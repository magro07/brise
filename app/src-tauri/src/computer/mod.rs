//! Computer Use: Agenten sehen den Bildschirm und bedienen Maus und Tastatur.
//!
//! Die Werkzeuge stehen über Brises MCP-Server (`brise --mcp-app`) jedem
//! Backend zur Verfügung. Der MCP-Prozess führt selbst nichts aus, sondern
//! reicht jeden Aufruf über den lokalen Kanal der Master-Session an die
//! laufende App weiter. Dort laufen Richtlinie, Freigabekarte, Not-Aus und
//! die eigentliche Ausführung – unabhängig davon, ob das Backend Freigaben
//! abfragt (Vibe mit `bypass_tool_permissions` täte es nicht).
//!
//! Plattformen: X11 (XTest über enigo, Bildschirm über x11rb), Wayland
//! (xdg-desktop-portal: Screenshot und RemoteDesktop, Rückfall ydotool),
//! macOS und Windows (xcap für Bildschirm und Fenster, enigo für Eingaben).

mod keys;
mod platform;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use image::{imageops::FilterType, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::installer::data_dir;

pub use platform::capabilities;

type CmdResult<T> = Result<T, String>;

/// Größe, auf die Screenshots für den Agenten verkleinert werden (wie bei
/// Anthropics Computer Use: genug für Text, sparsam bei Tokens).
const MAX_W: u32 = 1280;
const MAX_H: u32 = 800;
/// Vorschau in der Oberfläche (Freigabekarte, Werkzeugaufruf).
const THUMB_W: u32 = 560;
/// So lange wartet ein Aufruf auf die Freigabe. Vibe bricht MCP-Aufrufe nach
/// 60 s ab; die Karte bleibt offen und der Agent ruft erneut auf.
const ASK_WAIT: Duration = Duration::from_secs(50);
/// Eine Antwort, die erst nach dem Abbruch kam, gilt so lange für den
/// nächsten gleichen Aufruf.
const LATE_ANSWER_MS: u64 = 5 * 60 * 1000;
/// Nach so viel Ruhe gilt „Agent steuert“ als beendet.
const IDLE: Duration = Duration::from_secs(6);
/// Not-Aus-Tastenkürzel (global, wo das System es erlaubt).
pub const STOP_SHORTCUT: &str = if cfg!(target_os = "macos") { "Cmd+Shift+Escape" } else { "Ctrl+Alt+Escape" };

pub const MCP_INSTRUCTIONS: &str = "Computer Use: Mit computer_screenshot siehst du den Bildschirm, mit computer_click, computer_type, computer_key usw. \
    bedienst du ihn. Koordinaten beziehen sich immer auf den zuletzt gelieferten Screenshot (Pixel im Bild). Prüfe nach Aktionen mit einem neuen Screenshot, \
    ob sie gewirkt haben. Jede Aktion kann eine Freigabe des Nutzers brauchen; Passwortfelder füllt Brise nicht aus, Brises eigenes Fenster ist ausgeblendet.";

// ---------- Einstellungen ----------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Werkzeuge überhaupt anbieten (Standard: aus).
    pub enabled: bool,
    /// Projekte, in denen Computer Use ohne Rückfrage eingeschaltet ist
    /// (jede Aktion braucht trotzdem ihre Freigabe).
    pub projects: Vec<String>,
    /// Wiederherstellungs-Token des RemoteDesktop-Portals (Wayland), damit die
    /// Systemabfrage nur einmal kommt.
    pub portal_token: Option<String>,
}

fn settings_file() -> PathBuf {
    data_dir().join("computer_use.json")
}

