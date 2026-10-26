//! Kollaboration: Sessions teilen (Host), geteilten Sessions beitreten (Gast)
//! und Teams (Präsenz, Sessions der anderen, gemeinsame Projekte).
//!
//! Ein Agent läuft immer nur beim Host, mit dessen Abo. Dieses Modul
//! transportiert verschlüsselte Nachrichten über ein Relay (oder Brises
//! eingebautes LAN-Relay), setzt Rollen und Abo-Regeln durch und zählt die
//! Nutzung pro Gast. Welche Ereignisse gespiegelt werden, entscheidet die
//! Oberfläche (`src/lib/collab.ts`); Protokoll in `docs/collab-protocol.md`.

mod crypto;
mod link;
mod secrets;
pub mod team;
mod transport;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use crypto::{Identity, b64, random, unb64};
use link::Link;
use transport::Transport;

type CmdResult<T> = Result<T, String>;

/// Standardport des eingebauten LAN-Relays.
const LAN_PORT: u16 = 47800;
const MAX_QUEUE: usize = 20;
const MAX_PROMPT: usize = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Sieht nur zu.
    Viewer,
    /// Darf Prompts in die Warteschlange stellen und abbrechen.
    Collaborator,
    /// Darf außerdem Freigaben entscheiden.
    Approver,
}

/// Was Gäste auf dem Abo des Hosts dürfen.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// Prompts von Gästen laufen auf dem Abo des Hosts. Aus: nur zusehen.
    #[serde(default = "yes")]
    guest_prompts: bool,
    /// Höchstens so viele ausgeführte Prompts je Gast und Tag.
    daily_prompts: Option<u32>,
    /// Höchstens so viele Tokens je Gast und Tag.
    daily_tokens: Option<u64>,
}

fn yes() -> bool {
    true
}

