//! Secrets: Passwörter, API-Keys und Tokens, die nie ans Modell gehen.
//!
//! Der Wert liegt nur im System-Schlüsselbund (Dienst `dev.brise.secrets`).
//! Der Agent kennt nur den Platzhalter `{{secret:NAME}}`; eingesetzt wird
//! der echte Wert erst in `brise --mcp-app`, wenn ein Befehl oder HTTP-Aufruf
//! läuft (`run_with_secrets`, `http_request_with_secrets`). Was zurück ans
//! Modell geht, wird vorher geschwärzt.
//!
//! Fordert der Agent ein Secret an (`request_secret`), schreibt der
//! MCP-Server eine Anfrage nach `<Datenordner>/secrets/requests/` – nur Name,
//! Zweck und Session, nie ein Wert. Die laufende App zeigt dafür eine Karte;
//! den eingegebenen Wert legt sie selbst in den Schlüsselbund und antwortet
//! mit einer Statusdatei. In Dateien stehen nur Namen.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const SERVICE: &str = "dev.brise.secrets";
/// Vibe bricht MCP-Werkzeuge nach 60 s ab; so lange wartet ein Aufruf höchstens.
const TOOL_WAIT: Duration = Duration::from_secs(50);
const MAX_OUTPUT: usize = 40_000;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Nur diese Session, bis Brise beendet wird.
    Session,
    /// Alle Sessions in diesem Projektordner.
    Project,
    /// Überall, dauerhaft.
    Global,
}

impl Scope {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "session" => Some(Self::Session),
            "project" => Some(Self::Project),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Session => "nur diese Session",
            Self::Project => "dieses Projekt",
            Self::Global => "dauerhaft",
        }
    }
}

/// Eintrag im Verzeichnis – alles außer dem Wert.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SecretMeta {
    pub name: String,
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub created: u64,
}

impl SecretMeta {
    /// Konto im Schlüsselbund. Hängt vom Datenordner ab, damit getrennte
    /// Instanzen (Tests) sich nicht überschreiben.
    fn account(&self) -> String {
        let key = match self.scope {
            Scope::Session => self.session_id.clone().unwrap_or_default(),
            Scope::Project => short_hash(self.project.as_deref().unwrap_or_default()),
            Scope::Global => "global".into(),
        };
        let scope = match self.scope {
            Scope::Session => "session",
            Scope::Project => "project",
            Scope::Global => "global",
        };
        format!("{}:{scope}:{key}:{}", short_hash(&data_dir().to_string_lossy()), self.name)
    }

    fn same_slot(&self, other: &SecretMeta) -> bool {
        self.account() == other.account()
    }

    fn applies(&self, session: Option<&str>, cwd: Option<&str>) -> bool {
        match self.scope {
            Scope::Session => session.is_some() && self.session_id.as_deref() == session,
            Scope::Project => match (cwd, self.project.as_deref()) {
                (Some(c), Some(p)) => in_project(c, p),
                _ => false,
            },
            Scope::Global => true,
        }
    }
}

fn short_hash(s: &str) -> String {
    Sha256::digest(s.as_bytes())[..6].iter().map(|b| format!("{b:02x}")).collect()
}

