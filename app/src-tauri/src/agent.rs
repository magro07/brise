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

#[derive(Default)]
pub struct AgentState {
    conn: AsyncMutex<Option<Connection>>,
    child: AsyncMutex<Option<tokio::process::Child>>,
    /// Offene Freigabe-Anfragen: Schlüssel für die Oberfläche → JSON-RPC-ID.
    permissions: Arc<Mutex<HashMap<String, Value>>>,
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
    ]
    .into_iter()
    .find(|p| p.is_file())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    generation: u64,
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
    if let Some(mut old) = state.child.lock().await.take() {
        let _ = old.kill().await;
    }
    state.permissions.lock().unwrap().clear();

    let path = find_vibe_acp().ok_or("VIBE_NOT_FOUND")?;
    let trace = std::env::var_os("BRISE_ACP_TRACE").map(PathBuf::from);
    let (conn, events, child) = rpc::spawn(path.as_os_str(), &[], trace.as_deref()).map_err(|e| e.to_string())?;

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
    tauri::async_runtime::spawn(pump(app, conn.clone(), events, state.permissions.clone(), generation));
    *state.conn.lock().await = Some(conn);
    *state.child.lock().await = Some(child);

    let info = ConnectInfo { generation, agent_path: path.display().to_string(), init, auth };
    *state.info.lock().await = Some(info.clone());
    Ok(info)
}

/// Leitet alles, was der Agent von sich aus schickt, an die Oberfläche weiter.
async fn pump(
    app: AppHandle,
    conn: Connection,
    mut events: mpsc::UnboundedReceiver<Incoming>,
    permissions: Arc<Mutex<HashMap<String, Value>>>,
    generation: u64,
) {
    while let Some(ev) = events.recv().await {
        match ev {
            Incoming::Notification { method, params } if method == "session/update" => {
                let _ = app.emit("acp:update", params);
            }
            Incoming::Notification { method, params } => {
                let _ = app.emit("acp:notification", json!({ "method": method, "params": params }));
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => {
                    let key = format!("{generation}:{id}");
                    permissions.lock().unwrap().insert(key.clone(), id);
                    let _ = app.emit("acp:permission", json!({ "key": key, "request": params }));
                }
                "fs/read_text_file" => conn.respond(id, fs_read(&params)),
                "fs/write_text_file" => conn.respond(id, fs_write(&params)),
                _ => conn.respond(id, Err(RpcError::method_not_found(&method))),
            },
        }
    }
    let _ = app.emit("acp:closed", json!({ "generation": generation }));
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

#[tauri::command]
pub async fn new_session(state: State<'_, AgentState>, cwd: String) -> CmdResult<Value> {
    call(&state, "session/new", json!({ "cwd": cwd, "mcpServers": [] })).await
}

#[tauri::command]
pub async fn load_session(state: State<'_, AgentState>, cwd: String, session_id: String) -> CmdResult<Value> {
    call(&state, "session/load", json!({ "cwd": cwd, "sessionId": session_id, "mcpServers": [] })).await
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
pub async fn prompt(state: State<'_, AgentState>, session_id: String, prompt: Vec<Value>) -> CmdResult<Value> {
    call(&state, "session/prompt", json!({ "sessionId": session_id, "prompt": prompt })).await
}

#[tauri::command]
pub async fn set_config_option(
    state: State<'_, AgentState>,
    session_id: String,
    config_id: String,
    value: Value,
) -> CmdResult<Value> {
    call(&state, "session/set_config_option", json!({ "sessionId": session_id, "configId": config_id, "value": value }))
        .await
}

#[tauri::command]
pub async fn config_schema(state: State<'_, AgentState>) -> CmdResult<Value> {
    call(&state, "_config/schema", json!({})).await
}

#[tauri::command]
pub async fn delete_session(state: State<'_, AgentState>, session_id: String) -> CmdResult<Value> {
    call(&state, "_session/delete", json!({ "sessionId": session_id })).await
}

#[tauri::command]
pub async fn cancel(app: AppHandle, state: State<'_, AgentState>, session_id: String) -> CmdResult<()> {
    let conn = connection(&state).await?;
    // Laut ACP muss der Client offene Freigaben selbst als abgebrochen beantworten.
    let open: Vec<(String, Value)> = state.permissions.lock().unwrap().drain().collect();
    for (key, id) in open {
        conn.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })));
        let _ = app.emit("acp:permission-closed", json!({ "key": key, "optionId": null }));
    }
    conn.notify("session/cancel", json!({ "sessionId": session_id }));
    Ok(())
}

#[tauri::command]
pub async fn set_mode(state: State<'_, AgentState>, session_id: String, mode_id: String) -> CmdResult<Value> {
    call(&state, "session/set_mode", json!({ "sessionId": session_id, "modeId": mode_id })).await
}

#[tauri::command]
pub async fn respond_permission(
    app: AppHandle,
    state: State<'_, AgentState>,
    key: String,
    option_id: Option<String>,
) -> CmdResult<()> {
    let id = state.permissions.lock().unwrap().remove(&key).ok_or("Diese Freigabe ist nicht mehr offen")?;
    let outcome = match &option_id {
        Some(option) => json!({ "outcome": "selected", "optionId": option }),
        None => json!({ "outcome": "cancelled" }),
    };
    connection(&state).await?.respond(id, Ok(json!({ "outcome": outcome })));
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
