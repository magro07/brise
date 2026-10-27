//! Mistral-Modelle mit ihren echten Denkstufen in Vibe (Tabelle: thinking.rs).
//!
//! Vibes Mistral-Anbindung bildet die Stufen um (low → none, medium bis max →
//! high). GLM-5.3 kann aber low, high und max und lehnt none ab. Vibes generische Anbindung reicht
//! `reasoning_effort` roh durch, versteht aber Mistrals Gedankengang-Format
//! nicht und schickt `reasoning_content` zurück, das Mistral ablehnt (HTTP 422).
//!
//! Deshalb leitet Brise diese Modelle über seinen lokalen Proxy (cortecs.rs,
//! Pfad `/mistral/v1/…`) und setzt dort beide Richtungen um:
//! - Anfrage: `reasoning_content` im Verlauf → `thinking`-Teil im content-Array
//!   (wie Vibes Mistral-Anbindung), `reasoning_effort` bleibt unverändert.
//! - Antwort: content-Array mit `thinking`-Teilen → `content` + `reasoning_content`
//!   (Stream und ganze Antwort), so zeigt Brise den Gedankengang weiter an.
//!
//! Die Umleitung gilt nur für Vibe-Prozesse, die Brise startet: Brise ergänzt
//! deren Umgebung um `VIBE_PROVIDERS` (Anbieter `brise-mistral`) und
//! `VIBE_MODELS` (vollständige Kopien der Einträge aus config.toml mit den
//! gemessenen Stufen, umgeleitete mit diesem Anbieter). config.toml bleibt
//! unverändert, die Vibe-CLI ohne Brise läuft also weiter direkt.
//!
//! Den Schlüssel liest Vibe wie bisher selbst (Umgebung, `.env`, Schlüsselbund)
//! und schickt ihn mit; der Proxy reicht ihn nur an api.mistral.ai weiter. Er
//! steht weder in config.toml noch in der Umgebung, und weitere Accounts
//! (accounts.rs) behalten ihre eigene Schlüsselvariable.
//!
//! Verbrauch: Vibe meldet die Tokens wie gewohnt per ACP (`usage_update`),
//! usage.rs bucht den Turn. Der Proxy bucht nichts, sonst zählte er doppelt.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::credentials::API_BASE;

/// Name des Anbieters in Vibe.
pub const PROVIDER: &str = "brise-mistral";
/// Pfad-Präfix im lokalen Proxy.
pub const PATH: &str = "/mistral/";
/// Läuft dieses Mistral-Modell über den Proxy (laut gemessener Tabelle)?
pub fn routed(name: &str) -> bool {
    crate::thinking::vibe_levels("mistral", name).is_some_and(|(_, proxy)| proxy)
}

// ---------- Umgebung für vibe-acp ----------

/// Einträge aus config.toml, deren Stufen Brise korrigiert, als vollständige
/// Modelle für `VIBE_MODELS` (Vibe verwirft Teil-Einträge). Umgeleitete
/// Mistral-Modelle bekommen den Proxy-Anbieter – nur mit `proxy`.
fn corrected_models(doc: &toml::Table, proxy: bool) -> Vec<Value> {
    let Some(list) = doc.get("models").and_then(|m| m.as_array()) else { return Vec::new() };
    let mut out = Vec::new();
    for m in list.iter().filter_map(|m| m.as_table()) {
        let provider = m.get("provider").and_then(|v| v.as_str()).unwrap_or("mistral");
        let Some(name) = m.get("name").and_then(|v| v.as_str()) else { continue };
        let Some((levels, via_proxy)) = crate::thinking::vibe_levels(provider, name) else { continue };
        if via_proxy && !proxy {
            continue;
        }
        let current: Vec<&str> = m.get("thinking_levels").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
        if !via_proxy && current == levels {
            continue;
        }
        let Ok(mut entry) = serde_json::to_value(m) else { continue };
        if via_proxy {
            entry["provider"] = json!(PROVIDER);
        }
        entry["thinking_levels"] = json!(levels);
        out.push(entry);
    }
    out
}

