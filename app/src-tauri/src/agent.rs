//! Brücke zwischen Oberfläche und `vibe-acp`: Tauri-Commands für Anfragen,
//! Tauri-Events für alles, was der Agent von sich aus schickt.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::rpc::{self, Connection, Incoming, RpcError};

type CmdResult<T> = Result<T, String>;

/// Offene Freigabe-Anfragen: Schlüssel für die Oberfläche → Verbindung und JSON-RPC-ID.
type Permissions = Arc<Mutex<HashMap<String, (Connection, Value)>>>;

/// Sessions, deren Updates gerade nicht an die Oberfläche gehen, mit dem Text
/// der zuletzt wiedergegebenen Nutzernachricht.
type Muted = Arc<Mutex<HashMap<String, Replay>>>;

#[derive(Default)]
struct Replay {
    last_user: String,
    in_user: bool,
}

/// Ein weiterer `vibe-acp` für einen Account außer dem Standard (siehe accounts.rs).
struct Extra {
    conn: Connection,
    child: tokio::process::Child,
}

#[derive(Default)]
pub struct AgentState {
    /// Der Prozess des Standard-Accounts.
    conn: AsyncMutex<Option<Connection>>,
    child: AsyncMutex<Option<tokio::process::Child>>,
    permissions: Permissions,
    extra: AsyncMutex<HashMap<String, Extra>>,
    muted: Muted,
    /// Zählt Verbindungen, damit ein altes `acp:closed` die neue nicht beendet.
    generation: AtomicU64,
    /// Letzte erfolgreiche Verbindung – ein Neuladen der Oberfläche übernimmt sie.
    info: AsyncMutex<Option<ConnectInfo>>,
}

async fn connection(state: &AgentState) -> CmdResult<Connection> {
    state.conn.lock().await.clone().ok_or_else(|| "Nicht mit Vibe verbunden".to_string())
}

async fn call(state: &AgentState, method: &str, params: Value) -> CmdResult<Value> {
    connection(state).await?.request(method, params).await.map_err(|e| e.to_string())
}

/// Verbindung des Accounts; ein weiterer Prozess startet beim ersten Bedarf.
async fn account_connection(app: &AppHandle, state: &AgentState, account: &str) -> CmdResult<Connection> {
    if account == crate::accounts::STANDARD {
        return connection(state).await;
    }
    let mut extra = state.extra.lock().await;
    if let Some(e) = extra.get_mut(account) {
        if matches!(e.child.try_wait(), Ok(None)) {
            return Ok(e.conn.clone());
        }
    }
    let env = crate::accounts::agent_env(account)?;
    let (conn, child, _) = start_agent(app, state, &env, Some(account)).await?;
    extra.insert(account.to_string(), Extra { conn: conn.clone(), child });
    Ok(conn)
}

/// Verbindung, über die eine Session läuft.
async fn session_connection(app: &AppHandle, state: &AgentState, session_id: &str) -> CmdResult<Connection> {
    match crate::accounts::for_session(session_id) {
        Some(account) => account_connection(app, state, &account).await,
        None => connection(state).await,
    }
}

async fn session_call(app: &AppHandle, state: &AgentState, session_id: &str, method: &str, params: Value) -> CmdResult<Value> {
    session_connection(app, state, session_id).await?.request(method, params).await.map_err(|e| e.to_string())
}

fn bind(app: &AppHandle, session_id: &str, account: &str) {
    crate::accounts::bind_session(session_id, account);
    let _ = app.emit(
        "accounts:session",
        json!({ "sessionId": session_id, "id": account, "name": crate::accounts::name(account) }),
    );
}

/// Beendet den Prozess eines Accounts (beim Entfernen).
pub async fn stop_account(state: &AgentState, account: &str) {
    if let Some(mut e) = state.extra.lock().await.remove(account) {
        let _ = e.child.kill().await;
    }
}

/// Startet `vibe-acp`, initialisiert ACP und leitet seine Nachrichten weiter.
async fn start_agent(
    app: &AppHandle,
    state: &AgentState,
    env: &[(String, String)],
    account: Option<&str>,
) -> CmdResult<(Connection, tokio::process::Child, ConnectInfo)> {
    let path = find_vibe_acp().ok_or("VIBE_NOT_FOUND")?;
    let trace = std::env::var_os("BRISE_ACP_TRACE").map(|t| match account {
        Some(a) => PathBuf::from(format!("{}.{a}", t.to_string_lossy())),
        None => PathBuf::from(t),
    });
    let (conn, events, child) = rpc::spawn_with_env(path.as_os_str(), &[], env, trace.as_deref()).map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;
    let auth = conn.request("_auth/status", json!({})).await.unwrap_or(Value::Null);

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(pump(
        app.clone(),
        conn.clone(),
        events,
        state.permissions.clone(),
        state.muted.clone(),
        generation,
        account.map(str::to_string),
    ));
    let info = ConnectInfo { generation, new_models: Value::Null, agent_path: path.display().to_string(), init, auth };
    Ok((conn, child, info))
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
    /// Neue Modelle bei Mistral seit dem letzten Start.
    new_models: Value,
    agent_path: String,
    init: Value,
    auth: Value,
}

