//! Brücke zwischen Oberfläche und den ACP-Agenten (Vibe, Claude Code, …):
//! Tauri-Commands für Anfragen, Tauri-Events für alles, was ein Agent von sich
//! aus schickt. Je Backend läuft höchstens ein Prozess, jede Session gehört
//! genau einem Backend (siehe backends.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::backends::{self, Caps, DEFAULT_BACKEND};
use crate::rpc::{self, Connection, Incoming, RpcError};

type CmdResult<T> = Result<T, String>;

/// Ein laufender Agent-Prozess (ein Backend).
struct Agent {
    conn: Connection,
    child: tokio::process::Child,
    info: ConnectInfo,
}

#[derive(Default)]
pub struct AgentState {
    /// Laufende Agenten je Backend-ID.
    agents: AsyncMutex<HashMap<String, Agent>>,
    /// Verbindungsaufbau nacheinander, damit kein Backend doppelt startet.
    connecting: AsyncMutex<()>,
    /// Offene Freigabe-Anfragen: Schlüssel für die Oberfläche → (Backend, Session, JSON-RPC-ID).
    permissions: Arc<Mutex<HashMap<String, (String, String, Value)>>>,
    /// Zu welchem Backend gehört welche Session?
    sessions: Mutex<HashMap<String, String>>,
    /// Zählt Verbindungen, damit ein altes `acp:closed` die neue nicht beendet.
    generation: AtomicU64,
}

fn title(backend: &str) -> &'static str {
    backends::get(backend).map(|b| b.title()).unwrap_or("dem Agenten")
}

async fn connection(state: &AgentState, backend: &str) -> CmdResult<Connection> {
    state.agents.lock().await.get(backend).map(|a| a.conn.clone()).ok_or_else(|| format!("Nicht mit {} verbunden", title(backend)))
}

async fn call(state: &AgentState, method: &str, params: Value) -> CmdResult<Value> {
    call_on(state, DEFAULT_BACKEND, method, params).await
}

async fn call_on(state: &AgentState, backend: &str, method: &str, params: Value) -> CmdResult<Value> {
    connection(state, backend).await?.request(method, params).await.map_err(|e| e.to_string())
}

/// Backend einer Session; unbekannte Sessions gehören zu Vibe (wie bisher).
fn session_backend(state: &AgentState, session_id: &str) -> String {
    state.sessions.lock().unwrap().get(session_id).cloned().unwrap_or_else(|| DEFAULT_BACKEND.to_string())
}

fn remember(state: &AgentState, session_id: &str, backend: &str) {
    state.sessions.lock().unwrap().insert(session_id.to_string(), backend.to_string());
}

async fn call_session(state: &AgentState, session_id: &str, method: &str, params: Value) -> CmdResult<Value> {
    call_on(state, &session_backend(state, session_id), method, params).await
}

