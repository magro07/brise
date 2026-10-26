//! `brise --self-test`: prüft ohne Fenster die Teile, die je nach Betriebssystem
//! schiefgehen können – Vibe-Installation, ACP-Start, MCP-Server, Terminal, Git.
//! Läuft in der CI auf Windows, macOS und Linux.

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
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut all = String::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            all.push_str(&String::from_utf8_lossy(&buf[..n]));
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

    // 3. Eigene MCP-Server
    for (name, flag) in [("MCP brise-app", vec!["--mcp-app"]), ("MCP brise-search", vec!["--mcp-search", "."])] {
        match check_mcp(&flag) {
            Ok(n) => ok &= report(name, n > 0, format!("{n} Werkzeuge")),
            Err(e) => ok &= report(name, false, e),
        }
    }

    // 4. Terminal
    match check_pty() {
        Ok(line) => ok &= report("Terminal (PTY)", true, line),
        Err(e) => ok &= report("Terminal (PTY)", false, e),
    }

    // 5. Git und Schlüsselbund (nur Hinweise, kein Fehlschlag)
    report("Git", crate::git::find_git().is_some(), crate::git::find_git().map(|p| p.display().to_string()).unwrap_or_else(|| "nicht gefunden – Brise bietet die Installation an".into()));
    report("Mistral-Key", true, if crate::credentials::read_key().is_some() { "vorhanden" } else { "nicht gesetzt (in der CI erwartet)" });

    println!("{} nach {:.1} s", if ok { "Alles in Ordnung" } else { "Selbsttest fehlgeschlagen" }, started.elapsed().as_secs_f32());
    if ok {
        0
    } else {
        1
    }
}
