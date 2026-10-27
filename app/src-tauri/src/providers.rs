//! Anbieter für Brises eigene Modellaufrufe: Mistral, Anthropic, OpenAI,
//! Google Gemini, Cortecs und beliebig viele OpenAI-kompatible Endpunkte
//! (Ollama, LM Studio, vLLM, OpenRouter, Groq, Together, Azure OpenAI …).
//!
//! - Konfiguration ohne Geheimnisse in `<Datenordner>/providers.json`.
//! - Schlüssel nur im Schlüsselbund: Mistral weiter dort, wo Vibe ihn ablegt
//!   (credentials.rs), Cortecs unter `dev.brise.cortecs` (cortecs.rs), alle
//!   anderen unter Dienst `dev.brise.providers`, Konto = Anbieter-ID.
//!   Bestehende Schlüssel bleiben also, wo sie sind – nichts wird kopiert.
//! - Modelle werden als `<anbieter>/<modell>` angegeben, z. B.
//!   `openai/gpt-4.1-mini` oder `ollama/qwen3:8b`. Ohne bekannten Anbieter
//!   davor gilt der Name als Mistral-Modell (so stehen sie in alten Einstellungen).
//! - Vibe kann OpenAI- und Anthropic-kompatible Anbieter über `[[providers]]`
//!   nutzen. Brise trägt freigegebene Anbieter dort als `brise-<id>` ein; die
//!   Anfragen laufen über den lokalen Proxy (cortecs.rs, Pfad `/p/<id>/…`),
//!   der Schlüssel und Kopfzeilen erst dort einsetzt. Vibe kennt nur ein
//!   Sitzungs-Token von Brise, nie den Schlüssel.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use toml_edit::Item;

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const SERVICE: &str = "dev.brise.providers";
pub const MISTRAL: &str = "mistral";
pub const ANTHROPIC: &str = "anthropic";
pub const OPENAI: &str = "openai";
pub const GEMINI: &str = "gemini";
pub const CORTECS: &str = "cortecs";
/// Art eines frei angelegten Anbieters.
pub const COMPATIBLE: &str = "compatible";
/// Präfix der Anbieter, die Brise in Vibes config.toml einträgt.
const VIBE_PREFIX: &str = "brise-";
/// Umgebungsvariable, über die Vibe dem Proxy das Sitzungs-Token schickt.
pub const TOKEN_ENV: &str = "BRISE_PROVIDER_TOKEN";

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().unwrap_or_default()).clone()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------- Konfiguration ----------

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub id: String,
    /// mistral, anthropic, openai, gemini, cortecs oder compatible.
    pub kind: String,
    pub name: String,
    /// Mit `/v1` o. Ä., ohne abschließenden Schrägstrich.
    pub base_url: String,
    /// Vorlage, aus der der Eintrag entstand (ollama, openrouter, azure …).
    pub template: Option<String>,
    /// Kopfzeile für den Schlüssel; leer = `Authorization: Bearer …`.
    pub auth_header: String,
    /// Weitere feste Kopfzeilen (keine Geheimnisse – die gehören in den Schlüssel).
    pub headers: BTreeMap<String, String>,
    /// Anbieter speichert keine Daten (lokal oder vertraglich ZDR).
    pub zdr: bool,
    /// In Vibes config.toml eintragen.
    pub vibe_export: bool,
    /// Diese Modelle in Vibe anbieten.
    pub vibe_models: Vec<String>,
    /// € je Million Tokens; leer = Preistabelle (Nutzung → Preise).
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    /// Modell für die Schlüsselprüfung und als Vorschlag.
    pub test_model: String,
}

impl Provider {
    pub fn is_builtin(&self) -> bool {
        BUILTINS.iter().any(|(id, ..)| *id == self.id)
    }

    /// Läuft auf diesem Rechner bzw. im lokalen Netz – kostet nichts, speichert nichts außer Haus.
    pub fn is_local(&self) -> bool {
        let rest = self.base_url.split("://").nth(1).unwrap_or("");
        let host = rest.split(['/', ':']).next().unwrap_or("");
        let host = if rest.starts_with('[') { rest.split(']').next().unwrap_or("").trim_start_matches('[') } else { host };
        host == "localhost"
            || host == "::1"
            || host.ends_with(".local")
            || host.starts_with("127.")
            || host.starts_with("10.")
            || host.starts_with("192.168.")
            || (host.starts_with("172.") && host.split('.').nth(1).and_then(|o| o.parse::<u8>().ok()).is_some_and(|o| (16..=31).contains(&o)))
    }

    /// Ohne Schlüssel nutzbar (lokale Server wie Ollama).
    pub fn key_optional(&self) -> bool {
        self.kind == COMPATIBLE && self.is_local()
    }

    pub fn api_style(&self) -> &'static str {
        if self.kind == ANTHROPIC { "anthropic" } else { "openai" }
    }

    /// Vibe bringt Mistral selbst mit, Cortecs hat einen eigenen Eintrag (cortecs.rs).
    pub fn exportable(&self) -> bool {
        self.id != MISTRAL && self.kind != CORTECS
    }
}

/// Feste Anbieter: ID, Name, Basis-URL, Modell für die Prüfung.
const BUILTINS: &[(&str, &str, &str, &str)] = &[
    (MISTRAL, "Mistral", "https://api.mistral.ai/v1", "mistral-small-latest"),
    (ANTHROPIC, "Anthropic", "https://api.anthropic.com/v1", "claude-haiku-4-5"),
    (OPENAI, "OpenAI", "https://api.openai.com/v1", "gpt-4.1-nano"),
    (GEMINI, "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash-lite"),
    (CORTECS, "Cortecs (ZDR)", "https://api.cortecs.ai/v1", "clef-flash"),
];

fn builtin(id: &str) -> Option<Provider> {
    BUILTINS.iter().find(|(i, ..)| *i == id).map(|(id, name, base, test)| Provider {
        id: id.to_string(),
        kind: id.to_string(),
        name: name.to_string(),
        base_url: base.to_string(),
        zdr: *id == CORTECS,
        test_model: test.to_string(),
        ..Default::default()
    })
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    /// 1 = Stand nach der Umstellung von „nur Mistral“ (Migration erledigt).
    version: u32,
    providers: Vec<Provider>,
}

fn store_path() -> std::path::PathBuf {
    data_dir().join("providers.json")
}