fn in_project(cwd: &str, project: &str) -> bool {
    let (c, p) = (Path::new(cwd), Path::new(project));
    c == p || c.starts_with(p)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn dir() -> PathBuf {
    data_dir().join("secrets")
}
fn index_file() -> PathBuf {
    dir().join("index.json")
}
fn requests_dir() -> PathBuf {
    dir().join("requests")
}
fn tags_file() -> PathBuf {
    dir().join("sessions.json")
}

fn entry(account: &str) -> keyring::Result<keyring::Entry> {
    if cfg!(windows) {
        keyring::Entry::new_with_target(&format!("{SERVICE}:{account}"), SERVICE, account)
    } else {
        keyring::Entry::new(SERVICE, account)
    }
}

/// Schreibt erst in eine Nachbardatei und benennt dann um – der andere
/// Prozess liest nie eine halbe Datei.
fn write_atomic(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn read_index() -> Vec<SecretMeta> {
    std::fs::read(index_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_index(list: &[SecretMeta]) -> CmdResult<()> {
    write_atomic(&index_file(), &serde_json::to_vec_pretty(list).unwrap())
}

/// Namen wie Umgebungsvariablen: GROSS, Ziffern, Unterstrich.
pub fn normalize_name(raw: &str) -> CmdResult<String> {
    let name: String = raw.trim().chars().map(|c| if c == '-' || c == ' ' || c == '.' { '_' } else { c.to_ascii_uppercase() }).collect();
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if ok { Ok(name) } else { Err(format!("Ungültiger Secret-Name „{raw}“: erlaubt sind A–Z, 0–9 und _, beginnend mit einem Buchstaben.")) }
}

pub fn placeholder(name: &str) -> String {
    format!("{{{{secret:{name}}}}}")
}

fn placeholder_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{secret:([A-Za-z][A-Za-z0-9_]*)\}\}").unwrap())
}

/// Sichtbare Secrets in einem Kontext; bei gleichem Namen gewinnt Session vor Projekt vor dauerhaft.
pub fn visible(index: &[SecretMeta], session: Option<&str>, cwd: Option<&str>) -> Vec<SecretMeta> {
    let rank = |s: Scope| match s {
        Scope::Session => 0,
        Scope::Project => 1,
        Scope::Global => 2,
    };
    let mut best: HashMap<String, SecretMeta> = HashMap::new();
    for m in index.iter().filter(|m| m.applies(session, cwd)) {
        match best.get(&m.name) {
            Some(b) if rank(b.scope) < rank(m.scope) => {}
            Some(b) if rank(b.scope) == rank(m.scope) && b.project.as_ref().map_or(0, String::len) >= m.project.as_ref().map_or(0, String::len) => {}
            _ => {
                best.insert(m.name.clone(), m.clone());
            }
        }
    }
    let mut list: Vec<SecretMeta> = best.into_values().collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

fn read_value(meta: &SecretMeta) -> CmdResult<String> {
    entry(&meta.account()).and_then(|e| e.get_password()).map_err(|e| format!("Secret {} nicht im Schlüsselbund lesbar: {e}", meta.name))
}

/// Legt ein Secret an oder ersetzt es (gleicher Name und Geltungsbereich).
pub fn store(meta: SecretMeta, value: &str) -> CmdResult<SecretMeta> {
    if value.is_empty() {
        return Err("Leerer Wert".into());
    }
    if meta.scope == Scope::Session && meta.session_id.is_none() {
        return Err("Für „nur diese Session“ fehlt die Session.".into());
    }
    if meta.scope == Scope::Project && meta.project.is_none() {
        return Err("Für „dieses Projekt“ fehlt der Projektordner.".into());
    }
    entry(&meta.account())
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("Schlüsselbund nicht verfügbar ({e}). Ohne Schlüsselbund speichert Brise keine Secrets."))?;
    let mut index = read_index();
    index.retain(|m| !m.same_slot(&meta));
    index.push(meta.clone());
    write_index(&index)?;
    Ok(meta)
}

fn find_slot(name: &str, scope: Scope, project: Option<&str>, session_id: Option<&str>) -> Option<SecretMeta> {
    read_index().into_iter().find(|m| {
        m.name == name
            && m.scope == scope
            && match scope {
                Scope::Session => m.session_id.as_deref() == session_id,
                Scope::Project => m.project.as_deref() == project,
                Scope::Global => true,
            }
    })
}

fn remove(meta: &SecretMeta) -> CmdResult<()> {
    if let Ok(e) = entry(&meta.account()) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("Löschen im Schlüsselbund fehlgeschlagen: {e}")),
        }
    }
    let mut index = read_index();
    index.retain(|m| !m.same_slot(meta));
    write_index(&index)
}

// ---------- Schwärzen und Einsetzen ----------

/// Ersetzt Secret-Werte (auch base64-, hex- und URL-kodiert) durch den Platzhalter.
pub struct Redactor {
    pairs: Vec<(String, String)>,
}

impl Redactor {
    pub fn new(values: &[(String, String)]) -> Self {
        let mut pairs = Vec::new();
        for (name, value) in values {
            // Sehr kurze Werte würden beliebigen Text zerschießen.
            if value.chars().count() < 4 {
                continue;
            }
            let ph = placeholder(name);
            let b = value.as_bytes();
            let variants = [
                value.clone(),
                base64::engine::general_purpose::STANDARD.encode(b),
                base64::engine::general_purpose::STANDARD_NO_PAD.encode(b),
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b),
                b.iter().map(|x| format!("{x:02x}")).collect(),
                b.iter().map(|x| format!("{x:02X}")).collect(),
                percent_encode(value),
                serde_json::to_string(value).unwrap_or_default().trim_matches('"').to_string(),
            ];
            for v in variants {
                if v.len() >= 4 && !pairs.iter().any(|(p, _): &(String, String)| *p == v) {
                    pairs.push((v, ph.clone()));
                }
            }
        }
        // Längste zuerst, damit ein Wert nicht nur teilweise ersetzt wird.
        pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        Self { pairs }
    }

    pub fn apply(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (value, ph) in &self.pairs {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), ph);
            }
        }
        out
    }
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn env_var(name: &str) -> String {
    format!("BRISE_SECRET_{name}")
}

