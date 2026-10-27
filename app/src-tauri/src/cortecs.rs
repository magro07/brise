//! Cortecs (cortecs.ai): europäischer LLM-Router mit Zero Data Retention (ZDR).
//!
//! - Schlüssel im Schlüsselbund (Dienst `dev.brise.cortecs`, Konto
//!   `CORTECS_API_KEY`), nie im Klartext in Dateien.
//! - Modell-Anbieter für Vibe: `[[providers]]` „cortecs“ in Vibes config.toml.
//!   Vibe kann keine zusätzlichen Body-Felder senden, deshalb zeigt `api_base`
//!   auf einen kleinen Proxy in Brise (nur 127.0.0.1). Er setzt in jeder Anfrage
//!   `allow_zero_data_retention: true` (optional `eu_native` und die
//!   § 203-Anbieterliste) und leitet an `api.cortecs.ai` weiter. Den Schlüssel
//!   kennt der Proxy nicht: Vibe schickt ihn selbst als Bearer-Token mit.
//!   Läuft Brise nicht, scheitern Cortecs-Aufrufe aus Vibe – es geht nie etwas
//!   ohne ZDR raus.
//! - Decisions-API (Beta) für Brises Entscheidungen: Aufgabe einstufen,
//!   Denkstufe nachsteuern, Sensibilitäts-Prüfung – mit Wahrscheinlichkeiten.
//! - Jeder Aufruf landet im Nutzungsjournal, mit den Kosten, die Cortecs selbst
//!   meldet (Credits, 1 € = 1 000 000).
//!
//! Siehe docs/adr/0004-cortecs.md.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use toml_edit::Item;

use crate::config::{edit_config, json_to_table};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const SERVICE: &str = "dev.brise.cortecs";
const ACCOUNT: &str = "CORTECS_API_KEY";
pub const API_BASE: &str = "https://api.cortecs.ai/v1";
const ORIGIN: &str = "https://api.cortecs.ai";
/// Name des Anbieters in Vibes config.toml.
pub const PROVIDER: &str = "cortecs";
/// Bevorzugter Port des ZDR-Proxys; ist er belegt, nimmt Brise einen freien.
const PROXY_PORT: u16 = 47318;

/// Decision-Modelle (Tag „Decision“). Alle laufen bei ZDR-Anbietern.
/// Vergleich an 20 Aufgaben in docs/adr/0004-cortecs.md: Clef Flash ist der
/// beste Kompromiss, Laya ist schneller, aber für Brises Fragen zu ungenau.
pub const DECISION_MODELS: &[(&str, &str)] = &[
    ("clef-flash", "Clef Flash (Berget, empfohlen)"),
    ("clef", "Clef (sference, genauer, 5× teurer)"),
    ("laya", "Laya (Berget, am schnellsten, ungenau)"),
];
const DEFAULT_DECISION_MODEL: &str = "clef-flash";
/// Für Antworten mit Text (Vorschläge, Commit-Nachrichten).
const DEFAULT_CHAT_MODEL: &str = "mistral-small-2603";

/// Anbieter, die Cortecs für § 203 StGB freigibt (Stand 10/2026,
/// docs.cortecs.ai/security-and-compliance/professional-secrecy-agreement).
pub const SECRECY_203_PROVIDERS: &[&str] = &["amazon_ireland", "amazon_paris", "ionos", "ovh", "aki", "infercom", "google", "berget", "tensorix"];

/// Modelle, die Brise in Vibe einträgt: Name bei Cortecs, Alias in Vibe, Anzeigename.
const DEFAULT_MODELS: &[(&str, &str, &str)] = &[
    ("glm-5.3", "cortecs-glm-5-3", "GLM-5.3 · Cortecs ZDR"),
    ("kimi-k2.7-code", "cortecs-kimi-k2-7-code", "Kimi K2.7 Code · Cortecs ZDR"),
    ("qwen3.8-27b", "cortecs-qwen3-8-27b", "Qwen 3.8 27B · Cortecs ZDR"),
    ("mistral-medium-3.5", "cortecs-mistral-medium-3-5", "Mistral Medium 3.5 · Cortecs ZDR"),
];

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().unwrap_or_default()).clone()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------- Schlüssel ----------

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT)
}

