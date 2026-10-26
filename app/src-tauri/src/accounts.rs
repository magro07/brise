//! Mehrere Mistral-Schlüssel mit Namen (siehe docs/adr/0002-mehrere-schluessel.md).
//!
//! Der Standard-Account ist der bisherige Eintrag `MISTRAL_API_KEY`, den sich
//! Brise mit Vibe-CLI und Abo-Login teilt. Jeder weitere Schlüssel liegt im
//! Schlüsselbund unter Vibes Dienstnamen, Konto `BRISE_KEY_<id>`. Für einen
//! solchen Account startet Brise einen eigenen `vibe-acp` und biegt per
//! `VIBE_PROVIDERS` nur den *Namen* der Schlüsselvariable um – Vibe liest den
//! Schlüssel dann selbst aus dem Schlüsselbund. So steht er nie in einer
//! Umgebung, die Shell-Befehle des Modells erben würden.
//!
//! In `accounts.json` stehen nur Namen und Zuordnungen, nie Schlüssel. Eine
//! Session bleibt bei dem Account, mit dem sie begonnen hat.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::credentials::{self, API_BASE};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

pub const STANDARD: &str = "standard";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Le-Chat-/Vibe-Abo einer Person.
    #[default]
    Abo,
    /// Team-, Firmen- oder Kunden-Workspace.
    Team,
    /// API-Key mit Guthaben (bezahlte Mehrnutzung).
    Payg,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: String,
    name: String,
    kind: Kind,
    /// Darf einspringen, wenn eine Session am Limit ist. Nur für Pay-as-you-go.
    reserve: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    standard_name: Option<String>,
    standard_kind: Kind,
    accounts: Vec<Account>,
    /// Account für neue Sessions, wenn das Projekt keinen eigenen hat.
    default: Option<String>,
    projects: BTreeMap<String, String>,
    sessions: BTreeMap<String, String>,
    /// Bei Limit ohne Rückfrage auf die Reserve wechseln.
    auto_switch: bool,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    data_dir().join("accounts.json")
}

