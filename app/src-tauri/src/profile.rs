//! Brise-Konto: die eigene Identität in Brise, rein lokal und ohne zentralen
//! Server. Name, optional E-Mail, Farbe und Avatar stehen in
//! `<Datenordner>/profile.json` (keine Schlüssel). Der Name erscheint unten
//! links, in Teams, geteilten Sessions, beim Gastzugang und im Audit-Log; auf
//! Wunsch auch als Git-Autor bei Commits aus Brise.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

/// Avatar als Data-URL höchstens so groß (die Oberfläche verkleinert auf 128 px).
const MAX_AVATAR: usize = 256 * 1024;

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub name: String,
    pub email: String,
    /// Akzentfarbe des Avatars (CSS-Farbe).
    pub color: String,
    /// Bild als Data-URL (`data:image/…;base64,…`), sonst Initialen.
    pub avatar: Option<String>,
    /// Name und E-Mail als Git-Autor für Commits aus Brise.
    pub use_for_commits: bool,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    profile: Option<Profile>,
    /// „Später“ gewählt – Brise fragt beim Start nicht mehr nach.
    skipped: bool,
}

fn path() -> PathBuf {
    data_dir().join("profile.json")
}

fn load() -> Stored {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn store(s: &Stored) -> CmdResult<()> {
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    let tmp = path().with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path()).map_err(|e| e.to_string())
}

/// Das gespeicherte Konto (für andere Module, z. B. Git).
pub fn current() -> Option<Profile> {
    load().profile.filter(|p| !p.name.trim().is_empty())
}

fn git_config(key: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["config", "--global", key]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// Konto, „Später“-Status und Vorschlag aus der globalen Git-Konfiguration.
#[tauri::command]
pub fn profile_get() -> Value {
    let s = load();
    json!({
        "profile": s.profile.filter(|p| !p.name.trim().is_empty()),
        "skipped": s.skipped,
        "git": { "name": git_config("user.name"), "email": git_config("user.email") },
    })
}

fn check(p: &Profile) -> CmdResult<()> {
    if p.name.trim().is_empty() {
        return Err("Bitte einen Namen angeben.".into());
    }
    if p.name.chars().count() > 60 {
        return Err("Der Name ist zu lang (höchstens 60 Zeichen).".into());
    }
    let email = p.email.trim();
    if !email.is_empty() && (!email.contains('@') || email.contains(char::is_whitespace) || email.len() > 254) {
        return Err("Die E-Mail-Adresse sieht nicht gültig aus.".into());
    }
    if p.use_for_commits && email.is_empty() {
        return Err("Für Commits braucht es eine E-Mail-Adresse.".into());
    }
    if let Some(a) = &p.avatar {
        if !a.starts_with("data:image/") || a.len() > MAX_AVATAR {
            return Err("Der Avatar muss ein Bild unter 256 KB sein.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn profile_save(profile: Profile) -> CmdResult<Profile> {
    let mut p = profile;
    p.name = p.name.trim().to_string();
    p.email = p.email.trim().to_string();
    check(&p)?;
    let mut s = load();
    p.created_at = s.profile.as_ref().map(|o| o.created_at).filter(|t| *t > 0).unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    });
    s.profile = Some(p.clone());
    s.skipped = false;
    store(&s)?;
    Ok(p)
}

/// „Später“: weiterarbeiten ohne Konto.
#[tauri::command]
pub fn profile_skip() -> CmdResult<()> {
    let mut s = load();
    s.skipped = true;
    store(&s)
}

/// `-c user.name=… -c user.email=…` für Commits aus Brise, wenn gewünscht.
pub fn commit_identity() -> Vec<String> {
    match current() {
        Some(p) if p.use_for_commits && !p.email.is_empty() => vec!["-c".into(), format!("user.name={}", p.name), "-c".into(), format!("user.email={}", p.email)],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pruefung() {
        let ok = Profile { name: "Max".into(), ..Default::default() };
        assert!(check(&ok).is_ok());
        assert!(check(&Profile { name: " ".into(), ..Default::default() }).is_err());
        assert!(check(&Profile { email: "kein-at".into(), ..ok.clone() }).is_err());
        assert!(check(&Profile { email: "max@example.org".into(), ..ok.clone() }).is_ok());
        assert!(check(&Profile { use_for_commits: true, ..ok.clone() }).is_err());
        assert!(check(&Profile { avatar: Some("https://example.org/a.png".into()), ..ok.clone() }).is_err());
        assert!(check(&Profile { avatar: Some("data:image/png;base64,AAAA".into()), ..ok }).is_ok());
    }
}