/// Umgebung (für Tests/CI), sonst Schlüsselbund.
pub fn read_key() -> Option<String> {
    if let Ok(k) = std::env::var(ACCOUNT) {
        if !k.is_empty() {
            return Some(k);
        }
    }
    entry().ok()?.get_password().ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

pub fn available() -> bool {
    read_key().is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub valid: bool,
    pub message: String,
    pub models: usize,
}

/// `GET /v1/models` ist bei Cortecs öffentlich und prüft den Schlüssel nicht.
/// Deshalb zusätzlich eine winzige Entscheidung (≈ 0,000005 €, mit ZDR):
/// 200 heißt angemeldet, 401 unbekannter Schlüssel.
pub(crate) async fn check(key: &str) -> CmdResult<KeyCheck> {
    let models = client()
        .get(format!("{API_BASE}/models"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Cortecs nicht erreichbar: {e}"))?
        .json::<Value>()
        .await
        .map(|b| b["data"].as_array().map_or(0, Vec::len))
        .unwrap_or(0);
    let status = client()
        .post(format!("{API_BASE}/decisions"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(20))
        .json(&json!({
            "model": DEFAULT_DECISION_MODEL,
            "allow_zero_data_retention": true,
            "input": "ok",
            "questions": [{ "type": "predicate", "name": "ok", "instructions": "Is the text 'ok'?" }]
        }))
        .send()
        .await
        .map_err(|e| format!("Cortecs nicht erreichbar: {e}"))?
        .status();
    let (valid, message) = match status.as_u16() {
        401 => (false, "Cortecs kennt diesen Schlüssel nicht. Bitte prüfen, ob er vollständig kopiert wurde.".to_string()),
        403 => (false, "Der Schlüssel ist gültig, hat aber keinen Zugriff (Projekt, Team oder Budget prüfen).".to_string()),
        402 => (false, "Das Cortecs-Projekt hat kein Guthaben mehr.".to_string()),
        429 => (false, "Zu viele Anfragen – bitte kurz warten.".to_string()),
        200..=299 => (true, "Schlüssel gültig".to_string()),
        code => (false, format!("Cortecs antwortete mit Status {code}.")),
    };
    Ok(KeyCheck { valid, message, models })
}

#[tauri::command]
pub async fn cortecs_save_key(key: String) -> CmdResult<KeyCheck> {
    crate::policy::check_section("providers")?;
    let key = key.trim().to_string();
    if key.len() < 16 || key.contains(char::is_whitespace) {
        return Ok(KeyCheck { valid: false, message: "Das sieht nicht nach einem Cortecs-Schlüssel aus.".into(), models: 0 });
    }
    let result = check(&key).await?;
    if result.valid {
        entry().and_then(|e| e.set_password(&key)).map_err(|e| format!("Schlüsselbund nicht verfügbar: {e}"))?;
        let _ = ensure_vibe_config().await;
    }
    Ok(result)
}

#[tauri::command]
pub fn cortecs_delete_key() -> CmdResult<()> {
    crate::policy::check_section("providers")?;
    match entry().and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Prüft den gespeicherten Schlüssel (für die Einstellungen).
#[tauri::command]
pub async fn cortecs_check_key() -> CmdResult<KeyCheck> {
    let key = read_key().ok_or("Kein Cortecs-Schlüssel gespeichert")?;
    check(&key).await
}

// ---------- Einstellungen ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Nur Anbieter mit Sitz und Aufsicht in der EU (`eu_native`).
    pub eu_native: bool,
    /// Nur die für § 203 StGB freigegebenen Anbieter (`allowed_providers`).
    /// Setzt zusätzlich den Professional Secrecy Addendum mit Cortecs voraus.
    pub secrecy203: bool,
    pub decision_model: String,
    pub chat_model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { eu_native: false, secrecy203: false, decision_model: DEFAULT_DECISION_MODEL.into(), chat_model: DEFAULT_CHAT_MODEL.into() }
    }
}

fn settings_path() -> std::path::PathBuf {
    data_dir().join("cortecs.json")
}

pub fn settings() -> Settings {
    std::fs::read(settings_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn cortecs_save_settings(mut settings: Settings) -> CmdResult<()> {
    crate::policy::check_section("privacy")?;
    let p = crate::policy::effective().policy;
    settings.eu_native |= p.eu_native;
    settings.secrecy203 |= p.secrecy203;
    write_settings(&settings)
}

pub fn write_settings(settings: &Settings) -> CmdResult<()> {
    let _ = std::fs::create_dir_all(data_dir());
    std::fs::write(settings_path(), serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Felder, die Brise in jede Cortecs-Anfrage setzt. ZDR immer.
pub(crate) fn routing_fields(body: &mut serde_json::Map<String, Value>) {
    let s = settings();
    body.insert("allow_zero_data_retention".into(), json!(true));
    if s.eu_native {
        body.insert("eu_native".into(), json!(true));
    }
    if s.secrecy203 {
        // Eigene Liste des Aufrufers nur als Schnittmenge zulassen.
        let wanted: Vec<String> = body
            .get("allowed_providers")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str()).filter(|p| SECRECY_203_PROVIDERS.contains(p)).map(str::to_string).collect())
            .filter(|v: &Vec<String>| !v.is_empty())
            .unwrap_or_else(|| SECRECY_203_PROVIDERS.iter().map(|s| s.to_string()).collect());
        body.insert("allowed_providers".into(), json!(wanted));
    }
}

// ---------- Modellkatalog ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CortecsModel {
    pub id: String,
    pub description: String,
    pub context: u64,
    pub providers: Vec<String>,
    pub tags: Vec<String>,
    pub zdr: bool,
    pub eu_native: bool,
    /// EUR pro 1 Mio. Tokens.
    pub input_price: f64,
    pub output_price: f64,
    pub cache_price: Option<f64>,
}

static CATALOG: Mutex<Option<(Instant, Vec<CortecsModel>)>> = Mutex::new(None);

async fn fetch_ids(query: &str) -> CmdResult<Vec<Value>> {
    let body: Value = client()
        .get(format!("{API_BASE}/models{query}"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Cortecs nicht erreichbar: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    body["data"].as_array().cloned().ok_or_else(|| "Unerwartete Antwort von Cortecs".into())
}

/// Öffentlicher Katalog (Preise in EUR), mit ZDR- und EU-Kennzeichen.
/// Eine Stunde zwischengespeichert.
pub async fn catalog() -> CmdResult<Vec<CortecsModel>> {
    if let Some((at, list)) = CATALOG.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(3600) {
            return Ok(list.clone());
        }
    }
    let (all, zdr, eu, decision) = tokio::join!(
        fetch_ids("?currency=EUR"),
        fetch_ids("?currency=EUR&allow_zero_data_retention=true"),
        fetch_ids("?currency=EUR&eu_native=true"),
        fetch_ids("?currency=EUR&tag=Decision"),
    );
    let ids = |v: &CmdResult<Vec<Value>>| -> Vec<String> { v.as_ref().map(|l| l.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect()).unwrap_or_default() };
    let (zdr, eu) = (ids(&zdr), ids(&eu));
    let mut list: Vec<CortecsModel> = all?
        .into_iter()
        .chain(decision.unwrap_or_default())
        .map(|m| {
            let id = m["id"].as_str().unwrap_or_default().to_string();
            let strs = |k: &str| m[k].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>();
            let tags = strs("tags");
            CortecsModel {
                // Decision-Modelle laufen nur bei Berget/sference – beide ohne Speicherung.
                zdr: zdr.contains(&id) || tags.iter().any(|t| t == "Decision"),
                eu_native: eu.contains(&id),
                description: m["description"].as_str().unwrap_or_default().to_string(),
                context: m["context_size"].as_u64().unwrap_or(0),
                providers: strs("providers"),
                input_price: m["pricing"]["input_token"].as_f64().unwrap_or(0.0),
                output_price: m["pricing"]["output_token"].as_f64().unwrap_or(0.0),
                cache_price: m["pricing"]["cache_read_cost"].as_f64(),
                tags,
                id,
            }
        })
        .collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list.dedup_by(|a, b| a.id == b.id);
    *CATALOG.lock().unwrap() = Some((Instant::now(), list.clone()));
    Ok(list)
}

#[tauri::command]
pub async fn cortecs_models() -> CmdResult<Vec<CortecsModel>> {
    catalog().await
}

// ---------- Vibe-Konfiguration ----------

fn proxy_base() -> String {
    format!("http://127.0.0.1:{}/v1", PROXY.load(Ordering::SeqCst))
}

fn model_entry(name: &str, alias: &str, display: &str, info: Option<&CortecsModel>) -> Value {
    let mut entry = json!({ "provider": PROVIDER, "name": name, "alias": alias, "display_name": display });
    if let Some(m) = info {
        entry["supports_images"] = json!(m.tags.iter().any(|t| t == "Vision"));
        if m.context > 0 {
            entry["max_context_length"] = json!(m.context);
        }
        // Vibe rechnet in seiner Anzeige ohne Währung; die Werte sind EUR.
        entry["input_price"] = json!(m.input_price);
        entry["output_price"] = json!(m.output_price);
        if let Some(c) = m.cache_price {
            entry["cached_input_price"] = json!(c);
        }
        if m.tags.iter().any(|t| t == "Reasoning") {
            entry["thinking"] = json!("high");
            entry["thinking_levels"] = json!(["low", "high", "max"]);
        }
    }
    entry
}

/// Trägt Anbieter und Modelle ein bzw. hält `api_base` auf dem aktuellen
/// Proxy-Port. Ohne Schlüssel ändert Brise nichts.
pub async fn ensure_vibe_config() -> CmdResult<bool> {
    if !available() || PROXY.load(Ordering::SeqCst) == 0 {
        return Ok(false);
    }
    let catalog = catalog().await.unwrap_or_default();
    let base = proxy_base();
    edit_config(|doc| {
        if doc.get("providers").is_some_and(|p| !p.is_array_of_tables()) {
            return Err("`providers` in config.toml hat ein Format, das Brise nicht ändern kann.".into());
        }
        if !doc.contains_key("providers") {
            doc.insert("providers", Item::ArrayOfTables(toml_edit::ArrayOfTables::new()));
        }
        let providers = doc["providers"].as_array_of_tables_mut().expect("geprüft");
        let wanted = json!({
            "name": PROVIDER,
            "api_base": base,
            "api_key_env_var": ACCOUNT,
            "api_style": "openai",
            "backend": "generic",
        });
        let existing = providers.iter().position(|t| t.get("name").and_then(|v| v.as_str()) == Some(PROVIDER));
        match existing.and_then(|i| providers.get_mut(i)) {
            Some(t) => {
                for (k, v) in wanted.as_object().unwrap() {
                    if t.get(k).and_then(|x| x.as_str()) != v.as_str() {
                        t.insert(k, Item::Value(crate::config::json_to_toml(v)?));
                    }
                }
            }
            None => providers.push(json_to_table(&wanted)?),
        }

        if doc.get("models").is_some_and(|m| !m.is_array_of_tables()) {
            return Ok(());
        }
        if !doc.contains_key("models") {
            doc.insert("models", Item::ArrayOfTables(toml_edit::ArrayOfTables::new()));
        }
        let models = doc["models"].as_array_of_tables_mut().expect("geprüft");
        // Nur beim ersten Mal: entfernte Modelle bleiben entfernt.
        let seeded = models.iter().any(|t| t.get("provider").and_then(|v| v.as_str()) == Some(PROVIDER));
        if !seeded {
            for (name, alias, display) in DEFAULT_MODELS {
                let info = catalog.iter().find(|m| m.id == *name);
                if info.is_some_and(|m| !m.zdr) {
                    continue;
                }
                models.push(json_to_table(&model_entry(name, alias, display, info))?);
            }
        }
        Ok(())
    })
}

/// Fügt ein Cortecs-Modell zu Vibe hinzu – nur Modelle mit ZDR.
#[tauri::command]
pub async fn cortecs_add_model(id: String) -> CmdResult<String> {
    crate::policy::check_section("agents")?;
    let catalog = catalog().await?;
    let info = catalog.iter().find(|m| m.id == id).ok_or("Cortecs kennt dieses Modell nicht.")?;
    if !info.zdr {
        return Err("Dieses Modell gibt es bei Cortecs nicht ohne Datenspeicherung (ZDR).".into());
    }
    let alias = format!("cortecs-{}", id.replace(['.', '/', ':'], "-"));
    let display = format!("{id} · Cortecs ZDR");
    let entry = model_entry(&id, &alias, &display, Some(info));
    edit_config(|doc| {
        if !doc.contains_key("models") {
            doc.insert("models", Item::ArrayOfTables(toml_edit::ArrayOfTables::new()));
        }
        let arr = doc["models"].as_array_of_tables_mut().ok_or("`models` hat ein unbekanntes Format")?;
        if arr.iter().any(|t| t.get("alias").and_then(|v| v.as_str()) == Some(alias.as_str())) {
            return Err("Dieses Modell ist schon eingetragen.".into());
        }
        arr.push(json_to_table(&entry)?);
        Ok(())
    })?;
    Ok(alias)
}

/// Vibe erzeugt Titel und Smart-Approve-Urteile mit einem schnellen
/// Mistral-Modell – also mit dem Prompt, an Mistral direkt. Mit „active“
/// nimmt Vibe stattdessen das Modell der Session (bei ZDR: Cortecs).
#[tauri::command]
pub fn cortecs_utility_active(on: bool) -> CmdResult<bool> {
    crate::policy::check_section("agents")?;
    edit_config(|doc| {
        if on {
            if !doc.contains_key("utility_models") {
                doc.insert("utility_models", toml_edit::table());
            }
            let t = doc["utility_models"].as_table_like_mut().ok_or("`utility_models` hat ein unbekanntes Format")?;
            t.insert("title", toml_edit::value("active"));
            t.insert("smart_approve", toml_edit::value("active"));
        } else if let Some(t) = doc.get_mut("utility_models").and_then(Item::as_table_like_mut) {
            for k in ["title", "smart_approve"] {
                if t.get(k).and_then(|v| v.as_str()) == Some("active") {
                    t.remove(k);
                }
            }
        }
        Ok(())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    key_present: bool,
    /// Nur Anfang und Ende, nie der ganze Schlüssel.
    hint: Option<String>,
    proxy_port: u16,
    proxy_running: bool,
    settings: Settings,
    utility_active: bool,
    /// In Vibe eingetragene Cortecs-Modelle (Aliase).
    pub vibe_models: Vec<String>,
    decision_models: Vec<(String, String)>,
    secrecy_providers: Vec<String>,
}

#[tauri::command]
pub fn cortecs_status() -> Status {
    let key = read_key();
    let mut vibe_models = Vec::new();
    let mut utility_active = false;
    let _ = edit_config(|doc| {
        if let Some(arr) = doc.get("models").and_then(Item::as_array_of_tables) {
            vibe_models = arr
                .iter()
                .filter(|t| t.get("provider").and_then(|v| v.as_str()) == Some(PROVIDER))
                .filter_map(|t| t.get("alias").and_then(|v| v.as_str()).map(str::to_string))
                .collect();
        }
        utility_active = doc.get("utility_models").and_then(|t| t.get("title")).and_then(|v| v.as_str()) == Some("active");
        Ok(())
    });
    let port = PROXY.load(Ordering::SeqCst);
    Status {
        key_present: key.is_some(),
        hint: key.map(|k| {
            let c: Vec<char> = k.chars().collect();
            format!("{}…{}", c.iter().take(4).collect::<String>(), c[c.len().saturating_sub(4)..].iter().collect::<String>())
        }),
        proxy_port: port,
        proxy_running: port != 0,
        settings: settings(),
        utility_active,
        vibe_models,
        decision_models: DECISION_MODELS.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
        secrecy_providers: SECRECY_203_PROVIDERS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Liest die Projekt-Einstellungen über die Management-API. Klappt nur mit
/// einem Management-Schlüssel; sonst meldet Brise, dass es nicht prüfbar ist.
#[tauri::command]
pub async fn cortecs_project_config() -> CmdResult<Value> {
    let key = read_key().ok_or("Kein Cortecs-Schlüssel gespeichert")?;
    let resp = client().get(format!("{API_BASE}/manage/project-configs")).bearer_auth(key).timeout(Duration::from_secs(20)).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or_default();
    if !status.is_success() {
        return Ok(json!({ "readable": false, "status": status.as_u16() }));
    }
    Ok(json!({ "readable": true, "config": body }))
}

// ---------- ZDR-Proxy ----------

static PROXY: AtomicU16 = AtomicU16::new(0);

/// Port des lokalen Proxys (0 = läuft nicht). Auch für Anbieter in Vibe (providers.rs).
pub fn proxy_port() -> u16 {
    PROXY.load(Ordering::SeqCst)
}

/// Startet den Proxy (einmal pro Prozess) und gibt den Port zurück.
pub fn start_proxy() -> std::io::Result<u16> {
    let current = PROXY.load(Ordering::SeqCst);
    if current != 0 {
        return Ok(current);
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", PROXY_PORT)).or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    PROXY.store(port, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            PROXY.store(0, Ordering::SeqCst);
            return;
        };
        loop {
            if let Ok((sock, _)) = listener.accept().await {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = serve(sock).await {
                        eprintln!("Cortecs-Proxy: {e}");
                    }
                });
            }
        }
    });
    Ok(port)
}

pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Result<Request, String> {
    let mut buf = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 16 * 1024];
    let head_end = loop {
        if let Some(p) = find(&buf, b"\r\n\r\n") {
            break p;
        }
        if buf.len() > 64 * 1024 {
            return Err("Kopfzeilen zu groß".into());
        }
        let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Verbindung geschlossen".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let header = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let mut rest = buf[head_end + 4..].to_vec();
    let body = if let Some(len) = header("content-length").and_then(|v| v.parse::<usize>().ok()) {
        if len > 64 * 1024 * 1024 {
            return Err("Anfrage zu groß".into());
        }
        while rest.len() < len {
            let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Anfrage unvollständig".into());
            }
            rest.extend_from_slice(&chunk[..n]);
        }
        rest.truncate(len);
        rest
    } else if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        let mut out = Vec::new();
        loop {
            while find(&rest, b"\r\n").is_none() {
                let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("Anfrage unvollständig".into());
                }
                rest.extend_from_slice(&chunk[..n]);
            }
            let p = find(&rest, b"\r\n").unwrap();
            let size = usize::from_str_radix(String::from_utf8_lossy(&rest[..p]).split(';').next().unwrap_or("0").trim(), 16).map_err(|e| e.to_string())?;
            while rest.len() < p + 2 + size + 2 {
                let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("Anfrage unvollständig".into());
                }
                rest.extend_from_slice(&chunk[..n]);
            }
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[p + 2..p + 2 + size]);
            rest.drain(..p + 2 + size + 2);
        }
        out
    } else {
        Vec::new()
    };
    Ok(Request { method, path, headers, body })
}

