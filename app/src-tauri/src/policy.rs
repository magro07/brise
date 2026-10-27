//! Team-Richtlinien: was ein Mitglied in seinem Brise ändern und nutzen darf.
//!
//! Ein Team-Admin legt sie im signierten Team-Stand fest (siehe
//! `collab/team.rs` und docs/adr/0005-team-workspaces.md). Der zuletzt gültige
//! Stand jedes Teams liegt in `<Datenordner>/teams/<id>.json` und wird beim Lesen
//! erneut geprüft – so sehen auch Brises MCP-Prozesse dieselben Regeln.
//!
//! Commands rufen die `check_*`-Funktionen auf, bevor sie etwas ändern oder
//! einen Prompt schicken. Das ist eine Leitplanke, keine Sicherheitsgrenze:
//! Auf einem fremden Rechner lässt sich ein lokales Programm umgehen. Echt
//! durchgesetzt wird nur beim Host eines geteilten Abos (`collab/mod.rs`).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use toml_edit::{Item, value};

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const DOMAIN: &str = "brise-team-v1";
/// So viele Einträge behält das Audit-Log.
pub const AUDIT_MAX: usize = 200;

/// Zugriff auf einen Einstellungsbereich.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Hidden,
    Read,
    #[default]
    Edit,
}

/// Richtlinie für ein Mitglied. `None` bzw. fehlend heißt: nicht eingeschränkt.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    /// Einstellungsbereich (IDs wie in der Oberfläche) → Zugriff. Fehlt = `edit`.
    pub sections: BTreeMap<String, Access>,
    pub backends: Option<Vec<String>>,
    pub models: Option<Vec<String>>,
    /// Prompts nur über Cortecs-Modelle (Zero Data Retention).
    pub require_zdr: bool,
    pub eu_native: bool,
    pub secrecy203: bool,
    pub modes: Option<Vec<String>>,
    pub no_auto_edits: bool,
    pub daily_eur: Option<f64>,
    pub monthly_eur: Option<f64>,
    /// Websuche fest an (`true`) oder aus (`false`).
    pub web_search: Option<bool>,
    pub mcp_servers: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    /// Tageslimits auf geteilten Abos (setzt der Host durch).
    pub shared_daily_prompts: Option<u32>,
    pub shared_daily_tokens: Option<u64>,
    /// Master-Session (ADR 0006): `false` sperrt das Starten von Untersessions.
    pub orchestra: Option<bool>,
    /// Höchstzahl gleichzeitiger Untersessions.
    pub max_sub_sessions: Option<u32>,
    /// Computer Use: `false` sperrt Bildschirm und Eingaben für Agenten.
    pub computer_use: Option<bool>,
}

/// Modi, die Änderungen ohne Rückfrage ausführen (Vibe und Claude Code).
pub const AUTO_EDIT_MODES: &[&str] = &["accept-edits", "smart-approve", "auto-approve", "acceptEdits", "bypassPermissions", "auto"];

fn both<T: Clone + PartialEq>(a: &Option<Vec<T>>, b: &Option<Vec<T>>) -> Option<Vec<T>> {
    match (a, b) {
        (None, x) | (x, None) => x.clone(),
        (Some(a), Some(b)) => Some(a.iter().filter(|x| b.contains(x)).cloned().collect()),
    }
}

fn min_opt<T: PartialOrd + Copy>(a: Option<T>, b: Option<T>) -> Option<T> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if b < a { b } else { a }),
        (a, b) => a.or(b),
    }
}

