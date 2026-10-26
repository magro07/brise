//! Master-Session (ADR 0006): Eine Session plant Teilaufgaben, startet sie als
//! eigene Sessions (Untersessions, gern im eigenen Git-Worktree), schickt ihnen
//! Nachrichten, verfolgt ihren Stand und merged nach Freigabe ihre Branches.
//!
//! Die Werkzeuge stellt `brise --mcp-app` bereit. Der MCP-Server ist ein
//! Kindprozess des Agenten und spricht über einen lokalen TCP-Port (nur
//! 127.0.0.1, mit Zufallstoken aus seiner Umgebung) mit der laufenden App.
//! Hier führt die App Buch, prüft Grenzen, legt Worktrees an und baut die
//! Notizen; die Sessions selbst startet die Oberfläche über den normalen Weg
//! (Event `orch:call`, Antwort per `orch_reply`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt as _;
use tokio::sync::oneshot;

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

/// So lange wartet die App auf die Oberfläche (Vibe bricht Werkzeuge nach 60 s ab).
const UI_TIMEOUT: Duration = Duration::from_secs(45);
/// So viel vom letzten Bericht einer Untersession geht in die Notiz.
const REPORT_CHARS: usize = 1800;

// ---------- Buchführung ----------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Starting,
    Running,
    /// Wartet auf eine Freigabe des Nutzers.
    Waiting,
    Done,
    Error,
    Stopped,
    /// Brise wurde beendet, während die Untersession lief.
    Interrupted,
    Merged,
}

impl Status {
    fn active(self) -> bool {
        matches!(self, Status::Starting | Status::Running | Status::Waiting)
    }
    fn label(self) -> &'static str {
        match self {
            Status::Starting => "startet",
            Status::Running => "läuft",
            Status::Waiting => "wartet auf Freigabe",
            Status::Done => "fertig",
            Status::Error => "Fehler",
            Status::Stopped => "gestoppt",
            Status::Interrupted => "unterbrochen",
            Status::Merged => "gemerged",
        }
    }
}

/// Eine Untersession.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Sub {
    /// Session-ID beim Backend.
    pub id: String,
    pub master: String,
    pub title: String,
    pub task: String,
    pub backend: String,
    pub model: Option<String>,
    /// Arbeitsordner (Worktree oder Ordner der Master-Session).
    pub cwd: String,
    /// Ordner der Master-Session – dorthin wird gemerged.
    pub repo: String,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub worktree: bool,
    /// "code" (leer), "design" oder "3d" (ADR 0007).
    pub mode: String,
    /// Design- bzw. Modell-ID bei mode design/3d.
    pub item: Option<String>,
    pub status: Status,
    pub stop_reason: Option<String>,
    pub report: Option<String>,
    pub turns: u32,
    pub created: u64,
    pub updated: u64,
}

/// Vorschlag der Master-Session, über den der Nutzer entscheidet.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Proposal {
    pub id: String,
    pub master: String,
    pub master_cwd: String,
    pub master_title: String,
    pub title: String,
    pub task: String,
    pub backend: String,
    pub model: Option<String>,
    pub worktree: bool,
    /// "code" (leer), "design" oder "3d" (ADR 0007).
    pub mode: String,
    /// open, started, here, dismissed, failed
    pub state: String,
    pub session: Option<String>,
    pub error: Option<String>,
    pub created: u64,
    /// Beim Start festgelegt (Worktree, Branch, Basis).
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub base: Option<String>,
}

/// Bitte um Freigabe zum Mergen eines Branches.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeRequest {
    pub id: String,
    pub master: String,
    pub session: String,
    pub title: String,
    pub branch: String,
    pub into: String,
    pub commits: Vec<String>,
    pub stat: String,
    /// open, merged, rejected, failed
    pub state: String,
    pub result: Option<String>,
    pub created: u64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Book {
    pub subs: Vec<Sub>,
    pub proposals: Vec<Proposal>,
    pub merges: Vec<MergeRequest>,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn book_file() -> PathBuf {
    data_dir().join("orchestra").join("state.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn load_book() -> Book {
    std::fs::read(book_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Liest bzw. ändert das Buch; jede Änderung wird gespeichert und an die Oberfläche gemeldet.
fn with_book<T>(change: bool, f: impl FnOnce(&mut Book) -> T) -> T {
    let mut guard = BOOK.lock().unwrap_or_else(|e| e.into_inner());
    let book = guard.get_or_insert_with(load_book);
    let out = f(book);
    if change {
        let snapshot = book.clone();
        drop(guard);
        let path = book_file();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&snapshot).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
        if let Some(app) = APP.get() {
            let _ = app.emit("orch:changed", &snapshot);
        }
    }
    out
}

fn sub(id: &str) -> Option<Sub> {
    with_book(false, |b| b.subs.iter().find(|s| s.id == id).cloned())
}

/// Master-Session einer Untersession (für `load_session`: keine Werkzeuge für Untersessions).
pub fn parent_of(session: &str) -> Option<String> {
    sub(session).map(|s| s.master)
}

fn active_count() -> usize {
    with_book(false, |b| b.subs.iter().filter(|s| s.status.active()).count())
}

/// Ordner, in dem die Worktrees der Untersessions liegen.
pub fn worktree_root() -> PathBuf {
    data_dir().join("worktrees")
}

// ---------- Einstellungen und Grenzen ----------

struct Prefs {
    enabled: bool,
    confirm_start: bool,
    max_parallel: usize,
    worktree: bool,
}

fn prefs() -> Prefs {
    let p = crate::customize::current_prefs();
    let o = &p["orchestra"];
    Prefs {
        enabled: o["enabled"].as_bool().unwrap_or(true),
        confirm_start: o["confirmStart"].as_bool().unwrap_or(true),
        max_parallel: o["maxParallel"].as_u64().unwrap_or(3).clamp(1, 12) as usize,
        worktree: o["worktree"].as_bool().unwrap_or(true),
    }
}

/// Höchstzahl gleichzeitiger Untersessions (Einstellung und Team-Richtlinie).
fn max_parallel() -> usize {
    let own = prefs().max_parallel;
    match crate::policy::max_sub_sessions() {
        Some(team) => own.min(team as usize),
        None => own,
    }
}

/// Darf die Master-Session-Funktion überhaupt genutzt werden?
pub fn check_enabled() -> CmdResult<()> {
    crate::policy::check_orchestra()?;
    if !prefs().enabled {
        return Err("Die Master-Session ist in den Einstellungen ausgeschaltet (Einstellungen → Master-Session).".into());
    }
    Ok(())
}

/// Vor jedem Start: Funktion frei, Platz frei, Budget nicht erreicht.
fn check_start(backend: &str, model: Option<&str>) -> CmdResult<()> {
    check_enabled()?;
    crate::policy::check_backend(backend)?;
    if let Some(m) = model {
        crate::policy::check_model(m)?;
    }
    let (active, max) = (active_count(), max_parallel());
    if active >= max {
        return Err(format!(
            "LIMIT: Es laufen schon {active} Untersessions (höchstens {max} gleichzeitig). Warte auf eine Rückmeldung oder stoppe eine mit stop_session."
        ));
    }
    if let Some(budget) = crate::usage::monthly_budget_eur().filter(|b| *b > 0.0) {
        let spent = crate::usage::spent_month_eur();
        if spent >= budget {
            return Err(format!("BUDGET: Das Monatsbudget von {budget:.2} € ist erreicht ({spent:.2} € verbraucht) – keine neuen Untersessions."));
        }
    }
    Ok(())
}

// ---------- Kanal zur Oberfläche ----------

static PENDING: Mutex<Option<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Bittet die Oberfläche, etwas zu tun (Session starten, Nachricht schicken …).
async fn call_ui(kind: &str, payload: Value) -> CmdResult<Value> {
    let app = APP.get().ok_or("Brise läuft nicht")?;
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(id, tx);
    app.emit("orch:call", json!({ "id": id, "kind": kind, "payload": payload })).map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(UI_TIMEOUT, rx).await;
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&id);
    match result {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("Die Oberfläche hat nicht geantwortet".into()),
        Err(_) => Err("Zeitüberschreitung: Die Oberfläche von Brise hat nicht rechtzeitig geantwortet".into()),
    }
}

/// Antwort der Oberfläche auf `orch:call`.
#[tauri::command]
pub fn orch_reply(id: u64, ok: bool, value: Value) {
    let tx = PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(if ok { Ok(value) } else { Err(value.as_str().map_or_else(|| value.to_string(), str::to_string)) });
    }
}

// ---------- Lokaler Server für den MCP-Prozess ----------

struct Server {
    addr: String,
    token: String,
}

static SERVER: OnceLock<Server> = OnceLock::new();

/// Beim Start der App: Port öffnen, laufende Untersessions als unterbrochen markieren.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    with_book(true, |b| {
        for s in b.subs.iter_mut().filter(|s| s.status.active()) {
            s.status = Status::Interrupted;
        }
    });
    let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => return eprintln!("Master-Session: Port nicht verfügbar: {e}"),
    };
    let Ok(addr) = listener.local_addr() else { return };
    let _ = listener.set_nonblocking(true);
    let _ = SERVER.set(Server { addr: addr.to_string(), token: random_hex(32) });
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        while let Ok((stream, _)) = listener.accept().await {
            tauri::async_runtime::spawn(serve(stream));
        }
    });
}