/// Sucht `vibe-acp`. Aus dem Desktop gestartete Apps erben oft nicht den PATH
/// der Shell, deshalb zusätzlich die üblichen Installationsorte von uv.
pub fn find_vibe_acp() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "vibe-acp.exe" } else { "vibe-acp" };
    if let Some(paths) = std::env::var_os("PATH") {
        if let Some(found) = std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()) {
            return Some(found);
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    [
        home.join(".local").join("bin").join(exe),
        home.join(".local").join("share").join("uv").join("tools").join("mistral-vibe").join("bin").join(exe),
        // Von Brise selbst installiert (siehe installer.rs).
        crate::installer::managed_bin_dir().join(exe),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    generation: u64,
    backend: String,
    title: &'static str,
    caps: Caps,
    /// Neue Modelle bei Mistral seit dem letzten Start.
    new_models: Value,
    agent_path: String,
    init: Value,
    auth: Value,
}

/// Anmeldestatus: Vibe fragt man per `_auth/status`, die anderen Agenten
/// prüft Brise selbst (CLI bzw. vorhandene Zugangsdaten, nie deren Inhalt).
async fn auth_of(backend: &str, conn: &Connection) -> Value {
    if backends::caps(backend).vibe_extensions {
        return conn.request("_auth/status", json!({})).await.unwrap_or(Value::Null);
    }
    let Some(b) = backends::get(backend) else { return Value::Null };
    tokio::task::spawn_blocking(move || b.probe_auth()).await.ok().flatten().unwrap_or(Value::Null)
}

/// Verbindet mit einem Backend (`backend` fehlt = Vibe). Mit `reuse` wird ein
/// laufender Agent übernommen, etwa nach einem Neuladen der Oberfläche.
#[tauri::command]
pub async fn agent_connect(app: AppHandle, state: State<'_, AgentState>, reuse: bool, backend: Option<String>) -> CmdResult<ConnectInfo> {
    connect_backend(&app, &state, &backend.unwrap_or_else(|| DEFAULT_BACKEND.into()), reuse).await
}

async fn connect_backend(app: &AppHandle, state: &AgentState, backend: &str, reuse: bool) -> CmdResult<ConnectInfo> {
    let spec = backends::get(backend).ok_or_else(|| format!("Unbekanntes Backend: {backend}"))?;
    let _guard = state.connecting.lock().await;
    if reuse {
        let mut agents = state.agents.lock().await;
        if let Some(agent) = agents.get_mut(backend) {
            if matches!(agent.child.try_wait(), Ok(None)) {
                let conn = agent.conn.clone();
                let mut info = agent.info.clone();
                drop(agents);
                let auth = auth_of(backend, &conn).await;
                if !auth.is_null() {
                    info.auth = auth;
                }
                return Ok(info);
            }
        }
    }
    let old = state.agents.lock().await.remove(backend);
    if let Some(mut old) = old {
        let _ = old.child.kill().await;
    }
    state.permissions.lock().unwrap().retain(|_, (b, _, _)| b != backend);

    let launch = spec.locate().ok_or(if backend == DEFAULT_BACKEND { "VIBE_NOT_FOUND" } else { "BACKEND_NOT_FOUND" })?;

    // Vor dem Start von Vibe: Standardmodelle und Skills eintragen, neue Modelle suchen.
    let mut new_models = Value::Null;
    if spec.caps().models {
        let report = tokio::time::timeout(std::time::Duration::from_secs(10), crate::models::startup_check(app.clone())).await;
        if let Ok(Ok(r)) = report {
            new_models = serde_json::to_value(r).ok().map(|v| v["newModels"].clone()).unwrap_or(Value::Null);
        }
    }

    // Mit mehreren Backends bekommt jedes seine eigene Trace-Datei (`<pfad>.<backend>`).
    let trace = std::env::var_os("BRISE_ACP_TRACE").map(|p| {
        let mut p = PathBuf::from(p).into_os_string();
        if backend != DEFAULT_BACKEND {
            p.push(format!(".{backend}"));
        }
        PathBuf::from(p)
    });
    let (conn, events, child) = rpc::spawn(launch.program.as_os_str(), &launch.args, trace.as_deref()).map_err(|e| e.to_string())?;

    let init = conn
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false,
                    "_meta": { "browser-auth-delegated": true }
                },
                "clientInfo": { "name": "brise", "title": "Brise", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await
        .map_err(|e| format!("{} antwortet nicht: {e}", spec.title()))?;
    let auth = auth_of(backend, &conn).await;

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(pump(app.clone(), backend.to_string(), conn.clone(), events, state.permissions.clone(), generation));

    let info = ConnectInfo {
        generation,
        backend: backend.to_string(),
        title: spec.title(),
        caps: spec.caps(),
        new_models,
        agent_path: launch.display(),
        init,
        auth,
    };
    state.agents.lock().await.insert(backend.to_string(), Agent { conn: conn.clone(), child, info: info.clone() });
    Ok(info)
}

/// Verbindung zum Backend, bei Bedarf jetzt aufbauen.
async fn ensure(app: &AppHandle, state: &AgentState, backend: &str) -> CmdResult<Connection> {
    {
        let mut agents = state.agents.lock().await;
        if let Some(agent) = agents.get_mut(backend) {
            if matches!(agent.child.try_wait(), Ok(None)) {
                return Ok(agent.conn.clone());
            }
        }
    }
    connect_backend(app, state, backend, true).await?;
    connection(state, backend).await
}

/// Beendet den Agenten eines Backends (z. B. nach der Anmeldung neu starten).
#[tauri::command]
pub async fn disconnect_backend(state: State<'_, AgentState>, backend: String) -> CmdResult<()> {
    let old = state.agents.lock().await.remove(&backend);
    if let Some(mut old) = old {
        let _ = old.child.kill().await;
    }
    Ok(())
}

/// Leitet alles, was der Agent von sich aus schickt, an die Oberfläche weiter.
/// Jedes Event trägt die Backend-ID.
async fn pump(
    app: AppHandle,
    backend: String,
    conn: Connection,
    mut events: mpsc::UnboundedReceiver<Incoming>,
    permissions: Arc<Mutex<HashMap<String, (String, String, Value)>>>,
    generation: u64,
) {
    let tag = |mut params: Value| {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("backend".into(), json!(backend));
        }
        params
    };
    while let Some(ev) = events.recv().await {
        match ev {
            Incoming::Notification { method, params } if method == "session/update" => {
                let _ = app.emit("acp:update", tag(params));
            }
            Incoming::Notification { method, params } if method == "_auth/status_update" => {
                let _ = app.emit("acp:backend-auth", json!({ "backend": backend, "status": params["authStatus"] }));
            }
            Incoming::Notification { method, params } => {
                let _ = app.emit("acp:notification", json!({ "method": method, "params": params, "backend": backend }));
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => {
                    let key = format!("{backend}:{generation}:{id}");
                    let session = params["sessionId"].as_str().unwrap_or_default().to_string();
                    permissions.lock().unwrap().insert(key.clone(), (backend.clone(), session, id));
                    let _ = app.emit("acp:permission", json!({ "key": key, "request": params, "backend": backend }));
                }
                "fs/read_text_file" => conn.respond(id, fs_read(&params)),
                "fs/write_text_file" => conn.respond(id, fs_write(&params)),
                _ => conn.respond(id, Err(RpcError::method_not_found(&method))),
            },
        }
    }
    let _ = app.emit("acp:closed", json!({ "generation": generation, "backend": backend }));
}