impl Policy {
    /// Strengste Kombination zweier Richtlinien (mehrere Teams).
    pub fn merge(&self, other: &Policy) -> Policy {
        let mut sections = self.sections.clone();
        for (k, v) in &other.sections {
            let e = sections.entry(k.clone()).or_default();
            *e = (*e).min(*v);
        }
        Policy {
            sections,
            backends: both(&self.backends, &other.backends),
            models: both(&self.models, &other.models),
            require_zdr: self.require_zdr || other.require_zdr,
            eu_native: self.eu_native || other.eu_native,
            secrecy203: self.secrecy203 || other.secrecy203,
            modes: both(&self.modes, &other.modes),
            no_auto_edits: self.no_auto_edits || other.no_auto_edits,
            daily_eur: min_opt(self.daily_eur, other.daily_eur),
            monthly_eur: min_opt(self.monthly_eur, other.monthly_eur),
            // Aus schlägt an.
            web_search: match (self.web_search, other.web_search) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                (a, b) => a.or(b),
            },
            mcp_servers: both(&self.mcp_servers, &other.mcp_servers),
            skills: both(&self.skills, &other.skills),
            shared_daily_prompts: min_opt(self.shared_daily_prompts, other.shared_daily_prompts),
            shared_daily_tokens: min_opt(self.shared_daily_tokens, other.shared_daily_tokens),
            orchestra: match (self.orchestra, other.orchestra) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                (a, b) => a.or(b),
            },
            max_sub_sessions: min_opt(self.max_sub_sessions, other.max_sub_sessions),
            computer_use: match (self.computer_use, other.computer_use) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                (a, b) => a.or(b),
            },
        }
    }

    /// Zugriff auf einen Bereich. Alte Bereichs-IDs (vor der Neugliederung der
    /// Einstellungen) zählen zu ihrem neuen Bereich; es gilt das Strengste.
    pub fn access(&self, section: &str) -> Access {
        let target = canonical_section(section);
        self.sections.iter().filter(|(k, _)| canonical_section(k) == target).map(|(_, v)| *v).min().unwrap_or_default()
    }

    /// Bereiche unter den neuen IDs (für die Oberfläche).
    pub fn normalized(mut self) -> Policy {
        let mut sections = BTreeMap::new();
        for k in self.sections.keys() {
            let id = canonical_section(k).to_string();
            let access = self.access(&id);
            sections.insert(id, access);
        }
        self.sections = sections;
        self
    }

    pub fn mode_allowed(&self, mode: &str) -> bool {
        !(self.no_auto_edits && AUTO_EDIT_MODES.contains(&mode)) && self.modes.as_ref().is_none_or(|m| m.iter().any(|x| x == mode))
    }

    pub fn model_allowed(&self, model: &str) -> bool {
        self.models.as_ref().is_none_or(|m| m.iter().any(|x| x == model))
    }

    pub fn backend_allowed(&self, backend: &str) -> bool {
        self.backends.as_ref().is_none_or(|b| b.iter().any(|x| x == backend))
    }
}

// ---------- Team-Stand ----------

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MemberInfo {
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: u64,
    pub by: String,
    #[serde(default)]
    pub by_name: String,
    pub action: String,
    #[serde(default)]
    pub detail: String,
}

/// Rollen, Richtlinien und Audit-Log eines Teams.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TeamState {
    pub team: String,
    pub version: u64,
    pub owner: String,
    pub admins: Vec<String>,
    pub members: BTreeMap<String, MemberInfo>,
    pub removed: Vec<String>,
    pub default_policy: Policy,
    pub policies: BTreeMap<String, Policy>,
    pub audit: Vec<AuditEntry>,
}

impl TeamState {
    pub fn is_admin(&self, id: &str) -> bool {
        id == self.owner || self.admins.iter().any(|a| a == id)
    }

    /// Richtlinie für dieses Mitglied; Admins sind nicht eingeschränkt.
    pub fn policy_for(&self, id: &str) -> Option<Policy> {
        if self.is_admin(id) {
            return None;
        }
        Some(self.policies.get(id).unwrap_or(&self.default_policy).clone())
    }

    /// Darf `next`, signiert von `by`, diesen Stand ablösen?
    pub fn accepts(&self, next: &TeamState, by: &str) -> Result<(), &'static str> {
        if next.team != self.team || next.owner != self.owner {
            return Err("anderes Team oder anderer Besitzer");
        }
        if next.version <= self.version {
            return Err("veraltet");
        }
        if !self.is_admin(by) {
            return Err("nicht von einem Admin");
        }
        if by != self.owner && self.admins.iter().any(|a| !next.admins.contains(a)) {
            return Err("nur der Besitzer darf Admins absetzen");
        }
        Ok(())
    }
}

