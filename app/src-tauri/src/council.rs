//! Model Council: Der Agent fragt andere Modelle um Rat – Code-Review,
//! Fehlersuche, Schlussprüfung. Mehrere Modelle urteilen unabhängig und
//! parallel, ein Vorsitz-Modell führt die Urteile zusammen (ersatzweise
//! gruppiert Brise selbst). Konzept: `docs/adr/0003-model-council.md`.
//!
//! `brise --mcp-council <ordner>` bietet das als MCP-Server an. Läufe liegen
//! vollständig unter `<Datenordner>/council/runs/<id>.json` (für die Karte im
//! Chat), Kosten pro Tag in `council/journal.jsonl`.

use std::collections::BTreeSet;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::credentials::{read_key, API_BASE};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

/// Grenze für Diff und Dateien zusammen (~35 000 Tokens).
const MAX_CONTEXT_CHARS: usize = 120_000;
/// Einzelne Datei höchstens so lang (danach gekürzt).
const MAX_FILE_CHARS: usize = 40_000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Der Vorsitz sieht weniger Kontext, dafür alle Urteile.
const CHAIR_CONTEXT_CHARS: usize = 60_000;
/// Vibe bricht MCP-Aufrufe nach 60 s ab; so lange wartet ein Aufruf höchstens,
/// danach läuft das Council weiter und `council_result` holt das Ergebnis.
const WAIT_SECS: u64 = 50;

// ---------- Einstellungen ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct CouncilConfig {
    /// "auto" (Agent fragt von sich aus), "request" (nur auf Wunsch), "off"
    pub mode: String,
    pub review: Vec<String>,
    pub debug: Vec<String>,
    pub verify: Vec<String>,
    /// Modell, das die Urteile zusammenführt; leer = Brise gruppiert selbst.
    pub chair: String,
    /// Anzahl unabhängiger Meinungen (1–5).
    pub opinions: usize,
    /// Tageslimit in Euro, 0 = ohne Limit.
    pub daily_limit_eur: f64,
    /// Zeitlimit je Modellaufruf in Sekunden.
    pub timeout_secs: u64,
    /// Denkaufwand der Denk-Modelle: "low" (schnell, Standard) oder "high".
    pub effort: String,
}

impl Default for CouncilConfig {
    fn default() -> Self {
        let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect();
        CouncilConfig {
            mode: "auto".into(),
            review: v(&["mistral-large-4", "zai-glm-5-3", "codestral-latest"]),
            debug: v(&["magistral-medium-latest", "mistral-large-4", "zai-glm-5-3"]),
            verify: v(&["mistral-large-4", "zai-glm-5-3", "mistral-medium-3.5"]),
            chair: "mistral-large-4".into(),
            opinions: 3,
            daily_limit_eur: 2.0,
            timeout_secs: 120,
            effort: "low".into(),
        }
    }
}

/// Einstellungen aus `custom/settings.json` (`current.council`), die die
/// Oberfläche synchronisiert. So gelten Änderungen ab dem nächsten Aufruf.
pub fn config() -> CouncilConfig {
    let path = data_dir().join("custom").join("settings.json");
    let stored = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(|v| v["current"]["council"].clone());
    let mut c: CouncilConfig = stored.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let d = CouncilConfig::default();
    for (list, def) in [(&mut c.review, d.review), (&mut c.debug, d.debug), (&mut c.verify, d.verify)] {
        list.retain(|m| !m.trim().is_empty());
        if list.is_empty() {
            *list = def;
        }
    }
    c.opinions = c.opinions.clamp(1, 5);
    c.timeout_secs = c.timeout_secs.clamp(20, 600);
    c
}

// ---------- Preise und Kosten ----------

/// EUR je Million Tokens (Eingabe, Ausgabe), Stand Mistral-Preisseite 2026-10.
/// Spezifische Muster zuerst; Unbekanntes kostet wie Mistral Large 4.
const PRICES: &[(&str, f64, f64)] = &[
    ("glm-5-3-flash", 0.1275, 0.425),
    ("glm", 1.19, 3.74),
    ("mistral-large-4", 1.156, 3.553),
    ("mistral-large-latest", 1.156, 3.553),
    ("mistral-large", 0.425, 1.275),
    ("magistral-medium", 1.7, 4.25),
    ("magistral-small", 0.1275, 0.51),
    ("mistral-medium", 1.275, 6.375),
    ("devstral", 1.275, 6.375),
    ("mistral-small", 0.1275, 0.51),
    ("ministral", 0.17, 0.17),
    ("codestral", 0.255, 0.765),
];

fn price(model: &str) -> (f64, f64) {
    PRICES.iter().find(|(p, _, _)| model.contains(p)).map(|(_, i, o)| (*i, *o)).unwrap_or((1.156, 3.553))
}