pub fn settings() -> Settings {
    std::fs::read(settings_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_settings(s: &Settings) -> CmdResult<()> {
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    std::fs::write(settings_file(), serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())
}

fn update_settings(f: impl FnOnce(&mut Settings)) -> CmdResult<Settings> {
    let mut s = settings();
    f(&mut s);
    save_settings(&s)?;
    Ok(s)
}

/// Gleicher Projektordner, auch mit abschließendem Schrägstrich.
fn same_project(a: &str, b: &str) -> bool {
    !a.is_empty() && a.trim_end_matches(['/', '\\']) == b.trim_end_matches(['/', '\\'])
}

// ---------- Werkzeuge (MCP-Prozess) ----------

/// Werkzeuge, die Bildschirm oder Fenster nur ansehen.
const OBSERVE: &[&str] = &["computer_screenshot", "computer_zoom", "computer_list_windows"];
const TOOL_NAMES: &[&str] = &[
    "computer_screenshot",
    "computer_zoom",
    "computer_list_windows",
    "computer_click",
    "computer_double_click",
    "computer_move",
    "computer_drag",
    "computer_scroll",
    "computer_type",
    "computer_key",
    "computer_focus_window",
    "computer_open_app",
];

/// Werkzeuge nur, wenn Computer Use eingeschaltet, nicht gesperrt und die App erreichbar ist.
fn mcp_ready() -> bool {
    settings().enabled && crate::policy::check_computer_use().is_ok() && std::env::var("BRISE_ORCH_ADDR").is_ok_and(|a| !a.is_empty())
}

pub fn tools() -> Vec<Value> {
    if !mcp_ready() {
        return vec![];
    }
    let xy = |what: &str| {
        json!({
            "x": { "type": "integer", "description": format!("x-Koordinate {what} im letzten Screenshot") },
            "y": { "type": "integer", "description": format!("y-Koordinate {what} im letzten Screenshot") }
        })
    };
    let with = |mut base: Value, extra: Value| {
        if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
            b.extend(e.clone());
        }
        base
    };
    vec![
        json!({
            "name": "computer_screenshot",
            "description": "Screenshot des Bildschirms (oder eines Fensters), verkleinert auf höchstens 1280×800. Alle Koordinaten der anderen \
                computer_*-Werkzeuge beziehen sich auf das zuletzt gelieferte Bild. Brises eigenes Fenster ist ausgegraut.",
            "inputSchema": { "type": "object", "properties": {
                "window": { "type": "string", "description": "Nur dieses Fenster (ID oder Teil des Titels aus computer_list_windows)" },
                "monitor": { "type": "integer", "description": "Bildschirm-Nummer ab 0 bei mehreren Monitoren (Standard: Hauptbildschirm)" }
            } },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "computer_zoom",
            "description": "Vergrößerter Ausschnitt des Bildschirms in voller Auflösung, um Kleingedrucktes zu lesen. Der Bereich wird in Koordinaten des \
                letzten Screenshots angegeben; Klick-Koordinaten beziehen sich danach weiterhin auf den letzten Screenshot, nicht auf den Ausschnitt.",
            "inputSchema": { "type": "object", "properties": with(xy("der linken oberen Ecke"), json!({
                "width": { "type": "integer" }, "height": { "type": "integer" }
            })), "required": ["x", "y", "width", "height"] },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "computer_list_windows",
            "description": "Listet die offenen Fenster: ID, Titel, Programm, Position und Größe (in Koordinaten des letzten Screenshots, falls vorhanden).",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "computer_click",
            "description": "Klickt an eine Stelle des letzten Screenshots.",
            "inputSchema": { "type": "object", "properties": with(xy("des Klicks"), json!({
                "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "Standard: left" }
            })), "required": ["x", "y"] }
        }),
        json!({
            "name": "computer_double_click",
            "description": "Doppelklick (links) an eine Stelle des letzten Screenshots.",
            "inputSchema": { "type": "object", "properties": xy("des Doppelklicks"), "required": ["x", "y"] }
        }),
        json!({
            "name": "computer_move",
            "description": "Bewegt den Mauszeiger, ohne zu klicken (z. B. für Tooltips oder Menüs).",
            "inputSchema": { "type": "object", "properties": xy("des Ziels"), "required": ["x", "y"] }
        }),
        json!({
            "name": "computer_drag",
            "description": "Zieht mit gedrückter linker Maustaste von (x, y) nach (to_x, to_y).",
            "inputSchema": { "type": "object", "properties": with(xy("des Startpunkts"), json!({
                "to_x": { "type": "integer" }, "to_y": { "type": "integer" }
            })), "required": ["x", "y", "to_x", "to_y"] }
        }),
        json!({
            "name": "computer_scroll",
            "description": "Scrollt an einer Stelle des letzten Screenshots.",
            "inputSchema": { "type": "object", "properties": with(xy("der Stelle"), json!({
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                "amount": { "type": "integer", "description": "Anzahl Rasterschritte (Standard 3)" }
            })), "required": ["x", "y", "direction"] }
        }),
        json!({
            "name": "computer_type",
            "description": "Tippt Text in das Feld mit dem Fokus. Passwort- und Anmeldefelder füllt Brise nicht aus – das macht der Nutzer selbst.",
            "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
        }),
        json!({
            "name": "computer_key",
            "description": "Drückt eine Taste oder Tastenkombination, z. B. \"Return\", \"Escape\", \"Tab\", \"ctrl+s\", \"ctrl+shift+t\", \"alt+F4\", \"super\", \"Page_Down\".",
            "inputSchema": { "type": "object", "properties": { "combo": { "type": "string" } }, "required": ["combo"] }
        }),
        json!({
            "name": "computer_focus_window",
            "description": "Holt ein Fenster in den Vordergrund (ID oder Teil des Titels aus computer_list_windows).",
            "inputSchema": { "type": "object", "properties": { "window": { "type": "string" } }, "required": ["window"] }
        }),
        json!({
            "name": "computer_open_app",
            "description": "Startet ein Programm über seinen Namen (z. B. \"Firefox\", \"gnome-text-editor\", \"Rechner\", \"TextEdit\", \"notepad\").",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
        }),
    ]
}

/// Aufruf im MCP-Prozess: an die App weiterreichen und deren MCP-Inhalte zurückgeben.
pub fn call_tool(name: &str, args: &Value) -> Option<CmdResult<Vec<Value>>> {
    if !TOOL_NAMES.contains(&name) {
        return None;
    }
    Some(forward(name, args))
}

fn forward(name: &str, args: &Value) -> CmdResult<Vec<Value>> {
    crate::policy::check_computer_use()?;
    if !settings().enabled {
        return Err("Computer Use ist ausgeschaltet (Einstellungen → Werkzeuge & MCP → Computer Use).".into());
    }
    let addr = std::env::var("BRISE_ORCH_ADDR").map_err(|_| "Brise läuft nicht")?;
    let token = std::env::var("BRISE_ORCH_TOKEN").unwrap_or_default();
    let tag = std::env::var("BRISE_SECRET_TAG").unwrap_or_default();
    let cwd = std::env::var("BRISE_CWD").unwrap_or_default();
    let mut stream = std::net::TcpStream::connect(&addr).map_err(|e| format!("Brise ist nicht erreichbar: {e}"))?;
    // Die Freigabekarte darf dauern.
    stream.set_read_timeout(Some(ASK_WAIT + Duration::from_secs(60))).ok();
    let msg = json!({ "token": token, "tag": tag, "cwd": cwd, "tool": format!("computer:{name}"), "args": args });
    writeln!(stream, "{msg}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| format!("Keine Antwort von Brise: {e}"))?;
    let reply: Value = serde_json::from_str(&line).map_err(|_| "Ungültige Antwort von Brise")?;
    if reply["ok"].as_bool() != Some(true) {
        return Err(reply["error"].as_str().unwrap_or("Fehler").to_string());
    }
    let text = reply["text"].as_str().unwrap_or_default();
    serde_json::from_str::<Vec<Value>>(text).map_err(|_| "Ungültige Antwort von Brise".into())
}

// ---------- Zustand in der App ----------

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Abbildung von Screenshot-Koordinaten auf Eingabe-Koordinaten:
/// `eingabe = o + bild * factor`. Für Wayland sind Eingabe-Koordinaten die
/// Pixel des Portal-Screenshots (das Portal rechnet sie selbst um).
#[derive(Clone, Debug)]
struct View {
    ox: f64,
    oy: f64,
    factor: f64,
    w: u32,
    h: u32,
    /// Verkleinertes JPEG des letzten Screenshots für Freigabekarten.
    thumb: String,
}

impl View {
    fn to_input(&self, x: f64, y: f64) -> (f64, f64) {
        (self.ox + x * self.factor, self.oy + y * self.factor)
    }
    fn from_input(&self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.ox) / self.factor, (y - self.oy) / self.factor)
    }
}

