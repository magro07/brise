//! Modellverwaltung: Mistrals Modellkatalog abrufen, Modelle in Vibes
//! `config.toml` eintragen (`[[models]]`) und beim Start neue Modelle melden.
//!
//! Ohne eigene Einträge bietet Vibe nur `mistral-medium-3.5` an. Brise trägt
//! zusätzlich Mistral Large 4 und GLM-5.3 ein.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use toml_edit::Item;

use crate::config::{edit_config, json_to_table};
use crate::credentials::{read_key, API_BASE};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub description: String,
    pub context: u64,
    pub vision: bool,
    pub tools: bool,
    pub reasoning: bool,
    pub aliases: Vec<String>,
}

/// Modelle, die Brise immer anbietet – Name bei Mistral, Alias in Vibe, Anzeigename.
/// Brises Standardmodell (Vibe-Alias), passend zu DEFAULT_MODEL im Frontend.
const DEFAULT_MODEL: &str = "deepseek-v4-1-flash-1017";

const DEFAULTS: &[(&str, &str, &str)] = &[
    ("mistral-large-4", "mistral-large-4", "Mistral Large 4"),
    ("zai-glm-5-3", "glm-5-3", "GLM-5.3"),
    (DEFAULT_MODEL, DEFAULT_MODEL, "DeepSeek V4.1 Flash"),
];

/// Multimodale Modelle, die Mistrals Katalog (noch) ohne `vision` meldet.
fn multimodal(id: &str) -> bool {
    id.starts_with("deepseek-v4")
}

/// Was kein Chat-Modell für Vibe ist.
fn skip(id: &str) -> bool {
    ["voxtral", "embed", "ocr", "moderation", "fim", "vibe-cli"].iter().any(|s| id.contains(s))
}

/// Bevorzugter Name einer Alias-Gruppe: ohne Datum und ohne „-latest“, kurz.
fn canonical(ids: &[String]) -> String {
    let dated = |s: &str| s.rsplit('-').next().is_some_and(|t| t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()));
    let mut best: Vec<&String> = ids.iter().filter(|i| !i.ends_with("-latest") && !dated(i)).collect();
    if best.is_empty() {
        best = ids.iter().collect();
    }
    best.sort_by_key(|i| (i.len(), (*i).clone()));
    best[0].clone()
}

