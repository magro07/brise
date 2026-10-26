//! Agent-Backends: welche ACP-Agenten Brise kennt, wie man sie findet,
//! installiert und ihre Anmeldung prüft. Welche Brise-Erweiterungen ein
//! Backend kann, steht in seinen Capabilities – die Oberfläche blendet alles
//! andere aus. Siehe docs/adr/0001-agent-backends.md.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::installer::{data_dir, Progress};

type CmdResult<T> = Result<T, String>;

pub const DEFAULT_BACKEND: &str = "vibe";

/// Was ein Backend über Standard-ACP hinaus kann.
#[derive(Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    /// `_auth/*`, `_config/schema`, `_session/delete` (Vibe-Erweiterungen)
    pub vibe_extensions: bool,
    /// `_voice/*`: Spracheingabe und Vorlesen
    pub voice: bool,
    /// Einstellungen aus einem JSON-Schema des Agenten
    pub settings_schema: bool,
    /// Brises mitgelieferte Skills landen in den Skill-Pfaden des Agenten
    pub skills: bool,
    /// Modelle lassen sich in der Konfiguration des Agenten verwalten
    pub models: bool,
    /// Brises Auto-Modellwahl und Denkstufen-Steuerung passen zu den Optionen
    pub auto_model: bool,
}

/// Wie der Agent gestartet wird.
#[derive(Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Von Brise in den Datenordner installiert.
    pub managed: bool,
}

impl Launch {
    pub fn display(&self) -> String {
        std::iter::once(self.program.display().to_string()).chain(self.args.iter().cloned()).collect::<Vec<_>>().join(" ")
    }
}

/// Ein ACP-Agent, den Brise starten kann.
pub trait Backend: Send + Sync {
    fn id(&self) -> &'static str;
    fn title(&self) -> &'static str;
    /// Kurzbeschreibung für die Einstellungen.
    fn description(&self) -> &'static str;
    fn caps(&self) -> Caps;
    fn locate(&self) -> Option<Launch>;
    /// Fehlt etwas für die Installation (z. B. Node.js)? `None` = installierbar.
    fn install_blocker(&self) -> Option<String>;
    /// Anmeldestatus ohne laufende Verbindung (blockierend, kurz). `None` = unbekannt.
    fn probe_auth(&self) -> Option<Value> {
        None
    }
    /// Befehlszeile für die Anmeldung im eingebauten Terminal.
    fn login_command(&self) -> Option<String> {
        None
    }
    /// Hinweis, wie man sich anmeldet, falls es keinen Befehl gibt.
    fn login_hint(&self) -> Option<&'static str> {
        None
    }
}

// ---------- Mistral Vibe ----------

struct Vibe;

impl Backend for Vibe {
    fn id(&self) -> &'static str {
        "vibe"
    }
    fn title(&self) -> &'static str {
        "Mistral Vibe"
    }
    fn description(&self) -> &'static str {
        "Coding-Agent von Mistral. Mistral-Konto oder API-Key; Sprache, Skills, Modelle und Auto-Modellwahl."
    }
    fn caps(&self) -> Caps {
        Caps { vibe_extensions: true, voice: true, settings_schema: true, skills: true, models: true, auto_model: true }
    }
    fn locate(&self) -> Option<Launch> {
        let path = crate::agent::find_vibe_acp()?;
        let managed = path.starts_with(crate::installer::managed_bin_dir());
        Some(Launch { program: path, args: vec![], managed })
    }
    fn install_blocker(&self) -> Option<String> {
        None
    }
}

// ---------- Node-basierte ACP-Agenten (Claude Code, Codex, Gemini) ----------

struct NodeAgent {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    /// npm-Paket, das Brise installiert
    package: &'static str,
    /// Programmnamen im PATH, neuester zuerst
    path_bins: &'static [&'static str],
    args: &'static [&'static str],
    min_node: u32,
    /// Dateien, deren Existenz eine Anmeldung anzeigt (relativ zum Home-Ordner)
    auth_files: &'static [&'static str],
    /// Umgebungsvariablen, deren Existenz eine Anmeldung anzeigt
    auth_env: &'static [&'static str],
    login_hint: &'static str,
}