/// Ergänzt die Umgebung eines `vibe-acp` um den Proxy-Anbieter und die
/// umgeleiteten GLM-Modelle. Ohne Proxy oder ohne GLM-Eintrag bleibt alles,
/// wie es ist (GLM dann direkt, mit „Standard“ und „hoch“).
pub fn extend_env(env: &mut Vec<(String, String)>) {
    // Wer selbst VIBE_MODELS setzt, bekommt seine Einstellung.
    if std::env::var_os("VIBE_MODELS").is_some() {
        return;
    }
    let Some(path) = crate::config::vibe_home().map(|h| h.join("config.toml")) else { return };
    let Ok(doc) = std::fs::read_to_string(path).unwrap_or_default().parse::<toml::Table>() else { return };
    let port = crate::cortecs::start_proxy().ok();
    let models = corrected_models(&doc, port.is_some());
    if models.is_empty() {
        return;
    }
    if let Some(port) = port.filter(|_| models.iter().any(|m| m["provider"] == PROVIDER)) {
        let given = env.iter().position(|(k, _)| k == "VIBE_PROVIDERS");
        let mut providers: Vec<Value> = given
            .and_then(|i| serde_json::from_str(&env[i].1).ok())
            .or_else(|| std::env::var("VIBE_PROVIDERS").ok().and_then(|v| serde_json::from_str(&v).ok()))
            .unwrap_or_default();
        // Gleiche Schlüsselvariable wie der Mistral-Anbieter (weitere Accounts setzen eine eigene).
        let key_var = providers
            .iter()
            .find(|p| p["name"] == "mistral")
            .and_then(|p| p["api_key_env_var"].as_str())
            .unwrap_or("MISTRAL_API_KEY")
            .to_string();
        providers.retain(|p| p["name"] != PROVIDER);
        providers.push(json!({
            "name": PROVIDER,
            "api_base": format!("http://127.0.0.1:{port}{PATH}v1"),
            "api_key_env_var": key_var,
            "api_style": "openai",
            "backend": "generic",
        }));
        let providers = Value::Array(providers).to_string();
        match given {
            Some(i) => env[i].1 = providers,
            None => env.push(("VIBE_PROVIDERS".into(), providers)),
        }
    }
    env.push(("VIBE_MODELS".into(), Value::Array(models).to_string()));
}

// ---------- Umsetzung ----------

/// Verlauf für Mistral: Gedankengang zurück ins content-Array, nur Felder,
/// die Mistral annimmt (wie Vibes Mistral-Anbindung).
fn to_mistral(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else { return };
    for m in messages {
        let Some(obj) = m.as_object_mut() else { continue };
        let reasoning = obj.remove("reasoning_content");
        if obj.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(r) = reasoning.as_ref().and_then(Value::as_str).filter(|r| !r.is_empty()) {
            let mut parts = vec![json!({ "type": "thinking", "thinking": [{ "type": "text", "text": r }] })];
            if let Some(t) = obj.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                parts.push(json!({ "type": "text", "text": t }));
            }
            obj.insert("content".into(), Value::Array(parts));
        }
        if let Some(calls) = obj.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for c in calls.iter_mut().filter_map(Value::as_object_mut) {
                c.retain(|k, _| matches!(k.as_str(), "id" | "type" | "function"));
            }
        }
    }
}

/// Text eines Gedankengang-Teils: `thinking` ist eine Liste von Text-Teilen (oder Text).
fn thinking_text(part: &Value) -> String {
    match &part["thinking"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|t| t["text"].as_str()).collect(),
        _ => String::new(),
    }
}

/// Nachricht oder Delta von Mistral → OpenAI-Form mit `reasoning_content`.
fn from_mistral(msg: &mut Value) {
    let Some(obj) = msg.as_object_mut() else { return };
    // Mistral setzt `index` auch in Nachricht und Delta; Vibe kennt das Feld dort nicht.
    obj.remove("index");
    let Some(Value::Array(parts)) = obj.get("content") else { return };
    let mut text = String::new();
    let mut reasoning = String::new();
    for p in parts {
        match p["type"].as_str() {
            Some("thinking") => reasoning.push_str(&thinking_text(p)),
            Some("text") => text.push_str(p["text"].as_str().unwrap_or_default()),
            _ => {}
        }
    }
    obj.insert("content".into(), json!(text));
    if !reasoning.is_empty() {
        obj.insert("reasoning_content".into(), json!(reasoning));
    }
}

/// Eine ganze Antwort oder ein Stream-Chunk.
fn convert_response(v: &mut Value) {
    for c in v.get_mut("choices").and_then(Value::as_array_mut).into_iter().flatten() {
        for k in ["message", "delta"] {
            if let Some(m) = c.get_mut(k) {
                from_mistral(m);
            }
        }
    }
}

