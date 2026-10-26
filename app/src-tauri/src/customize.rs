//! Selbstanpassung per Chat: `brise --mcp-app` ist ein MCP-Server, über den
//! Vibe Brise verändern kann – Einstellungen, eigenes CSS, Schnellaktionen
//! und Vibes config.toml. Die laufende App beobachtet die Dateien und
//! übernimmt Änderungen sofort (Event `custom:changed`).

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

fn custom_dir() -> PathBuf {
    data_dir().join("custom")
}
fn settings_file() -> PathBuf {
    custom_dir().join("settings.json")
}
fn css_file() -> PathBuf {
    custom_dir().join("custom.css")
}

fn read_settings() -> Map<String, Value> {
    std::fs::read(settings_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_settings(map: &Map<String, Value>) -> CmdResult<()> {
    std::fs::create_dir_all(custom_dir()).map_err(|e| e.to_string())?;
    std::fs::write(settings_file(), serde_json::to_vec_pretty(map).unwrap()).map_err(|e| e.to_string())
}

/// Aktuelle Anpassungen für die Oberfläche.
#[tauri::command]
pub fn read_customization() -> Value {
    json!({
        "settings": read_settings(),
        "css": std::fs::read_to_string(css_file()).unwrap_or_default(),
    })
}

/// Die Oberfläche meldet Änderungen, die der Nutzer selbst macht, zurück –
/// damit Vibe den aktuellen Stand lesen kann.
#[tauri::command]
pub fn sync_prefs(prefs: Value) -> CmdResult<()> {
    let mut map = read_settings();
    map.insert("current".into(), prefs);
    // Übernommene Änderungen von Vibe sind damit erledigt.
    map.remove("overrides");
    write_settings(&map)
}

/// Beobachtet die Anpassungsdateien und meldet Änderungen an die Oberfläche.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let stamp = || {
            [settings_file(), css_file()]
                .iter()
                .map(|p| std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH))
                .collect::<Vec<_>>()
        };
        let mut last = stamp();
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let now = stamp();
            if now != last {
                last = now;
                let _ = app.emit("custom:changed", read_customization());
            }
        }
    });
}

// ---------- MCP-Server ----------

/// Einstellungen der Oberfläche, die Vibe ändern darf (Schlüssel → Beschreibung).
const PREFS: &[(&str, &str)] = &[
    ("theme", "\"system\", \"light\" oder \"dark\""),
    ("fontSize", "Schriftgröße der Oberfläche in px (12–18)"),
    ("notify", "Benachrichtigung, wenn eine Session im Hintergrund fertig ist (true/false)"),
    ("sttLanguage", "Sprache der Spracheingabe, z. B. \"de\" oder \"en\""),
    ("autoNarrate", "Antworten automatisch vorlesen (true/false)"),
    ("embedModel", "\"codestral-embed\" oder \"mistral-embed\""),
    ("agentSearch", "Vibe darf die semantische Suche nutzen (true/false)"),
    ("rea", "REA-Werkzeuge in Sessions mitgeben (true/false)"),
    ("autoModel", "Automatische Modellwahl (true/false)"),
    ("routing", "Objekt {simple, standard, complex} mit Vibe-Modell-Aliasen für die Auto-Wahl"),
    ("accent", "Akzentfarbe als CSS-Farbe, z. B. \"#e8590c\" (null = Standard)"),
];

fn tools() -> Value {
    json!([
        {
            "name": "brise_get_settings",
            "description": "Liest die aktuellen Einstellungen der Brise-Oberfläche, das eigene CSS und die Schnellaktionen.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "brise_set_setting",
            "description": format!(
                "Ändert eine Einstellung der Brise-Oberfläche; wirkt sofort. Erlaubte Schlüssel: {}",
                PREFS.iter().map(|(k, d)| format!("{k} ({d})")).collect::<Vec<_>>().join("; ")
            ),
            "inputSchema": {
                "type": "object",
                "properties": { "key": { "type": "string", "enum": PREFS.iter().map(|(k, _)| *k).collect::<Vec<_>>() }, "value": {} },
                "required": ["key", "value"]
            }
        },
        {
            "name": "brise_set_custom_css",
            "description": "Setzt eigenes CSS für die Brise-Oberfläche (ersetzt das bisherige; leerer Text entfernt es). Wirkt sofort. \
                Farben über CSS-Variablen auf :root bzw. :root[data-theme=\"dark\"]: --bg, --sidebar, --panel, --elev, --hover, --active, --line, \
                --fg, --fg-2, --muted, --accent, --accent-soft, --ok, --warn, --bad, --code, --user, --app-font-size. \
                Bereiche tragen data-brise-Attribute: sidebar, header, conversation, composer, side-panel, terminal, user-message, assistant-message, tool-group.",
            "inputSchema": { "type": "object", "properties": { "css": { "type": "string" } }, "required": ["css"] }
        },
        {
            "name": "brise_set_quick_actions",
            "description": "Legt eigene Schnellaktionen fest, die auf der Startseite jedes Projekts als Karten erscheinen (ersetzt die bisherigen). \
                Jede Aktion: {title (max. 4 Wörter), description (ein Satz), prompt (vollständige Anweisung an den Agenten), icon (bug|test|docs|refactor|feature|explain|git|perf|security)}.",
            "inputSchema": {
                "type": "object",
                "properties": { "actions": { "type": "array", "items": { "type": "object" } } },
                "required": ["actions"]
            }
        },
        {
            "name": "brise_set_vibe_config",
            "description": "Ändert einen Eintrag in Vibes config.toml (z. B. default_agent, auto_compact_threshold, enable_subagents, disabled_skills). \
                key ist ein Pfad wie [\"enable_subagents\"] oder [\"tools\",\"bash\",\"allowlist\"]; value null entfernt den Eintrag. \
                Gilt für neue Sessions.",
            "inputSchema": {
                "type": "object",
                "properties": { "key": { "type": "array", "items": { "type": "string" } }, "value": {} },
                "required": ["key", "value"]
            }
        }
    ])
}

