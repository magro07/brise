//! Teams: ein dauerhafter, verschlüsselter Raum auf dem Relay.
//!
//! Mitglieder kündigen sich regelmäßig an (Name, Agent-Backends mit Abo,
//! geteilte Sessions samt Beitritts-Link) und teilen eine Projektliste.
//! Einladung: `brise://team/<id>?relay=<url>&name=<name>&owner=<id>#<schlüssel>`.
//!
//! Wer ein Team anlegt, ist sein Besitzer. Rollen, Richtlinien, entfernte
//! Mitglieder und das Audit-Log stehen im Team-Stand, einem eigenständig
//! signierten Dokument, das jedes Mitglied an Nachzügler weiterreicht
//! (siehe docs/adr/0005-team-workspaces.md und `crate::policy`).

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};

use super::crypto::{self, b64, random, unb64};
use super::link::{Link, decode, encode};
use super::secrets::{self, Secrets, TeamSecret};
use super::transport::Transport;
use super::{CmdResult, CollabState, Inner, LAN_PORT, clean_name, ensure_lan, lan_ip, message_id, unix_now};
use crate::policy::{self, AUDIT_MAX, AuditEntry, Policy, SignedDoc, Stored, TeamState};

/// Nach so langer Stille gilt ein Mitglied als abwesend.
const OFFLINE_AFTER: Duration = Duration::from_secs(75);
const ANNOUNCE_EVERY: Duration = Duration::from_secs(25);
/// So viele Tage behält das Nutzungsbuch des Hosts.
const USAGE_DAYS: u64 = 62;

pub(super) struct Team {
    pub secret: TeamSecret,
    key: [u8; 32],
    transport: Transport,
    connected: bool,
    error: Option<String>,
    members: BTreeMap<String, Member>,
    seen: VecDeque<String>,
    generation: u64,
    /// Zuletzt gültiger Team-Stand samt Signatur.
    state: Option<(SignedDoc, TeamState)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    id: String,
    name: String,
    /// Agent-Backends dieses Mitglieds mit Abo, z. B. `[{id: "vibe", plan: "Mistral Vibe Pro"}]`.
    backends: Value,
    /// Geteilte Sessions dieses Mitglieds (mit Beitritts-Link).
    sessions: Value,
    online: bool,
    #[serde(skip)]
    last_seen: Option<Instant>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    id: String,
    name: String,
    relay: String,
    link: String,
    connected: bool,
    error: Option<String>,
    me: String,
    members: Vec<Member>,
    projects: Value,
    /// Besitzer (fehlt bei Teams aus der Zeit vor den Admin-Rechten).
    owner: Option<String>,
    /// Darf ich Rollen und Richtlinien ändern?
    admin: bool,
    state: Option<TeamState>,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn team_link(s: &TeamSecret) -> String {
    let owner = s.owner.as_deref().map(|o| format!("&owner={o}")).unwrap_or_default();
    format!("brise://team/{}?relay={}&name={}{owner}#{}", s.id, encode(&s.relay), encode(&s.name), s.key)
}

fn parse_team_link(text: &str) -> Result<TeamSecret, String> {
    let bad = || "Das ist kein gültiger Team-Einladungslink.".to_string();
    let rest = text.trim().strip_prefix("brise://team/").ok_or_else(bad)?;
    let (before, key) = rest.split_once('#').ok_or("Im Link fehlt der Schlüssel (Teil nach #).")?;
    unb64::<32>(key).ok_or_else(bad)?;
    let (id, query) = before.split_once('?').unwrap_or((before, ""));
    if id.len() < 16 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(bad());
    }
    let (mut relay, mut name, mut owner) = (None, None, None);
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("relay", v)) => relay = decode(v),
            Some(("name", v)) => name = decode(v),
            Some(("owner", v)) => owner = Some(v.to_string()),
            _ => {}
        }
    }
    let relay = relay.filter(|r| r.starts_with("ws://") || r.starts_with("wss://")).ok_or("Im Link fehlt die Relay-Adresse.")?;
    if owner.as_deref().is_some_and(|o| unb64::<32>(o).is_none()) {
        return Err(bad());
    }
    Ok(TeamSecret {
        id: id.to_string(),
        name: clean_name(&json!(name.unwrap_or_else(|| "Team".into()))),
        relay,
        key: key.to_string(),
        owner,
        projects: json!([]),
        projects_at: 0,
    })
}