/// Ersetzt Platzhalter in einem Shell-Befehl durch Verweise auf
/// Umgebungsvariablen – der Wert steht so nie in der Befehlszeile (und damit
/// nicht in `ps`). Unter Unix je nach Quoting-Zustand passend eingebettet.
pub fn shell_substitute(command: &str) -> (String, Vec<String>) {
    let mut names = Vec::new();
    let mut out = String::new();
    let mut last = 0;
    for cap in placeholder_re().captures_iter(command) {
        let m = cap.get(0).unwrap();
        let name = cap[1].to_string();
        out.push_str(&command[last..m.start()]);
        let var = env_var(&name);
        if cfg!(windows) {
            out.push_str(&format!("%{var}%"));
        } else {
            match quote_state(&command[..m.start()]) {
                Quote::Single => out.push_str(&format!("'\"${{{var}}}\"'")),
                Quote::Double => out.push_str(&format!("${{{var}}}")),
                Quote::None => out.push_str(&format!("\"${{{var}}}\"")),
            }
        }
        if !names.contains(&name) {
            names.push(name);
        }
        last = m.end();
    }
    out.push_str(&command[last..]);
    (out, names)
}

#[derive(PartialEq, Debug)]
enum Quote {
    None,
    Single,
    Double,
}

fn quote_state(prefix: &str) -> Quote {
    let mut state = Quote::None;
    let mut escaped = false;
    for c in prefix.chars() {
        match state {
            Quote::Single => {
                if c == '\'' {
                    state = Quote::None;
                }
            }
            _ if escaped => escaped = false,
            Quote::Double => match c {
                '\\' => escaped = true,
                '"' => state = Quote::None,
                _ => {}
            },
            Quote::None => match c {
                '\\' => escaped = true,
                '\'' => state = Quote::Single,
                '"' => state = Quote::Double,
                _ => {}
            },
        }
    }
    state
}

/// Setzt echte Werte direkt in einen Text ein (HTTP-Aufrufe, Umgebung).
fn substitute_values(text: &str, values: &HashMap<String, String>) -> String {
    placeholder_re().replace_all(text, |c: &regex::Captures| values.get(&c[1]).cloned().unwrap_or_else(|| c[0].to_string())).to_string()
}

fn names_in(text: &str) -> Vec<String> {
    placeholder_re().captures_iter(text).map(|c| c[1].to_string()).collect()
}

// ---------- Kontext im MCP-Server ----------

/// Wo läuft der MCP-Server? Kommt aus der Umgebung, die Brise beim Start der Session setzt.
struct Ctx {
    tag: Option<String>,
    cwd: Option<String>,
}

impl Ctx {
    fn from_env() -> Self {
        Self { tag: std::env::var("BRISE_SECRET_TAG").ok().filter(|s| !s.is_empty()), cwd: std::env::var("BRISE_CWD").ok().filter(|s| !s.is_empty()) }
    }
    fn session(&self) -> Option<String> {
        session_for_tag(self.tag.as_deref()?)
    }
}