async fn serve(stream: tokio::net::TcpStream) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    let mut reader = tokio::io::BufReader::new(read.take(1 << 20));
    if tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await.is_err() {
        return;
    }
    let reply = match handle(&line).await {
        Ok(text) => json!({ "ok": true, "text": text }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handle(line: &str) -> CmdResult<String> {
    let msg: Value = serde_json::from_str(line).map_err(|_| "Ungültige Anfrage")?;
    let server = SERVER.get().ok_or("Server nicht bereit")?;
    if !same(msg["token"].as_str().unwrap_or(""), &server.token) {
        return Err("Nicht berechtigt".into());
    }
    let caller = crate::secrets::session_for_tag(msg["tag"].as_str().unwrap_or("")).ok_or("Unbekannte Session – bitte kurz warten und erneut versuchen.")?;
    let cwd = msg["cwd"].as_str().unwrap_or("").to_string();
    let args = &msg["args"];
    if parent_of(&caller).is_some() {
        return Err("Untersessions können keine weiteren Sessions steuern.".into());
    }
    match msg["tool"].as_str().unwrap_or("") {
        "start_session" => start_session(&caller, &cwd, args).await,
        "list_sessions" => Ok(list_text(&caller)),
        "get_session" => get_text(&caller, args),
        "send_message" => send_message(&caller, args).await,
        "stop_session" => stop_session(&caller, args).await,
        "merge_session" => merge_session(&caller, args).await,
        other => Err(format!("Unbekanntes Werkzeug {other}")),
    }
}

/// Umgebung für `brise --mcp-app`: Adresse, Token und ggf. die Master-Session.
pub fn mcp_env(session: Option<&str>, parent: Option<&str>) -> Vec<Value> {
    let Some(server) = SERVER.get() else { return vec![] };
    let mut env = vec![json!({ "name": "BRISE_ORCH_ADDR", "value": server.addr }), json!({ "name": "BRISE_ORCH_TOKEN", "value": server.token })];
    let parent = parent.map(str::to_string).or_else(|| session.and_then(parent_of));
    if let Some(p) = parent {
        env.push(json!({ "name": "BRISE_ORCH_PARENT", "value": p }));
    }
    env
}

// ---------- Werkzeuge (in der App) ----------

fn own_sub(caller: &str, args: &Value) -> CmdResult<Sub> {
    let id = args["session"].as_str().ok_or("session fehlt")?.trim();
    with_book(false, |b| {
        b.subs.iter().find(|s| s.master == caller && (s.id == id || s.id.starts_with(id) && id.len() >= 6 || s.title == id)).cloned()
    })
    .ok_or_else(|| format!("Keine Untersession „{id}“ dieser Master-Session (siehe list_sessions)"))
}

/// Art der Untersession: Code (Worktree, Merge) oder Design bzw. 3D (Ergebnis im Datenordner).
fn mode_arg(args: &Value) -> CmdResult<String> {
    match args["mode"].as_str().map(str::trim).unwrap_or("") {
        "" | "code" => Ok(String::new()),
        "design" => Ok("design".into()),
        "3d" => Ok("3d".into()),
        other => Err(format!("Unbekannter mode „{other}“ – erlaubt: code, design, 3d")),
    }
}

/// Anzeigename der Art.
fn mode_label(mode: &str) -> &'static str {
    match mode {
        "design" => "Design-Session",
        "3d" => "3D-Session",
        _ => "Untersession",
    }
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

async fn start_session(caller: &str, cwd: &str, args: &Value) -> CmdResult<String> {
    let title = str_arg(args, "title").ok_or("title fehlt")?;
    let task = str_arg(args, "task").ok_or("task fehlt")?;
    // Backend und Ordner der Master-Session kennt die Oberfläche.
    let info = call_ui("info", json!({ "session": caller })).await?;
    let master_cwd = info["cwd"].as_str().filter(|c| !c.is_empty()).unwrap_or(cwd).to_string();
    let backend = str_arg(args, "backend").or_else(|| info["backend"].as_str().map(str::to_string)).unwrap_or_else(|| "vibe".into());
    let mode = mode_arg(args)?;
    // Design- und 3D-Sessions laufen wie im jeweiligen Modus über Vibe, ohne Worktree.
    let (backend, model) = if mode.is_empty() { (backend, str_arg(args, "model")) } else { ("vibe".to_string(), None) };
    let p = prefs();
    let worktree = mode.is_empty() && args["worktree"].as_bool().unwrap_or(p.worktree);
    check_start(&backend, model.as_deref())?;
    let proposal = Proposal {
        id: format!("p{}", random_hex(6)),
        master: caller.to_string(),
        master_cwd,
        master_title: info["title"].as_str().map(|t| shorten_start(t, 60)).unwrap_or_else(|| "Master-Session".into()),
        title: title.chars().take(80).collect(),
        task,
        backend,
        model,
        worktree,
        mode,
        state: "open".into(),
        created: now_ms(),
        ..Default::default()
    };
    with_book(true, |b| b.proposals.push(proposal.clone()));
    if p.confirm_start {
        return Ok(format!(
            "Vorschlag „{}“ als Karte im Chat angezeigt (Vorschlag {}). Der Nutzer entscheidet: „Neue Session“ oder „Hier erledigen“. \
             Du bekommst dazu automatisch eine Notiz, die dich neu startet: Mach mit anderen Teilen weiter oder beende jetzt deinen Turn – nicht mit wait warten.",
            proposal.title, proposal.id
        ));
    }
    let s = launch(&proposal.id).await?;
    Ok(format!("{} „{}“ gestartet: {}{}. Du bekommst eine Notiz, wenn sie ihren Turn beendet – bis dahin weiterarbeiten oder den Turn beenden, nicht mit wait warten.", mode_label(&s.mode), s.title, s.id, branch_note(&s)))
}

fn branch_note(s: &Sub) -> String {
    if let Some(item) = &s.item {
        return format!(" ({} {item} im {}-Modus)", if s.mode == "3d" { "Modell" } else { "Design" }, if s.mode == "3d" { "3D" } else { "Design" });
    }
    match (&s.branch, &s.base) {
        (Some(b), Some(base)) => format!(" (Worktree {}, Branch {b} von {base})", s.cwd),
        (Some(b), None) => format!(" (Worktree {}, Branch {b})", s.cwd),
        _ => String::new(),
    }
}

/// ASCII-Kurzname für Branch und Ordner.
fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        let rep = match c {
            'ä' => "ae",
            'ö' => "oe",
            'ü' => "ue",
            'ß' => "ss",
            c if c.is_ascii_alphanumeric() => {
                out.push(c);
                continue;
            }
            _ => "-",
        };
        if rep == "-" && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push_str(rep);
    }
    let out: String = out.trim_matches('-').chars().take(32).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "aufgabe".into() } else { out }
}

