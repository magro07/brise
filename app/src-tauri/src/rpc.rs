//! Minimaler JSON-RPC-2.0-Transport über stdin/stdout eines Kindprozesses,
//! eine JSON-Nachricht pro Zeile – so wie ACP es vorschreibt.

use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// Nachricht, die der Agent von sich aus an uns schickt.
#[derive(Debug)]
pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("Methode nicht unterstützt: {method}"))
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(-32603, message)
    }

    fn closed() -> Self {
        Self::new(-32000, "Verbindung zum Agenten beendet")
    }

    fn from_value(v: &Value) -> Self {
        Self {
            code: v["code"].as_i64().unwrap_or(-32603),
            message: v["message"].as_str().unwrap_or("unbekannter Fehler").to_string(),
            data: v.get("data").cloned(),
        }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JSON-RPC-Fehler {}: {}", self.code, self.message)?;
        if let Some(data) = &self.data {
            write!(f, " ({data})")?;
        }
        Ok(())
    }
}

impl std::error::Error for RpcError {}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// Schreibt den kompletten Verkehr mit, damit man das Protokoll nachlesen kann.
#[derive(Clone)]
struct Tracer(Arc<Mutex<File>>);

impl Tracer {
    fn log(&self, prefix: &str, line: &str) {
        if let Ok(mut f) = self.0.lock() {
            let _ = writeln!(f, "{prefix} {line}");
        }
    }
}

#[derive(Clone)]
pub struct Connection {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    tracer: Option<Tracer>,
}

/// Startet den Agenten und verbindet sich mit ihm.
pub fn spawn(
    program: &std::ffi::OsStr,
    args: &[String],
    trace: Option<&Path>,
) -> Result<(Connection, mpsc::UnboundedReceiver<Incoming>, Child)> {
    spawn_with_env(program, args, &[], trace)
}

/// Wie `spawn`, mit zusätzlichen Umgebungsvariablen für den Agenten.
pub fn spawn_with_env(
    program: &std::ffi::OsStr,
    args: &[String],
    env: &[(String, String)],
    trace: Option<&Path>,
) -> Result<(Connection, mpsc::UnboundedReceiver<Incoming>, Child)> {
    let tracer = match trace {
        Some(path) => Some(Tracer(Arc::new(Mutex::new(
            File::create(path).with_context(|| format!("Trace-Datei {path:?}"))?,
        )))),
        None => None,
    };

    let mut command = Command::new(program);
    // Von Brise mitgebrachtes Git (Windows) auch für Vibe sichtbar machen.
    if let Some(extra) = crate::git::extra_path() {
        let mut paths = vec![extra];
        paths.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    // Cortecs-Modelle in Vibe lesen den Schlüssel aus der Umgebung (`api_key_env_var`).
    if let Some(key) = crate::cortecs::read_key() {
        command.env("CORTECS_API_KEY", key);
    }
    command
        .envs(env.iter().map(|(k, v)| (k, v)))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if tracer.is_some() { Stdio::piped() } else { Stdio::null() })
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // kein Konsolenfenster unter Windows
    let mut child = command
        .spawn()
        .with_context(|| format!("Konnte {} nicht starten – ist Mistral Vibe installiert?", program.to_string_lossy()))?;

    let mut stdin = child.stdin.take().expect("stdin ist gepiped");
    let stdout = child.stdout.take().expect("stdout ist gepiped");

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    if let (Some(stderr), Some(t)) = (child.stderr.take(), tracer.clone()) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                t.log("!!", &line);
            }
        });
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    {
        let pending = pending.clone();
        let tracer = tracer.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(t) = &tracer {
                    t.log("<<", &line);
                }
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                dispatch(msg, &pending, &in_tx);
            }
            // Agent weg: alle offenen Anfragen scheitern lassen.
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err(RpcError::closed()));
            }
        });
    }

    let conn = Connection { out: out_tx, pending, next_id: Arc::new(AtomicU64::new(1)), tracer };
    Ok((conn, in_rx, child))
}

fn dispatch(mut msg: Value, pending: &Pending, in_tx: &mpsc::UnboundedSender<Incoming>) {
    let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
    match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
        (Some(method), Some(id)) => {
            let _ = in_tx.send(Incoming::Request { id: id.clone(), method: method.to_string(), params });
        }
        (Some(method), None) => {
            let _ = in_tx.send(Incoming::Notification { method: method.to_string(), params });
        }
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let Some(tx) = pending.lock().unwrap().remove(&id) else { return };
            let result = match msg.get("error") {
                Some(err) => Err(RpcError::from_value(err)),
                None => Ok(msg.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
            };
            let _ = tx.send(result);
        }
        (None, None) => {}
    }
}

impl Connection {
    /// Gehören beide Handles zum selben Agent-Prozess?
    pub fn same(&self, other: &Connection) -> bool {
        Arc::ptr_eq(&self.next_id, &other.next_id)
    }

    fn send(&self, msg: Value) {
        let line = msg.to_string();
        if let Some(t) = &self.tracer {
            t.log(">>", &line);
        }
        let _ = self.out.send(line);
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        rx.await.unwrap_or_else(|_| Err(RpcError::closed()))
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn respond(&self, id: Value, result: Result<Value, RpcError>) {
        let msg = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(e) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } })
            }
        };
        self.send(msg);
    }
}