/// Mistrals Modellkatalog, Aliase zusammengefasst, nur Chat-Modelle.
#[tauri::command]
pub async fn model_catalog() -> CmdResult<Vec<CatalogModel>> {
    let key = read_key().ok_or("Kein Mistral-Schlüssel gefunden")?;
    let body: Value = reqwest::Client::new()
        .get(format!("{API_BASE}/models"))
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Mistral nicht erreichbar: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let data = body["data"].as_array().ok_or("Unerwartete Antwort von Mistral")?;

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in data {
        let id = m["id"].as_str().unwrap_or_default().to_string();
        let caps = &m["capabilities"];
        if seen.contains(&id) || skip(&id) || caps["completion_chat"] != true {
            continue;
        }
        let mut group: Vec<String> = vec![id.clone()];
        group.extend(m["aliases"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)));
        // Manche Aliase verweisen quer (z. B. magistral → medium); nur echte Geschwister zählen.
        let members: Vec<String> = group
            .iter()
            .filter(|g| data.iter().any(|o| o["id"] == g.as_str() && o["description"] == m["description"]))
            .cloned()
            .collect();
        seen.extend(members.iter().cloned());
        if members.iter().any(|g| skip(g)) {
            continue;
        }
        out.push(CatalogModel {
            id: canonical(&members),
            description: m["description"].as_str().unwrap_or_default().to_string(),
            context: m["max_context_length"].as_u64().unwrap_or(0),
            vision: caps["vision"] == true || members.iter().any(|g| multimodal(g)),
            tools: caps["function_calling"] == true,
            reasoning: caps["reasoning"] == true,
            aliases: members,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredModel {
    alias: String,
    name: String,
    provider: String,
    display_name: Option<String>,
}

fn configured_from(doc: &toml_edit::DocumentMut) -> Vec<ConfiguredModel> {
    let mut out = Vec::new();
    if let Some(arr) = doc.get("models").and_then(Item::as_array_of_tables) {
        for t in arr.iter() {
            let get = |k: &str| t.get(k).and_then(|v| v.as_str()).map(str::to_string);
            if let (Some(name), Some(alias)) = (get("name"), get("alias")) {
                out.push(ConfiguredModel { alias, name, provider: get("provider").unwrap_or_default(), display_name: get("display_name") });
            }
        }
    }
    out
}

/// Von Brise oder dem Nutzer in config.toml eingetragene Modelle.
#[tauri::command]
pub fn configured_models() -> CmdResult<Vec<ConfiguredModel>> {
    let mut list = Vec::new();
    edit_config(|doc| {
        list = configured_from(doc);
        Ok(())
    })?;
    Ok(list)
}

fn model_entry(name: &str, alias: &str, display: &str, info: Option<&CatalogModel>) -> Value {
    let mut entry = json!({ "provider": "mistral", "name": name, "alias": alias, "display_name": display });
    if let Some(m) = info {
        entry["supports_images"] = json!(m.vision);
        if m.context > 0 {
            entry["max_context_length"] = json!(m.context);
        }
        // Gemessene Stufen (thinking.rs); in Brise korrigiert bzw. leitet
        // mistral_proxy.rs sie beim Start von Vibe, hier gilt, was auch die
        // Vibe-CLI ohne Brise richtig schickt.
        match crate::thinking::config_levels("mistral", name) {
            Some(levels) => {
                if levels.contains(&"high") {
                    entry["thinking"] = json!("high");
                }
                entry["thinking_levels"] = json!(levels);
            }
            None if m.reasoning => entry["thinking"] = json!("high"),
            None => {}
        }
    }
    entry
}

fn add_entries(entries: Vec<Value>) -> CmdResult<bool> {
    edit_config(|doc| {
        let existing = configured_from(doc);
        let fresh: Vec<&Value> = entries
            .iter()
            .filter(|e| !existing.iter().any(|c| c.name == e["name"].as_str().unwrap_or("") || c.alias == e["alias"].as_str().unwrap_or("")))
            .collect();
        if fresh.is_empty() {
            return Ok(());
        }
        if doc.get("models").is_some_and(|m| !m.is_array_of_tables()) {
            return Err("`models` in config.toml hat ein Format, das Brise nicht ändern kann.".into());
        }
        if !doc.contains_key("models") {
            doc.insert("models", Item::ArrayOfTables(toml_edit::ArrayOfTables::new()));
        }
        let arr = doc["models"].as_array_of_tables_mut().expect("geprüft");
        for e in fresh {
            arr.push(json_to_table(e)?);
        }
        Ok(())
    })
}

/// Stellt sicher, dass Brises Standardmodelle in Vibe verfügbar sind.
pub async fn ensure_default_models() -> CmdResult<bool> {
    let catalog = model_catalog().await.unwrap_or_default();
    let entries = DEFAULTS
        .iter()
        .map(|(name, alias, display)| model_entry(name, alias, display, catalog.iter().find(|m| m.aliases.iter().any(|a| a == name))))
        .collect();
    let added = add_entries(entries)?;
    Ok(fix_thinking_levels()? | fix_images()? | default_compact()? | flash_limits()? | default_active()? | default_web_search()? || added)
}

/// Stellt jede Vibe-Installation einmalig auf Brises Standardmodell (DeepSeek V4.1 Flash) um.
/// Danach merkt sich Vibe selbst das zuletzt gewählte Modell. Die Marke liegt neben der Config.
fn default_active() -> CmdResult<bool> {
    let marker = crate::config::config_path()?.with_file_name(".brise-default-model-v5");
    if marker.exists() {
        return edit_config(|doc| {
            if doc.get("active_model").and_then(|v| v.as_str()).is_none() {
                doc.insert("active_model", toml_edit::value(DEFAULT_MODEL));
            }
            Ok(())
        });
    }
    let changed = edit_config(|doc| {
        doc.insert("active_model", toml_edit::value(DEFAULT_MODEL));
        // Oberste Stufe: In Brise heißt sie Ultra.
        if let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) {
            if let Some(t) = arr.iter_mut().find(|t| t.get("name").and_then(|v| v.as_str()) == Some(DEFAULT_MODEL)) {
                t.insert("thinking", toml_edit::value("max"));
            }
        }
        Ok(())
    })?;
    std::fs::write(&marker, "").map_err(|e| e.to_string())?;
    Ok(changed)
}

/// Mistrals Katalog nennt für DeepSeek V4.1 Flash 1017 nicht die echten Grenzen: 1M Kontext, 128k Ausgabe.
fn flash_limits() -> CmdResult<bool> {
    edit_config(|doc| {
        let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) else { return Ok(()) };
        for t in arr.iter_mut() {
            if t.get("name").and_then(|v| v.as_str()) == Some(DEFAULT_MODEL) {
                t.insert("max_context_length", toml_edit::value(1_000_000_i64));
                t.insert("max_output_tokens", toml_edit::value(128_000_i64));
            }
        }
        Ok(())
    })
}

/// DeepSeek V4 komprimiert erst ab 500k; eine eigene Einstellung bleibt.
fn default_compact() -> CmdResult<bool> {
    edit_config(|doc| {
        let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) else { return Ok(()) };
        for t in arr.iter_mut() {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.starts_with("deepseek-v4") && !t.contains_key("auto_compact_threshold") {
                t.insert("auto_compact_threshold", toml_edit::value(500_000_i64));
            }
        }
        Ok(())
    })
}