/// Läuft das Relay dieses Teams als LAN-Relay auf diesem Rechner?
pub(super) fn is_own_lan(relay: &str) -> bool {
    let Some(ip) = lan_ip() else { return false };
    relay.starts_with(&format!("ws://{ip}:"))
}

fn lan_port(relay: &str) -> Option<u16> {
    relay.rsplit(':').next()?.trim_end_matches('/').parse().ok()
}

impl Team {
    fn view(&self, me: &str) -> TeamView {
        let state = self.state.as_ref().map(|(_, s)| s.clone());
        let admin = match (&state, &self.secret.owner) {
            (Some(s), _) => s.is_admin(me),
            (None, Some(owner)) => owner == me,
            _ => false,
        };
        TeamView {
            id: self.secret.id.clone(),
            name: self.secret.name.clone(),
            relay: self.secret.relay.clone(),
            link: team_link(&self.secret),
            connected: self.connected,
            error: self.error.clone(),
            me: me.to_string(),
            members: self.members.values().cloned().collect(),
            projects: self.secret.projects.clone(),
            owner: self.secret.owner.clone(),
            admin,
            state,
        }
    }

    fn removed(&self, id: &str) -> bool {
        self.state.as_ref().is_some_and(|(_, s)| s.removed.iter().any(|r| r == id))
    }

    /// Bisheriger Stand oder – vor dem ersten – ein leerer mit dem Besitzer aus dem Link.
    fn base_state(&self) -> Option<TeamState> {
        let owner = self.secret.owner.clone()?;
        Some(match &self.state {
            Some((_, s)) => s.clone(),
            None => TeamState { team: self.secret.id.clone(), owner, ..Default::default() },
        })
    }
}

/// Mitglied eines gemeinsamen Teams (und nicht entfernt)?
pub(super) fn is_member(g: &Inner, id: &str) -> bool {
    g.teams.values().any(|t| t.members.contains_key(id) && !t.removed(id))
}

fn persist(g: &Inner) {
    secrets::save(&Secrets { seed: Some(b64(&g.me.seed())), teams: g.teams.values().map(|t| t.secret.clone()).collect() });
}

fn emit(app: &AppHandle, g: &Inner, team_id: &str) {
    if let Some(t) = g.teams.get(team_id) {
        let _ = app.emit("collab:team", t.view(&g.me.id()));
    }
}

fn send(g: &Inner, team_id: &str, body: &Value) {
    if let Some(t) = g.teams.get(team_id) {
        t.transport.send(crypto::seal(&t.key, team_id, &g.me, body));
    }
}

/// Eigene Ankündigung: Profil und die in diesem Team geteilten Sessions.
fn announce(g: &Inner, team_id: &str) {
    let sessions: Vec<Value> = g.hosts.values().filter(|h| h.team.as_deref() == Some(team_id)).map(|h| h.team_entry()).collect();
    let body = json!({
        "t": "announce",
        "id": message_id(),
        "name": g.profile["name"],
        "backends": g.profile["backends"],
        "sessions": sessions,
    });
    send(g, team_id, &body);
}

pub(super) fn announce_all(g: &mut Inner) {
    let ids: Vec<String> = g.teams.keys().cloned().collect();
    for id in ids {
        announce(g, &id);
    }
}

/// Den bekannten Team-Stand weiterreichen (jeder darf das, er ist signiert).
fn send_state(g: &Inner, team_id: &str) {
    if let Some((doc, _)) = g.teams.get(team_id).and_then(|t| t.state.as_ref()) {
        send(g, team_id, &json!({ "t": "state", "id": message_id(), "doc": doc }));
    }
}

fn store_state(g: &Inner, team_id: &str) {
    if let Some(t) = g.teams.get(team_id) {
        if let Some((doc, _)) = &t.state {
            policy::save_stored(team_id, &Stored { name: t.secret.name.clone(), me: g.me.id(), doc: doc.clone() });
        }
    }
}

