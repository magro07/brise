//! Brise ACP-Spike: ein kleiner Konsolen-Client, der `vibe-acp` über das
//! Agent Client Protocol steuert – Initialize, Plan-Login, Session, Prompt,
//! Streaming und Freigaben. Dient nur dazu, das Protokoll für die spätere
//! Tauri-App zu verstehen.

mod rpc;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use rpc::{Connection, Incoming, RpcError};

const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const YELLOW: &str = "\x1b[33m";
const RESET: &str = "\x1b[0m";

const HELP: &str = "\
brise-acp – ACP-Spike für Mistral Vibe

Aufruf: brise-acp [Optionen]

  --cwd <ordner>     Projektordner der Session (Standard: aktueller Ordner)
  --prompt <text>    Nur diesen einen Prompt senden und danach beenden
  --mode <id>        Agent-Modus setzen (z. B. ask, accept-edits, auto-approve)
  --trace <datei>    Gesamten JSON-RPC-Verkehr und stderr von vibe-acp mitschreiben
  --login            Anmeldung über den Mistral-Plan erzwingen, auch wenn schon angemeldet
  --agent <befehl>   Agent-Programm (Standard: vibe-acp)
  -h, --help         Diese Hilfe

Befehle in der Sitzung: /mode <id>, /status, /cancel, /quit
Ctrl+C bricht den laufenden Turn ab.";

struct Args {
    cwd: PathBuf,
    prompt: Option<String>,
    mode: Option<String>,
    trace: Option<PathBuf>,
    force_login: bool,
    agent: String,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        cwd: std::env::current_dir()?,
        prompt: None,
        mode: None,
        trace: None,
        force_login: false,
        agent: "vibe-acp".into(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().with_context(|| format!("{arg} braucht einen Wert"));
        match arg.as_str() {
            "--cwd" => args.cwd = PathBuf::from(value()?),
            "--prompt" => args.prompt = Some(value()?),
            "--mode" => args.mode = Some(value()?),
            "--trace" => args.trace = Some(PathBuf::from(value()?)),
            "--agent" => args.agent = value()?,
            "--login" => args.force_login = true,
            "-h" | "--help" => {
                println!("{HELP}");
                std::process::exit(0);
            }
            other => bail!("Unbekannte Option {other} (siehe --help)"),
        }
    }
    args.cwd = std::fs::canonicalize(&args.cwd).with_context(|| format!("Ordner {:?}", args.cwd))?;
    Ok(args)
}

/// Zeilen von stdin. Was während eines Turns getippt wird, landet im Puffer
/// und dient als Antwort auf die nächste Rückfrage oder als nächster Prompt.
struct Input {
    rx: mpsc::UnboundedReceiver<String>,
    buffer: VecDeque<String>,
    closed: bool,
}

impl Input {
    fn start() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self { rx, buffer: VecDeque::new(), closed: false }
    }

    async fn next(&mut self) -> Option<String> {
        if let Some(line) = self.buffer.pop_front() {
            return Some(line);
        }
        if self.closed {
            return None;
        }
        let line = self.rx.recv().await;
        self.closed = line.is_none();
        line
    }
}

/// Merkt sich, was gerade auf dem Bildschirm steht, damit Text-Streaming und
/// Tool-Karten sauber getrennt werden.
#[derive(Default)]
struct Ui {
    streaming: Option<&'static str>,
    tool_titles: HashMap<String, String>,
    usage: Option<Value>,
    title: Option<String>,
}

impl Ui {
    fn stream(&mut self, kind: &'static str, text: &str) {
        if self.streaming != Some(kind) {
            self.end_stream();
            if kind == "thought" {
                print!("{DIM}💭 ");
            }
            self.streaming = Some(kind);
        }
        print!("{text}");
        flush();
    }

    fn end_stream(&mut self) {
        if self.streaming.take().is_some() {
            println!("{RESET}");
        }
    }

    fn line(&mut self, text: impl AsRef<str>) {
        self.end_stream();
        println!("{}", text.as_ref());
    }
}

fn flush() {
    let _ = std::io::stdout().flush();
}

