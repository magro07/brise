//! Der Mistral-Schlüssel (Vibe-Key oder API-Key). Gespeichert wird dort, wo
//! Vibe selbst ihn ablegt: im Schlüsselbund unter Dienst `ai.mistral.vibe`,
//! Konto `MISTRAL_API_KEY` – ersatzweise in `$VIBE_HOME/.env`. So teilen sich
//! Brise, die Vibe-CLI und die VS-Code-Erweiterung denselben Zugang.

use std::path::PathBuf;

use serde::Serialize;

use crate::config::vibe_home;

const SERVICE: &str = "ai.mistral.vibe";
const ACCOUNT: &str = "MISTRAL_API_KEY";
pub const API_BASE: &str = "https://api.mistral.ai/v1";

type CmdResult<T> = Result<T, String>;

fn entry() -> keyring::Result<keyring::Entry> {
    // Pythons Windows-Backend nutzt den Dienstnamen als Ziel; daran halten wir uns.
    if cfg!(windows) {
        keyring::Entry::new_with_target(SERVICE, SERVICE, ACCOUNT)
    } else {
        keyring::Entry::new(SERVICE, ACCOUNT)
    }
}

fn env_file() -> Option<PathBuf> {
    vibe_home().map(|h| h.join(".env"))
}

fn read_env_file() -> Option<String> {
    let text = std::fs::read_to_string(env_file()?).ok()?;
    text.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        (k.trim() == ACCOUNT).then(|| v.trim().trim_matches(['"', '\'']).to_string())
    })
}

/// Reihenfolge wie bei Vibe: Umgebung, `.env`, Schlüsselbund.
pub fn read_key() -> Option<String> {
    if let Ok(k) = std::env::var(ACCOUNT) {
        if !k.is_empty() {
            return Some(k);
        }
    }
    if let Some(k) = read_env_file().filter(|k| !k.is_empty()) {
        return Some(k);
    }
    entry().ok()?.get_password().ok().filter(|k| !k.is_empty())
}

fn write_env_file(key: &str) -> CmdResult<()> {
    let path = env_file().ok_or("Kein Home-Verzeichnis gefunden")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().filter(|l| !l.trim_start().starts_with(&format!("{ACCOUNT}="))).map(str::to_string).collect();
    lines.push(format!("{ACCOUNT}={key}"));
    std::fs::write(&path, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    valid: bool,
    message: String,
    models: usize,
}

/// Prüft einen Schlüssel gegen die Mistral-API, ohne ihn zu speichern.
async fn check(key: &str) -> CmdResult<KeyCheck> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/models"))
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Mistral nicht erreichbar: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        let models = body["data"].as_array().map_or(0, Vec::len);
        return Ok(KeyCheck { valid: true, message: "Schlüssel gültig".into(), models });
    }
    let message = match status.as_u16() {
        401 => "Mistral kennt diesen Schlüssel nicht. Bitte prüfen, ob er vollständig kopiert wurde.".to_string(),
        403 => "Der Schlüssel ist gültig, hat aber keinen Zugriff. Prüfe deinen Plan oder die Workspace-Rechte.".to_string(),
        429 => "Zu viele Anfragen – bitte kurz warten.".to_string(),
        code => format!("Mistral antwortete mit Status {code}."),
    };
    Ok(KeyCheck { valid: false, message, models: 0 })
}

/// Prüft und speichert einen eingefügten Schlüssel.
#[tauri::command]
pub async fn save_api_key(key: String) -> CmdResult<KeyCheck> {
    let key = key.trim().to_string();
    if key.len() < 16 || key.contains(char::is_whitespace) {
        return Ok(KeyCheck { valid: false, message: "Das sieht nicht nach einem Mistral-Schlüssel aus.".into(), models: 0 });
    }
    let result = check(&key).await?;
    if !result.valid {
        return Ok(result);
    }
    match entry().and_then(|e| e.set_password(&key)) {
        Ok(()) => {
            // Wie Vibe: eine alte Klartext-Kopie entfernen, wenn der Schlüsselbund geht.
            if let Some(path) = env_file() {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    let kept: Vec<&str> = text.lines().filter(|l| !l.trim_start().starts_with(&format!("{ACCOUNT}="))).collect();
                    let _ = std::fs::write(&path, kept.join("\n") + if kept.is_empty() { "" } else { "\n" });
                }
            }
        }
        Err(_) => write_env_file(&key)?,
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    present: bool,
    /// Nur Anfang und Ende, nie der ganze Schlüssel.
    hint: Option<String>,
}

#[tauri::command]
pub fn api_key_info() -> KeyInfo {
    let key = read_key();
    KeyInfo {
        present: key.is_some(),
        hint: key.map(|k| {
            let chars: Vec<char> = k.chars().collect();
            let start: String = chars.iter().take(4).collect();
            let end: String = chars.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            format!("{start}…{end}")
        }),
    }
}
