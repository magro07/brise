//! Eigene Benchmarks: Aufgaben mit Prüfkriterien, die Brise immer wieder gegen
//! mehrere Modelle bzw. Agenten laufen lässt. Definitionen liegen als JSON in
//! `<Datenordner>/benchmarks/<id>.json` (versionierbar), Ergebnisse je Lauf in
//! `<Datenordner>/benchmarks/runs/<id>/<lauf>.json`.
//!
//! Jede Kombination Aufgabe × Ziel läuft in einer eigenen, frischen Session in
//! einem Arbeitsordner unter `<Datenordner>/benchmarks/work/` – das echte
//! Projekt wird nur gelesen (Kopie bzw. `git clone` auf den Start-Ref).
//! Bench-Sessions erscheinen nicht in der Oberfläche: agent.rs reicht ihre
//! Updates an `observe` weiter und Freigaben beantwortet `auto_permission`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::AgentState;
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const EXAMPLE: &str = include_str!("../resources/benchmarks/beispiel.json");
/// Standard-Zeitlimit einer Aufgabe und eines Prüfbefehls.
const TASK_TIMEOUT: u64 = 600;
const CHECK_TIMEOUT: u64 = 300;
const JUDGE_MODEL: &str = "mistral-small-latest";
/// Gespeicherte Antwortlänge je Ergebnis.
const ANSWER_LIMIT: usize = 6000;
/// Wie in der Oberfläche (usage.ts): Pausen zwischen Chunks bis 2 s zählen als
/// Generierung, bis zu 30 s zwischen Text und folgendem Werkzeugaufruf.
const CHUNK_GAP: Duration = Duration::from_secs(2);
const TOOL_GAP: Duration = Duration::from_secs(30);

fn dir() -> PathBuf {
    data_dir().join("benchmarks")
}

fn runs_dir(bench: &str) -> PathBuf {
    dir().join("runs").join(bench)
}

fn work_root() -> PathBuf {
    dir().join("work")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------- Definition ----------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Benchmark {
    /// Dateiname ohne `.json`; beim Speichern aus dem Namen gebildet, falls leer.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Richtermodell für `judge`-Prüfungen ohne eigenes Modell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
    pub tasks: Vec<Task>,
    pub targets: Vec<Target>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// Projektordner, der in den Arbeitsordner kopiert wird (sonst leer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Startzustand: Git-Ref (Branch, Tag, Commit) – dann `git clone` statt Kopie.
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// Zusätzliche Dateien (relativer Pfad → Inhalt), nach der Kopie geschrieben.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
    /// Befehl vor dem Prompt (z. B. `npm ci`), im Arbeitsordner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    pub checks: Vec<Check>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Check {
    /// Antwort enthält den Text.
    Contains {
        value: String,
        #[serde(default)]
        ignore_case: bool,
    },
    /// Antwort passt auf den regulären Ausdruck.
    Regex { pattern: String },
    /// Befehl im Arbeitsordner endet mit Code 0 (z. B. Tests).
    Command {
        run: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_sec: Option<u64>,
    },
    /// Datei existiert (und passt auf `pattern`).
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
    },
    /// Ein Richtermodell bewertet die Antwort mit 0–10 Punkten.
    Judge {
        criteria: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// Ab diesem Anteil (0–1) gilt die Prüfung als bestanden, Standard 0,6.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        threshold: Option<f64>,
    },
}