impl Default for Policy {
    fn default() -> Self {
        Self { guest_prompts: true, daily_prompts: None, daily_tokens: None }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    id: String,
    name: String,
    role: Role,
    online: bool,
    /// Auch Mitglied eines gemeinsamen Teams.
    team: bool,
    /// Nutzung auf dem Abo des Hosts, heute.
    prompts: u32,
    tokens: u64,
    #[serde(skip)]
    day: u64,
    #[serde(skip)]
    last_seen: Option<Instant>,
}

impl Participant {
    fn roll_day(&mut self) {
        let today = unix_now() / 86_400;
        if self.day != today {
            self.day = today;
            self.prompts = 0;
            self.tokens = 0;
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queued {
    id: String,
    author: String,
    author_id: String,
    text: String,
}

fn default_backend() -> String {
    "vibe".into()
}

fn default_team_role() -> Role {
    Role::Collaborator
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOptions {
    name: String,
    /// Relay-Adresse (ws:// oder wss://). Leer = eingebautes LAN-Relay.
    relay: Option<String>,
    lan_port: Option<u16>,
    default_role: Role,
    /// Werkzeug-Ausgaben (z. B. gelesene Dateien) an Gäste schicken.
    show_outputs: bool,
    expires_minutes: Option<u64>,
    /// Agent-Backend der Session, z. B. `vibe` oder `claude-code`.
    #[serde(default = "default_backend")]
    backend: String,
    /// Abo, auf dem die Session läuft (Anzeige), z. B. „Mistral Vibe Pro“.
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    project: Option<String>,
    /// Session im Team ankündigen (Team-ID).
    #[serde(default)]
    team: Option<String>,
    /// Rolle für Mitglieder gemeinsamer Teams.
    #[serde(default = "default_team_role")]
    team_role: Role,
    #[serde(default)]
    policy: Policy,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    session_id: String,
    link: String,
    relay: String,
    lan: bool,
    connected: bool,
    error: Option<String>,
    participants: Vec<Participant>,
    queue: Vec<Queued>,
    default_role: Role,
    team_role: Role,
    show_outputs: bool,
    expires: Option<u64>,
    backend: String,
    billed_to: Value,
    team: Option<String>,
    policy: Policy,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestView {
    room: String,
    session_id: String,
    relay: String,
    me: String,
    connected: bool,
    error: Option<String>,
}

struct Host {
    session_id: String,
    link: Link,
    me: Identity,
    name: String,
    transport: Transport,
    connected: bool,
    error: Option<String>,
    seq: u64,
    participants: BTreeMap<String, Participant>,
    /// Entfernte Teilnehmer: Nachrichten werden ignoriert.
    blocked: Vec<String>,
    queue: Vec<Queued>,
    default_role: Role,
    team_role: Role,
    show_outputs: bool,
    lan: bool,
    backend: String,
    plan: Option<String>,
    title: Option<String>,
    project: Option<String>,
    team: Option<String>,
    policy: Policy,
    /// Gast-Prompt, der gerade gestartet wird bzw. läuft (für die Nutzung).
    next_author: Option<String>,
    running_author: Option<String>,
    running: bool,
    /// Zuletzt gesehene Nachrichten-IDs gegen doppelt eingespielte Frames.
    seen: VecDeque<String>,
}

struct Guest {
    link: Link,
    session_id: String,
    name: String,
    transport: Transport,
    connected: bool,
    error: Option<String>,
    last_seq: u64,
    synced: bool,
}

struct Lan {
    port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct Inner {
    /// Identität dieser Brise-Installation (dauerhaft, siehe secrets.rs).
    me: Identity,
    /// Name und Agent-Backends samt Abo, von der Oberfläche gesetzt.
    profile: Value,
    hosts: HashMap<String, Host>,
    guests: HashMap<String, Guest>,
    teams: HashMap<String, team::Team>,
    lan: Option<Lan>,
}

pub struct CollabState(Arc<Mutex<Inner>>);

impl Default for CollabState {
    fn default() -> Self {
        let stored = secrets::load();
        let me = match stored.seed.as_deref().and_then(unb64::<32>) {
            Some(seed) => Identity::from_seed(seed),
            None => {
                let me = Identity::generate();
                secrets::save(&secrets::Secrets { seed: Some(b64(&me.seed())), teams: stored.teams.clone() });
                me
            }
        };
        Self(Arc::new(Mutex::new(Inner {
            me,
            profile: json!({ "name": "", "backends": [] }),
            hosts: HashMap::new(),
            guests: HashMap::new(),
            teams: HashMap::new(),
            lan: None,
        })))
    }
}

/// Beim Start: gespeicherte Teams verbinden.
pub fn start(app: &AppHandle) {
    team::start(app.clone(), app.state::<CollabState>().0.clone());
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn message_id() -> String {
    b64(&random::<12>())
}

fn clean_name(v: &Value) -> String {
    let name: String = v.as_str().unwrap_or("").trim().chars().filter(|c| !c.is_control()).take(40).collect();
    if name.is_empty() { "Gast".into() } else { name }
}

/// Werkzeug-Ausgaben entfernen: Gäste sehen dann nur Konversation und Diffs.
fn strip_outputs(ev: &mut Value) {
    match ev["t"].as_str() {
        Some("snapshot") => {
            if let Some(items) = ev["session"]["items"].as_array_mut() {
                for item in items.iter_mut().filter(|i| i["type"] == "tool") {
                    item["output"] = json!([]);
                    if let Some(o) = item.as_object_mut() {
                        o.remove("rawOutput");
                    }
                }
            }
        }
        Some("update") => {
            let u = &mut ev["update"];
            if matches!(u["sessionUpdate"].as_str(), Some("tool_call" | "tool_call_update")) {
                if let Some(content) = u["content"].as_array_mut() {
                    content.retain(|c| c["type"] == "diff");
                }
                if let Some(o) = u.as_object_mut() {
                    o.remove("rawOutput");
                }
            }
        }
        _ => {}
    }
}

impl Host {
    fn send(&mut self, mut body: Value) {
        self.seq += 1;
        body["seq"] = json!(self.seq);
        self.transport.send(crypto::seal(&self.link.key, &self.link.room, &self.me, &body));
    }

    /// Wessen Abo die Session nutzt – für Anzeige und Usage pro Person.
    fn billed_to(&self) -> Value {
        json!({ "id": self.me.id(), "name": self.name, "plan": self.plan })
    }

    fn view(&self) -> HostView {
        HostView {
            session_id: self.session_id.clone(),
            link: self.link.to_url(),
            relay: self.link.relay.clone(),
            lan: self.lan,
            connected: self.connected,
            error: self.error.clone(),
            participants: self.participants.values().cloned().collect(),
            queue: self.queue.clone(),
            default_role: self.default_role,
            team_role: self.team_role,
            show_outputs: self.show_outputs,
            expires: self.link.expires,
            backend: self.backend.clone(),
            billed_to: self.billed_to(),
            team: self.team.clone(),
            policy: self.policy.clone(),
        }
    }

    /// Eintrag für die Team-Ankündigung (inklusive Beitritts-Link).
    fn team_entry(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "title": self.title,
            "project": self.project,
            "backend": self.backend,
            "billedTo": self.billed_to(),
            "policy": self.policy,
            "link": self.link.to_url(),
            "running": self.running,
            "participants": self.participants.values().filter(|p| p.online).count(),
        })
    }

    /// Rollen und Abo-Regeln gehen signiert an alle – Gäste richten ihre Oberfläche danach.
    fn send_roster(&mut self) {
        let participants: Vec<Value> = self
            .participants
            .values()
            .map(|p| json!({ "id": p.id, "name": p.name, "role": p.role, "online": p.online, "prompts": p.prompts, "tokens": p.tokens }))
            .collect();
        let body = json!({
            "t": "roster",
            "host": { "id": self.me.id(), "name": self.name },
            "participants": participants,
            "expires": self.link.expires,
            "backend": self.backend,
            "billedTo": self.billed_to(),
            "policy": self.policy,
        });
        self.send(body);
    }

    fn send_queue(&mut self) {
        let items: Vec<Value> = self.queue.iter().map(|q| json!({ "id": q.id, "author": q.author, "authorId": q.author_id, "text": q.text })).collect();
        self.send(json!({ "t": "queue", "items": items }));
    }

    /// Darf dieser Gast jetzt noch einen Prompt auf das Abo des Hosts stellen?
    fn prompt_refusal(&mut self, from: &str) -> Option<String> {
        if !self.policy.guest_prompts {
            return Some(format!("{} lässt in dieser Session keine Prompts von Gästen auf sein Abo zu.", self.name));
        }
        if self.queue.len() >= MAX_QUEUE {
            return Some("Die Warteschlange ist voll.".into());
        }
        let queued = self.queue.iter().filter(|q| q.author_id == from).count() as u32;
        let p = self.participants.get_mut(from)?;
        p.roll_day();
        if let Some(max) = self.policy.daily_prompts.filter(|max| p.prompts + queued >= *max) {
            return Some(format!("Tageslimit erreicht: {max} {} pro Tag auf dem Abo von {}.", if max == 1 { "Prompt" } else { "Prompts" }, self.name));
        }
        if let Some(max) = self.policy.daily_tokens.filter(|max| p.tokens >= *max) {
            return Some(format!("Tageslimit erreicht: {max} Tokens pro Tag auf dem Abo von {}.", self.name));
        }
        None
    }
}

fn emit_host(app: &AppHandle, host: &Host) {
    let _ = app.emit("collab:host", host.view());
}

fn emit_guest_status(app: &AppHandle, room: &str, guest: &Guest) {
    let _ = app.emit("collab:guest-status", json!({ "room": room, "connected": guest.connected, "error": guest.error }));
}

/// Nachricht eines Gasts beim Host.
fn host_frame(app: &AppHandle, inner: &Mutex<Inner>, session_id: &str, frame: &[u8]) {
    let mut g = inner.lock().unwrap();
    let Some(h) = g.hosts.get(session_id) else { return };
    let Some((from, body)) = crypto::open(&h.link.key, &h.link.room, frame) else { return };
    let in_team = team::is_member(&g, &from);
    let Some(h) = g.hosts.get_mut(session_id) else { return };
    // Eigene Frames kommen beim Neuverbinden aus dem Puffer des Relays zurück.
    if from == h.me.id() || h.blocked.contains(&from) {
        return;
    }
    if let Some(id) = body["id"].as_str() {
        if h.seen.iter().any(|s| s == id) {
            return;
        }
        h.seen.push_back(id.to_string());
        if h.seen.len() > 512 {
            h.seen.pop_front();
        }
    }
    let t = body["t"].as_str().unwrap_or("");
    let now = Instant::now();
    if t == "hello" {
        let known = h.participants.contains_key(&from);
        if !known && h.link.expires.is_some_and(|e| unix_now() > e) {
            return;
        }
        // Teammitglieder erkennt der Host an ihrer festen Identität.
        let role = if in_team { h.team_role } else { h.default_role };
        let p = h.participants.entry(from.clone()).or_insert_with(|| Participant {
            id: from.clone(),
            name: String::new(),
            role,
            online: true,
            team: in_team,
            prompts: 0,
            tokens: 0,
            day: unix_now() / 86_400,
            last_seen: None,
        });
        p.name = clean_name(&body["name"]);
        p.online = true;
        p.last_seen = Some(now);
        h.send_roster();
        h.send_queue();
        emit_host(app, h);
        // Die Oberfläche schickt daraufhin einen Snapshot der Session.
        let _ = app.emit("collab:snapshot-request", json!({ "sessionId": session_id }));
        team::announce_all(&mut g);
        return;
    }
    let Some(p) = h.participants.get_mut(&from) else { return };
    let was_online = p.online;
    p.last_seen = Some(now);
    p.online = t != "bye";
    let (role, name) = (p.role, p.name.clone());
    match t {
        "presence" | "bye" => {
            if was_online != (t != "bye") {
                h.send_roster();
                emit_host(app, h);
                team::announce_all(&mut g);
            }
        }
        "prompt" if role >= Role::Collaborator => {
            let text: String = body["text"].as_str().unwrap_or("").trim().chars().take(MAX_PROMPT).collect();
            if text.is_empty() {
                return;
            }
            let id = body["id"].as_str().map(str::to_string).unwrap_or_else(message_id);
            if let Some(reason) = h.prompt_refusal(&from) {
                h.send(json!({ "t": "rejected", "to": from, "ref": id, "reason": reason }));
                return;
            }
            h.queue.push(Queued { id, author: name, author_id: from, text });
            h.send_queue();
            emit_host(app, h);
        }
        "decide" if role >= Role::Approver => {
            let _ = app.emit(
                "collab:decide",
                json!({ "sessionId": session_id, "key": body["key"], "optionId": body["optionId"], "by": name }),
            );
        }
        "cancel" if role >= Role::Collaborator => {
            let _ = app.emit("collab:cancel", json!({ "sessionId": session_id, "by": name }));
        }
        _ => {}
    }
}

/// Nachricht des Hosts beim Gast: nur echte Host-Nachrichten, in Reihenfolge.
fn guest_frame(app: &AppHandle, inner: &Mutex<Inner>, room: &str, frame: &[u8]) {
    let mut g = inner.lock().unwrap();
    let Some(guest) = g.guests.get_mut(room) else { return };
    let Some((from, body)) = crypto::open(&guest.link.key, room, frame) else { return };
    if from != guest.link.host {
        return;
    }
    let seq = body["seq"].as_u64().unwrap_or(0);
    let t = body["t"].as_str().unwrap_or("");
    if t == "snapshot" && (!guest.synced || seq > guest.last_seq) {
        guest.synced = true;
    } else if seq <= guest.last_seq {
        return;
    } else if !guest.synced && !matches!(t, "roster" | "queue" | "ended" | "rejected") {
        // Ohne Snapshot ergeben einzelne Ereignisse keine Ansicht.
        guest.last_seq = seq;
        return;
    }
    guest.last_seq = seq;
    let _ = app.emit("collab:guest", json!({ "room": room, "sessionId": guest.session_id, "body": body }));
}

fn send_as_guest(inner: &Mutex<Inner>, room: &str, mut body: Value) -> CmdResult<()> {
    let g = inner.lock().unwrap();
    let guest = g.guests.get(room).ok_or("Du bist dieser Session nicht beigetreten.")?;
    body["id"] = json!(message_id());
    guest.transport.send(crypto::seal(&guest.link.key, room, &g.me, &body));
    Ok(())
}

/// Adresse im LAN, unter der andere diesen Rechner erreichen. Es wird kein
/// Paket verschickt, `connect` wählt nur die passende Schnittstelle.
fn lan_ip() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

async fn ensure_lan(inner: &Mutex<Inner>, port: u16) -> CmdResult<u16> {
    if let Some(lan) = &inner.lock().unwrap().lan {
        return Ok(lan.port);
    }
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        // Port belegt: einen freien nehmen, er steht ja im Link.
        Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| format!("LAN-Relay: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let task = tauri::async_runtime::spawn(async move {
        let cfg = brise_relay::Config { max_rooms: 32, ..Default::default() };
        if let Err(e) = brise_relay::serve(listener, cfg).await {
            eprintln!("LAN-Relay beendet: {e}");
        }
    });
    let mut g = inner.lock().unwrap();
    if let Some(existing) = &g.lan {
        task.abort();
        return Ok(existing.port);
    }
    g.lan = Some(Lan { port, task });
    Ok(port)
}

/// LAN-Relay stoppen, wenn weder Freigaben noch Teams es brauchen.
fn release_lan(g: &mut Inner) {
    let Some(lan) = &g.lan else { return };
    let suffix = format!(":{}", lan.port);
    let team_uses = g.teams.values().any(|t| t.secret.relay.ends_with(&suffix) && team::is_own_lan(&t.secret.relay));
    if !g.hosts.values().any(|h| h.lan) && !team_uses {
        if let Some(lan) = g.lan.take() {
            lan.task.abort();
        }
    }
}

/// Markiert Gäste ohne Lebenszeichen als abwesend.
fn spawn_host_ticker(app: AppHandle, inner: Arc<Mutex<Inner>>, session_id: String, room: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let mut g = inner.lock().unwrap();
            let Some(h) = g.hosts.get_mut(&session_id).filter(|h| h.link.room == room) else { return };
            let mut changed = false;
            for p in h.participants.values_mut() {
                if p.online && p.last_seen.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                    p.online = false;
                    changed = true;
                }
            }
            if changed {
                h.send_roster();
                emit_host(&app, h);
            }
        }
    });
}

/// Lebenszeichen des Gasts alle 20 s.
fn spawn_guest_ticker(inner: Arc<Mutex<Inner>>, room: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if send_as_guest(&inner, &room, json!({ "t": "presence", "state": "online" })).is_err() {
                return;
            }
        }
    });
}