fn load_stored() -> Stored {
    std::fs::read(store_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_stored(s: &Stored) -> CmdResult<()> {
    let _ = std::fs::create_dir_all(data_dir());
    let tmp = store_path().with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, store_path()).map_err(|e| e.to_string())
}

/// Feste Anbieter (mit den Feldern, die man bei ihnen ändern darf) und eigene.
pub fn all() -> Vec<Provider> {
    let stored = load_stored();
    let mut list: Vec<Provider> = BUILTINS
        .iter()
        .filter_map(|(id, ..)| builtin(id))
        .map(|mut b| {
            if let Some(s) = stored.providers.iter().find(|s| s.id == b.id) {
                b.vibe_export = s.vibe_export && b.exportable();
                b.vibe_models = s.vibe_models.clone();
                b.input_price = s.input_price;
                b.output_price = s.output_price;
                if !s.test_model.trim().is_empty() {
                    b.test_model = s.test_model.clone();
                }
            }
            b
        })
        .collect();
    list.extend(stored.providers.into_iter().filter(|p| builtin(&p.id).is_none()).map(|mut p| {
        p.kind = COMPATIBLE.into();
        p
    }));
    list
}

pub fn get(id: &str) -> Option<Provider> {
    all().into_iter().find(|p| p.id == id)
}

/// Erster Start nach der Umstellung: Datei anlegen, damit klar ist, dass die
/// alten Schlüssel (Mistral, Cortecs) übernommen sind. Sie bleiben, wo sie sind.
pub fn migrate() {
    let mut s = load_stored();
    if s.version >= 1 {
        return;
    }
    s.version = 1;
    let _ = save_stored(&s);
}

// ---------- Schlüssel ----------

fn entry(id: &str) -> keyring::Result<keyring::Entry> {
    if cfg!(windows) {
        keyring::Entry::new_with_target(&format!("{SERVICE}:{id}"), SERVICE, id)
    } else {
        keyring::Entry::new(SERVICE, id)
    }
}

/// Übliche Umgebungsvariable des Anbieters (wie bei dessen eigenen Werkzeugen).
fn env_var(id: &str) -> Option<&'static str> {
    match id {
        ANTHROPIC => Some("ANTHROPIC_API_KEY"),
        OPENAI => Some("OPENAI_API_KEY"),
        GEMINI => Some("GEMINI_API_KEY"),
        _ => None,
    }
}

fn from_env(id: &str) -> Option<String> {
    env_var(id).and_then(|v| std::env::var(v).ok()).map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

pub fn read_key(id: &str) -> Option<String> {
    match id {
        MISTRAL => crate::credentials::read_key(),
        CORTECS => crate::cortecs::read_key(),
        _ => from_env(id).or_else(|| entry(id).ok()?.get_password().ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())),
    }
}

/// Woher der Schlüssel kommt – nur für die Anzeige.
fn key_source(id: &str) -> &'static str {
    match id {
        MISTRAL => "vibe",
        CORTECS => "keyring",
        _ if from_env(id).is_some() => "env",
        _ => "keyring",
    }
}

/// Anbieter mit Schlüssel (bzw. lokal ohne Schlüssel nutzbar).
pub fn usable(p: &Provider) -> bool {
    p.key_optional() || read_key(&p.id).is_some()
}

fn fingerprint(key: &str) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(key.as_bytes());
    format!("key-{}", hash.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>())
}

// ---------- Modell-Angaben ----------

/// `anbieter/modell` → (Anbieter, Modell). Unbekanntes Präfix: Mistral-Modell
/// (Modell-IDs mit Schrägstrich wie bei OpenRouter bleiben so heil).
pub fn split_ref(r: &str) -> (Provider, String) {
    let r = r.trim();
    if let Some((p, m)) = r.split_once('/') {
        if let Some(p) = get(p) {
            return (p, m.to_string());
        }
    }
    (builtin(MISTRAL).expect("Mistral ist eingebaut"), r.to_string())
}

/// Ist dieses Modell gerade nutzbar (Anbieter bekannt, Schlüssel da)?
pub fn available(r: &str) -> bool {
    !r.trim().is_empty() && usable(&split_ref(r).0)
}

/// Gültige Angabe mit Präfix, z. B. für alte Mistral-Namen ohne Präfix.
pub fn canonical(r: &str) -> String {
    let (p, m) = split_ref(r);
    format!("{}/{m}", p.id)
}

/// Speichert der Anbieter dieses Modells keine Daten (Cortecs, als ZDR markiert, lokal)?
pub fn is_zdr(r: &str) -> bool {
    let (p, _) = split_ref(r);
    p.zdr || p.is_local()
}

/// Vorschlag je Anbieter und Zweck, falls nichts eingestellt ist.
fn default_model(p: &Provider, purpose: &str) -> Option<String> {
    let m = match (p.id.as_str(), purpose) {
        (CORTECS, "decide" | "sensitivity") => crate::cortecs::settings().decision_model,
        (CORTECS, _) => crate::cortecs::settings().chat_model,
        (MISTRAL, "council") => "mistral-large-4".into(),
        (MISTRAL, _) => "mistral-small-latest".into(),
        (ANTHROPIC, _) => "claude-haiku-4-5".into(),
        (OPENAI, _) => "gpt-4.1-mini".into(),
        (GEMINI, _) => "gemini-2.5-flash".into(),
        _ if !p.test_model.trim().is_empty() => p.test_model.clone(),
        _ => cached_models(&p.id).into_iter().next()?,
    };
    Some(format!("{}/{m}", p.id))
}

/// Modell für eine Funktion von Brise (`decide`, `helper`, `sensitivity`,
/// `judge`): Einstellung der Oberfläche (`taskModels`), sonst alte
/// Einstellungen (`assistModel`, `decisionProvider`), sonst der erste
/// Anbieter mit Schlüssel. `None`, wenn kein Anbieter nutzbar ist.
pub fn function_model(purpose: &str) -> Option<String> {
    let prefs = crate::customize::current_prefs();
    let chosen = prefs["taskModels"][purpose].as_str().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    if let Some(m) = chosen.filter(|m| available(m)) {
        return Some(m);
    }
    if matches!(purpose, "decide" | "helper") {
        if prefs["decisionProvider"].as_str() == Some(CORTECS) && crate::cortecs::available() {
            return builtin(CORTECS).and_then(|p| default_model(&p, purpose));
        }
        if let Some(m) = prefs["assistModel"].as_str().filter(|m| !m.is_empty()) {
            let m = canonical(m);
            if available(&m) {
                return Some(m);
            }
        }
    }
    if purpose == "sensitivity" {
        // Bisher prüfte nur Cortecs (ZDR); andere Anbieter erst nach ausdrücklicher Wahl.
        return builtin(CORTECS).filter(usable).and_then(|p| default_model(&p, purpose));
    }
    all().into_iter().filter(usable).find_map(|p| default_model(&p, purpose))
}