fn repo_dir_name(repo: &Path) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(repo.to_string_lossy().as_bytes());
    let name = repo.file_name().map(|n| slug(&n.to_string_lossy())).unwrap_or_else(|| "repo".into());
    format!("{name}-{}", hash.iter().take(4).map(|x| format!("{x:02x}")).collect::<String>())
}

/// Rahmen vor dem Auftrag einer Untersession.
fn sub_prompt(p: &Proposal, master_title: &str) -> String {
    let mut out = format!("[Brise · Untersession der Master-Session „{master_title}“]\n");
    if !p.mode.is_empty() {
        out.push_str(&format!(
            "Die Session „{master_title}“ arbeitet in einem Code-Projekt ({}) und braucht von dir {}. Arbeite nur in deinem Arbeitsordner; \
             die Master-Session übernimmt das Ergebnis selbst ins Projekt. Beende deinen Turn mit einem kurzen Bericht: was entstanden ist, {}offene Punkte. \
             Warte danach nicht mit wait auf Nachrichten – Rückfragen und Korrekturen kommen als neue Nachricht.\n\nAuftrag:\n",
            p.master_cwd,
            if p.mode == "3d" { "ein 3D-Modell" } else { "ein Design" },
            if p.mode == "3d" { "Maße, Teile, " } else { "Aufbau, Zustände, " }
        ));
        out.push_str(&p.task);
        return out;
    }
    match (&p.branch, &p.cwd) {
        (Some(branch), Some(cwd)) => {
            out.push_str(&format!(
                "Du arbeitest in einem eigenen Git-Worktree ({cwd}) auf dem Branch {branch}{}. \
                 Arbeite nur dort und committe deine Änderungen auf diesem Branch, bevor du fertig bist. Nicht pushen, nicht mergen.\n",
                p.base.as_deref().map(|b| format!(", abgezweigt von {b}")).unwrap_or_default()
            ));
        }
        _ => out.push_str("Du arbeitest im selben Ordner wie die Master-Session; andere Sessions können parallel Dateien ändern.\n"),
    }
    out.push_str("Beende deinen Turn mit einem kurzen Bericht: was erledigt ist, was offen ist, wie du es geprüft hast.\n\nAuftrag:\n");
    out.push_str(&p.task);
    out
}