// ---------- Host ----------

#[tauri::command]
pub async fn collab_share(
    app: AppHandle,
    state: State<'_, CollabState>,
    session_id: String,
    options: ShareOptions,
) -> CmdResult<HostView> {
    if let Some(h) = state.0.lock().unwrap().hosts.get(&session_id) {
        return Ok(h.view());
    }
    let custom = options.relay.as_deref().map(str::trim).filter(|r| !r.is_empty()).map(|r| r.trim_end_matches('/').to_string());
    let (public, local, lan) = match custom {
        Some(url) => {
            if !(url.starts_with("ws://") || url.starts_with("wss://")) {
                return Err("Die Relay-Adresse muss mit ws:// oder wss:// beginnen.".into());
            }
            (url.clone(), url, false)
        }
        None => {
            let port = ensure_lan(&state.0, options.lan_port.unwrap_or(LAN_PORT)).await?;
            let ip = lan_ip().map(|ip| ip.to_string()).unwrap_or_else(|| "127.0.0.1".into());
            (format!("ws://{ip}:{port}"), format!("ws://127.0.0.1:{port}"), true)
        }
    };
    // Erst eintragen, dann kann der Transport-Status ankommen.
    let mut g = state.0.lock().unwrap();
    let me = g.me.clone();
    let link = Link {
        room: b64(&random::<16>()),
        relay: public,
        key: random::<32>(),
        host: me.id(),
        expires: options.expires_minutes.filter(|m| *m > 0).map(|m| unix_now() + m * 60),
    };
    let room = link.room.clone();
    let transport = {
        let (app_f, inner_f, sid_f) = (app.clone(), state.0.clone(), session_id.clone());
        let (app_s, inner_s, sid_s) = (app.clone(), state.0.clone(), session_id.clone());
        Transport::spawn(
            Link::socket_url(&local, &room),
            move |frame| host_frame(&app_f, &inner_f, &sid_f, &frame),
            move |connected, error| {
                let mut g = inner_s.lock().unwrap();
                if let Some(h) = g.hosts.get_mut(&sid_s) {
                    h.connected = connected;
                    h.error = error;
                    emit_host(&app_s, h);
                }
            },
        )
    };
    let team = options.team.filter(|t| g.teams.contains_key(t));
    let host = Host {
        session_id: session_id.clone(),
        link,
        me,
        name: clean_name(&json!(options.name)),
        transport,
        connected: false,
        error: None,
        seq: 0,
        participants: BTreeMap::new(),
        blocked: Vec::new(),
        queue: Vec::new(),
        default_role: options.default_role,
        team_role: options.team_role,
        show_outputs: options.show_outputs,
        lan,
        backend: options.backend,
        plan: options.plan,
        title: options.title,
        project: options.project,
        team,
        policy: options.policy,
        next_author: None,
        running_author: None,
        running: false,
        seen: VecDeque::new(),
    };
    let view = host.view();
    g.hosts.insert(session_id.clone(), host);
    team::announce_all(&mut g);
    drop(g);
    spawn_host_ticker(app, state.0.clone(), session_id, room);
    Ok(view)
}

