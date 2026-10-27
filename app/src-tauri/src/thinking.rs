//! Denkstufen je Modell: welche `reasoning_effort`-Werte die API wirklich
//! annimmt (gemessen, nicht geraten) und welche Stufen Brise daraus in Vibe
//! anbietet.
//!
//! Vibes Mistral-Anbindung (3.0.x, mitgeschnitten) schickt bei „off“ keinen
//! Wert, bei „low“ `none` und bei „medium“ bis „max“ `high`. Modelle, die
//! low, medium oder max wirklich können, laufen in Brise deshalb über den
//! lokalen Proxy (mistral_proxy.rs): dort geht `reasoning_effort` unverändert
//! hinaus, „off“ lässt ihn ebenfalls weg.
//!
//! Die Tabelle unten ist der gemessene Stand (Messprotokoll in
//! docs/adr/0008-denkstufen.md). Modelle, die dort fehlen, misst Brise beim
//! Start einmal mit Mini-Aufrufen und merkt sich das Ergebnis in
//! `<Datenordner>/thinking-levels.json`.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::installer::data_dir;

/// Werte, die Brise prüft. `none` ist nur ein Leitungswert, keine Stufe in Vibe.
pub const WIRE: [&str; 5] = ["none", "low", "medium", "high", "max"];
/// Stufen in Vibe, in Anzeigereihenfolge.
const ORDER: [&str; 5] = ["off", "low", "medium", "high", "max"];

/// Gemessenes Verhalten eines Modells.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Wire {
    /// Angenommene `reasoning_effort`-Werte (Teilmenge von [`WIRE`]).
    pub accepted: Vec<String>,
    /// Denkt das Modell ohne `reasoning_effort` (Server-Standard)?
    pub default_thinks: bool,
}

/// Gemessen am 26./27.10.2026 direkt gegen die APIs (Mini-Aufruf je Wert).
/// Anbieter, Modellnamen (alle Aliase), angenommene Werte, denkt ohne Angabe.
const MEASURED: &[(&str, &[&str], &[&str], bool)] = &[
    ("mistral", &["zai-glm-5-3", "zai-glm-5", "zai-glm-latest"], &["low", "high", "max"], true),
    ("mistral", &["zai-glm-5-3-flash"], &["low", "high", "max"], true),
    ("mistral", &["zai-glm-5-2", "glm-5-2"], &["none", "low", "medium", "high", "max"], false),
    ("mistral", &["mistral-large-4", "mistral-large-4-0"], &["none", "high"], true),
    (
        "mistral",
        &[
            "mistral-medium-3.5", "mistral-medium-3-5", "mistral-medium-3", "mistral-medium", "mistral-medium-latest", "mistral-medium-2604",
            "magistral-medium-latest", "mistral-vibe-cli-latest", "mistral-vibe-cli-with-tools",
        ],
        &["none", "high"],
        false,
    ),
    ("mistral", &["mistral-small-latest", "mistral-small-2603", "magistral-small-latest", "mistral-vibe-cli-fast"], &["none", "high"], false),
    ("mistral", &["codestral-latest", "codestral-2508", "mistral-code-latest"], &[], false),
    ("mistral", &["ministral-14b-latest", "ministral-14b-2512", "ministral-8b-latest", "ministral-8b-2512", "ministral-3b-latest", "ministral-3b-2512"], &[], false),
    ("mistral", &["mistral-large-latest", "mistral-large-2512"], &[], false),
    ("cortecs", &["glm-5.3", "kimi-k2.7-code", "qwen3.8-27b"], &["none", "low", "medium", "high", "max"], true),
    ("cortecs", &["mistral-medium-3.5"], &["none", "low", "medium", "high", "max"], false),
];

/// Weitere, beim Start gemessene Modelle (`<anbieter>/<name>` → Ergebnis).
fn cache_path() -> std::path::PathBuf {
    data_dir().join("thinking-levels.json")
}

static CACHE: Mutex<Option<BTreeMap<String, Wire>>> = Mutex::new(None);

