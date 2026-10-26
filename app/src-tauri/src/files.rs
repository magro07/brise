//! Dateien für den eingebauten Editor lesen und schreiben – nur innerhalb des
//! Projektordners – und das Projekt in einem externen Editor öffnen.

use std::path::{Path, PathBuf};

use serde::Serialize;

type CmdResult<T> = Result<T, String>;

const MAX_EDIT_BYTES: u64 = 4 * 1024 * 1024;

/// Löst `rel` im Projekt auf und verhindert Ausbrüche über `..` oder Links.
fn resolve(cwd: &str, rel: &str) -> CmdResult<PathBuf> {
    let root = std::fs::canonicalize(cwd).map_err(|e| format!("{cwd}: {e}"))?;
    let joined = root.join(rel);
    let real = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        // Neue Datei: den Elternordner prüfen.
        Err(_) => std::fs::canonicalize(joined.parent().ok_or("Ungültiger Pfad")?)
            .map_err(|e| e.to_string())?
            .join(joined.file_name().ok_or("Ungültiger Pfad")?),
    };
    if !real.starts_with(&root) {
        return Err("Pfad liegt außerhalb des Projekts".into());
    }
    Ok(real)
}

#[tauri::command]
pub fn read_project_file(cwd: String, path: String) -> CmdResult<String> {
    let p = resolve(&cwd, &path)?;
    let len = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if len > MAX_EDIT_BYTES {
        return Err("Datei ist zu groß für den Editor (über 4 MB).".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("Binärdatei – kann nicht als Text angezeigt werden.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub fn write_project_file(cwd: String, path: String, content: String) -> CmdResult<()> {
    let p = resolve(&cwd, &path)?;
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    id: String,
    name: String,
}

const EDITORS: &[(&str, &str)] = &[("code", "VS Code"), ("codium", "VSCodium"), ("cursor", "Cursor"), ("zed", "Zed"), ("idea", "IntelliJ IDEA")];

fn which(bin: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) { vec![format!("{bin}.cmd"), format!("{bin}.exe")] } else { vec![bin.into()] };
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// Installierte externe Editoren (VS Code & Co.).
#[tauri::command]
pub fn external_editors() -> Vec<ExternalEditor> {
    EDITORS.iter().filter(|(bin, _)| which(bin).is_some()).map(|(bin, name)| ExternalEditor { id: bin.to_string(), name: name.to_string() }).collect()
}

#[tauri::command]
pub fn open_in_external(editor: String, cwd: String, path: Option<String>, line: Option<u32>) -> CmdResult<()> {
    let bin = which(&editor).ok_or("Editor nicht gefunden")?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(&cwd);
    if let Some(p) = path {
        let file = Path::new(&cwd).join(p);
        if matches!(editor.as_str(), "code" | "codium" | "cursor") {
            cmd.arg("--goto").arg(format!("{}:{}", file.display(), line.unwrap_or(1)));
        } else {
            cmd.arg(file);
        }
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