impl Check {
    fn kind(&self) -> &'static str {
        match self {
            Check::Contains { .. } => "contains",
            Check::Regex { .. } => "regex",
            Check::Command { .. } => "command",
            Check::File { .. } => "file",
            Check::Judge { .. } => "judge",
        }
    }

    fn label(&self) -> String {
        match self {
            Check::Contains { value, .. } => format!("enthält „{value}“"),
            Check::Regex { pattern } => format!("passt auf /{pattern}/"),
            Check::Command { run, .. } => format!("$ {run}"),
            Check::File { path, pattern: None } => format!("Datei {path}"),
            Check::File { path, pattern: Some(p) } => format!("{path} passt auf /{p}/"),
            Check::Judge { criteria, .. } => format!("Richter: {}", short(criteria, 80)),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    /// `vibe`, `claude`, `codex`, `gemini` (siehe backends.rs).
    pub backend: String,
    /// Wert der Session-Option `model`, z. B. `glm-5-3`; leer = Standard des Agenten.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Weitere Session-Optionen, z. B. `{"thinking": "high"}`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl Target {
    /// Stabile Kennung für Vergleiche über Läufe hinweg.
    fn key(&self) -> String {
        let mut k = format!("{}:{}", self.backend, self.model.as_deref().unwrap_or("standard"));
        for (o, v) in &self.options {
            k.push_str(&format!(":{o}={}", v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
        }
        k
    }

    fn display(&self) -> String {
        if let Some(l) = self.label.as_deref().filter(|l| !l.is_empty()) {
            return l.to_string();
        }
        let agent = crate::backends::get(&self.backend).map(|b| b.title()).unwrap_or(&self.backend);
        let mut s = match &self.model {
            Some(m) => format!("{agent} · {m}"),
            None => agent.to_string(),
        };
        for (o, v) in &self.options {
            s.push_str(&format!(" · {o} {}", v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
        }
        s
    }
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    format!("{}…", s.chars().take(n).collect::<String>())
}

/// Kleinbuchstaben, Ziffern und Bindestriche – für Datei- und Ordnernamen.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        let c = match c {
            'ä' => "ae".to_string(),
            'ö' => "oe".to_string(),
            'ü' => "ue".to_string(),
            'ß' => "ss".to_string(),
            c if c.is_ascii_alphanumeric() => c.to_string(),
            _ => "-".to_string(),
        };
        out.push_str(&c);
    }
    let parts: Vec<&str> = out.split('-').filter(|p| !p.is_empty()).collect();
    let s = parts.join("-");
    if s.is_empty() { "benchmark".into() } else { s.chars().take(48).collect() }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Benchmark {
    /// Prüft die Definition und ergänzt fehlende Aufgaben-IDs.
    fn normalize(&mut self) -> CmdResult<()> {
        if self.name.trim().is_empty() {
            return Err("Der Benchmark braucht einen Namen".into());
        }
        if self.tasks.is_empty() {
            return Err("Der Benchmark braucht mindestens eine Aufgabe".into());
        }
        if self.targets.is_empty() {
            return Err("Der Benchmark braucht mindestens ein Ziel (Modell bzw. Agent)".into());
        }
        let mut seen = std::collections::HashSet::new();
        for (i, t) in self.tasks.iter_mut().enumerate() {
            if t.name.trim().is_empty() {
                t.name = format!("Aufgabe {}", i + 1);
            }
            if t.id.trim().is_empty() {
                t.id = slug(&t.name);
            }
            while !seen.insert(t.id.clone()) {
                t.id = format!("{}-{}", t.id, i + 1);
            }
            if t.prompt.trim().is_empty() {
                return Err(format!("„{}“: Prompt fehlt", t.name));
            }
            if t.checks.is_empty() {
                return Err(format!("„{}“: mindestens eine Prüfung nötig", t.name));
            }
            if let Some(p) = &t.project {
                if !Path::new(p).is_dir() {
                    return Err(format!("„{}“: Projektordner {p} gibt es nicht", t.name));
                }
            }
            for (path, _) in &t.files {
                if !safe_relative(path) {
                    return Err(format!("„{}“: Dateipfad {path} muss relativ sein und darf nicht mit .. aus dem Ordner führen", t.name));
                }
            }
            for c in &t.checks {
                match c {
                    Check::Regex { pattern } | Check::File { pattern: Some(pattern), .. } => {
                        regex::Regex::new(pattern).map_err(|e| format!("„{}“: Regex /{pattern}/: {e}", t.name))?;
                    }
                    Check::File { path, .. } if !safe_relative(path) => return Err(format!("„{}“: Dateipfad {path} muss relativ sein", t.name)),
                    Check::Command { run, .. } if run.trim().is_empty() => return Err(format!("„{}“: leerer Prüfbefehl", t.name)),
                    Check::Judge { criteria, .. } if criteria.trim().is_empty() => return Err(format!("„{}“: Richter ohne Kriterien", t.name)),
                    _ => {}
                }
            }
        }
        for t in &self.targets {
            if crate::backends::get(&t.backend).is_none() {
                return Err(format!("Unbekannter Agent: {}", t.backend));
            }
        }
        Ok(())
    }
}

fn safe_relative(path: &str) -> bool {
    let p = Path::new(path);
    !path.is_empty() && p.is_relative() && !p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_)))
}

fn def_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.json"))
}

/// Legt den mitgelieferten Beispiel-Benchmark einmalig an (nicht wieder, wenn gelöscht).
fn seed() {
    let marker = dir().join(".beispiel");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(dir());
    let path = def_path("beispiel");
    if !path.exists() {
        let _ = std::fs::write(&path, EXAMPLE);
    }
    let _ = std::fs::write(marker, "");
}

fn load(id: &str) -> CmdResult<Benchmark> {
    if !valid_id(id) {
        return Err(format!("Ungültige Benchmark-ID: {id}"));
    }
    let text = std::fs::read_to_string(def_path(id)).map_err(|e| format!("{id}.json: {e}"))?;
    let mut b: Benchmark = serde_json::from_str(&text).map_err(|e| format!("{id}.json: {e}"))?;
    b.id = id.to_string();
    Ok(b)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    id: String,
    name: String,
    description: String,
    tasks: usize,
    targets: usize,
    runs: usize,
    last_run: Option<RunSummary>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    id: String,
    started: u64,
    status: String,
    passed: usize,
    total: usize,
}