fn with_cache<T>(f: impl FnOnce(&mut BTreeMap<String, Wire>) -> T) -> T {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(|| std::fs::read(cache_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    f(map)
}

fn key(provider: &str, name: &str) -> String {
    format!("{provider}/{name}")
}

/// Gemessenes Verhalten: erst die Tabelle, dann der Cache.
pub fn lookup(provider: &str, name: &str) -> Option<Wire> {
    MEASURED
        .iter()
        .find(|(p, names, ..)| *p == provider && names.contains(&name))
        .map(|(_, _, accepted, thinks)| Wire { accepted: accepted.iter().map(|s| s.to_string()).collect(), default_thinks: *thinks })
        .or_else(|| with_cache(|m| m.get(&key(provider, name)).cloned()))
}

impl Wire {
    fn accepts(&self, v: &str) -> bool {
        self.accepted.iter().any(|a| a == v)
    }

    /// Verfälscht Vibes Mistral-Anbindung dieses Modell? Ja, wenn es Werte
    /// kann, die sie nicht schickt (low, medium, max).
    pub fn needs_proxy(&self) -> bool {
        ["low", "medium", "max"].iter().any(|v| self.accepts(v))
    }

    /// Stufen über eine OpenAI-kompatible Anbindung (Proxy, Cortecs):
    /// „off“ lässt den Wert weg, alle anderen gehen unverändert hinaus.
    pub fn generic_levels(&self) -> Vec<&'static str> {
        ORDER.iter().copied().filter(|l| *l == "off" || self.accepts(l)).collect()
    }

    /// Stufen über Vibes Mistral-Anbindung: „off“ (kein Wert), „low“
    /// (`none`, nur wenn das Modell ohne Angabe denkt – sonst wäre es nur ein
    /// zweites „Standard“) und „high“.
    pub fn direct_levels(&self) -> Vec<&'static str> {
        let mut out = vec!["off"];
        if self.accepts("none") && self.default_thinks {
            out.push("low");
        }
        if self.accepts("high") {
            out.push("high");
        }
        out
    }
}

/// Stufen eines Modells in Vibe und ob es über den Proxy laufen muss.
/// `None`: nicht gemessen – Brise lässt den Eintrag dann, wie er ist.
pub fn vibe_levels(provider: &str, name: &str) -> Option<(Vec<&'static str>, bool)> {
    let w = lookup(provider, name)?;
    Some(match provider {
        "mistral" if w.needs_proxy() => (w.generic_levels(), true),
        "mistral" => (w.direct_levels(), false),
        _ => (w.generic_levels(), false),
    })
}

/// Stufen für config.toml, wo auch die Vibe-CLI ohne Brise (also ohne Proxy)
/// sie nutzt: nur, was Vibes Mistral-Anbindung richtig schickt. Bei GLM ist
/// das „Standard“ (ohne Angabe) und „hoch“.
pub fn config_levels(provider: &str, name: &str) -> Option<Vec<&'static str>> {
    let w = lookup(provider, name)?;
    if provider != "mistral" {
        return Some(w.generic_levels());
    }
    Some(w.direct_levels())
}

// ---------- Messen ----------

/// Ein Mini-Aufruf je Wert und einer ohne. Zählt nur 200 als angenommen;
/// 401/403/429/5xx brechen ab (kein Ergebnis statt eines falschen).
pub async fn measure(base: &str, key: &str, model: &str, extra: &Value) -> Result<Wire, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90)).build().map_err(|e| e.to_string())?;
    let mut w = Wire::default();
    for v in WIRE.iter().map(Some).chain([None]) {
        let mut body = json!({
            "model": model,
            "max_tokens": 200,
            "messages": [{ "role": "user", "content": "Wie viel ist 17*23? Rechne kurz nach, dann nur die Zahl." }],
        });
        if let (Some(src), Some(dst)) = (extra.as_object(), body.as_object_mut()) {
            dst.extend(src.clone());
        }
        if let Some(v) = v {
            body["reasoning_effort"] = json!(v);
        }
        let resp = client.post(format!("{base}/chat/completions")).bearer_auth(key).json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let data: Value = resp.json().await.unwrap_or(Value::Null);
        match (status, v) {
            (200, Some(v)) => w.accepted.push(v.to_string()),
            (200, None) => w.default_thinks = thinks(&data),
            (400 | 422, _) => {}
            _ => return Err(format!("{model}: HTTP {status}")),
        }
    }
    Ok(w)
}

