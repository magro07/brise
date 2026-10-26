//! Lesen und Schreiben der Vibe-Konfiguration (`$VIBE_HOME/config.toml`,
//! Standard `~/.vibe/config.toml`). Geschrieben wird mit `toml_edit`, damit
//! Kommentare und Formatierung des Nutzers erhalten bleiben.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use toml_edit::{DocumentMut, Item};

type CmdResult<T> = Result<T, String>;

pub fn vibe_home() -> Option<PathBuf> {
    match std::env::var_os("VIBE_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".vibe")),
    }
}

fn config_path() -> CmdResult<PathBuf> {
    vibe_home().map(|h| h.join("config.toml")).ok_or_else(|| "Kein Home-Verzeichnis gefunden".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    path: String,
    exists: bool,
    values: Value,
}

#[tauri::command]
pub fn read_config() -> CmdResult<ConfigFile> {
    let path = config_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let values: toml::Table = toml::from_str(&text).map_err(|e| format!("config.toml ist ungültig: {e}"))?;
    Ok(ConfigFile {
        path: path.display().to_string(),
        exists: path.exists(),
        values: serde_json::to_value(values).map_err(|e| e.to_string())?,
    })
}

/// Setzt `key` auf oberster Ebene oder als Pfad (`tools.bash.allowlist`).
/// `value = null` entfernt den Eintrag, Vibe nimmt dann wieder seinen Standard.
#[tauri::command]
pub fn write_config_value(key: Vec<String>, value: Value) -> CmdResult<()> {
    if key.is_empty() {
        return Err("Leerer Schlüssel".into());
    }
    let path = config_path()?;
    let original = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc: DocumentMut = original.parse().map_err(|e| format!("config.toml ist ungültig: {e}"))?;

    let (last, parents) = key.split_last().expect("nicht leer");
    let mut table = doc.as_table_mut();
    for part in parents {
        if !table.contains_key(part) {
            table.insert(part, Item::Table(toml_edit::Table::new()));
        }
        table = table[part.as_str()].as_table_mut().ok_or_else(|| format!("{part} ist keine Tabelle"))?;
    }
    match &value {
        Value::Null => {
            table.remove(last);
        }
        // Listen von Objekten als [[tabelle]] schreiben, wie Vibe es selbst tut.
        Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_object) => {
            let mut array = toml_edit::ArrayOfTables::new();
            for item in items {
                let mut t = toml_edit::Table::new();
                for (k, v) in item.as_object().expect("geprüft") {
                    if !v.is_null() {
                        t.insert(k, Item::Value(json_to_toml(v)?));
                    }
                }
                array.push(t);
            }
            table.insert(last, Item::ArrayOfTables(array));
        }
        _ => {
            table.insert(last, Item::Value(json_to_toml(&value)?));
        }
    }

    // Einmalige Sicherung der Originaldatei, bevor Brise das erste Mal schreibt.
    let backup = path.with_extension("toml.brise-backup");
    if path.exists() && !backup.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("Backup fehlgeschlagen: {e}"))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("toml.brise-tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

fn json_to_toml(v: &Value) -> CmdResult<toml_edit::Value> {
    Ok(match v {
        Value::Bool(b) => (*b).into(),
        Value::Number(n) if n.is_i64() => n.as_i64().unwrap().into(),
        Value::Number(n) => n.as_f64().unwrap_or_default().into(),
        Value::String(s) => s.as_str().into(),
        Value::Array(items) => {
            let mut arr = toml_edit::Array::new();
            for item in items {
                arr.push(json_to_toml(item)?);
            }
            toml_edit::Value::Array(arr)
        }
        Value::Object(map) => {
            let mut table = toml_edit::InlineTable::new();
            for (k, item) in map {
                table.insert(k, json_to_toml(item)?);
            }
            toml_edit::Value::InlineTable(table)
        }
        Value::Null => return Err("null innerhalb eines Werts wird nicht unterstützt".into()),
    })
}

/// Dateien eines Projekts für `@`-Erwähnungen, unter Beachtung von .gitignore.
#[tauri::command]
pub fn list_project_files(cwd: String) -> CmdResult<Vec<String>> {
    let root = PathBuf::from(&cwd);
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(&root).hidden(true).max_depth(Some(12)).build().flatten() {
        if entry.file_type().is_some_and(|t| t.is_file()) {
            if let Ok(rel) = entry.path().strip_prefix(&root) {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        if files.len() >= 20_000 {
            break;
        }
    }
    files.sort();
    Ok(files)
}

/// Bild für einen Prompt laden (Base64 + MIME-Typ).
#[tauri::command]
pub fn read_image(path: String) -> CmdResult<(String, String)> {
    use base64::Engine;
    let mime = match PathBuf::from(&path).extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return Err("Nur PNG, JPEG, GIF und WebP werden unterstützt".into()),
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Bild ist größer als 20 MB".into());
    }
    Ok((mime.to_string(), base64::engine::general_purpose::STANDARD.encode(bytes)))
}