#[tauri::command]
pub fn bench_list() -> Vec<Summary> {
    seed();
    let mut ids: Vec<String> = std::fs::read_dir(dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .filter(|id| valid_id(id))
        .collect();
    ids.sort();
    ids.into_iter()
        .map(|id| {
            let runs = load_runs(&id);
            let last_run = runs.last().map(|r| RunSummary {
                id: r.id.clone(),
                started: r.started,
                status: r.status.clone(),
                passed: r.results.iter().filter(|x| x.passed).count(),
                total: r.results.len(),
            });
            match load(&id) {
                Ok(b) => Summary { id, name: b.name, description: b.description, tasks: b.tasks.len(), targets: b.targets.len(), runs: runs.len(), last_run, error: None },
                Err(e) => Summary { name: id.clone(), id, description: String::new(), tasks: 0, targets: 0, runs: runs.len(), last_run, error: Some(e) },
            }
        })
        .collect()
}

#[tauri::command]
pub fn bench_get(id: String) -> CmdResult<Benchmark> {
    load(&id)
}

/// Speichert eine Definition; ohne `id` wird eine neue Datei aus dem Namen angelegt.
#[tauri::command]
pub fn bench_save(mut bench: Benchmark) -> CmdResult<String> {
    crate::policy::check_section("usage")?;
    bench.normalize()?;
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    if bench.id.is_empty() {
        let base = slug(&bench.name);
        let mut id = base.clone();
        let mut n = 2;
        while def_path(&id).exists() {
            id = format!("{base}-{n}");
            n += 1;
        }
        bench.id = id;
    } else if !valid_id(&bench.id) {
        return Err(format!("Ungültige Benchmark-ID: {}", bench.id));
    }
    let id = bench.id.clone();
    // Die ID steckt im Dateinamen, nicht in der Datei.
    bench.id.clear();
    let mut text = serde_json::to_string_pretty(&bench).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(def_path(&id), text).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Löscht die Definition; Läufe bleiben für den Verlauf erhalten, außer mit `runs`.
#[tauri::command]
pub fn bench_delete(id: String, runs: Option<bool>) -> CmdResult<()> {
    crate::policy::check_section("usage")?;
    if !valid_id(&id) {
        return Err(format!("Ungültige Benchmark-ID: {id}"));
    }
    std::fs::remove_file(def_path(&id)).map_err(|e| e.to_string())?;
    if runs.unwrap_or(false) {
        let _ = std::fs::remove_dir_all(runs_dir(&id));
    }
    Ok(())
}

#[tauri::command]
pub fn bench_dir() -> String {
    seed();
    dir().display().to_string()
}

// ---------- Läufe ----------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Run {
    pub id: String,
    pub bench_id: String,
    pub bench_name: String,
    pub started: u64,
    pub finished: Option<u64>,
    /// running, done, cancelled, failed
    pub status: String,
    /// Anzahl geplanter Kombinationen Aufgabe × Ziel.
    pub total: usize,
    /// Ziele in Reihenfolge der Definition (Schlüssel + Anzeige).
    pub targets: Vec<RunTarget>,
    pub tasks: Vec<RunTask>,
    pub results: Vec<TaskResult>,
    /// Gerade laufende Kombination.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunTarget {
    pub key: String,
    pub label: String,
    pub backend: String,
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunTask {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskResult {
    pub task: String,
    pub target: String,
    pub passed: bool,
    /// Anteil bestandener bzw. bewerteter Prüfungen, 0–1.
    pub score: f64,
    pub checks: Vec<CheckResult>,
    pub error: Option<String>,
    pub stop_reason: Option<String>,
    /// Tatsächlich benutztes Modell laut Session.
    pub model: Option<String>,
    pub duration_ms: u64,
    pub ttft_ms: Option<u64>,
    pub output_tps: Option<f64>,
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub tool_calls: u64,
    /// Geschätzte Kosten in €; `None` = kein Preis bekannt.
    pub cost_eur: Option<f64>,
    pub answer: String,
    /// Hinweise des Agenten, die nicht zur Antwort zählen.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<String>,
    /// Arbeitsordner, falls er behalten wurde (bei Fehlschlag).
    pub workdir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckResult {
    pub kind: String,
    pub label: String,
    pub passed: bool,
    pub score: f64,
    pub detail: String,
}

fn run_path(bench: &str, run: &str) -> PathBuf {
    runs_dir(bench).join(format!("{run}.json"))
}

fn save_run(run: &Run) {
    let _ = std::fs::create_dir_all(runs_dir(&run.bench_id));
    match serde_json::to_vec_pretty(run) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(run_path(&run.bench_id, &run.id), bytes) {
                eprintln!("Benchmark-Lauf speichern: {e}");
            }
        }
        Err(e) => eprintln!("Benchmark-Lauf speichern: {e}"),
    }
}

fn load_runs(bench: &str) -> Vec<Run> {
    let mut runs: Vec<Run> = std::fs::read_dir(runs_dir(bench))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Run>(&std::fs::read(e.path()).ok()?).ok())
        .collect();
    runs.sort_by_key(|r| r.started);
    // Ein Lauf, der beim Beenden der App noch lief, ist abgebrochen.
    let active = ACTIVE.lock().unwrap().as_ref().map(|r| r.id.clone());
    for r in &mut runs {
        if r.status == "running" && active.as_deref() != Some(r.id.as_str()) {
            r.status = "cancelled".into();
            r.current = None;
        }
    }
    runs
}

/// Alle Läufe eines Benchmarks, älteste zuerst.
#[tauri::command]
pub fn bench_runs(id: String) -> CmdResult<Vec<Run>> {
    if !valid_id(&id) {
        return Err(format!("Ungültige Benchmark-ID: {id}"));
    }
    Ok(load_runs(&id))
}

#[tauri::command]
pub fn bench_delete_run(id: String, run: String) -> CmdResult<()> {
    if !valid_id(&id) || !valid_id(&run) {
        return Err("Ungültige ID".into());
    }
    let _ = std::fs::remove_dir_all(work_root().join(&run));
    std::fs::remove_file(run_path(&id, &run)).map_err(|e| e.to_string())
}

/// Der laufende Benchmark (höchstens einer gleichzeitig).
static ACTIVE: Mutex<Option<Run>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Session der gerade laufenden Kombination (für den Abbruch).
static CURRENT_SESSION: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub fn bench_status() -> Option<Run> {
    ACTIVE.lock().unwrap().clone()
}

#[tauri::command]
pub async fn bench_cancel(app: AppHandle) -> CmdResult<()> {
    CANCEL.store(true, Ordering::SeqCst);
    let sid = CURRENT_SESSION.lock().unwrap().clone();
    if let Some(sid) = sid {
        let _ = crate::agent::cancel(app.clone(), app.state::<AgentState>(), sid).await;
    }
    Ok(())
}

/// Startet einen Lauf im Hintergrund. `tasks`/`targets` schränken auf IDs bzw.
/// Ziel-Schlüssel ein (leer = alle). Fortschritt kommt als Event `bench:progress`.
#[tauri::command]
pub fn bench_run(app: AppHandle, id: String, tasks: Option<Vec<String>>, targets: Option<Vec<String>>) -> CmdResult<Run> {
    let mut bench = load(&id)?;
    bench.normalize()?;
    let tasks = tasks.unwrap_or_default();
    let targets = targets.unwrap_or_default();
    if !tasks.is_empty() {
        bench.tasks.retain(|t| tasks.contains(&t.id));
    }
    if !targets.is_empty() {
        bench.targets.retain(|t| targets.contains(&t.key()));
    }
    if bench.tasks.is_empty() || bench.targets.is_empty() {
        return Err("Nichts ausgewählt".into());
    }
    let started = now_ms();
    let run = Run {
        id: format!("{started}"),
        bench_id: id.clone(),
        bench_name: bench.name.clone(),
        started,
        finished: None,
        status: "running".into(),
        total: bench.tasks.len() * bench.targets.len(),
        targets: bench.targets.iter().map(|t| RunTarget { key: t.key(), label: t.display(), backend: t.backend.clone(), model: t.model.clone() }).collect(),
        tasks: bench.tasks.iter().map(|t| RunTask { id: t.id.clone(), name: t.name.clone() }).collect(),
        results: Vec::new(),
        current: None,
    };
    {
        let mut active = ACTIVE.lock().unwrap();
        if active.is_some() {
            return Err("Es läuft schon ein Benchmark".into());
        }
        *active = Some(run.clone());
    }
    CANCEL.store(false, Ordering::SeqCst);
    save_run(&run);
    let _ = app.emit("bench:progress", &run);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        execute(&handle, bench).await;
    });
    Ok(run)
}