#[derive(Default)]
struct Grants {
    /// Sessions, in denen Computer Use eingeschaltet wurde.
    sessions: HashSet<String>,
    /// „Immer in dieser Session erlauben“ – getrennt nach Ansehen und Bedienen.
    observe: HashSet<String>,
    control: HashSet<String>,
}

#[derive(Default)]
struct State {
    grants: Grants,
    views: HashMap<String, View>,
    /// Session, die gerade steuert, und Zeitpunkt der letzten Aktion.
    active: Option<(String, u64)>,
    /// Wayland: Brise wurde für Eingaben minimiert und kommt danach zurück.
    hidden: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
/// Offene Freigabekarte. `sig` = Session, Werkzeug und Argumente: ein erneuter
/// gleicher Aufruf hängt sich an dieselbe Karte, statt eine neue zu öffnen.
struct Open {
    sig: String,
    tx: Option<oneshot::Sender<Option<String>>>,
}

#[derive(Default)]
struct Asks {
    open: HashMap<String, Open>,
    /// Antworten, deren Aufruf schon aufgegeben hatte: sig → (Wahl, Zeitpunkt).
    late: HashMap<String, (Option<String>, u64)>,
}

/// Offene Freigaben (Schlüssel `cu:<n>`).
static ASKS: Mutex<Option<Asks>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);
/// Zählt Not-Aus-Auslösungen; laufende Aktionen brechen ab, wenn er sich ändert.
static STOPS: AtomicU64 = AtomicU64::new(0);
/// Immer nur eine Aktion gleichzeitig – auch über Sessions hinweg. Solange eine
/// Freigabekarte offen ist, kann so keine andere Aktion auf sie klicken.
static RUN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn with_asks<T>(f: impl FnOnce(&mut Asks) -> T) -> T {
    f(ASKS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Asks::default))
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    f(STATE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(State::default))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Beim Start der App: Handle merken, Not-Aus-Kürzel registrieren.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(STOP_SHORTCUT, move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            emergency_stop(&handle, "Tastenkürzel");
        }
    }) {
        // Unter Wayland gibt es keine globalen Kürzel; dort hält GNOME selbst
        // einen Stopp-Knopf für die Fernsteuerung bereit.
        eprintln!("Computer Use: Not-Aus-Kürzel {STOP_SHORTCUT} nicht verfügbar: {e}");
    }
}

/// Not-Aus: alle Freigaben weg, offene Karten abgelehnt, laufende Aktionen brechen ab.
pub fn emergency_stop(app: &AppHandle, by: &str) {
    STOPS.fetch_add(1, Ordering::SeqCst);
    let sessions: Vec<String> = with_state(|s| {
        let mut list: Vec<String> = s.grants.sessions.drain().collect();
        if let Some((a, _)) = s.active.take() {
            if !list.contains(&a) {
                list.push(a);
            }
        }
        s.grants.observe.clear();
        s.grants.control.clear();
        list
    });
    let open: Vec<_> = with_asks(|a| {
        a.late.clear();
        a.open.drain().collect()
    });
    for (key, entry) in open {
        if let Some(tx) = entry.tx {
            let _ = tx.send(None);
        }
        let _ = app.emit("acp:permission-closed", json!({ "key": key, "optionId": "reject_once" }));
    }
    platform::release_all();
    restore_brise(app);
    let _ = app.emit("cu:stopped", json!({ "sessions": sessions, "by": by }));
    let _ = app.emit("cu:state", json!({ "active": false }));
}

fn stopped_since(stop_gen: u64) -> CmdResult<()> {
    if STOPS.load(Ordering::SeqCst) != stop_gen {
        return Err("NOT-AUS: Der Nutzer hat Computer Use gestoppt. Nicht erneut versuchen, bis er es wieder freigibt.".into());
    }
    Ok(())
}

// ---------- Freigabe ----------

/// Antwort auf eine Freigabekarte (`respond_permission` mit Schlüssel `cu:…`).
pub fn decide(app: &AppHandle, key: &str, option: Option<String>) -> CmdResult<()> {
    let entry = with_asks(|a| a.open.remove(key)).ok_or("Diese Freigabe ist nicht mehr offen")?;
    let _ = app.emit("acp:permission-closed", json!({ "key": key, "optionId": option }));
    match entry.tx {
        Some(tx) => {
            let _ = tx.send(option);
        }
        // Der Aufruf hatte schon aufgegeben – die Antwort gilt für seine Wiederholung.
        None => with_asks(|a| {
            a.late.insert(entry.sig, (option, now_ms()));
        }),
    }
    Ok(())
}

/// Ergebnis des Wartens auf eine Freigabe.
enum Answer {
    Chosen(Option<String>),
    /// Noch keine Antwort; die Karte bleibt offen.
    Pending,
}

struct Ask<'a> {
    session: &'a str,
    tool: &'a str,
    args: &'a Value,
    summary: String,
    point: Option<(f64, f64)>,
    activate: bool,
}