pub(crate) async fn respond(sock: &mut tokio::net::TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let msg = format!("HTTP/1.1 {status} Brise\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    sock.write_all(msg.as_bytes()).await
}

/// Eine Anfrage: ZDR-Felder setzen, weiterleiten, Antwort durchreichen
/// (auch Streams) und dabei den Verbrauch mitlesen.
async fn serve(mut sock: tokio::net::TcpStream) -> Result<(), String> {
    let req = read_request(&mut sock).await?;
    if req.path.starts_with("/p/") {
        return crate::providers::forward(&mut sock, req).await;
    }
    if req.path == "/__brise" {
        return respond(&mut sock, 200, r#"{"zdr":true}"#).await.map_err(|e| e.to_string());
    }
    if !req.path.starts_with("/v1/") || req.path.contains("/manage/") {
        return respond(&mut sock, 404, r#"{"error":"Brise leitet nur /v1/ weiter"}"#).await.map_err(|e| e.to_string());
    }
    let mut body = req.body;
    let mut model = String::new();
    if req.method == "POST" && !body.is_empty() {
        match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Object(mut map)) => {
                model = map.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
                routing_fields(&mut map);
                body = serde_json::to_vec(&map).map_err(|e| e.to_string())?;
            }
            // Was Brise nicht lesen kann, geht nicht ungeprüft hinaus.
            _ => return respond(&mut sock, 400, r#"{"error":"Brise: Anfrage ist kein JSON-Objekt, ZDR nicht erzwingbar"}"#).await.map_err(|e| e.to_string()),
        }
    }
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut up = client().request(method, format!("{ORIGIN}{}", req.path));
    for (k, v) in &req.headers {
        if matches!(k.as_str(), "authorization" | "content-type" | "accept" | "user-agent" | "anthropic-version" | "x-api-key" | "anthropic-beta") {
            up = up.header(k, v);
        }
    }
    let started = Instant::now();
    let mut resp = match up.body(body).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = json!({ "error": { "message": format!("Cortecs nicht erreichbar: {e}") } }).to_string();
            return respond(&mut sock, 502, &msg).await.map_err(|e| e.to_string());
        }
    };
    let status = resp.status();
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    let head = format!("HTTP/1.1 {} {}\r\nContent-Type: {ctype}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    sock.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut meter = UsageScanner::default();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        meter.feed(&chunk);
        if sock.write_all(&chunk).await.is_err() {
            break; // Vibe hat abgebrochen.
        }
    }
    let _ = sock.flush().await;
    let _ = sock.shutdown().await;
    let first = meter.first;
    if status.is_success() && req.path.ends_with("/chat/completions") {
        if let Some(usage) = meter.finish() {
            journal(&UsageEntry::new("chat", "Chat (Vibe)", &model).usage(&usage).timed(started, first));
        }
    }
    Ok(())
}