/// Session zu einer Kennung: `s:<id>` direkt, sonst die Zuordnung, die Brise
/// nach `session/new` einträgt.
pub(crate) fn session_for_tag(tag: &str) -> Option<String> {
    if let Some(id) = tag.strip_prefix("s:") {
        return Some(id.to_string());
    }
    let map: HashMap<String, String> = std::fs::read(tags_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    map.get(tag).cloned()
}

/// Kennung für eine neue Session, deren ID noch nicht feststeht.
pub fn new_tag() -> String {
    let mut b = [0u8; 9];
    let _ = getrandom::fill(&mut b);
    format!("n:{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Nach `session/new`: Kennung → Session-ID merken.
pub fn bind_tag(tag: &str, session_id: &str) {
    let mut map: HashMap<String, String> = std::fs::read(tags_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    map.insert(tag.to_string(), session_id.to_string());
    let _ = write_atomic(&tags_file(), &serde_json::to_vec(&map).unwrap());
}

/// Umgebung für `brise --mcp-app`: Projekt und Session-Kennung.
pub fn mcp_env(cwd: &str, tag: &str) -> Vec<Value> {
    vec![json!({ "name": "BRISE_CWD", "value": cwd }), json!({ "name": "BRISE_SECRET_TAG", "value": tag })]
}

/// Werte für die Namen; unbekannte Namen sind ein Fehler mit Liste der bekannten.
fn resolve(ctx: &Ctx, names: &[String]) -> CmdResult<HashMap<String, String>> {
    let session = ctx.session();
    let list = visible(&read_index(), session.as_deref(), ctx.cwd.as_deref());
    let mut values = HashMap::new();
    for name in names {
        let Some(meta) = list.iter().find(|m| &m.name == name) else {
            let known = list.iter().map(|m| m.name.as_str()).collect::<Vec<_>>().join(", ");
            return Err(format!(
                "Secret {name} gibt es hier nicht{}. Fordere es mit request_secret an.",
                if known.is_empty() { String::new() } else { format!(" (vorhanden: {known})") }
            ));
        };
        values.insert(name.clone(), read_value(meta)?);
    }
    Ok(values)
}

// ---------- Anfragen an die Oberfläche ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub name: String,
    pub purpose: String,
    /// Vorschlag des Agenten; der Nutzer entscheidet.
    pub scope: Scope,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub created: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    /// "saved" oder "declined".
    status: String,
    #[serde(default)]
    scope: Option<Scope>,
}

fn req_path(id: &str) -> PathBuf {
    requests_dir().join(format!("{id}.req.json"))
}
fn res_path(id: &str) -> PathBuf {
    requests_dir().join(format!("{id}.res.json"))
}

fn read_requests() -> Vec<Request> {
    let Ok(rd) = std::fs::read_dir(requests_dir()) else { return vec![] };
    let mut list: Vec<Request> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".req.json"))
        .filter_map(|e| std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice(&b).ok()))
        .collect();
    list.sort_by_key(|r: &Request| r.created);
    list
}

fn request_secret(ctx: &Ctx, args: &Value) -> CmdResult<String> {
    let name = normalize_name(args["name"].as_str().ok_or("name fehlt")?)?;
    let purpose = args["purpose"].as_str().unwrap_or("").trim().chars().take(300).collect::<String>();
    let scope = args["scope"].as_str().and_then(Scope::parse).unwrap_or(Scope::Project);
    let renew = args["replace"].as_bool().unwrap_or(false);
    let session = ctx.session();
    if !renew {
        if let Some(m) = visible(&read_index(), session.as_deref(), ctx.cwd.as_deref()).into_iter().find(|m| m.name == name) {
            return Ok(format!("Secret {name} ist schon vorhanden ({}). Platzhalter: {}", m.scope.label(), placeholder(&name)));
        }
    }
    // Läuft schon eine Anfrage mit diesem Namen (vorheriger Aufruf ohne Antwort)? Dann weiter warten.
    let existing = read_requests().into_iter().find(|r| r.name == name && r.tag == ctx.tag);
    let id = match existing {
        Some(r) => r.id,
        None => {
            let mut b = [0u8; 8];
            let _ = getrandom::fill(&mut b);
            let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
            let req = Request { id: id.clone(), name: name.clone(), purpose, scope, tag: ctx.tag.clone(), session_id: session, cwd: ctx.cwd.clone(), created: now_ms() };
            write_atomic(&req_path(&id), &serde_json::to_vec(&req).unwrap())?;
            id
        }
    };
    let deadline = Instant::now() + TOOL_WAIT;
    while Instant::now() < deadline {
        if let Some(answer) = std::fs::read(res_path(&id)).ok().and_then(|b| serde_json::from_slice::<Answer>(&b).ok()) {
            let _ = std::fs::remove_file(res_path(&id));
            let _ = std::fs::remove_file(req_path(&id));
            return if answer.status == "saved" {
                Ok(format!(
                    "Der Nutzer hat {name} gespeichert ({}). Verwende im Befehl, in Headern oder in der Umgebung den Platzhalter {} – \
                     mit run_with_secrets oder http_request_with_secrets wird der echte Wert erst bei der Ausführung eingesetzt. \
                     Den Wert selbst bekommst du nie zu sehen.",
                    answer.scope.unwrap_or(scope).label(),
                    placeholder(&name)
                ))
            } else {
                Err(format!("Der Nutzer hat die Eingabe von {name} abgelehnt. Frag nicht erneut, sondern kläre im Chat, wie es weitergehen soll."))
            };
        }
        if !req_path(&id).exists() {
            return Err("Die Anfrage wurde in Brise verworfen.".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ok(format!(
        "Brise zeigt dem Nutzer die Eingabe für {name}, er hat aber noch nicht geantwortet. \
         Rufe request_secret mit demselben Namen noch einmal auf, um weiter zu warten."
    ))
}

// ---------- Ausführen mit Secrets ----------

fn run_with_secrets(ctx: &Ctx, args: &Value) -> CmdResult<String> {
    let command = args["command"].as_str().ok_or("command fehlt")?;
    let env_args: Vec<(String, String)> =
        args["env"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect()).unwrap_or_default();
    let (shell_cmd, mut names) = shell_substitute(command);
    for (_, v) in &env_args {
        for n in names_in(v) {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    if names.is_empty() {
        return Err("Der Befehl enthält keinen Platzhalter {{secret:NAME}}. Für Befehle ohne Secrets das normale Shell-Werkzeug nehmen.".into());
    }
    let values = resolve(ctx, &names)?;
    let redactor = Redactor::new(&values.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>());
    let cwd = args["cwd"].as_str().map(str::to_string).or_else(|| ctx.cwd.clone());
    let timeout = Duration::from_secs(args["timeoutSec"].as_u64().unwrap_or(45).clamp(1, 55));

    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &shell_cmd]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &shell_cmd]);
        c
    };
    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }
    for (name, value) in &values {
        cmd.env(env_var(name), value);
    }
    for (k, v) in &env_args {
        cmd.env(k, substitute_values(v, &values));
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Start fehlgeschlagen: {e}"))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(s);
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).to_string();
    let mut text = String::new();
    match status {
        Some(s) => text.push_str(&format!("Exit-Code: {}\n", s.code().map_or("–".into(), |c| c.to_string()))),
        None => text.push_str(&format!("Abgebrochen nach {} s\n", timeout.as_secs())),
    }
    if !stdout.is_empty() {
        text.push_str("--- stdout ---\n");
        text.push_str(&tail(&stdout));
        text.push('\n');
    }
    if !stderr.is_empty() {
        text.push_str("--- stderr ---\n");
        text.push_str(&tail(&stderr));
    }
    Ok(redactor.apply(&text))
}