/// Ereignisse der geteilten Session an alle Gäste (in Reihenfolge, signiert).
#[tauri::command]
pub fn collab_publish(app: AppHandle, state: State<'_, CollabState>, session_id: String, events: Vec<Value>) {
    let mut g = state.0.lock().unwrap();
    let Some(h) = g.hosts.get_mut(&session_id) else { return };
    let mut usage_changed = false;
    let mut running_changed = false;
    for mut ev in events {
        match ev["t"].as_str() {
            Some("snapshot" | "update" | "permission" | "permission_closed" | "notice") => {}
            Some("prompt") => {
                // Ein Gast-Prompt aus der Warteschlange – oder ein eigener des Hosts.
                h.running_author = h.next_author.take();
                h.running = true;
                running_changed = true;
                ev["billedTo"] = h.billed_to();
                ev["backend"] = json!(h.backend);
            }
            Some("turn_end") => {
                let tokens = ev["tokens"].as_u64().unwrap_or(0);
                let author = h.running_author.take();
                h.running = false;
                running_changed = true;
                let mut author_name = Value::Null;
                if let Some(p) = author.as_ref().and_then(|a| h.participants.get_mut(a)) {
                    p.roll_day();
                    p.tokens += tokens;
                    author_name = json!(p.name);
                    usage_changed = true;
                }
                ev["billedTo"] = h.billed_to();
                ev["backend"] = json!(h.backend);
                // Für die Usage-Anzeige: wer hat auf wessen Abo wie viel verbraucht.
                let _ = app.emit(
                    "collab:usage",
                    json!({
                        "sessionId": session_id, "backend": h.backend, "billedTo": h.billed_to(),
                        "authorId": author, "authorName": author_name, "tokens": tokens,
                    }),
                );
            }
            _ => continue,
        }
        if !h.show_outputs {
            strip_outputs(&mut ev);
        }
        h.send(ev);
    }
    if usage_changed {
        h.send_roster();
        emit_host(&app, h);
    }
    if running_changed {
        team::announce_all(&mut g);
    }
}

