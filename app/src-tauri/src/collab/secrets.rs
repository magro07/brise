//! Dauerhafte Kollaborations-Daten: eigene Identität und Team-Schlüssel.
//!
//! Liegen im Schlüsselbund (Dienst `dev.brise.app`), ersatzweise in
//! `<Datenordner>/collab.json` mit Rechten nur für den Nutzer. Das Konto hängt
//! vom Datenordner ab, damit getrennte Instanzen (Tests) getrennte Identitäten haben.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SERVICE: &str = "dev.brise.app";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSecret {
    pub id: String,
    pub name: String,
    pub relay: String,
    pub key: String,
    /// Ed25519-ID des Besitzers (aus dem Einladungslink). Fehlt bei alten Teams.
    #[serde(default)]
    pub owner: Option<String>,
    /// Gemeinsame Projektliste (zuletzt bekannter Stand).
    #[serde(default)]
    pub projects: serde_json::Value,
    #[serde(default)]
    pub projects_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Secrets {
    /// Ed25519-Seed der eigenen Identität (base64url).
    pub seed: Option<String>,
    #[serde(default)]
    pub teams: Vec<TeamSecret>,
}

fn file() -> PathBuf {
    crate::installer::data_dir().join("collab.json")
}

fn entry() -> Option<keyring::Entry> {
    let hash = Sha256::digest(crate::installer::data_dir().to_string_lossy().as_bytes());
    let account = format!("collab-{}", super::crypto::b64(&hash[..6]));
    keyring::Entry::new(SERVICE, &account).ok()
}

pub fn load() -> Secrets {
    if let Some(text) = entry().and_then(|e| e.get_password().ok()) {
        if let Ok(s) = serde_json::from_str(&text) {
            return s;
        }
    }
    std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(secrets: &Secrets) {
    let Ok(text) = serde_json::to_string(secrets) else { return };
    if entry().is_some_and(|e| e.set_password(&text).is_ok()) {
        let _ = std::fs::remove_file(file());
        return;
    }
    let path = file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&path, text).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}
