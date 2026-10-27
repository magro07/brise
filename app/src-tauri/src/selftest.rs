//! `brise --self-test`: prüft ohne Fenster die Teile, die je nach Betriebssystem
//! schiefgehen können – Vibe-Installation, ACP-Start, weitere Agent-Backends,
//! MCP-Server, Terminal, Git. Läuft in der CI auf Windows, macOS und Linux.
//!
//! `BRISE_SELFTEST_PROMPT=1` schickt jedem erreichbaren Backend außerdem einen
//! echten Mini-Prompt (kostet ein paar Tokens beim jeweiligen Anbieter).

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn report(name: &str, ok: bool, detail: impl AsRef<str>) -> bool {
    println!("{} {name}: {}", if ok { "✔" } else { "✘" }, detail.as_ref());
    ok
}

/// Startet `brise <flag>` als MCP-Server und fragt die Werkzeugliste ab.
fn check_mcp(flag: &[&str]) -> Result<usize, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe).args(flag).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().unwrap();
    for msg in [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    ] {
        writeln!(stdin, "{msg}").map_err(|e| e.to_string())?;
    }
    drop(stdin);
    let mut tools = None;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if v["id"] == 2 {
            tools = v["result"]["tools"].as_array().map(Vec::len);
        }
    }
    let _ = child.wait();
    tools.ok_or_else(|| "keine Werkzeugliste".into())
}

fn check_pty() -> Result<String, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pty = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/C", "echo brise-pty-ok"]);
        c
    } else {
        let mut c = CommandBuilder::new("/bin/sh");
        c.args(["-c", "echo brise-pty-ok"]);
        c
    };
    cmd.cwd(std::env::temp_dir());
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut all = String::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
            // Windows-ConPTY fragt beim Start die Cursorposition ab und wartet auf
            // die Antwort (in der App beantwortet das xterm.js).
            if chunk.contains("\x1b[6n") {
                let _ = writer.write_all(b"\x1b[1;1R");
                let _ = writer.flush();
            }
            all.push_str(&chunk);
            if all.contains("brise-pty-ok") {
                let _ = tx.send(all.clone());
                break;
            }
        }
    });
    let out = rx.recv_timeout(Duration::from_secs(15)).map_err(|_| "keine Ausgabe vom Terminal".to_string())?;
    let _ = child.kill();
    Ok(out.lines().find(|l| l.contains("brise-pty-ok")).unwrap_or("").trim().to_string())
}

async fn check_acp() -> Result<String, String> {
    let path = crate::agent::find_vibe_acp().ok_or("vibe-acp nicht gefunden")?;
    let (conn, _events, _child) = crate::rpc::spawn(path.as_os_str(), &[], None).map_err(|e| e.to_string())?;
    let init = tokio::time::timeout(
        Duration::from_secs(90),
        conn.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "_meta": { "browser-auth-delegated": true } } })),
    )
    .await
    .map_err(|_| "Zeitüberschreitung bei initialize".to_string())?
    .map_err(|e| e.to_string())?;
    let auth = conn.request("_auth/status", json!({})).await.map_err(|e| e.to_string())?;
    let methods: Vec<&str> = init["authMethods"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect();
    Ok(format!(
        "{} {} · Anmeldung: {} · Methoden: {}",
        init["agentInfo"]["title"].as_str().unwrap_or("?"),
        init["agentInfo"]["version"].as_str().unwrap_or("?"),
        auth["authenticated"],
        methods.join(", ")
    ))
}

