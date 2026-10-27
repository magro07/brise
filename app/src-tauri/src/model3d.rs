//! 3D-Modus (ADR 0007): Arbeitsordner für Modelle im Datenordner (`<Daten>/3d`).
//! Jedes Modell ist ein eigener Ordner (`model.js` bzw. `model.scad`,
//! Varianten, Notizen, erzeugte Dateien unter `out/`, Versionen unter
//! `.versions/`). Dazu OpenSCAD und Blender finden, OpenSCAD rendern und die
//! MCP-Werkzeuge, mit denen jede Session Designs und Modelle lesen und ins
//! Projekt übernehmen kann.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

use crate::design::{copy_tree, design_dir, resolve_in, walk, DesignFile};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

/// Größte Datei, die Viewer und Werkzeuge lesen.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// So viel Quelltext geben `read_model`/`read_design` mit.
const SOURCE_CHARS: usize = 8000;

pub fn model_dir() -> PathBuf {
    data_dir().join("3d")
}

fn resolve(rel: &str) -> CmdResult<PathBuf> {
    resolve_in(&model_dir(), rel)
}

#[tauri::command]
pub fn model_root() -> CmdResult<String> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn model_read(path: String) -> CmdResult<String> {
    let p = resolve(&path)?;
    let len = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?.len();
    if len > MAX_BYTES {
        return Err(format!("{path} ist zu groß"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("{path}: {e}"))
}

/// Binärdatei (GLB, STL …) für den Viewer, als ArrayBuffer.
#[tauri::command]
pub fn model_bytes(path: String) -> CmdResult<tauri::ipc::Response> {
    let p = resolve(&path)?;
    let len = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?.len();
    if len > MAX_BYTES {
        return Err(format!("{path} ist größer als 64 MB"));
    }
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn model_write(path: String, content: String) -> CmdResult<()> {
    let p = resolve(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn model_write_base64(path: String, data: String) -> CmdResult<String> {
    let p = resolve(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub fn model_list(path: String) -> CmdResult<Vec<DesignFile>> {
    let base = resolve(&path)?;
    let mut out = Vec::new();
    walk(&base, &base, true, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn model_dirs() -> CmdResult<Vec<String>> {
    let Ok(entries) = std::fs::read_dir(model_dir()) else { return Ok(vec![]) };
    let mut out: Vec<String> =
        entries.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("m-")).collect();
    out.sort();
    Ok(out)
}

/// Wie `design_copy`, nur im 3D-Ordner.
#[tauri::command]
pub fn model_copy(from: String, to: String, skip: Vec<String>, replace: bool) -> CmdResult<()> {
    let src = resolve(&from)?;
    let dst = resolve(&to)?;
    if let Ok(inner) = dst.strip_prefix(&src) {
        let first = inner.components().next().map(|c| c.as_os_str().to_string_lossy().to_string());
        if !first.is_some_and(|f| skip.contains(&f)) {
            return Err("Ziel liegt im Quellordner".into());
        }
    }
    if replace {
        crate::design::clear_except(&dst, &skip).map_err(|e| e.to_string())?;
    }
    copy_tree(&src, &dst, &skip).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn model_remove(path: String) -> CmdResult<()> {
    let p = resolve(&path)?;
    if p == model_dir() {
        return Err("Der 3D-Ordner selbst wird nicht gelöscht".into());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Kopiert eine Datei oder einen Ordner eines Modells ins Projekt. Liefert den absoluten Zielpfad.
#[tauri::command]
pub fn model_export(path: String, project: String, target: String) -> CmdResult<String> {
    export_into(&resolve(&path)?, Path::new(&project), &target)
}

fn export_into(src: &Path, project: &Path, target: &str) -> CmdResult<String> {
    let root = std::fs::canonicalize(project).map_err(|e| format!("{}: {e}", project.display()))?;
    let dst = resolve_in(&root, target)?;
    if src.is_dir() {
        let _ = std::fs::remove_dir_all(&dst);
        copy_tree(src, &dst, &[".versions".into(), "model.json".into(), "design.json".into()]).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
    }
    // Lokale Übergabeordner gehören nicht ins Repository.
    let brise = root.join(".brise");
    let ignore = brise.join(".gitignore");
    if dst.starts_with(&brise) && !ignore.exists() {
        let _ = std::fs::write(&ignore, "# Von Brise angelegt: lokale Übergaben aus dem Design- und 3D-Modus\n*\n");
    }
    Ok(dst.display().to_string())
}

// ---------- Werkzeuge finden und OpenSCAD rendern ----------

fn find_program(names: &[&str], extra: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for n in names {
            for candidate in [dir.join(n), dir.join(format!("{n}.exe"))] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    extra.iter().map(PathBuf::from).find(|p| p.is_file())
}

fn find_blender() -> Option<PathBuf> {
    if let Some(p) = find_program(&["blender"], &["/Applications/Blender.app/Contents/MacOS/Blender", "/snap/bin/blender", "/var/lib/flatpak/exports/bin/org.blender.Blender"]) {
        return Some(p);
    }
    // Windows: C:\Program Files\Blender Foundation\Blender 4.x\blender.exe (neueste zuerst).
    let base = Path::new(r"C:\Program Files\Blender Foundation");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(base).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.into_iter().rev().map(|d| d.join("blender.exe")).find(|p| p.is_file())
}

fn find_openscad() -> Option<PathBuf> {
    find_program(
        &["openscad"],
        &[
            "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
            "/snap/bin/openscad",
            "/var/lib/flatpak/exports/bin/org.openscad.OpenSCAD",
            r"C:\Program Files\OpenSCAD\openscad.exe",
        ],
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTools {
    openscad: Option<String>,
    blender: Option<String>,
}

/// Gefundene optionale Werkzeuge (für die erste Nachricht und die Oberfläche).
#[tauri::command]
pub fn model_tools() -> ModelTools {
    ModelTools { openscad: find_openscad().map(|p| p.display().to_string()), blender: find_blender().map(|p| p.display().to_string()) }
}

/// Rendert `<dir>/<src>` (OpenSCAD) nach `<dir>/<out>`; liefert die Meldungen von OpenSCAD.
#[tauri::command]
pub async fn model_openscad(dir: String, src: String, out: String) -> CmdResult<String> {
    let exe = find_openscad().ok_or("OpenSCAD ist nicht installiert (openscad.org).")?;
    let base = resolve(&dir)?;
    let input = resolve_in(&base, &src)?;
    let output = resolve_in(&base, &out)?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = output.with_extension(format!("tmp.{}", output.extension().and_then(|e| e.to_str()).unwrap_or("stl")));
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("-o").arg(&tmp).arg(&input).current_dir(&base).kill_on_drop(true);
    let run = tokio::time::timeout(Duration::from_secs(180), cmd.output()).await.map_err(|_| "OpenSCAD hat nach 3 Minuten nicht fertig gerendert.".to_string())?;
    let result = run.map_err(|e| format!("OpenSCAD: {e}"))?;
    let log = String::from_utf8_lossy(&result.stderr).to_string();
    let tail: String = log.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    if !result.status.success() || !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp);
        return Err(if tail.is_empty() { "OpenSCAD ist fehlgeschlagen.".into() } else { tail });
    }
    std::fs::rename(&tmp, &output).map_err(|e| e.to_string())?;
    Ok(tail)
}

// ---------- MCP-Werkzeuge: Designs und Modelle lesen und übernehmen ----------

/// Kurze Beschreibung für die Anweisungen des MCP-Servers.
pub const MCP_INSTRUCTIONS: &str = "Design und 3D: Mit list_designs/read_design und list_models/read_model siehst du die Entwürfe aus dem Design- \
    und dem 3D-Modus von Brise (inklusive Vorschaubild), mit export_design bzw. export_model übernimmst du sie in dein Projekt. \
    Neue Designs bzw. 3D-Modelle lässt du mit start_session(mode: \"design\" bzw. \"3d\") von einer eigenen Session erstellen.";

pub fn tools() -> Vec<Value> {
    let id = json!({ "type": "string", "description": "ID (d-… bzw. m-…) oder Name" });
    let only = json!({ "type": "string", "description": "Nur Einträge, die diesem Projekt zugeordnet sind: Projektpfad oder \"aktuell\" für das Projekt dieser Session" });
    vec![
        json!({
            "name": "list_designs",
            "description": "Listet die Designs aus dem Design-Modus von Brise (HTML-Entwürfe mit Live-Vorschau): ID, Name, Stand, Versionen, zugeordnetes Projekt.",
            "inputSchema": { "type": "object", "properties": { "project": only.clone() } },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "read_design",
            "description": "Liest ein Design: Beschreibung (notes.md), Dateien, Haupt-HTML (gekürzt) und den letzten Screenshot als Bild.",
            "inputSchema": { "type": "object", "properties": { "design": id }, "required": ["design"] },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "export_design",
            "description": "Kopiert ein Design (ohne Versionen) in dein Projekt, Standard .brise/design/<name>/ (per .gitignore ausgeschlossen). Liefert den Zielpfad.",
            "inputSchema": { "type": "object", "properties": { "design": id, "target": { "type": "string", "description": "Zielordner relativ zum Projekt" } }, "required": ["design"] }
        }),
        json!({
            "name": "list_models",
            "description": "Listet die 3D-Modelle aus dem 3D-Modus von Brise: ID, Name, Stand, Versionen, erzeugte Dateien (GLB, STL …), zugeordnetes Projekt.",
            "inputSchema": { "type": "object", "properties": { "project": only.clone() } },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "read_model",
            "description": "Liest ein 3D-Modell: Beschreibung (notes.md), Maße (Bounding Box in mm), Teile, Quellcode (gekürzt), erzeugte Dateien und den letzten Screenshot als Bild.",
            "inputSchema": { "type": "object", "properties": { "model": id }, "required": ["model"] },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "export_model",
            "description": "Kopiert ein 3D-Modell in dein Projekt. format: glb (Standard, für Web/Spiele), stl (3D-Druck), obj, 3mf oder source (Quellcode und Notizen). \
                Standardziel: public/models/<name>.<format> (ohne public/: models/…), bei source .brise/3d/<name>/. Liefert den Zielpfad.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "model": id,
                    "format": { "type": "string", "enum": ["glb", "stl", "obj", "3mf", "source"] },
                    "target": { "type": "string", "description": "Zielpfad relativ zum Projekt" }
                },
                "required": ["model"]
            }
        }),
    ]
}

const TOOL_NAMES: &[&str] = &["list_designs", "read_design", "export_design", "list_models", "read_model", "export_model"];

/// Werkzeugaufruf im MCP-Server; liefert MCP-Inhalte (Text und Bilder).
pub fn call_tool(name: &str, args: &Value) -> Option<CmdResult<Vec<Value>>> {
    if !TOOL_NAMES.contains(&name) {
        return None;
    }
    let project = std::env::var("BRISE_CWD").ok().filter(|s| !s.is_empty());
    // „aktuell“ steht für das Projekt der aufrufenden Session.
    let only = args["project"].as_str().map(str::trim).filter(|p| !p.is_empty()).map(|p| if p == "aktuell" { project.clone().unwrap_or_default() } else { p.to_string() });
    Some(match name {
        "list_designs" => Ok(vec![text(list_text(&design_dir(), "d-", "design.json", "Designs", only.as_deref()))]),
        "list_models" => Ok(vec![text(list_text(&model_dir(), "m-", "model.json", "3D-Modelle", only.as_deref()))]),
        "read_design" => find(&design_dir(), "d-", "design.json", &args["design"]).map(|e| read_design(&e)),
        "read_model" => find(&model_dir(), "m-", "model.json", &args["model"]).map(|e| read_model(&e)),
        "export_design" => (|| {
            let e = find(&design_dir(), "d-", "design.json", &args["design"])?;
            let project = project.ok_or("Kein Projektordner bekannt")?;
            let target = args["target"].as_str().map(str::to_string).unwrap_or_else(|| format!(".brise/design/{}", slug(&e.name)));
            let dst = export_into(&e.dir, Path::new(&project), &target)?;
            Ok(vec![text(format!("Design „{}“ liegt jetzt in {dst}. Hauptdesign: index.html (bzw. App.jsx), Beschreibung: notes.md, Tokens: tokens.css.", e.name))])
        })(),
        _ => (|| {
            let e = find(&model_dir(), "m-", "model.json", &args["model"])?;
            let project = project.ok_or("Kein Projektordner bekannt")?;
            let format = args["format"].as_str().unwrap_or("glb");
            if format == "source" {
                let target = args["target"].as_str().map(str::to_string).unwrap_or_else(|| format!(".brise/3d/{}", slug(&e.name)));
                let dst = export_into(&e.dir, Path::new(&project), &target)?;
                return Ok(vec![text(format!("Quellcode, Notizen und erzeugte Dateien von „{}“ liegen in {dst}.", e.name))]);
            }
            let src = e.dir.join("out").join(format!("model.{format}"));
            if !src.is_file() {
                let have = outputs(&e.dir).join(", ");
                return Err(format!("„{}“ hat kein out/model.{format}{}", e.name, if have.is_empty() { " (noch nichts erzeugt)".into() } else { format!(" – vorhanden: {have}") }));
            }
            let target = args["target"].as_str().map(str::to_string).unwrap_or_else(|| {
                let dir = if Path::new(&project).join("public").is_dir() { "public/models" } else { "models" };
                format!("{dir}/{}.{format}", slug(&e.name))
            });
            let dst = export_into(&src, Path::new(&project), &target)?;
            let info = std::fs::read_to_string(e.dir.join("out").join("info.json")).unwrap_or_default();
            Ok(vec![text(format!(
                "Modell „{}“ liegt jetzt in {dst}. Einheiten: 1 = 1 mm, Y nach oben.{}",
                e.name,
                if info.is_empty() { String::new() } else { format!("\nMaße und Teile: {info}") }
            ))])
        })(),
    })
}

fn text(t: impl Into<String>) -> Value {
    json!({ "type": "text", "text": t.into() })
}

struct Entry {
    id: String,
    name: String,
    dir: PathBuf,
    meta: Value,
}

fn entries(root: &Path, prefix: &str, meta_file: &str) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(root) else { return vec![] };
    let mut out: Vec<Entry> = read
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix) && e.path().is_dir())
        .filter_map(|e| {
            let meta: Value = serde_json::from_slice(&std::fs::read(e.path().join(meta_file)).ok()?).ok()?;
            Some(Entry { id: e.file_name().to_string_lossy().to_string(), name: meta["name"].as_str().unwrap_or("ohne Namen").to_string(), dir: e.path(), meta })
        })
        .collect();
    out.sort_by_key(|e| std::cmp::Reverse(e.meta["updated"].as_u64().unwrap_or(0)));
    out
}

fn find(root: &Path, prefix: &str, meta_file: &str, key: &Value) -> CmdResult<Entry> {
    let key = key.as_str().map(str::trim).filter(|k| !k.is_empty()).ok_or("ID oder Name fehlt")?;
    let mut all = entries(root, prefix, meta_file);
    let lower = key.to_lowercase();
    let pos = all
        .iter()
        .position(|e| e.id == key)
        .or_else(|| all.iter().position(|e| e.name.to_lowercase() == lower))
        .or_else(|| all.iter().position(|e| e.name.to_lowercase().contains(&lower)));
    match pos {
        Some(i) => Ok(all.swap_remove(i)),
        None => Err(format!("Nichts gefunden für „{key}“. Vorhanden: {}", all.iter().map(|e| format!("{} ({})", e.name, e.id)).collect::<Vec<_>>().join(", "))),
    }
}

/// „vor 5 Min.“ usw.
fn date(ms: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let min = now.saturating_sub(ms) / 60_000;
    match min {
        0 => "gerade eben".into(),
        1..=59 => format!("vor {min} Min."),
        60..=2879 => format!("vor {} Std.", min / 60),
        _ => format!("vor {} Tagen", min / 1440),
    }
}

fn outputs(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir.join("out"))
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !n.ends_with(".json")).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// Gleicher Projektpfad, unabhängig von abschließendem Trenner und Schreibweise unter Windows.
fn same_project(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.trim_end_matches(['/', '\\']).replace('\\', "/");
    if cfg!(windows) { norm(a).eq_ignore_ascii_case(&norm(b)) } else { norm(a) == norm(b) }
}

fn list_text(root: &Path, prefix: &str, meta_file: &str, what: &str, only: Option<&str>) -> String {
    let all: Vec<Entry> = entries(root, prefix, meta_file)
        .into_iter()
        .filter(|e| only.is_none_or(|p| e.meta["project"].as_str().is_some_and(|q| same_project(p, q))))
        .collect();
    if all.is_empty() {
        return match only {
            Some(p) => format!("Keine {what} im Projekt {p}."),
            None => format!("Noch keine {what}."),
        };
    }
    let lines: Vec<String> = all
        .iter()
        .map(|e| {
            let versions = e.meta["versions"].as_array().map_or(0, Vec::len);
            let out = outputs(&e.dir);
            format!(
                "- {} ({}) · Stand {} · {versions} Versionen{}{}",
                e.name,
                e.id,
                date(e.meta["updated"].as_u64().unwrap_or(0)),
                if out.is_empty() { String::new() } else { format!(" · {}", out.join(", ")) },
                e.meta["project"].as_str().map(|p| format!(" · Projekt {p}")).unwrap_or_default()
            )
        })
        .collect();
    format!("{what} ({}):\n{}", all.len(), lines.join("\n"))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!("{}\n… (gekürzt)", s.chars().take(max).collect::<String>())
}

fn preview_image(dir: &Path) -> Option<Value> {
    let bytes = std::fs::read(dir.join("preview.png")).ok()?;
    Some(json!({ "type": "image", "mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

fn file_list(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    walk(dir, dir, true, &mut files);
    files.into_iter().map(|f| f.path).filter(|p| !p.starts_with("refs/") && p != "design.json" && p != "model.json").collect()
}

fn read_design(e: &Entry) -> Vec<Value> {
    let notes = std::fs::read_to_string(e.dir.join("notes.md")).unwrap_or_default();
    let files = file_list(&e.dir);
    let main = ["index.html", "App.jsx", "App.tsx"].into_iter().find(|f| e.dir.join(f).is_file());
    let source = main.and_then(|f| std::fs::read_to_string(e.dir.join(f)).ok()).unwrap_or_default();
    let image = preview_image(&e.dir);
    let mut out = vec![text(format!(
        "Design „{}“ ({}) · Stand {}\nOrdner: {}\nDateien: {}\n\n## notes.md\n{}\n\n## {}\n```html\n{}\n```{}",
        e.name,
        e.id,
        date(e.meta["updated"].as_u64().unwrap_or(0)),
        e.dir.display(),
        files.join(", "),
        notes.trim(),
        main.unwrap_or("Hauptdatei"),
        clip(&source, SOURCE_CHARS),
        if image.is_some() { "\n\nDas Bild zeigt den letzten Stand der Vorschau." } else { "\n\n(Noch kein Vorschaubild – öffne das Design einmal im Design-Modus.)" }
    ))];
    out.extend(image);
    out
}

fn read_model(e: &Entry) -> Vec<Value> {
    let notes = std::fs::read_to_string(e.dir.join("notes.md")).unwrap_or_default();
    let info = std::fs::read_to_string(e.dir.join("out").join("info.json")).unwrap_or_default();
    let main = ["model.js", "model.scad", "model.py"].into_iter().find(|f| e.dir.join(f).is_file());
    let source = main.and_then(|f| std::fs::read_to_string(e.dir.join(f)).ok()).unwrap_or_default();
    let image = preview_image(&e.dir);
    let mut out = vec![text(format!(
        "3D-Modell „{}“ ({}) · Stand {}\nOrdner: {}\nErzeugt: {}\nDateien: {}\nEinheiten: 1 = 1 mm, Y nach oben.\n\n## Maße und Teile\n{}\n\n## notes.md\n{}\n\n## {}\n```\n{}\n```{}",
        e.name,
        e.id,
        date(e.meta["updated"].as_u64().unwrap_or(0)),
        e.dir.display(),
        outputs(&e.dir).iter().map(|o| format!("out/{o}")).collect::<Vec<_>>().join(", "),
        file_list(&e.dir).join(", "),
        if info.is_empty() { "unbekannt (noch nicht im Viewer geladen)".into() } else { info },
        notes.trim(),
        main.unwrap_or("Quelle"),
        clip(&source, SOURCE_CHARS),
        if image.is_some() { "\n\nDas Bild zeigt den letzten Stand im Viewer." } else { "" }
    ))];
    out.extend(image);
    out
}

/// Dateiname aus einem Namen: klein, ASCII, Bindestriche.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        let mapped = match c {
            'ä' => "ae".to_string(),
            'ö' => "oe".to_string(),
            'ü' => "ue".to_string(),
            'ß' => "ss".to_string(),
            c if c.is_ascii_alphanumeric() => c.to_string(),
            _ => "-".to_string(),
        };
        if mapped == "-" && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push_str(&mapped);
    }
    let out = out.trim_end_matches('-').chars().take(48).collect::<String>();
    if out.is_empty() { "modell".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slug("Halterung für Größe 3"), "halterung-fuer-groesse-3");
        assert_eq!(slug("  !!"), "modell");
    }

    #[test]
    fn rejects_escape() {
        assert!(resolve("../x").is_err());
        assert!(resolve("m-1/out/model.glb").is_ok());
    }

    #[test]
    fn find_and_export() {
        let tmp = std::env::temp_dir().join(format!("brise-3d-test-{}", std::process::id()));
        let root = tmp.join("3d");
        let m = root.join("m-abc");
        std::fs::create_dir_all(m.join("out")).unwrap();
        std::fs::write(m.join("model.json"), r#"{"name":"Zahnrad","updated":5,"versions":[{}]}"#).unwrap();
        std::fs::write(m.join("out/model.glb"), b"glTF").unwrap();
        std::fs::write(m.join("model.js"), "export default () => null").unwrap();
        assert_eq!(find(&root, "m-", "model.json", &json!("zahn")).unwrap().id, "m-abc");
        assert!(find(&root, "m-", "model.json", &json!("nix")).is_err());
        assert!(list_text(&root, "m-", "model.json", "3D-Modelle", None).contains("Zahnrad (m-abc)"));
        let other = root.join("m-def");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("model.json"), r#"{"name":"Halter","updated":6,"project":"/home/a/shop"}"#).unwrap();
        let listed = list_text(&root, "m-", "model.json", "3D-Modelle", Some("/home/a/shop/"));
        assert!(listed.contains("Halter (m-def)") && listed.contains("Projekt /home/a/shop") && !listed.contains("Zahnrad"));
        assert!(list_text(&root, "m-", "model.json", "3D-Modelle", Some("/x")).starts_with("Keine"));
        let project = tmp.join("proj");
        std::fs::create_dir_all(project.join("public")).unwrap();
        let dst = export_into(&m.join("out/model.glb"), &project, "public/models/zahnrad.glb").unwrap();
        assert_eq!(std::fs::read(dst).unwrap(), b"glTF");
        let dst = export_into(&m, &project, ".brise/3d/zahnrad").unwrap();
        assert!(Path::new(&dst).join("model.js").is_file());
        assert!(!Path::new(&dst).join("model.json").exists());
        assert!(project.join(".brise/.gitignore").is_file());
        assert!(export_into(&m, &project, "../raus").is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