/// Auto-Compact für ein einzelnes Modell; `tokens = None` nimmt Vibes Standard.
#[tauri::command]
pub fn set_model_compact(alias: String, tokens: Option<i64>) -> CmdResult<()> {
    edit_config(|doc| {
        let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) else { return Ok(()) };
        for t in arr.iter_mut().filter(|t| t.get("alias").and_then(|v| v.as_str()) == Some(alias.as_str())) {
            match tokens {
                Some(n) => t.insert("auto_compact_threshold", toml_edit::value(n)),
                None => t.remove("auto_compact_threshold"),
            };
        }
        Ok(())
    })?;
    Ok(())
}

/// Websuche läuft ohne Rückfrage, solange niemand etwas anderes eingestellt hat.
/// Sie liest nur; `web_fetch` fragt weiter nach.
fn default_web_search() -> CmdResult<bool> {
    edit_config(|doc| {
        if doc.get("tools").and_then(|t| t.get("web_search")).and_then(|t| t.get("permission")).is_none() {
            let tools = doc.entry("tools").or_insert_with(|| { let mut t = toml_edit::Table::new(); t.set_implicit(true); Item::Table(t) });
            let Some(tools) = tools.as_table_mut() else { return Ok(()) };
            let search = tools.entry("web_search").or_insert_with(|| Item::Table(toml_edit::Table::new()));
            if let Some(search) = search.as_table_mut() {
                search.insert("permission", toml_edit::value("always"));
            }
        }
        Ok(())
    })
}

/// Schaltet Bilder für multimodale Modelle frei, die mit `supports_images = false`
/// eingetragen wurden – sonst schickt Vibe ihnen keine Bilder.
fn fix_images() -> CmdResult<bool> {
    edit_config(|doc| {
        let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) else { return Ok(()) };
        for t in arr.iter_mut() {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let provider = t.get("provider").and_then(|v| v.as_str()).unwrap_or("mistral");
            if provider == "mistral" && multimodal(name) && t.get("supports_images").and_then(|v| v.as_bool()) != Some(true) {
                t.insert("supports_images", toml_edit::value(true));
            }
        }
        Ok(())
    })
}

/// Korrigiert Denkstufen bestehender GLM-/Large-4-Einträge (auch von Hand
/// angelegter) auf die gemessenen (thinking.rs): „low“ würde Vibe als `none`
/// senden – GLM-5.3 antwortet dann mit HTTP 400; „max“ bei Large 4 wäre nur
/// ein zweites „high“.
fn fix_thinking_levels() -> CmdResult<bool> {
    edit_config(|doc| {
        let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) else { return Ok(()) };
        for t in arr.iter_mut() {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let provider = t.get("provider").and_then(|v| v.as_str()).unwrap_or("mistral").to_string();
            if provider != "mistral" || !(name.starts_with("zai-glm") || name.starts_with("mistral-large-4")) {
                continue;
            }
            let levels: Vec<String> = t
                .get("thinking_levels")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let Some(wanted) = crate::thinking::config_levels("mistral", &name) else { continue };
            if levels != wanted {
                let a: toml_edit::Array = wanted.iter().copied().collect();
                t.insert("thinking_levels", Item::Value(toml_edit::Value::Array(a)));
            }
            // Über Brise gültige Stufen (z. B. „max“ bei GLM) bleiben stehen: Vibe
            // schreibt die gewählte Stufe hierher zurück, die CLI fällt selbst auf „high“.
            let thinking = t.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
            let via_brise = crate::thinking::vibe_levels("mistral", &name).map(|(l, _)| l).unwrap_or_default();
            if !wanted.contains(&thinking) && !via_brise.contains(&thinking) {
                t.insert("thinking", toml_edit::value("high"));
            }
        }
        Ok(())
    })
}

