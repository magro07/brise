//! Verbrauchs-Journal für die Nutzungsanzeige. Mistral liefert weder über
//! Vibe (`/whoami` kennt nur den Plan) noch über die API Verbrauch oder Limit,
//! deshalb protokolliert Brise jeden Vorgang selbst in
//! `<Datenordner>/usage/YYYY-MM.jsonl` (UTC-Monat) und rechnet mit einer
//! mitgelieferten, änderbaren Preistabelle. Alle Beträge sind Schätzungen.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const DEFAULT_PRICES: &str = include_str!("../resources/prices.json");

/// Schützt Journal, Sitzungsstände und Einstellungen vor gleichzeitigem Schreiben.
static LOCK: Mutex<()> = Mutex::new(());

fn dir() -> PathBuf {
    data_dir().join("usage")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Jahr und Monat (UTC) eines Zeitstempels, ohne Datumsbibliothek.
fn year_month(ms: u64) -> (i64, u32) {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month)
}

fn journal_path(ms: u64) -> PathBuf {
    let (y, m) = year_month(ms);
    dir().join(format!("{y:04}-{m:02}.jsonl"))
}

// ---------- Einträge ----------

fn is_zero(n: &u64) -> bool {
    *n == 0
}

fn is_zero_f(n: &f64) -> bool {
    *n == 0.0
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    pub ts: u64,
    /// chat, assist, embed, ocr, fim, stt, tts, search
    pub kind: String,
    /// Funktion für die Aufschlüsselung, z. B. „Chat“, „Einstufung“, „Index“.
    pub feature: String,
    pub model: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub input: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub cached: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub output: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub pages: u64,
    #[serde(skip_serializing_if = "is_zero_f")]
    pub minutes: f64,
    #[serde(skip_serializing_if = "is_zero")]
    pub chars: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub calls: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Subagents, die in diesem Turn liefen (ihre Tokens stecken in der Summe).
    #[serde(skip_serializing_if = "is_zero")]
    pub subagents: u64,
    /// Turns und Werkzeugaufrufe (nur bei Vibe-Turns).
    #[serde(skip_serializing_if = "is_zero")]
    pub turns: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub tool_calls: u64,
    /// Menge selbst geschätzt (z. B. Audiodauer), nicht von der API gemeldet.
    #[serde(skip_serializing_if = "is_false")]
    pub estimated: bool,
    /// Kennung des Mistral-Zugangs (Fingerabdruck, nie der Schlüssel).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Wer den Aufruf gemacht hat: `vibe`, `brise` (direkt an die API), später weitere.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub backend: String,
    /// Anbieter, falls nicht Mistral (z. B. `cortecs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Vom Anbieter gemeldete Kosten in € – haben Vorrang vor der Preistabelle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_eur: Option<f64>,
    /// Leistung: Gesamtdauer des Aufrufs bzw. Turns (`ms` = altes Cortecs-Feld).
    #[serde(skip_serializing_if = "Option::is_none", alias = "ms")]
    pub duration_ms: Option<u64>,
    /// Zeit vom Absenden bis zum ersten Token – nur bei gestreamten Antworten bekannt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    /// Output-Tokens je Sekunde Generierungszeit (ab dem ersten Token, ohne Stream die ganze Dauer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tps: Option<f64>,
}

impl Record {
    pub fn new(kind: &str, feature: &str, model: &str) -> Self {
        Record { ts: now_ms(), kind: kind.into(), feature: feature.into(), model: model.into(), account: account_id(), backend: "brise".into(), ..Default::default() }
    }

    pub fn backend(mut self, backend: &str) -> Self {
        self.backend = backend.into();
        self
    }

    pub fn project(mut self, cwd: Option<&str>) -> Self {
        self.project = cwd.filter(|c| !c.is_empty()).map(str::to_string);
        self
    }

