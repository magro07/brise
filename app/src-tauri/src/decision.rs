//! Entscheidungsschicht neben den Coding-Agenten: kleine Modellaufrufe, die
//! Brise selbst trifft (Aufgabe einstufen, Denkstufe nachsteuern, Vorschläge,
//! Commit-Nachrichten). Die Aufrufe stehen in assist.rs; das Modell kommt aus
//! den Einstellungen (`taskModels`) und kann bei jedem konfigurierten Anbieter
//! liegen (providers.rs). Cortecs-Decision-Modelle laufen über die
//! Decisions-API (cortecs.rs). Siehe docs/adr/0001-agent-backends.md,
//! docs/adr/0004-cortecs.md und docs/adr/0009-anbieter.md.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: String,
    title: String,
    available: bool,
}

/// Alle Anbieter samt Schlüsselstatus. Ohne Schlüssel greifen Heuristiken.
#[tauri::command]
pub fn decision_providers() -> Vec<ProviderInfo> {
    crate::providers::all()
        .into_iter()
        .map(|p| ProviderInfo { available: crate::providers::usable(&p), id: p.id, title: p.name })
        .collect()
}