fn tail(s: &str) -> String {
    if s.len() <= MAX_OUTPUT {
        return s.to_string();
    }
    let mut start = s.len() - MAX_OUTPUT;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[… gekürzt …]\n{}", &s[start..])
}

fn http_request(ctx: &Ctx, args: &Value) -> CmdResult<String> {
    let url = args["url"].as_str().ok_or("url fehlt")?.to_string();
    let method = args["method"].as_str().unwrap_or("GET").to_uppercase();
    let headers: Vec<(String, String)> =
        args["headers"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect()).unwrap_or_default();
    let body = args["body"].as_str().map(str::to_string);
    let mut names = names_in(&url);
    for (_, v) in &headers {
        names.extend(names_in(v));
    }
    if let Some(b) = &body {
        names.extend(names_in(b));
    }
    names.sort();
    names.dedup();
    let values = resolve(ctx, &names)?;
    let redactor = Redactor::new(&values.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let result: CmdResult<String> = rt.block_on(async {
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| format!("Unbekannte Methode {method}"))?;
        let mut req = reqwest::Client::new().request(method, substitute_values(&url, &values)).timeout(TOOL_WAIT);
        for (k, v) in &headers {
            req = req.header(k.as_str(), substitute_values(v, &values));
        }
        if let Some(b) = &body {
            req = req.body(substitute_values(b, &values));
        }
        let resp = req.send().await.map_err(|e| format!("Anfrage fehlgeschlagen: {e}"))?;
        let status = resp.status();
        let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let text = resp.text().await.unwrap_or_default();
        Ok(format!("HTTP {status}\nContent-Type: {ctype}\n\n{}", tail(&text)))
    });
    // Auch Fehlermeldungen können die URL samt Secret enthalten.
    result.map(|t| redactor.apply(&t)).map_err(|e| redactor.apply(&e))
}

