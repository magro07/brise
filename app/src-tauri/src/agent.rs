//! Brücke zwischen Oberfläche und den ACP-Agenten (Vibe, Claude Code, …):
//! Tauri-Commands für Anfragen, Tauri-Events für alles, was ein Agent von sich
//! aus schickt. Je Backend läuft höchstens ein Prozess, jede Session gehört
//! genau einem Backend (siehe backends.rs). Weitere Vibe-Accounts bekommen je
//! einen eigenen `vibe-acp` (Schlüssel `vibe@<account>`, siehe accounts.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::backends::{self, Caps, DEFAULT_BACKEND};
use crate::rpc::{self, Connection, Incoming, RpcError};

type CmdResult<T> = Result<T, String>;

/// Ein laufender Agent-Prozess (ein Backend oder ein weiterer Vibe-Account).
struct Agent {
    conn: Connection,
    child: tokio::process::Child,
    info: ConnectInfo,
}

/// Offene Freigabe: (Agent-Schlüssel, Session, Verbindung, JSON-RPC-ID).
type Permissions = Arc<Mutex<HashMap<String, (String, String, Connection, Value)>>>;

/// Sessions, deren Updates gerade nicht an die Oberfläche gehen, mit dem Text
/// der zuletzt wiedergegebenen Nutzernachricht.
type Muted = Arc<Mutex<HashMap<String, Replay>>>;

#[derive(Default)]
struct Replay {
    last_user: String,
    in_user: bool,
}

