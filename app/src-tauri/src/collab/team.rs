//! Teams: ein dauerhafter, verschlüsselter Raum auf dem Relay.
//!
//! Mitglieder kündigen sich regelmäßig an (Name, Agent-Backends mit Abo,
//! geteilte Sessions samt Beitritts-Link) und teilen eine Projektliste.
//! Einladung: `brise://team/<id>?relay=<url>&name=<name>#<schlüssel>`.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};

use super::crypto::{self, b64, random, unb64};
use super::link::{Link, decode, encode};
use super::secrets::{self, Secrets, TeamSecret};
use super::transport::Transport;
use super::{CmdResult, CollabState, Inner, LAN_PORT, clean_name, ensure_lan, lan_ip, message_id, unix_now};

/// Nach so langer Stille gilt ein Mitglied als abwesend.
const OFFLINE_AFTER: Duration = Duration::from_secs(75);
const ANNOUNCE_EVERY: Duration = Duration::from_secs(25);

pub(super) struct Team {
    pub secret: TeamSecret,
    key: [u8; 32],
    transport: Transport,
    connected: bool,
    error: Option<String>,
    members: BTreeMap<String, Member>,
    seen: VecDeque<String>,
    generation: u64,
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
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn team_link(s: &TeamSecret) -> String {
    format!("brise://team/{}?relay={}&name={}#{}", s.id, encode(&s.relay), encode(&s.name), s.key)
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
    let (mut relay, mut name) = (None, None);
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("relay", v)) => relay = decode(v),
            Some(("name", v)) => name = decode(v),
            _ => {}
        }
    }
    let relay = relay.filter(|r| r.starts_with("ws://") || r.starts_with("wss://")).ok_or("Im Link fehlt die Relay-Adresse.")?;
    Ok(TeamSecret {
        id: id.to_string(),
        name: clean_name(&json!(name.unwrap_or_else(|| "Team".into()))),
        relay,
        key: key.to_string(),
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
        }
    }
}

pub(super) fn is_member(g: &Inner, id: &str) -> bool {
    g.teams.values().any(|t| t.members.contains_key(id))
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
                }
                emit(&app_s, &g, &id_s);
            },
        )
    };
    g.teams.insert(
        id.clone(),
        Team { secret, key, transport, connected: false, error: None, members: BTreeMap::new(), seen: VecDeque::new(), generation },
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

#[tauri::command]
pub async fn collab_team_create(
    app: AppHandle,
    state: State<'_, CollabState>,
    name: String,
    relay: Option<String>,
    lan_port: Option<u16>,
) -> CmdResult<TeamView> {
    let relay = match relay.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(url) if url.starts_with("ws://") || url.starts_with("wss://") => url.trim_end_matches('/').to_string(),
        Some(_) => return Err("Die Relay-Adresse muss mit ws:// oder wss:// beginnen.".into()),
        None => {
            let port = ensure_lan(&state.0, lan_port.unwrap_or(LAN_PORT)).await?;
            let ip = lan_ip().ok_or("Keine Adresse im LAN gefunden")?;
            format!("ws://{ip}:{port}")
        }
    };
    let secret = TeamSecret {
        id: b64(&random::<16>()),
        name: clean_name(&json!(name)),
        relay,
        key: b64(&random::<32>()),
        projects: json!([]),
        projects_at: 0,
    };
    let id = secret.id.clone();
    let mut g = state.0.lock().unwrap();
    connect(&app, &state.0, &mut g, secret)?;
    persist(&g);
    Ok(g.teams[&id].view(&g.me.id()))
}

#[tauri::command]
pub fn collab_team_join(app: AppHandle, state: State<'_, CollabState>, link: String) -> CmdResult<TeamView> {
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
pub fn collab_team_leave(state: State<'_, CollabState>, team_id: String) {
    let mut g = state.0.lock().unwrap();
    send(&g, &team_id, &json!({ "t": "bye", "id": message_id() }));
    g.teams.remove(&team_id);
    for h in g.hosts.values_mut().filter(|h| h.team.as_deref() == Some(team_id.as_str())) {
        h.team = None;
    }
    persist(&g);
    super::release_lan(&mut g);
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

    #[test]
    fn team_link_roundtrip() {
        let secret = TeamSecret {
            id: b64(&random::<16>()),
            name: "Die Drei".into(),
            relay: "wss://relay.example.org".into(),
            key: b64(&random::<32>()),
            projects: json!([]),
            projects_at: 0,
        };
        let link = team_link(&secret);
        assert!(!link.split('#').next().unwrap().contains(&secret.key));
        let parsed = parse_team_link(&link).unwrap();
        assert_eq!((parsed.id, parsed.name, parsed.relay, parsed.key), (secret.id, secret.name, secret.relay, secret.key));
        assert!(parse_team_link("brise://join/abc#x").is_err());
    }
}