async fn ask(app: &AppHandle, a: Ask<'_>) -> Answer {
    let sig = format!("{}\n{}\n{}\n{}", a.session, a.tool, a.args, a.activate);
    let (tx, rx) = oneshot::channel();
    let mut tx = Some(tx);
    // Späte Antwort auf einen früheren gleichen Aufruf? Sonst an eine offene gleiche Karte anhängen.
    let late = with_asks(|asks| {
        let now = now_ms();
        asks.late.retain(|_, (_, at)| now.saturating_sub(*at) < LATE_ANSWER_MS);
        if let Some((choice, _)) = asks.late.remove(&sig) {
            return Some(choice);
        }
        if let Some(open) = asks.open.values_mut().find(|o| o.sig == sig) {
            open.tx = tx.take();
        }
        None
    });
    if let Some(choice) = late {
        return Answer::Chosen(choice);
    }
    if let Some(tx) = tx {
        let key = format!("cu:{}", NEXT.fetch_add(1, Ordering::SeqCst));
        with_asks(|asks| asks.open.insert(key.clone(), Open { sig: sig.clone(), tx: Some(tx) }));
        show_card(app, &key, &a);
    }
    match tokio::time::timeout(ASK_WAIT, rx).await {
        Ok(Ok(choice)) => Answer::Chosen(choice),
        Ok(Err(_)) => Answer::Chosen(None),
        Err(_) => {
            with_asks(|asks| {
                if let Some(open) = asks.open.values_mut().find(|o| o.sig == sig) {
                    open.tx = None;
                }
            });
            Answer::Pending
        }
    }
}

fn show_card(app: &AppHandle, key: &str, a: &Ask<'_>) {
    let view = with_state(|s| s.views.get(a.session).cloned());
    let options = if a.activate {
        json!([
            { "optionId": "cu_session", "name": "Für diese Session einschalten", "kind": "allow_once" },
            { "optionId": "cu_project", "name": "Für dieses Projekt einschalten", "kind": "allow_once" },
            { "optionId": "reject_once", "name": "Ablehnen", "kind": "reject_once" }
        ])
    } else {
        json!([
            { "optionId": "allow_once", "name": "Erlauben", "kind": "allow_once" },
            { "optionId": "allow_always", "name": if OBSERVE.contains(&a.tool) { "Ansehen in dieser Session immer erlauben" } else { "Bedienen in dieser Session immer erlauben" }, "kind": "allow_always" },
            { "optionId": "reject_once", "name": "Ablehnen", "kind": "reject_once" }
        ])
    };
    let point = match (&view, a.point) {
        (Some(v), Some((x, y))) => json!([x / v.w as f64, y / v.h as f64]),
        _ => Value::Null,
    };
    let request = json!({
        "sessionId": a.session,
        "toolCall": { "toolCallId": "", "title": a.summary, "rawInput": {} },
        "options": options,
        "_meta": { "briseComputer": {
            "tool": a.tool,
            "summary": a.summary,
            "activate": a.activate,
            "image": view.as_ref().filter(|_| a.point.is_some()).map(|v| v.thumb.clone()),
            "point": point,
            "shortcut": STOP_SHORTCUT,
        } }
    });
    // Unter Wayland ist Brise während der Steuerung minimiert – für die Karte zurückholen.
    restore_brise(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    let _ = app.emit("acp:permission", json!({ "key": key, "request": request, "backend": "brise" }));
}

// ---------- Ausführung in der App ----------

fn num(args: &Value, key: &str) -> CmdResult<f64> {
    args[key].as_f64().ok_or_else(|| format!("{key} fehlt"))
}

fn text(t: impl Into<String>) -> Value {
    json!({ "type": "text", "text": t.into() })
}

/// Kurzbeschreibung einer Aktion für Freigabekarte und Vorschau.
fn summary(tool: &str, args: &Value) -> String {
    let xy = || format!("({}, {})", args["x"].as_i64().unwrap_or(0), args["y"].as_i64().unwrap_or(0));
    match tool {
        "computer_screenshot" => match args["window"].as_str() {
            Some(w) => format!("macht einen Screenshot des Fensters „{w}“"),
            None => "macht einen Screenshot des Bildschirms".into(),
        },
        "computer_zoom" => format!("vergrößert den Ausschnitt bei {} ({}×{})", xy(), args["width"], args["height"]),
        "computer_list_windows" => "listet die offenen Fenster".into(),
        "computer_click" => {
            let b = match args["button"].as_str().unwrap_or("left") {
                "right" => "rechts ",
                "middle" => "mit der mittleren Taste ",
                _ => "",
            };
            format!("klickt {b}auf {}", xy())
        }
        "computer_double_click" => format!("doppelklickt auf {}", xy()),
        "computer_move" => format!("bewegt die Maus nach {}", xy()),
        "computer_drag" => format!("zieht von {} nach ({}, {})", xy(), args["to_x"], args["to_y"]),
        "computer_scroll" => format!("scrollt bei {} nach {}", xy(), match args["direction"].as_str().unwrap_or("down") {
            "up" => "oben",
            "left" => "links",
            "right" => "rechts",
            _ => "unten",
        }),
        "computer_type" => {
            let t = args["text"].as_str().unwrap_or("");
            let shown: String = t.chars().take(80).collect();
            format!("tippt „{shown}{}“", if t.chars().count() > 80 { "…" } else { "" })
        }
        "computer_key" => format!("drückt {}", args["combo"].as_str().unwrap_or("?")),
        "computer_focus_window" => format!("holt das Fenster „{}“ nach vorn", args["window"].as_str().unwrap_or("?")),
        "computer_open_app" => format!("startet „{}“", args["name"].as_str().unwrap_or("?")),
        other => other.to_string(),
    }
}

/// Aufruf aus dem MCP-Prozess (über den Kanal in `orchestra`).
pub async fn handle(session: &str, cwd: &str, tool: &str, args: &Value) -> CmdResult<String> {
    let app = APP.get().ok_or("Brise läuft nicht")?;
    crate::policy::check_computer_use()?;
    let conf = settings();
    if !conf.enabled {
        return Err("Computer Use ist ausgeschaltet (Einstellungen → Werkzeuge & MCP → Computer Use).".into());
    }
    if !TOOL_NAMES.contains(&tool) {
        return Err(format!("Unbekanntes Werkzeug {tool}"));
    }
    let stop_gen = STOPS.load(Ordering::SeqCst);
    let _run = RUN.lock().await;
    stopped_since(stop_gen)?;
    let observe = OBSERVE.contains(&tool);
    let point = args["x"].as_f64().zip(args["y"].as_f64()).filter(|_| !matches!(tool, "computer_zoom"));
    let (activated, always) = with_state(|s| {
        let g = &s.grants;
        let on = g.sessions.contains(session) || conf.projects.iter().any(|p| same_project(p, cwd));
        (on, if observe { g.observe.contains(session) } else { g.control.contains(session) })
    });
    let line = summary(tool, args);
    if !(activated && always) {
        let choice = match ask(app, Ask { session, tool, args, summary: line.clone(), point, activate: !activated }).await {
            Answer::Chosen(c) => c,
            Answer::Pending => {
                return Err("WARTET: Die Freigabekarte ist noch offen, der Nutzer hat noch nicht entschieden. Rufe dasselbe Werkzeug mit genau denselben \
                    Argumenten erneut auf, um weiter zu warten."
                    .into());
            }
        };
        stopped_since(stop_gen)?;
        match choice.as_deref() {
            Some("allow_once") => {}
            Some("allow_always") => with_state(|s| {
                if observe { &mut s.grants.observe } else { &mut s.grants.control }.insert(session.to_string());
            }),
            Some("cu_session") => with_state(|s| {
                s.grants.sessions.insert(session.to_string());
            }),
            Some("cu_project") => {
                with_state(|s| s.grants.sessions.insert(session.to_string()));
                if !cwd.is_empty() {
                    update_settings(|s| {
                        if !s.projects.iter().any(|p| same_project(p, cwd)) {
                            s.projects.push(cwd.to_string());
                        }
                    })?;
                }
            }
            _ => return Err("ABGELEHNT: Der Nutzer hat diese Computer-Use-Aktion nicht freigegeben.".into()),
        }
    }
    mark_active(app, session, &line);
    let result = run(app, session, tool, args, stop_gen).await;
    let content = match result {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("cu:action", json!({ "sessionId": session, "tool": tool, "summary": line, "error": e, "at": now_ms() }));
            return Err(e);
        }
    };
    // Vorschau für den Werkzeugaufruf im Chat.
    let view = with_state(|s| s.views.get(session).cloned());
    let image = content.iter().find(|c| c["type"] == "image").and_then(|c| c["thumb"].as_str().map(str::to_string));
    let marker = match (&view, point) {
        (Some(v), Some((x, y))) if !observe => json!([x / v.w as f64, y / v.h as f64]),
        _ => Value::Null,
    };
    let _ = app.emit(
        "cu:action",
        json!({
            "sessionId": session,
            "tool": tool,
            "summary": line,
            "image": image.or_else(|| view.filter(|_| !marker.is_null()).map(|v| v.thumb)),
            "point": marker,
            "at": now_ms(),
        }),
    );
    let clean: Vec<Value> = content
        .into_iter()
        .map(|mut c| {
            if let Some(o) = c.as_object_mut() {
                o.remove("thumb");
            }
            c
        })
        .collect();
    Ok(serde_json::to_string(&clean).unwrap())
}

