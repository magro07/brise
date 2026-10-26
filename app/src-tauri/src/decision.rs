//! Entscheidungsschicht neben den Coding-Agenten: kleine Modellaufrufe, die
//! Brise selbst trifft (Aufgabe einstufen, Denkstufe nachsteuern, Vorschläge,
//! Commit-Nachrichten). Die Aufrufe stehen in assist.rs (Mistral Small) und
//! cortecs.rs (Decision-Modelle mit ZDR); welcher Anbieter gilt, legt die
//! Einstellung `decisionProvider` fest. Siehe docs/adr/0001-agent-backends.md
//! und docs/adr/0004-cortecs.md.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: &'static str,
    title: &'static str,
    available: bool,
}

/// Alle Anbieter samt Schlüsselstatus. Ohne Schlüssel greifen Heuristiken.
#[tauri::command]
pub fn decision_providers() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo { id: "mistral", title: "Mistral (Task-Modell)", available: crate::credentials::read_key().is_some() },
        ProviderInfo { id: crate::cortecs::PROVIDER, title: "Cortecs (ZDR)", available: crate::cortecs::available() },
    ]
}