/// Entstand Reasoning (Tokens laut usage oder ein Gedankengang-Teil)?
fn thinks(data: &Value) -> bool {
    let tokens = data["usage"]["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0);
    let msg = &data["choices"][0]["message"];
    let part = msg["content"].as_array().is_some_and(|a| a.iter().any(|p| p["type"] == "thinking"));
    tokens > 0 || part || msg["reasoning_content"].as_str().is_some_and(|s| !s.is_empty())
}

/// Misst Mistral- und Cortecs-Modelle aus config.toml, die weder in der
/// Tabelle noch im Cache stehen. Läuft beim Start; gibt zurück, ob etwas neu ist.
pub async fn measure_configured() -> bool {
    let Some(path) = crate::config::vibe_home().map(|h| h.join("config.toml")) else { return false };
    let Ok(doc) = std::fs::read_to_string(path).unwrap_or_default().parse::<toml::Table>() else { return false };
    let mut todo: Vec<(String, String)> = Vec::new();
    for m in doc.get("models").and_then(|m| m.as_array()).into_iter().flatten().filter_map(|m| m.as_table()) {
        let provider = m.get("provider").and_then(|v| v.as_str()).unwrap_or("mistral").to_string();
        let Some(name) = m.get("name").and_then(|v| v.as_str()) else { continue };
        if matches!(provider.as_str(), "mistral" | "cortecs") && lookup(&provider, name).is_none() && !todo.iter().any(|(p, n)| *p == provider && n == name) {
            todo.push((provider, name.to_string()));
        }
    }
    let mut changed = false;
    for (provider, name) in todo {
        let result = match provider.as_str() {
            "mistral" => match crate::credentials::read_key() {
                Some(k) => measure(crate::credentials::API_BASE, &k, &name, &Value::Null).await,
                None => continue,
            },
            _ => match crate::cortecs::read_key() {
                Some(k) => measure("https://api.cortecs.ai/v1", &k, &name, &json!({ "allow_zero_data_retention": true })).await,
                None => continue,
            },
        };
        match result {
            Ok(w) => {
                with_cache(|m| {
                    m.insert(key(&provider, &name), w);
                    let _ = std::fs::create_dir_all(data_dir());
                    let _ = std::fs::write(cache_path(), serde_json::to_vec_pretty(m).unwrap_or_default());
                });
                changed = true;
            }
            Err(e) => eprintln!("Denkstufen messen: {e}"),
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glm_ueber_den_proxy_mit_allen_stufen() {
        assert_eq!(vibe_levels("mistral", "zai-glm-5-3"), Some((vec!["off", "low", "high", "max"], true)));
        assert_eq!(vibe_levels("mistral", "zai-glm-5-3-flash"), Some((vec!["off", "low", "high", "max"], true)));
        assert_eq!(vibe_levels("mistral", "zai-glm-5-2"), Some((vec!["off", "low", "medium", "high", "max"], true)));
        assert_eq!(config_levels("mistral", "zai-glm-5-3"), Some(vec!["off", "high"]), "CLI ohne Proxy");
    }

    #[test]
    fn none_und_high_direkt() {
        // Large 4 denkt ohne Angabe: none heißt dort „niedrig“.
        assert_eq!(vibe_levels("mistral", "mistral-large-4"), Some((vec!["off", "low", "high"], false)));
        // Medium und Small denken ohne Angabe nicht: none ist der Standard.
        assert_eq!(vibe_levels("mistral", "mistral-medium-3.5"), Some((vec!["off", "high"], false)));
        assert_eq!(vibe_levels("mistral", "mistral-vibe-cli-latest"), Some((vec!["off", "high"], false)));
        assert_eq!(vibe_levels("mistral", "mistral-small-latest"), Some((vec!["off", "high"], false)));
    }

    #[test]
    fn ohne_denkstufen() {
        // Codestral lehnt jeden Wert ab: nur „Standard“ (kein Wert).
        assert_eq!(vibe_levels("mistral", "codestral-latest"), Some((vec!["off"], false)));
        assert_eq!(vibe_levels("mistral", "unbekannt-xyz"), None);
    }

    #[test]
    fn cortecs_generisch() {
        assert_eq!(vibe_levels("cortecs", "glm-5.3"), Some((vec!["off", "low", "medium", "high", "max"], false)));
    }

    #[test]
    fn reasoning_erkannt() {
        assert!(thinks(&json!({ "usage": { "completion_tokens_details": { "reasoning_tokens": 3 } } })));
        assert!(thinks(&json!({ "choices": [{ "message": { "content": [{ "type": "thinking", "thinking": [] }] } }] })));
        assert!(!thinks(&json!({ "choices": [{ "message": { "content": "391" } }], "usage": { "completion_tokens_details": { "reasoning_tokens": 0 } } })));
    }
}