/// Titel der geteilten Session hat sich geändert (für die Team-Ankündigung).
#[tauri::command]
pub fn collab_session_meta(state: State<'_, CollabState>, session_id: String, title: Option<String>) {
    let mut g = state.0.lock().unwrap();
    if let Some(h) = g.hosts.get_mut(&session_id) {
        if h.title != title {
            h.title = title;
            team::announce_all(&mut g);
        }
    }
}

#[tauri::command]
pub fn collab_set_role(app: AppHandle, state: State<'_, CollabState>, session_id: String, participant: String, role: Role) -> CmdResult<()> {
    let mut g = state.0.lock().unwrap();
    let h = g.hosts.get_mut(&session_id).ok_or("Session ist nicht geteilt")?;
    h.participants.get_mut(&participant).ok_or("Unbekannter Teilnehmer")?.role = role;
    h.send_roster();
    emit_host(&app, h);
    Ok(())
}

/// Entzieht einem Teilnehmer die Freigabe: seine Nachrichten zählen nicht mehr.
#[tauri::command]
pub fn collab_remove(app: AppHandle, state: State<'_, CollabState>, session_id: String, participant: String) -> CmdResult<()> {
    let mut g = state.0.lock().unwrap();
    let h = g.hosts.get_mut(&session_id).ok_or("Session ist nicht geteilt")?;
    h.participants.remove(&participant);
    h.queue.retain(|q| q.author_id != participant);
    h.blocked.push(participant);
    h.send_roster();
    h.send_queue();
    emit_host(&app, h);
    Ok(())
}