/// Fügt ein Modell aus dem Katalog (oder frei benannt) hinzu.
#[tauri::command]
pub async fn add_model(name: String, alias: Option<String>, display_name: Option<String>) -> CmdResult<()> {
    crate::policy::check_section("agents")?;
    let catalog = model_catalog().await.unwrap_or_default();
    let info = catalog.iter().find(|m| m.id == name || m.aliases.contains(&name));
    let alias = alias.filter(|a| !a.is_empty()).unwrap_or_else(|| name.clone());
    let display = display_name.filter(|d| !d.is_empty()).unwrap_or_else(|| name.clone());
    if !add_entries(vec![model_entry(&name, &alias, &display, info)])? {
        return Err("Dieses Modell ist schon eingetragen.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn remove_model(alias: String) -> CmdResult<()> {
    crate::policy::check_section("agents")?;
    edit_config(|doc| {
        if let Some(arr) = doc.get_mut("models").and_then(Item::as_array_of_tables_mut) {
            arr.retain(|t| t.get("alias").and_then(|v| v.as_str()) != Some(alias.as_str()));
        }
        Ok(())
    })?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupReport {
    /// Brise hat config.toml geändert (Standardmodelle, Skill-Pfad).
    changed: bool,
    /// Modelle, die seit dem letzten Start neu im Katalog sind.
    new_models: Vec<CatalogModel>,
}

/// Läuft bei jedem Start vor der Verbindung zu Vibe.
#[tauri::command]
pub async fn startup_check(app: tauri::AppHandle) -> CmdResult<StartupReport> {
    let mut changed = crate::skills::install_bundled(&app).unwrap_or(false);
    changed |= crate::skills::write_agent_profiles().unwrap_or(false);
    changed |= crate::cortecs::ensure_vibe_config().await.unwrap_or(false);
    if read_key().is_none() {
        return Ok(StartupReport { changed, new_models: vec![] });
    }
    changed |= ensure_default_models().await.unwrap_or(false);
    // Vibes eigenen Modellkatalog lesen, damit auch dessen Modelle die gemessenen Stufen bekommen.
    crate::mistral_proxy::refresh_catalog().await;
    // Unbekannte Modelle im Hintergrund messen; gilt ab dem nächsten Start von Vibe.
    tauri::async_runtime::spawn(crate::thinking::measure_configured());

    let catalog = match model_catalog().await {
        Ok(c) => c,
        Err(_) => return Ok(StartupReport { changed, new_models: vec![] }),
    };
    let path = data_dir().join("models-seen.json");
    let seen: Option<HashSet<String>> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let all: HashSet<String> = catalog.iter().map(|m| m.id.clone()).collect();
    let new_models = match &seen {
        Some(seen) => catalog.into_iter().filter(|m| !seen.contains(&m.id)).collect(),
        None => vec![], // Erster Start: alles gilt als bekannt.
    };
    let _ = std::fs::create_dir_all(data_dir());
    let mut merged: HashSet<String> = seen.unwrap_or_default();
    merged.extend(all);
    let _ = std::fs::write(&path, serde_json::to_vec(&merged).unwrap_or_default());
    Ok(StartupReport { changed, new_models })
}

/// Eckdaten eines Vibe-Modells aus config.toml (für `available_models` der Master-Session):
/// Kontextgröße, Bilder, Denkstufen. Leer, wenn das Modell dort nicht eingetragen ist.
pub fn model_facts(alias: &str) -> Value {
    let Some(path) = crate::config::vibe_home().map(|h| h.join("config.toml")) else { return Value::Null };
    let Ok(doc) = std::fs::read_to_string(path).unwrap_or_default().parse::<toml::Table>() else { return Value::Null };
    let Some(m) = doc.get("models").and_then(|m| m.as_array()).and_then(|a| a.iter().find(|m| m.get("alias").and_then(|v| v.as_str()) == Some(alias))) else {
        return Value::Null;
    };
    json!({
        "name": m.get("name").and_then(|v| v.as_str()),
        "context": m.get("max_context_length").and_then(|v| v.as_integer()),
        "images": m.get("supports_images").and_then(|v| v.as_bool()),
        "thinking": m.get("thinking_levels").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>()),
    })
}