/// Unabhängig vom Transport signiertes Dokument (darf weitergereicht werden).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SignedDoc {
    pub by: String,
    pub sig: String,
    pub body: String,
}

pub fn signed_bytes(team: &str, body: &str) -> Vec<u8> {
    format!("{DOMAIN}:{team}:{body}").into_bytes()
}

impl SignedDoc {
    /// Prüft die Signatur und liefert den Team-Stand.
    pub fn open(&self, team: &str) -> Option<TeamState> {
        let key: [u8; 32] = URL_SAFE_NO_PAD.decode(&self.by).ok()?.try_into().ok()?;
        let sig: [u8; 64] = URL_SAFE_NO_PAD.decode(&self.sig).ok()?.try_into().ok()?;
        VerifyingKey::from_bytes(&key).ok()?.verify_strict(&signed_bytes(team, &self.body), &Signature::from_bytes(&sig)).ok()?;
        let state: TeamState = serde_json::from_str(&self.body).ok()?;
        (state.team == team).then_some(state)
    }
}

/// Gespeicherter Stand eines Teams (nur öffentliche Daten).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub name: String,
    /// Eigene ID in diesem Datenordner.
    pub me: String,
    pub doc: SignedDoc,
}

fn teams_dir() -> PathBuf {
    data_dir().join("teams")
}

fn stored_path(team: &str) -> PathBuf {
    teams_dir().join(format!("{team}.json"))
}

pub fn load_stored(team: &str) -> Option<(Stored, TeamState)> {
    let stored: Stored = serde_json::from_slice(&std::fs::read(stored_path(team)).ok()?).ok()?;
    let state = stored.doc.open(team)?;
    state.is_admin(&stored.doc.by).then_some((stored, state))
}

pub fn save_stored(team: &str, stored: &Stored) {
    let _ = std::fs::create_dir_all(teams_dir());
    if let Ok(bytes) = serde_json::to_vec_pretty(stored) {
        let _ = std::fs::write(stored_path(team), bytes);
    }
}

pub fn remove_stored(team: &str) {
    let _ = std::fs::remove_file(stored_path(team));
}

// ---------- Wirksame Richtlinie ----------

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    /// Mindestens ein Team schränkt dieses Brise ein.
    pub managed: bool,
    pub policy: Policy,
    /// Teams, deren Richtlinie gilt (Name).
    pub teams: Vec<String>,
}

/// Alle gespeicherten Team-Stände zu einer Richtlinie zusammengeführt.
pub fn effective() -> Effective {
    let mut out = Effective::default();
    let Ok(entries) = std::fs::read_dir(teams_dir()) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(team) = path.file_stem().and_then(|s| s.to_str()).filter(|_| path.extension().is_some_and(|e| e == "json")) else { continue };
        let Some((stored, state)) = load_stored(team) else { continue };
        if state.removed.contains(&stored.me) {
            continue;
        }
        if let Some(p) = state.policy_for(&stored.me) {
            out.policy = if out.managed { out.policy.merge(&p) } else { p };
            out.managed = true;
            out.teams.push(stored.name);
        }
    }
    out.policy = out.policy.normalized();
    out
}

fn managed_by(e: &Effective) -> String {
    match e.teams.as_slice() {
        [one] => format!("vom Admin des Teams „{one}“"),
        _ => "von deinem Team-Admin".into(),
    }
}

/// Einstellungsbereiche (wie SECTIONS in Settings.tsx und SECTION_LABELS in lib/policy.ts).
pub const SECTION_LABELS: &[(&str, &str)] = &[
    ("general", "Allgemein"),
    ("providers", "Anbieter & Schlüssel"),
    ("agents", "Agenten"),
    ("models", "Modelle & Automatik"),
    ("privacy", "Datenschutz & Sicherheit"),
    ("usage", "Nutzung & Budget"),
    ("tools", "Werkzeuge"),
    ("collab", "Zusammenarbeit & Team"),
    ("advanced", "Erweitert"),
];