fn mark_active(app: &AppHandle, session: &str, line: &str) {
    let at = now_ms();
    with_state(|s| s.active = Some((session.to_string(), at)));
    let _ = app.emit("cu:state", json!({ "active": true, "sessionId": session, "summary": line, "shortcut": STOP_SHORTCUT }));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE).await;
        let idle = with_state(|s| match &s.active {
            Some((_, t)) if *t == at => {
                s.active = None;
                true
            }
            _ => false,
        });
        if idle {
            restore_brise(&app);
            let _ = app.emit("cu:state", json!({ "active": false }));
        }
    });
}

/// Brises Fenster in Eingabe-Koordinaten: aus der Fensterliste des Systems
/// (Prozess-ID, erfasst auch Nebenfenster), sonst aus Tauri. Unter Wayland
/// unbekannt – dort tritt Brise beiseite (`hide_brise`).
fn brise_rects(app: &AppHandle) -> Vec<platform::Rect> {
    if platform::wayland() {
        return vec![];
    }
    let own: Vec<platform::Rect> = platform::windows().unwrap_or_default().into_iter().filter(|w| w.brise && !w.minimized).map(|w| w.rect).collect();
    if !own.is_empty() {
        return own;
    }
    let Some(w) = app.get_webview_window("main") else { return vec![] };
    if w.is_minimized().unwrap_or(false) {
        return vec![];
    }
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return vec![] };
    // macOS arbeitet in Punkten, die anderen in physischen Pixeln.
    let scale = if cfg!(target_os = "macos") { w.scale_factor().unwrap_or(1.0) } else { 1.0 };
    vec![platform::Rect { x: pos.x as f64 / scale, y: pos.y as f64 / scale, w: size.width as f64 / scale, h: size.height as f64 / scale }]
}