/// Ein Team-Stand kommt an: prüfen, übernehmen, anwenden.
fn receive_state(app: &AppHandle, g: &mut Inner, team_id: &str, doc: SignedDoc) {
    let me = g.me.id();
    let Some(t) = g.teams.get_mut(team_id) else { return };
    let Some(base) = t.base_state() else { return };
    let Some(next) = doc.open(team_id) else { return };
    if base.accepts(&next, &doc.by).is_err() {
        return;
    }
    for r in &next.removed {
        t.members.remove(r);
    }
    let removed = next.removed.contains(&me);
    let name = t.secret.name.clone();
    t.state = Some((doc, next));
    if removed {
        // Ein Admin hat mich entfernt: Team hier verlassen.
        g.teams.remove(team_id);
        policy::remove_stored(team_id);
        persist(g);
        super::release_lan(g);
        let _ = app.emit("collab:team-removed", json!({ "id": team_id, "name": name }));
    } else {
        store_state(g, team_id);
        emit(app, g, team_id);
    }
    policy::changed(app);
}

fn team_frame(app: &AppHandle, inner: &Mutex<Inner>, team_id: &str, frame: &[u8]) {
    let mut g = inner.lock().unwrap();
    let me = g.me.id();
    let Some(t) = g.teams.get_mut(team_id) else { return };
    let Some((from, body)) = crypto::open(&t.key, team_id, frame) else { return };
    if from == me {
        return;
    }
    if let Some(id) = body["id"].as_str() {
        if t.seen.iter().any(|s| s == id) {
            return;
        }
        t.seen.push_back(id.to_string());
        if t.seen.len() > 512 {
            t.seen.pop_front();
        }
    }
    // Entfernte Mitglieder dürfen nur noch signierte Team-Stände weiterreichen.
    if t.removed(&from) && body["t"] != "state" {
        return;
    }
    match body["t"].as_str() {
        Some("announce") => {
            let fresh = !t.members.get(&from).is_some_and(|m| m.online);
            let m = t.members.entry(from.clone()).or_insert_with(|| Member {
                id: from.clone(),
                name: String::new(),
                backends: json!([]),
                sessions: json!([]),
                online: true,
                last_seen: None,
            });
            m.name = clean_name(&body["name"]);
            m.backends = if body["backends"].is_array() { body["backends"].clone() } else { json!([]) };
            m.sessions = if body["sessions"].is_array() { body["sessions"].clone() } else { json!([]) };
            m.online = true;
            m.last_seen = Some(Instant::now());
            // Neue Mitglieder sollen alle sofort sehen, nicht erst nach 25 s.
            if fresh {
                announce(&g, team_id);
                send_projects(&g, team_id);
                send_state(&g, team_id);
            }
        }
        Some("projects") => {
            let at = body["at"].as_u64().unwrap_or(0);
            if at > t.secret.projects_at && body["items"].is_array() {
                t.secret.projects = body["items"].clone();
                t.secret.projects_at = at;
                persist(&g);
            }
        }
        Some("state") => {
            if let Ok(doc) = serde_json::from_value::<SignedDoc>(body["doc"].clone()) {
                receive_state(app, &mut g, team_id, doc);
            }
            return;
        }
        Some("bye") => {
            if let Some(m) = t.members.get_mut(&from) {
                m.online = false;
            }
        }
        _ => return,
    }
    emit(app, &g, team_id);
}

fn send_projects(g: &Inner, team_id: &str) {
    if let Some(t) = g.teams.get(team_id).filter(|t| t.secret.projects_at > 0) {
        let body = json!({ "t": "projects", "id": message_id(), "items": t.secret.projects, "at": t.secret.projects_at });
        send(g, team_id, &body);
    }
}

/// Verbindet ein Team (Aufrufer hält die Sperre) und startet die Ankündigungen.
fn connect(app: &AppHandle, inner: &Arc<Mutex<Inner>>, g: &mut Inner, secret: TeamSecret) -> CmdResult<()> {
    let key = unb64::<32>(&secret.key).ok_or("Ungültiger Team-Schlüssel")?;
    let id = secret.id.clone();
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Zuletzt gespeicherter Stand, sofern er zum Besitzer aus dem Link passt.
    let state = policy::load_stored(&id).filter(|(_, s)| Some(&s.owner) == secret.owner.as_ref()).map(|(stored, s)| (stored.doc, s));
    let transport = {
        let (app_f, inner_f, id_f) = (app.clone(), inner.clone(), id.clone());
        let (app_s, inner_s, id_s) = (app.clone(), inner.clone(), id.clone());
        Transport::spawn(
            Link::socket_url(&secret.relay, &id),
            move |frame| team_frame(&app_f, &inner_f, &id_f, &frame),
            move |connected, error| {
                let mut g = inner_s.lock().unwrap();
                let Some(t) = g.teams.get_mut(&id_s) else { return };
                t.connected = connected;
                t.error = error;
                if connected {
                    announce(&g, &id_s);
                    send_projects(&g, &id_s);
                    send_state(&g, &id_s);
                }
                emit(&app_s, &g, &id_s);
            },
        )
    };
    g.teams.insert(
        id.clone(),
        Team { secret, key, transport, connected: false, error: None, members: BTreeMap::new(), seen: VecDeque::new(), generation, state },
    );
    spawn_ticker(app.clone(), inner.clone(), id, generation);
    Ok(())
}