/// Sucht im (gestreamten) Antworttext das letzte `usage`-Objekt und merkt sich,
/// wann das erste Token (Text, Gedankengang oder Werkzeugaufruf) kam.
#[derive(Default)]
pub(crate) struct UsageScanner {
    line: Vec<u8>,
    whole: Vec<u8>,
    last: Option<Value>,
    pub first: Option<Instant>,
}

/// Enthält ein Stream-Chunk erzeugte Tokens? Der erste Chunk trägt oft nur die Rolle.
fn has_token(v: &Value) -> bool {
    let d = &v["choices"][0]["delta"];
    ["content", "reasoning_content", "reasoning"].iter().any(|k| d[*k].as_str().is_some_and(|t| !t.is_empty()))
        || d["tool_calls"].as_array().is_some_and(|a| !a.is_empty())
        || d["content"].as_array().is_some_and(|a| !a.is_empty())
}

impl UsageScanner {
    pub fn feed(&mut self, bytes: &[u8]) {
        if self.whole.len() < 4 * 1024 * 1024 {
            self.whole.extend_from_slice(bytes);
        }
        for &b in bytes {
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                if let Some(data) = line.strip_prefix(b"data:") {
                    if let Ok(v) = serde_json::from_slice::<Value>(data.trim_ascii()) {
                        if self.first.is_none() && has_token(&v) {
                            self.first = Some(Instant::now());
                        }
                        if v["usage"].is_object() {
                            self.last = Some(v["usage"].clone());
                        }
                    }
                }
            } else if self.line.len() < 1024 * 1024 {
                self.line.push(b);
            }
        }
    }

    pub fn finish(self) -> Option<Value> {
        self.last.or_else(|| serde_json::from_slice::<Value>(&self.whole).ok().map(|v| v["usage"].clone()).filter(Value::is_object))
    }
}