fn cost(model: &str, input: u64, output: u64) -> f64 {
    let (i, o) = price(model);
    (input as f64 * i + output as f64 * o) / 1_000_000.0
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Tag (UTC) als Zahl seit 1970 – reicht für das Tageslimit.
fn day(ms: u64) -> u64 {
    ms / 86_400_000
}

fn council_dir() -> PathBuf {
    data_dir().join("council")
}

/// Heutige Council-Kosten in Euro.
fn spent_today() -> f64 {
    let today = day(now_ms());
    std::fs::read_to_string(council_dir().join("journal.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["ts"].as_u64().map(day) == Some(today))
        .map(|v| v["costEur"].as_f64().unwrap_or(0.0))
        .sum()
}

fn append_line(path: &Path, line: &Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Eine Zeile pro write mit O_APPEND – App und MCP-Prozesse schreiben gleichzeitig.
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut f| f.write_all(format!("{line}\n").as_bytes()));
}

/// Jahr und Monat (UTC) für den Dateinamen des Usage-Journals.
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

/// Meldet einen Modellaufruf ins Usage-Journal (`usage/JJJJ-MM.jsonl`, Format
/// von `usage.rs`). Sobald `usage::record` im Hauptzweig ist, kann diese
/// Funktion darauf umgestellt werden.
fn report_usage(feature: &str, model: &str, input: u64, output: u64, project: &str) {
    if input + output == 0 {
        return;
    }
    let ts = now_ms();
    let (y, m) = year_month(ts);
    let line = json!({ "ts": ts, "kind": "council", "feature": feature, "model": model, "input": input, "output": output, "project": project });
    append_line(&data_dir().join("usage").join(format!("{y:04}-{m:02}.jsonl")), &line);
}

// ---------- Kontext aus dem Projekt ----------

struct Context {
    text: String,
    truncated: bool,
    notes: Vec<String>,
}

impl Context {
    fn push(&mut self, section: String) -> bool {
        let left = MAX_CONTEXT_CHARS.saturating_sub(self.text.len());
        if left < 200 {
            self.truncated = true;
            return false;
        }
        if section.len() > left {
            let cut: String = section.chars().take(left).collect();
            self.text.push_str(&cut);
            self.text.push_str("\n[… gekürzt]\n\n");
            self.truncated = true;
        } else {
            self.text.push_str(&section);
            self.text.push('\n');
        }
        true
    }
}

/// Pfad im Projekt auflösen – nichts außerhalb des Projektordners.
fn resolve(root: &Path, rel: &str) -> CmdResult<PathBuf> {
    let p = Path::new(rel);
    let joined = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let canon = joined.canonicalize().map_err(|e| format!("{rel}: {e}"))?;
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&base) {
        return Err(format!("{rel} liegt außerhalb des Projektordners"));
    }
    Ok(canon)
}

/// `pfad` oder `pfad:von-bis` (bzw. `pfad:zeile`).
fn split_range(spec: &str) -> (&str, Option<(usize, usize)>) {
    if let Some((path, range)) = spec.rsplit_once(':') {
        let nums: Vec<Option<usize>> = range.split('-').map(|n| n.trim().parse().ok()).collect();
        match nums.as_slice() {
            [Some(a)] => return (path, Some((*a, *a))),
            [Some(a), Some(b)] if a <= b => return (path, Some((*a, *b))),
            _ => {}
        }
    }
    (spec, None)
}

/// Datei mit Zeilennummern, damit die Modelle Stellen zitieren können.
fn numbered_file(root: &Path, spec: &str) -> CmdResult<String> {
    let (rel, range) = split_range(spec);
    let path = resolve(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("{rel}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{rel} ist keine Datei"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{rel} ist größer als 512 KB"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{rel}: {e}"))?;
    if bytes.contains(&0) {
        return Err(format!("{rel} ist eine Binärdatei"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    // Beim Ausschnitt etwas Umgebung mitgeben.
    let (from, to) = range.map(|(a, b)| (a.saturating_sub(15).max(1), (b + 15).min(lines.len()))).unwrap_or((1, lines.len()));
    let mut out = format!("### Datei {rel}{}\n```\n", if range.is_some() { format!(" (Zeilen {from}–{to})") } else { String::new() });
    let mut body = String::new();
    for (n, line) in lines.iter().enumerate().take(to).skip(from.saturating_sub(1)) {
        body.push_str(&format!("{:>5}| {line}\n", n + 1));
        if body.len() > MAX_FILE_CHARS {
            body.push_str("[… Datei gekürzt]\n");
            break;
        }
    }
    out.push_str(&body);
    out.push_str("```\n");
    Ok(out)
}

fn str_list(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Value::String(s) if !s.trim().is_empty() => s.split([',', '\n']).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        _ => vec![],
    }
}

/// Diff, Dateien und – bei Diffs – die geänderten Dateien vollständig.
fn build_context(root: &Path, args: &Value) -> CmdResult<Context> {
    let mut ctx = Context { text: String::new(), truncated: false, notes: vec![] };
    let mut changed: Vec<String> = vec![];

    if args["git_diff"].as_bool() == Some(true) {
        let diff = crate::git::git_output(root, &["diff", "HEAD", "--no-color", "--no-ext-diff"])
            .or_else(|_| crate::git::git_output(root, &["diff", "--cached", "--no-color", "--no-ext-diff"]))
            .map_err(|e| format!("git diff fehlgeschlagen: {e}"))?;
        let untracked = crate::git::git_output(root, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
        let untracked: Vec<String> = untracked.lines().map(str::to_string).take(20).collect();
        if diff.trim().is_empty() && untracked.is_empty() {
            ctx.notes.push("Git meldet keine Änderungen gegenüber HEAD.".into());
        } else {
            ctx.push(format!("## Aktueller Git-Diff (gegenüber HEAD)\n```diff\n{diff}```\n"));
            if !untracked.is_empty() {
                ctx.push(format!("Neue, noch nicht versionierte Dateien: {}\n", untracked.join(", ")));
            }
            changed.extend(untracked);
        }
        changed.extend(diff_files(&diff));
    }
    if let Some(diff) = args["diff"].as_str().filter(|d| !d.trim().is_empty()) {
        ctx.push(format!("## Diff\n```diff\n{diff}\n```\n"));
        changed.extend(diff_files(diff));
    }
    let explicit = str_list(&args["files"]);
    for spec in &explicit {
        match numbered_file(root, spec) {
            Ok(s) => {
                if !ctx.push(s) {
                    break;
                }
            }
            Err(e) => ctx.notes.push(e),
        }
    }
    // Geänderte Dateien ganz, solange Platz ist – Diffs allein zeigen zu wenig Umfeld.
    let mut seen: BTreeSet<String> = explicit.iter().map(|s| split_range(s).0.to_string()).collect();
    for file in changed {
        if !seen.insert(file.clone()) || ctx.text.len() > MAX_CONTEXT_CHARS * 3 / 4 {
            continue;
        }
        if let Ok(s) = numbered_file(root, &file) {
            ctx.push(s);
        }
    }
    if ctx.text.trim().is_empty() {
        return Err("Kein Code zum Prüfen: gib git_diff: true, diff oder files an.".into());
    }
    Ok(ctx)
}

/// Dateien aus `+++ b/…`-Zeilen eines Diffs.
fn diff_files(diff: &str) -> Vec<String> {
    diff.lines()
        .filter_map(|l| l.strip_prefix("+++ "))
        .filter(|p| *p != "/dev/null")
        .map(|p| p.strip_prefix("b/").unwrap_or(p).trim().to_string())
        .collect()
}

// ---------- Rollen und Prompts ----------

#[derive(Clone, Copy, PartialEq)]
enum Tool {
    Review,
    Debug,
    Verify,
}

impl Tool {
    fn from_name(name: &str) -> Option<Tool> {
        match name.trim_start_matches("council_") {
            "review" => Some(Tool::Review),
            "debug" => Some(Tool::Debug),
            "verify" => Some(Tool::Verify),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Tool::Review => "review",
            Tool::Debug => "debug",
            Tool::Verify => "verify",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Tool::Review => "Review",
            Tool::Debug => "Fehlersuche",
            Tool::Verify => "Schlussprüfung",
        }
    }
    /// Rollen in der Reihenfolge, in der sie vergeben werden.
    fn roles(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Tool::Review => &[
                ("Gutachter", "Dein Fokus: Korrektheit und Logik – tut der Code, was er soll? Stimmen Bedingungen, Rückgabewerte, Datenfluss?"),
                ("Bug-Jäger", "Dein Fokus: Randfälle und Fehlerpfade – leere Eingaben, Off-by-one, None/null, Ausnahmen, Nebenläufigkeit, Ressourcen."),
                ("Skeptiker", "Dein Fokus: Sicherheit, Regressionen und unbelegte Annahmen – was bricht für bestehende Aufrufer, was fehlt an Prüfung oder Tests?"),
            ],
            Tool::Debug => &[
                ("Ursachenforscher", "Arbeite vom Symptom rückwärts zur Ursache. Unterscheide Ursache und Folgefehler."),
                ("Bug-Jäger", "Suche gezielt nach Randfällen, Zustandsfehlern und falschen Annahmen, die das Fehlerbild erklären."),
                ("Skeptiker", "Hinterfrage die naheliegende Erklärung und die bisherigen Versuche. Was erklärt das Fehlerbild noch?"),
            ],
            Tool::Verify => &[
                ("Verifizierer", "Prüfe, ob die Belege die Behauptung wirklich tragen und ob der Code sie erfüllt."),
                ("Skeptiker", "Suche gezielt, was gegen „erledigt“ spricht: fehlende Fälle, ungetestete Pfade, Nebenwirkungen."),
                ("Gutachter", "Prüfe Korrektheit und Vollständigkeit der Umsetzung gegenüber der Behauptung."),
            ],
        }
    }
    fn models(self, c: &CouncilConfig) -> &Vec<String> {
        match self {
            Tool::Review => &c.review,
            Tool::Debug => &c.debug,
            Tool::Verify => &c.verify,
        }
    }
}

const SEVERITY_RULES: &str = "Schweregrade: kritisch (Datenverlust, Sicherheitslücke, Absturz im Normalbetrieb), \
    hoch (falsches Verhalten in üblichen Fällen), mittel (Randfälle, fragile Stellen), niedrig (Kleinigkeit mit echtem Risiko).";

fn system_prompt(tool: Tool, role: &str, focus: &str) -> String {
    let base = format!(
        "Du bist {role} in einem Gremium mehrerer KI-Modelle (Model Council), das einem Coding-Agenten eine unabhängige zweite Meinung gibt. {focus} \
         Zeilennummern beziehen sich auf die nummerierten Dateien (`  12| code`) bzw. die neue Seite eines Diffs. \
         Belege alles am gezeigten Code; keine Vermutungen über nicht gezeigten Code, keine Stilfragen, kein Lob. Antworte auf Deutsch und nur als JSON."
    );
    match tool {
        Tool::Review => format!(
            "{base} Prüfe den Code bzw. Diff auf echte Fehler. {SEVERITY_RULES} \
             Format: {{\"summary\":\"1–2 Sätze\",\"findings\":[{{\"severity\":\"kritisch|hoch|mittel|niedrig\",\"file\":\"pfad\",\"line\":42,\"title\":\"kurz\",\"reason\":\"warum das ein Fehler ist\",\"fix\":\"konkreter Vorschlag\"}}]}}. \
             Leere Liste, wenn du nichts Belastbares findest."
        ),
        Tool::Debug => format!(
            "{base} Finde die wahrscheinlichsten Ursachen für das beschriebene Fehlerbild. \
             Format: {{\"summary\":\"1–2 Sätze\",\"hypotheses\":[{{\"cause\":\"Ursache\",\"likelihood\":\"hoch|mittel|niedrig\",\"file\":\"pfad\",\"line\":42,\"evidence\":\"was im Code dafür spricht\",\"check\":\"wie man es schnell prüft\",\"fix\":\"Vorschlag\"}}]}}. \
             Höchstens 5 Hypothesen, wahrscheinlichste zuerst."
        ),
        Tool::Verify => format!(
            "{base} Prüfe die Behauptung des Agenten gegen Code und Belege. {SEVERITY_RULES} \
             Format: {{\"verdict\":\"bestätigt|einwände|unklar\",\"confidence\":0.8,\"summary\":\"1–2 Sätze\",\"objections\":[{{\"severity\":\"kritisch|hoch|mittel|niedrig\",\"file\":\"pfad\",\"line\":42,\"issue\":\"was fehlt oder falsch ist\",\"reason\":\"Beleg\"}}]}}. \
             „bestätigt“ nur, wenn nichts Wesentliches dagegen spricht; „unklar“, wenn die Belege nicht reichen."
        ),
    }
}

fn task_text(tool: Tool, args: &Value) -> String {
    let s = |k: &str| args[k].as_str().unwrap_or("").trim().to_string();
    match tool {
        Tool::Review => {
            let focus = s("focus");
            if focus.is_empty() { "Aufgabe: Prüfe die Änderungen.".into() } else { format!("Aufgabe: Prüfe die Änderungen. Schwerpunkt: {focus}") }
        }
        Tool::Debug => {
            let mut t = format!("Fehlerbild:\n{}", s("problem"));
            if !s("tried").is_empty() {
                t.push_str(&format!("\n\nBisher versucht (ohne Erfolg):\n{}", s("tried")));
            }
            t
        }
        Tool::Verify => {
            let mut t = format!("Behauptung des Agenten:\n{}", s("claim"));
            if !s("evidence").is_empty() {
                t.push_str(&format!("\n\nBelege (z. B. Testausgabe):\n{}", s("evidence").chars().take(15_000).collect::<String>()));
            }
            t
        }
    }
}

// ---------- Modellaufruf ----------

/// Text aus einer Chat-Antwort; Denk-Modelle liefern Blöcke (thinking + text).
fn message_text(body: &Value) -> String {
    let content = &body["choices"][0]["message"]["content"];
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

/// JSON aus der Antwort, auch wenn ein Modell Codezäune oder Vorrede schreibt.
fn parse_json(text: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        return Some(v);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

struct Answer {
    json: Value,
    input: u64,
    output: u64,
}

/// `reasoning_effort` je Modell: Mistral-Modelle kennen nur high/none, GLM
/// auch low, Codestral gar nichts. Ohne GLM-low denkt GLM-5.3 minutenlang.
fn effort_for(model: &str, effort: &str) -> Option<&'static str> {
    match effort {
        "high" if !model.contains("codestral") && !model.contains("ministral") => Some("high"),
        "low" if model.contains("glm") => Some("low"),
        _ => None,
    }
}

async fn ask(client: &reqwest::Client, key: &str, model: &str, system: &str, user: &str, timeout: u64, effort: &str) -> CmdResult<Answer> {
    let mut body = json!({
        "model": model,
        "temperature": 0.2,
        "max_tokens": 8000,
        "response_format": { "type": "json_object" },
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }]
    });
    if let Some(e) = effort_for(model, effort) {
        body["reasoning_effort"] = json!(e);
    }
    let started = Instant::now();
    let mut retried = false;
    let body = loop {
        let left = timeout.saturating_sub(started.elapsed().as_secs()).max(5);
        let resp = client
            .post(format!("{API_BASE}/chat/completions"))
            .bearer_auth(key)
            .timeout(Duration::from_secs(left))
            .json(&body)
            .send()
            .await
            .map_err(|e| if e.is_timeout() { format!("keine Antwort nach {timeout} s") } else { e.to_string() })?;
        let status = resp.status();
        let reply: Value = resp.json().await.map_err(|e| if e.is_timeout() { format!("keine Antwort nach {timeout} s") } else { e.to_string() })?;
        if status.is_success() {
            break reply;
        }
        let msg = reply["message"].as_str().or(reply["detail"].as_str()).map(str::to_string).unwrap_or_else(|| reply.to_string());
        // Unbekannter Denkaufwand: einmal ohne versuchen.
        if !retried && msg.contains("reasoning_effort") && body.get("reasoning_effort").is_some() {
            body.as_object_mut().unwrap().remove("reasoning_effort");
            retried = true;
            continue;
        }
        return Err(format!("HTTP {}: {}", status.as_u16(), msg.chars().take(200).collect::<String>()));
    };
    let input = body["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    let output = body["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    let text = message_text(&body);
    match parse_json(&text) {
        Some(json) => Ok(Answer { json, input, output }),
        None if body["choices"][0]["finish_reason"] == "length" => Err(format!("Antwort abgeschnitten ({output} Tokens, meist Gedankengang)")),
        None => Err(format!("kein gültiges JSON ({} Zeichen Antwort)", text.len())),
    }
}

// ---------- Lauf ----------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Opinion {
    pub index: usize,
    pub model: String,
    pub role: String,
    /// wartet, fertig, fehler
    pub status: String,
    pub error: Option<String>,
    pub ms: u64,
    pub input: u64,
    pub output: u64,
    pub cost_eur: f64,
    pub result: Value,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Run {
    pub id: String,
    pub tool: String,
    pub cwd: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    /// läuft, fertig, fehler
    pub status: String,
    /// Fokus, Fehlerbild oder Behauptung (gekürzt) für die Karte.
    pub subject: String,
    pub opinions: Vec<Opinion>,
    pub chair: Option<Opinion>,
    pub result: Value,
    /// "vorsitz" oder "brise"
    pub merged_by: String,
    pub input: u64,
    pub output: u64,
    pub cost_eur: f64,
    pub context_chars: usize,
    pub truncated: bool,
    pub notes: Vec<String>,
    pub error: Option<String>,
}

fn run_path(id: &str) -> PathBuf {
    council_dir().join("runs").join(format!("{id}.json"))
}

fn save_run(run: &Run) {
    let path = run_path(&run.id);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    // Erst in eine Nebendatei, dann umbenennen – die Oberfläche liest mit.
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(run).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

pub fn load_run(id: &str) -> Option<Run> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    std::fs::read(run_path(id)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

fn new_id() -> String {
    let n = now_ms();
    let rnd: u32 = std::process::id().wrapping_mul(2_654_435_761) ^ (Instant::now().elapsed().subsec_nanos()) ^ (n as u32).rotate_left(7);
    format!("{n:x}-{rnd:08x}")
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "kritisch" => 4,
        "hoch" => 3,
        "mittel" => 2,
        "niedrig" => 1,
        _ => 0,
    }
}

fn norm_severity(s: &str) -> String {
    match s.trim().to_lowercase().as_str() {
        "kritisch" | "critical" | "blocker" => "kritisch",
        "hoch" | "high" | "major" => "hoch",
        "mittel" | "medium" | "moderate" => "mittel",
        "niedrig" | "low" | "minor" | "info" => "niedrig",
        _ => "mittel",
    }
    .into()
}

fn words(s: &str) -> BTreeSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() > 3).map(str::to_string).collect()
}

fn similar(a: &str, b: &str) -> bool {
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return false;
    }
    let inter = wa.intersection(&wb).count() as f64;
    inter / (wa.len().min(wb.len()) as f64) >= 0.4
}

fn same_file(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_start_matches("./"), b.trim_start_matches("./"));
    !a.is_empty() && (a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}")))
}