fn short(v: &Value, max: usize) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let s = s.replace('\n', "⏎");
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let (conn, mut events, _child) = rpc::spawn(&args.agent, &[], args.trace.as_deref())?;
    let mut input = Input::start();
    let mut ui = Ui::default();

    // 1. Initialize: eigene Fähigkeiten melden, Auth-Methoden erfahren.
    let init = conn
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false,
                    // Vibe-spezifisch: Wir öffnen den Login-Link selbst.
                    "_meta": { "browser-auth-delegated": true }
                },
                "clientInfo": { "name": "brise-acp-spike", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await?;
    let agent = &init["agentInfo"];
    println!(
        "{BOLD}{} {}{RESET} {DIM}(ACP v{}){RESET}",
        agent["title"].as_str().unwrap_or("Agent"),
        agent["version"].as_str().unwrap_or("?"),
        init["protocolVersion"]
    );
    let methods: Vec<&str> =
        init["authMethods"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect();
    println!("{DIM}Auth-Methoden: {}{RESET}", methods.join(", "));

    // 2. Anmeldung über den Mistral-Plan, falls nötig.
    login(&conn, &methods, args.force_login).await?;

    // 3. Session für den Projektordner anlegen.
    let session = conn
        .request("session/new", json!({ "cwd": args.cwd, "mcpServers": [] }))
        .await
        .context("session/new")?;
    let session_id = session["sessionId"].as_str().context("keine sessionId")?.to_string();
    print_session_info(&session, &args.cwd);

    if let Some(mode) = &args.mode {
        set_mode(&conn, &session_id, mode).await;
    }

    // 4. Prompts senden.
    if let Some(prompt) = args.prompt.clone() {
        run_turn(&conn, &mut events, &mut input, &mut ui, &session_id, &prompt).await?;
        return Ok(());
    }

    println!("{DIM}Tippe einen Prompt. /quit beendet.{RESET}");
    loop {
        drain_events(&conn, &mut events, &mut input, &mut ui).await;
        print!("{CYAN}{BOLD}› {RESET}");
        flush();
        let Some(line) = input.next().await else { break };
        let line = line.trim();
        match line {
            "" => continue,
            "/quit" | "/exit" => break,
            "/status" => match conn.request("_auth/status", json!({})).await {
                Ok(v) => println!("{DIM}{v}{RESET}"),
                Err(e) => println!("{RED}{e}{RESET}"),
            },
            "/cancel" => println!("{DIM}Gerade läuft nichts.{RESET}"),
            _ if line.starts_with("/mode ") => set_mode(&conn, &session_id, line[6..].trim()).await,
            _ => run_turn(&conn, &mut events, &mut input, &mut ui, &session_id, line).await?,
        }
    }
    Ok(())
}

async fn login(conn: &Connection, methods: &[&str], force: bool) -> Result<()> {
    let status = conn.request("_auth/status", json!({})).await.unwrap_or(Value::Null);
    if status["authenticated"].as_bool() == Some(true) && !force {
        println!(
            "{GREEN}✓ Angemeldet{RESET} {DIM}(Quelle: {}){RESET}",
            status["authState"].as_str().unwrap_or("?")
        );
        return Ok(());
    }

    if methods.contains(&"browser-auth-delegated") {
        // Variante für GUIs: Agent liefert die URL, wir öffnen den Browser,
        // danach wartet "complete", bis der Login im Browser abgeschlossen ist.
        let start = conn
            .request("authenticate", json!({ "methodId": "browser-auth-delegated", "_meta": { "action": "start" } }))
            .await?;
        let meta = &start["_meta"]["browser-auth-delegated"];
        let url = meta["signInUrl"].as_str().context("keine signInUrl")?;
        let attempt = meta["attemptId"].as_str().context("keine attemptId")?;
        println!("{YELLOW}Bitte im Browser bei Mistral anmelden:{RESET}\n  {url}");
        if let Err(e) = open::that(url) {
            println!("{DIM}(Browser ließ sich nicht öffnen: {e} – Link bitte selbst öffnen){RESET}");
        }
        println!("{DIM}Warte auf Abschluss der Anmeldung …{RESET}");
        let done = conn
            .request(
                "authenticate",
                json!({ "methodId": "browser-auth-delegated", "_meta": { "action": "complete", "attemptId": attempt } }),
            )
            .await?;
        println!("{GREEN}✓ Angemeldet{RESET} {DIM}{}{RESET}", done["_meta"]["browser-auth-delegated"]);
    } else if methods.contains(&"browser-auth") {
        // Fallback: vibe-acp öffnet den Browser selbst und blockiert bis zum Ende.
        println!("{YELLOW}Anmeldung im Browser läuft …{RESET}");
        conn.request("authenticate", json!({ "methodId": "browser-auth" })).await?;
        println!("{GREEN}✓ Angemeldet{RESET}");
    } else {
        bail!("Nicht angemeldet und keine Browser-Anmeldung angeboten – `vibe --setup` ausführen.");
    }
    Ok(())
}

fn print_session_info(session: &Value, cwd: &std::path::Path) {
    println!(
        "{DIM}Session {} in {}{RESET}",
        session["sessionId"].as_str().unwrap_or("?"),
        cwd.display()
    );
    let modes = &session["modes"];
    if let Some(list) = modes["availableModes"].as_array() {
        let ids: Vec<&str> = list.iter().filter_map(|m| m["id"].as_str()).collect();
        println!(
            "{DIM}Modus: {} (verfügbar: {}){RESET}",
            modes["currentModeId"].as_str().unwrap_or("?"),
            ids.join(", ")
        );
    }
    let trust = &session["_meta"]["workspace_trust"];
    if !trust.is_null() {
        println!("{DIM}Ordner-Vertrauen: {}{RESET}", trust["status"].as_str().unwrap_or("?"));
    }
}

async fn set_mode(conn: &Connection, session_id: &str, mode: &str) {
    match conn.request("session/set_mode", json!({ "sessionId": session_id, "modeId": mode })).await {
        Ok(_) => println!("{DIM}Modus jetzt: {mode}{RESET}"),
        Err(e) => println!("{RED}Modus nicht gesetzt: {e}{RESET}"),
    }
}

/// Verarbeitet, was sich zwischen zwei Turns angesammelt hat (z. B. Befehlslisten).
async fn drain_events(
    conn: &Connection,
    events: &mut mpsc::UnboundedReceiver<Incoming>,
    input: &mut Input,
    ui: &mut Ui,
) {
    while let Ok(ev) = events.try_recv() {
        handle_incoming(conn, ev, input, ui).await;
    }
}

async fn run_turn(
    conn: &Connection,
    events: &mut mpsc::UnboundedReceiver<Incoming>,
    input: &mut Input,
    ui: &mut Ui,
    session_id: &str,
    text: &str,
) -> Result<()> {
    let prompt = {
        let conn = conn.clone();
        let params = json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] });
        tokio::spawn(async move { conn.request("session/prompt", params).await })
    };
    tokio::pin!(prompt);
    let mut cancelled = false;

    loop {
        tokio::select! {
            res = &mut prompt => {
                // Restliche Updates, die vor der Antwort eintrafen, noch zeigen.
                drain_events(conn, events, input, ui).await;
                match res? {
                    Ok(v) => {
                        let reason = v["stopReason"].as_str().unwrap_or("?");
                        let colour = if reason == "end_turn" { GREEN } else { YELLOW };
                        ui.line(format!("{colour}■ Turn beendet: {reason}{RESET}"));
                        if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
                            ui.line(format!("{DIM}  Verbrauch: {usage}{RESET}"));
                        }
                        if let Some(u) = &ui.usage {
                            ui.line(format!(
                                "{DIM}  Kontext: {} Tokens, {} Schritte{RESET}",
                                u["lastTurnTotalTokens"], u["steps"]
                            ));
                        }
                        if let Some(title) = &ui.title {
                            ui.line(format!("{DIM}  Session-Titel: {}{RESET}", short(&json!(title), 80)));
                        }
                    }
                    Err(e) => ui.line(format!("{RED}■ Fehler: {e}{RESET}")),
                }
                return Ok(());
            }
            Some(ev) = events.recv() => handle_incoming(conn, ev, input, ui).await,
            line = input.rx.recv(), if !input.closed => match line {
                Some(l) if l.trim() == "/cancel" => cancel(conn, session_id, ui, &mut cancelled),
                Some(l) => input.buffer.push_back(l),
                None => input.closed = true,
            },
            _ = tokio::signal::ctrl_c() => {
                if cancelled {
                    ui.line("Beende.");
                    std::process::exit(130);
                }
                cancel(conn, session_id, ui, &mut cancelled);
            }
        }
    }
}