const CLAUDE: NodeAgent = NodeAgent {
    id: "claude",
    title: "Claude Code",
    description: "Claude Code über den offiziellen ACP-Adapter. Nutzt die Claude-Code-Anmeldung (Claude Pro/Max oder Anthropic Console).",
    package: "@agentclientprotocol/claude-agent-acp",
    path_bins: &["claude-agent-acp", "claude-code-acp"],
    args: &[],
    min_node: 22,
    auth_files: &[],
    auth_env: &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    login_hint: "Anmeldung über Claude Code (Claude Pro/Max im Browser)",
};

const CODEX: NodeAgent = NodeAgent {
    id: "codex",
    title: "OpenAI Codex",
    description: "Codex CLI über den ACP-Adapter. Nutzt das ChatGPT-Konto oder einen OpenAI-API-Key aus `codex login`.",
    package: "@agentclientprotocol/codex-acp",
    path_bins: &["codex-acp"],
    args: &[],
    min_node: 20,
    auth_files: &[".codex/auth.json"],
    auth_env: &["OPENAI_API_KEY", "CODEX_API_KEY"],
    login_hint: "Im Terminal `codex login` ausführen (ChatGPT-Konto) oder OPENAI_API_KEY setzen.",
};

const GEMINI: NodeAgent = NodeAgent {
    id: "gemini",
    title: "Gemini CLI",
    description: "Googles Gemini CLI im ACP-Modus (`gemini --acp`). Google-Konto oder Gemini-API-Key.",
    package: "@google/gemini-cli",
    path_bins: &["gemini"],
    args: &["--acp"],
    min_node: 20,
    auth_files: &[".gemini/oauth_creds.json"],
    auth_env: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    login_hint: "Einmal `gemini` im Terminal starten und die Anmeldung wählen, oder GEMINI_API_KEY setzen.",
};

fn in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) { vec![format!("{name}.cmd"), format!("{name}.exe")] } else { vec![name.to_string()] };
    std::env::split_paths(&paths).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

pub fn find_node() -> Option<PathBuf> {
    in_path("node").or_else(|| {
        let exe = if cfg!(windows) { "node.exe" } else { "node" };
        let home = dirs::home_dir()?;
        [home.join(".local/bin").join(exe), PathBuf::from("/opt/homebrew/bin").join(exe), PathBuf::from("/usr/local/bin").join(exe)]
            .into_iter()
            .find(|p| p.is_file())
    })
}

fn find_npm() -> Option<PathBuf> {
    in_path("npm")
}

/// Hauptversion von Node.js, z. B. 22.
fn node_major(node: &Path) -> Option<u32> {
    let out = std::process::Command::new(node).arg("--version").stdin(Stdio::null()).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Ordner, in den Brise ein Backend installiert.
fn managed_dir(id: &str) -> PathBuf {
    data_dir().join("backends").join(id)
}

impl NodeAgent {
    /// Einstiegsskript des installierten Pakets laut `package.json` (`bin`).
    fn managed_entry(&self) -> Option<PathBuf> {
        let pkg = managed_dir(self.id).join("node_modules").join(self.package);
        let manifest: Value = serde_json::from_slice(&std::fs::read(pkg.join("package.json")).ok()?).ok()?;
        let rel = match &manifest["bin"] {
            Value::String(s) => s.clone(),
            Value::Object(map) => map.values().next()?.as_str()?.to_string(),
            _ => return None,
        };
        Some(pkg.join(rel)).filter(|p| p.is_file())
    }

    fn launch_with(&self, extra: &[&str]) -> Option<Launch> {
        let mut launch = self.locate_inner()?;
        launch.args.extend(extra.iter().map(|s| s.to_string()));
        Some(launch)
    }

    fn locate_inner(&self) -> Option<Launch> {
        let args: Vec<String> = self.args.iter().map(|s| s.to_string()).collect();
        if let Some(p) = self.path_bins.iter().find_map(|b| in_path(b)) {
            return Some(Launch { program: p, args, managed: false });
        }
        let entry = self.managed_entry()?;
        let node = find_node()?;
        Some(Launch { program: node, args: std::iter::once(entry.display().to_string()).chain(args).collect(), managed: true })
    }

    /// Umgebungsvariablen und `~/.claude/settings.json` (`env`) nach Token-Namen
    /// durchsuchen. Werte werden nie gelesen oder weitergegeben.
    fn env_auth(&self) -> Option<String> {
        if let Some(name) = self.auth_env.iter().find(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty())) {
            return Some(format!("Umgebungsvariable {name}"));
        }
        if self.id == "claude" {
            let settings: Value = serde_json::from_slice(&std::fs::read(dirs::home_dir()?.join(".claude/settings.json")).ok()?).ok()?;
            let env = settings.get("env")?.as_object()?;
            if self.auth_env.iter().any(|k| env.get(*k).and_then(Value::as_str).is_some_and(|v| !v.is_empty())) {
                let host = env
                    .get("ANTHROPIC_BASE_URL")
                    .and_then(Value::as_str)
                    .and_then(|u| u.split("://").nth(1))
                    .map(|h| h.split('/').next().unwrap_or(h).to_string());
                return Some(match host {
                    Some(h) => format!("Gateway {h} (~/.claude/settings.json)"),
                    None => "Schlüssel in ~/.claude/settings.json".into(),
                });
            }
        }
        None
    }
}

