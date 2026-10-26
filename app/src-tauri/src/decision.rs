//! Entscheidungsschicht neben den Coding-Agenten: kleine Modellaufrufe, die
//! Brise selbst trifft (Aufgabe einstufen, Denkstufe nachsteuern, Vorschläge,
//! Commit-Nachrichten). Alles läuft über `DecisionProvider`; heute gibt es
//! nur `MistralDecisions` (Mistral Small). Weitere Anbieter – etwa „Cortex AI“
//! Decision Models – werden als eigene Implementierung eingehängt, die
//! fachliche Prüfung der Antworten bleibt in assist.rs.
//! Siehe docs/adr/0001-agent-backends.md.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::credentials::{read_key, API_BASE};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Wofür eine Entscheidung gebraucht wird. Ein Anbieter kann je Aufgabe ein
/// eigenes Modell oder ein eigenes Format wählen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionTask {
    /// simple | standard | complex
    ClassifyTask,
    /// low | high | max während eines laufenden Turns
    AdjustReasoning,
    /// vier Aufgaben-Vorschläge für die Startseite
    ProjectSuggestions,
    /// Commit-Nachricht aus dem gestagten Diff
    CommitMessage,
}

/// Eine Anfrage: Anweisung samt gewünschtem JSON-Format, Eingabe, Zeitlimit.
pub struct DecisionRequest<'a> {
    pub system: &'a str,
    pub user: &'a str,
    /// Vom Nutzer gewähltes Modell; `None` = Standard des Anbieters.
    pub model: Option<&'a str>,
    pub timeout: Duration,
}

pub trait DecisionProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn title(&self) -> &'static str;
    /// Sind Zugangsdaten da? Ohne greifen in der Oberfläche Heuristiken.
    fn available(&self) -> bool;
    /// Antwort als JSON-Objekt nach dem in `system` beschriebenen Schema.
    fn decide<'a>(&'a self, task: DecisionTask, req: DecisionRequest<'a>) -> BoxFuture<'a, Result<Value, String>>;
}

// ---------- Mistral ----------

/// Mistral-Chat-API im JSON-Modus mit dem Nutzer-Key.
pub struct MistralDecisions;

const MISTRAL_DEFAULT: &str = "mistral-small-latest";

impl DecisionProvider for MistralDecisions {
    fn id(&self) -> &'static str {
        "mistral"
    }
    fn title(&self) -> &'static str {
        "Mistral (Task-Modell)"
    }
    fn available(&self) -> bool {
        read_key().is_some()
    }
    fn decide<'a>(&'a self, _task: DecisionTask, req: DecisionRequest<'a>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let key = read_key().ok_or("Kein Mistral-Schlüssel")?;
            let body: Value = reqwest::Client::new()
                .post(format!("{API_BASE}/chat/completions"))
                .bearer_auth(key)
                .timeout(req.timeout)
                .json(&json!({
                    "model": req.model.unwrap_or(MISTRAL_DEFAULT),
                    "temperature": 0.2,
                    "response_format": { "type": "json_object" },
                    "messages": [{ "role": "system", "content": req.system }, { "role": "user", "content": req.user }]
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            let text = body["choices"][0]["message"]["content"].as_str().ok_or_else(|| format!("Unerwartete Antwort: {body}"))?;
            serde_json::from_str(text).map_err(|e| format!("Kein gültiges JSON: {e}"))
        })
    }
}

// ---------- Auswahl ----------

static MISTRAL: MistralDecisions = MistralDecisions;

/// Alle Anbieter. Cortex AI kommt hier dazu, sobald API und Modelle feststehen.
pub fn providers() -> [&'static dyn DecisionProvider; 1] {
    [&MISTRAL]
}

/// Der aktive Anbieter. Später aus der Einstellung `decisionProvider`.
pub fn current() -> &'static dyn DecisionProvider {
    &MISTRAL
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: &'static str,
    title: &'static str,
    available: bool,
    active: bool,
}

#[tauri::command]
pub fn decision_providers() -> Vec<ProviderInfo> {
    let active = current().id();
    providers().into_iter().map(|p| ProviderInfo { id: p.id(), title: p.title(), available: p.available(), active: p.id() == active }).collect()
}