fn update_active(app: &AppHandle, f: impl FnOnce(&mut Run)) {
    let snapshot = {
        let mut active = ACTIVE.lock().unwrap();
        let Some(run) = active.as_mut() else { return };
        f(run);
        run.clone()
    };
    save_run(&snapshot);
    let _ = app.emit("bench:progress", &snapshot);
}

async fn execute(app: &AppHandle, bench: Benchmark) {
    let run_id = ACTIVE.lock().unwrap().as_ref().map(|r| r.id.clone()).unwrap_or_default();
    // Aufgabe für Aufgabe, darin alle Ziele – so sieht man früh einen Vergleich.
    'outer: for task in &bench.tasks {
        for target in &bench.targets {
            if CANCEL.load(Ordering::SeqCst) {
                break 'outer;
            }
            let label = format!("{} · {}", task.name, target.display());
            update_active(app, |r| r.current = Some(label));
            let result = run_one(app, &bench, &run_id, task, target).await;
            update_active(app, |r| {
                r.results.push(result);
                r.current = None;
            });
        }
    }
    let cancelled = CANCEL.load(Ordering::SeqCst);
    update_active(app, |r| {
        r.status = if cancelled { "cancelled" } else { "done" }.into();
        r.finished = Some(now_ms());
    });
    ACTIVE.lock().unwrap().take();
    // Leere Arbeitsordner des Laufs aufräumen.
    let _ = std::fs::remove_dir(work_root().join(&run_id));
}

async fn run_one(app: &AppHandle, bench: &Benchmark, run_id: &str, task: &Task, target: &Target) -> TaskResult {
    let mut result = TaskResult { task: task.id.clone(), target: target.key(), model: target.model.clone(), ..Default::default() };
    let work = work_root().join(run_id).join(format!("{}--{}", task.id, slug(&target.key())));
    let prepared = {
        let (task, work) = (task.clone(), work.clone());
        tokio::task::spawn_blocking(move || prepare(&task, &work)).await.map_err(|e| e.to_string()).and_then(|r| r)
    };
    if let Err(e) = prepared {
        result.error = Some(format!("Arbeitsordner: {e}"));
        result.workdir = Some(work.display().to_string());
        return result;
    }
    if let Some(setup) = task.setup.as_deref().filter(|s| !s.trim().is_empty()) {
        let (ok, out) = shell(setup, &work, CHECK_TIMEOUT).await;
        if !ok {
            result.error = Some(format!("Vorbereitung „{setup}“ fehlgeschlagen:\n{}", short(&out, 2000)));
            result.workdir = Some(work.display().to_string());
            return result;
        }
    }

    match agent_turn(app, task, target, &work, &mut result).await {
        Ok(()) => {}
        Err(e) => result.error = Some(e),
    }

    // Prüfen – auch nach einem Fehler, damit sichtbar wird, was schon stimmt.
    if result.error.is_none() || !result.answer.is_empty() {
        let judge_default = bench.judge_model.clone();
        for check in &task.checks {
            let r = evaluate(check, &result.answer, &work, task, judge_default.as_deref()).await;
            result.checks.push(r);
        }
    }
    let n = result.checks.len().max(1) as f64;
    result.score = if result.error.is_some() && result.checks.is_empty() { 0.0 } else { (result.checks.iter().map(|c| c.score).sum::<f64>() / n * 100.0).round() / 100.0 };
    result.passed = result.error.is_none() && !result.checks.is_empty() && result.checks.iter().all(|c| c.passed);
    if result.passed {
        let _ = std::fs::remove_dir_all(&work);
    } else {
        result.workdir = Some(work.display().to_string());
    }
    result
}

