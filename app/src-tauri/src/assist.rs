//! Kleine KI-Helfer neben Vibe, über die Mistral-API mit dem Nutzer-Key:
//! Auto-Modellwahl (Aufgabe einstufen), personalisierte Vorschläge und
//! Commit-Nachrichten. Alles mit einem schnellen Modell und kurzem Timeout.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::credentials::{read_key, API_BASE};
use crate::git::git_output;
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const FAST_MODEL: &str = "mistral-small-latest";

/// Chat-Anfrage mit JSON-Antwort.
async fn quick_json(system: &str, user: &str, timeout: u64) -> CmdResult<Value> {
    let key = read_key().ok_or("Kein Mistral-Schlüssel")?;
    let body: Value = reqwest::Client::new()
        .post(format!("{API_BASE}/chat/completions"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(timeout))
        .json(&json!({
            "model": FAST_MODEL,
            "temperature": 0.2,
            "response_format": { "type": "json_object" },
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let text = body["choices"][0]["message"]["content"].as_str().ok_or_else(|| format!("Unerwartete Antwort: {body}"))?;
    serde_json::from_str(text).map_err(|e| format!("Kein gültiges JSON: {e}"))
}

/// Stuft eine Aufgabe für die Auto-Modellwahl ein: simple, standard oder complex.
#[tauri::command]
pub async fn classify_task(text: String, history: Option<String>) -> CmdResult<Value> {
    const SYSTEM: &str = "Du ordnest Aufgaben für einen Coding-Agenten einer Stufe zu, damit das passende Modell gewählt wird. \
        simple: kurze Fragen, Erklärungen, kleine lokale Änderungen, Umbenennungen, Formatierung. \
        standard: übliche Features, Bugfixes in wenigen Dateien, Tests schreiben. \
        complex: Architektur, große Refactorings über viele Dateien, schwierige Fehlersuche, Sicherheit, Performance, Planung. \
        Antworte nur als JSON: {\"level\":\"simple|standard|complex\",\"reason\":\"max. 8 Wörter auf Deutsch\"}";
    let mut user = String::new();
    if let Some(h) = history.filter(|h| !h.is_empty()) {
        user.push_str("Bisheriger Verlauf (Auszug):\n");
        user.push_str(&h.chars().take(1500).collect::<String>());
        user.push_str("\n\n");
    }
    user.push_str("Neue Aufgabe:\n");
    user.push_str(&text.chars().take(4000).collect::<String>());
    let v = quick_json(SYSTEM, &user, 6).await?;
    let level = match v["level"].as_str() {
        Some(l @ ("simple" | "standard" | "complex")) => l,
        _ => "standard",
    };
    Ok(json!({ "level": level, "reason": v["reason"].as_str().unwrap_or("") }))
}

/// Kurzer Steckbrief des Projekts für Vorschläge.
fn project_brief(cwd: &Path) -> String {
    let mut out = String::new();
    let mut names: Vec<String> = std::fs::read_dir(cwd)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.') || n == ".github")
        .collect();
    names.sort();
    out.push_str(&format!("Dateien im Hauptordner: {}\n", names.join(", ")));

    for manifest in ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile"] {
        if let Ok(t) = std::fs::read_to_string(cwd.join(manifest)) {
            out.push_str(&format!("\n{manifest} (Anfang):\n{}\n", t.chars().take(900).collect::<String>()));
        }
    }
    for readme in ["README.md", "readme.md", "README"] {
        if let Ok(t) = std::fs::read_to_string(cwd.join(readme)) {
            out.push_str(&format!("\nREADME (Anfang):\n{}\n", t.chars().take(1200).collect::<String>()));
            break;
        }
    }
    if let Ok(s) = git_output(cwd, &["status", "--short", "--branch"]) {
        out.push_str(&format!("\ngit status:\n{}\n", s.lines().take(25).collect::<Vec<_>>().join("\n")));
    }
    if let Ok(s) = git_output(cwd, &["log", "--oneline", "-10"]) {
        out.push_str(&format!("\nLetzte Commits:\n{s}\n"));
    }
    // TODO/FIXME-Stellen (gitignore-bewusst, begrenzt).
    let mut todos = Vec::new();
    for entry in ignore::WalkBuilder::new(cwd).max_depth(Some(8)).build().flatten() {
        if todos.len() >= 8 || !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > 300_000).unwrap_or(true) {
            continue;
        }
        if let Ok(t) = std::fs::read_to_string(entry.path()) {
            for (n, line) in t.lines().enumerate() {
                if line.contains("TODO") || line.contains("FIXME") {
                    let rel = entry.path().strip_prefix(cwd).unwrap_or(entry.path()).display();
                    todos.push(format!("{rel}:{}: {}", n + 1, line.trim().chars().take(120).collect::<String>()));
                    if todos.len() >= 8 {
                        break;
                    }
                }
            }
        }
    }
    if !todos.is_empty() {
        out.push_str(&format!("\nOffene TODOs:\n{}\n", todos.join("\n")));
    }
    out
}

fn cache_path(cwd: &str) -> PathBuf {
    let hash: String = Sha256::digest(cwd.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    data_dir().join("suggestions").join(format!("{hash}.json"))
}

/// Vier Vorschläge, zugeschnitten auf Projekt, Git-Stand und letzte Sessions.
/// Zwischengespeichert, bis sich HEAD/Status ändert oder 12 Stunden vergehen.
#[tauri::command]
pub async fn project_suggestions(cwd: String, recent: Vec<String>, refresh: Option<bool>) -> CmdResult<Value> {
    let root = PathBuf::from(&cwd);
    let state = git_output(&root, &["rev-parse", "HEAD"]).unwrap_or_default() + &git_output(&root, &["status", "--porcelain"]).unwrap_or_default();
    let fingerprint: String = Sha256::digest(state.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = cache_path(&cwd);
    if !refresh.unwrap_or(false) {
        if let Some(cached) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            let fresh = cached["fingerprint"] == fingerprint.as_str() && now.saturating_sub(cached["at"].as_u64().unwrap_or(0)) < 12 * 3600;
            if fresh {
                return Ok(cached["suggestions"].clone());
            }
        }
    }

    let brief = tokio::task::spawn_blocking(move || project_brief(&root)).await.map_err(|e| e.to_string())?;
    const SYSTEM: &str = "Du bist Teil einer Coding-App. Schlage genau 4 konkrete, sofort umsetzbare nächste Aufgaben für dieses Projekt vor, \
        die ein Coding-Agent erledigen kann. Bezieh dich auf echte Dateien, Commits, uncommittete Änderungen oder TODOs aus dem Steckbrief. \
        Keine allgemeinen Floskeln. Wiederhole keine Aufgaben aus den letzten Sessions. \
        Antworte als JSON: {\"suggestions\":[{\"title\":\"max. 4 Wörter\",\"description\":\"ein kurzer Satz\",\"prompt\":\"vollständige Anweisung an den Agenten auf Deutsch\",\"icon\":\"bug|test|docs|refactor|feature|explain|git|perf|security\"}]}";
    let user = format!("Projekt: {cwd}\n\n{brief}\n\nLetzte Sessions in diesem Projekt: {}", if recent.is_empty() { "keine".into() } else { recent.join("; ") });
    let v = quick_json(SYSTEM, &user, 20).await?;
    let suggestions = v["suggestions"].clone();
    if !suggestions.is_array() {
        return Err("Keine Vorschläge erhalten".into());
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let _ = std::fs::write(&path, json!({ "fingerprint": fingerprint, "at": now, "suggestions": suggestions }).to_string());
    Ok(suggestions)
}

/// Formuliert eine Commit-Nachricht aus dem gestagten Diff.
#[tauri::command]
pub async fn commit_message(cwd: String) -> CmdResult<String> {
    let root = PathBuf::from(&cwd);
    let mut diff = git_output(&root, &["diff", "--cached", "--stat"]).unwrap_or_default();
    diff.push_str("\n");
    diff.push_str(&git_output(&root, &["diff", "--cached"]).unwrap_or_default().chars().take(12000).collect::<String>());
    if diff.trim().is_empty() {
        return Err("Es ist nichts zum Committen vorgemerkt.".into());
    }
    let log = git_output(&root, &["log", "--oneline", "-8"]).unwrap_or_default();
    const SYSTEM: &str = "Formuliere eine Git-Commit-Nachricht für den Diff. Halte dich an Sprache und Stil der bisherigen Commits \
        (falls vorhanden, sonst Deutsch): Betreffzeile im Imperativ, max. 72 Zeichen, optional Leerzeile und kurze Stichpunkte. \
        Antworte als JSON: {\"message\":\"...\"}";
    let v = quick_json(SYSTEM, &format!("Bisherige Commits:\n{log}\n\nDiff:\n{diff}"), 20).await?;
    v["message"].as_str().map(str::to_string).ok_or_else(|| "Keine Nachricht erhalten".into())
}
