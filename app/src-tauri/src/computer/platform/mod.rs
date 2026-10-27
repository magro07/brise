//! Plattformschicht für Computer Use: Bildschirm aufnehmen, Fenster listen,
//! Eingaben schicken. Linux wählt zur Laufzeit zwischen X11 und Wayland.

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod desktop;
mod input;
#[cfg(target_os = "linux")]
mod portal;
#[cfg(target_os = "linux")]
mod x11;

use image::RgbaImage;
use serde::Serialize;

use super::keys::Key;

type CmdResult<T> = Result<T, String>;

/// Rechteck in Eingabe-Koordinaten (X11/Windows: Pixel, macOS: Punkte).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

/// Aufnahme: Bild, Lage der linken oberen Ecke in Eingabe-Koordinaten und
/// Bildpixel je Eingabe-Einheit (HiDPI unter macOS: 2).
pub struct Shot {
    pub img: RgbaImage,
    pub ox: f64,
    pub oy: f64,
    pub unit: f64,
}

impl Shot {
    fn px(&self, r: &Rect) -> (i64, i64, i64, i64) {
        let x0 = ((r.x - self.ox) * self.unit).floor() as i64;
        let y0 = ((r.y - self.oy) * self.unit).floor() as i64;
        let x1 = ((r.x + r.w - self.ox) * self.unit).ceil() as i64;
        let y1 = ((r.y + r.h - self.oy) * self.unit).ceil() as i64;
        (x0, y0, x1, y1)
    }

    /// Fläche ausgrauen (Brises eigenes Fenster).
    pub fn mask(&mut self, r: &Rect) {
        let (x0, y0, x1, y1) = self.px(r);
        super::fill(&mut self.img, x0, y0, x1, y1);
    }

    /// Ausschnitt (Fenster, Zoom); die Abbildung auf Eingabe-Koordinaten bleibt stimmig.
    pub fn crop(self, r: &Rect) -> CmdResult<Shot> {
        let (w, h) = self.img.dimensions();
        let (x0, y0, x1, y1) = self.px(r);
        let (x0, y0) = (x0.clamp(0, w as i64), y0.clamp(0, h as i64));
        let (x1, y1) = (x1.clamp(0, w as i64), y1.clamp(0, h as i64));
        if x1 - x0 < 2 || y1 - y0 < 2 {
            return Err("Der Bereich liegt außerhalb des Bildschirms.".into());
        }
        let img = image::imageops::crop_imm(&self.img, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32).to_image();
        Ok(Shot { img, ox: self.ox + x0 as f64 / self.unit, oy: self.oy + y0 as f64 / self.unit, unit: self.unit })
    }
}

#[derive(Clone, Debug)]
pub struct WinInfo {
    pub id: u64,
    pub title: String,
    pub app: String,
    pub rect: Rect,
    pub focused: bool,
    pub minimized: bool,
    /// Gehört zu Brise selbst (wird nie angeboten).
    pub brise: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Debug)]
pub enum Input {
    Move { x: f64, y: f64 },
    Click { x: f64, y: f64, button: Button, count: u8 },
    Drag { from: (f64, f64), to: (f64, f64) },
    Scroll { x: f64, y: f64, dx: i32, dy: i32 },
    Text(String),
    Keys(Vec<Key>),
}

/// Was auf diesem System geht (Einstellungen und Selbsttest – ohne etwas auszulösen).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    /// x11, wayland-portal, macos, windows, keine
    pub backend: String,
    pub screenshot: bool,
    pub screenshot_detail: String,
    pub input: bool,
    pub input_detail: String,
    pub windows: bool,
    pub notes: Vec<String>,
}

/// Wayland-Sitzung (Portal statt X11)? `BRISE_CU_BACKEND=x11|portal` erzwingt eine Seite.
pub fn wayland() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    match std::env::var("BRISE_CU_BACKEND").unwrap_or_default().as_str() {
        "x11" => false,
        "portal" | "wayland" => true,
        _ => std::env::var("WAYLAND_DISPLAY").is_ok_and(|v| !v.is_empty()) || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland"),
    }
}