impl Backend for NodeAgent {
    fn id(&self) -> &'static str {
        self.id
    }
    fn title(&self) -> &'static str {
        self.title
    }
    fn description(&self) -> &'static str {
        self.description
    }
    fn caps(&self) -> Caps {
        Caps::default()
    }
    fn locate(&self) -> Option<Launch> {
        self.locate_inner()
    }
    fn install_blocker(&self) -> Option<String> {
        let Some(node) = find_node() else {
            return Some(format!("Node.js {} oder neuer fehlt (nodejs.org)", self.min_node));
        };
        match node_major(&node) {
            Some(v) if v < self.min_node => Some(format!("Node.js {v} ist zu alt, nötig ist {} oder neuer", self.min_node)),
            _ if find_npm().is_none() => Some("npm fehlt (gehört zu Node.js)".into()),
            _ => None,
        }
    }

    fn probe_auth(&self) -> Option<Value> {
        if self.id == "claude" {
            // Der Adapter bringt die Claude-Code-CLI mit: `--cli auth status --json`.
            if let Some(launch) = self.launch_with(&["--cli", "auth", "status", "--json"]) {
                if let Some(v) = run_json(&launch, Duration::from_secs(8)) {
                    if v["loggedIn"].as_bool() == Some(true) {
                        let plan = v["subscriptionType"].as_str().map(|s| format!("Claude {}", capitalize(s)));
                        let method = match v["authMethod"].as_str() {
                            Some("claude.ai") => "Claude-Konto",
                            Some("oauth_token") => "OAuth-Token",
                            Some("api_key") => "API-Key",
                            Some(other) => other,
                            None => "angemeldet",
                        };
                        // Kommt die Anmeldung aus Variablen bzw. settings.json, prüft die
                        // CLI den Token nicht – erst der erste Prompt zeigt, ob er gilt.
                        let source = self.env_auth();
                        return Some(json!({
                            "authenticated": true,
                            "label": plan.unwrap_or_else(|| method.to_string()),
                            "unverified": source.is_some(),
                            "detail": source.or_else(|| v["email"].as_str().map(str::to_string)),
                        }));
                    }
                }
            }
        }
        if let Some(source) = self.env_auth() {
            return Some(json!({ "authenticated": true, "label": "Schlüssel vorhanden", "unverified": true, "detail": source }));
        }
        let home = dirs::home_dir()?;
        if let Some(f) = self.auth_files.iter().find(|f| home.join(f).is_file()) {
            return Some(json!({ "authenticated": true, "label": "angemeldet", "detail": format!("~/{f}") }));
        }
        Some(json!({ "authenticated": false, "label": "nicht angemeldet" }))
    }

    fn login_command(&self) -> Option<String> {
        if self.id != "claude" {
            return None;
        }
        let launch = self.launch_with(&["--cli", "auth", "login", "--claudeai"])?;
        Some(std::iter::once(&launch.program.display().to_string()).chain(launch.args.iter()).map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "))
    }

    fn login_hint(&self) -> Option<&'static str> {
        Some(self.login_hint)
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-:=@".contains(c)) {
        s.to_string()
    } else if cfg!(windows) {
        format!("\"{s}\"")
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Startet ein Programm, wartet höchstens `timeout` und liest JSON von stdout.
fn run_json(launch: &Launch, timeout: Duration) -> Option<Value> {
    let mut cmd = std::process::Command::new(&launch.program);
    cmd.args(&launch.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    serde_json::from_str(out.trim()).ok()
}

// ---------- Registry ----------

static VIBE: Vibe = Vibe;

pub fn all() -> [&'static dyn Backend; 4] {
    [&VIBE, &CLAUDE, &CODEX, &GEMINI]
}

pub fn get(id: &str) -> Option<&'static dyn Backend> {
    all().into_iter().find(|b| b.id() == id)
}

pub fn caps(id: &str) -> Caps {
    get(id).map(|b| b.caps()).unwrap_or_default()
}

// ---------- Installation ----------

/// Installiert einen Node-Adapter mit npm in Brises Datenordner.
pub async fn install_node_agent(id: &str, progress: &Progress) -> CmdResult<String> {
    let agent = [&CLAUDE, &CODEX, &GEMINI].into_iter().find(|a| a.id == id).ok_or_else(|| format!("Unbekanntes Backend: {id}"))?;
    if let Some(blocker) = agent.install_blocker() {
        return Err(blocker);
    }
    let npm = find_npm().ok_or("npm fehlt")?;
    let dir = managed_dir(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    progress("npm", format!("npm install {}@latest …", agent.package));
    let mut cmd = tokio::process::Command::new(&npm);
    cmd.args(["install", "--prefix"])
        .arg(&dir)
        .args(["--no-fund", "--no-audit", "--omit=dev", &format!("{}@latest", agent.package)])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("npm konnte nicht starten: {e}"))?;
    let mut tasks = Vec::new();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)].into_iter().flatten() {
        let progress = progress.clone();
        tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                progress("npm", line);
            }
        }));
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    for t in tasks {
        let _ = t.await;
    }
    if !status.success() {
        return Err(format!("npm install ist fehlgeschlagen ({status})"));
    }
    let launch = agent.locate().ok_or("Installiert, aber das Programm wurde nicht gefunden")?;
    progress("npm", format!("Fertig: {}", launch.display()));
    Ok(launch.display())
}