/// Ersatzweg ohne Vorsitz: gleiche Datei und Zeile ±3 bzw. ähnlicher Text.
fn cluster(items: Vec<(usize, Value)>, text_key: &str) -> Vec<(Value, BTreeSet<usize>)> {
    let mut groups: Vec<(Value, BTreeSet<usize>)> = vec![];
    for (who, item) in items {
        let file = item["file"].as_str().unwrap_or("");
        let line = item["line"].as_i64();
        let text = format!("{} {}", item[text_key].as_str().unwrap_or(""), item["reason"].as_str().unwrap_or(""));
        let hit = groups.iter_mut().find(|(g, _)| {
            let gfile = g["file"].as_str().unwrap_or("");
            let gtext = format!("{} {}", g[text_key].as_str().unwrap_or(""), g["reason"].as_str().unwrap_or(""));
            let near = match (line, g["line"].as_i64()) {
                (Some(a), Some(b)) => (a - b).abs() <= 3,
                _ => false,
            };
            (same_file(file, gfile) && (near || similar(&text, &gtext))) || (file.is_empty() && gfile.is_empty() && similar(&text, &gtext))
        });
        match hit {
            Some((g, who_set)) => {
                who_set.insert(who);
                // Der höhere Schweregrad gewinnt.
                if severity_rank(item["severity"].as_str().unwrap_or("")) > severity_rank(g["severity"].as_str().unwrap_or("")) {
                    g["severity"] = item["severity"].clone();
                }
            }
            None => groups.push((item, BTreeSet::from([who]))),
        }
    }
    groups
}