/// Legt den Arbeitsordner an: Git-Klon auf den Ref, Kopie des Projekts oder leer,
/// danach die Zusatzdateien.
fn prepare(task: &Task, work: &Path) -> CmdResult<()> {
    if work.exists() {
        std::fs::remove_dir_all(work).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = work.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match (&task.project, &task.git_ref) {
        (Some(project), Some(git_ref)) if !git_ref.trim().is_empty() => {
            let src = Path::new(project);
            let parent = work.parent().unwrap_or(work);
            let name = work.file_name().and_then(|n| n.to_str()).unwrap_or("work");
            crate::git::git_output(parent, &["clone", "--quiet", "--no-checkout", &src.display().to_string(), name])?;
            crate::git::git_output(work, &["checkout", "--quiet", "--detach", git_ref.trim()]).map_err(|e| format!("Ref {git_ref}: {e}"))?;
        }
        (Some(project), _) => copy_tree(Path::new(project), work)?,
        (None, _) => std::fs::create_dir_all(work).map_err(|e| e.to_string())?,
    }
    for (rel, content) in &task.files {
        let path = work.join(rel);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| format!("{rel}: {e}"))?;
    }
    Ok(())
}

/// Kopiert den Arbeitsstand eines Projekts ohne `.git` und ohne, was `.gitignore`
/// ausschließt (node_modules, target, …).
fn copy_tree(src: &Path, dst: &Path) -> CmdResult<()> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let walker = ignore::WalkBuilder::new(src).hidden(false).git_ignore(true).require_git(false).filter_entry(|e| e.file_name() != ".git").build();
    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = entry.path().strip_prefix(src).map_err(|e| e.to_string())?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dst.join(rel);
        let ft = entry.file_type();
        if ft.is_some_and(|t| t.is_dir()) {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else if ft.is_some_and(|t| t.is_file()) {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", rel.display()))?;
        }
    }
    Ok(())
}

/// Führt einen Befehl über die Shell aus; liefert (Erfolg, Ausgabe).
async fn shell(cmd: &str, cwd: &Path, timeout: u64) -> (bool, String) {
    let mut c = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    c.current_dir(cwd).stdin(std::process::Stdio::null()).kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(timeout), c.output()).await {
        Err(_) => (false, format!("Zeitüberschreitung nach {timeout} s")),
        Ok(Err(e)) => (false, e.to_string()),
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            let text = text.trim();
            // Das Ende der Ausgabe ist meist aussagekräftiger (Testzusammenfassung).
            let chars: Vec<char> = text.chars().collect();
            let tail: String = chars[chars.len().saturating_sub(1500)..].iter().collect();
            let code = out.status.code().map_or("Signal".to_string(), |c| c.to_string());
            (out.status.success(), format!("Exit {code}\n{tail}"))
        }
    }
}

// ---------- Agent-Turn ----------

/// Mitschnitt einer laufenden Bench-Session (aus agent.rs gefüttert).
#[derive(Default)]
struct Live {
    sent: Option<Instant>,
    first: Option<Instant>,
    last: Option<Instant>,
    /// 1 = Chunk, 2 = Werkzeugaufruf, 3 = Werkzeug-Update
    last_kind: u8,
    generation: Duration,
    text: String,
    /// Hinweise des Agenten außerhalb der Antwort (z. B. Vibes MCP-Warnungen).
    notices: Vec<String>,
    tool_calls: u64,
    meta: Value,
}

/// Vibe schickt nach `session/new` Warnungen als gewöhnliche Text-Chunks
/// (acp/agent.py `_warm_up`); sie gehören weder zur Antwort noch zur Messung.
fn is_warm_up_notice(text: &str) -> bool {
    text.starts_with("The following MCP servers failed to connect:") || text.starts_with("MCP OAuth login is required for:")
}

static LIVE: Mutex<Option<HashMap<String, Live>>> = Mutex::new(None);

fn with_live<R>(f: impl FnOnce(&mut HashMap<String, Live>) -> R) -> R {
    let mut guard = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Gehört die Session zu einem Benchmark? Dann schluckt agent.rs das Update.
pub fn observe(session: &str, update: &Value) -> bool {
    with_live(|map| {
        let Some(l) = map.get_mut(session) else { return false };
        let now = Instant::now();
        let after_chunk = matches!(l.last_kind, 1 | 2);
        let gap = l.last.map(|t| now.duration_since(t)).unwrap_or_default();
        match update["sessionUpdate"].as_str().unwrap_or_default() {
            kind @ ("agent_message_chunk" | "agent_thought_chunk") => {
                let text = update["content"]["text"].as_str().unwrap_or_default();
                if text.is_empty() || l.sent.is_none() {
                    return true;
                }
                if kind == "agent_message_chunk" && is_warm_up_notice(text) {
                    l.notices.push(text.to_string());
                    return true;
                }
                if kind == "agent_message_chunk" {
                    l.text.push_str(text);
                }
                if l.first.is_none() {
                    l.first = Some(now);
                } else if after_chunk && gap < CHUNK_GAP {
                    l.generation += gap;
                }
                l.last = Some(now);
                l.last_kind = 1;
            }
            "tool_call" => {
                l.tool_calls += 1;
                if !l.text.is_empty() && !l.text.ends_with('\n') {
                    l.text.push_str("\n\n");
                }
                if l.first.is_none() {
                    l.first = Some(now);
                } else if after_chunk {
                    l.generation += gap.min(TOOL_GAP);
                }
                l.last = Some(now);
                l.last_kind = 2;
            }
            "tool_call_update" => {
                l.last = Some(now);
                l.last_kind = 3;
            }
            "usage_update" => {
                if let Some(m) = update["_meta"].as_object() {
                    if let Some(obj) = l.meta.as_object_mut() {
                        obj.extend(m.clone());
                    } else {
                        l.meta = Value::Object(m.clone());
                    }
                }
            }
            _ => {}
        }
        true
    })
}

/// Freigabe-Anfragen von Bench-Sessions beantwortet Brise selbst mit „erlauben“ –
/// der Agent arbeitet ohnehin in einem Wegwerf-Ordner.
pub fn auto_permission(session: &str, request: &Value) -> Option<Value> {
    if !with_live(|map| map.contains_key(session)) {
        return None;
    }
    let options = request["options"].as_array().cloned().unwrap_or_default();
    let pick = ["allow_once", "allow_always"]
        .iter()
        .find_map(|k| options.iter().find(|o| o["kind"] == *k))
        .or_else(|| options.first())
        .and_then(|o| o["optionId"].as_str().map(str::to_string));
    Some(match pick {
        Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    })
}

struct SessionGuard {
    id: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        with_live(|map| map.remove(&self.id));
        let mut cur = CURRENT_SESSION.lock().unwrap();
        if cur.as_deref() == Some(self.id.as_str()) {
            *cur = None;
        }
    }
}