/// Regelmäßig ankündigen und stille Mitglieder als abwesend markieren.
fn spawn_ticker(app: AppHandle, inner: Arc<Mutex<Inner>>, team_id: String, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(ANNOUNCE_EVERY).await;
            let mut g = inner.lock().unwrap();
            let Some(t) = g.teams.get_mut(&team_id).filter(|t| t.generation == generation) else { return };
            let mut changed = false;
            for m in t.members.values_mut() {
                if m.online && m.last_seen.is_none_or(|s| s.elapsed() > OFFLINE_AFTER) {
                    m.online = false;
                    changed = true;
                }
            }
            announce(&g, &team_id);
            if changed {
                emit(&app, &g, &team_id);
            }
        }
    });
}

/// Beim Start: gespeicherte Teams verbinden (eigenes LAN-Relay vorher starten).
pub(super) fn start(app: AppHandle, inner: Arc<Mutex<Inner>>) {
    tauri::async_runtime::spawn(async move {
        let stored = secrets::load().teams;
        for secret in stored {
            if is_own_lan(&secret.relay) {
                let _ = ensure_lan(&inner, lan_port(&secret.relay).unwrap_or(LAN_PORT)).await;
            }
            let mut g = inner.lock().unwrap();
            if !g.teams.contains_key(&secret.id) {
                let _ = connect(&app, &inner, &mut g, secret);
            }
        }
    });
}

// ---------- Admin: Team-Stand ändern ----------

fn member_name(state: &TeamState, t: &Team, id: &str) -> String {
    t.members
        .get(id)
        .map(|m| m.name.clone())
        .filter(|n| !n.is_empty())
        .or_else(|| state.members.get(id).map(|m| m.name.clone()).filter(|n| !n.is_empty()))
        .unwrap_or_else(|| format!("{}…", id.chars().take(6).collect::<String>()))
}

/// Ändert den Team-Stand als Admin: signieren, speichern, verteilen, anwenden.
fn update(
    app: &AppHandle,
    g: &mut Inner,
    team_id: &str,
    action: &str,
    f: impl FnOnce(&mut TeamState, &Team) -> CmdResult<String>,
) -> CmdResult<TeamView> {
    let me = g.me.id();
    let my_name = clean_name(&g.profile["name"]);
    let t = g.teams.get(team_id).ok_or("Unbekanntes Team")?;
    let base = t.base_state().ok_or("Dieses Team hat noch keinen Besitzer. Der Ersteller kann es in den Team-Einstellungen übernehmen.")?;
    if !base.is_admin(&me) {
        return Err("Nur Team-Admins können das ändern.".into());
    }
    let mut next = base.clone();
    for m in t.members.values().filter(|m| !m.name.is_empty()) {
        next.members.entry(m.id.clone()).or_default().name = m.name.clone();
    }
    if !my_name.is_empty() {
        next.members.entry(me.clone()).or_default().name = my_name.clone();
    }
    let detail = f(&mut next, t)?;
    next.removed.sort();
    next.removed.dedup();
    let owner = next.owner.clone();
    let removed = next.removed.clone();
    next.admins.retain(|a| *a != owner && !removed.contains(a));
    next.admins.sort();
    next.admins.dedup();
    for r in &removed {
        next.policies.remove(r);
    }
    let now = unix_now() * 1000;
    next.version = now.max(base.version + 1);
    next.audit.push(AuditEntry { at: now, by: me.clone(), by_name: my_name, action: action.into(), detail });
    if next.audit.len() > AUDIT_MAX {
        let cut = next.audit.len() - AUDIT_MAX;
        next.audit.drain(..cut);
    }
    base.accepts(&next, &me).map_err(|e| format!("Änderung abgelehnt: {e}"))?;
    let body = serde_json::to_string(&next).map_err(|e| e.to_string())?;
    let doc = SignedDoc { by: me.clone(), sig: g.me.sign(&policy::signed_bytes(team_id, &body)), body };
    let t = g.teams.get_mut(team_id).ok_or("Unbekanntes Team")?;
    for r in &removed {
        t.members.remove(r);
    }
    t.state = Some((doc, next));
    store_state(g, team_id);
    send_state(g, team_id);
    emit(app, g, team_id);
    policy::changed(app);
    Ok(g.teams[team_id].view(&me))
}