fn list_tool(ctx: &Ctx) -> String {
    let list = visible(&read_index(), ctx.session().as_deref(), ctx.cwd.as_deref());
    if list.is_empty() {
        return "Keine Secrets verfügbar. Mit request_secret kannst du eines anfordern.".into();
    }
    list.iter()
        .map(|m| format!("{} – {}{}", placeholder(&m.name), m.scope.label(), if m.purpose.is_empty() { String::new() } else { format!(" – {}", m.purpose) }))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Werkzeuge für `brise --mcp-app`.
pub fn tools() -> Vec<Value> {
    vec![
        json!({
            "name": "request_secret",
            "description": "Fordert ein Secret (Passwort, API-Key, Token) beim Nutzer an. Brise zeigt dafür ein eigenes, maskiertes Eingabefeld; \
                der Wert landet im Schlüsselbund und geht nie an dich. Du bekommst nur den Platzhalter {{secret:NAME}}. \
                Bitte den Nutzer nie, ein Secret in den Chat zu schreiben – nutze immer dieses Werkzeug.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Name wie eine Umgebungsvariable, z. B. GITHUB_TOKEN" },
                    "purpose": { "type": "string", "description": "Wofür das Secret gebraucht wird (ein Satz, wird dem Nutzer gezeigt)" },
                    "scope": { "type": "string", "enum": ["session", "project", "global"], "description": "Vorschlag für die Gültigkeit; der Nutzer entscheidet" },
                    "replace": { "type": "boolean", "description": "true, um ein vorhandenes Secret neu abzufragen (z. B. abgelaufen)" }
                },
                "required": ["name", "purpose"]
            }
        }),
        json!({
            "name": "list_secrets",
            "description": "Listet die Secrets, die in dieser Session verfügbar sind (nur Namen und Zweck, nie Werte).",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "run_with_secrets",
            "description": "Führt einen Shell-Befehl aus und setzt Platzhalter {{secret:NAME}} erst bei der Ausführung ein (als Umgebungsvariable, \
                nicht in der Befehlszeile). Zusätzlich kann `env` Umgebungsvariablen mit Platzhaltern setzen, z. B. {\"GH_TOKEN\": \"{{secret:GITHUB_TOKEN}}\"}. \
                Die Ausgabe wird vor der Rückgabe geschwärzt. Höchstens 55 s Laufzeit.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "env": { "type": "object", "additionalProperties": { "type": "string" } },
                    "cwd": { "type": "string", "description": "Arbeitsordner (Standard: Projekt)" },
                    "timeoutSec": { "type": "integer", "minimum": 1, "maximum": 55 }
                },
                "required": ["command"]
            }
        }),
        json!({
            "name": "http_request_with_secrets",
            "description": "HTTP-Aufruf, bei dem Platzhalter {{secret:NAME}} in URL, Headern und Body erst beim Senden eingesetzt werden. \
                Die Antwort wird vor der Rückgabe geschwärzt.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": { "type": "string", "description": "GET, POST, PUT, PATCH, DELETE …" },
                    "url": { "type": "string" },
                    "headers": { "type": "object", "additionalProperties": { "type": "string" } },
                    "body": { "type": "string" }
                },
                "required": ["url"]
            }
        }),
    ]
}

/// `None`, wenn das Werkzeug nicht zu den Secrets gehört.
pub fn call_tool(name: &str, args: &Value) -> Option<CmdResult<String>> {
    let ctx = Ctx::from_env();
    Some(match name {
        "request_secret" => request_secret(&ctx, args),
        "list_secrets" => Ok(list_tool(&ctx)),
        "run_with_secrets" => run_with_secrets(&ctx, args),
        "http_request_with_secrets" => http_request(&ctx, args),
        _ => return None,
    })
}

pub const MCP_INSTRUCTIONS: &str = "Secrets (Passwörter, API-Keys, Tokens) nie im Chat erfragen oder ausgeben: mit request_secret anfordern, \
    dann mit run_with_secrets bzw. http_request_with_secrets und dem Platzhalter {{secret:NAME}} verwenden. \
    Steht ein Platzhalter {{secret:NAME}} in der Nachricht des Nutzers, ist das ein solches Secret.";

// ---------- App-Seite ----------

/// Beim Start: Session-Secrets der letzten Sitzung und alte Anfragen entfernen.
pub fn startup_cleanup() {
    for m in read_index().into_iter().filter(|m| m.scope == Scope::Session) {
        let _ = remove(&m);
    }
    let _ = std::fs::remove_dir_all(requests_dir());
    let _ = std::fs::remove_file(tags_file());
}

/// Beobachtet neue Anfragen der MCP-Server und meldet sie an die Oberfläche.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let current = read_requests();
            seen.retain(|id| current.iter().any(|r| &r.id == id));
            for r in current {
                if seen.insert(r.id.clone()) {
                    let _ = app.emit("secrets:request", with_session(r));
                }
            }
        }
    });
}