#[tauri::command]
pub fn collab_set_default_role(app: AppHandle, state: State<'_, CollabState>, session_id: String, role: Role) -> CmdResult<()> {
    let mut g = state.0.lock().unwrap();
    let h = g.hosts.get_mut(&session_id).ok_or("Session ist nicht geteilt")?;
    h.default_role = role;
    emit_host(&app, h);
    Ok(())
}

/// Abo-Regeln ändern: Gast-Prompts erlauben, Tageslimits.
#[tauri::command]
pub fn collab_set_policy(app: AppHandle, state: State<'_, CollabState>, session_id: String, policy: Policy) -> CmdResult<()> {
    let mut g = state.0.lock().unwrap();
    let h = g.hosts.get_mut(&session_id).ok_or("Session ist nicht geteilt")?;
    h.policy = policy;
    h.send_roster();
    emit_host(&app, h);
    team::announce_all(&mut g);
    Ok(())
}

/// Nimmt einen Gast-Prompt aus der Warteschlange. `run`: er wird gleich
/// ausgeführt und zählt zur Nutzung des Gasts; sonst ist er verworfen.
#[tauri::command]
pub fn collab_queue_take(app: AppHandle, state: State<'_, CollabState>, session_id: String, id: String, run: bool) -> CmdResult<Option<Queued>> {
    let mut g = state.0.lock().unwrap();
    let h = g.hosts.get_mut(&session_id).ok_or("Session ist nicht geteilt")?;
    let Some(pos) = h.queue.iter().position(|q| q.id == id) else { return Ok(None) };
    let item = h.queue.remove(pos);
    if run {
        if let Some(p) = h.participants.get_mut(&item.author_id) {
            p.roll_day();
            p.prompts += 1;
        }
        h.next_author = Some(item.author_id.clone());
        h.send_roster();
    }
    h.send_queue();
    emit_host(&app, h);
    Ok(Some(item))
}