/// Kurzbeschreibung einer Richtlinie fürs Audit-Log.
fn describe(p: &Policy) -> String {
    let mut parts = Vec::new();
    let locked: Vec<String> = p
        .sections
        .iter()
        .filter(|(_, a)| **a != policy::Access::Edit)
        .map(|(s, a)| format!("{s}={}", if *a == policy::Access::Hidden { "aus" } else { "lesen" }))
        .collect();
    if !locked.is_empty() {
        parts.push(format!("Bereiche {}", locked.join(", ")));
    }
    let list = |l: &Option<Vec<String>>| l.as_ref().map(|v| if v.is_empty() { "keine".to_string() } else { v.join(", ") });
    if let Some(v) = list(&p.backends) {
        parts.push(format!("Backends: {v}"));
    }
    if let Some(v) = list(&p.models) {
        parts.push(format!("Modelle: {v}"));
    }
    if let Some(v) = list(&p.modes) {
        parts.push(format!("Modi: {v}"));
    }
    if p.no_auto_edits {
        parts.push("keine automatischen Edits".into());
    }
    if p.require_zdr {
        parts.push("ZDR-Pflicht".into());
    }
    if p.eu_native {
        parts.push("nur EU-Anbieter".into());
    }
    if p.secrecy203 {
        parts.push("§ 203".into());
    }
    if let Some(v) = p.daily_eur {
        parts.push(format!("{v:.2} €/Tag"));
    }
    if let Some(v) = p.monthly_eur {
        parts.push(format!("{v:.2} €/Monat"));
    }
    if let Some(on) = p.web_search {
        parts.push(format!("Websuche {}", if on { "an" } else { "aus" }));
    }
    if let Some(v) = list(&p.mcp_servers) {
        parts.push(format!("MCP: {v}"));
    }
    if let Some(v) = list(&p.skills) {
        parts.push(format!("Skills: {v}"));
    }
    if let Some(v) = p.shared_daily_prompts {
        parts.push(format!("{v} Prompts/Tag auf geteilten Abos"));
    }
    if let Some(v) = p.shared_daily_tokens {
        parts.push(format!("{v} Tokens/Tag auf geteilten Abos"));
    }
    if parts.is_empty() { "keine Einschränkungen".into() } else { parts.join("; ") }
}

#[tauri::command]
pub fn collab_team_set_admin(app: AppHandle, state: State<'_, CollabState>, team_id: String, member: String, admin: bool) -> CmdResult<TeamView> {
    let mut g = state.0.lock().unwrap();
    update(&app, &mut g, &team_id, if admin { "admin" } else { "admin-entzogen" }, |s, t| {
        if member == s.owner {
            return Err("Der Besitzer bleibt immer Admin.".into());
        }
        let name = member_name(s, t, &member);
        if admin {
            s.admins.push(member.clone());
            s.members.entry(member.clone()).or_default();
            Ok(format!("{name} ist jetzt Admin"))
        } else {
            s.admins.retain(|a| *a != member);
            Ok(format!("{name} ist kein Admin mehr"))
        }
    })
}

#[tauri::command]
pub fn collab_team_remove_member(app: AppHandle, state: State<'_, CollabState>, team_id: String, member: String) -> CmdResult<TeamView> {
    let mut g = state.0.lock().unwrap();
    let me = g.me.id();
    update(&app, &mut g, &team_id, "entfernt", |s, t| {
        if member == s.owner || member == me {
            return Err("Besitzer und du selbst können nicht entfernt werden.".into());
        }
        let name = member_name(s, t, &member);
        s.removed.push(member.clone());
        s.admins.retain(|a| *a != member);
        Ok(format!("{name} entfernt"))
    })
}