    /// Übernimmt `usage` einer Mistral-Antwort (Chat, FIM, Embeddings).
    pub fn tokens(mut self, body: &Value) -> Self {
        let u = &body["usage"];
        self.input = u["prompt_tokens"].as_u64().unwrap_or(0);
        self.output = u["completion_tokens"].as_u64().unwrap_or(0);
        self.cached = u["prompt_tokens_details"]["cached_tokens"].as_u64().or(u["cached_tokens"].as_u64()).unwrap_or(0);
        self
    }

    /// Misst einen Aufruf bis jetzt: `started` beim Absenden, `first` beim ersten
    /// Token (nur bei Streams). Nach `tokens()` aufrufen, weil t/s die Ausgabe braucht.
    pub fn timed(self, started: Instant, first: Option<Instant>) -> Self {
        let end = Instant::now();
        let generation = end.duration_since(first.unwrap_or(started));
        self.perf(end.duration_since(started), first.map(|f| f.duration_since(started)), generation)
    }

    pub fn perf(mut self, duration: Duration, ttft: Option<Duration>, generation: Duration) -> Self {
        self.duration_ms = Some(duration.as_millis() as u64);
        self.ttft_ms = ttft.map(|t| t.as_millis() as u64);
        self.output_tps = tokens_per_second(self.output, generation);
        self
    }
}

/// Unter 50 ms Generierungszeit ist die Rate nur Rauschen.
pub fn tokens_per_second(output: u64, generation: Duration) -> Option<f64> {
    let secs = generation.as_secs_f64();
    (output > 0 && secs >= 0.05).then(|| (output as f64 / secs * 10.0).round() / 10.0)
}

/// Fingerabdruck des aktuellen Schlüssels (`key-` + 8 Hex-Zeichen von SHA-256).
/// Kurz zwischengespeichert, damit nicht jeder Eintrag den Schlüsselbund fragt.
pub fn account_id() -> Option<String> {
    static CACHE: Mutex<Option<(std::time::Instant, Option<String>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, id)) = cache.as_ref() {
        if at.elapsed().as_secs() < 300 {
            return id.clone();
        }
    }
    use sha2::Digest;
    let id = crate::credentials::read_key().map(|k| {
        let hash = sha2::Sha256::digest(k.as_bytes());
        format!("key-{}", hash.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>())
    });
    *cache = Some((std::time::Instant::now(), id.clone()));
    id
}

fn append(rec: &Record) -> CmdResult<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_string(rec).map_err(|e| e.to_string())?;
    line.push('\n');
    // Eine Zeile pro write mit O_APPEND – auch der MCP-Suchprozess schreibt hierher.
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_path(rec.ts))
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())
}

/// Für Brises eigene API-Aufrufe: Fehler beim Protokollieren stören nie den Aufruf.
pub fn record(rec: Record) {
    if rec.input + rec.output + rec.pages + rec.chars + rec.calls == 0 && rec.minutes == 0.0 {
        return;
    }
    if let Err(e) = append(&rec) {
        eprintln!("Nutzungsjournal: {e}");
    }
}

/// Monatsdateien, die den Zeitraum berühren (ein Tag Puffer wegen UTC).
fn read_range(from: u64, to: u64) -> Vec<Record> {
    let first = year_month(from.saturating_sub(86_400_000));
    let last = year_month(to.saturating_add(86_400_000));
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let Some(name) = p.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")) else { return false };
            let Some((y, m)) = name.split_once('-') else { return false };
            let (Ok(y), Ok(m)) = (y.parse::<i64>(), m.parse::<u32>()) else { return false };
            (y, m) >= first && (y, m) <= last
        })
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .flat_map(|text| text.lines().filter_map(|l| serde_json::from_str::<Record>(l).ok()).collect::<Vec<_>>())
        .filter(|r| r.ts >= from && r.ts <= to)
        .collect()
}