/// Ordner aus der Kommandozeile (`brise ~/code/projekt`), wie bei `code .`.
#[tauri::command]
pub fn startup_project() -> Option<String> {
    std::env::args()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.is_dir())
        .and_then(|p| std::fs::canonicalize(p).ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
pub async fn auth_status(state: State<'_, AgentState>) -> CmdResult<Value> {
    call(&state, "_auth/status", json!({})).await
}

/// Anmeldung über den Mistral-Plan: Vibe liefert die URL, wir öffnen den
/// Browser, `complete` wartet, bis der Login dort abgeschlossen ist.
#[tauri::command]
pub async fn login(app: AppHandle, state: State<'_, AgentState>) -> CmdResult<Value> {
    let conn = connection(&state, DEFAULT_BACKEND).await?;
    let start = conn
        .request("authenticate", json!({ "methodId": "browser-auth-delegated", "_meta": { "action": "start" } }))
        .await
        .map_err(|e| e.to_string())?;
    let meta = &start["_meta"]["browser-auth-delegated"];
    let url = meta["signInUrl"].as_str().ok_or("Vibe hat keine Anmelde-URL geliefert")?;
    let attempt = meta["attemptId"].as_str().ok_or("Vibe hat keine attemptId geliefert")?;
    let _ = app.emit("acp:login-url", json!({ "url": url, "expiresAt": meta["expiresAt"] }));
    let _ = app.opener().open_url(url, None::<&str>);

    conn.request(
        "authenticate",
        json!({ "methodId": "browser-auth-delegated", "_meta": { "action": "complete", "attemptId": attempt } }),
    )
    .await
    .map_err(|e| e.to_string())?;
    call(&state, "_auth/status", json!({})).await
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AgentState>) -> CmdResult<Value> {
    call(&state, "_auth/signOut", json!({})).await?;
    call(&state, "_auth/status", json!({})).await
}

/// Umgebung für MCP-Server, die Vibe startet. Vibe reicht nur wenig durch;
/// ohne diese Variablen fehlen Schlüsselbund (D-Bus), Datenordner und unter
/// Windows grundlegende Systempfade. Schlüssel selbst werden nie übergeben.
pub fn child_env() -> Vec<Value> {
    [
        "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "XDG_RUNTIME_DIR", "XDG_DATA_HOME",
        "DBUS_SESSION_BUS_ADDRESS", "VIBE_HOME", "BRISE_DATA_DIR", "LANG",
        // Windows
        "SystemRoot", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "PATHEXT", "COMSPEC", "ProgramData", "ProgramFiles", "ALLUSERSPROFILE",
        // macOS
        "TMPDIR", "USER",
    ]
    .iter()
    .filter_map(|k| std::env::var(k).ok().map(|v| json!({ "name": k, "value": v })))
    .collect()
}

/// MCP-Server, die Brise jeder Session mitgibt: Selbstanpassung, semantische
/// Suche (falls indexiert) und die REA-Werkzeuge (falls Node.js da ist).
fn mcp_servers(cwd: &str, search: bool, rea: bool) -> Value {
    let mut list: Vec<Value> = crate::customize::mcp_entry().into_iter().collect();
    if search {
        list.extend(crate::embeddings::mcp_entry(cwd));
    }
    if rea {
        if let Some(npx) = crate::skills::find_npx() {
            list.push(json!({ "name": "rea", "command": npx.display().to_string(), "args": ["-y", "rea-agents@latest", "mcp"], "env": child_env() }));
        }
    }
    Value::Array(list)
}

/// Neue Session beim gewählten Backend (fehlt es, bei Vibe). Startet den
/// Agenten bei Bedarf.
#[tauri::command]
pub async fn new_session(
    app: AppHandle,
    state: State<'_, AgentState>,
    cwd: String,
    search: Option<bool>,
    rea: Option<bool>,
    backend: Option<String>,
) -> CmdResult<Value> {
    let backend = backend.unwrap_or_else(|| DEFAULT_BACKEND.into());
    let conn = ensure(&app, &state, &backend).await?;
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    let mut r = conn.request("session/new", json!({ "cwd": cwd, "mcpServers": servers })).await.map_err(|e| e.to_string())?;
    if let Some(id) = r["sessionId"].as_str() {
        remember(&state, id, &backend);
    }
    r["backend"] = json!(backend);
    Ok(r)
}

#[tauri::command]
pub async fn load_session(
    app: AppHandle,
    state: State<'_, AgentState>,
    cwd: String,
    session_id: String,
    search: Option<bool>,
    rea: Option<bool>,
    backend: Option<String>,
) -> CmdResult<Value> {
    let backend = backend.unwrap_or_else(|| session_backend(&state, &session_id));
    let conn = ensure(&app, &state, &backend).await?;
    remember(&state, &session_id, &backend);
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    conn.request("session/load", json!({ "cwd": cwd, "sessionId": session_id, "mcpServers": servers })).await.map_err(|e| e.to_string())
}

/// Vibe-Erweiterungen (`_voice/…` usw.) direkt aufrufen – nur bei Backends,
/// die sie können.
#[tauri::command]
pub async fn ext(state: State<'_, AgentState>, method: String, params: Value, backend: Option<String>) -> CmdResult<Value> {
    let backend = backend.unwrap_or_else(|| DEFAULT_BACKEND.into());
    if !backends::caps(&backend).vibe_extensions {
        return Err(format!("{} unterstützt _{method} nicht", title(&backend)));
    }
    call_on(&state, &backend, &format!("_{method}"), params).await
}

/// Kann das verbundene Backend `session/list` bzw. Sessions löschen?
fn session_capability(info: &ConnectInfo, name: &str) -> bool {
    info.caps.vibe_extensions || info.init["agentCapabilities"]["sessionCapabilities"].get(name).is_some()
}

/// Sessions aller verbundenen Backends (oder nur von `backend`), jede mit
/// ihrer Backend-ID. Ohne `cwd` die Sessions aller Projekte.
#[tauri::command]
pub async fn list_sessions(state: State<'_, AgentState>, cwd: Option<String>, backend: Option<String>) -> CmdResult<Value> {
    let params = match cwd {
        Some(cwd) => json!({ "cwd": cwd }),
        None => json!({}),
    };
    let targets: Vec<(String, Connection)> = {
        let agents = state.agents.lock().await;
        agents
            .iter()
            .filter(|(id, a)| backend.as_deref().is_none_or(|b| b == id.as_str()) && session_capability(&a.info, "list"))
            .map(|(id, a)| (id.clone(), a.conn.clone()))
            .collect()
    };
    let mut all = Vec::new();
    let mut errors = Vec::new();
    for (id, conn) in targets {
        match conn.request("session/list", params.clone()).await {
            Ok(r) => {
                for mut s in r["sessions"].as_array().cloned().unwrap_or_default() {
                    if let Some(sid) = s["sessionId"].as_str() {
                        remember(&state, sid, &id);
                    }
                    s["backend"] = json!(id);
                    all.push(s);
                }
            }
            Err(e) => errors.push(format!("{}: {e}", title(&id))),
        }
    }
    if all.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(json!({ "sessions": all }))
}

/// `prompt` sind fertige ACP-Content-Blöcke (Text, resource_link, image).
#[tauri::command]
pub async fn prompt(state: State<'_, AgentState>, session_id: String, prompt: Vec<Value>) -> CmdResult<Value> {
    call_session(&state, &session_id, "session/prompt", json!({ "sessionId": session_id, "prompt": prompt })).await
}

#[tauri::command]
pub async fn set_config_option(
    state: State<'_, AgentState>,
    session_id: String,
    config_id: String,
    value: Value,
) -> CmdResult<Value> {
    call_session(&state, &session_id, "session/set_config_option", json!({ "sessionId": session_id, "configId": config_id, "value": value }))
        .await
}

#[tauri::command]
pub async fn config_schema(state: State<'_, AgentState>) -> CmdResult<Value> {
    call(&state, "_config/schema", json!({})).await
}

/// Vibe löscht über `_session/delete`, andere Agenten über `session/delete`,
/// sofern sie es in `sessionCapabilities` anbieten.
#[tauri::command]
pub async fn delete_session(state: State<'_, AgentState>, session_id: String) -> CmdResult<Value> {
    let backend = session_backend(&state, &session_id);
    let method = {
        let agents = state.agents.lock().await;
        let info = &agents.get(&backend).ok_or_else(|| format!("Nicht mit {} verbunden", title(&backend)))?.info;
        if info.caps.vibe_extensions {
            "_session/delete"
        } else if session_capability(info, "delete") {
            "session/delete"
        } else {
            return Err(format!("{} kann Sessions nicht löschen", title(&backend)));
        }
    };
    let r = call_on(&state, &backend, method, json!({ "sessionId": session_id })).await?;
    state.sessions.lock().unwrap().remove(&session_id);
    Ok(r)
}

#[tauri::command]
pub async fn cancel(app: AppHandle, state: State<'_, AgentState>, session_id: String) -> CmdResult<()> {
    let backend = session_backend(&state, &session_id);
    let conn = connection(&state, &backend).await?;
    // Laut ACP muss der Client offene Freigaben selbst als abgebrochen beantworten.
    let open: Vec<(String, Value)> = {
        let mut map = state.permissions.lock().unwrap();
        let keys: Vec<String> = map.iter().filter(|(_, (b, s, _))| *b == backend && (s.is_empty() || *s == session_id)).map(|(k, _)| k.clone()).collect();
        keys.into_iter().filter_map(|k| map.remove(&k).map(|(_, _, id)| (k, id))).collect()
    };
    for (key, id) in open {
        conn.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })));
        let _ = app.emit("acp:permission-closed", json!({ "key": key, "optionId": null }));
    }
    conn.notify("session/cancel", json!({ "sessionId": session_id }));
    Ok(())
}