/// Richtlinie setzen: `member` fehlt = Standard für alle Mitglieder,
/// `policy` fehlt = eigene Richtlinie des Mitglieds aufheben.
#[tauri::command]
pub fn collab_team_set_policy(
    app: AppHandle,
    state: State<'_, CollabState>,
    team_id: String,
    member: Option<String>,
    policy: Option<Policy>,
) -> CmdResult<TeamView> {
    let mut g = state.0.lock().unwrap();
    update(&app, &mut g, &team_id, "richtlinie", |s, t| match (member, policy) {
        (None, Some(p)) => {
            let d = describe(&p);
            s.default_policy = p;
            Ok(format!("Standard-Richtlinie: {d}"))
        }
        (None, None) => Err("Richtlinie fehlt".into()),
        (Some(m), Some(p)) => {
            let d = describe(&p);
            let name = member_name(s, t, &m);
            s.members.entry(m.clone()).or_default();
            s.policies.insert(m, p);
            Ok(format!("Richtlinie für {name}: {d}"))
        }
        (Some(m), None) => {
            let name = member_name(s, t, &m);
            s.policies.remove(&m);
            Ok(format!("{name} folgt wieder der Standard-Richtlinie"))
        }
    })
}

/// Altes Team ohne Besitzer übernehmen (nur sinnvoll für den Ersteller).
/// Danach gilt der neue Einladungslink mit `owner`.
#[tauri::command]
pub fn collab_team_claim(app: AppHandle, state: State<'_, CollabState>, team_id: String) -> CmdResult<TeamView> {
    let mut g = state.0.lock().unwrap();
    let me = g.me.id();
    let t = g.teams.get_mut(&team_id).ok_or("Unbekanntes Team")?;
    if t.secret.owner.is_some() {
        return Err("Dieses Team hat schon einen Besitzer.".into());
    }
    t.secret.owner = Some(me);
    persist(&g);
    update(&app, &mut g, &team_id, "übernommen", |_, _| Ok("Team übernommen; neuer Einladungslink".into()))
}

// ---------- Nutzung geteilter Abos (beim Host) ----------

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageEntry {
    pub name: String,
    pub prompts: u32,
    pub tokens: u64,
}

/// Tag (UTC, Tage seit 1970) → Mitglied → Nutzung auf dem eigenen Abo.
type Book = BTreeMap<u64, BTreeMap<String, UsageEntry>>;

static BOOK_LOCK: Mutex<()> = Mutex::new(());

fn book_path() -> PathBuf {
    crate::installer::data_dir().join("team-usage.json")
}