/// Alte Bereichs-ID (Brise ≤ 0.2) → neuer Bereich. Team-Richtlinien, die noch
/// alte IDs enthalten, gelten so weiter.
pub fn canonical_section(section: &str) -> &str {
    match section {
        "account" => "providers",
        "backends" => "agents",
        "council" | "orchestra" => "models",
        "permissions" | "cortecs" => "privacy",
        "bench" => "usage",
        "skills" | "web" | "voice" | "embeddings" => "tools",
        other => other,
    }
}

fn label(section: &str) -> &str {
    let id = canonical_section(section);
    SECTION_LABELS.iter().find(|(s, _)| *s == id).map_or(section, |(_, l)| l)
}

/// Darf der Bereich geändert werden?
pub fn check_section(section: &str) -> CmdResult<()> {
    let e = effective();
    check_section_in(&e, section)
}

fn check_section_in(e: &Effective, section: &str) -> CmdResult<()> {
    match e.policy.access(section) {
        Access::Edit => Ok(()),
        _ => Err(format!("POLICY: Der Bereich „{}“ wird {} verwaltet.", label(section), managed_by(e))),
    }
}

/// Einstellungsbereich eines Schlüssels in Vibes config.toml.
pub fn section_of(key: &[String]) -> &'static str {
    let k0 = key.first().map(String::as_str).unwrap_or("");
    let k1 = key.get(1).map(String::as_str).unwrap_or("");
    match k0 {
        // Vibes Modelle und Anbieter stehen unter Agenten → Vibe.
        "active_model" | "auto_compact_threshold" | "show_thinking_nodes" | "models" | "providers" => "agents",
        "default_agent" | "bypass_tool_permissions" | "enable_auto_approve" | "smart_approve_available" => "privacy",
        "tools" if k1 == "bash" => "privacy",
        "tools" if k1.starts_with("web_") => "tools",
        "enable_subagents" | "max_subagents" | "max_concurrent_subagents" | "enable_background_processes" => "agents",
        "enable_mcp" | "enable_connectors" | "mcp_servers" => "tools",
        "active_transcribe_model" | "active_tts_model" => "tools",
        "disabled_skills" | "enabled_skills" | "skill_paths" => "tools",
        _ => "advanced",
    }
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Prüft eine Änderung an Vibes config.toml: Bereich und fest vorgegebene Werte.
pub fn check_config_write(key: &[String], v: &Value) -> CmdResult<()> {
    let e = effective();
    if !e.managed {
        return Ok(());
    }
    check_section_in(&e, section_of(key))?;
    check_config_value(&e, key, v)
}