fn option_values(config: &Value, id: &str) -> Option<Vec<String>> {
    let opt = config.as_array()?.iter().find(|o| o["id"] == id)?;
    let mut values = Vec::new();
    for o in opt["options"].as_array().into_iter().flatten() {
        // ACP erlaubt auch Gruppen ({group, options: [...]}).
        if let Some(inner) = o["options"].as_array() {
            values.extend(inner.iter().filter_map(|i| i["value"].as_str().map(str::to_string)));
        } else if let Some(v) = o["value"].as_str() {
            values.push(v.to_string());
        }
    }
    Some(values)
}

fn current_value(config: &Value, id: &str) -> Option<String> {
    config.as_array()?.iter().find(|o| o["id"] == id)?["currentValue"].as_str().map(str::to_string)
}

async fn agent_turn(app: &AppHandle, task: &Task, target: &Target, work: &Path, result: &mut TaskResult) -> CmdResult<()> {
    let state = app.state::<AgentState>();
    let cwd = work.display().to_string();
    let setup = crate::agent::new_session(app.clone(), state.clone(), cwd.clone(), Some(false), Some(false), Some(target.backend.clone()), None, None).await?;
    let sid = setup["sessionId"].as_str().ok_or("Agent hat keine Session-ID geliefert")?.to_string();
    with_live(|map| map.insert(sid.clone(), Live::default()));
    *CURRENT_SESSION.lock().unwrap() = Some(sid.clone());
    let _guard = SessionGuard { id: sid.clone() };

    let outcome = drive(app, &sid, &setup, task, target, result).await;

    // Sessionstand merken, damit der Import aus Vibes Logs den Lauf nicht noch einmal bucht.
    let _ = crate::usage::usage_baseline(sid.clone(), result.input, result.cached, result.output);
    let _ = crate::agent::delete_session(app.clone(), state, sid).await;
    outcome
}

async fn drive(app: &AppHandle, sid: &str, setup: &Value, task: &Task, target: &Target, result: &mut TaskResult) -> CmdResult<()> {
    let state = app.state::<AgentState>();
    let mut config = setup["configOptions"].clone();

    // Ohne Rückfragen arbeiten, soweit der Agent einen solchen Modus hat.
    let modes: Vec<String> = setup["modes"]["availableModes"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    if let Some(mode) = ["auto-approve", "bypassPermissions", "yolo"].iter().find(|m| modes.iter().any(|x| x == *m)) {
        let _ = crate::agent::set_mode(app.clone(), state.clone(), sid.to_string(), mode.to_string()).await;
    }

    let mut wanted: Vec<(String, Value)> = Vec::new();
    if let Some(m) = target.model.as_deref().filter(|m| !m.is_empty()) {
        wanted.push(("model".into(), json!(m)));
    }
    wanted.extend(target.options.iter().map(|(k, v)| (k.clone(), v.clone())));
    for (id, value) in wanted {
        // Erst nach dem Modellwechsel steht fest, welche Denkstufen es gibt.
        if let (Some(values), Some(v)) = (option_values(&config, &id), value.as_str()) {
            if !values.iter().any(|x| x == v) {
                return Err(format!("{} kennt für „{id}“ den Wert „{v}“ nicht (verfügbar: {})", target.display(), values.join(", ")));
            }
        } else if option_values(&config, &id).is_none() {
            return Err(format!("{} hat keine Option „{id}“", target.display()));
        }
        let r = crate::agent::set_config_option(app.clone(), state.clone(), sid.to_string(), id.clone(), value.clone()).await.map_err(|e| format!("Option {id}: {e}"))?;
        if r["configOptions"].is_array() {
            config = r["configOptions"].clone();
        }
    }
    result.model = current_value(&config, "model").or_else(|| target.model.clone());

    let timeout = task.timeout_sec.unwrap_or(TASK_TIMEOUT);
    let started = Instant::now();
    with_live(|map| {
        if let Some(l) = map.get_mut(sid) {
            l.sent = Some(started);
        }
    });
    let prompt = vec![json!({ "type": "text", "text": task.prompt })];
    let reply = tokio::time::timeout(Duration::from_secs(timeout), crate::agent::prompt(app.clone(), state.clone(), sid.to_string(), prompt)).await;
    let ended = Instant::now();
    let outcome = match reply {
        Err(_) => {
            let _ = crate::agent::cancel(app.clone(), state.clone(), sid.to_string()).await;
            Err(format!("Zeitüberschreitung nach {timeout} s"))
        }
        Ok(Err(e)) => Err(e),
        Ok(Ok(r)) => {
            result.stop_reason = r["stopReason"].as_str().map(str::to_string);
            let u = &r["usage"];
            result.input = u["inputTokens"].as_u64().unwrap_or(0);
            result.output = u["outputTokens"].as_u64().unwrap_or(0);
            result.cached = u["cachedReadTokens"].as_u64().unwrap_or(0);
            if CANCEL.load(Ordering::SeqCst) {
                Err("Abgebrochen".to_string())
            } else if result.stop_reason.as_deref().is_some_and(|s| s != "end_turn") {
                Err(format!("Turn endete mit „{}“", result.stop_reason.as_deref().unwrap_or_default()))
            } else {
                Ok(())
            }
        }
    };
    // Das letzte usage_update kommt manchmal erst nach der Antwort.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (first, generation, text, notices, tool_calls, meta) = with_live(|map| {
        map.get_mut(sid).map(|l| (l.first, l.generation, std::mem::take(&mut l.text), std::mem::take(&mut l.notices), l.tool_calls, l.meta.clone())).unwrap_or_default()
    });
    result.notices = notices;
    // Vibe zählt kumuliert je Session – die Session ist frisch, also gilt der Stand.
    result.input = result.input.max(meta["promptTokens"].as_u64().unwrap_or(0));
    result.output = result.output.max(meta["completionTokens"].as_u64().unwrap_or(0));
    result.cached = result.cached.max(meta["cachedTokens"].as_u64().unwrap_or(0)).min(result.input);
    result.tool_calls = tool_calls;
    result.answer = short(text.trim(), ANSWER_LIMIT);
    result.duration_ms = ended.duration_since(started).as_millis() as u64;
    result.ttft_ms = first.map(|f| f.duration_since(started).as_millis() as u64);
    result.output_tps = (generation > Duration::ZERO).then(|| crate::usage::tokens_per_second(result.output, generation)).flatten();

    book(target, task, result, started_ms(started));
    outcome
}