// ---------- Modellaufruf ----------

pub struct Ask<'a> {
    pub system: &'a str,
    pub user: &'a str,
    /// Antwort als JSON-Objekt anfordern.
    pub json: bool,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    /// Denkaufwand (`low`, `high` …), wo der Anbieter ihn kennt.
    pub effort: Option<&'a str>,
    pub timeout: u64,
}

impl<'a> Ask<'a> {
    pub fn json(system: &'a str, user: &'a str, timeout: u64) -> Self {
        Ask { system, user, json: true, max_tokens: None, temperature: Some(0.2), effort: None, timeout }
    }
}

pub struct Reply {
    pub text: String,
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub provider: Provider,
    pub model: String,
    /// Vom Anbieter gemeldete Kosten (Cortecs).
    pub reported_eur: Option<f64>,
    pub took: Duration,
    pub truncated: bool,
}

impl Reply {
    /// Kosten in €: gemeldet, eigener Preis des Anbieters, lokal kostenlos, sonst Preistabelle.
    pub fn cost_eur(&self) -> f64 {
        cost_eur(&self.provider, &self.model, self.input, self.cached, self.output, self.reported_eur)
    }

    /// Antwort als JSON, auch mit Codezaun oder Vorrede.
    pub fn json(&self) -> CmdResult<Value> {
        parse_json(&self.text).ok_or_else(|| {
            if self.truncated {
                format!("Antwort abgeschnitten ({} Tokens)", self.output)
            } else {
                format!("Kein gültiges JSON ({} Zeichen Antwort)", self.text.len())
            }
        })
    }
}

/// Fehler eines Aufrufs mit HTTP-Status, falls es eine Antwort gab.
pub struct CallError {
    pub status: Option<u16>,
    pub message: String,
}

impl From<CallError> for String {
    fn from(e: CallError) -> String {
        match e.status {
            Some(s) => format!("HTTP {s}: {}", e.message),
            None => e.message,
        }
    }
}

pub fn parse_json(text: &str) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    serde_json::from_str(&t[start..=end]).ok()
}

fn error_message(v: &Value) -> String {
    v["error"]["message"]
        .as_str()
        .or(v["message"].as_str())
        .or(v["detail"].as_str())
        .or(v["error"].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| v.to_string().chars().take(300).collect())
}

/// Schlüssel und feste Kopfzeilen an eine Anfrage hängen.
fn authorize(mut rb: reqwest::RequestBuilder, p: &Provider, key: Option<&str>) -> reqwest::RequestBuilder {
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        let header = p.auth_header.trim();
        rb = if p.kind == ANTHROPIC {
            rb.header("x-api-key", k)
        } else if header.is_empty() || header.eq_ignore_ascii_case("authorization") {
            rb.bearer_auth(k)
        } else {
            rb.header(header, k)
        };
    }
    if p.kind == ANTHROPIC {
        rb = rb.header("anthropic-version", "2023-06-01");
    }
    for (k, v) in &p.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    rb
}

/// Vorbereitete POST-Anfrage an `<base>/<path>` beim Anbieter von `model_ref`
/// (z. B. `embeddings`), mit Schlüssel und Kopfzeilen. Liefert auch Anbieter und Modellnamen.
pub fn post(model_ref: &str, path: &str) -> CmdResult<(reqwest::RequestBuilder, Provider, String)> {
    let (p, model) = split_ref(model_ref);
    let key = read_key(&p.id);
    if key.is_none() && !p.key_optional() {
        return Err(format!("Kein Schlüssel für {} (Einstellungen → Anbieter & Schlüssel)", p.name));
    }
    let rb = authorize(client().post(format!("{}/{path}", p.base_url.trim_end_matches('/'))), &p, key.as_deref());
    Ok((rb, p, model))
}

/// Anbieter und eigene Preise in einen Journal-Eintrag übernehmen (Mistral bleibt ohne Anbieterfeld).
pub fn tag_record(rec: &mut crate::usage::Record, p: &Provider) {
    if p.id != MISTRAL {
        rec.provider = Some(p.id.clone());
        rec.account = read_key(&p.id).map(|k| fingerprint(&k));
    }
    if (p.input_price.is_some() && p.output_price.is_some()) || p.is_local() {
        rec.cost_eur = Some(cost_eur(p, &rec.model, rec.input, rec.cached, rec.output, None));
    }
}

/// Text aus einer Chat-Antwort; Denk-Modelle liefern Blöcke (thinking + text).
fn message_text(body: &Value) -> String {
    let content = &body["choices"][0]["message"]["content"];
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

/// Ein Modellaufruf beim Anbieter aus `model_ref`. Protokolliert nichts –
/// dafür `record` oder `chat_json`.
pub async fn ask(model_ref: &str, a: &Ask<'_>) -> Result<Reply, CallError> {
    let (p, model) = split_ref(model_ref);
    let key = read_key(&p.id);
    if key.is_none() && !p.key_optional() {
        return Err(CallError { status: None, message: format!("Kein Schlüssel für {} (Einstellungen → Anbieter & Schlüssel)", p.name) });
    }
    ask_with(&p, key.as_deref(), &model, a).await
}

async fn ask_with(p: &Provider, key: Option<&str>, model: &str, a: &Ask<'_>) -> Result<Reply, CallError> {
    if p.kind == ANTHROPIC {
        return ask_anthropic(p, key, model, a).await;
    }
    let mut body = json!({
        "model": model,
        "messages": [{ "role": "system", "content": a.system }, { "role": "user", "content": a.user }]
    });
    if let Some(t) = a.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = a.max_tokens {
        // OpenAI nimmt bei neuen Modellen nur noch max_completion_tokens.
        body[if p.kind == OPENAI { "max_completion_tokens" } else { "max_tokens" }] = json!(m);
    }
    if a.json {
        body["response_format"] = json!({ "type": "json_object" });
    }
    if let Some(e) = a.effort {
        body["reasoning_effort"] = json!(e);
    }
    if p.kind == CORTECS {
        crate::cortecs::routing_fields(body.as_object_mut().expect("Objekt"));
    }
    let url = format!("{}/chat/completions", p.base_url.trim_end_matches('/'));
    let started = Instant::now();
    let mut fixes = 0;
    let (reply, took) = loop {
        let left = a.timeout.saturating_sub(started.elapsed().as_secs()).max(5);
        let attempt = Instant::now();
        let resp = authorize(client().post(&url), p, key)
            .timeout(Duration::from_secs(left))
            .json(&body)
            .send()
            .await
            .map_err(|e| CallError { status: None, message: net_error(p, &e, a.timeout) })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| CallError { status: Some(status.as_u16()), message: net_error(p, &e, a.timeout) })?;
        let v: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text.chars().take(300).collect::<String>() }));
        if status.is_success() {
            break (v, attempt.elapsed());
        }
        let msg = error_message(&v);
        // Nicht jeder Anbieter kennt jeden Parameter: einmal ohne bzw. anders versuchen.
        if status.as_u16() == 400 && fixes < 4 && adapt(&mut body, &msg) {
            fixes += 1;
            continue;
        }
        return Err(CallError { status: Some(status.as_u16()), message: msg.chars().take(300).collect() });
    };
    let u = &reply["usage"];
    Ok(Reply {
        text: message_text(&reply),
        input: u["prompt_tokens"].as_u64().unwrap_or(0),
        cached: u["prompt_tokens_details"]["cached_tokens"].as_u64().or(u["cached_tokens"].as_u64()).unwrap_or(0),
        output: u["completion_tokens"].as_u64().unwrap_or(0),
        reported_eur: (p.kind == CORTECS).then(|| crate::cortecs::credits(u)),
        provider: p.clone(),
        model: reply["model"].as_str().filter(|_| p.kind != CORTECS).unwrap_or(model).to_string(),
        took,
        truncated: reply["choices"][0]["finish_reason"] == "length",
    })
}