#[tauri::command]
pub async fn set_mode(state: State<'_, AgentState>, session_id: String, mode_id: String) -> CmdResult<Value> {
    call_session(&state, &session_id, "session/set_mode", json!({ "sessionId": session_id, "modeId": mode_id })).await
}

#[tauri::command]
pub async fn respond_permission(
    app: AppHandle,
    state: State<'_, AgentState>,
    key: String,
    option_id: Option<String>,
) -> CmdResult<()> {
    let (backend, _, id) = state.permissions.lock().unwrap().remove(&key).ok_or("Diese Freigabe ist nicht mehr offen")?;
    let outcome = match &option_id {
        Some(option) => json!({ "outcome": "selected", "optionId": option }),
        None => json!({ "outcome": "cancelled" }),
    };
    connection(&state, &backend).await?.respond(id, Ok(json!({ "outcome": outcome })));
    let _ = app.emit("acp:permission-closed", json!({ "key": key, "optionId": option_id }));
    Ok(())
}

fn fs_read(params: &Value) -> Result<Value, RpcError> {
    let path = params["path"].as_str().ok_or_else(|| RpcError::new(-32602, "path fehlt"))?;
    let text = std::fs::read_to_string(path).map_err(|e| RpcError::internal(format!("{path}: {e}")))?;
    let start = params["line"].as_u64().map_or(0, |l| l.saturating_sub(1) as usize);
    let content = match params["limit"].as_u64() {
        None if start == 0 => text,
        limit => text
            .split_inclusive('\n')
            .skip(start)
            .take(limit.map_or(usize::MAX, |l| l as usize))
            .collect(),
    };
    Ok(json!({ "content": content }))
}

fn fs_write(params: &Value) -> Result<Value, RpcError> {
    let path = params["path"].as_str().ok_or_else(|| RpcError::new(-32602, "path fehlt"))?;
    let content = params["content"].as_str().unwrap_or("");
    let path = std::path::Path::new(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    std::fs::write(path, content).map_err(|e| RpcError::internal(format!("{}: {e}", path.display())))?;
    Ok(Value::Null)
}