/// Startet einen Vorschlag: Worktree anlegen, Oberfläche startet die Session.
async fn launch(proposal: &str) -> CmdResult<Sub> {
    let p = with_book(false, |b| b.proposals.iter().find(|x| x.id == proposal).cloned()).ok_or("Vorschlag nicht gefunden")?;
    if p.state != "open" {
        return Err("Dieser Vorschlag ist schon erledigt".into());
    }
    check_start(&p.backend, p.model.as_deref())?;
    let master_dir = PathBuf::from(&p.master_cwd);
    let (cwd, branch, base) = if p.worktree {
        let repo = crate::git::repo_root(&master_dir).ok_or_else(|| format!("{} ist kein Git-Repository – Untersession mit worktree: false starten", p.master_cwd))?;
        let name = format!("{}-{}", slug(&p.title), random_hex(2));
        let path = worktree_root().join(repo_dir_name(&repo)).join(&name);
        let branch = format!("brise/{name}");
        let base = crate::git::current_branch(&master_dir);
        let (r, pa, br) = (repo.clone(), path.clone(), branch.clone());
        tokio::task::spawn_blocking(move || crate::git::worktree_add(&r, &pa, &br)).await.map_err(|e| e.to_string())?.map_err(|e| format!("Worktree anlegen: {e}"))?;
        // Unterordner der Master-Session im Worktree übernehmen (Monorepos).
        let rel = master_dir.strip_prefix(&repo).ok().filter(|r| !r.as_os_str().is_empty()).map(|r| path.join(r));
        (rel.unwrap_or(path).display().to_string(), Some(branch), base)
    } else {
        (p.master_cwd.clone(), None, None)
    };
    with_book(true, |b| {
        if let Some(x) = b.proposals.iter_mut().find(|x| x.id == p.id) {
            x.cwd = Some(cwd.clone());
            x.branch = branch.clone();
            x.base = base.clone();
        }
    });
    let launched = Proposal { cwd: Some(cwd.clone()), branch: branch.clone(), base: base.clone(), ..p.clone() };
    let reply = call_ui(
        "start",
        json!({
            "proposal": p.id,
            "master": p.master,
            "cwd": cwd,
            "backend": p.backend,
            "model": p.model,
            "title": p.title,
            "mode": p.mode,
            "prompt": sub_prompt(&launched, &launched.master_title),
        }),
    )
    .await;
    match reply {
        Ok(r) => {
            let id = r["sessionId"].as_str().ok_or("Die Oberfläche hat keine Session-ID geliefert")?.to_string();
            // Meist hat die Oberfläche die Session schon über `orch_register` eingetragen.
            register(&p.id, &id, r["item"].as_str())
        }
        Err(e) => {
            // Kam die Session doch noch an (orch_register), ist der Vorschlag gestartet.
            let started = with_book(true, |b| {
                let x = b.proposals.iter_mut().find(|x| x.id == p.id)?;
                if x.state == "started" {
                    return Some(true);
                }
                x.state = "failed".into();
                x.error = Some(e.clone());
                Some(false)
            });
            if started == Some(true) {
                return sub(&with_book(false, |b| b.proposals.iter().find(|x| x.id == p.id).and_then(|x| x.session.clone())).unwrap_or_default()).ok_or(e);
            }
            // Bei einer Zeitüberschreitung kann die Session noch nachkommen – Worktree dann behalten.
            if let (Some(branch), true, false) = (&branch, p.worktree, e.starts_with("Zeitüberschreitung")) {
                // Unbenutzten Worktree wieder entfernen.
                if let Some(repo) = crate::git::repo_root(&master_dir) {
                    let _ = crate::git::worktree_remove(&repo, Path::new(&cwd), branch);
                }
            }
            Err(e)
        }
    }
}

fn register(proposal: &str, session: &str, item: Option<&str>) -> CmdResult<Sub> {
    with_book(true, |b| {
        if let Some(s) = b.subs.iter_mut().find(|s| s.id == session) {
            if s.item.is_none() {
                s.item = item.map(str::to_string);
            }
            return Ok(s.clone());
        }
        let p = b.proposals.iter_mut().find(|x| x.id == proposal).ok_or("Vorschlag nicht gefunden")?;
        p.state = "started".into();
        p.session = Some(session.to_string());
        let now = now_ms();
        let s = Sub {
            id: session.to_string(),
            master: p.master.clone(),
            title: p.title.clone(),
            task: p.task.clone(),
            backend: p.backend.clone(),
            model: p.model.clone(),
            cwd: p.cwd.clone().unwrap_or_else(|| p.master_cwd.clone()),
            repo: p.master_cwd.clone(),
            branch: p.branch.clone(),
            base: p.base.clone(),
            worktree: p.branch.is_some(),
            mode: p.mode.clone(),
            item: item.map(str::to_string),
            status: Status::Starting,
            created: now,
            updated: now,
            ..Default::default()
        };
        b.subs.push(s.clone());
        Ok(s)
    })
}

/// Die Oberfläche hat die Session angelegt – eintragen, bevor der erste Prompt läuft.
#[tauri::command]
pub fn orch_register(proposal: String, session: String, item: Option<String>) -> CmdResult<Sub> {
    register(&proposal, &session, item.as_deref())
}

#[derive(Default)]
struct GitInfo {
    ahead: u32,
    /// Geänderte versionierte Dateien (nicht committet).
    dirty: Vec<String>,
    /// Nicht versionierte Dateien (z. B. Build-Reste) – blockieren keinen Merge.
    untracked: Vec<String>,
    commits: Vec<String>,
    stat: String,
}

fn git_info(s: &Sub) -> Option<GitInfo> {
    let branch = s.branch.as_deref()?;
    let base = s.base.as_deref().unwrap_or("HEAD");
    let repo = Path::new(&s.repo);
    let (commits, stat) = crate::git::branch_summary(repo, base, branch);
    let (dirty, untracked) = crate::git::dirty_files(Path::new(&s.cwd));
    Some(GitInfo { ahead: crate::git::ahead_of(repo, base, branch), dirty, untracked, commits, stat })
}

fn git_line(s: &Sub, g: &GitInfo) -> String {
    let base = s.base.as_deref().unwrap_or("Basis");
    let mut dirty = match g.dirty.len() {
        0 => "alles committet".to_string(),
        n => format!("{n} geänderte Datei(en) nicht committet"),
    };
    if !g.untracked.is_empty() {
        dirty.push_str(&format!(", {} nicht versionierte Datei(en)", g.untracked.len()));
    }
    format!("Branch {}: {} Commit(s) vor {base}, {dirty}{}", s.branch.as_deref().unwrap_or("-"), g.ahead, if g.stat.is_empty() { String::new() } else { format!(" ({})", g.stat) })
}

fn list_text(caller: &str) -> String {
    let subs = with_book(false, |b| b.subs.iter().filter(|s| s.master == caller).cloned().collect::<Vec<_>>());
    if subs.is_empty() {
        return "Noch keine Untersessions.".into();
    }
    let open = with_book(false, |b| b.proposals.iter().filter(|p| p.master == caller && p.state == "open").count());
    let mut out: Vec<String> = subs
        .iter()
        .map(|s| {
            format!(
                "- {} · „{}“ · {} · {}{}{}{}",
                s.id,
                s.title,
                s.status.label(),
                if s.mode.is_empty() { String::new() } else { format!("{} · ", mode_label(&s.mode)) },
                s.backend,
                s.model.as_deref().map(|m| format!("/{m}")).unwrap_or_default(),
                s.branch.as_deref().map(|b| format!(" · Branch {b}")).or_else(|| s.item.as_deref().map(|i| format!(" · {i}"))).unwrap_or_default()
            )
        })
        .collect();
    if open > 0 {
        out.push(format!("Offene Vorschläge, über die der Nutzer noch entscheidet: {open}"));
    }
    out.join("\n")
}