/// Passt die Anfrage an eine Fehlermeldung an; `false`, wenn nichts zu ändern ist.
fn adapt(body: &mut Value, msg: &str) -> bool {
    let m = msg.to_lowercase();
    let obj = body.as_object_mut().expect("Objekt");
    if m.contains("max_tokens") && obj.contains_key("max_tokens") {
        let v = obj.remove("max_tokens").unwrap_or_default();
        obj.insert("max_completion_tokens".into(), v);
        return true;
    }
    for key in ["reasoning_effort", "response_format", "temperature", "max_completion_tokens"] {
        if (m.contains(key) || (key == "response_format" && m.contains("json"))) && obj.remove(key).is_some() {
            return true;
        }
    }
    false
}

fn net_error(p: &Provider, e: &reqwest::Error, timeout: u64) -> String {
    if e.is_timeout() {
        format!("keine Antwort nach {timeout} s")
    } else {
        format!("{} nicht erreichbar: {e}", p.name)
    }
}

async fn ask_anthropic(p: &Provider, key: Option<&str>, model: &str, a: &Ask<'_>) -> Result<Reply, CallError> {
    let system = if a.json { format!("{}\n\nAntworte ausschließlich mit einem gültigen JSON-Objekt, ohne Codezaun.", a.system) } else { a.system.to_string() };
    let mut body = json!({
        "model": model,
        "system": system,
        "max_tokens": a.max_tokens.unwrap_or(4096),
        "messages": [{ "role": "user", "content": a.user }]
    });
    if let Some(t) = a.temperature {
        body["temperature"] = json!(t);
    }
    let started = Instant::now();
    let resp = authorize(client().post(format!("{}/messages", p.base_url.trim_end_matches('/'))), p, key)
        .timeout(Duration::from_secs(a.timeout))
        .json(&body)
        .send()
        .await
        .map_err(|e| CallError { status: None, message: net_error(p, &e, a.timeout) })?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(CallError { status: Some(status.as_u16()), message: error_message(&v) });
    }
    let text = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("");
    let u = &v["usage"];
    let cached = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
    Ok(Reply {
        text,
        input: u["input_tokens"].as_u64().unwrap_or(0) + cached,
        cached,
        output: u["output_tokens"].as_u64().unwrap_or(0),
        reported_eur: None,
        provider: p.clone(),
        model: model.to_string(),
        took: started.elapsed(),
        truncated: v["stop_reason"] == "max_tokens",
    })
}

// ---------- Kosten und Nutzungsjournal ----------

pub fn cost_eur(p: &Provider, model: &str, input: u64, cached: u64, output: u64, reported: Option<f64>) -> f64 {
    if let Some(eur) = reported {
        return eur;
    }
    if let (Some(i), Some(o)) = (p.input_price, p.output_price) {
        return (input as f64 * i + output as f64 * o) / 1e6;
    }
    if p.is_local() {
        return 0.0;
    }
    let mut rec = crate::usage::Record::new("assist", "", &journal_model(p, model));
    rec.provider = (p.id != MISTRAL).then(|| p.id.clone());
    rec.input = input;
    rec.cached = cached;
    rec.output = output;
    crate::usage::estimate_eur(&rec).unwrap_or(0.0)
}

/// Modellname im Journal: Cortecs wie bisher mit Präfix, sonst der Name beim Anbieter.
fn journal_model(p: &Provider, model: &str) -> String {
    if p.kind == CORTECS { format!("cortecs/{model}") } else { model.to_string() }
}

/// Bucht einen Aufruf ins Nutzungsjournal (`kind` z. B. `assist`, `council`, `bench`).
pub fn record(kind: &str, feature: &str, cwd: Option<&str>, r: &Reply) {
    let mut rec = crate::usage::Record::new(kind, feature, &journal_model(&r.provider, &r.model)).project(cwd);
    rec.input = r.input;
    rec.cached = r.cached;
    rec.output = r.output;
    rec.calls = u64::from(r.input + r.output == 0);
    // Eigene Preise und lokale Modelle fest buchen (tag_record), gemeldete Kosten ebenso;
    // sonst rechnet die Preistabelle – auch rückwirkend, wenn man Preise ändert.
    tag_record(&mut rec, &r.provider);
    if let Some(eur) = r.reported_eur {
        rec.cost_eur = Some(eur);
    }
    crate::usage::record(rec.perf(r.took, None, r.took));
}

/// Chat-Antwort im JSON-Modus mit Journal-Eintrag – für Einstufung, Vorschläge,
/// Commit-Nachrichten, Richter usw.
pub async fn chat_json(model_ref: &str, kind: &str, feature: &str, system: &str, user: &str, timeout: u64, cwd: Option<&str>) -> CmdResult<Value> {
    let reply = ask(model_ref, &Ask::json(system, user, timeout)).await?;
    record(kind, feature, cwd, &reply);
    reply.json()
}

// ---------- Modellliste und Schlüsselprüfung ----------

fn models_path() -> std::path::PathBuf {
    data_dir().join("provider-models.json")
}