fn check_config_value(e: &Effective, key: &[String], v: &Value) -> CmdResult<()> {
    let p = &e.policy;
    let deny = |what: &str| Err(format!("POLICY: {what} – {} festgelegt.", managed_by(e)));
    let path: Vec<&str> = key.iter().map(String::as_str).collect();
    match path.as_slice() {
        ["active_model"] => {
            if let Some(m) = v.as_str().filter(|m| !p.model_allowed(m)) {
                return deny(&format!("Das Modell „{m}“ ist nicht freigegeben"));
            }
        }
        ["default_agent"] => {
            if let Some(m) = v.as_str().filter(|m| !p.mode_allowed(m)) {
                return deny(&format!("Der Freigabe-Modus „{m}“ ist nicht erlaubt"));
            }
        }
        ["bypass_tool_permissions"] | ["enable_auto_approve"] if p.no_auto_edits && v == &json!(true) => {
            return deny("Automatische Freigaben sind gesperrt");
        }
        ["tools", "web_search" | "web_fetch", "permission"] | ["tools", "web_search" | "web_fetch"] => {
            if let Some(on) = p.web_search {
                let perm = if path.len() == 3 { v.as_str() } else { v["permission"].as_str() };
                if (perm == Some("never")) == on {
                    return deny(if on { "Die Websuche ist eingeschaltet" } else { "Die Websuche ist ausgeschaltet" });
                }
            }
        }
        ["mcp_servers"] => {
            if let (Some(allowed), Some(list)) = (&p.mcp_servers, v.as_array()) {
                for s in list.iter().filter(|s| s["disabled"] != json!(true)) {
                    let name = s["name"].as_str().unwrap_or("");
                    if !allowed.iter().any(|a| a == name) {
                        return deny(&format!("Der MCP-Server „{name}“ ist nicht freigegeben"));
                    }
                }
            }
        }
        ["enable_mcp"] if p.mcp_servers.as_ref().is_some_and(Vec::is_empty) && v == &json!(true) => {
            return deny("MCP-Server sind gesperrt");
        }
        ["disabled_skills"] => {
            if let Some(allowed) = &p.skills {
                let disabled = str_list(v);
                if let Some(s) = crate::skills::list_skills(None).into_iter().map(|s| s.name).find(|n| !allowed.contains(n) && !disabled.contains(n)) {
                    return deny(&format!("Der Skill „{s}“ ist nicht freigegeben"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn check_backend(backend: &str) -> CmdResult<()> {
    let e = effective();
    if e.policy.backend_allowed(backend) {
        Ok(())
    } else {
        Err(format!("POLICY: Das Backend „{backend}“ ist {} nicht freigegeben.", managed_by(&e)))
    }
}

/// Darf diese Installation Untersessions starten (Master-Session)?
pub fn check_orchestra() -> CmdResult<()> {
    let e = effective();
    if e.policy.orchestra == Some(false) {
        return Err(format!("POLICY: Die Master-Session (Untersessions starten) ist {} gesperrt.", managed_by(&e)));
    }
    Ok(())
}

/// Darf diese Installation Agenten den Bildschirm sehen und bedienen lassen?
pub fn check_computer_use() -> CmdResult<()> {
    let e = effective();
    if e.policy.computer_use == Some(false) {
        return Err(format!("POLICY: Computer Use ist {} gesperrt.", managed_by(&e)));
    }
    Ok(())
}

/// Höchstzahl gleichzeitiger Untersessions laut Team-Richtlinie.
pub fn max_sub_sessions() -> Option<u32> {
    effective().policy.max_sub_sessions
}

pub fn check_mode(mode: &str) -> CmdResult<()> {
    let e = effective();
    if e.policy.mode_allowed(mode) {
        Ok(())
    } else {
        Err(format!("POLICY: Der Freigabe-Modus „{mode}“ ist {} nicht erlaubt.", managed_by(&e)))
    }
}

pub fn check_model(model: &str) -> CmdResult<()> {
    let e = effective();
    if e.policy.model_allowed(model) {
        Ok(())
    } else {
        Err(format!("POLICY: Das Modell „{model}“ ist {} nicht freigegeben.", managed_by(&e)))
    }
}

// ---------- Sessions: aktuelles Modell und aktueller Modus ----------

#[derive(Clone, Default)]
struct SessionInfo {
    model: Option<String>,
    mode: Option<String>,
}

static SESSIONS: Mutex<Option<HashMap<String, SessionInfo>>> = Mutex::new(None);

fn with_session(id: &str, f: impl FnOnce(&mut SessionInfo)) {
    let mut g = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new).entry(id.to_string()).or_default());
}

/// Modell und Modus aus der Antwort auf `session/new` bzw. `session/load`.
pub fn note_session(id: &str, r: &Value) {
    let model = r["configOptions"]
        .as_array()
        .and_then(|a| a.iter().find(|o| o["id"] == "model"))
        .and_then(|o| o["currentValue"].as_str())
        .or_else(|| r["models"]["currentModelId"].as_str())
        .map(str::to_string);
    let mode = r["modes"]["currentModeId"]
        .as_str()
        .or_else(|| r["configOptions"].as_array().and_then(|a| a.iter().find(|o| o["id"] == "mode")).and_then(|o| o["currentValue"].as_str()))
        .map(str::to_string);
    with_session(id, |s| {
        if model.is_some() {
            s.model = model;
        }
        if mode.is_some() {
            s.mode = mode;
        }
    });
}

pub fn note_model(id: &str, model: &str) {
    with_session(id, |s| s.model = Some(model.to_string()));
}

pub fn note_mode(id: &str, mode: &str) {
    with_session(id, |s| s.mode = Some(mode.to_string()));
}

/// Vor jedem Prompt: Backend, Modell, Modus, ZDR und Budget.
pub fn check_prompt(session: &str, backend: &str) -> CmdResult<()> {
    let e = effective();
    if !e.managed {
        return Ok(());
    }
    let p = &e.policy;
    let info = SESSIONS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(session).cloned()).unwrap_or_default();
    let by = managed_by(&e);
    if !p.backend_allowed(backend) {
        return Err(format!("POLICY: Das Backend „{backend}“ ist {by} nicht freigegeben."));
    }
    if let Some(m) = info.model.as_deref().filter(|m| !p.model_allowed(m)) {
        return Err(format!("POLICY: Das Modell „{m}“ ist {by} nicht freigegeben. Wähle ein anderes Modell."));
    }
    if p.models.is_some() && info.model.is_none() {
        return Err(format!("POLICY: Das Modell dieser Session ist unbekannt; erlaubt sind nur bestimmte Modelle ({by})."));
    }
    if let Some(m) = info.mode.as_deref().filter(|m| !p.mode_allowed(m)) {
        return Err(format!("POLICY: Der Freigabe-Modus „{m}“ ist {by} nicht erlaubt. Wähle einen anderen Modus."));
    }
    if p.require_zdr {
        let zdr = backend == "vibe" && info.model.as_deref().is_some_and(|m| crate::cortecs::cortecs_status().vibe_models.iter().any(|a| a == m));
        if !zdr {
            return Err(format!("POLICY: Prompts dürfen nur über Cortecs-Modelle ohne Datenspeicherung (ZDR) laufen ({by})."));
        }
    }
    if let Some(limit) = p.daily_eur {
        let spent = crate::usage::spent_today_eur();
        if spent >= limit {
            return Err(format!("POLICY: Tagesbudget von {limit:.2} € erreicht ({spent:.2} € verbraucht, {by})."));
        }
    }
    if let Some(limit) = p.monthly_eur {
        let spent = crate::usage::spent_month_eur();
        if spent >= limit {
            return Err(format!("POLICY: Monatsbudget von {limit:.2} € erreicht ({spent:.2} € verbraucht, {by})."));
        }
    }
    Ok(())
}

// ---------- Fest vorgegebene Werte anwenden ----------

/// Schreibt fest vorgegebene Werte in Vibes config.toml und Brises Cortecs-
/// Einstellungen. Läuft, wenn ein neuer Team-Stand ankommt, und beim Start.
pub fn apply() -> CmdResult<()> {
    let e = effective();
    if !e.managed {
        return Ok(());
    }
    let p = e.policy.clone();
    let skills: Vec<String> = match &p.skills {
        Some(allowed) => crate::skills::list_skills(None).into_iter().map(|s| s.name).filter(|n| !allowed.contains(n)).collect(),
        None => Vec::new(),
    };
    crate::config::edit_config(|doc| {
        if p.no_auto_edits {
            doc["bypass_tool_permissions"] = value(false);
            doc["enable_auto_approve"] = value(false);
        }
        // Ohne Eintrag startet Vibe mit „Edits automatisch“ – das ist dann ggf. auch verboten.
        let mode = doc.get("default_agent").and_then(Item::as_str).unwrap_or("accept-edits").to_string();
        if !p.mode_allowed(&mode) {
            let fallback = p.modes.as_ref().and_then(|m| m.iter().find(|m| p.mode_allowed(m)).cloned()).unwrap_or_else(|| "ask".into());
            doc["default_agent"] = value(fallback);
        }
        if let Some(on) = p.web_search {
            for tool in ["web_search", "web_fetch"] {
                if !doc.contains_key("tools") {
                    doc["tools"] = toml_edit::table();
                }
                let tools = doc["tools"].as_table_mut().ok_or("tools ist keine Tabelle")?;
                if !tools.contains_key(tool) {
                    tools[tool] = toml_edit::table();
                }
                let current = tools[tool].get("permission").and_then(Item::as_str).map(str::to_string);
                if on && current.as_deref() == Some("never") {
                    tools[tool].as_table_mut().map(|t| t.remove("permission"));
                } else if !on {
                    tools[tool]["permission"] = value("never");
                }
            }
        }
        if let Some(allowed) = &p.mcp_servers {
            if allowed.is_empty() {
                doc["enable_mcp"] = value(false);
            }
            if let Some(arr) = doc.get_mut("mcp_servers").and_then(Item::as_array_of_tables_mut) {
                for t in arr.iter_mut() {
                    let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if !allowed.contains(&name) {
                        t["disabled"] = value(true);
                    }
                }
            }
        }
        if p.skills.is_some() {
            let mut list: Vec<String> = doc.get("disabled_skills").and_then(Item::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            for s in &skills {
                if !list.contains(s) {
                    list.push(s.clone());
                }
            }
            doc["disabled_skills"] = value(toml_edit::Array::from_iter(list));
        }
        Ok(())
    })?;
    if p.eu_native || p.secrecy203 {
        let mut s = crate::cortecs::settings();
        if (p.eu_native && !s.eu_native) || (p.secrecy203 && !s.secrecy203) {
            s.eu_native |= p.eu_native;
            s.secrecy203 |= p.secrecy203;
            crate::cortecs::write_settings(&s)?;
        }
    }
    Ok(())
}

/// Neuer Stand: anwenden und der Oberfläche melden.
pub fn changed(app: &AppHandle) {
    if let Err(err) = apply() {
        eprintln!("Team-Richtlinie anwenden: {err}");
    }
    let _ = app.emit("policy:changed", effective());
}

/// Wirksame Richtlinie für die Oberfläche.
#[tauri::command]
pub fn policy_effective() -> Effective {
    effective()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(v: &[&str]) -> Option<Vec<String>> {
        Some(v.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn merge_is_strictest() {
        let a = Policy {
            sections: [("models".to_string(), Access::Read), ("web".to_string(), Access::Hidden)].into(),
            models: strs(&["a", "b"]),
            daily_eur: Some(5.0),
            web_search: Some(true),
            ..Default::default()
        };
        let b = Policy {
            sections: [("models".to_string(), Access::Hidden), ("usage".to_string(), Access::Read)].into(),
            models: strs(&["b", "c"]),
            daily_eur: Some(3.0),
            monthly_eur: Some(40.0),
            web_search: Some(false),
            require_zdr: true,
            ..Default::default()
        };
        let m = a.merge(&b);
        assert_eq!(m.access("models"), Access::Hidden);
        assert_eq!(m.access("web"), Access::Hidden);
        assert_eq!(m.access("usage"), Access::Read);
        assert_eq!(m.access("general"), Access::Edit);
        assert_eq!(m.models, strs(&["b"]));
        assert_eq!((m.daily_eur, m.monthly_eur), (Some(3.0), Some(40.0)));
        assert_eq!(m.web_search, Some(false));
        assert!(m.require_zdr);
    }

    #[test]
    fn orchestra_lock_wins() {
        let open = Policy { orchestra: Some(true), max_sub_sessions: Some(4), ..Default::default() };
        let locked = Policy { orchestra: Some(false), max_sub_sessions: Some(2), ..Default::default() };
        let m = open.merge(&locked);
        assert_eq!((m.orchestra, m.max_sub_sessions), (Some(false), Some(2)));
        assert_eq!(open.merge(&Policy::default()).orchestra, Some(true));
        // Ältere Team-Stände ohne die Felder bleiben lesbar.
        let old: Policy = serde_json::from_str(r#"{"dailyEur": 3}"#).unwrap();
        assert_eq!((old.orchestra, old.max_sub_sessions), (None, None));
        let cu = Policy { computer_use: Some(false), ..Default::default() };
        assert_eq!(open.merge(&cu).computer_use, Some(false));
        assert_eq!(open.merge(&Policy::default()).computer_use, None);
    }

    #[test]
    fn modes_and_auto_edits() {
        let p = Policy { no_auto_edits: true, ..Default::default() };
        assert!(p.mode_allowed("ask") && p.mode_allowed("plan"));
        assert!(!p.mode_allowed("accept-edits") && !p.mode_allowed("bypassPermissions"));
        let p = Policy { modes: strs(&["ask"]), ..Default::default() };
        assert!(p.mode_allowed("ask") && !p.mode_allowed("plan"));
    }

    #[test]
    fn config_keys_map_to_sections() {
        let k = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(section_of(&k(&["tools", "web_search", "permission"])), "tools");
        assert_eq!(section_of(&k(&["tools", "bash", "allowlist"])), "privacy");
        assert_eq!(section_of(&k(&["active_model"])), "agents");
        assert_eq!(section_of(&k(&["mcp_servers"])), "tools");
        assert_eq!(section_of(&k(&["something_new"])), "advanced");
    }

    #[test]
    fn alte_bereiche_gelten_weiter() {
        // Richtlinie aus Brise 0.2: „Cortecs & Datenschutz“ nur lesen, „Websuche“ ausgeblendet.
        let p = Policy { sections: [("cortecs".to_string(), Access::Read), ("web".to_string(), Access::Hidden), ("skills".to_string(), Access::Read)].into(), ..Default::default() };
        assert_eq!(p.access("privacy"), Access::Read);
        assert_eq!(p.access("cortecs"), Access::Read);
        assert_eq!(p.access("permissions"), Access::Read);
        assert_eq!(p.access("tools"), Access::Hidden);
        assert_eq!(p.access("providers"), Access::Edit);
        let n = p.normalized();
        assert_eq!(n.sections.get("privacy"), Some(&Access::Read));
        assert_eq!(n.sections.get("tools"), Some(&Access::Hidden));
        assert!(!n.sections.contains_key("cortecs"));
        assert_eq!(canonical_section("account"), "providers");
        assert_eq!(canonical_section("orchestra"), "models");
    }

    #[test]
    fn config_values_follow_policy() {
        let e = Effective {
            managed: true,
            teams: vec!["Die Drei".into()],
            policy: Policy {
                models: strs(&["devstral"]),
                no_auto_edits: true,
                web_search: Some(false),
                mcp_servers: strs(&["git"]),
                ..Default::default()
            },
        };
        let k = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(check_config_value(&e, &k(&["active_model"]), &json!("devstral")).is_ok());
        assert!(check_config_value(&e, &k(&["active_model"]), &json!("mistral-large")).is_err());
        assert!(check_config_value(&e, &k(&["default_agent"]), &json!("auto-approve")).is_err());
        assert!(check_config_value(&e, &k(&["bypass_tool_permissions"]), &json!(true)).is_err());
        assert!(check_config_value(&e, &k(&["bypass_tool_permissions"]), &json!(false)).is_ok());
        assert!(check_config_value(&e, &k(&["tools", "web_search", "permission"]), &json!("always")).is_err());
        assert!(check_config_value(&e, &k(&["tools", "web_search", "permission"]), &json!("never")).is_ok());
        let servers = json!([{ "name": "git" }, { "name": "fremd", "disabled": true }]);
        assert!(check_config_value(&e, &k(&["mcp_servers"]), &servers).is_ok());
        assert!(check_config_value(&e, &k(&["mcp_servers"]), &json!([{ "name": "fremd" }])).is_err());
        let err = check_config_value(&e, &k(&["active_model"]), &json!("x")).unwrap_err();
        assert!(err.contains("Die Drei"), "{err}");
    }

    #[test]
    fn admins_and_acceptance() {
        let base = TeamState { team: "t".into(), version: 1, owner: "o".into(), admins: vec!["a".into()], ..Default::default() };
        assert!(base.policy_for("o").is_none() && base.policy_for("a").is_none());
        assert_eq!(base.policy_for("m"), Some(Policy::default()));
        let mut next = TeamState { version: 2, ..base.clone() };
        assert!(base.accepts(&next, "a").is_ok());
        assert!(base.accepts(&next, "m").is_err(), "Mitglieder dürfen nichts ändern");
        next.admins.clear();
        assert!(base.accepts(&next, "a").is_err(), "Admin setzt Admin ab");
        assert!(base.accepts(&next, "o").is_ok(), "Besitzer darf absetzen");
        let old = TeamState { version: 1, ..base.clone() };
        assert!(base.accepts(&old, "o").is_err(), "Version muss steigen");
        let foreign = TeamState { owner: "x".into(), version: 3, ..base.clone() };
        assert!(base.accepts(&foreign, "o").is_err());
    }
}