pub async fn capture(monitor: Option<usize>) -> CmdResult<Shot> {
    #[cfg(target_os = "linux")]
    {
        let _ = monitor;
        if wayland() {
            return portal::capture().await;
        }
        tauri::async_runtime::spawn_blocking(x11::capture).await.map_err(|e| e.to_string())?
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        tauri::async_runtime::spawn_blocking(move || desktop::capture(monitor)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = monitor;
        Err("Computer Use gibt es auf diesem System nicht.".into())
    }
}

pub fn windows() -> CmdResult<Vec<WinInfo>> {
    #[cfg(target_os = "linux")]
    {
        if wayland() {
            return Err("Unter Wayland gibt es keine Schnittstelle für Fensterlisten. Nutze computer_screenshot und klicke das Fenster an \
                (oder computer_key mit \"super\" für die Übersicht)."
                .into());
        }
        x11::windows()
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        desktop::windows()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Err("Computer Use gibt es auf diesem System nicht.".into())
    }
}

pub fn focus(id: u64) -> CmdResult<()> {
    #[cfg(target_os = "linux")]
    {
        x11::focus(id)
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        desktop::focus(id)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = id;
        Err("Computer Use gibt es auf diesem System nicht.".into())
    }
}

pub async fn input(a: Input) -> CmdResult<()> {
    #[cfg(target_os = "linux")]
    if wayland() {
        return portal::input(a).await;
    }
    tauri::async_runtime::spawn_blocking(move || input::run(&a)).await.map_err(|e| e.to_string())?
}

/// Lässt gedrückte Tasten und Knöpfe los (Not-Aus).
pub fn release_all() {
    #[cfg(target_os = "linux")]
    if wayland() {
        tauri::async_runtime::spawn(portal::release_all());
    }
}

/// Liegt der Fokus auf einem Passwort- oder Anmeldefeld? Dann `Some(Grund)`.
pub fn password_context() -> CmdResult<Option<String>> {
    #[cfg(target_os = "linux")]
    {
        if wayland() {
            return Ok(None);
        }
        Ok(x11::active_title().and_then(|t| password_title(&t)))
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        desktop::password_context()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Ok(None)
    }
}

/// Fenstertitel, die auf eine Passwort-Abfrage hindeuten.
pub fn password_title(title: &str) -> Option<String> {
    let t = title.to_lowercase();
    const HINTS: &[&str] = &[
        "passwort", "password", "kennwort", "passphrase", "keepass", "1password", "bitwarden", "authentifizierung", "authentication required", "polkit",
        "schlüsselbund", "keychain", "keyring", "sudo",
    ];
    let words: Vec<&str> = t.split(|c: char| !c.is_alphanumeric()).collect();
    (HINTS.iter().any(|h| t.contains(h)) || words.contains(&"pin")).then(|| format!("Das aktive Fenster „{title}“ sieht nach einer Passwort-Abfrage aus."))
}

pub fn open_app(name: &str) -> CmdResult<()> {
    use std::process::{Command, Stdio};
    let name = name.trim();
    if name.is_empty() {
        return Err("name fehlt".into());
    }
    let spawn = |cmd: &mut Command| cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string());
    #[cfg(target_os = "macos")]
    {
        let ok = Command::new("open").args(["-a", name]).status().map_err(|e| e.to_string())?.success();
        return if ok { Ok(()) } else { Err(format!("Programm „{name}“ nicht gefunden.")) };
    }
    #[cfg(target_os = "windows")]
    {
        return spawn(Command::new("cmd").args(["/C", "start", "", name]));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(id) = desktop_entry(name) {
            if which("gtk-launch") {
                return spawn(Command::new("gtk-launch").arg(&id));
            }
            if which("gio") {
                return spawn(Command::new("gio").args(["launch", &format!("{id}.desktop")]));
            }
        }
        if which(name) {
            return spawn(&mut Command::new(name));
        }
        Err(format!("Programm „{name}“ nicht gefunden."))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = spawn;
        Err("Computer Use gibt es auf diesem System nicht.".into())
    }
}

#[cfg(target_os = "linux")]
fn which(cmd: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()))
}

/// `.desktop`-Datei zu einem Programmnamen („Firefox“, „Rechner“, „org.gnome.TextEditor“).
#[cfg(target_os = "linux")]
fn desktop_entry(name: &str) -> Option<String> {
    let mut dirs: Vec<std::path::PathBuf> = vec![dirs::data_dir().unwrap_or_default().join("applications")];
    let data = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    dirs.extend(data.split(':').filter(|d| !d.is_empty()).map(|d| std::path::Path::new(d).join("applications")));
    dirs.push("/var/lib/flatpak/exports/share/applications".into());
    let want = name.to_lowercase();
    let mut fuzzy = None;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()).filter(|_| path.extension().is_some_and(|x| x == "desktop")) else { continue };
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if text.lines().any(|l| l.trim() == "NoDisplay=true") {
                continue;
            }
            let names: Vec<String> = text
                .lines()
                .take_while(|l| !l.starts_with("[Desktop Action"))
                .filter_map(|l| l.strip_prefix("Name").and_then(|r| r.split_once('=')).map(|(_, v)| v.trim().to_lowercase()))
                .collect();
            let s = stem.to_lowercase();
            if s == want || s.rsplit('.').next() == Some(want.as_str()) || names.iter().any(|n| *n == want) {
                return Some(stem.to_string());
            }
            if fuzzy.is_none() && names.iter().any(|n| n.contains(&want)) {
                fuzzy = Some(stem.to_string());
            }
        }
    }
    fuzzy
}

pub async fn capabilities() -> Caps {
    #[cfg(target_os = "linux")]
    {
        if wayland() {
            return portal::capabilities().await;
        }
        x11::capabilities()
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        desktop::capabilities()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Caps { backend: "keine".into(), ..Default::default() }
    }
}

pub fn request_access() -> CmdResult<String> {
    #[cfg(target_os = "macos")]
    {
        desktop::request_access()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("Auf diesem System sind keine zusätzlichen Rechte nötig.".into())
    }
}

pub async fn prepare() -> CmdResult<String> {
    #[cfg(target_os = "linux")]
    if wayland() {
        return portal::prepare().await;
    }
    Ok("Keine Vorbereitung nötig.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_titles() {
        assert!(password_title("Authentifizierung erforderlich").is_some());
        assert!(password_title("KeePassXC – Datenbank").is_some());
        assert!(password_title("PIN eingeben").is_some());
        assert!(password_title("Spinning Wheel – Editor").is_none());
        assert!(password_title("Brise-Test").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn backend_override() {
        // Nur lesen – Umgebungsvariablen nicht verändern (Tests laufen parallel).
        let forced = std::env::var("BRISE_CU_BACKEND").unwrap_or_default();
        if forced == "x11" {
            assert!(!wayland());
        }
    }
}