fn agreement(raised: &BTreeSet<usize>, total: usize) -> String {
    format!("{}/{}", raised.len(), total)
}

/// Einzelurteile (Index ab 1) zu einem Ergebnis – ohne Vorsitz.
fn merge_plain(tool: Tool, ok: &[&Opinion]) -> Value {
    let total = ok.len();
    let majority = total / 2 + 1;
    let decide = |n: usize| if n >= majority && total > 1 { "bestätigt" } else { "umstritten" };
    match tool {
        Tool::Review | Tool::Debug => {
            let (key, text_key) = if tool == Tool::Review { ("findings", "title") } else { ("hypotheses", "cause") };
            let items: Vec<(usize, Value)> =
                ok.iter().flat_map(|o| o.result[key].as_array().cloned().unwrap_or_default().into_iter().map(move |f| (o.index, f))).collect();
            let mut merged: Vec<Value> = cluster(items, text_key)
                .into_iter()
                .map(|(mut g, who)| {
                    g["raisedBy"] = json!(who.iter().collect::<Vec<_>>());
                    g["agreement"] = json!(agreement(&who, total));
                    g["decision"] = json!(decide(who.len()));
                    g
                })
                .collect();
            sort_items(&mut merged, tool);
            let summary = ok.iter().filter_map(|o| o.result["summary"].as_str()).next().unwrap_or("").to_string();
            json!({ "summary": summary, key: merged })
        }
        Tool::Verify => merge_verify(ok),
    }
}

fn sort_items(items: &mut [Value], tool: Tool) {
    let rank = |v: &Value| {
        let sev = if tool == Tool::Debug { v["likelihood"].as_str() } else { v["severity"].as_str() };
        let decision = match v["decision"].as_str() {
            Some("verworfen") => 0,
            Some("umstritten") => 1,
            _ => 2,
        };
        (decision, severity_rank(sev.unwrap_or("")), v["raisedBy"].as_array().map(Vec::len).unwrap_or(0))
    };
    items.sort_by(|a, b| rank(b).cmp(&rank(a)));
}

/// Schlussprüfung: Mehrheit der Urteile, kritische Einwände zählen immer.
fn merge_verify(ok: &[&Opinion]) -> Value {
    let total = ok.len();
    let count = |v: &str| ok.iter().filter(|o| o.result["verdict"].as_str() == Some(v)).count();
    let (yes, no, unsure) = (count("bestätigt"), count("einwände"), count("unklar"));
    let items: Vec<(usize, Value)> =
        ok.iter().flat_map(|o| o.result["objections"].as_array().cloned().unwrap_or_default().into_iter().map(move |f| (o.index, f))).collect();
    let mut objections: Vec<Value> = cluster(items, "issue")
        .into_iter()
        .map(|(mut g, who)| {
            g["raisedBy"] = json!(who.iter().collect::<Vec<_>>());
            g["agreement"] = json!(agreement(&who, total));
            g
        })
        .collect();
    sort_items(&mut objections, Tool::Verify);
    let critical = objections.iter().any(|o| o["severity"] == "kritisch");
    let verdict = if yes * 2 > total && !critical {
        "bestätigt"
    } else if unsure == total {
        "unklar"
    } else if no == 0 && !critical {
        "unklar"
    } else {
        "einwände"
    };
    let summary = ok.iter().filter(|o| o.result["verdict"] == verdict).filter_map(|o| o.result["summary"].as_str()).next().unwrap_or("").to_string();
    json!({ "verdict": verdict, "votes": { "bestätigt": yes, "einwände": no, "unklar": unsure }, "summary": summary, "objections": objections })
}