fn load() -> Store {
    std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(store: &Store) -> CmdResult<()> {
    let path = path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Liest, ändert und schreibt `accounts.json` unter einer Sperre.
fn update<T>(f: impl FnOnce(&mut Store) -> CmdResult<T>) -> CmdResult<T> {
    let _guard = LOCK.lock().unwrap();
    let mut store = load();
    let out = f(&mut store)?;
    save(&store)?;
    Ok(out)
}

fn key_account(id: &str) -> String {
    format!("BRISE_KEY_{id}")
}

fn read_key(id: &str) -> Option<String> {
    if id == STANDARD {
        return credentials::read_key();
    }
    credentials::entry_for(&key_account(id)).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

fn exists(store: &Store, id: &str) -> bool {
    id == STANDARD || store.accounts.iter().any(|a| a.id == id)
}

/// Account für eine neue Session in `cwd`.
pub fn for_project(cwd: &str) -> String {
    let store = load();
    store
        .projects
        .get(cwd)
        .or(store.default.as_ref())
        .filter(|id| exists(&store, id))
        .cloned()
        .unwrap_or_else(|| STANDARD.to_string())
}

/// Account einer bekannten Session; unbekannte und alte Sessions laufen über den Standard.
pub fn for_session(session_id: &str) -> Option<String> {
    let store = load();
    store.sessions.get(session_id).filter(|id| exists(&store, id)).cloned()
}

pub fn bind_session(session_id: &str, account: &str) {
    let _ = update(|s| {
        s.sessions.insert(session_id.to_string(), account.to_string());
        Ok(())
    });
}

pub fn forget_session(session_id: &str) {
    let _ = update(|s| {
        s.sessions.remove(session_id);
        Ok(())
    });
}

pub fn name(id: &str) -> String {
    let store = load();
    if id == STANDARD {
        return store.standard_name.unwrap_or_else(|| "Standard".into());
    }
    store.accounts.iter().find(|a| a.id == id).map_or_else(|| id.to_string(), |a| a.name.clone())
}

/// Erster Reserve-Schlüssel außer `current`, der im Schlüsselbund liegt.
pub fn reserve_for(current: &str) -> Option<String> {
    load()
        .accounts
        .into_iter()
        .find(|a| a.reserve && a.kind == Kind::Payg && a.id != current && read_key(&a.id).is_some())
        .map(|a| a.id)
}

pub fn auto_switch() -> bool {
    load().auto_switch
}

/// Umgebung für einen `vibe-acp` dieses Accounts: der Mistral-Provider mit
/// eigenem Variablennamen, Vibe sucht den Schlüssel dann im Schlüsselbund.
/// Enthält keinen Schlüssel.
pub fn agent_env(id: &str) -> CmdResult<Vec<(String, String)>> {
    if id == STANDARD {
        return Ok(Vec::new());
    }
    if read_key(id).is_none() {
        return Err(format!("Für „{}“ liegt kein Schlüssel im Schlüsselbund.", name(id)));
    }
    // Eigene Provider-Einstellungen aus config.toml übernehmen, nur die Variable tauschen.
    let configured = crate::config::read_config()
        .ok()
        .and_then(|c| serde_json::to_value(c).ok())
        .and_then(|c| c["values"]["providers"].as_array().cloned())
        .and_then(|list| list.into_iter().find(|p| p["name"] == "mistral"));
    let mut provider = json!({ "name": "mistral", "api_base": API_BASE, "backend": "mistral" });
    if let Some(Value::Object(fields)) = configured {
        for (k, v) in fields {
            provider[k] = v;
        }
    }
    provider["api_key_env_var"] = json!(key_account(id));
    Ok(vec![("VIBE_PROVIDERS".into(), json!([provider]).to_string())])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    id: String,
    name: String,
    kind: Kind,
    reserve: bool,
    standard: bool,
    present: bool,
    /// Nur Anfang und Ende, nie der ganze Schlüssel.
    hint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    accounts: Vec<AccountView>,
    default: String,
    projects: BTreeMap<String, String>,
    auto_switch: bool,
}

#[tauri::command]
pub fn list_accounts() -> Accounts {
    let store = load();
    let view = |id: &str, name: String, kind: Kind, reserve: bool| {
        let key = read_key(id);
        AccountView {
            id: id.to_string(),
            name,
            kind,
            reserve,
            standard: id == STANDARD,
            present: key.is_some(),
            hint: key.as_deref().map(credentials::hint),
        }
    };
    let mut accounts = vec![view(
        STANDARD,
        store.standard_name.clone().unwrap_or_else(|| "Standard".into()),
        store.standard_kind,
        false,
    )];
    accounts.extend(store.accounts.iter().map(|a| view(&a.id, a.name.clone(), a.kind, a.reserve)));
    Accounts {
        accounts,
        default: store.default.clone().filter(|d| exists(&store, d)).unwrap_or_else(|| STANDARD.into()),
        projects: store.projects.clone(),
        auto_switch: store.auto_switch,
    }
}

fn clean_name(name: &str) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("Bitte einen Namen mit 1 bis 40 Zeichen angeben.".into());
    }
    Ok(name.to_string())
}

/// Prüft den Schlüssel gegen Mistral und legt ihn im Schlüsselbund ab.
#[tauri::command]
pub async fn add_account(name: String, kind: Kind, key: String, reserve: bool) -> CmdResult<AccountView> {
    crate::policy::check_section("account")?;
    let name = clean_name(&name)?;
    let key = key.trim().to_string();
    if key.len() < 16 || key.contains(char::is_whitespace) {
        return Err("Das sieht nicht nach einem Mistral-Schlüssel aus.".into());
    }
    let store = load();
    let known = std::iter::once(STANDARD.to_string()).chain(store.accounts.iter().map(|a| a.id.clone()));
    if let Some(id) = known.into_iter().find(|id| read_key(id).as_deref() == Some(key.as_str())) {
        return Err(format!("Dieser Schlüssel ist schon als „{}“ eingetragen.", self::name(&id)));
    }
    let check = credentials::check(&key).await?;
    if !check.valid {
        return Err(check.message);
    }
    let id = format!(
        "{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis())
    );
    credentials::entry_for(&key_account(&id))
        .and_then(|e| e.set_password(&key))
        .map_err(|e| format!("Schlüsselbund nicht verfügbar ({e}). Weitere Schlüssel speichert Brise nur dort."))?;
    let reserve = reserve && kind == Kind::Payg;
    update(|s| {
        s.accounts.push(Account { id: id.clone(), name: name.clone(), kind, reserve });
        Ok(())
    })?;
    Ok(AccountView { id, name, kind, reserve, standard: false, present: true, hint: Some(credentials::hint(&key)) })
}

#[tauri::command]
pub fn update_account(id: String, name: Option<String>, kind: Option<Kind>, reserve: Option<bool>) -> CmdResult<()> {
    crate::policy::check_section("account")?;
    let name = name.as_deref().map(clean_name).transpose()?;
    update(|s| {
        if id == STANDARD {
            if let Some(n) = name {
                s.standard_name = Some(n);
            }
            if let Some(k) = kind {
                s.standard_kind = k;
            }
            return Ok(());
        }
        let a = s.accounts.iter_mut().find(|a| a.id == id).ok_or("Unbekannter Account")?;
        if let Some(n) = name {
            a.name = n;
        }
        if let Some(k) = kind {
            a.kind = k;
        }
        if let Some(r) = reserve {
            a.reserve = r;
        }
        a.reserve &= a.kind == Kind::Payg;
        Ok(())
    })
}

/// Entfernt Account und Schlüsselbund-Eintrag. Seine Sessions laufen danach über den Standard.
#[tauri::command]
pub async fn remove_account(state: State<'_, crate::agent::AgentState>, id: String) -> CmdResult<()> {
    crate::policy::check_section("account")?;
    if id == STANDARD {
        return Err("Der Standard-Account lässt sich hier nicht entfernen.".into());
    }
    crate::agent::stop_account(&state, &id).await;
    if let Ok(entry) = credentials::entry_for(&key_account(&id)) {
        let _ = entry.delete_credential();
    }
    update(|s| {
        s.accounts.retain(|a| a.id != id);
        s.projects.retain(|_, a| *a != id);
        s.sessions.retain(|_, a| *a != id);
        if s.default.as_deref() == Some(&id) {
            s.default = None;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_default_account(id: String) -> CmdResult<()> {
    crate::policy::check_section("account")?;
    update(|s| {
        if !exists(s, &id) {
            return Err("Unbekannter Account".into());
        }
        s.default = (id != STANDARD).then_some(id);
        Ok(())
    })
}

/// `id = None` nimmt das Projekt wieder zum Standard-Account.
#[tauri::command]
pub fn set_project_account(cwd: String, id: Option<String>) -> CmdResult<()> {
    crate::policy::check_section("account")?;
    update(|s| {
        match id {
            Some(id) if exists(s, &id) => {
                s.projects.insert(cwd, id);
            }
            Some(_) => return Err("Unbekannter Account".into()),
            None => {
                s.projects.remove(&cwd);
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_auto_switch(enabled: bool) -> CmdResult<()> {
    crate::policy::check_section("account")?;
    update(|s| {
        s.auto_switch = enabled;
        Ok(())
    })
}

/// Account einer Session für die Anzeige.
#[tauri::command]
pub fn session_account(session_id: String) -> Value {
    let id = for_session(&session_id).unwrap_or_else(|| STANDARD.into());
    json!({ "id": id, "name": name(&id) })
}
