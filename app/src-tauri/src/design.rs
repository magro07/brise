//! Design-Modus: Arbeitsordner für Designs im Datenordner (`<Daten>/design`).
//! Jedes Design ist ein eigener Ordner (`index.html`, Varianten, Notizen,
//! Tokens, Versionen unter `.versions/`). Alle Pfade sind relativ zum
//! Design-Ordner und dürfen ihn nicht verlassen.

use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub fn design_dir() -> PathBuf {
    data_dir().join("design")
}

/// `rel` unter dem Design-Ordner, ohne `..` und ohne absolute Pfade.
fn resolve(rel: &str) -> CmdResult<PathBuf> {
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("Ungültiger Pfad: {rel}"));
    }
    Ok(design_dir().join(p))
}

/// Projektpfad + relatives Ziel, ebenfalls ohne Ausbruch.
fn resolve_in(root: &Path, rel: &str) -> CmdResult<PathBuf> {
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("Ungültiger Pfad: {rel}"));
    }
    Ok(root.join(p))
}

/// Legt den Ordner an und liefert seinen absoluten Pfad.
#[tauri::command]
pub fn design_root() -> CmdResult<String> {
    let dir = design_dir();
    std::fs::create_dir_all(dir.join("systems")).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn design_read(path: String) -> CmdResult<String> {
    let p = resolve(&path)?;
    let len = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?.len();
    if len > MAX_BYTES {
        return Err(format!("{path} ist zu groß"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn design_write(path: String, content: String) -> CmdResult<()> {
    let p = resolve(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("{path}: {e}"))
}

/// Binärdatei (Screenshot, eingefügtes Bild) als Base64 schreiben.
#[tauri::command]
pub fn design_write_base64(path: String, data: String) -> CmdResult<String> {
    let p = resolve(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(p.display().to_string())
}

/// Datei als `data:`-URL, z. B. Bilder für die Vorschau.
#[tauri::command]
pub fn design_data_url(path: String) -> CmdResult<String> {
    let p = resolve(&path)?;
    let len = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?.len();
    if len > MAX_BYTES {
        return Err(format!("{path} ist zu groß"));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignFile {
    path: String,
    size: u64,
    modified: u64,
}

fn walk(base: &Path, dir: &Path, skip_hidden: bool, out: &mut Vec<DesignFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if skip_hidden && name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(base, &path, skip_hidden, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            out.push(DesignFile { path: rel.to_string_lossy().replace('\\', "/"), size: meta.len(), modified });
        }
    }
}

/// Alle Dateien unter `path` (rekursiv, ohne versteckte wie `.versions`).
#[tauri::command]
pub fn design_list(path: String) -> CmdResult<Vec<DesignFile>> {
    let base = resolve(&path)?;
    let mut out = Vec::new();
    walk(&base, &base, true, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Unterordner direkt unter `path` (z. B. alle Designs).
#[tauri::command]
pub fn design_dirs(path: String) -> CmdResult<Vec<String>> {
    let base = resolve(&path)?;
    let Ok(entries) = std::fs::read_dir(&base) else { return Ok(vec![]) };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    out.sort();
    Ok(out)
}

fn copy_tree(from: &Path, to: &Path, skip: &[String]) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if skip.iter().any(|s| s == &name) {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target, &[])?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Entfernt in `dir` alles außer den Einträgen in `keep`.
fn clear_except(dir: &Path, keep: &[String]) -> std::io::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if keep.iter().any(|k| k == &name) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// Kopiert `from` nach `to` (beides relativ). `skip` gilt für die oberste
/// Ebene; mit `replace` wird das Ziel vorher geleert – bis auf `skip`.
#[tauri::command]
pub fn design_copy(from: String, to: String, skip: Vec<String>, replace: bool) -> CmdResult<()> {
    let src = resolve(&from)?;
    let dst = resolve(&to)?;
    // Kopie in den eigenen Quellordner nur in einen übersprungenen Unterordner (Versionen).
    if let Ok(inner) = dst.strip_prefix(&src) {
        let first = inner.components().next().map(|c| c.as_os_str().to_string_lossy().to_string());
        if !first.is_some_and(|f| skip.contains(&f)) {
            return Err("Ziel liegt im Quellordner".into());
        }
    }
    if replace {
        clear_except(&dst, &skip).map_err(|e| e.to_string())?;
    }
    copy_tree(&src, &dst, &skip).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn design_remove(path: String) -> CmdResult<()> {
    let p = resolve(&path)?;
    if p == design_dir() {
        return Err("Der Design-Ordner selbst wird nicht gelöscht".into());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Übergabe: kopiert ein Design (ohne Versionen) ins Projekt, z. B. nach
/// `.brise/design/<name>`; `skip` lässt Einträge der obersten Ebene aus
/// (z. B. `variants`). Liefert den absoluten Zielpfad.
#[tauri::command]
pub fn design_export(path: String, project: String, target: String, skip: Vec<String>) -> CmdResult<String> {
    let src = resolve(&path)?;
    let root = std::fs::canonicalize(&project).map_err(|e| format!("{project}: {e}"))?;
    let dst = resolve_in(&root, &target)?;
    let _ = std::fs::remove_dir_all(&dst);
    let skip: Vec<String> = skip.into_iter().chain([".versions".to_string(), "design.json".to_string()]).collect();
    copy_tree(&src, &dst, &skip).map_err(|e| e.to_string())?;
    // Ein lokaler Übergabeordner gehört nicht ins Repository.
    let brise = root.join(".brise");
    let ignore = brise.join(".gitignore");
    if dst.starts_with(&brise) && !ignore.exists() {
        let _ = std::fs::write(&ignore, "# Von Brise angelegt: lokale Übergaben aus dem Design-Modus\n*\n");
    }
    Ok(dst.display().to_string())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTokens {
    /// Gelesene Dateien, relativ zum Projekt.
    sources: Vec<String>,
    /// CSS-Variablen aus `:root`/`@theme` (Name ohne `--`).
    vars: Vec<(String, String)>,
    /// Dunkle Varianten (`.dark`, `[data-theme=dark]`, `prefers-color-scheme: dark`).
    dark: Vec<(String, String)>,
    /// Farben und Schriften aus einer Tailwind-Konfiguration (JS/TS).
    tailwind: Vec<(String, String)>,
}

/// Liest `--name: wert;` aus CSS. Blöcke mit „dark“ im Selektor landen in `dark`.
fn parse_css_vars(css: &str, out: &mut ImportedTokens) {
    let mut stack: Vec<bool> = Vec::new();
    let mut buf = String::new();
    let mut chars = css.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '/' && chars.peek() == Some(&'*') {
            // Kommentar überspringen.
            let mut prev = ' ';
            for n in chars.by_ref() {
                if prev == '*' && n == '/' {
                    break;
                }
                prev = n;
            }
            continue;
        }
        let dark = stack.last().copied().unwrap_or(false);
        match c {
            '{' => {
                stack.push(dark || buf.contains("dark"));
                buf.clear();
            }
            '}' => {
                take_decl(&buf, dark, out);
                stack.pop();
                buf.clear();
            }
            ';' => {
                take_decl(&buf, dark, out);
                buf.clear();
            }
            _ => buf.push(c),
        }
    }
}

fn take_decl(decl: &str, dark: bool, out: &mut ImportedTokens) {
    let decl = decl.trim();
    let Some(rest) = decl.strip_prefix("--") else { return };
    let Some((name, value)) = rest.split_once(':') else { return };
    let (name, value) = (name.trim().to_string(), value.trim().to_string());
    if name.is_empty() || value.is_empty() || value.len() > 200 {
        return;
    }
    let list = if dark { &mut out.dark } else { &mut out.vars };
    if !list.iter().any(|(n, _)| n == &name) {
        list.push((name, value));
    }
}

/// Sehr einfache Suche nach `name: '#hex'` und `fontFamily`-Einträgen.
fn parse_tailwind(js: &str, out: &mut ImportedTokens) {
    for line in js.lines() {
        let line = line.trim().trim_end_matches(',');
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().trim_matches(['"', '\'']).to_string();
        let value = value.trim();
        let quoted = value.trim_matches(['"', '\'']);
        let is_color = quoted.starts_with('#') || quoted.starts_with("rgb") || quoted.starts_with("hsl") || quoted.starts_with("oklch");
        if is_color && !key.is_empty() && key.len() < 40 && !key.contains(' ') {
            out.tailwind.push((format!("color-{key}"), quoted.to_string()));
        } else if value.starts_with('[') && (key == "sans" || key == "serif" || key == "mono" || key == "display") {
            out.tailwind.push((format!("font-{key}"), value.trim_matches(['[', ']']).replace('\'', "").replace('"', "")));
        }
    }
}

/// Design-Tokens aus einem Projekt übernehmen: CSS-Variablen (auch Tailwind 4
/// `@theme`) und eine Tailwind-Konfiguration.
#[tauri::command]
pub fn design_import_tokens(project: String) -> CmdResult<ImportedTokens> {
    let root = PathBuf::from(&project);
    let mut out = ImportedTokens::default();
    let walker = ignore::WalkBuilder::new(&root).max_depth(Some(5)).build();
    let mut css_files = Vec::new();
    let mut tw_files = Vec::new();
    for entry in walker.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("tailwind.config.") {
            tw_files.push(p.to_path_buf());
        } else if name.ends_with(".css") && !p.components().any(|c| c.as_os_str() == "node_modules" || c.as_os_str() == "dist") {
            css_files.push(p.to_path_buf());
        }
    }
    // Typische Orte zuerst, damit globale Tokens vorne stehen.
    css_files.sort_by_key(|p| {
        let s = p.to_string_lossy().to_lowercase();
        let rank = if s.contains("global") || s.contains("index.css") || s.contains("tokens") || s.contains("theme") || s.contains("variables") { 0 } else { 1 };
        (rank, s.len())
    });
    for p in css_files.iter().take(12) {
        let Ok(text) = std::fs::read_to_string(p) else { continue };
        if !text.contains("--") {
            continue;
        }
        let before = out.vars.len() + out.dark.len();
        parse_css_vars(&text, &mut out);
        if out.vars.len() + out.dark.len() > before {
            out.sources.push(p.strip_prefix(&root).unwrap_or(p).display().to_string());
        }
    }
    for p in tw_files.iter().take(2) {
        let Ok(text) = std::fs::read_to_string(p) else { continue };
        parse_tailwind(&text, &mut out);
        out.sources.push(p.strip_prefix(&root).unwrap_or(p).display().to_string());
    }
    out.vars.truncate(200);
    out.dark.truncate(200);
    out.tailwind.truncate(100);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_vars_with_dark() {
        let mut out = ImportedTokens::default();
        parse_css_vars(":root { --bg: #fff; --accent: oklch(0.6 0.2 250); }\n/* x */ .dark { --bg: #000; }\n@theme { --font-sans: Inter, sans-serif; }", &mut out);
        assert_eq!(out.vars, vec![("bg".into(), "#fff".into()), ("accent".into(), "oklch(0.6 0.2 250)".into()), ("font-sans".into(), "Inter, sans-serif".into())]);
        assert_eq!(out.dark, vec![("bg".into(), "#000".into())]);
    }

    #[test]
    fn rejects_escape() {
        assert!(resolve("../x").is_err());
        assert!(resolve("/etc/passwd").is_err());
        assert!(resolve("a/b.html").is_ok());
    }
}