fn get_text(caller: &str, args: &Value) -> CmdResult<String> {
    let s = own_sub(caller, args)?;
    let mut out = vec![
        format!("Session {} · „{}“", s.id, s.title),
        format!("Status: {}{}", s.status.label(), s.stop_reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default()),
        format!("Backend: {}{}", s.backend, s.model.as_deref().map(|m| format!(", Modell {m}")).unwrap_or_default()),
        format!("Ordner: {}", s.cwd),
        format!("Turns: {}", s.turns),
    ];
    if let Some(note) = result_hint(&s) {
        out.push(note);
    }
    if let Some(g) = git_info(&s) {
        out.push(git_line(&s, &g));
        if !g.commits.is_empty() {
            out.push(format!("Commits:\n{}", g.commits.iter().map(|c| format!("  {c}")).collect::<Vec<_>>().join("\n")));
        }
        if !g.dirty.is_empty() {
            out.push(format!("Nicht committet: {}", g.dirty.iter().take(20).cloned().collect::<Vec<_>>().join(", ")));
        }
        if !g.untracked.is_empty() {
            out.push(format!("Nicht versioniert: {}", g.untracked.iter().take(20).cloned().collect::<Vec<_>>().join(", ")));
        }
    }
    out.push(format!("Letzter Bericht:\n{}", s.report.as_deref().unwrap_or("(noch keiner)")));
    Ok(out.join("\n"))
}

async fn send_message(caller: &str, args: &Value) -> CmdResult<String> {
    let s = own_sub(caller, args)?;
    let text = str_arg(args, "text").ok_or("text fehlt")?;
    if s.status == Status::Merged {
        return Err("Diese Untersession ist schon gemerged.".into());
    }
    let r = call_ui("send", json!({ "session": s.id, "cwd": s.cwd, "backend": s.backend, "title": s.title, "text": text })).await?;
    with_book(true, |b| {
        if let Some(x) = b.subs.iter_mut().find(|x| x.id == s.id) {
            if !x.status.active() {
                x.status = Status::Starting;
            }
            x.updated = now_ms();
        }
    });
    Ok(if r["queued"].as_bool().unwrap_or(false) {
        format!("„{}“ arbeitet gerade – Nachricht eingereiht, sie geht nach dem laufenden Turn raus.", s.title)
    } else {
        format!("Nachricht an „{}“ geschickt. Du bekommst eine Notiz, wenn sie fertig ist – beende bis dahin deinen Turn.", s.title)
    })
}

async fn stop_session(caller: &str, args: &Value) -> CmdResult<String> {
    let s = own_sub(caller, args)?;
    with_book(true, |b| {
        if let Some(x) = b.subs.iter_mut().find(|x| x.id == s.id) {
            x.status = Status::Stopped;
            x.updated = now_ms();
        }
    });
    call_ui("stop", json!({ "session": s.id })).await?;
    Ok(format!("„{}“ gestoppt.{}", s.title, if s.worktree { " Der Worktree bleibt erhalten." } else { "" }))
}

async fn merge_session(caller: &str, args: &Value) -> CmdResult<String> {
    let s = own_sub(caller, args)?;
    if !s.mode.is_empty() {
        return Err(result_hint(&s).unwrap_or_else(|| "Design- und 3D-Sessions haben keinen Branch zum Mergen.".into()));
    }
    let branch = s.branch.clone().ok_or("Diese Untersession arbeitet ohne eigenen Branch – nichts zu mergen.")?;
    if s.status == Status::Merged {
        return Err("Schon gemerged.".into());
    }
    if s.status.active() {
        return Err(format!("„{}“ arbeitet noch ({}). Erst nach ihrer Rückmeldung mergen.", s.title, s.status.label()));
    }
    if let Some(open) = with_book(false, |b| b.merges.iter().find(|m| m.session == s.id && m.state == "open").map(|m| m.id.clone())) {
        return Ok(format!("Die Freigabe ist schon angefragt ({open}); du bekommst eine Notiz."));
    }
    let g = git_info(&s).unwrap_or_default();
    if g.ahead == 0 {
        return Err(format!("Branch {branch} hat keine neuen Commits{}.", if g.dirty.is_empty() { "" } else { " (aber nicht committete Änderungen – bitte die Untersession committen lassen)" }));
    }
    let into = crate::git::current_branch(Path::new(&s.repo)).unwrap_or_else(|| "HEAD".into());
    let req = MergeRequest {
        id: format!("m{}", random_hex(6)),
        master: caller.to_string(),
        session: s.id.clone(),
        title: s.title.clone(),
        branch: branch.clone(),
        into: into.clone(),
        commits: g.commits,
        stat: g.stat,
        state: "open".into(),
        created: now_ms(),
        ..Default::default()
    };
    with_book(true, |b| b.merges.push(req.clone()));
    let mut text = format!("Freigabe angefragt: {branch} → {into} (Karte im Chat). Erst nach dem Klick des Nutzers wird gemerged; du bekommst eine Notiz mit dem Ergebnis – beende bis dahin deinen Turn, nicht mit wait warten.");
    if !g.dirty.is_empty() {
        text.push_str(&format!(" Achtung: {} nicht committete Datei(en) im Worktree – der Merge wird so abgelehnt.", g.dirty.len()));
    }
    Ok(text)
}

/// Bei Design- und 3D-Sessions: wo das Ergebnis liegt und wie die Master-Session es übernimmt.
fn result_hint(s: &Sub) -> Option<String> {
    let item = s.item.as_deref()?;
    Some(match s.mode.as_str() {
        "3d" => format!("Ergebnis: 3D-Modell {item}. Ansehen mit read_model(\"{item}\") (Maße, Teile, Bild), ins Projekt übernehmen mit export_model(\"{item}\", format: glb|stl|source)."),
        _ => format!("Ergebnis: Design {item}. Ansehen mit read_design(\"{item}\") (Beschreibung, HTML, Bild), ins Projekt übernehmen mit export_design(\"{item}\")."),
    })
}

// ---------- Notizen an die Master-Session ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub master: String,
    pub text: String,
}

