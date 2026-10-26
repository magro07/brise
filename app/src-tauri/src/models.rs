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
const DEFAULTS: &[(&str, &str, &str)] = &[
    ("mistral-large-4", "mistral-large-4", "Mistral Large 4"),
    ("zai-glm-5-3", "glm-5-3", "GLM-5.3"),
];

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
            vision: caps["vision"] == true,
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
        if m.reasoning {
            entry["thinking"] = json!("high");
            entry["thinking_levels"] = json!(["low", "high", "max"]);
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
    add_entries(entries)
}

/// Fügt ein Modell aus dem Katalog (oder frei benannt) hinzu.
#[tauri::command]
pub async fn add_model(name: String, alias: Option<String>, display_name: Option<String>) -> CmdResult<()> {
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
    if read_key().is_none() {
        return Ok(StartupReport { changed, new_models: vec![] });
    }
    changed |= ensure_default_models().await.unwrap_or(false);

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