// ---------- Nutzungsjournal ----------

/// Eintrag im Format des Nutzungsjournals (`<Datenordner>/usage/YYYY-MM.jsonl`,
/// siehe usage.rs auf dem Usage-Branch). Zusätzlich `provider` und `costEur`:
/// Cortecs meldet die echten Kosten, Brise muss nicht schätzen.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    ts: u64,
    kind: String,
    feature: String,
    model: String,
    provider: &'static str,
    #[serde(skip_serializing_if = "is_zero")]
    input: u64,
    #[serde(skip_serializing_if = "is_zero")]
    cached: u64,
    #[serde(skip_serializing_if = "is_zero")]
    output: u64,
    calls: u64,
    cost_eur: f64,
    /// Leistung, Felder wie `usage::Record`.
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ttft_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tps: Option<f64>,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

impl UsageEntry {
    pub fn new(kind: &str, feature: &str, model: &str) -> Self {
        UsageEntry { ts: now_ms(), kind: kind.into(), feature: feature.into(), model: format!("cortecs/{model}"), provider: PROVIDER, calls: 1, ..Default::default() }
    }

    /// Chat-Format (`prompt_tokens`) und Decisions-Format (`input_tokens`).
    pub fn usage(mut self, u: &Value) -> Self {
        self.input = u["prompt_tokens"].as_u64().or(u["input_tokens"].as_u64()).unwrap_or(0);
        self.output = u["completion_tokens"].as_u64().or(u["output_tokens"].as_u64()).unwrap_or(0);
        self.cached = u["prompt_tokens_details"]["cached_tokens"].as_u64().or(u["input_tokens_details"]["cached_tokens"].as_u64()).unwrap_or(0);
        self.cost_eur = credits(u);
        self
    }

    /// `first`: erstes Token im Stream; ohne Stream zählt die ganze Dauer als Generierung.
    fn timed(mut self, started: Instant, first: Option<Instant>) -> Self {
        let end = Instant::now();
        self.duration_ms = Some(end.duration_since(started).as_millis() as u64);
        self.ttft_ms = first.map(|f| f.duration_since(started).as_millis() as u64);
        self.output_tps = crate::usage::tokens_per_second(self.output, end.duration_since(first.unwrap_or(started)));
        self
    }
}

/// Kosten in EUR aus `usage.cost` (Credits) bzw. der Summe der Einzelposten.
pub fn credits(u: &Value) -> f64 {
    let c = &u["cost_details"];
    let parts: f64 = ["prompt_cost", "completion_cost", "cache_read_cost", "cache_write_cost", "prompt_audio_cost"].iter().filter_map(|k| c[*k].as_f64()).sum();
    u["cost"].as_f64().filter(|v| *v > 0.0).unwrap_or(parts) / 1_000_000.0
}

fn year_month(ms: u64) -> (i64, u32) {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m)
}

static JOURNAL: Mutex<()> = Mutex::new(());

/// Schnittstelle zum Nutzungsjournal. Fehler stören nie den eigentlichen Aufruf.
pub fn journal(e: &UsageEntry) {
    let _guard = JOURNAL.lock().unwrap_or_else(|e| e.into_inner());
    let (y, m) = year_month(e.ts);
    let dir = data_dir().join("usage");
    let line = match serde_json::to_string(e) {
        Ok(l) => l + "\n",
        Err(_) => return,
    };
    let result = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{y:04}-{m:02}.jsonl"))))
        .and_then(|mut f| f.write_all(line.as_bytes()));
    if let Err(err) = result {
        eprintln!("Nutzungsjournal: {err}");
    }
}

// ---------- Decisions ----------

/// Antwort der Decisions-API samt Messwerten für Anzeige und Vergleich.
pub struct Decided {
    pub answers: HashMap<String, Value>,
    pub ms: u64,
    pub cost_eur: f64,
    pub model: String,
}

/// `POST /v1/decisions` – immer mit ZDR.
pub async fn decide(feature: &str, input: &str, questions: Value, model: Option<&str>, timeout: Duration) -> CmdResult<Decided> {
    let key = read_key().ok_or("Kein Cortecs-Schlüssel")?;
    let model = model.filter(|m| !m.is_empty()).map(str::to_string).unwrap_or_else(|| settings().decision_model);
    let mut body = json!({ "model": model, "input": input, "questions": questions, "preference": "speed" });
    routing_fields(body.as_object_mut().unwrap());
    let started = Instant::now();
    let resp = client().post(format!("{API_BASE}/decisions")).bearer_auth(key).timeout(timeout).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().or(v["error"].as_str()).or(v["detail"].as_str()).map(str::to_string).unwrap_or_else(|| v.to_string());
        return Err(format!("Cortecs Decisions ({status}): {msg}"));
    }
    let entry = UsageEntry::new("assist", feature, &model).usage(&v["usage"]).timed(started, None);
    let (cost_eur, entry_ms) = (entry.cost_eur, entry.duration_ms.unwrap_or(0));
    journal(&entry);
    let answers = v["answers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["name"].as_str()?.to_string(), a.clone())))
        .collect();
    Ok(Decided { answers, ms: entry_ms, cost_eur, model })
}

