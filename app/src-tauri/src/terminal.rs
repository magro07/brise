//! Eingebautes Terminal: echte Pseudo-Terminals (portable-pty) mit der
//! Standard-Shell des Systems. Ausgaben gehen als `term:data`-Events an
//! xterm.js in der Oberfläche.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Term>>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command]
pub fn term_open(app: AppHandle, terms: State<'_, Terminals>, cwd: String, cols: u16, rows: u16) -> CmdResult<u32> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(default_shell());
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(extra) = crate::git::extra_path() {
        let mut paths = vec![extra];
        paths.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let id = terms.next.fetch_add(1, Ordering::SeqCst) + 1;

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Nur vollständige UTF-8-Zeichen weitergeben.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        let text = String::from_utf8_lossy(&pending[..valid]).to_string();
                        pending.drain(..valid);
                        let _ = app.emit("term:data", json!({ "id": id, "data": text }));
                    }
                }
            }
        }
        let _ = app.emit("term:exit", json!({ "id": id }));
    });

    terms.open.lock().unwrap().insert(id, Term { master: pty.master, writer, child });
    Ok(id)
}

#[tauri::command]
pub fn term_write(terms: State<'_, Terminals>, id: u32, data: String) -> CmdResult<()> {
    let mut open = terms.open.lock().unwrap();
    let term = open.get_mut(&id).ok_or("Terminal ist geschlossen")?;
    term.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    term.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(terms: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> CmdResult<()> {
    let open = terms.open.lock().unwrap();
    let term = open.get(&id).ok_or("Terminal ist geschlossen")?;
    term.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(terms: State<'_, Terminals>, id: u32) -> CmdResult<()> {
    if let Some(mut term) = terms.open.lock().unwrap().remove(&id) {
        let _ = term.child.kill();
    }
    Ok(())
}