/// Startet ein weiteres Backend (Claude Code, Codex, Gemini), legt eine Session
/// an und schickt auf Wunsch einen Mini-Prompt.
async fn check_backend(b: &'static dyn crate::backends::Backend, with_prompt: bool) -> Result<String, String> {
    use crate::rpc::Incoming;
    let launch = b.locate().ok_or("nicht installiert")?;
    let (conn, mut events, _child) = crate::rpc::spawn(launch.program.as_os_str(), &launch.args, None).map_err(|e| e.to_string())?;
    let init = tokio::time::timeout(
        Duration::from_secs(90),
        conn.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false } })),
    )
    .await
    .map_err(|_| "Zeitüberschreitung bei initialize".to_string())?
    .map_err(|e| e.to_string())?;
    let auth = tokio::task::spawn_blocking(move || b.probe_auth()).await.ok().flatten().unwrap_or(Value::Null);
    let dir = std::env::temp_dir().join(format!("brise-selftest-{}", b.id()));
    let _ = std::fs::create_dir_all(&dir);
    let session = tokio::time::timeout(Duration::from_secs(60), conn.request("session/new", json!({ "cwd": dir.display().to_string(), "mcpServers": [] })))
        .await
        .map_err(|_| "Zeitüberschreitung bei session/new".to_string())?
        .map_err(|e| e.to_string())?;
    let sid = session["sessionId"].as_str().ok_or("keine sessionId")?.to_string();
    let modes = session["modes"]["availableModes"].as_array().map_or(0, Vec::len);
    let models = session["configOptions"].as_array().into_iter().flatten().find(|o| o["id"] == "model").and_then(|o| o["options"].as_array()).map_or(0, Vec::len);
    let mut detail = format!(
        "{} {} · {} · {modes} Modi, {models} Modelle · Anmeldung: {}",
        init["agentInfo"]["title"].as_str().unwrap_or("?"),
        init["agentInfo"]["version"].as_str().unwrap_or("?"),
        launch.display(),
        auth["label"].as_str().unwrap_or("unbekannt")
    );
    if with_prompt {
        let conn2 = conn.clone();
        let text = Arc::new(std::sync::Mutex::new(String::new()));
        let sink = text.clone();
        let collect = tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
                match ev {
                    Incoming::Notification { method, params } if method == "session/update" => {
                        if params["update"]["sessionUpdate"] == "agent_message_chunk" {
                            sink.lock().unwrap().push_str(params["update"]["content"]["text"].as_str().unwrap_or(""));
                        }
                    }
                    // Werkzeuge braucht der Mini-Prompt nicht: alles ablehnen.
                    Incoming::Request { id, method, .. } if method == "session/request_permission" => {
                        conn2.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })));
                    }
                    Incoming::Request { id, method, .. } => conn2.respond(id, Err(crate::rpc::RpcError::method_not_found(&method))),
                    _ => {}
                }
            }
        });
        let started = Instant::now();
        let r = tokio::time::timeout(
            Duration::from_secs(90),
            conn.request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": "Antworte nur mit dem Wort OK." }] })),
        )
        .await
        .map_err(|_| format!("{detail} · keine Antwort nach 90 s – Anmeldung prüfen (abgelehnte Tokens wiederholt der Agent still)"))?
        .map_err(|e| e.to_string())?;
        // Die letzten Updates können kurz nach der Antwort eintreffen.
        tokio::time::sleep(Duration::from_millis(300)).await;
        collect.abort();
        let text = text.lock().unwrap().clone();
        let stop = r["stopReason"].as_str().unwrap_or("?").to_string();
        let answer: String = text.trim().chars().take(60).collect();
        detail.push_str(&format!(" · Prompt: {stop} nach {:.1} s, Antwort „{answer}“", started.elapsed().as_secs_f32()));
        if stop != "end_turn" || answer.is_empty() {
            return Err(detail);
        }
    }
    Ok(detail)
}