/// Wanduhrzeit eines `Instant` (für die Suche im Journal).
fn started_ms(at: Instant) -> u64 {
    now_ms().saturating_sub(at.elapsed().as_millis() as u64)
}

/// Bucht den Turn ins Nutzungsjournal (Art `bench`) und schätzt die Kosten.
/// Cortecs-Modelle bucht der ZDR-Proxy selbst mit echten Kosten.
fn book(target: &Target, task: &Task, result: &mut TaskResult, from_ms: u64) {
    let model = result.model.clone().unwrap_or_else(|| "unbekannt".into());
    if model.starts_with("cortecs") {
        result.cost_eur = Some(crate::usage::provider_cost(crate::cortecs::PROVIDER, from_ms, now_ms()));
        return;
    }
    let mut rec = crate::usage::Record::new("bench", "Benchmark", &model).backend(&target.backend);
    rec.title = Some(task.name.clone());
    rec.input = result.input;
    rec.cached = result.cached;
    rec.output = result.output;
    rec.turns = 1;
    rec.tool_calls = result.tool_calls;
    rec.duration_ms = Some(result.duration_ms);
    rec.ttft_ms = result.ttft_ms;
    rec.output_tps = result.output_tps;
    result.cost_eur = crate::usage::estimate_eur(&rec);
    crate::usage::record(rec);
}

// ---------- Prüfungen ----------

fn check_result(check: &Check, passed: bool, detail: impl Into<String>) -> CheckResult {
    CheckResult { kind: check.kind().into(), label: check.label(), passed, score: if passed { 1.0 } else { 0.0 }, detail: detail.into() }
}

async fn evaluate(check: &Check, answer: &str, work: &Path, task: &Task, judge_default: Option<&str>) -> CheckResult {
    match check {
        Check::Contains { value, ignore_case } => {
            let found = if *ignore_case { answer.to_lowercase().contains(&value.to_lowercase()) } else { answer.contains(value.as_str()) };
            check_result(check, found, if found { "gefunden" } else { "nicht in der Antwort" })
        }
        Check::Regex { pattern } => match regex::Regex::new(pattern) {
            Ok(re) => match re.find(answer) {
                Some(m) => check_result(check, true, format!("Treffer: {}", short(m.as_str(), 120))),
                None => check_result(check, false, "kein Treffer in der Antwort"),
            },
            Err(e) => check_result(check, false, format!("Ungültiger Ausdruck: {e}")),
        },
        Check::Command { run, timeout_sec } => {
            let (ok, out) = shell(run, work, timeout_sec.unwrap_or(CHECK_TIMEOUT)).await;
            check_result(check, ok, out)
        }
        Check::File { path, pattern } => {
            let full = work.join(path);
            match (std::fs::read_to_string(&full), pattern) {
                (Err(_), _) if !full.exists() => check_result(check, false, "Datei fehlt"),
                (Err(e), Some(_)) => check_result(check, false, e.to_string()),
                (_, None) => check_result(check, true, "vorhanden"),
                (Ok(text), Some(p)) => match regex::Regex::new(p) {
                    Ok(re) if re.is_match(&text) => check_result(check, true, "Inhalt passt"),
                    Ok(_) => check_result(check, false, "Inhalt passt nicht"),
                    Err(e) => check_result(check, false, format!("Ungültiger Ausdruck: {e}")),
                },
            }
        }
        Check::Judge { criteria, model, threshold } => {
            let fallback = crate::providers::function_model("judge");
            let model = model.as_deref().or(judge_default).or(fallback.as_deref()).unwrap_or(JUDGE_MODEL);
            match judge(model, &task.prompt, answer, criteria, work).await {
                Ok((points, reason)) => {
                    let score = (points / 10.0).clamp(0.0, 1.0);
                    let passed = score >= threshold.unwrap_or(0.6);
                    CheckResult { kind: "judge".into(), label: check.label(), passed, score: (score * 100.0).round() / 100.0, detail: format!("{points}/10 ({model}): {reason}") }
                }
                Err(e) => check_result(check, false, format!("Richter {model}: {e}")),
            }
        }
    }
}

