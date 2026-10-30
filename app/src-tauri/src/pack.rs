//! Geschützte Skill-Pakete: Die Datei liegt verschlüsselt im öffentlichen Repo
//! und in jedem Installer. Erst das Passwort entschlüsselt sie in den
//! Skills-Ordner, wo Vibe sie wie jeden anderen Skill findet.

use std::collections::BTreeMap;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::prelude::{Engine, BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::skills::skills_dir;

type CmdResult<T> = Result<T, String>;

const PACK: &str = "floorballheroes";
const ROUNDS: u32 = 600_000;

#[derive(Serialize, Deserialize)]
struct Sealed {
    salt: String,
    nonce: String,
    data: String,
}

fn cipher(password: &str, salt: &[u8]) -> Aes256Gcm {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2_pbkdf::Sha256>(password.as_bytes(), salt, ROUNDS, &mut key);
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
}

/// Dateien (Pfad → Inhalt) mit dem Passwort versiegeln.
pub fn seal(password: &str, files: &BTreeMap<String, Vec<u8>>) -> Result<String, String> {
    let (mut salt, mut nonce) = ([0u8; 16], [0u8; 12]);
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let plain: BTreeMap<&String, String> = files.iter().map(|(k, v)| (k, BASE64_STANDARD.encode(v))).collect();
    let plain = serde_json::to_vec(&plain).map_err(|e| e.to_string())?;
    let data = cipher(password, &salt).encrypt(Nonce::from_slice(&nonce), plain.as_slice()).map_err(|e| e.to_string())?;
    serde_json::to_string(&Sealed {
        salt: BASE64_STANDARD.encode(salt),
        nonce: BASE64_STANDARD.encode(nonce),
        data: BASE64_STANDARD.encode(data),
    })
    .map_err(|e| e.to_string())
}

/// `Err`, wenn das Passwort falsch ist.
pub fn open(password: &str, sealed: &str) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let wrong = || "Falsches Passwort".to_string();
    let s: Sealed = serde_json::from_str(sealed).map_err(|e| e.to_string())?;
    let decode = |v: &str| BASE64_STANDARD.decode(v).map_err(|e| e.to_string());
    let plain = cipher(password, &decode(&s.salt)?).decrypt(Nonce::from_slice(&decode(&s.nonce)?), decode(&s.data)?.as_slice()).map_err(|_| wrong())?;
    let files: BTreeMap<String, String> = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    files.into_iter().map(|(k, v)| Ok((k, decode(&v)?))).collect()
}

fn pack_file(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("packs").join(format!("{PACK}.pack")))
}

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    available: bool,
    unlocked: bool,
    dir: String,
    logo: Option<String>,
    skill: Option<String>,
}

/// Eine Änderung am Paket verlangt das Passwort erneut, sonst bliebe der alte Stand liegen.
#[tauri::command]
pub fn pack_status(app: tauri::AppHandle) -> CmdResult<PackStatus> {
    let dir = skills_dir().join(PACK);
    let sealed = std::fs::read_to_string(pack_file(&app)?).ok();
    let unlocked = sealed.as_deref().is_some_and(|s| std::fs::read_to_string(dir.join(".pack")).is_ok_and(|m| m == hash(s)));
    let logo = unlocked.then(|| std::fs::read(dir.join("logo.png")).ok()).flatten();
    Ok(PackStatus {
        available: sealed.is_some(),
        unlocked,
        dir: dir.display().to_string(),
        logo: logo.map(|b| format!("data:image/png;base64,{}", BASE64_STANDARD.encode(b))),
        skill: unlocked.then(|| std::fs::read_to_string(dir.join("SKILL.md")).ok()).flatten(),
    })
}

#[tauri::command]
pub async fn pack_unlock(app: tauri::AppHandle, password: String) -> CmdResult<PackStatus> {
    let sealed = std::fs::read_to_string(pack_file(&app)?).map_err(|e| e.to_string())?;
    let (files, marker) = tauri::async_runtime::spawn_blocking(move || open(&password, &sealed).map(|f| (f, hash(&sealed)))).await.map_err(|e| e.to_string())??;
    let dir = skills_dir().join(PACK);
    let _ = std::fs::remove_dir_all(&dir);
    for (path, content) in files {
        let target = dir.join(&path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(target, content).map_err(|e| e.to_string())?;
    }
    std::fs::write(dir.join(".pack"), marker).map_err(|e| e.to_string())?;
    pack_status(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nur_das_richtige_passwort_oeffnet_das_paket() {
        let files = BTreeMap::from([("SKILL.md".to_string(), b"geheim".to_vec())]);
        let sealed = seal("richtig", &files).unwrap();
        assert!(!sealed.contains("geheim"));
        assert_eq!(open("richtig", &sealed).unwrap(), files);
        assert_eq!(open("falsch", &sealed).unwrap_err(), "Falsches Passwort");
    }
}