fn cancel(conn: &Connection, session_id: &str, ui: &mut Ui, cancelled: &mut bool) {
    conn.notify("session/cancel", json!({ "sessionId": session_id }));
    *cancelled = true;
    ui.line(format!("{YELLOW}… Abbruch angefordert (nochmal Ctrl+C beendet){RESET}"));
}

async fn handle_incoming(conn: &Connection, ev: Incoming, input: &mut Input, ui: &mut Ui) {
    match ev {
        Incoming::Notification { method, params } if method == "session/update" => {
            render_update(&params["update"], ui)
        }
        Incoming::Notification { method, params } => {
            ui.line(format!("{DIM}[{method}] {}{RESET}", short(&params, 160)))
        }
        Incoming::Request { id, method, params } => {
            let result = match method.as_str() {
                "session/request_permission" => ask_permission(&params, input, ui).await,
                "fs/read_text_file" => fs_read(&params, ui),
                "fs/write_text_file" => fs_write(&params, ui),
                _ => {
                    ui.line(format!("{DIM}[unbeantwortete Anfrage {method}]{RESET}"));
                    Err(RpcError::method_not_found(&method))
                }
            };
            conn.respond(id, result);
        }
    }
}

fn render_update(update: &Value, ui: &mut Ui) {
    let kind = update["sessionUpdate"].as_str().unwrap_or("");
    match kind {
        "agent_message_chunk" | "agent_thought_chunk" => {
            let content = &update["content"];
            let text = match content["type"].as_str() {
                Some("text") => content["text"].as_str().unwrap_or("").to_string(),
                Some(other) => format!("[{other}]"),
                None => String::new(),
            };
            ui.stream(if kind == "agent_message_chunk" { "message" } else { "thought" }, &text);
        }
        "user_message_chunk" => {}
        "tool_call" => {
            let id = update["toolCallId"].as_str().unwrap_or("").to_string();
            let title = update["title"].as_str().unwrap_or("Tool").to_string();
            ui.line(format!(
                "{CYAN}⚙ {title}{RESET} {DIM}[{}] {}{RESET}",
                update["kind"].as_str().unwrap_or("other"),
                update["status"].as_str().unwrap_or("pending")
            ));
            ui.tool_titles.insert(id, title);
        }
        "tool_call_update" => {
            let id = update["toolCallId"].as_str().unwrap_or("");
            if let Some(title) = update["title"].as_str() {
                ui.tool_titles.insert(id.to_string(), title.to_string());
            }
            let title = ui.tool_titles.get(id).cloned().unwrap_or_else(|| id.to_string());
            for item in update["content"].as_array().into_iter().flatten() {
                if item["type"] == "diff" {
                    let old = item["oldText"].as_str().unwrap_or("").lines().count();
                    let new = item["newText"].as_str().unwrap_or("").lines().count();
                    ui.line(format!(
                        "  {YELLOW}✎ {}{RESET} {DIM}({old} → {new} Zeilen){RESET}",
                        item["path"].as_str().unwrap_or("?")
                    ));
                }
            }
            match update["status"].as_str() {
                Some("completed") => ui.line(format!("  {GREEN}✓{RESET} {DIM}{title}{RESET}")),
                Some("failed") => ui.line(format!("  {RED}✗ {title}{RESET}")),
                _ => {}
            }
        }
        "plan" => {
            ui.line(format!("{BOLD}Plan:{RESET}"));
            for entry in update["entries"].as_array().into_iter().flatten() {
                let mark = match entry["status"].as_str() {
                    Some("completed") => "☑",
                    Some("in_progress") => "▶",
                    _ => "☐",
                };
                ui.line(format!("  {mark} {}", entry["content"].as_str().unwrap_or("")));
            }
        }
        "current_mode_update" => {
            ui.line(format!("{DIM}Modus jetzt: {}{RESET}", update["currentModeId"].as_str().unwrap_or("?")))
        }
        "available_commands_update" => {
            let n = update["availableCommands"].as_array().map_or(0, Vec::len);
            ui.line(format!("{DIM}[{n} Slash-Befehle verfügbar]{RESET}"));
        }
        // Kommen mitten im Streaming – nur merken, nicht dazwischenschreiben.
        "usage_update" => ui.usage = Some(update["_meta"].clone()),
        "session_info_update" => ui.title = update["title"].as_str().map(str::to_string),
        other => ui.line(format!("{DIM}[{other}] {}{RESET}", short(update, 160))),
    }
}