fn still_active(master: &str, except: &str) -> String {
    let n = with_book(false, |b| b.subs.iter().filter(|s| s.master == master && s.id != except && s.status.active()).count());
    match n {
        0 => "Keine weitere Untersession läuft.".into(),
        1 => "Noch aktiv: 1 Untersession.".into(),
        n => format!("Noch aktiv: {n} Untersessions."),
    }
}

/// Anfang eines Textes, höchstens `max` Zeichen, in einer Zeile.
fn shorten_start(text: &str, max: usize) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max { t } else { format!("{}…", t.chars().take(max).collect::<String>().trim_end()) }
}

fn shorten(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    // Das Ende eines Berichts ist meist die Zusammenfassung.
    let tail: String = t.chars().rev().take(max).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

/// Statusmeldung der Oberfläche für eine Untersession. Am Ende eines Turns gibt
/// es eine Notiz für die Master-Session (außer sie hat selbst gestoppt).
#[tauri::command]
pub fn orch_status(session: String, status: Status, report: Option<String>, stop_reason: Option<String>) -> Option<Note> {
    let before = sub(&session)?;
    let finished = matches!(status, Status::Done | Status::Error);
    if before.status == Status::Stopped && (finished || status == Status::Stopped) {
        return None;
    }
    if before.status == Status::Merged {
        return None;
    }
    let s = with_book(true, |b| {
        let x = b.subs.iter_mut().find(|x| x.id == session)?;
        x.status = status;
        x.updated = now_ms();
        if finished {
            x.turns += 1;
            x.stop_reason = stop_reason.clone();
            if let Some(r) = report.as_deref().filter(|r| !r.trim().is_empty()) {
                x.report = Some(shorten(r, REPORT_CHARS));
            }
        }
        Some(x.clone())
    })?;
    if !finished {
        return None;
    }
    let state = match (status, stop_reason.as_deref()) {
        (Status::Error, _) => "ist mit einem Fehler stehen geblieben",
        (_, Some("cancelled")) => "wurde abgebrochen",
        (_, Some("max_tokens" | "max_turn_requests")) => "hat ein Limit erreicht",
        _ => "ist fertig",
    };
    let mut text = format!("[Brise · Rückmeldung] {} „{}“ ({}) {state}.", mode_label(&s.mode), s.title, s.id);
    if let Some(g) = git_info(&s) {
        text.push('\n');
        text.push_str(&git_line(&s, &g));
    }
    text.push_str(&format!("\nBericht:\n{}", s.report.as_deref().unwrap_or("(kein Text)")));
    if let Some(hint) = result_hint(&s) {
        text.push_str(&format!("\n{hint}"));
    }
    text.push_str(&format!("\n{}", still_active(&s.master, &s.id)));
    if s.branch.is_some() && status == Status::Done {
        text.push_str(" Prüfe das Ergebnis (get_session, Diff im Worktree) und bitte mit merge_session um die Freigabe zum Mergen – oder schicke mit send_message Korrekturen.");
    }
    Some(Note { master: s.master, text })
}

/// „Neue Session“ auf einer Vorschlagskarte.
#[tauri::command]
pub async fn orch_accept(proposal: String) -> CmdResult<Note> {
    let p = with_book(false, |b| b.proposals.iter().find(|x| x.id == proposal).cloned()).ok_or("Vorschlag nicht gefunden")?;
    match launch(&proposal).await {
        Ok(s) => Ok(Note {
            master: p.master,
            text: format!(
                "[Brise · Untersessions] Der Nutzer hat „{}“ als eigene {} gestartet: {} ({}{}){}. Du bekommst eine Notiz, wenn sie ihren Turn beendet.",
                s.title,
                if s.mode.is_empty() { "Session" } else { mode_label(&s.mode) },
                s.id,
                s.backend,
                s.model.as_deref().map(|m| format!(", {m}")).unwrap_or_default(),
                branch_note(&s)
            ),
        }),
        Err(e) => Err(e),
    }
}

/// „Hier erledigen“ (here = true) bzw. Vorschlag verwerfen.
#[tauri::command]
pub fn orch_decline(proposal: String, here: bool) -> CmdResult<Note> {
    let p = with_book(true, |b| {
        let p = b.proposals.iter_mut().find(|x| x.id == proposal && x.state == "open")?;
        p.state = if here { "here" } else { "dismissed" }.into();
        Some(p.clone())
    })
    .ok_or("Vorschlag nicht mehr offen")?;
    let text = if here {
        format!("[Brise · Untersessions] Der Nutzer möchte „{}“ nicht als eigene Session: Erledige es selbst hier in dieser Session.\nAuftrag war:\n{}", p.title, p.task)
    } else {
        format!("[Brise · Untersessions] Der Nutzer hat den Vorschlag „{}“ verworfen.", p.title)
    };
    Ok(Note { master: p.master, text })
}

fn merge_blocking(req: &MergeRequest) -> CmdResult<String> {
    let s = sub(&req.session).ok_or("Untersession nicht gefunden")?;
    let repo = Path::new(&s.repo);
    let wt = Path::new(&s.cwd);
    let (dirty_sub, _) = crate::git::dirty_files(wt);
    if s.worktree && !dirty_sub.is_empty() {
        return Err(format!("Im Worktree sind {} Datei(en) nicht committet ({}). Lass die Untersession zuerst committen.", dirty_sub.len(), dirty_sub.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
    }
    let (dirty_master, _) = crate::git::dirty_files(repo);
    if !dirty_master.is_empty() {
        return Err(format!("Im Ordner der Master-Session gibt es nicht committete Änderungen ({}). Erst committen oder zurücklegen.", dirty_master.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
    }
    let into = crate::git::current_branch(repo).unwrap_or_else(|| "HEAD".into());
    if into != req.into {
        return Err(format!("Die Master-Session steht inzwischen auf {into} statt {} – bitte neu anfragen.", req.into));
    }
    let hash = crate::git::merge_branch(repo, &req.branch, &format!("Merge: {} ({})", s.title, req.branch))?;
    let cleanup = if s.worktree {
        // Repo-Wurzel des Worktrees (die Untersession kann in einem Unterordner arbeiten).
        let root = crate::git::repo_root(wt).unwrap_or_else(|| wt.to_path_buf());
        match crate::git::worktree_remove(repo, &root, &req.branch) {
            Ok(()) => " Worktree und Branch entfernt.".to_string(),
            Err(e) => format!(" Worktree bleibt erhalten ({}).", e.lines().last().unwrap_or(&e)),
        }
    } else {
        String::new()
    };
    Ok(format!("{} in {into} gemerged (Merge-Commit {hash}).{cleanup}", req.branch))
}

/// „Mergen“ auf einer Merge-Karte – die eigentliche Freigabe des Nutzers.
#[tauri::command]
pub async fn orch_merge(request: String) -> CmdResult<Note> {
    let req = with_book(false, |b| b.merges.iter().find(|m| m.id == request && m.state == "open").cloned()).ok_or("Diese Merge-Anfrage ist nicht mehr offen")?;
    let r = req.clone();
    let result = tokio::task::spawn_blocking(move || merge_blocking(&r)).await.map_err(|e| e.to_string())?;
    with_book(true, |b| {
        if let Some(m) = b.merges.iter_mut().find(|m| m.id == req.id) {
            m.state = if result.is_ok() { "merged" } else { "failed" }.into();
            m.result = Some(result.clone().unwrap_or_else(|e| e));
        }
        if result.is_ok() {
            if let Some(s) = b.subs.iter_mut().find(|s| s.id == req.session) {
                s.status = Status::Merged;
                s.updated = now_ms();
            }
        }
    });
    let text = match &result {
        Ok(msg) => format!("[Brise · Merge] Freigegeben und gemerged: „{}“ – {msg}", req.title),
        Err(e) => format!("[Brise · Merge] Der Merge von „{}“ ({} → {}) ist fehlgeschlagen: {e}", req.title, req.branch, req.into),
    };
    Ok(Note { master: req.master, text })
}

/// „Ablehnen“ auf einer Merge-Karte.
#[tauri::command]
pub fn orch_reject(request: String) -> CmdResult<Note> {
    let req = with_book(true, |b| {
        let m = b.merges.iter_mut().find(|m| m.id == request && m.state == "open")?;
        m.state = "rejected".into();
        Some(m.clone())
    })
    .ok_or("Diese Merge-Anfrage ist nicht mehr offen")?;
    Ok(Note { master: req.master, text: format!("[Brise · Merge] Der Nutzer hat den Merge von „{}“ ({}) abgelehnt. Frag nach, was fehlt, bevor du es erneut versuchst.", req.title, req.branch) })
}

/// Untersession aus der Liste nehmen (z. B. nach dem Löschen der Session).
#[tauri::command]
pub fn orch_forget(session: String) {
    with_book(true, |b| b.subs.retain(|s| s.id != session));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchState {
    book: Book,
    worktree_root: String,
    /// Fehlertext, falls gesperrt oder ausgeschaltet.
    blocked: Option<String>,
    max_parallel: usize,
}

#[tauri::command]
pub fn orch_state() -> OrchState {
    OrchState { book: with_book(false, |b| b.clone()), worktree_root: worktree_root().display().to_string(), blocked: check_enabled().err(), max_parallel: max_parallel() }
}

// ---------- MCP-Seite (läuft im Prozess `brise --mcp-app`) ----------

pub const MCP_INSTRUCTIONS: &str = "Master-Session: Größere Aufgaben kannst du in Teilaufgaben zerlegen und mit start_session als eigene Sessions \
    (Untersessions) laufen lassen – meist in einem eigenen Git-Worktree auf eigenem Branch, auf Wunsch mit anderem Backend oder Modell \
    (z. B. Vibe mit glm-5-3 für Code, claude für Reviews). Gib jeder einen vollständigen, eigenständigen Auftrag. \
    Brise schickt dir automatisch eine Notiz ([Brise · Rückmeldung]), sobald eine Untersession ihren Turn beendet, und startet damit einen neuen Turn. \
    Darum nie per Schleife abfragen und nicht mit wait warten, sondern weiterarbeiten oder den Turn beenden. Danach Ergebnis prüfen (get_session), bei Bedarf send_message, und zum Mergen merge_session: \
    gemerged wird erst, wenn der Nutzer auf der Karte zustimmt. \
    Mit mode: \"design\" bzw. \"3d\" startest du statt einer Code-Session eine Session im Design- bzw. 3D-Modus von Brise (UI-Entwürfe bzw. 3D-Modelle mit Live-Vorschau); \
    deren Ergebnis holst du nach der Rückmeldung mit read_design/export_design bzw. read_model/export_model ins Projekt.";

fn mcp_ready() -> bool {
    std::env::var("BRISE_ORCH_ADDR").is_ok_and(|a| !a.is_empty()) && std::env::var("BRISE_ORCH_PARENT").is_err() && check_enabled().is_ok()
}

/// Werkzeuge für Master-Sessions; leer für Untersessions oder wenn gesperrt.
pub fn tools() -> Vec<Value> {
    if !mcp_ready() {
        return vec![];
    }
    let session = json!({ "type": "string", "description": "Session-ID (oder ihr Anfang, mind. 6 Zeichen) bzw. Titel der Untersession" });
    vec![
        json!({
            "name": "start_session",
            "description": "Startet eine Teilaufgabe als eigene Brise-Session (Untersession). Je nach Einstellung erscheint zuerst eine Karte, \
                auf der der Nutzer „Neue Session“ oder „Hier erledigen“ wählt. Mit worktree (Standard: an) arbeitet sie in einem eigenen Git-Worktree auf eigenem Branch. \
                Die Antwort kommt sofort; das Ergebnis später als Notiz.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Kurzer Titel (max. 6 Wörter)" },
                    "task": { "type": "string", "description": "Vollständiger, eigenständiger Auftrag: Ziel, betroffene Dateien, was „fertig“ heißt, wie zu prüfen ist" },
                    "backend": { "type": "string", "description": "vibe, claude, codex oder gemini (Standard: Backend dieser Session)" },
                    "model": { "type": "string", "description": "Modell-Alias des Backends, z. B. glm-5-3 oder mistral-medium-3.5 bei Vibe (Standard: Einstellung des Backends)" },
                    "worktree": { "type": "boolean", "description": "Eigener Git-Worktree und Branch (Standard: an)" },
                    "mode": {
                        "type": "string",
                        "enum": ["code", "design", "3d"],
                        "description": "code (Standard): Coding-Session im Projekt. design: Design-Session (HTML-Entwurf mit Live-Vorschau). \
                            3d: 3D-Session (3D-Modell als Code mit Viewer, Ergebnis als GLB/STL). Bei design/3d ohne Worktree, Backend Vibe."
                    }
                },
                "required": ["title", "task"]
            }
        }),
        json!({
            "name": "list_sessions",
            "description": "Listet die Untersessions dieser Master-Session mit Status (startet, läuft, wartet auf Freigabe, fertig, Fehler, gestoppt, gemerged), Backend und Branch.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "get_session",
            "description": "Stand einer Untersession: Status, letzter Bericht, Branch, Commits gegenüber der Basis, nicht committete Dateien.",
            "inputSchema": { "type": "object", "properties": { "session": session }, "required": ["session"] },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "send_message",
            "description": "Schickt einer Untersession eine Nachricht (z. B. Korrektur, Rückfrage beantworten, „bitte committen“). Läuft sie gerade, wird die Nachricht nach dem Turn zugestellt.",
            "inputSchema": { "type": "object", "properties": { "session": session, "text": { "type": "string" } }, "required": ["session", "text"] }
        }),
        json!({
            "name": "stop_session",
            "description": "Bricht den laufenden Turn einer Untersession ab und beendet sie. Ihr Worktree bleibt erhalten.",
            "inputSchema": { "type": "object", "properties": { "session": session }, "required": ["session"] }
        }),
        json!({
            "name": "merge_session",
            "description": "Bittet den Nutzer um die Freigabe, den Branch einer fertigen Untersession in den aktuellen Branch dieser Session zu mergen. \
                Es erscheint eine Karte; gemerged wird erst nach Zustimmung. Das Ergebnis kommt als Notiz.",
            "inputSchema": { "type": "object", "properties": { "session": session }, "required": ["session"] }
        }),
    ]
}

const TOOL_NAMES: &[&str] = &["start_session", "list_sessions", "get_session", "send_message", "stop_session", "merge_session"];

/// Werkzeugaufruf im MCP-Prozess: an die laufende App weiterreichen.
pub fn call_tool(name: &str, args: &Value) -> Option<CmdResult<String>> {
    if !TOOL_NAMES.contains(&name) {
        return None;
    }
    Some(forward(name, args))
}

fn forward(name: &str, args: &Value) -> CmdResult<String> {
    if !mcp_ready() {
        return Err(check_enabled().err().unwrap_or_else(|| "Untersessions können keine weiteren Sessions steuern.".into()));
    }
    let addr = std::env::var("BRISE_ORCH_ADDR").map_err(|_| "Brise läuft nicht")?;
    let token = std::env::var("BRISE_ORCH_TOKEN").unwrap_or_default();
    let tag = std::env::var("BRISE_SECRET_TAG").unwrap_or_default();
    let cwd = std::env::var("BRISE_CWD").unwrap_or_default();
    let mut stream = std::net::TcpStream::connect(&addr).map_err(|e| format!("Brise ist nicht erreichbar: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(55))).ok();
    let msg = json!({ "token": token, "tag": tag, "cwd": cwd, "tool": name, "args": args });
    writeln!(stream, "{msg}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| format!("Keine Antwort von Brise: {e}"))?;
    let reply: Value = serde_json::from_str(&line).map_err(|_| "Ungültige Antwort von Brise")?;
    if reply["ok"].as_bool() == Some(true) {
        Ok(reply["text"].as_str().unwrap_or_default().to_string())
    } else {
        Err(reply["error"].as_str().unwrap_or("Fehler").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slug("Tests für Größe & Ähnliches"), "tests-fuer-groesse-aehnliches");
        assert_eq!(slug("  ---  "), "aufgabe");
        assert!(slug(&"x".repeat(80)).len() <= 32);
        assert_eq!(slug("API: v2 / Login"), "api-v2-login");
    }

    #[test]
    fn constant_time_compare() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }

    #[test]
    fn shorten_keeps_end() {
        assert_eq!(shorten("kurz", 10), "kurz");
        let s = shorten("anfang mitte ende", 4);
        assert_eq!(s, "…ende");
        assert_eq!(shorten_start("Ein\nlanger   Titel", 9), "Ein lange…");
    }

    #[test]
    fn design_and_3d_modes() {
        assert_eq!(mode_arg(&json!({})).unwrap(), "");
        assert_eq!(mode_arg(&json!({ "mode": "3d" })).unwrap(), "3d");
        assert!(mode_arg(&json!({ "mode": "video" })).is_err());
        let s = Sub { mode: "3d".into(), item: Some("m-abc".into()), ..Default::default() };
        assert!(result_hint(&s).unwrap().contains("export_model(\"m-abc\""));
        assert!(branch_note(&s).contains("m-abc"));
        assert!(result_hint(&Sub::default()).is_none());
        let p = Proposal { mode: "3d".into(), task: "Zahnrad mit 20 Zähnen".into(), master_cwd: "/p".into(), ..Default::default() };
        let prompt = sub_prompt(&p, "Shop");
        assert!(prompt.contains("ein 3D-Modell") && prompt.ends_with("Zahnrad mit 20 Zähnen") && !prompt.contains("Worktree"));
    }

    #[test]
    fn status_active() {
        assert!(Status::Waiting.active());
        assert!(!Status::Done.active());
        assert_eq!(serde_json::to_value(Status::Interrupted).unwrap(), json!("interrupted"));
    }

    /// Worktree anlegen, committen, mergen, aufräumen – mit echtem Git.
    #[test]
    fn worktree_merge_roundtrip() {
        if crate::git::find_git().is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("brise-orch-test-{}", random_hex(4)));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let g = |cwd: &Path, args: &[&str]| crate::git::git_output(cwd, args).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        g(&repo, &["config", "user.email", "test@example.invalid"]);
        g(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "eins\n").unwrap();
        g(&repo, &["add", "."]);
        g(&repo, &["commit", "-q", "-m", "Start"]);
        let wt = dir.join("wt").join("aufgabe");
        crate::git::worktree_add(&repo, &wt, "brise/aufgabe").unwrap();
        assert_eq!(crate::git::current_branch(&wt).as_deref(), Some("brise/aufgabe"));
        std::fs::write(wt.join("b.txt"), "zwei\n").unwrap();
        assert_eq!(crate::git::dirty_files(&wt), (vec![], vec!["b.txt".to_string()]));
        g(&wt, &["add", "."]);
        g(&wt, &["commit", "-q", "-m", "B"]);
        assert_eq!(crate::git::ahead_of(&repo, "main", "brise/aufgabe"), 1);
        let hash = crate::git::merge_branch(&repo, "brise/aufgabe", "Merge: Aufgabe").unwrap();
        assert!(!hash.is_empty());
        assert!(repo.join("b.txt").is_file());
        crate::git::worktree_remove(&repo, &wt, "brise/aufgabe").unwrap();
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