// ---------- Preise ----------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Price {
    pub id: String,
    pub label: String,
    #[serde(rename = "match")]
    pub patterns: Vec<String>,
    pub input: f64,
    pub cached: f64,
    pub output: f64,
    pub per_page: f64,
    pub per_minute: f64,
    pub per_million_chars: f64,
    pub per_call: f64,
    /// Abweichende Währung nur für diesen Eintrag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hinweis: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PriceTable {
    pub stand: String,
    pub quelle: String,
    pub currency: String,
    pub usd_to_eur: f64,
    pub models: Vec<Price>,
}

fn prices_path() -> PathBuf {
    dir().join("prices.json")
}

fn default_prices() -> PriceTable {
    serde_json::from_str(DEFAULT_PRICES).expect("prices.json ist gültig")
}

/// Eigene Tabelle aus den Einstellungen, sonst die mitgelieferte.
fn load_prices() -> (PriceTable, bool) {
    match std::fs::read(prices_path()).ok().and_then(|b| serde_json::from_slice::<PriceTable>(&b).ok()) {
        Some(t) => (t, true),
        None => (default_prices(), false),
    }
}

/// Vibe-Aliasse (`glm-5-3`) auf Modellnamen (`zai-glm-5-3`) abbilden.
fn alias_names() -> HashMap<String, String> {
    let Some(path) = crate::config::vibe_home().map(|h| h.join("config.toml")) else { return HashMap::new() };
    let Ok(doc) = std::fs::read_to_string(path).unwrap_or_default().parse::<toml::Table>() else { return HashMap::new() };
    doc.get("models")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m.get("alias")?.as_str()?.to_lowercase(), m.get("name")?.as_str()?.to_lowercase())))
        .collect()
}

struct Pricer {
    table: PriceTable,
    aliases: HashMap<String, String>,
}

impl Pricer {
    fn new() -> Self {
        Pricer { table: load_prices().0, aliases: alias_names() }
    }

    /// Längstes passendes Muster gewinnt (GLM-5.3 Flash vor GLM-5.3).
    fn find(&self, model: &str) -> Option<&Price> {
        let m = model.to_lowercase();
        let name = self.aliases.get(&m).cloned().unwrap_or(m.clone());
        let mut best: Option<(&Price, usize)> = None;
        for p in &self.table.models {
            for pat in &p.patterns {
                let pat = pat.to_lowercase();
                if (name.contains(&pat) || m.contains(&pat)) && best.is_none_or(|(_, len)| pat.len() > len) {
                    best = Some((p, pat.len()));
                }
            }
        }
        best.map(|(p, _)| p)
    }

    fn factor(&self, p: &Price) -> f64 {
        let currency = p.currency.as_deref().unwrap_or(&self.table.currency);
        if currency.eq_ignore_ascii_case("USD") {
            self.table.usd_to_eur
        } else {
            1.0
        }
    }

    /// (Kosten in €, Cache-Ersparnis in €, Preis bekannt)
    fn cost(&self, r: &Record) -> (f64, f64, bool) {
        if let Some(eur) = r.cost_eur {
            return (eur, 0.0, true);
        }
        let Some(p) = self.find(&r.model) else { return (0.0, 0.0, false) };
        let f = self.factor(p);
        let cached = r.cached.min(r.input) as f64;
        let fresh = r.input as f64 - cached;
        let tokens = (fresh * p.input + cached * p.cached + r.output as f64 * p.output) / 1e6;
        let other = r.pages as f64 * p.per_page + r.minutes * p.per_minute + r.chars as f64 * p.per_million_chars / 1e6 + r.calls as f64 * p.per_call;
        let saving = cached * (p.input - p.cached).max(0.0) / 1e6;
        ((tokens + other) * f, saving * f, true)
    }
}

// ---------- Vibe-Turns ----------