#[derive(Default)]
pub struct AgentState {
    /// Laufende Agenten je Backend-ID bzw. `vibe@<account>`.
    agents: AsyncMutex<HashMap<String, Agent>>,
    /// Verbindungsaufbau nacheinander, damit kein Backend doppelt startet.
    connecting: AsyncMutex<()>,
    /// Offene Freigabe-Anfragen, Schlüssel für die Oberfläche.
    permissions: Permissions,
    muted: Muted,
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

/// Schlüssel eines weiteren Vibe-Accounts in `agents`.
fn account_key(account: &str) -> String {
    format!("{DEFAULT_BACKEND}@{account}")
}

/// Verbindung eines Vibe-Accounts; ein weiterer Prozess startet beim ersten Bedarf.
async fn account_connection(app: &AppHandle, state: &AgentState, account: &str) -> CmdResult<Connection> {
    if account == crate::accounts::STANDARD {
        return ensure(app, state, DEFAULT_BACKEND).await;
    }
    let key = account_key(account);
    let _guard = state.connecting.lock().await;
    if let Some(a) = state.agents.lock().await.get_mut(&key) {
        if matches!(a.child.try_wait(), Ok(None)) {
            return Ok(a.conn.clone());
        }
    }
    let env = crate::accounts::agent_env(account)?;
    let (conn, child, info) = start_agent(app, state, DEFAULT_BACKEND, &env, Some(account)).await?;
    state.agents.lock().await.insert(key, Agent { conn: conn.clone(), child, info });
    Ok(conn)
}

/// Verbindung, über die eine Session läuft (Backend und, bei Vibe, Account).
async fn session_connection(app: &AppHandle, state: &AgentState, session_id: &str) -> CmdResult<Connection> {
    let backend = session_backend(state, session_id);
    if backend == DEFAULT_BACKEND {
        if let Some(account) = crate::accounts::for_session(session_id) {
            return account_connection(app, state, &account).await;
        }
    }
    ensure(app, state, &backend).await
}

async fn session_call(app: &AppHandle, state: &AgentState, session_id: &str, method: &str, params: Value) -> CmdResult<Value> {
    session_connection(app, state, session_id).await?.request(method, params).await.map_err(|e| e.to_string())
}

fn bind(app: &AppHandle, session_id: &str, account: &str) {
    crate::accounts::bind_session(session_id, account);
    let _ = app.emit("accounts:session", json!({ "sessionId": session_id, "id": account, "name": crate::accounts::name(account) }));
}

/// Beendet den Prozess eines Accounts (beim Entfernen).
pub async fn stop_account(state: &AgentState, account: &str) {
    if let Some(mut a) = state.agents.lock().await.remove(&account_key(account)) {
        let _ = a.child.kill().await;
    }
}

/// Beendet einen Agenten samt seiner weiteren Accounts.
async fn stop_backend(state: &AgentState, backend: &str) {
    let prefix = format!("{backend}@");
    let old: Vec<Agent> = {
        let mut agents = state.agents.lock().await;
        let keys: Vec<String> = agents.keys().filter(|k| *k == backend || k.starts_with(&prefix)).cloned().collect();
        keys.iter().filter_map(|k| agents.remove(k)).collect()
    };
    for mut a in old {
        let _ = a.child.kill().await;
    }
    state.permissions.lock().unwrap().retain(|_, (k, _, _, _)| k != backend && !k.starts_with(&prefix));
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
    stop_backend(state, backend).await;

    spec.locate().ok_or(if backend == DEFAULT_BACKEND { "VIBE_NOT_FOUND" } else { "BACKEND_NOT_FOUND" })?;

    // Vor dem Start von Vibe: Standardmodelle und Skills eintragen, neue Modelle suchen.
    let mut new_models = Value::Null;
    if spec.caps().models {
        let report = tokio::time::timeout(std::time::Duration::from_secs(10), crate::models::startup_check(app.clone())).await;
        if let Ok(Ok(r)) = report {
            new_models = serde_json::to_value(r).ok().map(|v| v["newModels"].clone()).unwrap_or(Value::Null);
        }
    }

    let (conn, child, mut info) = start_agent(app, state, backend, &[], None).await?;
    info.new_models = new_models;
    state.agents.lock().await.insert(backend.to_string(), Agent { conn, child, info: info.clone() });
    Ok(info)
}

/// Startet den Agenten eines Backends, initialisiert ACP und leitet seine
/// Nachrichten weiter. `account` ist ein weiterer Vibe-Account.
async fn start_agent(
    app: &AppHandle,
    state: &AgentState,
    backend: &str,
    env: &[(String, String)],
    account: Option<&str>,
) -> CmdResult<(Connection, tokio::process::Child, ConnectInfo)> {
    let spec = backends::get(backend).ok_or_else(|| format!("Unbekanntes Backend: {backend}"))?;
    let launch = spec.locate().ok_or(if backend == DEFAULT_BACKEND { "VIBE_NOT_FOUND" } else { "BACKEND_NOT_FOUND" })?;
    // Jedes Backend und jeder weitere Account bekommt eine eigene Trace-Datei (`<pfad>.<backend>`, `<pfad>.<account>`).
    let trace = std::env::var_os("BRISE_ACP_TRACE").map(|p| {
        let mut p = PathBuf::from(p).into_os_string();
        if backend != DEFAULT_BACKEND {
            p.push(format!(".{backend}"));
        }
        if let Some(a) = account {
            p.push(format!(".{a}"));
        }
        PathBuf::from(p)
    });
    let (conn, events, child) = rpc::spawn_with_env(launch.program.as_os_str(), &launch.args, env, trace.as_deref()).map_err(|e| e.to_string())?;

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
    let key = account.map_or_else(|| backend.to_string(), account_key);
    tauri::async_runtime::spawn(pump(
        app.clone(),
        backend.to_string(),
        key,
        conn.clone(),
        events,
        state.permissions.clone(),
        state.muted.clone(),
        generation,
        account.map(str::to_string),
    ));
    let info = ConnectInfo {
        generation,
        backend: backend.to_string(),
        title: spec.title(),
        caps: spec.caps(),
        new_models: Value::Null,
        agent_path: launch.display(),
        init,
        auth,
    };
    Ok((conn, child, info))
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
    stop_backend(&state, &backend).await;
    Ok(())
}

/// Leitet alles, was der Agent von sich aus schickt, an die Oberfläche weiter.
/// Jedes Event trägt die Backend-ID.
#[allow(clippy::too_many_arguments)]
async fn pump(
    app: AppHandle,
    backend: String,
    key: String,
    conn: Connection,
    mut events: mpsc::UnboundedReceiver<Incoming>,
    permissions: Permissions,
    muted: Muted,
    generation: u64,
    account: Option<String>,
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
                let sid = params["sessionId"].as_str().unwrap_or_default();
                // Bench-Sessions laufen unsichtbar; ihre Updates wertet bench.rs aus.
                if crate::bench::observe(sid, &params["update"]) {
                    continue;
                }
                if let Some(replay) = muted.lock().unwrap().get_mut(sid) {
                    let update = &params["update"];
                    if update["sessionUpdate"] == "user_message_chunk" {
                        if !replay.in_user {
                            replay.last_user.clear();
                        }
                        replay.last_user.push_str(update["content"]["text"].as_str().unwrap_or_default());
                        replay.in_user = true;
                    } else {
                        replay.in_user = false;
                    }
                    continue;
                }
                let _ = app.emit("acp:update", tag(params));
            }
            Incoming::Notification { method, params } if method == "_auth/status_update" && account.is_none() => {
                let _ = app.emit("acp:backend-auth", json!({ "backend": backend, "status": params["authStatus"] }));
            }
            Incoming::Notification { method, params } => {
                let _ = app.emit("acp:notification", json!({ "method": method, "params": params, "backend": backend }));
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => {
                    if let Some(answer) = crate::bench::auto_permission(params["sessionId"].as_str().unwrap_or_default(), &params) {
                        conn.respond(id, Ok(answer));
                        continue;
                    }
                    let ui_key = format!("{key}:{generation}:{id}");
                    let session = params["sessionId"].as_str().unwrap_or_default().to_string();
                    permissions.lock().unwrap().insert(ui_key.clone(), (key.clone(), session, conn.clone(), id));
                    let _ = app.emit("acp:permission", json!({ "key": ui_key, "request": params, "backend": backend }));
                }
                "fs/read_text_file" => conn.respond(id, fs_read(&params)),
                "fs/write_text_file" => conn.respond(id, fs_write(&params)),
                _ => conn.respond(id, Err(RpcError::method_not_found(&method))),
            },
        }
    }
    match account {
        // Ein weiterer Account startet beim nächsten Bedarf neu; die Oberfläche bleibt verbunden.
        Some(account) => {
            let _ = app.emit("accounts:closed", json!({ "account": account }));
        }
        None => {
            let _ = app.emit("acp:closed", json!({ "generation": generation, "backend": backend }));
        }
    }
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

