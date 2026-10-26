//! Brise-Relay: verbindet Host und Gäste einer geteilten Session.
//!
//! Das Relay kennt nur Räume und undurchsichtige Binär-Frames. Inhalte sind
//! Ende-zu-Ende verschlüsselt (siehe `docs/collab-protocol.md`), der Schlüssel
//! steht nur im Einladungslink. Gespeichert wird nichts außer einem optionalen
//! Puffer der letzten Frames je Raum im Arbeitsspeicher.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::broadcast::{self, error::RecvError};

/// Betriebsgrenzen, per Umgebungsvariablen änderbar (siehe README).
#[derive(Clone, Debug)]
pub struct Config {
    /// Frames je Raum, die Nachzügler beim Beitreten bekommen (0 = aus).
    pub buffer: usize,
    /// Obergrenze des Puffers je Raum in Bytes.
    pub buffer_bytes: usize,
    /// Größter erlaubter Frame (Snapshots langer Sessions sind groß).
    pub max_frame: usize,
    pub max_rooms: usize,
    pub max_members: usize,
    /// So lange bleibt ein leerer Raum samt Puffer erhalten.
    pub room_ttl: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            buffer: 256,
            buffer_bytes: 16 << 20,
            max_frame: 8 << 20,
            max_rooms: 1000,
            max_members: 32,
            room_ttl: Duration::from_secs(600),
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        fn var<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
        }
        let d = Self::default();
        Self {
            buffer: var("BRISE_RELAY_BUFFER", d.buffer),
            buffer_bytes: var("BRISE_RELAY_BUFFER_BYTES", d.buffer_bytes),
            max_frame: var("BRISE_RELAY_MAX_FRAME", d.max_frame),
            max_rooms: var("BRISE_RELAY_MAX_ROOMS", d.max_rooms),
            max_members: var("BRISE_RELAY_MAX_MEMBERS", d.max_members),
            room_ttl: Duration::from_secs(var("BRISE_RELAY_ROOM_TTL", d.room_ttl.as_secs())),
        }
    }
}

struct Room {
    tx: broadcast::Sender<(u64, Bytes)>,
    buffer: VecDeque<Bytes>,
    buffered: usize,
    members: usize,
    empty_since: Option<Instant>,
}

impl Room {
    fn new() -> Self {
        Self { tx: broadcast::channel(1024).0, buffer: VecDeque::new(), buffered: 0, members: 0, empty_since: None }
    }
}

#[derive(Clone)]
struct Relay {
    cfg: Arc<Config>,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    next_id: Arc<AtomicU64>,
}

/// Raum-IDs sind zufällig (base64url), 16 bis 64 Zeichen.
fn valid_room(room: &str) -> bool {
    (16..=64).contains(&room.len()) && room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn router(cfg: Config) -> Router {
    let relay = Relay { cfg: Arc::new(cfg), rooms: Arc::default(), next_id: Arc::new(AtomicU64::new(1)) };
    tokio::spawn(relay.clone().sweep());
    Router::new().route("/healthz", get(health)).route("/ws/{room}", get(join)).with_state(relay)
}

/// Startet das Relay auf einem schon gebundenen Port (auch für Brises LAN-Modus).
pub async fn serve(listener: TcpListener, cfg: Config) -> std::io::Result<()> {
    axum::serve(listener, router(cfg)).await
}

async fn health(State(relay): State<Relay>) -> Json<serde_json::Value> {
    let rooms = relay.rooms.lock().unwrap();
    let connections: usize = rooms.values().map(|r| r.members).sum();
    Json(json!({ "status": "ok", "rooms": rooms.len(), "connections": connections }))
}

async fn join(Path(room): Path<String>, State(relay): State<Relay>, upgrade: WebSocketUpgrade) -> Response {
    if !valid_room(&room) {
        return (StatusCode::BAD_REQUEST, "ungültige Raum-ID").into_response();
    }
    {
        let rooms = relay.rooms.lock().unwrap();
        match rooms.get(&room) {
            Some(r) if r.members >= relay.cfg.max_members => {
                return (StatusCode::SERVICE_UNAVAILABLE, "Raum ist voll").into_response();
            }
            None if rooms.len() >= relay.cfg.max_rooms => {
                return (StatusCode::SERVICE_UNAVAILABLE, "zu viele Räume").into_response();
            }
            _ => {}
        }
    }
    upgrade
        .max_message_size(relay.cfg.max_frame)
        .max_frame_size(relay.cfg.max_frame)
        .on_upgrade(move |socket| relay.session(room, socket))
}

impl Relay {
    async fn session(self, room: String, socket: WebSocket) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (backlog, mut rx) = {
            let mut rooms = self.rooms.lock().unwrap();
            let r = rooms.entry(room.clone()).or_insert_with(Room::new);
            r.members += 1;
            r.empty_since = None;
            (r.buffer.iter().cloned().collect::<Vec<_>>(), r.tx.subscribe())
        };
        let (mut sink, mut stream) = socket.split();
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        ping.tick().await;

        let mut ok = true;
        for frame in backlog {
            if sink.send(Message::Binary(frame)).await.is_err() {
                ok = false;
                break;
            }
        }
        while ok {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Binary(data))) => self.publish(&room, id, data),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // Text, Ping und Pong tragen keine Inhalte.
                    Some(Ok(_)) => {}
                },
                ev = rx.recv() => match ev {
                    Ok((from, data)) if from != id => {
                        if sink.send(Message::Binary(data)).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    // Zu langsam: trennen, der Client verbindet neu und holt einen Snapshot.
                    Err(RecvError::Lagged(_)) | Err(RecvError::Closed) => break,
                },
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
        self.leave(&room);
    }

    fn publish(&self, room: &str, from: u64, data: Bytes) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(r) = rooms.get_mut(room) else { return };
        if self.cfg.buffer > 0 {
            r.buffered += data.len();
            r.buffer.push_back(data.clone());
            while r.buffer.len() > self.cfg.buffer || r.buffered > self.cfg.buffer_bytes {
                let Some(old) = r.buffer.pop_front() else { break };
                r.buffered -= old.len();
            }
        }
        let _ = r.tx.send((from, data));
    }

    fn leave(&self, room: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        if let Some(r) = rooms.get_mut(room) {
            r.members -= 1;
            if r.members == 0 {
                if r.buffer.is_empty() || self.cfg.room_ttl.is_zero() {
                    rooms.remove(room);
                } else {
                    r.empty_since = Some(Instant::now());
                }
            }
        }
    }

    /// Räumt leere Räume nach Ablauf der Haltezeit ab.
    async fn sweep(self) {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            let ttl = self.cfg.room_ttl;
            self.rooms.lock().unwrap().retain(|_, r| r.empty_since.is_none_or(|t| t.elapsed() < ttl));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_ids() {
        assert!(valid_room("abcdefghijklmnop"));
        assert!(valid_room("Ab-_0123456789xyzQ"));
        assert!(!valid_room("short"));
        assert!(!valid_room("../../../../etc/passwd"));
        assert!(!valid_room(&"a".repeat(65)));
    }
}