pub fn run() -> i32 {
    let started = Instant::now();
    println!("Brise {} Selbsttest auf {}/{}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    println!("Datenordner: {}", crate::installer::data_dir().display());
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("Tokio");
    let mut ok = true;

    // 1. Vibe finden oder installieren
    match crate::agent::find_vibe_acp() {
        Some(p) => ok &= report("Vibe", true, format!("gefunden: {}", p.display())),
        None => {
            let progress: crate::installer::Progress = Arc::new(|stage: &str, line: String| println!("   [{stage}] {line}"));
            match rt.block_on(crate::installer::install_vibe_with(&progress)) {
                Ok(p) => ok &= report("Vibe-Installation", true, p),
                Err(e) => ok &= report("Vibe-Installation", false, e),
            }
        }
    }

    // 2. ACP
    match rt.block_on(check_acp()) {
        Ok(info) => ok &= report("ACP", true, info),
        Err(e) => ok &= report("ACP", false, e),
    }

    // 3. Weitere Agent-Backends: nur prüfen, was installiert ist (kein Fehlschlag, wenn nicht).
    //    `BRISE_SELFTEST_INSTALL=claude,codex` installiert fehlende Adapter vorher mit npm.
    let with_prompt = std::env::var_os("BRISE_SELFTEST_PROMPT").is_some_and(|v| v == "1");
    let install = std::env::var("BRISE_SELFTEST_INSTALL").unwrap_or_default();
    for b in crate::backends::all().into_iter().filter(|b| b.id() != crate::backends::DEFAULT_BACKEND) {
        if b.locate().is_none() && install.split(',').any(|id| id.trim() == b.id()) {
            let progress: crate::installer::Progress = Arc::new(|stage: &str, line: String| println!("   [{stage}] {line}"));
            if let Err(e) = rt.block_on(crate::backends::install_node_agent(b.id(), &progress)) {
                ok &= report(&format!("{}-Installation", b.title()), false, e);
                continue;
            }
        }
        if b.locate().is_none() {
            report(b.title(), true, match b.install_blocker() {
                Some(why) => format!("nicht installiert ({why})"),
                None => "nicht installiert – in Brise unter Einstellungen → Agenten installierbar".into(),
            });
            continue;
        }
        match rt.block_on(check_backend(b, with_prompt)) {
            Ok(info) => ok &= report(b.title(), true, info),
            Err(e) => ok &= report(b.title(), false, e),
        }
    }

    // 4. Eigene MCP-Server
    for (name, flag) in [("MCP brise-app", vec!["--mcp-app"]), ("MCP brise-search", vec!["--mcp-search", "."]), ("MCP brise-council", vec!["--mcp-council", "."])] {
        match check_mcp(&flag) {
            Ok(n) => ok &= report(name, n > 0, format!("{n} Werkzeuge")),
            Err(e) => ok &= report(name, false, e),
        }
    }

    // 5. Terminal
    match check_pty() {
        Ok(line) => ok &= report("Terminal (PTY)", true, line),
        Err(e) => ok &= report("Terminal (PTY)", false, e),
    }

    // 6. Git und Schlüsselbund (nur Hinweise, kein Fehlschlag)
    report("Git", crate::git::find_git().is_some(), crate::git::find_git().map(|p| p.display().to_string()).unwrap_or_else(|| "nicht gefunden – Brise bietet die Installation an".into()));
    // Computer Use: nur melden, was ginge – nichts aufnehmen, nichts klicken. Kein
    // Fehlschlag ohne Bildschirm (CI) oder ohne erteilte Rechte (macOS).
    let caps = rt.block_on(crate::computer::capabilities());
    report("Computer Use", true, format!("{} · {}", caps.backend, if crate::computer::settings().enabled { "eingeschaltet" } else { "aus (Standard)" }));
    report("  Bildschirm", true, format!("{} {}", if caps.screenshot { "verfügbar:" } else { "nicht verfügbar:" }, caps.screenshot_detail));
    report("  Eingabe", true, format!("{} {}", if caps.input { "verfügbar:" } else { "nicht verfügbar:" }, caps.input_detail));
    report("Mistral-Key", true, if crate::credentials::read_key().is_some() { "vorhanden" } else { "nicht gesetzt (in der CI erwartet)" });

    println!("{} nach {:.1} s", if ok { "Alles in Ordnung" } else { "Selbsttest fehlgeschlagen" }, started.elapsed().as_secs_f32());
    if ok {
        0
    } else {
        1
    }
}