/// Eine SSE-Zeile (ohne Zeilenende) umsetzen; alles außer `data: {…}` bleibt.
fn convert_line(line: &[u8]) -> Vec<u8> {
    let Some(data) = line.strip_prefix(b"data:") else { return line.to_vec() };
    match serde_json::from_slice::<Value>(data.trim_ascii_start()) {
        Ok(mut v) => {
            convert_response(&mut v);
            format!("data: {v}").into_bytes()
        }
        Err(_) => line.to_vec(),
    }
}

/// Setzt einen Stream zeilenweise um; unvollständige Zeilen warten auf den nächsten Chunk.
#[derive(Default)]
struct SseConverter {
    pending: Vec<u8>,
}

impl SseConverter {
    fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(p) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=p).collect();
            let body = line[..line.len() - 1].strip_suffix(b"\r").unwrap_or(&line[..line.len() - 1]);
            out.extend(convert_line(body));
            out.push(b'\n');
        }
        out
    }

    fn finish(self) -> Vec<u8> {
        if self.pending.is_empty() { Vec::new() } else { convert_line(&self.pending) }
    }
}

// ---------- Proxy ----------

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().unwrap_or_default()).clone()
}

async fn respond(sock: &mut tokio::net::TcpStream, status: u16, message: &str) -> Result<(), String> {
    let body = json!({ "error": { "message": message } }).to_string();
    let msg = format!("HTTP/1.1 {status} Brise\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    sock.write_all(msg.as_bytes()).await.map_err(|e| e.to_string())
}

/// `POST /mistral/v1/chat/completions` an Mistral weiterleiten und umsetzen.
/// Nur dieser Pfad, nur zu api.mistral.ai, mit dem Schlüssel, den Vibe schickt.
pub(crate) async fn forward(sock: &mut tokio::net::TcpStream, method: &str, path: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<(), String> {
    if method != "POST" || path.trim_start_matches(PATH) != "v1/chat/completions" {
        return respond(sock, 404, "Brise leitet hier nur /v1/chat/completions an Mistral weiter").await;
    }
    let Ok(mut payload) = serde_json::from_slice::<Value>(&body) else {
        return respond(sock, 400, "Brise: Anfrage ist kein JSON").await;
    };
    if !payload["model"].as_str().is_some_and(routed) {
        return respond(sock, 400, "Brise: Dieses Modell läuft nicht über den Proxy").await;
    }
    to_mistral(&mut payload);
    let mut up = client().post(format!("{API_BASE}/chat/completions")).json(&payload);
    for (k, v) in headers {
        if matches!(k.as_str(), "authorization" | "accept" | "user-agent") || k.starts_with("x-") {
            up = up.header(k, v);
        }
    }
    let mut resp = match up.send().await {
        Ok(r) => r,
        Err(e) => return respond(sock, 502, &format!("Mistral nicht erreichbar: {e}")).await,
    };
    let status = resp.status();
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    let head = format!("HTTP/1.1 {} {}\r\nContent-Type: {ctype}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    sock.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Fehler unverändert durchreichen (Vibe zeigt Mistrals Meldung).
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            sock.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
    } else if ctype.starts_with("text/event-stream") {
        let mut sse = SseConverter::default();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            if sock.write_all(&sse.feed(&chunk)).await.is_err() {
                break; // Vibe hat abgebrochen.
            }
        }
        let _ = sock.write_all(&sse.finish()).await;
    } else {
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let out = match serde_json::from_slice::<Value>(&bytes) {
            Ok(mut v) => {
                convert_response(&mut v);
                v.to_string().into_bytes()
            }
            Err(_) => bytes.to_vec(),
        };
        sock.write_all(&out).await.map_err(|e| e.to_string())?;
    }
    let _ = sock.flush().await;
    let _ = sock.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn umgeleitet_laut_tabelle() {
        assert!(routed("zai-glm-5-3"));
        assert!(!routed("codestral-latest"), "kennt keine Stufen");
        assert!(!routed("mistral-large-4"));
        assert!(!routed("mistral-medium-3.5"));
        assert!(!routed("unbekannt"));
    }

    #[test]
    fn verlauf_fuer_mistral() {
        let mut body = json!({ "model": "zai-glm-5-3", "reasoning_effort": "max", "messages": [
            { "role": "user", "content": "17*23?" },
            { "role": "assistant", "content": "391", "reasoning_content": "17*20+17*3" },
            { "role": "assistant", "content": "", "reasoning_content": "lesen", "tool_calls": [{ "id": "a", "index": 0, "type": "function", "function": { "name": "f", "arguments": "{}" } }] },
            { "role": "assistant", "content": "ohne" },
        ]});
        to_mistral(&mut body);
        let m = &body["messages"];
        assert_eq!(body["reasoning_effort"], "max", "Stufe bleibt unverändert");
        assert_eq!(m[1]["content"], json!([{ "type": "thinking", "thinking": [{ "type": "text", "text": "17*20+17*3" }] }, { "type": "text", "text": "391" }]));
        assert!(m[1].get("reasoning_content").is_none());
        assert_eq!(m[2]["content"].as_array().unwrap().len(), 1, "leerer Text fällt weg");
        assert!(m[2]["tool_calls"][0].get("index").is_none());
        assert_eq!(m[3]["content"], "ohne");
    }

    #[test]
    fn stream_mit_gedankengang() {
        let mut sse = SseConverter::default();
        let a = br#"data: {"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"17 * 23"}],"closed":true}]}}]}"#;
        let b = br#"data: {"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"."}],"closed":true},{"type":"text","text":"**391**"}]}}]}"#;
        let mut input = Vec::new();
        input.extend_from_slice(a);
        input.extend_from_slice(b"\n\n");
        input.extend_from_slice(b);
        input.extend_from_slice(b"\n\ndata: [DONE]\n\n");
        // In zwei ungünstig geschnittenen Stücken.
        let (x, y) = input.split_at(37);
        let mut out = sse.feed(x);
        out.extend(sse.feed(y));
        out.extend(sse.finish());
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| l.starts_with("data: {")).collect();
        let first: Value = serde_json::from_str(&lines[0][6..]).unwrap();
        let second: Value = serde_json::from_str(&lines[1][6..]).unwrap();
        assert_eq!(first["choices"][0]["delta"], json!({ "content": "", "reasoning_content": "17 * 23" }));
        assert_eq!(second["choices"][0]["delta"], json!({ "content": "**391**", "reasoning_content": "." }));
        assert!(text.contains("data: [DONE]\n"));
    }

    #[test]
    fn ganze_antwort_und_reiner_text() {
        let mut v = json!({ "choices": [{ "message": { "role": "assistant", "index": 0, "content": [{ "type": "thinking", "thinking": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }] }, { "type": "text", "text": "c" }] } }] });
        convert_response(&mut v);
        assert_eq!(v["choices"][0]["message"], json!({ "role": "assistant", "content": "c", "reasoning_content": "ab" }));
        let mut plain = json!({ "choices": [{ "delta": { "content": "hallo" } }] });
        convert_response(&mut plain);
        assert_eq!(plain["choices"][0]["delta"], json!({ "content": "hallo" }));
    }

    #[test]
    fn stufen_aus_der_tabelle() {
        let doc: toml::Table = r#"
            [[models]]
            provider = "mistral"
            name = "zai-glm-5-3"
            alias = "glm-5-3"
            thinking = "high"
            thinking_levels = ["off", "high"]
            max_context_length = 200000

            [[models]]
            provider = "mistral"
            name = "mistral-large-4"
            alias = "mistral-large-4"

            [[models]]
            provider = "cortecs"
            name = "glm-5.3"
            alias = "cortecs-glm-5-3"
            thinking_levels = ["low", "high", "max"]
        "#
        .parse()
        .unwrap();
        let models = corrected_models(&doc, true);
        assert_eq!(models.len(), 3, "GLM, Large 4 (Stufen falsch) und Cortecs-GLM");
        assert_eq!(models[0]["provider"], PROVIDER);
        assert_eq!(models[0]["alias"], "glm-5-3");
        assert_eq!(models[0]["thinking_levels"], json!(["off", "low", "high", "max"]));
        assert_eq!(models[0]["max_context_length"], 200000, "übrige Felder bleiben");
        assert_eq!(models[1]["provider"], "mistral");
        assert_eq!(models[1]["thinking_levels"], json!(["off", "low", "high"]));
        assert_eq!(models[2]["provider"], "cortecs");
        assert_eq!(models[2]["thinking_levels"], json!(["off", "low", "medium", "high", "max"]));
        let direct = corrected_models(&doc, false);
        assert!(direct.iter().all(|m| m["provider"] != PROVIDER), "ohne Proxy nichts umleiten");
    }
}