fn load_book() -> Book {
    std::fs::read(book_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Bucht Prompts und Tokens eines Gasts auf dem Abo dieses Rechners.
pub(super) fn book(member: &str, name: &str, prompts: u32, tokens: u64) {
    let _guard = BOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let today = unix_now() / 86_400;
    let mut book = load_book();
    book.retain(|day, _| day + USAGE_DAYS > today);
    let e = book.entry(today).or_default().entry(member.to_string()).or_default();
    if !name.is_empty() {
        e.name = name.to_string();
    }
    e.prompts += prompts;
    e.tokens += tokens;
    if let Ok(bytes) = serde_json::to_vec(&book) {
        let _ = std::fs::write(book_path(), bytes);
    }
}

fn today_usage(member: &str) -> UsageEntry {
    load_book().get(&(unix_now() / 86_400)).and_then(|d| d.get(member).cloned()).unwrap_or_default()
}

/// Tageslimits eines Mitglieds auf geteilten Abos aus allen gemeinsamen Teams.
pub(super) fn shared_limits(g: &Inner, member: &str) -> (Option<u32>, Option<u64>) {
    let mut out: Option<Policy> = None;
    for t in g.teams.values() {
        let Some((_, s)) = &t.state else { continue };
        if !t.members.contains_key(member) && !s.members.contains_key(member) {
            continue;
        }
        if let Some(p) = s.policy_for(member) {
            out = Some(match out {
                Some(o) => o.merge(&p),
                None => p,
            });
        }
    }
    out.map_or((None, None), |p| (p.shared_daily_prompts, p.shared_daily_tokens))
}

/// Grund, einen Gast-Prompt wegen der Team-Limits abzulehnen.
pub(super) fn limit_refusal(limits: (Option<u32>, Option<u64>), member: &str, queued: u32, host: &str) -> Option<String> {
    if limits == (None, None) {
        return None;
    }
    let used = today_usage(member);
    if let Some(max) = limits.0.filter(|max| used.prompts + queued >= *max) {
        return Some(format!("Team-Limit erreicht: {max} Prompts pro Tag auf geteilten Abos (Abo von {host})."));
    }
    if let Some(max) = limits.1.filter(|max| used.tokens >= *max) {
        return Some(format!("Team-Limit erreicht: {max} Tokens pro Tag auf geteilten Abos (Abo von {host})."));
    }
    None
}

/// Nutzung des eigenen Abos durch Teammitglieder, je Tag (für den Admin).
#[tauri::command]
pub fn collab_team_usage() -> Value {
    let book = load_book();
    let days: BTreeMap<String, &BTreeMap<String, UsageEntry>> = book.iter().map(|(d, m)| (d.to_string(), m)).collect();
    json!({ "today": unix_now() / 86_400, "days": days })
}

// ---------- Teams anlegen, beitreten, verlassen ----------

#[tauri::command]
pub async fn collab_team_create(
    app: AppHandle,
    state: State<'_, CollabState>,
    name: String,
    relay: Option<String>,
    lan_port: Option<u16>,
) -> CmdResult<TeamView> {
    crate::policy::check_section("collab")?;
    let relay = match relay.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(url) if url.starts_with("ws://") || url.starts_with("wss://") => url.trim_end_matches('/').to_string(),
        Some(_) => return Err("Die Relay-Adresse muss mit ws:// oder wss:// beginnen.".into()),
        None => {
            let port = ensure_lan(&state.0, lan_port.unwrap_or(LAN_PORT)).await?;
            let ip = lan_ip().ok_or("Keine Adresse im LAN gefunden")?;
            format!("ws://{ip}:{port}")
        }
    };
    let mut g = state.0.lock().unwrap();
    let secret = TeamSecret {
        id: b64(&random::<16>()),
        name: clean_name(&json!(name)),
        relay,
        key: b64(&random::<32>()),
        owner: Some(g.me.id()),
        projects: json!([]),
        projects_at: 0,
    };
    let id = secret.id.clone();
    connect(&app, &state.0, &mut g, secret)?;
    persist(&g);
    update(&app, &mut g, &id, "angelegt", |_, _| Ok("Team angelegt".into()))
}

#[tauri::command]
pub fn collab_team_join(app: AppHandle, state: State<'_, CollabState>, link: String) -> CmdResult<TeamView> {
    crate::policy::check_section("collab")?;
    let secret = parse_team_link(&link)?;
    let id = secret.id.clone();
    let mut g = state.0.lock().unwrap();
    if !g.teams.contains_key(&id) {
        connect(&app, &state.0, &mut g, secret)?;
        persist(&g);
    }
    Ok(g.teams[&id].view(&g.me.id()))
}

#[tauri::command]
pub fn collab_team_leave(app: AppHandle, state: State<'_, CollabState>, team_id: String) -> CmdResult<()> {
    let mut g = state.0.lock().unwrap();
    let me = g.me.id();
    // Ein verwaltetes Mitglied kann sich den Regeln nicht per Klick entziehen.
    if g.teams.get(&team_id).and_then(|t| t.state.as_ref()).is_some_and(|(_, s)| s.policy_for(&me).is_some_and(|p| p.access("collab") != policy::Access::Edit)) {
        return Err("POLICY: Das Team kann nur ein Admin verlassen lassen (Bereich „Zusammenarbeit“ ist gesperrt).".into());
    }
    send(&g, &team_id, &json!({ "t": "bye", "id": message_id() }));
    g.teams.remove(&team_id);
    for h in g.hosts.values_mut().filter(|h| h.team.as_deref() == Some(team_id.as_str())) {
        h.team = None;
    }
    persist(&g);
    policy::remove_stored(&team_id);
    super::release_lan(&mut g);
    policy::changed(&app);
    Ok(())
}

/// Gemeinsame Projektliste ersetzen (der neueste Stand gewinnt).
#[tauri::command]
pub fn collab_team_projects(app: AppHandle, state: State<'_, CollabState>, team_id: String, projects: Value) -> CmdResult<()> {
    if !projects.is_array() {
        return Err("Projektliste erwartet".into());
    }
    let mut g = state.0.lock().unwrap();
    let t = g.teams.get_mut(&team_id).ok_or("Unbekanntes Team")?;
    t.secret.projects = projects;
    t.secret.projects_at = (unix_now() * 1000).max(t.secret.projects_at + 1);
    persist(&g);
    send_projects(&g, &team_id);
    emit(&app, &g, &team_id);
    Ok(())
}

/// Eigener Name und Agent-Backends mit Abo, für alle Teams.
#[tauri::command]
pub fn collab_team_profile(state: State<'_, CollabState>, name: String, backends: Value) {
    let mut g = state.0.lock().unwrap();
    let profile = json!({ "name": clean_name(&json!(name)), "backends": if backends.is_array() { backends } else { json!([]) } });
    if g.profile != profile {
        g.profile = profile;
        announce_all(&mut g);
    }
}

#[tauri::command]
pub fn collab_teams(state: State<'_, CollabState>) -> Vec<TeamView> {
    let g = state.0.lock().unwrap();
    let me = g.me.id();
    g.teams.values().map(|t| t.view(&me)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::crypto::Identity;

    #[test]
    fn team_link_roundtrip() {
        let owner = Identity::generate().id();
        let secret = TeamSecret {
            id: b64(&random::<16>()),
            name: "Die Drei".into(),
            relay: "wss://relay.example.org".into(),
            key: b64(&random::<32>()),
            owner: Some(owner.clone()),
            projects: json!([]),
            projects_at: 0,
        };
        let link = team_link(&secret);
        assert!(!link.split('#').next().unwrap().contains(&secret.key));
        let parsed = parse_team_link(&link).unwrap();
        assert_eq!((parsed.id, parsed.name, parsed.relay, parsed.key, parsed.owner), (secret.id, secret.name, secret.relay, secret.key, Some(owner)));
        assert!(parse_team_link("brise://join/abc#x").is_err());
        // Alte Links ohne Besitzer bleiben gültig.
        let old = link.replace(&format!("&owner={}", secret.owner.unwrap()), "");
        assert_eq!(parse_team_link(&old).unwrap().owner, None);
    }

    fn signed(by: &Identity, state: &TeamState) -> SignedDoc {
        let body = serde_json::to_string(state).unwrap();
        SignedDoc { by: by.id(), sig: by.sign(&policy::signed_bytes(&state.team, &body)), body }
    }

    #[test]
    fn signed_state_chain() {
        let (owner, admin, member) = (Identity::generate(), Identity::generate(), Identity::generate());
        let base = TeamState { team: "team-0123456789abcdef".into(), owner: owner.id(), ..Default::default() };
        // Erster Stand vom Besitzer: ernennt einen Admin und sperrt Modelle.
        let first = TeamState {
            version: 1,
            admins: vec![admin.id()],
            default_policy: Policy { models: Some(vec!["devstral".into()]), ..Default::default() },
            ..base.clone()
        };
        let doc = signed(&owner, &first);
        let opened = doc.open(&base.team).unwrap();
        assert!(base.accepts(&opened, &doc.by).is_ok());
        assert_eq!(opened.policy_for(&member.id()).unwrap().models, Some(vec!["devstral".into()]));
        assert!(opened.policy_for(&admin.id()).is_none());
        // Ein Mitglied kann sich nicht selbst freischalten.
        let forged = TeamState { version: 2, default_policy: Policy::default(), ..opened.clone() };
        let doc = signed(&member, &forged);
        assert!(opened.accepts(&doc.open(&base.team).unwrap(), &doc.by).is_err());
        // Manipulierter Inhalt mit alter Signatur: Signatur passt nicht.
        let mut tampered = signed(&admin, &TeamState { version: 3, ..opened.clone() });
        tampered.body = tampered.body.replace("devstral", "alles");
        assert!(tampered.open(&base.team).is_none());
        // Für ein anderes Team signiert: abgelehnt.
        let other = signed(&owner, &TeamState { team: "anderes-team-0000000".into(), version: 4, ..opened.clone() });
        assert!(other.open(&base.team).is_none());
    }
}