#[tauri::command]
pub fn collab_unshare(app: AppHandle, state: State<'_, CollabState>, session_id: String) {
    let mut g = state.0.lock().unwrap();
    if let Some(mut h) = g.hosts.remove(&session_id) {
        h.send(json!({ "t": "ended" }));
        // Der Transport verschickt noch das Ende und schließt dann.
    }
    release_lan(&mut g);
    team::announce_all(&mut g);
    let _ = app.emit("collab:host-ended", json!({ "sessionId": session_id }));
}

// ---------- Gast ----------

#[tauri::command]
pub fn collab_join(app: AppHandle, state: State<'_, CollabState>, link: String, name: String) -> CmdResult<GuestView> {
    let link = Link::parse(&link)?;
    if link.expires.is_some_and(|e| unix_now() > e) {
        return Err("Dieser Einladungslink ist abgelaufen.".into());
    }
    let room = link.room.clone();
    let session_id = format!("collab-{room}");
    let mut g = state.0.lock().unwrap();
    if g.hosts.values().any(|h| h.link.room == room) {
        return Err("Das ist deine eigene geteilte Session.".into());
    }
    let me = g.me.id();
    if let Some(guest) = g.guests.get(&room) {
        return Ok(GuestView { room, session_id, relay: guest.link.relay.clone(), me, connected: guest.connected, error: guest.error.clone() });
    }
    let transport = {
        let (app_f, inner_f, room_f) = (app.clone(), state.0.clone(), room.clone());
        let (app_s, inner_s, room_s) = (app.clone(), state.0.clone(), room.clone());
        Transport::spawn(
            Link::socket_url(&link.relay, &room),
            move |frame| guest_frame(&app_f, &inner_f, &room_f, &frame),
            move |connected, error| {
                let mut g = inner_s.lock().unwrap();
                let Inner { me, guests, .. } = &mut *g;
                let Some(guest) = guests.get_mut(&room_s) else { return };
                guest.connected = connected;
                guest.error = error;
                if connected {
                    // Nach jedem (Neu-)Verbinden: anmelden, der Host schickt einen Snapshot.
                    guest.synced = false;
                    guest.last_seq = 0;
                    let hello = json!({ "t": "hello", "id": message_id(), "name": guest.name });
                    guest.transport.send(crypto::seal(&guest.link.key, &room_s, me, &hello));
                }
                emit_guest_status(&app_s, &room_s, guest);
            },
        )
    };
    let view = GuestView { room: room.clone(), session_id: session_id.clone(), relay: link.relay.clone(), me, connected: false, error: None };
    g.guests.insert(
        room.clone(),
        Guest { link, session_id, name: clean_name(&json!(name)), transport, connected: false, error: None, last_seq: 0, synced: false },
    );
    drop(g);
    spawn_guest_ticker(state.0.clone(), room);
    Ok(view)
}

