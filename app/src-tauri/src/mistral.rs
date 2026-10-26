//! Weitere Mistral-Modelle direkt aus Brise: Codestral für die
//! Inline-Vervollständigung im Editor (FIM) und Mistral OCR für Dokumente.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use crate::credentials::{read_key, API_BASE};

type CmdResult<T> = Result<T, String>;

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Codestral Fill-in-the-Middle: Vervollständigung zwischen `prefix` und `suffix`.
#[tauri::command]
pub async fn fim_complete(prefix: String, suffix: String, model: Option<String>) -> CmdResult<String> {
    let key = read_key().ok_or("Kein Mistral-Schlüssel")?;
    let body: Value = client()
        .post(format!("{API_BASE}/fim/completions"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(8))
        .json(&json!({
            "model": model.unwrap_or_else(|| "codestral-latest".into()),
            "prompt": prefix,
            "suffix": suffix,
            "max_tokens": 96,
            "temperature": 0,
            // Nicht über mehrere Absätze hinaus raten.
            "stop": ["\n\n\n"]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(body["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string())
}

/// Mistral OCR: PDF, Office-Dokument oder Bild → Markdown.
#[tauri::command]
pub async fn ocr_document(path: String) -> CmdResult<String> {
    let key = read_key().ok_or("Kein Mistral-Schlüssel")?;
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err(format!(".{ext} wird von OCR nicht unterstützt")),
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("Dokument ist größer als 50 MB".into());
    }
    let data = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    let document = if mime.starts_with("image/") {
        json!({ "type": "image_url", "image_url": data })
    } else {
        json!({ "type": "document_url", "document_url": data })
    };
    let resp = client()
        .post(format!("{API_BASE}/ocr"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(180))
        .json(&json!({ "model": "mistral-ocr-latest", "document": document }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OCR fehlgeschlagen ({status}): {}", body["message"].as_str().unwrap_or("")));
    }
    let pages: Vec<String> = body["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(n, p)| format!("<!-- Seite {} -->\n{}", n + 1, p["markdown"].as_str().unwrap_or("")))
        .collect();
    Ok(pages.join("\n\n"))
}