/// Wahrscheinlichkeiten einer `choice`-Antwort als Objekt `{wert: p}`.
fn choice_probs(a: &Value) -> serde_json::Map<String, Value> {
    a["probabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["value"].as_str()?.to_string(), json!(p["probability"].as_f64()?))))
        .collect()
}

fn pct(p: f64) -> String {
    format!("{:.0} %", p * 100.0)
}

/// Aufgabe einstufen (simple/standard/complex) – `choice` mit Wahrscheinlichkeiten.
pub async fn classify_task(text: &str, history: Option<&str>, model: Option<&str>) -> CmdResult<Value> {
    let mut input = String::new();
    if let Some(h) = history.filter(|h| !h.is_empty()) {
        input.push_str("Previous requests in this session (excerpt):\n");
        input.push_str(&h.chars().take(1500).collect::<String>());
        input.push_str("\n\n");
    }
    input.push_str("New request to a coding agent:\n");
    input.push_str(&text.chars().take(4000).collect::<String>());
    let questions = json!([{
        "type": "choice",
        "name": "level",
        "instructions": "How demanding is this request for an autonomous coding agent? The request may be written in German.",
        "choices": [
            { "value": "simple", "description": "Short question, explanation, small local edit, rename, formatting, typo." },
            { "value": "standard", "description": "Typical feature, bug fix in a few files, writing tests." },
            { "value": "complex", "description": "Architecture, large refactoring across many files, hard debugging, security, performance, planning." }
        ]
    }]);
    let d = decide("Einstufung", &input, questions, model, Duration::from_secs(6)).await?;
    let a = d.answers.get("level").ok_or("Keine Antwort erhalten")?;
    let level = match a["choice"].as_str() {
        Some(l @ ("simple" | "standard" | "complex")) => l,
        _ => "standard",
    };
    let probs = choice_probs(a);
    let p = probs.get(level).and_then(Value::as_f64).or(a["confidence"].as_f64()).unwrap_or(0.0);
    let label = match level {
        "simple" => "einfach",
        "complex" => "komplex",
        _ => "normal",
    };
    Ok(json!({
        "level": level,
        "reason": format!("Cortecs: {label} zu {}", pct(p)),
        "probabilities": probs,
        "provider": PROVIDER,
        "model": d.model,
        "ms": d.ms,
        "costEur": d.cost_eur,
    }))
}

/// Denkstufe während eines Turns: `choice` low/high/max. Gewechselt wird nur,
/// wenn das Modell sich klar sicher ist (≥ 60 %) – jeder Wechsel kostet Cache.
pub async fn adjust_reasoning(task: &str, progress: &str, current: &str, model: Option<&str>) -> CmdResult<Value> {
    let input = format!(
        "Task:\n{}\n\nProgress of the current turn:\n{}\n\nCurrent reasoning level: {current}",
        task.chars().take(2000).collect::<String>(),
        progress.chars().take(2500).collect::<String>()
    );
    let questions = json!([{
        "type": "choice",
        "name": "level",
        "instructions": "Which reasoning effort should the coding agent (GLM-5.3) use from now on? Switching costs cache, so keep the current level unless another one clearly helps.",
        "choices": [
            { "value": "low", "description": "Routine: reading, searching, simple edits." },
            { "value": "high", "description": "Normal development work." },
            { "value": "max", "description": "Repeated failures, difficult logic, architecture, many dependent steps." }
        ]
    }]);
    let d = decide("Denkstufe", &input, questions, model, Duration::from_secs(6)).await?;
    let a = d.answers.get("level").ok_or("Keine Antwort erhalten")?;
    let probs = choice_probs(a);
    let top = a["choice"].as_str().unwrap_or(current);
    let p = probs.get(top).and_then(Value::as_f64).unwrap_or(0.0);
    let level = if top != current && p < 0.6 { current } else { top };
    Ok(json!({
        "level": level,
        "reason": format!("Cortecs: {top} zu {}", pct(p)),
        "probabilities": probs,
        "provider": PROVIDER,
        "model": d.model,
        "ms": d.ms,
        "costEur": d.cost_eur,
    }))
}

// ---------- Tauri-Commands für die Oberfläche ----------

#[tauri::command]
pub async fn cortecs_classify_task(text: String, history: Option<String>, model: Option<String>) -> CmdResult<Value> {
    classify_task(&text, history.as_deref(), model.as_deref()).await
}

#[tauri::command]
pub async fn cortecs_adjust_reasoning(task: String, progress: String, current: String, model: Option<String>) -> CmdResult<Value> {
    adjust_reasoning(&task, &progress, &current, model.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credits_in_eur() {
        assert_eq!(credits(&json!({ "cost": 2_500_000 })), 2.5);
        assert_eq!(credits(&json!({ "cost_details": { "prompt_cost": 100, "completion_cost": 900 } })), 0.001);
    }

    #[test]
    fn usage_from_stream() {
        let mut s = UsageScanner::default();
        s.feed(b"data: {\"choices\":[]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,");
        s.feed(b"\"completion_tokens\":3,\"cost\":40}}\n\ndata: [DONE]\n\n");
        let u = s.finish().unwrap();
        assert_eq!(u["prompt_tokens"], 12);
        let e = UsageEntry::new("chat", "Chat", "glm-5.3").usage(&u);
        assert_eq!((e.input, e.output), (12, 3));
        // Rolle allein ist noch kein Token, Gedankengang schon.
        let mut s = UsageScanner::default();
        s.feed(b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n");
        assert!(s.first.is_none());
        s.feed(b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Hm\"}}]}\n\n");
        assert!(s.first.is_some());
        let e = UsageEntry::new("chat", "Chat", "glm-5.3").usage(&u).timed(Instant::now(), None);
        assert!(e.duration_ms.is_some() && e.ttft_ms.is_none());
    }

    #[test]
    fn routing_always_zdr() {
        let mut m = serde_json::Map::new();
        m.insert("allow_zero_data_retention".into(), json!(false));
        routing_fields(&mut m);
        assert_eq!(m["allow_zero_data_retention"], json!(true));
    }

    /// Echter Durchlauf mit Schlüssel: `cargo test --lib cortecs::tests::live -- --ignored --nocapture`.
    /// Proxy erzwingt ZDR (Nicht-ZDR-Modell scheitert), Streaming samt Verbrauch,
    /// Decisions, und Vibe selbst über den Proxy.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn live() {
        let key = read_key().expect("Cortecs-Key im Schlüsselbund");
        let port = start_proxy().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let base = format!("http://127.0.0.1:{port}/v1");

        // 1. Ohne ZDR-Anbieter (nur Azure) muss die Anfrage scheitern.
        let r = client()
            .post(format!("{base}/chat/completions"))
            .bearer_auth(&key)
            .json(&json!({ "model": "gpt-5-nano", "max_tokens": 5, "messages": [{ "role": "user", "content": "Hi" }] }))
            .send()
            .await
            .unwrap();
        let status = r.status();
        let body = r.text().await.unwrap();
        println!("gpt-5-nano über Proxy: {status} {}", body.chars().take(160).collect::<String>());
        assert!(!status.is_success(), "Nicht-ZDR-Modell darf nicht antworten");

        // 2. Streaming über den Proxy, Verbrauch wird mitgelesen.
        let started = Instant::now();
        let r = client()
            .post(format!("{base}/chat/completions"))
            .bearer_auth(&key)
            .json(&json!({ "model": "glm-5.3", "stream": true, "stream_options": { "include_usage": true }, "max_tokens": 200, "reasoning_effort": "low",
                "messages": [{ "role": "user", "content": "Antworte nur mit: OK" }] }))
            .send()
            .await
            .unwrap();
        assert!(r.status().is_success(), "{}", r.status());
        let text = r.text().await.unwrap();
        let mut scan = UsageScanner::default();
        scan.feed(text.as_bytes());
        let usage = scan.finish().expect("usage im Stream");
        println!("glm-5.3 Stream: {} ms, usage {usage}, {:.6} €", started.elapsed().as_millis(), credits(&usage));

        // 3. Decisions.
        let d = classify_task("Benenne die Variable foo in bar um", None, None).await.unwrap();
        println!("Einstufung: {d}");

        // 4. Vibe headless mit Cortecs-Modell über den Proxy.
        let home = std::env::temp_dir().join(format!("brise-cortecs-{port}"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("config.toml"),
            format!(
                "active_model = \"cortecs-glm-5-3\"\n\n[[providers]]\nname = \"cortecs\"\napi_base = \"{base}\"\napi_key_env_var = \"CORTECS_API_KEY\"\napi_style = \"openai\"\nbackend = \"generic\"\n\n[[models]]\nname = \"glm-5.3\"\nprovider = \"cortecs\"\nalias = \"cortecs-glm-5-3\"\nthinking = \"low\"\nthinking_levels = [\"low\", \"high\", \"max\"]\n\n[utility_models]\ntitle = \"active\"\nsmart_approve = \"active\"\n"
            ),
        )
        .unwrap();
        let out = tokio::process::Command::new("vibe")
            .args(["-p", "Antworte nur mit dem Wort ZDR.", "--output", "text", "--max-turns", "2", "--workdir"])
            .arg(&home)
            .env("VIBE_HOME", &home)
            .env("CORTECS_API_KEY", &key)
            .output()
            .await
            .expect("vibe startet");
        let stdout = String::from_utf8_lossy(&out.stdout);
        println!("vibe: {} | {}", out.status, stdout.trim().chars().take(300).collect::<String>());
        let _ = std::fs::remove_dir_all(&home);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr).chars().take(800).collect::<String>());
    }

    /// Brise trägt Anbieter und Modelle in eine (temporäre) config.toml ein,
    /// Vibe liest sie und antwortet über ein Cortecs-Modell.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn vibe_config() {
        let key = read_key().expect("Cortecs-Key im Schlüsselbund");
        let home = std::env::temp_dir().join("brise-cortecs-config");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("config.toml"), "active_model = \"cortecs-qwen3-8-27b\"\n\n[[models]]\nname = \"mistral-large-4\"\nprovider = \"mistral\"\nalias = \"mistral-large-4\"\n").unwrap();
        // SAFETY: einziger Test, der VIBE_HOME setzt; läuft mit --ignored allein.
        unsafe { std::env::set_var("VIBE_HOME", &home) };
        start_proxy().unwrap();
        assert!(ensure_vibe_config().await.unwrap(), "erster Lauf ändert die Datei");
        assert!(!ensure_vibe_config().await.unwrap(), "zweiter Lauf ändert nichts");
        assert!(cortecs_utility_active(true).unwrap());
        assert!(cortecs_add_model("gpt-5-nano".into()).await.is_err(), "Nicht-ZDR-Modell abgelehnt");
        assert_eq!(cortecs_add_model("gemma-4-31b-it".into()).await.unwrap(), "cortecs-gemma-4-31b-it");
        let text = std::fs::read_to_string(home.join("config.toml")).unwrap();
        println!("{text}");
        assert!(text.contains("mistral-large-4") && text.contains("api_key_env_var = \"CORTECS_API_KEY\"") && !text.contains(&key));
        let status = cortecs_status();
        assert_eq!(status.vibe_models.len(), DEFAULT_MODELS.len() + 1);
        let out = tokio::process::Command::new("vibe")
            .args(["-p", "Antworte nur mit dem Wort OK.", "--output", "text", "--max-turns", "1", "--workdir"])
            .arg(&home)
            .env("CORTECS_API_KEY", &key)
            .output()
            .await
            .unwrap();
        println!("vibe: {} | {}", out.status, String::from_utf8_lossy(&out.stdout).trim());
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr).chars().take(800).collect::<String>());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Vergleich für docs/adr/0004-cortecs.md:
    /// `cargo test --lib cortecs::tests::eval -- --ignored --nocapture --test-threads=1`.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn eval() {
        const TASKS: &[(&str, &str)] = &[
            ("simple", "Was macht die Funktion `debounce` in utils.ts?"),
            ("simple", "Korrigiere den Tippfehler 'Enstellungen' in Settings.tsx"),
            ("simple", "Benenne die Variable `tmp` in `buffer` um"),
            ("simple", "Formatiere die Datei main.rs mit rustfmt"),
            ("simple", "Erklär mir kurz den Unterschied zwischen let und const"),
            ("simple", "Füge in README.md einen Abschnitt 'Lizenz' mit Apache-2.0 hinzu"),
            ("standard", "Füge der Einstellungsseite einen Schalter für Benachrichtigungstöne hinzu und speichere ihn in den Prefs"),
            ("standard", "Schreib Unit-Tests für parse_config in config.rs, inklusive Fehlerfällen"),
            ("standard", "Der Export als CSV lässt die Kopfzeile weg – finde und behebe den Fehler in export.ts"),
            ("standard", "Baue eine Paginierung für die Sessionliste in der Sidebar (je 50 Einträge)"),
            ("standard", "Ergänze den REST-Endpunkt /api/users um Filter nach Rolle und Tests dazu"),
            ("standard", "Ersetze moment.js durch date-fns in den drei Dateien, die es nutzen"),
            ("standard", "Füge eine Dark-Mode-Variante für die Diff-Ansicht hinzu"),
            ("complex", "Migriere die gesamte App von Redux auf Zustand, inklusive aller 40 Slices und Tests"),
            ("complex", "Unter Last gibt es sporadisch Deadlocks zwischen dem Index-Thread und dem Terminal – finde die Ursache"),
            ("complex", "Entwirf eine Architektur für Kollaboration in Echtzeit mit CRDTs und einem Relay-Server"),
            ("complex", "Mach einen Sicherheits-Review der Authentifizierung: Token-Speicherung, CSRF, Session-Fixation"),
            ("complex", "Die Startzeit ist von 1 s auf 6 s gestiegen; profiliere und optimiere den Start"),
            ("complex", "Plane die Aufteilung des Monolithen in drei Services mit Migrationspfad ohne Downtime"),
            ("complex", "Refactore das Plugin-System so, dass Plugins in einer WASM-Sandbox laufen, über alle Module"),
        ];
        // Mistral Small laut Vibe (FAST_MODEL_CANDIDATES): 0,10 / 0,30 je Mio. Tokens.
        async fn mistral(text: &str) -> (String, u64, f64) {
            let key = crate::credentials::read_key().expect("Mistral-Key");
            let started = Instant::now();
            let v: Value = client()
                .post(format!("{}/chat/completions", crate::credentials::API_BASE))
                .bearer_auth(key)
                .timeout(Duration::from_secs(20))
                .json(&json!({ "model": "mistral-small-latest", "temperature": 0.2, "response_format": { "type": "json_object" },
                    "messages": [{ "role": "system", "content": crate::assist::CLASSIFY_SYSTEM }, { "role": "user", "content": crate::assist::classify_input(text, None) }] }))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let ms = started.elapsed().as_millis() as u64;
            let level = serde_json::from_str::<Value>(v["choices"][0]["message"]["content"].as_str().unwrap_or("{}")).unwrap_or_default()["level"].as_str().unwrap_or("?").to_string();
            let cost = v["usage"]["prompt_tokens"].as_f64().unwrap_or(0.0) * 0.10e-6 + v["usage"]["completion_tokens"].as_f64().unwrap_or(0.0) * 0.30e-6;
            (level, ms, cost)
        }
        let models = ["laya", "clef-flash", "clef"];
        let mut stats: Vec<(String, usize, usize, Vec<u64>, f64)> = std::iter::once("mistral-small".to_string()).chain(models.iter().map(|m| m.to_string())).map(|m| (m, 0, 0, vec![], 0.0)).collect();
        println!("| # | erwartet | Mistral Small | laya | clef-flash | clef |\n|---|---|---|---|---|---|");
        for (n, (want, text)) in TASKS.iter().enumerate() {
            let mut row = format!("| {} | {want} |", n + 1);
            let (level, ms, cost) = mistral(text).await;
            let s = &mut stats[0];
            s.1 += usize::from(level == *want);
            s.2 += usize::from((level == "simple" && *want == "complex") || (level == "complex" && *want == "simple"));
            s.3.push(ms);
            s.4 += cost;
            row.push_str(&format!(" {level} ({ms} ms) |"));
            for (i, m) in models.iter().enumerate() {
                match classify_task(text, None, Some(m)).await {
                    Ok(v) => {
                        let level = v["level"].as_str().unwrap_or("?").to_string();
                        let ms = v["ms"].as_u64().unwrap_or(0);
                        let p = v["probabilities"][&level].as_f64().unwrap_or(0.0);
                        let s = &mut stats[i + 1];
                        s.1 += usize::from(level == *want);
                        s.2 += usize::from((level == "simple" && *want == "complex") || (level == "complex" && *want == "simple"));
                        s.3.push(ms);
                        s.4 += v["costEur"].as_f64().unwrap_or(0.0);
                        row.push_str(&format!(" {level} {:.0} % ({ms} ms) |", p * 100.0));
                    }
                    Err(e) => row.push_str(&format!(" Fehler: {} |", e.chars().take(60).collect::<String>())),
                }
            }
            println!("{row}");
        }
        println!("\n| Modell | richtig | grob falsch | Median | p90 | Kosten je 1000 Entscheidungen |\n|---|---|---|---|---|---|");
        for (m, ok, bad, mut ms, cost) in stats {
            ms.sort();
            let q = |f: f64| ms.get(((ms.len() as f64 - 1.0) * f).round() as usize).copied().unwrap_or(0);
            println!("| {m} | {ok}/20 | {bad} | {} ms | {} ms | {:.4} € |", q(0.5), q(0.9), cost / 20.0 * 1000.0);
        }

        const SENSITIVE: &[(bool, &str)] = &[
            (false, "Schreib eine Funktion, die IBANs validiert, z. B. DE89 3704 0044 0532 0130 00"),
            (true, "Hier die Patientenliste: Anna Müller, geb. 03.04.1981, Diagnose F32.1, Tel +49 170 1234567 – importier sie in die Datenbank"),
            (true, "Mein DB-Passwort ist Xk9#mP2!qL, trag es in die .env ein: password=Xk9#mP2!qL"),
            (false, "Refactore die Funktion parse_config und schreib Tests"),
            (true, "Baue ein Tool, das Bewerber automatisch nach Lebenslauf rankt und aussortiert"),
            (true, "Fasse dieses vertrauliche Board-Memo zusammen: Umsatzplanung 2027 sieht 14 Mio. EUR vor, Übernahme der Firma Hansen GmbH geplant"),
            (false, "Schreibe Tests für die Klasse PatientRepository mit Mock-Daten"),
            (false, "Ersetze process.env.API_KEY durch einen Config-Loader"),
            (true, "Mandant Herr Dr. Klaus Berger, Az. 12/2026, schuldet 4.300 €; formuliere ein Mahnschreiben an ihn"),
            (false, "Erkläre, wie Gesichtserkennung in OpenCV technisch funktioniert"),
            (true, "Warum funktioniert mein Key sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUv nicht?"),
            (false, "Validiere im Kontaktformular E-Mail-Adressen wie test@example.com"),
        ];
        for model in ["laya", "clef-flash", "clef"] {
            println!("\n**{model}**\n\n| erwartet | lokal | mit Cortecs | Kategorien | ms |\n|---|---|---|---|---|");
            let (mut right, mut ms_all) = (0, vec![]);
            for (want, text) in SENSITIVE {
                let local = crate::sensitive::check(text, &[], None, false, None).await;
                let remote = crate::sensitive::check(text, &[], None, true, Some(model)).await;
                right += usize::from(remote.flagged == *want);
                if remote.ms > 0 {
                    ms_all.push(remote.ms);
                }
                println!(
                    "| {} | {} | {} | {} | {} |",
                    if *want { "sensibel" } else { "unkritisch" },
                    if local.flagged { "markiert" } else { "–" },
                    if remote.flagged { "markiert" } else { "–" },
                    remote.reason,
                    remote.ms
                );
            }
            ms_all.sort();
            println!("\n{model}: {right}/12 richtig, Median {} ms", ms_all.get(ms_all.len() / 2).copied().unwrap_or(0));
        }
    }

    #[test]
    fn month_of_timestamp() {
        assert_eq!(year_month(1_792_972_800_000), (2026, 10));
    }
}