/// MCP-Server, die Brise jeder Session mitgibt: Selbstanpassung, Council, semantische
/// Suche (falls indexiert) und die REA-Werkzeuge (falls Node.js da ist).
fn mcp_servers(cwd: &str, search: bool, rea: bool) -> Value {
    let mut list: Vec<Value> = crate::customize::mcp_entry().into_iter().collect();
    list.extend(crate::council::mcp_entry(cwd));
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
/// Agenten bei Bedarf. Vibe-Sessions nehmen ohne `account` den Account des
/// Projekts (siehe accounts.rs).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn new_session(
    app: AppHandle,
    state: State<'_, AgentState>,
    cwd: String,
    search: Option<bool>,
    rea: Option<bool>,
    backend: Option<String>,
    account: Option<String>,
) -> CmdResult<Value> {
    let backend = backend.unwrap_or_else(|| DEFAULT_BACKEND.into());
    let account = (backend == DEFAULT_BACKEND).then(|| account.unwrap_or_else(|| crate::accounts::for_project(&cwd)));
    let conn = match &account {
        Some(a) => account_connection(&app, &state, a).await?,
        None => ensure(&app, &state, &backend).await?,
    };
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    let mut r = conn.request("session/new", json!({ "cwd": cwd, "mcpServers": servers })).await.map_err(|e| e.to_string())?;
    if let Some(id) = r["sessionId"].as_str() {
        remember(&state, id, &backend);
        if let Some(a) = &account {
            bind(&app, id, a);
        }
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
    remember(&state, &session_id, &backend);
    // Eine Vibe-Session lädt in dem Account, mit dem sie begonnen hat.
    let account = (backend == DEFAULT_BACKEND).then(|| crate::accounts::for_session(&session_id).unwrap_or_else(|| crate::accounts::STANDARD.into()));
    let conn = match &account {
        Some(a) => account_connection(&app, &state, a).await?,
        None => ensure(&app, &state, &backend).await?,
    };
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    let result = conn
        .request("session/load", json!({ "cwd": cwd, "sessionId": session_id, "mcpServers": servers }))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(a) = &account {
        bind(&app, &session_id, a);
    }
    Ok(result)
}

/// Zieht eine Vibe-Session in einen anderen Account um, z. B. auf die Reserve
/// nach einem Limit. Der Verlauf wird dort geladen, ohne ihn der Oberfläche
/// erneut zu zeigen. Liefert die zuletzt gespeicherte Nutzernachricht, damit
/// die Oberfläche entscheiden kann, ob sie den Prompt wiederholen muss.
#[tauri::command]
pub async fn switch_account(
    app: AppHandle,
    state: State<'_, AgentState>,
    cwd: String,
    session_id: String,
    account: String,
    search: Option<bool>,
    rea: Option<bool>,
) -> CmdResult<Value> {
    if session_backend(&state, &session_id) != DEFAULT_BACKEND {
        return Err("Accounts gibt es nur für Vibe-Sessions".into());
    }
    let conn = account_connection(&app, &state, &account).await?;
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    state.muted.lock().unwrap().insert(session_id.clone(), Replay::default());
    let result = conn.request("session/load", json!({ "cwd": cwd, "sessionId": session_id, "mcpServers": servers })).await;
    // Nachzügler der Wiedergabe abwarten, bevor die Session wieder sichtbar wird.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let replay = state.muted.lock().unwrap().remove(&session_id).unwrap_or_default();
    result.map_err(|e| e.to_string())?;
    bind(&app, &session_id, &account);
    Ok(json!({ "id": account, "name": crate::accounts::name(&account), "lastUserText": replay.last_user }))
}

/// Reserve-Account für eine Vibe-Session am Limit, falls einer eingetragen ist.
#[tauri::command]
pub fn reserve_account(state: State<'_, AgentState>, session_id: String) -> Value {
    if session_backend(&state, &session_id) != DEFAULT_BACKEND {
        return Value::Null;
    }
    let current = crate::accounts::for_session(&session_id).unwrap_or_else(|| crate::accounts::STANDARD.into());
    match crate::accounts::reserve_for(&current) {
        Some(id) => json!({
            "id": id,
            "name": crate::accounts::name(&id),
            "from": crate::accounts::name(&current),
            "auto": crate::accounts::auto_switch(),
        }),
        None => Value::Null,
    }
}

/// Vibe-Erweiterungen (`_voice/…` usw.) direkt aufrufen – nur bei Backends,
/// die sie können; mit `sessionId` über den Account der Session.
#[tauri::command]
pub async fn ext(app: AppHandle, state: State<'_, AgentState>, method: String, params: Value, backend: Option<String>) -> CmdResult<Value> {
    let backend = backend.unwrap_or_else(|| DEFAULT_BACKEND.into());
    if !backends::caps(&backend).vibe_extensions {
        return Err(format!("{} unterstützt _{method} nicht", title(&backend)));
    }
    match params["sessionId"].as_str().map(str::to_string) {
        Some(sid) => session_call(&app, &state, &sid, &format!("_{method}"), params).await,
        None => call_on(&state, &backend, &format!("_{method}"), params).await,
    }
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
            // Weitere Vibe-Accounts teilen sich den Sessions-Ordner mit dem Standard.
            .filter(|(id, a)| !id.contains('@') && backend.as_deref().is_none_or(|b| b == id.as_str()) && session_capability(&a.info, "list"))
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
pub async fn prompt(app: AppHandle, state: State<'_, AgentState>, session_id: String, prompt: Vec<Value>) -> CmdResult<Value> {
    session_connection(&app, &state, &session_id)
        .await?
        .request("session/prompt", json!({ "sessionId": session_id, "prompt": prompt }))
        .await
        // Limit erkennbar machen (Vibe: -31001 nach eigenen Wiederholungen).
        .map_err(|e| if e.code == -31001 { format!("RATE_LIMIT: {}", e.message) } else { e.to_string() })
}

#[tauri::command]
pub async fn set_config_option(
    app: AppHandle,
    state: State<'_, AgentState>,
    session_id: String,
    config_id: String,
    value: Value,
) -> CmdResult<Value> {
    let params = json!({ "sessionId": session_id, "configId": config_id, "value": value });
    session_call(&app, &state, &session_id, "session/set_config_option", params).await
}

#[tauri::command]
pub async fn config_schema(state: State<'_, AgentState>) -> CmdResult<Value> {
    call(&state, "_config/schema", json!({})).await
}

/// Vibe löscht über `_session/delete`, andere Agenten über `session/delete`,
/// sofern sie es in `sessionCapabilities` anbieten.
#[tauri::command]
pub async fn delete_session(app: AppHandle, state: State<'_, AgentState>, session_id: String) -> CmdResult<Value> {
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
    let r = session_call(&app, &state, &session_id, method, json!({ "sessionId": session_id })).await?;
    state.sessions.lock().unwrap().remove(&session_id);
    crate::accounts::forget_session(&session_id);
    Ok(r)
}

#[tauri::command]
pub async fn cancel(app: AppHandle, state: State<'_, AgentState>, session_id: String) -> CmdResult<()> {
    let conn = session_connection(&app, &state, &session_id).await?;
    // Laut ACP muss der Client offene Freigaben selbst als abgebrochen beantworten.
    let open: Vec<(String, Connection, Value)> = {
        let mut map = state.permissions.lock().unwrap();
        let keys: Vec<String> = map.iter().filter(|(_, (_, s, c, _))| c.same(&conn) && (s.is_empty() || *s == session_id)).map(|(k, _)| k.clone()).collect();
        keys.into_iter().filter_map(|k| map.remove(&k).map(|(_, _, c, id)| (k, c, id))).collect()
    };
    for (key, owner, id) in open {
        owner.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })));
        let _ = app.emit("acp:permission-closed", json!({ "key": key, "optionId": null }));
    }
    conn.notify("session/cancel", json!({ "sessionId": session_id }));
    Ok(())
}

#[tauri::command]
pub async fn set_mode(app: AppHandle, state: State<'_, AgentState>, session_id: String, mode_id: String) -> CmdResult<Value> {
    session_call(&app, &state, &session_id, "session/set_mode", json!({ "sessionId": session_id, "modeId": mode_id })).await
}

#[tauri::command]
pub async fn respond_permission(
    app: AppHandle,
    state: State<'_, AgentState>,
    key: String,
    option_id: Option<String>,
) -> CmdResult<()> {
    // Freigaben einer geteilten Session, der man als Gast beigetreten ist.
    if let Some(rest) = key.strip_prefix("collab:") {
        return crate::collab::guest_decide(&app.state::<crate::collab::CollabState>(), rest, option_id);
    }
    let (_, _, conn, id) = state.permissions.lock().unwrap().remove(&key).ok_or("Diese Freigabe ist nicht mehr offen")?;
    let outcome = match &option_id {
        Some(option) => json!({ "outcome": "selected", "optionId": option }),
        None => json!({ "outcome": "cancelled" }),
    };
    conn.respond(id, Ok(json!({ "outcome": outcome })));
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