/// Vibe meldet kumulierte Summen je Session. Brise merkt sich den letzten
/// Stand und bucht nur die Differenz – auch über Neustarts hinweg.
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
#[serde(default)]
struct Totals {
    input: u64,
    cached: u64,
    output: u64,
    /// Stand, als Brise die Session zum ersten Mal sah (Verbrauch davor = Import).
    first: Option<[u64; 3]>,
    /// Verlauf aus Vibes Session-Logs schon übernommen.
    imported: bool,
}

fn totals_path() -> PathBuf {
    dir().join("sessions.json")
}

fn load_totals() -> HashMap<String, Totals> {
    std::fs::read(totals_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_totals(map: &HashMap<String, Totals>) -> CmdResult<()> {
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    std::fs::write(totals_path(), serde_json::to_vec(map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnReport {
    session: String,
    project: Option<String>,
    title: Option<String>,
    model: String,
    /// Kumulierte Summen der Session laut Vibe.
    input: u64,
    cached: u64,
    output: u64,
    subagents: Option<u64>,
    web_searches: Option<u64>,
    tool_calls: Option<u64>,
    /// Agent-Backend der Session (vibe, claude, …).
    backend: Option<String>,
    /// Messung in der Oberfläche: Senden bis erster Chunk, ganzer Turn und die
    /// Zeit, in der das Modell tatsächlich Text bzw. Werkzeugaufrufe erzeugte.
    ttft_ms: Option<u64>,
    duration_ms: Option<u64>,
    generation_ms: Option<u64>,
}

/// Stand vor dem ersten Turn merken, damit geladene Sessions ihren alten
/// Verbrauch nicht noch einmal verbuchen. Überschreibt nichts Vorhandenes.
#[tauri::command]
pub fn usage_baseline(session: String, input: u64, cached: u64, output: u64) -> CmdResult<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_totals();
    if map.contains_key(&session) {
        return Ok(());
    }
    map.insert(session, Totals { input, cached, output, first: Some([input, cached, output]), imported: false });
    save_totals(&map)
}

#[tauri::command]
pub fn usage_turn(report: TurnReport) -> CmdResult<Value> {
    let delta = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load_totals();
        let prev = map.get(&report.session).copied().unwrap_or(Totals { first: Some([0; 3]), ..Default::default() });
        // Kleiner als zuvor: Vibe hat neu gezählt (z. B. neu gestartet ohne Übernahme).
        let reset = report.input < prev.input || report.output < prev.output;
        let base = if reset { Totals::default() } else { prev };
        let delta = Totals {
            input: report.input - base.input,
            cached: report.cached.saturating_sub(base.cached),
            output: report.output - base.output,
            ..Default::default()
        };
        map.insert(report.session.clone(), Totals { input: report.input, cached: report.cached, output: report.output, ..prev });
        save_totals(&map)?;
        delta
    };
    let output_tps = report.generation_ms.and_then(|g| tokens_per_second(delta.output, Duration::from_millis(g)));
    // Turns über Cortecs-Modelle erfasst cortecs.rs selbst (mit exakten Kosten und Messwerten je Aufruf).
    if report.model.starts_with("cortecs") {
        return Ok(json!({ "input": delta.input, "cached": delta.cached, "output": delta.output, "costEur": 0.0, "viaCortecs": true, "outputTps": output_tps }));
    }
    let subagents = report.subagents.unwrap_or(0);
    let backend = report.backend.as_deref().filter(|b| !b.is_empty()).unwrap_or("vibe");
    let mut rec = Record::new("chat", if subagents > 0 { "Chat mit Subagents" } else { "Chat" }, &report.model).project(report.project.as_deref()).backend(backend);
    rec.ttft_ms = report.ttft_ms;
    rec.duration_ms = report.duration_ms;
    rec.output_tps = output_tps;
    rec.turns = 1;
    rec.tool_calls = report.tool_calls.unwrap_or(0);
    rec.session = Some(report.session.clone());
    rec.title = report.title.clone();
    rec.input = delta.input;
    rec.cached = delta.cached.min(delta.input);
    rec.output = delta.output;
    rec.subagents = subagents;
    let pricer = Pricer::new();
    let cost = pricer.cost(&rec).0;
    record(rec);
    if let Some(n) = report.web_searches.filter(|n| *n > 0) {
        let mut s = Record::new("search", "Websuche", "web_search").project(report.project.as_deref()).backend("vibe");
        s.session = Some(report.session);
        s.title = report.title;
        s.calls = n;
        s.estimated = true;
        record(s);
    }
    Ok(json!({ "input": delta.input, "cached": delta.cached, "output": delta.output, "costEur": cost, "outputTps": output_tps }))
}

/// Sonstige Vorgänge aus der Oberfläche (Spracheingabe, Vorlesen).
#[tauri::command]
pub fn usage_record(mut entry: Record) -> CmdResult<()> {
    entry.ts = now_ms();
    if entry.account.is_none() {
        entry.account = account_id();
    }
    record(entry);
    Ok(())
}

// ---------- Einstellungen ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub budget_eur: f64,
    pub warn_at: Vec<u32>,
    /// Ab `avoid_at` Prozent wählt Auto kleinere Modelle.
    pub avoid_expensive: bool,
    pub avoid_at: u32,
    /// Stand laut Mistral-Console: Betrag und Zeitpunkt der Ablesung.
    pub console_eur: Option<f64>,
    pub console_at: Option<u64>,
    /// Schon gezeigte Warnstufen je Monat, z. B. {"2026-10": [50, 80]}.
    pub warned: HashMap<String, Vec<u32>>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { budget_eur: 255.0, warn_at: vec![50, 80, 95], avoid_expensive: false, avoid_at: 95, console_eur: None, console_at: None, warned: HashMap::new() }
    }
}

fn settings_path() -> PathBuf {
    dir().join("settings.json")
}

fn load_settings() -> Settings {
    std::fs::read(settings_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn usage_save_settings(settings: Settings) -> CmdResult<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usage_prices() -> Value {
    let (table, custom) = load_prices();
    json!({ "table": table, "custom": custom, "defaultStand": default_prices().stand })
}

/// `None` stellt die mitgelieferte Tabelle wieder her.
#[tauri::command]
pub fn usage_save_prices(table: Option<PriceTable>) -> CmdResult<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match table {
        Some(t) => {
            std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
            std::fs::write(prices_path(), serde_json::to_vec_pretty(&t).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        None => match std::fs::remove_file(prices_path()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    }
}

// ---------- Auswertung ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Priced {
    #[serde(flatten)]
    rec: Record,
    cost: f64,
    saving: f64,
    priced: bool,
    label: String,
}

/// Alle Einträge im Zeitraum mit Kosten nach aktueller Preistabelle.
/// Die Oberfläche fasst sie nach Tag, Modell, Projekt usw. zusammen.
#[tauri::command]
pub fn usage_overview(from: u64, to: u64) -> Value {
    let pricer = Pricer::new();
    let records: Vec<Priced> = read_range(from, to)
        .into_iter()
        .map(|rec| {
            let (cost, saving, priced) = pricer.cost(&rec);
            let label = pricer.find(&rec.model).map(|p| p.label.clone()).unwrap_or_else(|| rec.model.clone());
            Priced { rec, cost, saving, priced, label }
        })
        .collect();
    json!({
        "records": records,
        "settings": load_settings(),
        "pricesStand": pricer.table.stand,
        "journalDir": dir().display().to_string(),
    })
}

/// Preise (€ pro Mio. Tokens) für die Modelle der Auswahl – für „teure Modelle meiden“.
#[tauri::command]
pub fn usage_model_prices(models: Vec<String>) -> Value {
    let pricer = Pricer::new();
    let out: serde_json::Map<String, Value> = models
        .into_iter()
        .filter_map(|m| {
            let p = pricer.find(&m)?;
            let f = pricer.factor(p);
            Some((m, json!({ "input": p.input * f, "output": p.output * f, "label": p.label })))
        })
        .collect();
    Value::Object(out)
}

// ---------- Import aus Vibes Session-Logs ----------

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-10-02T12:14:46.031553+00:00` → Millisekunden (Zeitzone beachtet).
fn parse_iso(s: &str) -> Option<u64> {
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let days = days_from_civil(n(0, 4)?, n(5, 7)? as u32, n(8, 10)? as u32);
    let mut secs = days * 86_400 + n(11, 13)? * 3600 + n(14, 16)? * 60 + n(17, 19)?;
    if let Some(pos) = s[19..].find(['+', '-']).map(|p| p + 19) {
        let sign = if &s[pos..pos + 1] == "-" { -1 } else { 1 };
        secs -= sign * (n(pos + 1, pos + 3)? * 3600 + n(pos + 4, pos + 6)? * 60);
    }
    u64::try_from(secs * 1000).ok()
}

struct VibeSession {
    id: String,
    parent: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    updated: u64,
    totals: [u64; 3],
    tool_calls: u64,
    /// Ordner, um das Modell erst bei Bedarf zu lesen.
    runtime: Option<PathBuf>,
}

fn read_json(p: &std::path::Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn vibe_sessions() -> Vec<VibeSession> {
    let Some(root) = crate::config::vibe_home().map(|h| h.join("logs").join("session")) else { return vec![] };
    let mut out = Vec::new();
    // Vibe 3: unified/<id>/CURRENT → generations/<gen>/projection-state.json
    for dir in std::fs::read_dir(root.join("unified")).into_iter().flatten().flatten().map(|e| e.path()) {
        let Some(generation) = read_json(&dir.join("CURRENT")).and_then(|c| c["generation"].as_str().map(str::to_string)) else { continue };
        let gdir = dir.join("generations").join(generation);
        let Some(state) = read_json(&gdir.join("projection-state.json")) else { continue };
        let s = &state["snapshot"]["session"];
        let u = &s["tokenUsage"];
        let meta = read_json(&dir.join("meta.json")).unwrap_or_default();
        let Some(id) = s["id"].as_str() else { continue };
        out.push(VibeSession {
            id: id.into(),
            parent: s["parentSessionId"].as_str().map(str::to_string),
            cwd: meta["environment"]["working_directory"].as_str().map(str::to_string),
            // Ohne Titel die Vorschau der ersten Nachricht, gekürzt.
            title: s["title"].as_str().or(meta["title"].as_str()).map(str::to_string).or_else(|| s["preview"].as_str().map(|p| p.chars().take(60).collect())),
            updated: s["updatedAt"].as_u64().unwrap_or(0),
            totals: [u["inputTokens"].as_u64().unwrap_or(0), u["cachedInputTokens"].as_u64().unwrap_or(0), u["outputTokens"].as_u64().unwrap_or(0)],
            tool_calls: 0,
            runtime: Some(gdir.join("runtime-state.json")),
        });
    }
    // Älteres Format: session_<datum>_<id>/meta.json mit `stats`.
    for dir in std::fs::read_dir(&root).into_iter().flatten().flatten().map(|e| e.path()) {
        if !dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("session_")) {
            continue;
        }
        let Some(meta) = read_json(&dir.join("meta.json")) else { continue };
        let (Some(id), st) = (meta["session_id"].as_str(), &meta["stats"]) else { continue };
        out.push(VibeSession {
            id: id.into(),
            parent: meta["parent_session_id"].as_str().map(str::to_string),
            cwd: meta["environment"]["working_directory"].as_str().map(str::to_string),
            title: meta["title"].as_str().map(str::to_string),
            updated: meta["end_time"].as_str().or(meta["start_time"].as_str()).and_then(parse_iso).unwrap_or(0),
            totals: [
                st["session_prompt_tokens"].as_u64().unwrap_or(0),
                st["session_cached_tokens"].as_u64().unwrap_or(0),
                st["session_completion_tokens"].as_u64().unwrap_or(0),
            ],
            tool_calls: st["tool_calls_succeeded"].as_u64().unwrap_or(0) + st["tool_calls_failed"].as_u64().unwrap_or(0),
            runtime: None,
        });
    }
    out
}

/// Vibe speichert kein Modell je Aufruf; das zuletzt aktive Modell der Session
/// oder sonst `active_model` aus der config.toml gilt für den ganzen Verbrauch.
fn session_model(v: &VibeSession, fallback: &str) -> String {
    v.runtime
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| {
            let rest = &text[text.find("\"active_model\":\"")? + 16..];
            Some(rest[..rest.find('"')?].to_string())
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// Übernimmt den Verlauf aus Vibes Session-Logs, einmal je Session: alles vor
/// Brises erstem Blick auf die Session. Spätere Zuwächse, die nicht über Brise
/// liefen (Vibe-CLI, IDE), bucht der Abgleich als „Vibe außerhalb von Brise“.
/// `skip`: Sessions, deren Turn in Brise gerade läuft.
#[tauri::command]
pub async fn usage_import(skip: Vec<String>) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || import_blocking(&skip)).await.map_err(|e| e.to_string())?
}

fn import_blocking(skip: &[String]) -> CmdResult<Value> {
    let sessions = vibe_sessions();
    let fallback = crate::config::vibe_home()
        .and_then(|h| std::fs::read_to_string(h.join("config.toml")).ok())
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| t.get("active_model")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "mistral-medium-3.5".into());
    let mut pending: Vec<(Record, Option<PathBuf>)> = Vec::new();
    let (mut imported, mut synced) = (0, 0);
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load_totals();
        for v in &sessions {
            if skip.contains(&v.id) || v.totals == [0; 3] {
                continue;
            }
            let entry = map.get(&v.id).copied();
            let (amount, feature) = match entry {
                None => (v.totals, if v.parent.is_some() { "Subagents (Import)" } else { "Chat (Import)" }),
                Some(e) if !e.imported => (e.first.unwrap_or([0; 3]), if v.parent.is_some() { "Subagents (Import)" } else { "Chat (Import)" }),
                Some(e) if v.totals[0] > e.input && v.totals[2] >= e.output => {
                    ([v.totals[0] - e.input, v.totals[1].saturating_sub(e.cached), v.totals[2] - e.output], "Vibe außerhalb von Brise")
                }
                Some(_) => continue,
            };
            let next = match entry {
                Some(e) if e.imported || e.input > v.totals[0] => Totals { input: e.input.max(v.totals[0]), cached: e.cached.max(v.totals[1]), output: e.output.max(v.totals[2]), ..e },
                Some(e) => Totals { imported: true, ..e },
                None => Totals { input: v.totals[0], cached: v.totals[1], output: v.totals[2], first: Some(v.totals), imported: true },
            };
            if entry.is_some_and(|e| e.imported) {
                synced += 1;
            } else {
                imported += 1;
            }
            map.insert(v.id.clone(), Totals { imported: true, ..next });
            if amount == [0; 3] {
                continue;
            }
            let mut rec = Record { ts: v.updated, kind: "chat".into(), feature: feature.into(), backend: "vibe".into(), estimated: true, ..Default::default() };
            rec.project = v.cwd.clone();
            rec.session = Some(v.parent.clone().unwrap_or_else(|| v.id.clone()));
            rec.title = v.title.clone();
            rec.subagents = u64::from(v.parent.is_some());
            rec.tool_calls = if entry.is_none() { v.tool_calls } else { 0 };
            [rec.input, rec.cached, rec.output] = amount;
            rec.cached = rec.cached.min(rec.input);
            pending.push((rec, v.runtime.clone()));
        }
        save_totals(&map)?;
    }
    let count = pending.len();
    for (mut rec, runtime) in pending {
        let v = VibeSession { id: String::new(), parent: None, cwd: None, title: None, updated: 0, totals: [0; 3], tool_calls: 0, runtime };
        rec.model = session_model(&v, &fallback);
        record(rec);
    }
    Ok(json!({ "sessions": sessions.len(), "imported": imported, "synced": synced, "records": count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months() {
        assert_eq!(year_month(0), (1970, 1));
        // 2026-10-31T23:59:59Z und 2026-11-01T00:00:00Z
        assert_eq!(year_month(1_793_491_199_000), (2026, 10));
        assert_eq!(year_month(1_793_491_200_000), (2026, 11));
        assert_eq!(year_month(1_709_164_800_000), (2024, 2)); // 29.02.2024
        assert_eq!(parse_iso("2026-11-01T00:00:00+00:00"), Some(1_793_491_200_000));
        assert_eq!(parse_iso("2026-11-01T01:30:00.123+01:30"), Some(1_793_491_200_000));
    }

    #[test]
    fn matching() {
        let pricer = Pricer { table: default_prices(), aliases: HashMap::new() };
        let id = |m: &str| pricer.find(m).map(|p| p.id.clone()).unwrap_or_default();
        assert_eq!(id("glm-5-3"), "glm-5-3");
        assert_eq!(id("zai-glm-5-3-flash"), "glm-5-3-flash");
        assert_eq!(id("mistral-small-latest"), "mistral-small-4");
        assert_eq!(id("codestral-latest"), "codestral");
        assert_eq!(id("codestral-embed"), "codestral-embed");
        assert_eq!(id("mistral-ocr-latest"), "mistral-ocr");
        assert_eq!(id("voxtral-mini-transcribe-realtime-2602"), "voxtral-realtime");
        assert_eq!(id("voxtral-mini-tts-latest"), "voxtral-tts");
        let mut r = Record::new("chat", "Chat", "mistral-medium-3.5");
        r.input = 1_000_000;
        r.cached = 400_000;
        r.output = 100_000;
        let (cost, saving, priced) = pricer.cost(&r);
        assert!(priced);
        assert!((cost - (0.6 * 1.275 + 0.4 * 0.1275 + 0.1 * 6.375)).abs() < 1e-9);
        assert!((saving - 0.4 * (1.275 - 0.1275)).abs() < 1e-9);
    }

    #[test]
    fn performance_fields() {
        // Alte Einträge ohne Messwerte und alte Cortecs-Einträge mit `ms` bleiben lesbar.
        let old: Record = serde_json::from_str(r#"{"ts":1,"kind":"chat","feature":"Chat","model":"m","input":5}"#).unwrap();
        assert!(old.duration_ms.is_none() && old.ttft_ms.is_none() && old.output_tps.is_none());
        let cortecs: Record = serde_json::from_str(r#"{"ts":1,"kind":"assist","feature":"x","model":"cortecs/m","provider":"cortecs","calls":1,"costEur":0.1,"ms":840}"#).unwrap();
        assert_eq!(cortecs.duration_ms, Some(840));
        let mut r = Record::new("assist", "Test", "m");
        r.output = 200;
        let r = r.perf(Duration::from_millis(2500), Some(Duration::from_millis(500)), Duration::from_secs(2));
        assert_eq!((r.duration_ms, r.ttft_ms, r.output_tps), (Some(2500), Some(500), Some(100.0)));
        let line = serde_json::to_string(&r).unwrap();
        assert!(line.contains(r#""ttftMs":500"#) && line.contains(r#""outputTps":100.0"#) && line.contains(r#""durationMs":2500"#));
        assert_eq!(tokens_per_second(0, Duration::from_secs(1)), None);
        assert_eq!(tokens_per_second(10, Duration::from_millis(10)), None);
    }
}