pub fn cached_models(id: &str) -> Vec<String> {
    let v: Value = std::fs::read(models_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v[id]["models"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect()
}

fn cached_at(id: &str) -> u64 {
    let v: Value = std::fs::read(models_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v[id]["at"].as_u64().unwrap_or(0)
}

fn cache_models(id: &str, models: &[String]) {
    let mut v: Value = std::fs::read(models_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v[id] = json!({ "at": now_ms(), "models": models });
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(models_path(), serde_json::to_vec_pretty(&v).unwrap_or_default());
}

/// Modelle, die nicht chatten (für die Prüfung und die Auswahl ausgeblendet).
fn non_chat(id: &str) -> bool {
    let id = id.to_lowercase();
    ["embed", "whisper", "tts", "dall-e", "moderation", "ocr", "transcribe", "image", "audio", "realtime", "babbage", "davinci", "rerank", "aqa", "veo", "imagen"]
        .iter()
        .any(|w| id.contains(w))
}

/// `GET /models` → (Status, IDs). Manche Anbieter antworten auch ohne gültigen
/// Schlüssel mit 200 – deshalb prüft `check` zusätzlich mit einem echten Aufruf.
async fn list_models(p: &Provider, key: Option<&str>) -> Result<(u16, Vec<String>), String> {
    if p.kind == CORTECS {
        let list = crate::cortecs::catalog().await?;
        return Ok((200, list.into_iter().filter(|m| m.zdr).map(|m| m.id).collect()));
    }
    let resp = authorize(client().get(format!("{}/models", p.base_url.trim_end_matches('/'))), p, key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("{} nicht erreichbar: {e}", p.name))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or_default();
    // OpenAI-Format (`data`), Ollama-nativ (`models`), Gemini mit `models/`-Präfix.
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .or(body["models"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().or(m["name"].as_str()).map(|s| s.trim_start_matches("models/").to_string()))
        .collect();
    ids.sort();
    ids.dedup();
    Ok((status, ids))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub valid: bool,
    pub message: String,
    pub models: Vec<String>,
    /// Modell, mit dem der Testaufruf lief.
    pub tested_with: Option<String>,
}

fn test_model_for(p: &Provider, models: &[String]) -> Option<String> {
    let wanted = p.test_model.trim();
    if !wanted.is_empty() && (models.is_empty() || models.iter().any(|m| m == wanted) || p.kind == COMPATIBLE) {
        return Some(wanted.to_string());
    }
    let chat: Vec<&String> = models.iter().filter(|m| !non_chat(m)).collect();
    // Kleine Modelle bevorzugen – der Testaufruf soll fast nichts kosten.
    ["nano", "mini", "small", "lite", "haiku", "flash", "8b", "3b", "1b"]
        .iter()
        .find_map(|w| chat.iter().find(|m| m.to_lowercase().contains(w)))
        .or(chat.first())
        .map(|m| m.to_string())
        .or_else(|| (!wanted.is_empty()).then(|| wanted.to_string()))
}

/// Prüft einen Schlüssel: Modellliste holen und mit einem winzigen echten
/// Aufruf bestätigen.
pub async fn check(p: &Provider, key: Option<&str>) -> CmdResult<KeyCheck> {
    if p.kind == CORTECS {
        let k = key.ok_or("Kein Schlüssel")?;
        let c = crate::cortecs::check(k).await?;
        let models = if c.valid { list_models(p, Some(k)).await.map(|r| r.1).unwrap_or_default() } else { Vec::new() };
        return Ok(KeyCheck { valid: c.valid, message: c.message, models, tested_with: Some(crate::cortecs::settings().decision_model) });
    }
    let (status, models) = list_models(p, key).await?;
    if matches!(status, 401 | 403) {
        return Ok(KeyCheck { valid: false, message: format!("{} lehnt den Schlüssel ab (HTTP {status}). Bitte prüfen, ob er vollständig kopiert wurde.", p.name), models: vec![], tested_with: None });
    }
    let Some(model) = test_model_for(p, &models) else {
        return Ok(KeyCheck {
            valid: false,
            message: if status == 200 { "Keine Modelle gefunden. Bitte ein Testmodell angeben.".into() } else { format!("Modellliste nicht abrufbar (HTTP {status}). Bitte ein Testmodell angeben.") },
            models,
            tested_with: None,
        });
    };
    let ask = Ask { system: "Antworte nur mit: ok", user: "ok", json: false, max_tokens: Some(16), temperature: None, effort: None, timeout: 60 };
    let (valid, message) = match ask_with(p, key, &model, &ask).await {
        Ok(_) => (true, format!("Schlüssel gültig – Testaufruf mit {model} erfolgreich.")),
        Err(CallError { status: Some(401 | 403), message }) => (false, format!("{} lehnt den Schlüssel ab: {message}", p.name)),
        Err(CallError { status: Some(402), .. }) => (false, format!("{}: kein Guthaben mehr auf dem Konto.", p.name)),
        Err(CallError { status: Some(429), .. }) => (true, "Schlüssel angenommen, aber gerade zu viele Anfragen (Limit). Später erneut prüfen.".into()),
        // Modell unbekannt o. Ä.: Die Anmeldung hat geklappt, nur dieses Modell nicht.
        Err(CallError { status: Some(s @ (400 | 404 | 422)), message }) => (true, format!("Schlüssel angenommen, aber {model} lehnte ab (HTTP {s}): {message}")),
        Err(e) => (false, String::from(e)),
    };
    Ok(KeyCheck { valid, message, models, tested_with: Some(model) })
}

// ---------- Commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    provider: Provider,
    builtin: bool,
    has_key: bool,
    /// Nur Anfang und Ende, nie der ganze Schlüssel.
    key_hint: Option<String>,
    /// vibe, keyring, env
    key_source: Option<&'static str>,
    local: bool,
    key_optional: bool,
    usable: bool,
    exportable: bool,
    models: Vec<String>,
    models_at: u64,
}

fn view(p: Provider) -> ProviderView {
    let key = read_key(&p.id);
    ProviderView {
        builtin: p.is_builtin(),
        has_key: key.is_some(),
        key_hint: key.as_deref().map(crate::credentials::hint),
        key_source: key.as_ref().map(|_| key_source(&p.id)),
        local: p.is_local(),
        key_optional: p.key_optional(),
        usable: key.is_some() || p.key_optional(),
        exportable: p.exportable(),
        models: cached_models(&p.id),
        models_at: cached_at(&p.id),
        provider: p,
    }
}

#[tauri::command]
pub fn providers_list() -> Vec<ProviderView> {
    all().into_iter().map(view).collect()
}

fn slug(name: &str) -> String {
    let mut s: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').chars().take(24).collect::<String>();
    if s.is_empty() { "anbieter".into() } else { s }
}

/// Kopfzeilen, deren Wert ein Geheimnis ist – die gehören ins Schlüsselfeld.
fn secret_header(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "authorization" || n.contains("api-key") || n.contains("apikey") || n.contains("token") || n.contains("secret")
}

/// Legt einen eigenen Anbieter an oder ändert einen (bei festen Anbietern nur
/// Vibe-Freigabe, Preise und Testmodell).
#[tauri::command]
pub async fn provider_save(provider: Provider) -> CmdResult<ProviderView> {
    crate::policy::check_section("providers")?;
    let mut p = provider;
    p.name = p.name.trim().to_string();
    p.base_url = p.base_url.trim().trim_end_matches('/').to_string();
    p.test_model = p.test_model.trim().to_string();
    p.auth_header = p.auth_header.trim().to_string();
    p.headers = p.headers.into_iter().map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).filter(|(k, _)| !k.is_empty()).collect();
    if let Some(h) = p.headers.keys().find(|h| secret_header(h)) {
        return Err(format!("Die Kopfzeile „{h}“ sieht nach einem Geheimnis aus. Den Wert bitte als Schlüssel speichern und „Schlüssel-Kopfzeile“ auf „{h}“ setzen."));
    }
    for price in [p.input_price, p.output_price].into_iter().flatten() {
        if !(0.0..=10_000.0).contains(&price) {
            return Err("Preise in € je Million Tokens zwischen 0 und 10 000.".into());
        }
    }
    let mut stored = load_stored();
    stored.version = stored.version.max(1);
    if let Some(b) = builtin(&p.id) {
        let mut entry = stored.providers.iter().find(|s| s.id == b.id).cloned().unwrap_or_else(|| Provider { id: b.id.clone(), ..Default::default() });
        entry.vibe_export = p.vibe_export && b.exportable();
        entry.vibe_models = p.vibe_models;
        entry.input_price = p.input_price;
        entry.output_price = p.output_price;
        entry.test_model = p.test_model;
        stored.providers.retain(|s| s.id != b.id);
        stored.providers.push(entry);
    } else {
        if p.name.is_empty() {
            return Err("Bitte einen Namen angeben.".into());
        }
        if !(p.base_url.starts_with("http://") || p.base_url.starts_with("https://")) {
            return Err("Die Base-URL muss mit http:// oder https:// beginnen.".into());
        }
        p.kind = COMPATIBLE.into();
        if p.id.trim().is_empty() || !stored.providers.iter().any(|s| s.id == p.id) {
            // Neue ID aus dem Namen, eindeutig und nie wie ein fester Anbieter.
            let base = slug(&p.name);
            let mut id = base.clone();
            let mut n = 2;
            while builtin(&id).is_some() || stored.providers.iter().any(|s| s.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            p.id = id;
        }
        match stored.providers.iter_mut().find(|s| s.id == p.id) {
            Some(s) => *s = p.clone(),
            None => stored.providers.push(p.clone()),
        }
    }
    save_stored(&stored)?;
    let saved = get(&p.id).ok_or("Anbieter nicht gefunden")?;
    if saved.vibe_export || vibe_has(&saved.id) {
        sync_vibe().await?;
    }
    Ok(view(saved))
}

#[tauri::command]
pub async fn provider_delete(id: String) -> CmdResult<()> {
    crate::policy::check_section("providers")?;
    if builtin(&id).is_some() {
        return Err("Feste Anbieter lassen sich nicht löschen – nur ihr Schlüssel.".into());
    }
    let mut stored = load_stored();
    stored.providers.retain(|p| p.id != id);
    save_stored(&stored)?;
    let _ = delete_key(&id);
    if vibe_has(&id) {
        sync_vibe().await?;
    }
    Ok(())
}

fn delete_key(id: &str) -> CmdResult<()> {
    match entry(id).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Prüft und speichert einen Schlüssel (nur bei Erfolg).
#[tauri::command]
pub async fn provider_set_key(id: String, key: String) -> CmdResult<KeyCheck> {
    crate::policy::check_section("providers")?;
    let p = get(&id).ok_or("Unbekannter Anbieter")?;
    let key = key.trim().to_string();
    match id.as_str() {
        MISTRAL => {
            let r = crate::credentials::save_api_key(key).await?;
            let models = if r.valid { list_models(&p, read_key(MISTRAL).as_deref()).await.map(|r| r.1).unwrap_or_default() } else { vec![] };
            if r.valid {
                cache_models(&id, &models);
            }
            return Ok(KeyCheck { valid: r.valid, message: r.message, models, tested_with: None });
        }
        CORTECS => {
            let c = crate::cortecs::cortecs_save_key(key).await?;
            let models = if c.valid { list_models(&p, None).await.map(|r| r.1).unwrap_or_default() } else { vec![] };
            if c.valid {
                cache_models(&id, &models);
            }
            return Ok(KeyCheck { valid: c.valid, message: c.message, models, tested_with: None });
        }
        _ => {}
    }
    if key.len() < 8 || key.contains(char::is_whitespace) {
        return Ok(KeyCheck { valid: false, message: "Das sieht nicht nach einem Schlüssel aus.".into(), models: vec![], tested_with: None });
    }
    let result = check(&p, Some(&key)).await?;
    if result.valid {
        entry(&id).and_then(|e| e.set_password(&key)).map_err(|e| format!("Schlüsselbund nicht verfügbar: {e}"))?;
        cache_models(&id, &result.models);
        if p.vibe_export {
            let _ = sync_vibe().await;
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn provider_delete_key(id: String) -> CmdResult<()> {
    crate::policy::check_section("providers")?;
    match id.as_str() {
        MISTRAL => Err("Den Mistral-Schlüssel teilt Brise mit Vibe – abmelden unter Agenten → Vibe.".into()),
        CORTECS => crate::cortecs::cortecs_delete_key(),
        _ => {
            if from_env(&id).is_some() {
                return Err(format!("Der Schlüssel kommt aus der Umgebungsvariable {} – dort entfernen.", env_var(&id).unwrap_or_default()));
            }
            delete_key(&id)?;
            if vibe_has(&id) {
                let _ = sync_vibe().await;
            }
            Ok(())
        }
    }
}

/// Prüft den gespeicherten Schlüssel (bzw. den lokalen Server ohne Schlüssel).
#[tauri::command]
pub async fn provider_check(id: String) -> CmdResult<KeyCheck> {
    let p = get(&id).ok_or("Unbekannter Anbieter")?;
    let key = read_key(&id);
    if key.is_none() && !p.key_optional() {
        return Err(format!("Kein Schlüssel für {} gespeichert.", p.name));
    }
    let r = check(&p, key.as_deref()).await?;
    if !r.models.is_empty() {
        cache_models(&id, &r.models);
    }
    Ok(r)
}

/// Modellliste eines Anbieters (zwischengespeichert, `refresh` holt neu).
#[tauri::command]
pub async fn provider_models(id: String, refresh: Option<bool>) -> CmdResult<Vec<String>> {
    let p = get(&id).ok_or("Unbekannter Anbieter")?;
    let cached = cached_models(&id);
    if !refresh.unwrap_or(false) && !cached.is_empty() {
        return Ok(cached);
    }
    let (status, models) = list_models(&p, read_key(&id).as_deref()).await?;
    if status >= 400 {
        return Err(format!("{} antwortete mit HTTP {status}.", p.name));
    }
    cache_models(&id, &models);
    Ok(models)
}

/// Kurzer Probeaufruf eines Modells (für „Testen“ in den Einstellungen).
#[tauri::command]
pub async fn provider_test_model(model: String) -> CmdResult<Value> {
    let req = Ask { system: "Antworte in höchstens fünf Wörtern auf Deutsch.", user: "Sag hallo.", json: false, max_tokens: Some(64), temperature: Some(0.2), effort: None, timeout: 60 };
    let r = ask(&model, &req).await?;
    record("assist", "Modelltest", None, &r);
    Ok(json!({ "text": r.text, "ms": r.took.as_millis() as u64, "input": r.input, "output": r.output, "costEur": r.cost_eur(), "model": r.model, "provider": r.provider.id }))
}

/// Modell für eine Funktion, wie das Backend es auflöst (für Anzeige und Tests).
#[tauri::command]
pub fn provider_function_model(purpose: String) -> Option<String> {
    function_model(&purpose)
}

// ---------- Vibe ----------

/// Sitzungs-Token für den Proxy; Vibe bekommt es über `BRISE_PROVIDER_TOKEN`.
pub fn proxy_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let mut b = [0u8; 24];
        let _ = getrandom::fill(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

fn vibe_name(id: &str) -> String {
    format!("{VIBE_PREFIX}{id}")
}

/// Alias eines Modells in Vibe.
pub fn vibe_alias(id: &str, model: &str) -> String {
    let m: String = model.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    format!("{id}-{}", m.trim_matches('-'))
}

/// Steht der Anbieter schon in Vibes config.toml?
fn vibe_has(id: &str) -> bool {
    let name = vibe_name(id);
    let mut found = false;
    let _ = crate::config::edit_config(|doc| {
        found = doc.get("providers").and_then(Item::as_array_of_tables).is_some_and(|a| a.iter().any(|t| t.get("name").and_then(|v| v.as_str()) == Some(name.as_str())));
        Ok(())
    });
    found
}

/// Trägt freigegebene Anbieter samt Modellen in Vibes config.toml ein und
/// entfernt, was nicht mehr freigegeben ist oder keinen Schlüssel mehr hat.
pub async fn sync_vibe() -> CmdResult<bool> {
    let port = crate::cortecs::proxy_port();
    let wanted: Vec<Provider> = all().into_iter().filter(|p| p.vibe_export && p.exportable() && usable(p)).collect();
    if port == 0 && !wanted.is_empty() {
        return Err("Der lokale Proxy läuft nicht – Vibe kann die Anbieter gerade nicht nutzen.".into());
    }
    crate::config::edit_config(|doc| {
        for key in ["providers", "models"] {
            if doc.get(key).is_some_and(|p| !p.is_array_of_tables()) {
                return Err(format!("`{key}` in config.toml hat ein Format, das Brise nicht ändern kann."));
            }
            if !doc.contains_key(key) {
                doc.insert(key, Item::ArrayOfTables(toml_edit::ArrayOfTables::new()));
            }
        }
        let names: Vec<String> = wanted.iter().map(|p| vibe_name(&p.id)).collect();
        let providers = doc["providers"].as_array_of_tables_mut().expect("geprüft");
        providers.retain(|t| t.get("name").and_then(|v| v.as_str()).is_none_or(|n| !n.starts_with(VIBE_PREFIX) || names.iter().any(|w| w == n)));
        for p in &wanted {
            let name = vibe_name(&p.id);
            let entry = json!({
                "name": name,
                "api_base": format!("http://127.0.0.1:{port}/p/{}", p.id),
                "api_key_env_var": TOKEN_ENV,
                "api_style": p.api_style(),
                "backend": "generic",
            });
            let existing = providers.iter().position(|t| t.get("name").and_then(|v| v.as_str()) == Some(name.as_str()));
            match existing.and_then(|i| providers.get_mut(i)) {
                Some(t) => {
                    for (k, v) in entry.as_object().expect("Objekt") {
                        if t.get(k).and_then(|x| x.as_str()) != v.as_str() {
                            t.insert(k, Item::Value(crate::config::json_to_toml(v)?));
                        }
                    }
                }
                None => providers.push(crate::config::json_to_table(&entry)?),
            }
        }
        let models = doc["models"].as_array_of_tables_mut().expect("geprüft");
        models.retain(|t| {
            let Some(prov) = t.get("provider").and_then(|v| v.as_str()) else { return true };
            if !prov.starts_with(VIBE_PREFIX) {
                return true;
            }
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            wanted.iter().any(|p| vibe_name(&p.id) == prov && p.vibe_models.iter().any(|m| m == name))
        });
        for p in &wanted {
            for m in &p.vibe_models {
                let prov = vibe_name(&p.id);
                if models.iter().any(|t| t.get("provider").and_then(|v| v.as_str()) == Some(prov.as_str()) && t.get("name").and_then(|v| v.as_str()) == Some(m.as_str())) {
                    continue;
                }
                let mut e = json!({ "provider": prov, "name": m, "alias": vibe_alias(&p.id, m), "display_name": format!("{m} · {}", p.name) });
                if let (Some(i), Some(o)) = (p.input_price, p.output_price) {
                    e["input_price"] = json!(i);
                    e["output_price"] = json!(o);
                } else if p.is_local() {
                    e["input_price"] = json!(0.0);
                    e["output_price"] = json!(0.0);
                }
                models.push(crate::config::json_to_table(&e)?);
            }
        }
        Ok(())
    })
}

/// Proxy für Vibe (`/p/<id>/…`): prüft das Sitzungs-Token, setzt Schlüssel und
/// Kopfzeilen des Anbieters ein, leitet weiter und bucht den Verbrauch.
pub(crate) async fn forward(sock: &mut tokio::net::TcpStream, req: crate::cortecs::Request) -> Result<(), String> {
    use crate::cortecs::respond;
    let rest = req.path.strip_prefix("/p/").unwrap_or_default();
    let (id, tail) = rest.split_once('/').map(|(a, b)| (a.to_string(), format!("/{b}"))).unwrap_or((rest.to_string(), "/".into()));
    let Some(p) = get(&id).filter(|p| p.vibe_export && p.exportable()) else {
        return respond(sock, 404, r#"{"error":{"message":"Brise: Anbieter nicht für Vibe freigegeben"}}"#).await.map_err(|e| e.to_string());
    };
    let header = |k: &str| req.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let token = header("authorization").and_then(|v| v.strip_prefix("Bearer ")).or(header("x-api-key")).unwrap_or_default();
    if token != proxy_token() {
        return respond(sock, 401, r#"{"error":{"message":"Brise: Dieser Anbieter ist nur aus Brise heraus nutzbar"}}"#).await.map_err(|e| e.to_string());
    }
    let base = p.base_url.trim_end_matches('/');
    // Vibes Anthropic-Adapter hängt `/v1/messages` an, die Basis-URL endet schon auf `/v1`.
    let tail = if base.ends_with("/v1") { tail.strip_prefix("/v1").filter(|t| t.starts_with('/')).unwrap_or(&tail).to_string() } else { tail };
    let model = serde_json::from_slice::<Value>(&req.body).ok().and_then(|v| v["model"].as_str().map(str::to_string)).unwrap_or_default();
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut up = client().request(method, format!("{base}{tail}"));
    for (k, v) in &req.headers {
        if matches!(k.as_str(), "content-type" | "accept" | "user-agent" | "anthropic-beta") {
            up = up.header(k, v);
        }
    }
    up = authorize(up, &p, read_key(&p.id).as_deref());
    let started = Instant::now();
    let mut resp = match up.body(req.body).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = json!({ "error": { "message": format!("{} nicht erreichbar: {e}", p.name) } }).to_string();
            return respond(sock, 502, &msg).await.map_err(|e| e.to_string());
        }
    };
    let status = resp.status();
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    let head = format!("HTTP/1.1 {} {}\r\nContent-Type: {ctype}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    sock.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut meter = crate::cortecs::UsageScanner::default();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        meter.feed(&chunk);
        if sock.write_all(&chunk).await.is_err() {
            break;
        }
    }
    let _ = sock.flush().await;
    let _ = sock.shutdown().await;
    let first = meter.first;
    if status.is_success() && (tail.ends_with("/chat/completions") || tail.ends_with("/messages")) {
        if let Some(u) = meter.finish() {
            let mut rec = crate::usage::Record::new("chat", "Chat (Vibe)", &model).backend("vibe");
            rec.input = u["prompt_tokens"].as_u64().or(u["input_tokens"].as_u64()).unwrap_or(0);
            rec.output = u["completion_tokens"].as_u64().or(u["output_tokens"].as_u64()).unwrap_or(0);
            rec.cached = u["prompt_tokens_details"]["cached_tokens"].as_u64().or(u["cache_read_input_tokens"].as_u64()).unwrap_or(0);
            tag_record(&mut rec, &p);
            crate::usage::record(rec.timed(started, first));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(base: &str) -> Provider {
        Provider { id: "x".into(), kind: COMPATIBLE.into(), name: "X".into(), base_url: base.into(), ..Default::default() }
    }

    #[test]
    fn lokal_erkannt() {
        assert!(custom("http://localhost:11434/v1").is_local());
        assert!(custom("http://127.0.0.1:1234/v1").is_local());
        assert!(custom("http://192.168.178.10:8000/v1").is_local());
        assert!(custom("http://172.20.0.2/v1").is_local());
        assert!(custom("http://[::1]:8080/v1").is_local());
        assert!(!custom("https://openrouter.ai/api/v1").is_local());
        assert!(!custom("http://172.40.0.2/v1").is_local());
        assert!(custom("http://localhost:11434/v1").key_optional());
    }

    #[test]
    fn modellangaben() {
        // Ohne bekanntes Präfix: Mistral (alte Einstellungen), Schrägstriche im Namen bleiben.
        let (p, m) = split_ref("mistral-large-4");
        assert_eq!((p.id.as_str(), m.as_str()), (MISTRAL, "mistral-large-4"));
        let (p, m) = split_ref("openai/gpt-4.1-mini");
        assert_eq!((p.id.as_str(), m.as_str()), (OPENAI, "gpt-4.1-mini"));
        let (p, m) = split_ref("cortecs/clef-flash");
        assert_eq!((p.id.as_str(), m.as_str()), (CORTECS, "clef-flash"));
        let (p, _) = split_ref("ft:open-mistral-7b:abc");
        assert_eq!(p.id, MISTRAL);
        assert_eq!(canonical("mistral-small-latest"), "mistral/mistral-small-latest");
        assert!(is_zdr("cortecs/glm-5.3"));
        assert!(!is_zdr("mistral-small-latest"));
    }

    #[test]
    fn parameter_anpassen() {
        let mut b = json!({ "model": "gpt-5", "max_tokens": 16, "temperature": 0.2 });
        assert!(adapt(&mut b, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."));
        assert_eq!(b["max_completion_tokens"], 16);
        assert!(adapt(&mut b, "Unsupported value: 'temperature' does not support 0.2"));
        assert!(b.get("temperature").is_none());
        assert!(!adapt(&mut b, "something else"));
        let mut b = json!({ "response_format": { "type": "json_object" } });
        assert!(adapt(&mut b, "JSON mode is not supported"));
    }

    #[test]
    fn testmodell_klein_bevorzugt() {
        let p = custom("https://example.org/v1");
        let models: Vec<String> = ["text-embedding-3-small", "gpt-4.1", "gpt-4.1-mini", "whisper-1"].iter().map(|s| s.to_string()).collect();
        assert_eq!(test_model_for(&p, &models).as_deref(), Some("gpt-4.1-mini"));
        let p = Provider { test_model: "llama3".into(), ..custom("http://localhost:11434/v1") };
        assert_eq!(test_model_for(&p, &models).as_deref(), Some("llama3"));
        assert_eq!(test_model_for(&custom("http://x/v1"), &[]), None);
    }

    #[test]
    fn geheime_kopfzeilen() {
        assert!(secret_header("Authorization"));
        assert!(secret_header("api-key"));
        assert!(secret_header("X-Api-Key"));
        assert!(!secret_header("HTTP-Referer"));
        assert!(!secret_header("X-Title"));
    }

    #[test]
    fn json_mit_vorrede() {
        assert_eq!(parse_json("Hier:\n```json\n{\"a\":1}\n```").unwrap()["a"], 1);
        assert!(parse_json("kein json").is_none());
        assert_eq!(slug("LM Studio (lokal)"), "lm-studio-lokal");
        assert_eq!(vibe_alias("ollama", "qwen3:8b"), "ollama-qwen3-8b");
    }
}