fn with_session(mut r: Request) -> Request {
    if r.session_id.is_none() {
        r.session_id = r.tag.as_deref().and_then(session_for_tag);
    }
    r
}

fn parse_scope(scope: &str) -> CmdResult<Scope> {
    Scope::parse(scope).ok_or_else(|| format!("Unbekannter Geltungsbereich {scope}"))
}

/// Offene Anfragen, etwa nach einem Neuladen der Oberfläche.
#[tauri::command]
pub fn secrets_pending() -> Vec<Request> {
    read_requests().into_iter().map(with_session).collect()
}

/// Antwort auf eine Anfrage: `value` fehlt = abgelehnt.
#[tauri::command]
pub fn secret_answer(request_id: String, value: Option<String>, scope: String) -> CmdResult<Value> {
    let req: Request = std::fs::read(req_path(&request_id)).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or("Diese Anfrage ist nicht mehr offen")?;
    let req = with_session(req);
    let scope = parse_scope(&scope)?;
    let answer = match value.filter(|v| !v.is_empty()) {
        Some(value) => {
            let meta = SecretMeta { name: req.name.clone(), scope, project: req.cwd.clone(), session_id: req.session_id.clone(), purpose: req.purpose.clone(), created: now_ms() };
            let meta = SecretMeta { project: (scope == Scope::Project).then_some(meta.project).flatten(), session_id: (scope == Scope::Session).then_some(meta.session_id).flatten(), ..meta };
            store(meta, &value)?;
            Answer { status: "saved".into(), scope: Some(scope) }
        }
        None => Answer { status: "declined".into(), scope: None },
    };
    let status = answer.status.clone();
    write_atomic(&res_path(&request_id), &serde_json::to_vec(&answer).unwrap())?;
    Ok(json!({ "status": status, "name": req.name, "placeholder": placeholder(&req.name) }))
}

/// Secret selbst anlegen (Composer oder Einstellungen). Liefert den Platzhalter.
#[tauri::command]
pub fn secret_save(name: String, value: String, scope: String, session_id: Option<String>, cwd: Option<String>, purpose: Option<String>) -> CmdResult<String> {
    let name = normalize_name(&name)?;
    let scope = parse_scope(&scope)?;
    let meta = SecretMeta {
        name: name.clone(),
        scope,
        project: if scope == Scope::Project { cwd } else { None },
        session_id: if scope == Scope::Session { session_id } else { None },
        purpose: purpose.unwrap_or_default(),
        created: now_ms(),
    };
    store(meta, value.trim_end_matches(['\r', '\n']))?;
    Ok(placeholder(&name))
}

/// Alle Secrets (nur Namen und Geltungsbereich).
#[tauri::command]
pub fn secrets_list() -> Vec<SecretMeta> {
    let mut list = read_index();
    list.sort_by(|a, b| a.name.cmp(&b.name).then(a.created.cmp(&b.created)));
    list
}

#[tauri::command]
pub fn secret_delete(name: String, scope: String, project: Option<String>, session_id: Option<String>) -> CmdResult<()> {
    let meta = find_slot(&name, parse_scope(&scope)?, project.as_deref(), session_id.as_deref()).ok_or("Secret nicht gefunden")?;
    remove(&meta)
}

/// Geltungsbereich ändern; für „Projekt“ braucht es `new_project`, für „Session“ `new_session_id`.
#[tauri::command]
pub fn secret_set_scope(
    name: String,
    scope: String,
    project: Option<String>,
    session_id: Option<String>,
    new_scope: String,
    new_project: Option<String>,
    new_session_id: Option<String>,
) -> CmdResult<SecretMeta> {
    let old = find_slot(&name, parse_scope(&scope)?, project.as_deref(), session_id.as_deref()).ok_or("Secret nicht gefunden")?;
    let new_scope = parse_scope(&new_scope)?;
    let new = SecretMeta {
        scope: new_scope,
        project: if new_scope == Scope::Project { new_project.or(old.project.clone()) } else { None },
        session_id: if new_scope == Scope::Session { new_session_id.or(old.session_id.clone()) } else { None },
        ..old.clone()
    };
    if new.same_slot(&old) {
        return Ok(old);
    }
    let value = read_value(&old)?;
    let saved = store(new, &value)?;
    remove(&old)?;
    Ok(saved)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub label: String,
    /// Fundstelle in UTF-16-Einheiten, passend zu JavaScript-Strings.
    pub start: usize,
    pub end: usize,
    /// Vorschlag für den Namen.
    pub name: String,
    /// Maskiert, zum Wiedererkennen.
    pub sample: String,
}