async fn ask_permission(params: &Value, input: &mut Input, ui: &mut Ui) -> Result<Value, RpcError> {
    // Vibe schickt hier oft nur die toolCallId; den Titel kennen wir aus dem tool_call-Update.
    let tool = &params["toolCall"];
    let title = tool["title"]
        .as_str()
        .map(str::to_string)
        .or_else(|| tool["toolCallId"].as_str().and_then(|id| ui.tool_titles.get(id).cloned()))
        .unwrap_or_else(|| "Tool-Aufruf".into());
    ui.line(format!("{YELLOW}{BOLD}? Freigabe nötig:{RESET} {title}"));
    if let Some(raw) = tool.get("rawInput").filter(|v| !v.is_null()) {
        ui.line(format!("  {DIM}{}{RESET}", short(raw, 300)));
    }
    let options: Vec<&Value> = params["options"].as_array().into_iter().flatten().collect();
    for (i, opt) in options.iter().enumerate() {
        // Vibe-Erweiterung: Für "immer erlauben" steht das Befehlsmuster in _meta.
        let patterns: Vec<&str> = opt["_meta"]["required_permissions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["label"].as_str())
            .collect();
        let scope = if patterns.is_empty() { String::new() } else { format!(" für „{}“", patterns.join(", ")) };
        ui.line(format!(
            "  [{}] {}{scope} {DIM}({}){RESET}",
            i + 1,
            opt["name"].as_str().unwrap_or("?"),
            opt["kind"].as_str().unwrap_or("?")
        ));
    }
    print!("  Auswahl (Nummer, leer = ablehnen): ");
    flush();
    let answer = input.next().await.unwrap_or_default();
    let choice = answer.trim().parse::<usize>().ok().and_then(|n| options.get(n.wrapping_sub(1)));
    Ok(match choice {
        Some(opt) => {
            ui.line(format!("  {DIM}→ {}{RESET}", opt["name"].as_str().unwrap_or("")));
            json!({ "outcome": { "outcome": "selected", "optionId": opt["optionId"] } })
        }
        None => {
            ui.line(format!("  {DIM}→ abgebrochen{RESET}"));
            json!({ "outcome": { "outcome": "cancelled" } })
        }
    })
}

fn fs_read(params: &Value, ui: &mut Ui) -> Result<Value, RpcError> {
    let path = params["path"].as_str().ok_or_else(|| RpcError::new(-32602, "path fehlt"))?;
    ui.line(format!("  {DIM}↳ fs/read_text_file {path}{RESET}"));
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

fn fs_write(params: &Value, ui: &mut Ui) -> Result<Value, RpcError> {
    let path = params["path"].as_str().ok_or_else(|| RpcError::new(-32602, "path fehlt"))?;
    let content = params["content"].as_str().unwrap_or("");
    ui.line(format!("  {DIM}↳ fs/write_text_file {path} ({} Bytes){RESET}", content.len()));
    let path = std::path::Path::new(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    std::fs::write(path, content).map_err(|e| RpcError::internal(format!("{}: {e}", path.display())))?;
    Ok(Value::Null)
}