const JUDGE_SYSTEM: &str = "Du bist ein strenger, fairer Prüfer für Antworten von KI-Coding-Agenten. \
Bewerte die Antwort ausschließlich nach den genannten Kriterien mit 0 bis 10 Punkten \
(10 = erfüllt alle Kriterien vollständig, 0 = verfehlt sie). Antworte nur mit JSON: \
{\"points\": <0-10>, \"reason\": \"<ein bis zwei Sätze auf Deutsch>\"}.";

/// Bittet ein Richtermodell um 0–10 Punkte. Modell als `anbieter/modell`
/// (z. B. `cortecs/glm-5.3` mit ZDR); ohne Präfix ein Mistral-Modell.
async fn judge(model: &str, prompt: &str, answer: &str, criteria: &str, work: &Path) -> CmdResult<(f64, String)> {
    let user = format!(
        "## Aufgabe an den Agenten\n{prompt}\n\n## Kriterien\n{criteria}\n\n## Antwort des Agenten\n{}",
        if answer.trim().is_empty() { "(keine Textantwort)" } else { answer }
    );
    let v = crate::providers::chat_json(model, "bench", "Benchmark: Richter", JUDGE_SYSTEM, &user, 120, Some(&work.display().to_string())).await?;
    let points = v["points"].as_f64().or_else(|| v["points"].as_str().and_then(|s| s.trim().parse().ok())).ok_or_else(|| format!("Antwort ohne Punkte: {v}"))?;
    Ok((points, v["reason"].as_str().unwrap_or_default().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_is_valid() {
        let mut b: Benchmark = serde_json::from_str(EXAMPLE).unwrap();
        b.normalize().unwrap();
        assert!(b.tasks.len() >= 2 && !b.targets.is_empty());
        assert!(b.tasks.iter().any(|t| t.checks.iter().any(|c| matches!(c, Check::Command { .. }))));
    }

    #[test]
    fn check_format() {
        let c: Vec<Check> = serde_json::from_str(
            r#"[{"type":"regex","pattern":"\\b42\\b"},{"type":"command","run":"true","timeoutSec":5},{"type":"judge","criteria":"x","threshold":0.5},{"type":"contains","value":"A","ignoreCase":true}]"#,
        )
        .unwrap();
        assert!(matches!(&c[1], Check::Command { timeout_sec: Some(5), .. }));
        assert!(matches!(&c[3], Check::Contains { ignore_case: true, .. }));
        let back = serde_json::to_string(&c[1]).unwrap();
        assert_eq!(back, r#"{"type":"command","run":"true","timeoutSec":5}"#);
    }

    #[test]
    fn target_keys_and_slugs() {
        let t = Target { backend: "vibe".into(), model: Some("glm-5-3".into()), options: [("thinking".to_string(), json!("high"))].into(), label: None };
        assert_eq!(t.key(), "vibe:glm-5-3:thinking=high");
        assert_eq!(slug("Größe prüfen: Test #1"), "groesse-pruefen-test-1");
        assert!(safe_relative("src/a.py") && !safe_relative("../a") && !safe_relative("/etc/passwd"));
    }

    #[test]
    fn rejects_bad_definitions() {
        let mut b: Benchmark = serde_json::from_str(r#"{"name":"x","tasks":[{"name":"a","prompt":"p","checks":[{"type":"regex","pattern":"("}]}],"targets":[{"backend":"vibe"}]}"#).unwrap();
        assert!(b.normalize().is_err());
        let mut b: Benchmark = serde_json::from_str(r#"{"name":"x","tasks":[{"name":"a","prompt":"p","checks":[{"type":"contains","value":"y"}]}],"targets":[{"backend":"nope"}]}"#).unwrap();
        assert!(b.normalize().is_err());
    }

    #[test]
    fn observe_collects_text_and_timing() {
        with_live(|m| m.insert("t1".into(), Live { sent: Some(Instant::now()), ..Default::default() }));
        assert!(observe("t1", &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"The following MCP servers failed to connect:\n- x: y"}})));
        assert!(observe("t1", &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hallo "}})));
        assert!(observe("t1", &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Welt"}})));
        assert!(observe("t1", &json!({"sessionUpdate":"usage_update","_meta":{"promptTokens":10,"completionTokens":4}})));
        assert!(!observe("andere", &json!({"sessionUpdate":"agent_message_chunk"})));
        let (text, first, meta, notices) = with_live(|m| {
            let l = m.remove("t1").unwrap();
            (l.text, l.first, l.meta, l.notices)
        });
        assert_eq!(text, "Hallo Welt");
        assert_eq!(notices.len(), 1);
        assert!(first.is_some());
        assert_eq!(meta["completionTokens"], 4);
        let perm = json!({"options":[{"optionId":"no","kind":"reject_once"},{"optionId":"yes","kind":"allow_once"}]});
        assert!(auto_permission("t1", &perm).is_none());
    }

    #[test]
    fn copy_skips_git_and_ignored() {
        let base = std::env::temp_dir().join(format!("brise-bench-test-{}", now_ms()));
        let src = base.join("src");
        std::fs::create_dir_all(src.join(".git")).unwrap();
        std::fs::create_dir_all(src.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(src.join("lib")).unwrap();
        std::fs::write(src.join(".gitignore"), "node_modules\n").unwrap();
        std::fs::write(src.join("lib/a.txt"), "a").unwrap();
        std::fs::write(src.join(".git/HEAD"), "x").unwrap();
        std::fs::write(src.join("node_modules/x/b"), "b").unwrap();
        let dst = base.join("dst");
        copy_tree(&src, &dst).unwrap();
        assert!(dst.join("lib/a.txt").is_file() && dst.join(".gitignore").is_file());
        assert!(!dst.join(".git").exists() && !dst.join("node_modules").exists());
        let _ = std::fs::remove_dir_all(base);
    }
}