fn call_tool(name: &str, args: &Value) -> CmdResult<String> {
    match name {
        "brise_get_settings" => {
            let custom = read_customization();
            Ok(serde_json::to_string_pretty(&custom).unwrap())
        }
        "brise_set_setting" => {
            let key = args["key"].as_str().ok_or("key fehlt")?;
            if !PREFS.iter().any(|(k, _)| *k == key) {
                return Err(format!("Unbekannte Einstellung {key}"));
            }
            let mut map = read_settings();
            let overrides = map.entry("overrides").or_insert_with(|| json!({}));
            overrides[key] = args["value"].clone();
            write_settings(&map)?;
            Ok(format!("{key} gesetzt – Brise übernimmt es sofort."))
        }
        "brise_set_custom_css" => {
            let css = args["css"].as_str().unwrap_or("");
            std::fs::create_dir_all(custom_dir()).map_err(|e| e.to_string())?;
            std::fs::write(css_file(), css).map_err(|e| e.to_string())?;
            Ok(if css.trim().is_empty() { "Eigenes CSS entfernt.".into() } else { "CSS gesetzt – sofort sichtbar.".into() })
        }
        "brise_set_quick_actions" => {
            let actions = args["actions"].as_array().ok_or("actions muss eine Liste sein")?;
            let mut map = read_settings();
            map.insert("quickActions".into(), Value::Array(actions.clone()));
            write_settings(&map)?;
            Ok(format!("{} Schnellaktionen gespeichert.", actions.len()))
        }
        "brise_set_vibe_config" => {
            let key: Vec<String> = args["key"].as_array().ok_or("key fehlt")?.iter().filter_map(|k| k.as_str().map(str::to_string)).collect();
            if key.first().map(String::as_str) == Some("bypass_tool_permissions") {
                return Err("Freigaben abschalten geht nur in den Einstellungen von Brise, nicht per Chat.".into());
            }
            crate::config::write_config_value(key.clone(), args["value"].clone())?;
            Ok(format!("{} in config.toml geändert – gilt für neue Sessions.", key.join(".")))
        }
        other => Err(format!("Unbekanntes Werkzeug {other}")),
    }
}

/// `brise --mcp-app`: MCP-Server (stdio) für die Selbstanpassung.
pub fn run_mcp_server() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue };
        let reply = match msg["method"].as_str().unwrap_or("") {
            "initialize" => json!({ "result": {
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "brise-app", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Werkzeuge, mit denen du die Desktop-App Brise selbst anpasst, wenn der Nutzer das im Chat wünscht."
            }}),
            "ping" => json!({ "result": {} }),
            "tools/list" => json!({ "result": { "tools": tools() } }),
            "tools/call" => {
                let p = &msg["params"];
                match call_tool(p["name"].as_str().unwrap_or(""), &p["arguments"]) {
                    Ok(text) => json!({ "result": { "content": [{ "type": "text", "text": text }] } }),
                    Err(e) => json!({ "result": { "content": [{ "type": "text", "text": e }], "isError": true } }),
                }
            }
            m => json!({ "error": { "code": -32601, "message": format!("Unbekannte Methode {m}") } }),
        };
        let mut out = reply;
        out["jsonrpc"] = json!("2.0");
        out["id"] = id;
        let _ = writeln!(stdout, "{out}");
        let _ = stdout.flush();
    }
}

/// MCP-Eintrag für jede Session.
pub fn mcp_entry() -> Option<Value> {
    let exe = std::env::current_exe().ok()?;
    Some(json!({ "name": "brise-app", "command": exe.display().to_string(), "args": ["--mcp-app"], "env": crate::agent::child_env() }))
}