#[tauri::command]
pub async fn agent_connect(app: AppHandle, state: State<'_, AgentState>, reuse: bool) -> CmdResult<ConnectInfo> {
    if reuse {
        let alive = match state.child.lock().await.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if let (true, Some(mut info)) = (alive, state.info.lock().await.clone()) {
            info.auth = call(&state, "_auth/status", json!({})).await.unwrap_or(info.auth);
            return Ok(info);
        }
    }
    *state.info.lock().await = None;
    *state.conn.lock().await = None;

    // Vor dem Start von Vibe: Standardmodelle und Skills eintragen, neue Modelle suchen.
    let report = tokio::time::timeout(std::time::Duration::from_secs(10), crate::models::startup_check(app.clone())).await;
    let new_models = match report {
        Ok(Ok(r)) => serde_json::to_value(r).ok().map(|v| v["newModels"].clone()).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    if let Some(mut old) = state.child.lock().await.take() {
        let _ = old.kill().await;
    }
    for (_, mut e) in state.extra.lock().await.drain() {
        let _ = e.child.kill().await;
    }
    state.permissions.lock().unwrap().clear();

    let (conn, child, mut info) = start_agent(&app, &state, &[], None).await?;
    info.new_models = new_models;
    *state.conn.lock().await = Some(conn);
    *state.child.lock().await = Some(child);
    *state.info.lock().await = Some(info.clone());
    Ok(info)
}

/// Leitet alles, was der Agent von sich aus schickt, an die Oberfläche weiter.
async fn pump(
    app: AppHandle,
    conn: Connection,
    mut events: mpsc::UnboundedReceiver<Incoming>,
    permissions: Permissions,
    muted: Muted,
    generation: u64,
    account: Option<String>,
) {
    while let Some(ev) = events.recv().await {
        match ev {
            Incoming::Notification { method, params } if method == "session/update" => {
                let sid = params["sessionId"].as_str().unwrap_or_default();
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
                let _ = app.emit("acp:update", params);
            }
            Incoming::Notification { method, params } => {
                let _ = app.emit("acp:notification", json!({ "method": method, "params": params }));
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => {
                    let key = format!("{generation}:{id}");
                    permissions.lock().unwrap().insert(key.clone(), (conn.clone(), id));
                    let _ = app.emit("acp:permission", json!({ "key": key, "request": params }));
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
            let _ = app.emit("acp:closed", json!({ "generation": generation }));
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
    let conn = connection(&state).await?;
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

/// Ohne `account` nimmt die Session den Account des Projekts (siehe accounts.rs).
#[tauri::command]
pub async fn new_session(
    app: AppHandle,
    state: State<'_, AgentState>,
    cwd: String,
    search: Option<bool>,
    rea: Option<bool>,
    account: Option<String>,
) -> CmdResult<Value> {
    let account = account.unwrap_or_else(|| crate::accounts::for_project(&cwd));
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    let conn = account_connection(&app, &state, &account).await?;
    let result = conn.request("session/new", json!({ "cwd": cwd, "mcpServers": servers })).await.map_err(|e| e.to_string())?;
    if let Some(id) = result["sessionId"].as_str() {
        bind(&app, id, &account);
    }
    Ok(result)
}

/// Eine Session lädt in dem Account, mit dem sie begonnen hat.
#[tauri::command]
pub async fn load_session(
    app: AppHandle,
    state: State<'_, AgentState>,
    cwd: String,
    session_id: String,
    search: Option<bool>,
    rea: Option<bool>,
) -> CmdResult<Value> {
    let account = crate::accounts::for_session(&session_id).unwrap_or_else(|| crate::accounts::STANDARD.into());
    let servers = mcp_servers(&cwd, search.unwrap_or(true), rea.unwrap_or(false));
    let conn = account_connection(&app, &state, &account).await?;
    let result = conn
        .request("session/load", json!({ "cwd": cwd, "sessionId": session_id, "mcpServers": servers }))
        .await
        .map_err(|e| e.to_string())?;
    bind(&app, &session_id, &account);
    Ok(result)
}

/// Zieht eine Session in einen anderen Account um, z. B. auf die Reserve
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

/// Reserve-Account für eine Session am Limit, falls einer eingetragen ist.
#[tauri::command]
pub fn reserve_account(session_id: String) -> Value {
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

/// Vibe-Erweiterungen (`_voice/…` usw.) direkt aufrufen; mit `sessionId` über deren Account.
#[tauri::command]
pub async fn ext(app: AppHandle, state: State<'_, AgentState>, method: String, params: Value) -> CmdResult<Value> {
    match params["sessionId"].as_str().map(str::to_string) {
        Some(sid) => session_call(&app, &state, &sid, &format!("_{method}"), params).await,
        None => call(&state, &format!("_{method}"), params).await,
    }
}

/// Ohne `cwd` liefert Vibe die Sessions aller Projekte.
#[tauri::command]
pub async fn list_sessions(state: State<'_, AgentState>, cwd: Option<String>) -> CmdResult<Value> {
    let params = match cwd {
        Some(cwd) => json!({ "cwd": cwd }),
        None => json!({}),
    };
    call(&state, "session/list", params).await
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

#[tauri::command]
pub async fn delete_session(app: AppHandle, state: State<'_, AgentState>, session_id: String) -> CmdResult<Value> {
    let result = session_call(&app, &state, &session_id, "_session/delete", json!({ "sessionId": session_id })).await?;
    crate::accounts::forget_session(&session_id);
    Ok(result)
}

#[tauri::command]
pub async fn cancel(app: AppHandle, state: State<'_, AgentState>, session_id: String) -> CmdResult<()> {
    let conn = session_connection(&app, &state, &session_id).await?;
    // Laut ACP muss der Client offene Freigaben selbst als abgebrochen beantworten.
    let open: Vec<(String, (Connection, Value))> = state.permissions.lock().unwrap().drain().collect();
    for (key, (owner, id)) in open {
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
    let (conn, id) = state.permissions.lock().unwrap().remove(&key).ok_or("Diese Freigabe ist nicht mehr offen")?;
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