fn chair_prompt(tool: Tool, total: usize) -> String {
    let (key, fields) = match tool {
        Tool::Review => ("findings", "\"severity\":\"kritisch|hoch|mittel|niedrig\",\"file\":\"pfad\",\"line\":42,\"title\":\"kurz\",\"reason\":\"Begründung\",\"fix\":\"Vorschlag\""),
        _ => ("hypotheses", "\"cause\":\"Ursache\",\"likelihood\":\"hoch|mittel|niedrig\",\"file\":\"pfad\",\"line\":42,\"evidence\":\"Beleg\",\"check\":\"Prüfschritt\",\"fix\":\"Vorschlag\""),
    };
    format!(
        "Du leitest ein Gremium aus {total} KI-Modellen (Model Council), die unabhängig voneinander geurteilt haben (#1 bis #{total}). \
         Führe ihre Urteile zusammen: gleiche Punkte zu einem Eintrag zusammenfassen, `raisedBy` = Nummern aller Mitglieder, die ihn genannt haben. \
         Prüfe jeden Eintrag am gezeigten Code und entscheide: \"bestätigt\" (Mehrheit oder am Code eindeutig belegbar), \
         \"umstritten\" (einzelne Stimme, plausibel, nicht sicher), \"verworfen\" (am Code widerlegt). Begründe die Entscheidung in `note`. \
         Erfinde keine neuen Punkte. {SEVERITY_RULES} Antworte auf Deutsch, nur als JSON: \
         {{\"summary\":\"2–3 Sätze Gesamturteil\",\"{key}\":[{{{fields},\"raisedBy\":[1,2],\"decision\":\"bestätigt|umstritten|verworfen\",\"note\":\"Begründung\"}}]}}"
    )
}

/// Ergebnis des Vorsitzes säubern: Übereinstimmung aus `raisedBy` berechnen.
fn finish_chair(tool: Tool, mut v: Value, ok: &[&Opinion]) -> Option<Value> {
    let (key, text_key) = if tool == Tool::Review { ("findings", "title") } else { ("hypotheses", "cause") };
    let valid: BTreeSet<usize> = ok.iter().map(|o| o.index).collect();
    if !v.is_object() || !v[key].is_array() {
        return None;
    }
    v[key] = Value::Array(objects(&v[key], text_key));
    let items = v[key].as_array_mut()?;
    for item in items.iter_mut() {
        let who: BTreeSet<usize> = item["raisedBy"].as_array().into_iter().flatten().filter_map(|n| n.as_u64().map(|n| n as usize)).filter(|n| valid.contains(n)).collect();
        if tool == Tool::Review {
            item["severity"] = json!(norm_severity(item["severity"].as_str().unwrap_or("")));
        }
        item["agreement"] = json!(agreement(&who, ok.len()));
        item["raisedBy"] = json!(who);
        if !matches!(item["decision"].as_str(), Some("bestätigt" | "umstritten" | "verworfen")) {
            item["decision"] = json!("umstritten");
        }
    }
    sort_items(items, tool);
    Some(v)
}

/// Nur Objekte behalten; reine Texte werden zu `{text_key: …}`.
fn objects(list: &Value, text_key: &str) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| match f {
            Value::Object(_) => Some(f.clone()),
            Value::String(s) if !s.trim().is_empty() => Some(json!({ text_key: s })),
            _ => None,
        })
        .collect()
}

fn normalize_opinion(tool: Tool, v: &mut Value) {
    let (key, text_key) = match tool {
        Tool::Review => ("findings", "title"),
        Tool::Debug => ("hypotheses", "cause"),
        Tool::Verify => ("objections", "issue"),
    };
    if !v.is_object() {
        *v = json!({ key: v.clone() });
    }
    let mut items = objects(&v[key], text_key);
    if tool != Tool::Debug {
        for f in items.iter_mut() {
            f["severity"] = json!(norm_severity(f["severity"].as_str().unwrap_or("")));
        }
    }
    v[key] = Value::Array(items);
    if tool == Tool::Verify {
        let verdict = match v["verdict"].as_str().unwrap_or("").to_lowercase().as_str() {
            "bestätigt" | "bestaetigt" | "confirmed" | "ok" => "bestätigt",
            "einwände" | "einwaende" | "objections" | "rejected" => "einwände",
            _ => "unklar",
        };
        v["verdict"] = json!(verdict);
    }
}

/// Schätzt die Kosten vorab (für die Kostenbremse).
fn estimate(tool: Tool, models: &[(String, &str)], chair: &str, ctx_chars: usize) -> f64 {
    let input = ((ctx_chars + 3000) as f64 / 3.5) as u64;
    let mut sum: f64 = models.iter().map(|(m, _)| cost(m, input, 2500)).sum();
    if tool != Tool::Verify && !chair.is_empty() && models.len() > 1 {
        sum += cost(chair, ((ctx_chars.min(CHAIR_CONTEXT_CHARS) + 4000 * models.len()) as f64 / 3.5) as u64, 2500);
    }
    sum
}