/// Wayland: Fensterpositionen sind unbekannt. Damit kein Klick auf Brise selbst
/// landet (Freigabekarten, Einstellungen), tritt Brise für Eingaben beiseite.
fn hide_brise(app: &AppHandle) {
    if !platform::wayland() {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.minimize();
            with_state(|s| s.hidden = true);
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

fn restore_brise(app: &AppHandle) {
    if !with_state(|s| std::mem::take(&mut s.hidden)) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn check_target(app: &AppHandle, x: f64, y: f64) -> CmdResult<()> {
    if brise_rects(app).iter().any(|r| r.contains(x, y)) {
        return Err("Diese Stelle gehört zu Brise selbst. Brise lässt sich nicht per Computer Use bedienen – wähle ein anderes Fenster.".into());
    }
    Ok(())
}

/// Tastatureingaben nie an Brise selbst (Composer, fokussierte Freigabeknöpfe).
fn check_keyboard(app: &AppHandle) -> CmdResult<()> {
    let focused = app.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    if focused {
        return Err("Der Tastaturfokus liegt auf Brise selbst. Erst in das Zielfenster klicken oder computer_focus_window nutzen.".into());
    }
    Ok(())
}

fn view_of(session: &str) -> CmdResult<View> {
    with_state(|s| s.views.get(session).cloned()).ok_or_else(|| "Erst computer_screenshot aufrufen – Koordinaten beziehen sich auf den letzten Screenshot.".into())
}

fn target(app: &AppHandle, session: &str, args: &Value, kx: &str, ky: &str) -> CmdResult<(f64, f64)> {
    let v = view_of(session)?;
    let (x, y) = (num(args, kx)?, num(args, ky)?);
    if x < 0.0 || y < 0.0 || x > v.w as f64 || y > v.h as f64 {
        return Err(format!("({x}, {y}) liegt außerhalb des letzten Screenshots ({}×{}).", v.w, v.h));
    }
    let (ix, iy) = v.to_input(x, y);
    check_target(app, ix, iy)?;
    Ok((ix, iy))
}

async fn run(app: &AppHandle, session: &str, tool: &str, args: &Value, stop_gen: u64) -> CmdResult<Vec<Value>> {
    use platform::Input;
    if !OBSERVE.contains(&tool) {
        hide_brise(app);
    }
    let input = |a: Input| async move { platform::input(a).await };
    match tool {
        "computer_screenshot" => screenshot(app, session, args).await,
        "computer_zoom" => zoom(app, session, args).await,
        "computer_list_windows" => {
            let list = blocking(platform::windows).await?;
            let view = with_state(|s| s.views.get(session).cloned());
            let mut out = String::new();
            for w in list.iter().filter(|w| !w.brise) {
                let (x, y, wd, ht) = match &view {
                    Some(v) => {
                        let (x, y) = v.from_input(w.rect.x, w.rect.y);
                        (x, y, w.rect.w / v.factor, w.rect.h / v.factor)
                    }
                    None => (w.rect.x, w.rect.y, w.rect.w, w.rect.h),
                };
                out.push_str(&format!(
                    "{} · „{}“{} · {}×{} bei ({}, {}){}{}\n",
                    w.id,
                    w.title,
                    if w.app.is_empty() { String::new() } else { format!(" ({})", w.app) },
                    wd.round(),
                    ht.round(),
                    x.round(),
                    y.round(),
                    if w.focused { " · aktiv" } else { "" },
                    if w.minimized { " · minimiert" } else { "" },
                ));
            }
            if out.is_empty() {
                out = "Keine Fenster gefunden.".into();
            } else if view.is_none() {
                out.push_str("(Koordinaten in Bildschirmpixeln – nach computer_screenshot in Bildkoordinaten.)");
            }
            Ok(vec![text(out)])
        }
        "computer_click" | "computer_double_click" => {
            let (x, y) = target(app, session, args, "x", "y")?;
            let button = match args["button"].as_str().unwrap_or("left") {
                "right" => platform::Button::Right,
                "middle" => platform::Button::Middle,
                _ => platform::Button::Left,
            };
            let count = if tool == "computer_double_click" { 2 } else { 1 };
            input(Input::Click { x, y, button, count }).await?;
            Ok(vec![text(format!("{} – mit computer_screenshot prüfen, ob es gewirkt hat.", capitalize(&summary(tool, args))))])
        }
        "computer_move" => {
            let (x, y) = target(app, session, args, "x", "y")?;
            input(Input::Move { x, y }).await?;
            Ok(vec![text("Maus bewegt.")])
        }
        "computer_drag" => {
            let from = target(app, session, args, "x", "y")?;
            let to = target(app, session, args, "to_x", "to_y")?;
            input(Input::Drag { from, to }).await?;
            Ok(vec![text("Gezogen.")])
        }
        "computer_scroll" => {
            let (x, y) = target(app, session, args, "x", "y")?;
            let n = args["amount"].as_i64().unwrap_or(3).clamp(1, 30) as i32;
            let (dx, dy) = match args["direction"].as_str().unwrap_or("down") {
                "up" => (0, -n),
                "left" => (-n, 0),
                "right" => (n, 0),
                _ => (0, n),
            };
            input(Input::Scroll { x, y, dx, dy }).await?;
            Ok(vec![text("Gescrollt.")])
        }
        "computer_type" => {
            let t = args["text"].as_str().ok_or("text fehlt")?.to_string();
            if t.contains("{{secret:") {
                return Err("Secrets tippt Brise nicht in fremde Fenster. Bitte den Nutzer, den Wert selbst einzugeben.".into());
            }
            check_keyboard(app)?;
            if let Some(why) = blocking(platform::password_context).await? {
                return Err(format!("PASSWORTFELD: {why} Brise füllt Passwort- und Anmeldefelder nicht aus – bitte den Nutzer, das selbst zu tun."));
            }
            // In Stücken tippen, damit der Not-Aus auch lange Texte unterbricht.
            let chars: Vec<char> = t.chars().collect();
            for chunk in chars.chunks(40) {
                stopped_since(stop_gen)?;
                input(Input::Text(chunk.iter().collect())).await?;
            }
            Ok(vec![text(format!("{} Zeichen getippt.", chars.len()))])
        }
        "computer_key" => {
            let combo = keys::parse(args["combo"].as_str().ok_or("combo fehlt")?)?;
            check_keyboard(app)?;
            input(Input::Keys(combo)).await?;
            Ok(vec![text(format!("{} gedrückt.", args["combo"].as_str().unwrap_or("")))])
        }
        "computer_focus_window" => {
            let w = find_window(args["window"].as_str().ok_or("window fehlt")?).await?;
            let id = w.id;
            blocking(move || platform::focus(id)).await?;
            Ok(vec![text(format!("Fenster „{}“ ist vorn.", w.title))])
        }
        "computer_open_app" => {
            let name = args["name"].as_str().ok_or("name fehlt")?.to_string();
            let shown = name.clone();
            blocking(move || platform::open_app(&name)).await?;
            tokio::time::sleep(Duration::from_millis(800)).await;
            Ok(vec![text(format!("„{shown}“ gestartet – mit computer_screenshot prüfen, ob das Fenster da ist."))])
        }
        other => Err(format!("Unbekanntes Werkzeug {other}")),
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

async fn find_window(query: &str) -> CmdResult<platform::WinInfo> {
    let list: Vec<_> = blocking(platform::windows).await?.into_iter().filter(|w| !w.brise).collect();
    let q = query.trim().to_lowercase();
    let by_id = list.iter().position(|w| w.id.to_string() == q || format!("{:#x}", w.id) == q);
    let by_title = || list.iter().position(|w| w.title.to_lowercase().contains(&q) || w.app.to_lowercase() == q);
    by_id
        .or_else(by_title)
        .map(|i| list[i].clone())
        .ok_or_else(|| format!("Kein Fenster „{query}“ gefunden – computer_list_windows zeigt die offenen Fenster."))
}

/// Bild verkleinern, Brise ausgrauen, als MCP-Bild liefern und die Abbildung merken.
async fn screenshot(app: &AppHandle, session: &str, args: &Value) -> CmdResult<Vec<Value>> {
    let monitor = args["monitor"].as_u64().map(|m| m as usize);
    let window = match args["window"].as_str().filter(|s| !s.trim().is_empty()) {
        Some(q) => Some(find_window(q).await?),
        None => None,
    };
    let shot = platform::capture(monitor).await?;
    let brise = brise_rects(app);
    let (img, view) = blocking(move || {
        let mut s = shot;
        for r in &brise {
            s.mask(r);
        }
        let s = match &window {
            Some(w) => s.crop(&w.rect)?,
            None => s,
        };
        Ok(prepare(s))
    })
    .await?;
    let note = format!(
        "Screenshot {}×{} Pixel{}. Koordinaten für computer_click usw. beziehen sich auf dieses Bild.",
        view.w,
        view.h,
        if (view.factor - 1.0).abs() > 0.01 { format!(" (verkleinert, Faktor {:.2})", 1.0 / view.factor) } else { String::new() }
    );
    let thumb = view.thumb.clone();
    with_state(|s| s.views.insert(session.to_string(), view));
    Ok(vec![json!({ "type": "image", "data": img, "mimeType": "image/png", "thumb": thumb }), text(note)])
}

async fn zoom(app: &AppHandle, session: &str, args: &Value) -> CmdResult<Vec<Value>> {
    let v = view_of(session)?;
    let (x, y, w, h) = (num(args, "x")?, num(args, "y")?, num(args, "width")?.max(4.0), num(args, "height")?.max(4.0));
    let (ix, iy) = v.to_input(x, y);
    let rect = platform::Rect { x: ix, y: iy, w: w * v.factor, h: h * v.factor };
    let shot = platform::capture(None).await?;
    let brise = brise_rects(app);
    let img = blocking(move || {
        let mut s = shot;
        for r in &brise {
            s.mask(r);
        }
        let part = s.crop(&rect)?;
        // Ausschnitt in voller Auflösung, höchstens doppelt vergrößert.
        let (pw, ph) = part.img.dimensions();
        let scale = (MAX_W as f64 / pw as f64).min(MAX_H as f64 / ph as f64).min(2.0);
        let out = image::imageops::resize(&part.img, ((pw as f64 * scale).round() as u32).max(1), ((ph as f64 * scale).round() as u32).max(1), FilterType::CatmullRom);
        Ok((png_base64(&out), thumb_data_url(&out)))
    })
    .await?;
    Ok(vec![
        json!({ "type": "image", "data": img.0, "mimeType": "image/png", "thumb": img.1 }),
        text(format!("Ausschnitt ({x}, {y}) {w}×{h} vergrößert. Klick-Koordinaten beziehen sich weiterhin auf den letzten Screenshot.")),
    ])
}

fn prepare(s: platform::Shot) -> (String, View) {
    let (w, h) = s.img.dimensions();
    let scale = (MAX_W as f64 / w as f64).min(MAX_H as f64 / h as f64).min(1.0);
    let (sw, sh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    let img = if scale < 1.0 { image::imageops::resize(&s.img, sw, sh, FilterType::Triangle) } else { s.img };
    let view = View { ox: s.ox, oy: s.oy, factor: 1.0 / (scale * s.unit), w: sw, h: sh, thumb: thumb_data_url(&img) };
    (png_base64(&img), view)
}

fn png_base64(img: &RgbaImage) -> String {
    let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut buf = std::io::Cursor::new(Vec::new());
    let _ = rgb.write_to(&mut buf, image::ImageFormat::Png);
    base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
}

fn thumb_data_url(img: &RgbaImage) -> String {
    let (w, h) = img.dimensions();
    let small = if w > THUMB_W { image::imageops::resize(img, THUMB_W, (h * THUMB_W / w).max(1), FilterType::Triangle) } else { img.clone() };
    let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
    let mut buf = std::io::Cursor::new(Vec::new());
    let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 72).encode_image(&rgb);
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}

/// Fläche grau übermalen (Brises Fenster in Screenshots).
fn fill(img: &mut RgbaImage, x0: i64, y0: i64, x1: i64, y1: i64) {
    let (w, h) = img.dimensions();
    let (x0, y0) = (x0.clamp(0, w as i64) as u32, y0.clamp(0, h as i64) as u32);
    let (x1, y1) = (x1.clamp(0, w as i64) as u32, y1.clamp(0, h as i64) as u32);
    for y in y0..y1 {
        for x in x0..x1 {
            // Diagonale Streifen, damit die Fläche klar als ausgeblendet erkennbar ist.
            let shade = if (x + y) / 12 % 2 == 0 { 58 } else { 70 };
            img.put_pixel(x, y, Rgba([shade, shade, shade + 6, 255]));
        }
    }
}

// ---------- Befehle für die Oberfläche ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(flatten)]
    settings: Settings,
    platform: platform::Caps,
    shortcut: &'static str,
    locked: Option<String>,
    active: Option<String>,
}

#[tauri::command]
pub async fn cu_status() -> Status {
    let mut s = settings();
    s.portal_token = None;
    let caps = capabilities().await;
    Status {
        settings: s,
        platform: caps,
        shortcut: STOP_SHORTCUT,
        locked: crate::policy::check_computer_use().err(),
        active: with_state(|s| s.active.as_ref().map(|a| a.0.clone())),
    }
}

#[tauri::command]
pub fn cu_set_enabled(app: AppHandle, enabled: bool) -> CmdResult<()> {
    if enabled {
        crate::policy::check_computer_use()?;
    }
    update_settings(|s| s.enabled = enabled)?;
    if !enabled {
        emergency_stop(&app, "Einstellungen");
    }
    Ok(())
}

#[tauri::command]
pub fn cu_set_project(path: String, on: bool) -> CmdResult<()> {
    update_settings(|s| {
        s.projects.retain(|p| !same_project(p, &path));
        if on {
            s.projects.push(path);
        }
    })
    .map(|_| ())
}

#[tauri::command]
pub fn cu_stop(app: AppHandle) {
    emergency_stop(&app, "Knopf");
}

/// macOS: Bedienungshilfen und Bildschirmaufnahme anfragen (öffnet die Systemeinstellungen).
#[tauri::command]
pub fn cu_request_access() -> CmdResult<String> {
    platform::request_access()
}

/// Wayland: Portal-Freigabe jetzt einholen (statt bei der ersten Aktion).
#[tauri::command]
pub async fn cu_prepare() -> CmdResult<String> {
    platform::prepare().await
}

pub(crate) fn save_portal_token(token: Option<String>) {
    let _ = update_settings(|s| s.portal_token = token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_maps_both_ways() {
        let v = View { ox: 100.0, oy: 50.0, factor: 2.0, w: 1280, h: 800, thumb: String::new() };
        assert_eq!(v.to_input(10.0, 20.0), (120.0, 90.0));
        assert_eq!(v.from_input(120.0, 90.0), (10.0, 20.0));
    }

    #[test]
    fn prepare_scales_to_fit() {
        let shot = platform::Shot { img: RgbaImage::new(2560, 1440), ox: 0.0, oy: 0.0, unit: 1.0 };
        let (_, v) = prepare(shot);
        assert_eq!((v.w, v.h), (1280, 720));
        assert!((v.factor - 2.0).abs() < 1e-9);
        // HiDPI (macOS): 2 Bildpixel je Punkt, Bild 2880×1800 → 1280×800, Punkte = Bild × 1,125.
        let shot = platform::Shot { img: RgbaImage::new(2880, 1800), ox: 0.0, oy: 0.0, unit: 2.0 };
        let (_, v) = prepare(shot);
        assert_eq!((v.w, v.h), (1280, 800));
        assert!((v.to_input(1280.0, 800.0).0 - 1440.0).abs() < 1e-6);
    }

    #[test]
    fn small_screens_stay_unscaled() {
        let shot = platform::Shot { img: RgbaImage::new(1024, 768), ox: 0.0, oy: 0.0, unit: 1.0 };
        let (_, v) = prepare(shot);
        assert_eq!((v.w, v.h, v.factor), (1024, 768, 1.0));
    }

    #[test]
    fn mask_and_crop() {
        let mut s = platform::Shot { img: RgbaImage::from_pixel(200, 100, Rgba([255, 255, 255, 255])), ox: 1000.0, oy: 0.0, unit: 2.0 };
        // Rechteck in Eingabe-Koordinaten: (1010, 10) 20×10 → Bildpixel (20, 20) 40×20.
        s.mask(&platform::Rect { x: 1010.0, y: 10.0, w: 20.0, h: 10.0 });
        assert_ne!(s.img.get_pixel(30, 30)[0], 255);
        assert_eq!(s.img.get_pixel(70, 30)[0], 255);
        let c = s.crop(&platform::Rect { x: 1050.0, y: 0.0, w: 25.0, h: 50.0 }).unwrap();
        assert_eq!(c.img.dimensions(), (50, 100));
        assert_eq!((c.ox, c.oy, c.unit), (1050.0, 0.0, 2.0));
    }

    #[test]
    fn summaries_are_readable() {
        assert_eq!(summary("computer_click", &json!({ "x": 12, "y": 34 })), "klickt auf (12, 34)");
        assert_eq!(summary("computer_click", &json!({ "x": 1, "y": 2, "button": "right" })), "klickt rechts auf (1, 2)");
        assert!(summary("computer_type", &json!({ "text": "x".repeat(100) })).ends_with("…“"));
    }

    #[test]
    fn projects_match_with_trailing_slash() {
        assert!(same_project("/home/a/proj/", "/home/a/proj"));
        assert!(!same_project("", ""));
        assert!(!same_project("/home/a/proj", "/home/a/projekt"));
    }
}