/// Findet Zugangsdaten im Composer-Text (lokal, ohne Netz).
#[tauri::command]
pub fn secret_scan(text: String) -> Vec<Found> {
    let utf16 = |byte: usize| text[..byte].encode_utf16().count();
    // Platzhalter selbst (`{{secret:NAME}}`) sind keine Zugangsdaten.
    let placeholders: Vec<(usize, usize)> = placeholder_re().find_iter(&text).map(|m| (m.start(), m.end())).collect();
    crate::sensitive::credential_spans(&text)
        .into_iter()
        .filter(|(_, s, e)| !placeholders.iter().any(|(ps, pe)| s < pe && ps < e))
        .map(|(label, s, e)| Found { name: suggest_name(label).into(), sample: crate::credentials::hint(&text[s..e]), label: label.into(), start: utf16(s), end: utf16(e) })
        .collect()
}

fn suggest_name(label: &str) -> &'static str {
    match label {
        "GitHub-Token" => "GITHUB_TOKEN",
        "AWS-Zugangsschlüssel" => "AWS_ACCESS_KEY_ID",
        "Slack-Token" => "SLACK_TOKEN",
        "API-Schlüssel (sk-…)" => "API_KEY",
        "Google-API-Schlüssel" => "GOOGLE_API_KEY",
        "JWT" => "JWT_TOKEN",
        "Privater Schlüssel" => "PRIVATE_KEY",
        "Verbindungs-URL mit Passwort" => "DB_PASSWORD",
        _ => "PASSWORD",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(normalize_name("github-token").unwrap(), "GITHUB_TOKEN");
        assert!(normalize_name("1ABC").is_err());
        assert!(normalize_name("A$B").is_err());
    }

    #[test]
    fn shell_quoting() {
        let (cmd, names) = shell_substitute("curl -H \"Authorization: Bearer {{secret:GH}}\" x");
        assert_eq!(names, vec!["GH"]);
        if !cfg!(windows) {
            assert_eq!(cmd, "curl -H \"Authorization: Bearer ${BRISE_SECRET_GH}\" x");
            assert_eq!(shell_substitute("echo {{secret:A}}").0, "echo \"${BRISE_SECRET_A}\"");
            assert_eq!(shell_substitute("echo 'x {{secret:A}} y'").0, "echo 'x '\"${BRISE_SECRET_A}\"' y'");
            assert_eq!(shell_substitute("echo \"it's\" {{secret:A}}").0, "echo \"it's\" \"${BRISE_SECRET_A}\"");
        }
    }

    #[test]
    fn redaction_covers_encodings() {
        let r = Redactor::new(&[("TOK".into(), "s3cr3t-Wert!".into())]);
        let b64 = base64::engine::general_purpose::STANDARD.encode("s3cr3t-Wert!");
        let out = r.apply(&format!("a s3cr3t-Wert! b {b64} c s3cr3t-Wert%21"));
        assert!(!out.contains("s3cr3t"));
        assert!(!out.contains(&b64));
        assert_eq!(out.matches("{{secret:TOK}}").count(), 3);
    }

    #[test]
    fn short_values_are_not_redacted() {
        assert_eq!(Redactor::new(&[("X".into(), "ab".into())]).apply("abc"), "abc");
    }

    #[test]
    fn precedence() {
        let m = |scope, project: Option<&str>, sid: Option<&str>, purpose: &str| SecretMeta {
            name: "T".into(),
            scope,
            project: project.map(Into::into),
            session_id: sid.map(Into::into),
            purpose: purpose.into(),
            created: 0,
        };
        let index = vec![m(Scope::Global, None, None, "g"), m(Scope::Project, Some("/p"), None, "p"), m(Scope::Session, None, Some("s1"), "s")];
        assert_eq!(visible(&index, Some("s1"), Some("/p/sub"))[0].purpose, "s");
        assert_eq!(visible(&index, Some("s2"), Some("/p"))[0].purpose, "p");
        assert_eq!(visible(&index, None, Some("/q"))[0].purpose, "g");
        assert!(visible(&index[1..2], None, Some("/pq")).is_empty());
    }

    #[test]
    fn substitutes_values() {
        let v = HashMap::from([("A".to_string(), "1".to_string())]);
        assert_eq!(substitute_values("x={{secret:A}}&y={{secret:B}}", &v), "x=1&y={{secret:B}}");
    }
}