#[tauri::command]
pub fn collab_guest_prompt(state: State<'_, CollabState>, room: String, text: String) -> CmdResult<()> {
    send_as_guest(&state.0, &room, json!({ "t": "prompt", "text": text }))
}

#[tauri::command]
pub fn collab_guest_cancel(state: State<'_, CollabState>, room: String) -> CmdResult<()> {
    send_as_guest(&state.0, &room, json!({ "t": "cancel" }))
}

/// Freigabe-Entscheidung eines Gasts (Schlüssel `<raum>:<schlüssel beim host>`).
pub fn guest_decide(state: &CollabState, key: &str, option_id: Option<String>) -> CmdResult<()> {
    let (room, host_key) = key.split_once(':').ok_or("Ungültige Freigabe")?;
    send_as_guest(&state.0, room, json!({ "t": "decide", "key": host_key, "optionId": option_id }))
}

#[tauri::command]
pub fn collab_leave(state: State<'_, CollabState>, room: String) {
    let _ = send_as_guest(&state.0, &room, json!({ "t": "bye" }));
    state.0.lock().unwrap().guests.remove(&room);
}

/// Stand nach einem Neuladen der Oberfläche.
#[tauri::command]
pub fn collab_status(state: State<'_, CollabState>) -> Value {
    let g = state.0.lock().unwrap();
    let hosts: Vec<HostView> = g.hosts.values().map(Host::view).collect();
    let guests: Vec<GuestView> = g
        .guests
        .iter()
        .map(|(room, guest)| GuestView {
            room: room.clone(),
            session_id: guest.session_id.clone(),
            relay: guest.link.relay.clone(),
            me: g.me.id(),
            connected: guest.connected,
            error: guest.error.clone(),
        })
        .collect();
    json!({ "hosts": hosts, "guests": guests, "me": g.me.id() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_are_stripped() {
        let mut ev = json!({ "t": "update", "update": {
            "sessionUpdate": "tool_call_update", "rawOutput": { "content": "geheim" },
            "content": [ { "type": "content", "content": { "type": "text", "text": "geheim" } },
                         { "type": "diff", "path": "/a", "oldText": "x", "newText": "y" } ] } });
        strip_outputs(&mut ev);
        assert!(!ev.to_string().contains("geheim"));
        assert_eq!(ev["update"]["content"][0]["type"], "diff");

        let mut snap = json!({ "t": "snapshot", "session": { "items": [
            { "type": "tool", "output": ["geheim"], "rawOutput": "geheim", "diffs": [] },
            { "type": "assistant", "text": "hallo" } ] } });
        strip_outputs(&mut snap);
        assert!(!snap.to_string().contains("geheim"));
        assert_eq!(snap["session"]["items"][1]["text"], "hallo");
    }

    #[test]
    fn roles_are_ordered() {
        assert!(Role::Approver > Role::Collaborator && Role::Collaborator > Role::Viewer);
    }

    #[test]
    fn daily_limits() {
        let mut p = Participant {
            id: "a".into(), name: "Anna".into(), role: Role::Collaborator, online: true, team: false,
            prompts: 5, tokens: 10, day: 0, last_seen: None,
        };
        p.roll_day();
        assert_eq!((p.prompts, p.tokens), (0, 0));
        let policy: Policy = serde_json::from_value(json!({ "dailyPrompts": 3 })).unwrap();
        assert!(policy.guest_prompts, "Gast-Prompts sind ohne Angabe erlaubt");
    }
}