/// Startet einen Lauf: prüft Limit, legt die Run-Datei an. Die eigentliche
/// Arbeit macht `execute`.
fn prepare(cwd: &str, tool: Tool, args: &Value) -> CmdResult<(Run, String, Vec<(String, &'static str, &'static str)>, CouncilConfig)> {
    let cfg = config();
    let root = PathBuf::from(cwd);
    let ctx = build_context(&root, args)?;
    let models = tool.models(&cfg).clone();
    let roles = tool.roles();
    let wanted = args["opinions"].as_u64().map(|n| n as usize).unwrap_or(cfg.opinions).clamp(1, cfg.opinions);
    let plan: Vec<(String, &'static str, &'static str)> =
        (0..wanted).map(|i| (models[i % models.len()].clone(), roles[i % roles.len()].0, roles[i % roles.len()].1)).collect();

    let est = estimate(tool, &plan.iter().map(|(m, r, _)| (m.clone(), *r)).collect::<Vec<_>>(), &cfg.chair, ctx.text.len());
    let spent = spent_today();
    if cfg.daily_limit_eur > 0.0 && spent + est > cfg.daily_limit_eur {
        return Err(format!(
            "Council-Tageslimit erreicht: heute {:.2} € verbraucht, dieser Aufruf kostet geschätzt {:.2} €, Limit {:.2} €. \
             Der Nutzer kann das Limit unter Einstellungen → Council erhöhen. Arbeite ohne Council weiter und sag es dem Nutzer.",
            spent, est, cfg.daily_limit_eur
        ));
    }
    if read_key().is_none() {
        return Err("Kein Mistral-Schlüssel – das Council braucht die Mistral-API.".into());
    }

    let subject = match tool {
        Tool::Review => args["focus"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or(if args["git_diff"] == true { "Aktueller Git-Diff" } else { "Änderungen" }),
        Tool::Debug => args["problem"].as_str().unwrap_or(""),
        Tool::Verify => args["claim"].as_str().unwrap_or(""),
    };
    let run = Run {
        id: new_id(),
        tool: tool.name().into(),
        cwd: cwd.into(),
        started_at: now_ms(),
        status: "läuft".into(),
        subject: subject.chars().take(300).collect(),
        opinions: plan
            .iter()
            .enumerate()
            .map(|(i, (m, r, _))| Opinion { index: i + 1, model: m.clone(), role: r.to_string(), status: "wartet".into(), ..Default::default() })
            .collect(),
        context_chars: ctx.text.len(),
        truncated: ctx.truncated,
        notes: ctx.notes.clone(),
        ..Default::default()
    };
    save_run(&run);
    Ok((run, ctx.text, plan, cfg))
}

/// Fragt alle Mitglieder parallel, führt zusammen und speichert den Lauf.
async fn execute(run: Run, context: String, plan: Vec<(String, &'static str, &'static str)>, cfg: CouncilConfig, args: Value) -> Run {
    let tool = Tool::from_name(&run.tool).unwrap_or(Tool::Review);
    let key = read_key().unwrap_or_default();
    let client = reqwest::Client::new();
    let shared = Arc::new(Mutex::new(run));
    let task = task_text(tool, &args);
    let user = format!("{context}\n\n{task}");
    let feature = format!("Council: {}", tool.label());
    let project = shared.lock().unwrap_or_else(|e| e.into_inner()).cwd.clone();

    let mut set = tokio::task::JoinSet::new();
    for (i, (model, role, focus)) in plan.iter().cloned().enumerate() {
        let (client, key, user, shared) = (client.clone(), key.clone(), user.clone(), shared.clone());
        let system = system_prompt(tool, role, focus);
        let (timeout, effort) = (cfg.timeout_secs, cfg.effort.clone());
        let (feature, project) = (feature.clone(), project.clone());
        set.spawn(async move {
            let started = Instant::now();
            let res = ask(&client, &key, &model, &system, &user, timeout, &effort).await;
            let mut run = shared.lock().unwrap_or_else(|e| e.into_inner());
            let op = &mut run.opinions[i];
            op.ms = started.elapsed().as_millis() as u64;
            match res {
                Ok(mut a) => {
                    normalize_opinion(tool, &mut a.json);
                    op.status = "fertig".into();
                    op.input = a.input;
                    op.output = a.output;
                    op.cost_eur = cost(&model, a.input, a.output);
                    op.result = a.json;
                    report_usage(&feature, &model, a.input, a.output, &project);
                }
                Err(e) => {
                    op.status = "fehler".into();
                    op.error = Some(e);
                }
            }
            save_run(&run);
        });
    }
    while set.join_next().await.is_some() {}

    let snapshot = shared.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let ok: Vec<&Opinion> = snapshot.opinions.iter().filter(|o| o.status == "fertig").collect();
    let mut run = snapshot.clone();
    if ok.is_empty() {
        run.status = "fehler".into();
        run.error = Some(format!(
            "Keine Meinung erhalten: {}",
            run.opinions.iter().map(|o| format!("{} ({})", o.model, o.error.clone().unwrap_or_default())).collect::<Vec<_>>().join("; ")
        ));
    } else {
        run.merged_by = "brise".into();
        run.result = merge_plain(tool, &ok);
        // Vorsitz nur, wenn es mehr als eine Meinung gibt und überhaupt etwas zu entscheiden ist.
        let anything = run.result["findings"].as_array().or(run.result["hypotheses"].as_array()).is_some_and(|a| !a.is_empty());
        if tool != Tool::Verify && ok.len() > 1 && !cfg.chair.is_empty() && anything {
            let verdicts = ok
                .iter()
                .map(|o| format!("#{} ({}, {}):\n{}", o.index, o.role, o.model, serde_json::to_string(&o.result).unwrap_or_default()))
                .collect::<Vec<_>>()
                .join("\n\n");
            let ctx_short: String = context.chars().take(CHAIR_CONTEXT_CHARS).collect();
            let user = format!("{ctx_short}\n\n{task}\n\n## Urteile der Mitglieder\n{verdicts}");
            let started = Instant::now();
            let mut chair = Opinion { index: 0, model: cfg.chair.clone(), role: "Vorsitz".into(), ..Default::default() };
            match ask(&client, &key, &cfg.chair, &chair_prompt(tool, ok.len()), &user, cfg.timeout_secs, &cfg.effort).await {
                Ok(a) => {
                    chair.input = a.input;
                    chair.output = a.output;
                    chair.cost_eur = cost(&cfg.chair, a.input, a.output);
                    report_usage(&feature, &cfg.chair, a.input, a.output, &project);
                    match finish_chair(tool, a.json, &ok) {
                        Some(merged) => {
                            chair.status = "fertig".into();
                            chair.result = merged.clone();
                            run.result = merged;
                            run.merged_by = "vorsitz".into();
                        }
                        None => {
                            chair.status = "fehler".into();
                            chair.error = Some("Antwort ohne Ergebnisliste".into());
                        }
                    }
                }
                Err(e) => {
                    chair.status = "fehler".into();
                    chair.error = Some(e);
                }
            }
            chair.ms = started.elapsed().as_millis() as u64;
            if chair.status == "fehler" {
                run.notes.push(format!("Vorsitz ({}) ausgefallen – Brise hat die Urteile selbst gruppiert.", cfg.chair));
            }
            run.chair = Some(chair);
        }
        run.status = "fertig".into();
    }
    let all = run.opinions.iter().chain(run.chair.iter());
    run.input = all.clone().map(|o| o.input).sum();
    run.output = all.clone().map(|o| o.output).sum();
    run.cost_eur = all.map(|o| o.cost_eur).sum();
    run.finished_at = Some(now_ms());
    save_run(&run);
    append_line(
        &council_dir().join("journal.jsonl"),
        &json!({ "ts": now_ms(), "id": run.id, "tool": run.tool, "cwd": run.cwd, "costEur": run.cost_eur, "input": run.input, "output": run.output }),
    );
    run
}

// ---------- Ausgabe für den Agenten ----------

fn loc(v: &Value) -> String {
    let file = v["file"].as_str().unwrap_or("");
    match (file.is_empty(), v["line"].as_i64()) {
        (true, _) => String::new(),
        (false, Some(l)) => format!("{file}:{l}"),
        (false, None) => file.to_string(),
    }
}

/// Markdown-Zusammenfassung; die letzte Zeile verweist auf den gespeicherten Lauf.
pub fn render(run: &Run) -> String {
    let tool = Tool::from_name(&run.tool).unwrap_or(Tool::Review);
    let ok = run.opinions.iter().filter(|o| o.status == "fertig").count();
    let members = run.opinions.iter().map(|o| format!("{} als {}", o.model, o.role)).collect::<Vec<_>>().join(", ");
    let mut out = format!("## Model Council – {}\n{ok} von {} Meinungen ({members})", tool.label(), run.opinions.len());
    if run.merged_by == "vorsitz" {
        out.push_str(&format!(", zusammengeführt vom Vorsitz ({})", run.chair.as_ref().map(|c| c.model.as_str()).unwrap_or("?")));
    }
    out.push_str(".\n\n");
    if let Some(e) = &run.error {
        out.push_str(&format!("Fehlgeschlagen: {e}\n"));
    }
    let r = &run.result;
    if let Some(s) = r["summary"].as_str().filter(|s| !s.is_empty()) {
        out.push_str(&format!("**Gesamturteil:** {s}\n\n"));
    }
    match tool {
        Tool::Review => {
            let items = r["findings"].as_array().cloned().unwrap_or_default();
            if items.is_empty() && run.error.is_none() {
                out.push_str("Keine Befunde – das Council hat nichts Belastbares gefunden.\n");
            }
            for (n, f) in items.iter().enumerate() {
                out.push_str(&format!(
                    "{}. [{} · {} · {}] {} – {}\n",
                    n + 1,
                    f["severity"].as_str().unwrap_or("?"),
                    f["agreement"].as_str().unwrap_or("?"),
                    f["decision"].as_str().unwrap_or("?"),
                    if loc(f).is_empty() { "allgemein".into() } else { loc(f) },
                    f["title"].as_str().unwrap_or("")
                ));
                for (label, key) in [("Begründung", "reason"), ("Vorschlag", "fix"), ("Vorsitz", "note")] {
                    if let Some(t) = f[key].as_str().filter(|t| !t.is_empty()) {
                        out.push_str(&format!("   {label}: {t}\n"));
                    }
                }
            }
        }
        Tool::Debug => {
            for (n, h) in r["hypotheses"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                out.push_str(&format!(
                    "{}. [Wahrscheinlichkeit {} · {} · {}] {}{}\n",
                    n + 1,
                    h["likelihood"].as_str().unwrap_or("?"),
                    h["agreement"].as_str().unwrap_or("?"),
                    h["decision"].as_str().unwrap_or("?"),
                    h["cause"].as_str().unwrap_or(""),
                    if loc(h).is_empty() { String::new() } else { format!(" ({})", loc(h)) }
                ));
                for (label, key) in [("Beleg", "evidence"), ("Prüfen", "check"), ("Vorschlag", "fix"), ("Vorsitz", "note")] {
                    if let Some(t) = h[key].as_str().filter(|t| !t.is_empty()) {
                        out.push_str(&format!("   {label}: {t}\n"));
                    }
                }
            }
        }
        Tool::Verify => {
            let v = &r["votes"];
            out.push_str(&format!(
                "**Urteil: {}** (bestätigt {}, Einwände {}, unklar {})\n\n",
                r["verdict"].as_str().unwrap_or("?"),
                v["bestätigt"],
                v["einwände"],
                v["unklar"]
            ));
            for (n, o) in r["objections"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                out.push_str(&format!(
                    "{}. [{} · {}] {} – {}\n",
                    n + 1,
                    o["severity"].as_str().unwrap_or("?"),
                    o["agreement"].as_str().unwrap_or("?"),
                    if loc(o).is_empty() { "allgemein".into() } else { loc(o) },
                    o["issue"].as_str().unwrap_or("")
                ));
                if let Some(t) = o["reason"].as_str().filter(|t| !t.is_empty()) {
                    out.push_str(&format!("   Begründung: {t}\n"));
                }
            }
        }
    }
    let failed: Vec<String> = run.opinions.iter().filter(|o| o.status == "fehler").map(|o| format!("{} ({})", o.model, o.error.clone().unwrap_or_default())).collect();
    if !failed.is_empty() {
        out.push_str(&format!("\nOhne Antwort: {}\n", failed.join("; ")));
    }
    for n in &run.notes {
        out.push_str(&format!("Hinweis: {n}\n"));
    }
    if run.truncated {
        out.push_str("Hinweis: Der Kontext war zu groß und wurde gekürzt – bei Bedarf gezielter mit files prüfen.\n");
    }
    out.push_str(&format!(
        "\nÜbereinstimmung „2/3“ = von 2 der 3 Mitglieder genannt. „bestätigt“ zuerst abarbeiten, „umstritten“ selbst am Code prüfen, „verworfen“ ignorieren.\n\
         council-run:{} · {} Tokens · ca. {:.3} €\n",
        run.id,
        run.input + run.output,
        run.cost_eur
    ));
    out
}

// ---------- Oberfläche ----------

/// Council direkt aus der Oberfläche (Git-Panel: aktuellen Diff prüfen).
#[tauri::command]
pub async fn council_start(cwd: String, tool: String, args: Value) -> CmdResult<Run> {
    let t = Tool::from_name(&tool).ok_or("Unbekanntes Council-Werkzeug")?;
    let (run, ctx, plan, cfg) = tokio::task::spawn_blocking({
        let (cwd, args) = (cwd.clone(), args.clone());
        move || prepare(&cwd, t, &args)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(execute(run, ctx, plan, cfg, args).await)
}

#[tauri::command]
pub fn council_run(id: String) -> Option<Run> {
    load_run(&id)
}

/// Lauf zu einem gerade laufenden Werkzeugaufruf: der erste passende ab `since`.
#[tauri::command]
pub fn council_find(cwd: String, tool: String, since: u64) -> Option<Run> {
    let tool = tool.trim_start_matches("council_").to_string();
    let mut best: Option<Run> = None;
    for entry in std::fs::read_dir(council_dir().join("runs")).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        // Die ID beginnt mit dem Startzeitpunkt (hex) – alte Läufe gar nicht erst lesen.
        let started = id.split('-').next().and_then(|h| u64::from_str_radix(h, 16).ok()).unwrap_or(0);
        if started < since || best.as_ref().is_some_and(|b| b.started_at <= started) {
            continue;
        }
        if let Some(run) = load_run(id).filter(|r| r.cwd == cwd && r.tool == tool) {
            best = Some(run);
        }
    }
    best
}

/// Heutiger Stand für die Einstellungen.
#[tauri::command]
pub fn council_today() -> Value {
    let cfg = config();
    json!({ "spentEur": spent_today(), "limitEur": cfg.daily_limit_eur })
}

// ---------- MCP-Server ----------

fn tools(mode: &str) -> Value {
    let when = if mode == "request" {
        " Nur nutzen, wenn der Nutzer ausdrücklich eine Zweitmeinung, ein Council-Review oder eine Prüfung durch andere Modelle verlangt."
    } else {
        ""
    };
    let files = json!({ "type": "array", "items": { "type": "string" }, "description": "Dateien relativ zum Projekt, optional mit Zeilenbereich: \"src/a.py\" oder \"src/a.py:40-80\". Der Server liest sie selbst." });
    let git_diff = json!({ "type": "boolean", "description": "Aktuellen Git-Diff (gegenüber HEAD, inkl. neuer Dateien) mitgeben; die geänderten Dateien liest der Server ganz dazu." });
    let diff = json!({ "type": "string", "description": "Eigener Diff im Unified-Format (statt oder zusätzlich zu git_diff)." });
    let opinions = json!({ "type": "integer", "description": "Weniger Meinungen als eingestellt (spart Kosten), 1–5." });
    json!([
        {
            "name": "council_review",
            "description": format!("Unabhängiges Code-Review durch mehrere andere Modelle (Model Council): jedes Mitglied prüft in eigener Rolle (Gutachter, Bug-Jäger, Skeptiker), danach werden die Befunde zusammengeführt – mit Schweregrad, Datei:Zeile, Begründung, Vorschlag und Übereinstimmung. Gut vor dem Abschluss größerer Änderungen. Dauert 20–90 s und kostet Geld; gezielt einsetzen.{when}"),
            "inputSchema": { "type": "object", "properties": { "git_diff": git_diff, "diff": diff, "files": files, "focus": { "type": "string", "description": "Worauf besonders achten, z. B. \"Nebenläufigkeit\" oder \"die neue Löschfunktion\"." }, "opinions": opinions } },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "council_debug",
            "description": format!("Mehrere andere Modelle suchen unabhängig nach der Ursache eines Fehlers und liefern priorisierte Hypothesen mit Beleg, Prüfschritt und Vorschlag. Gut, wenn ein Fehler nach zwei Versuchen noch besteht.{when}"),
            "inputSchema": { "type": "object", "properties": { "problem": { "type": "string", "description": "Fehlerbild: was passiert, was erwartet war, Fehlermeldung/Stacktrace." }, "tried": { "type": "string", "description": "Was schon versucht wurde und warum es nicht half." }, "files": files, "git_diff": git_diff, "diff": diff, "opinions": opinions }, "required": ["problem"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "council_verify",
            "description": format!("Unabhängige Schlussprüfung: Mehrere andere Modelle prüfen eine Behauptung wie „Feature X ist fertig und korrekt“ gegen Code und Belege und urteilen bestätigt, Einwände oder unklar (Mehrheit). Gut, bevor du eine riskante Aufgabe als erledigt meldest.{when}"),
            "inputSchema": { "type": "object", "properties": { "claim": { "type": "string", "description": "Was geprüft werden soll, konkret und überprüfbar." }, "evidence": { "type": "string", "description": "Belege, z. B. Testausgabe oder Befehlsausgabe." }, "files": files, "git_diff": git_diff, "diff": diff, "opinions": opinions }, "required": ["claim"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "council_result",
            "description": "Wartet auf einen Council-Lauf, der beim ersten Aufruf noch nicht fertig war, und liefert sein Ergebnis.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "Lauf-ID aus der vorherigen Antwort (council-run:…)" } }, "required": ["id"] },
            "annotations": { "readOnlyHint": true }
        }
    ])
}

/// Wartet bis zu `secs` auf einen Lauf; liefert Text für den Agenten.
fn wait_for(id: &str, secs: u64) -> String {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match load_run(id) {
            Some(run) if run.status != "läuft" => return render(&run),
            Some(run) if Instant::now() >= deadline => {
                let done = run.opinions.iter().filter(|o| o.status != "wartet").count();
                return format!(
                    "Das Council arbeitet noch ({done} von {} Meinungen da). Rufe council_result mit id \"{id}\" auf, um weiter zu warten.\ncouncil-run:{id}",
                    run.opinions.len()
                );
            }
            None if Instant::now() >= deadline => return format!("Lauf {id} nicht gefunden."),
            _ => std::thread::sleep(Duration::from_millis(400)),
        }
    }
}

fn call_tool(cwd: &str, name: &str, args: &Value, jobs: &mut Vec<std::thread::JoinHandle<()>>) -> CmdResult<String> {
    if name == "council_result" {
        let id = args["id"].as_str().unwrap_or("").trim().trim_start_matches("council-run:").to_string();
        return Ok(wait_for(&id, WAIT_SECS));
    }
    let tool = Tool::from_name(name).ok_or_else(|| format!("Unbekanntes Werkzeug {name}"))?;
    let (run, ctx, plan, cfg) = prepare(cwd, tool, args)?;
    let id = run.id.clone();
    let args = args.clone();
    // Eigener Thread: läuft weiter, wenn der Aufruf vorher zurückkehrt.
    jobs.push(std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("Tokio-Runtime");
        rt.block_on(execute(run, ctx, plan, cfg, args));
    }));
    Ok(wait_for(&id, WAIT_SECS))
}

/// `brise --mcp-council <ordner>`: MCP-Server (stdio, JSON pro Zeile).
pub fn run_mcp_server(cwd: String) {
    let mode = config().mode;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut jobs = vec![];
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue };
        let reply = match msg["method"].as_str().unwrap_or("") {
            "initialize" => json!({ "result": {
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "brise-council", "version": env!("CARGO_PKG_VERSION") },
                "instructions": if mode == "request" {
                    "Model Council: andere Modelle um Rat fragen (Review, Fehlersuche, Schlussprüfung). Nur auf ausdrücklichen Wunsch des Nutzers verwenden. Der Skill `council` beschreibt das Vorgehen."
                } else {
                    "Model Council: andere Modelle um Rat fragen (Review, Fehlersuche, Schlussprüfung). Von dir aus nutzen vor dem Abschluss größerer Änderungen, bei hartnäckigen Fehlern und vor „fertig“ bei riskanten Aufgaben. Der Skill `council` beschreibt das Vorgehen."
                }
            }}),
            "ping" => json!({ "result": {} }),
            "tools/list" => json!({ "result": { "tools": tools(&mode) } }),
            "tools/call" => {
                let p = &msg["params"];
                match call_tool(&cwd, p["name"].as_str().unwrap_or(""), &p["arguments"], &mut jobs) {
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
        jobs.retain(|j| !j.is_finished());
    }
    // Laufende Councils zu Ende bringen, damit Ergebnis und Kosten gespeichert sind.
    for j in jobs {
        let _ = j.join();
    }
}

/// MCP-Eintrag für jede Session, außer das Council ist abgeschaltet.
pub fn mcp_entry(cwd: &str) -> Option<Value> {
    if config().mode == "off" {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    Some(json!({ "name": "brise-council", "command": exe.display().to_string(), "args": ["--mcp-council", cwd], "env": crate::agent::child_env() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bereich_und_pfad() {
        assert_eq!(split_range("src/a.py:10-20"), ("src/a.py", Some((10, 20))));
        assert_eq!(split_range("src/a.py:7"), ("src/a.py", Some((7, 7))));
        assert_eq!(split_range("C:\\x\\a.py"), ("C:\\x\\a.py", None));
        assert_eq!(diff_files("--- a/x.py\n+++ b/x.py\n+++ /dev/null"), vec!["x.py"]);
    }

    #[test]
    fn ausserhalb_abgelehnt() {
        let dir = std::env::temp_dir();
        assert!(resolve(&dir.join("gibt-es-nicht-brise"), "../etc/passwd").is_err());
    }

    #[test]
    fn gruppieren() {
        let a = Opinion { index: 1, status: "fertig".into(), result: json!({"findings":[{"severity":"hoch","file":"a.py","line":10,"title":"Index falsch"}]}), ..Default::default() };
        let b = Opinion { index: 2, status: "fertig".into(), result: json!({"findings":[{"severity":"kritisch","file":"./a.py","line":12,"title":"Off-by-one"},{"severity":"niedrig","file":"b.py","line":1,"title":"x"}]}), ..Default::default() };
        let r = merge_plain(Tool::Review, &[&a, &b]);
        let f = r["findings"].as_array().unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0]["agreement"], "2/2");
        assert_eq!(f[0]["severity"], "kritisch");
        assert_eq!(f[0]["decision"], "bestätigt");
    }

    #[test]
    fn mehrheit() {
        let o = |i, v: &str| Opinion { index: i, status: "fertig".into(), result: json!({"verdict": v, "objections": []}), ..Default::default() };
        let (a, b, c) = (o(1, "bestätigt"), o(2, "bestätigt"), o(3, "einwände"));
        assert_eq!(merge_verify(&[&a, &b, &c])["verdict"], "bestätigt");
        assert_eq!(merge_verify(&[&a, &c])["verdict"], "einwände");
    }
}