// ---------- Commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    caps: Caps,
    installed: bool,
    managed: bool,
    command: Option<String>,
    install_blocker: Option<String>,
    login_available: bool,
    login_hint: Option<&'static str>,
}

/// Alle bekannten Backends mit Installationsstand (ohne Anmeldung, das dauert länger).
#[tauri::command]
pub async fn backends_list() -> CmdResult<Vec<BackendInfo>> {
    tokio::task::spawn_blocking(|| {
        all()
            .into_iter()
            .map(|b| {
                let launch = b.locate();
                BackendInfo {
                    id: b.id(),
                    title: b.title(),
                    description: b.description(),
                    caps: b.caps(),
                    installed: launch.is_some(),
                    managed: launch.as_ref().is_some_and(|l| l.managed),
                    command: launch.as_ref().map(Launch::display),
                    install_blocker: if launch.is_some() { None } else { b.install_blocker() },
                    login_available: b.login_command().is_some(),
                    login_hint: b.login_hint(),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Anmeldestatus eines nicht über `_auth/status` erreichbaren Backends.
#[tauri::command]
pub async fn backend_auth(backend: String) -> CmdResult<Value> {
    let b = get(&backend).ok_or("Unbekanntes Backend")?;
    tokio::task::spawn_blocking(move || b.probe_auth().unwrap_or(Value::Null)).await.map_err(|e| e.to_string())
}

/// Befehl für die Anmeldung im eingebauten Terminal.
#[tauri::command]
pub fn backend_login_command(backend: String) -> Option<String> {
    get(&backend)?.login_command()
}

#[tauri::command]
pub async fn install_backend(app: AppHandle, backend: String) -> CmdResult<String> {
    crate::policy::check_section("backends")?;
    crate::policy::check_backend(&backend)?;
    if backend == "vibe" {
        return crate::installer::install_vibe(app).await;
    }
    let app2 = app.clone();
    let progress: Progress = Arc::new(move |stage: &str, line: String| {
        let _ = app2.emit("install:progress", json!({ "stage": stage, "line": line }));
    });
    install_node_agent(&backend, &progress).await
}
