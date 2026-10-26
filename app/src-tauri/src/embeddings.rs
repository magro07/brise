//! Semantische Codesuche mit Mistrals Embedding-Modellen (`codestral-embed`,
//! `mistral-embed`). Der Index liegt in Brises Datenordner: Metadaten als JSON,
//! Vektoren als f32-Binärdatei. Neu eingebettet werden nur geänderte Dateien.
//!
//! Dieselbe Suche bietet `brise --mcp-search <ordner>` als MCP-Server an, damit
//! Vibe sie als Werkzeug nutzen kann (siehe `run_mcp_server`).

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::credentials::{read_key, API_BASE};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

const CHUNK_LINES: usize = 60;
const CHUNK_OVERLAP: usize = 10;
const MAX_CHUNK_CHARS: usize = 6000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_CHUNKS: usize = 30_000;
const BATCH_CHARS: usize = 48_000;
const BATCH_ITEMS: usize = 64;

const SKIP_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "svg", "pdf", "zip", "gz", "tar", "xz", "7z", "woff", "woff2", "ttf",
    "otf", "mp3", "mp4", "wav", "ogg", "mov", "lock", "bin", "exe", "dll", "so", "dylib", "class", "jar", "pyc", "wasm", "db",
    "sqlite", "map",
];

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    path: String,
    start: usize,
    end: usize,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileStamp {
    mtime: u64,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct Meta {
    model: String,
    dim: usize,
    cwd: String,
    updated_at: u64,
    files: HashMap<String, FileStamp>,
    entries: Vec<Entry>,
}

struct Index {
    meta: Meta,
    vectors: Vec<f32>,
}

fn index_dir(cwd: &str) -> PathBuf {
    let hash: String = Sha256::digest(cwd.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    data_dir().join("index").join(hash)
}

fn load_index(cwd: &str) -> Option<Index> {
    let dir = index_dir(cwd);
    let meta: Meta = serde_json::from_slice(&std::fs::read(dir.join("meta.json")).ok()?).ok()?;
    let bytes = std::fs::read(dir.join("vectors.bin")).ok()?;
    let vectors: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    (vectors.len() == meta.entries.len() * meta.dim).then_some(Index { meta, vectors })
}

fn save_index(cwd: &str, index: &Index) -> CmdResult<()> {
    let dir = index_dir(cwd);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes: Vec<u8> = index.vectors.iter().flat_map(|f| f.to_le_bytes()).collect();
    std::fs::write(dir.join("vectors.bin.tmp"), bytes).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("meta.json.tmp"), serde_json::to_vec(&index.meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(dir.join("vectors.bin.tmp"), dir.join("vectors.bin")).map_err(|e| e.to_string())?;
    std::fs::rename(dir.join("meta.json.tmp"), dir.join("meta.json")).map_err(|e| e.to_string())?;
    Ok(())
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(FileStamp { mtime, size: m.len() })
}

/// Textdateien des Projekts (beachtet .gitignore, überspringt Binäres).
fn project_files(root: &Path) -> Vec<(String, PathBuf, FileStamp)> {
    let mut out = Vec::new();
    for entry in ignore::WalkBuilder::new(root).hidden(true).max_depth(Some(16)).build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if SKIP_EXT.contains(&ext.as_str()) || name.ends_with(".min.js") || name == "package-lock.json" {
            continue;
        }
        let Some(st) = stamp(path) else { continue };
        if st.size == 0 || st.size > MAX_FILE_BYTES {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path.to_path_buf(), st));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Zerlegt eine Datei in überlappende Zeilenblöcke.
fn chunk_file(rel: &str, text: &str) -> Vec<(Entry, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        let end = (start + CHUNK_LINES).min(lines.len());
        let mut body = lines[start..end].join("\n");
        if body.len() > MAX_CHUNK_CHARS {
            let mut cut = MAX_CHUNK_CHARS;
            while !body.is_char_boundary(cut) {
                cut -= 1;
            }
            body.truncate(cut);
        }
        if !body.trim().is_empty() {
            out.push((Entry { path: rel.to_string(), start: start + 1, end }, format!("{rel}\n{body}")));
        }
        if end == lines.len() {
            break;
        }
        start = end - CHUNK_OVERLAP;
    }
    out
}

/// `tag` = (Funktion, Projekt) fürs Nutzungsjournal.
async fn embed(client: &reqwest::Client, key: &str, model: &str, inputs: &[String], tag: (&str, &str)) -> CmdResult<Vec<Vec<f32>>> {
    let mut attempt = 0;
    loop {
        let resp = client
            .post(format!("{API_BASE}/embeddings"))
            .bearer_auth(key)
            .json(&json!({ "model": model, "input": inputs }))
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("Mistral nicht erreichbar: {e}"))?;
        let status = resp.status();
        if status.as_u16() == 429 && attempt < 6 {
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(1500 * attempt)).await;
            continue;
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            // Zu groß? Dann halbieren und einzeln versuchen.
            if status.as_u16() == 400 && inputs.len() > 1 {
                let mid = inputs.len() / 2;
                let mut a = Box::pin(embed(client, key, model, &inputs[..mid], tag)).await?;
                a.extend(Box::pin(embed(client, key, model, &inputs[mid..], tag)).await?);
                return Ok(a);
            }
            return Err(format!("Embedding-Fehler ({status}): {}", body["message"].as_str().or(body["detail"].as_str()).unwrap_or("unbekannt")));
        }
        crate::usage::record(crate::usage::Record::new("embed", tag.0, model).project(Some(tag.1)).tokens(&body));
        let mut data: Vec<(usize, Vec<f32>)> = body["data"]
            .as_array()
            .ok_or("Antwort ohne Daten")?
            .iter()
            .map(|d| {
                let idx = d["index"].as_u64().unwrap_or(0) as usize;
                let v = d["embedding"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
                (idx, v)
            })
            .collect();
        data.sort_by_key(|(i, _)| *i);
        return Ok(data.into_iter().map(|(_, v)| normalize(v)).collect());
    }
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    indexed: bool,
    model: Option<String>,
    files: usize,
    chunks: usize,
    updated_at: Option<u64>,
}

#[tauri::command]
pub fn index_status(cwd: String) -> IndexStatus {
    let dir = index_dir(&cwd);
    match std::fs::read(dir.join("meta.json")).ok().and_then(|b| serde_json::from_slice::<Meta>(&b).ok()) {
        Some(m) => IndexStatus { indexed: true, model: Some(m.model), files: m.files.len(), chunks: m.entries.len(), updated_at: Some(m.updated_at) },
        None => IndexStatus { indexed: false, model: None, files: 0, chunks: 0, updated_at: None },
    }
}

#[tauri::command]
pub fn delete_index(cwd: String) -> CmdResult<()> {
    let dir = index_dir(&cwd);
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Baut oder aktualisiert den Index eines Projekts.
#[tauri::command]
pub async fn index_project(app: AppHandle, cwd: String, model: String) -> CmdResult<IndexStatus> {
    let key = read_key().ok_or("Kein Mistral-Schlüssel gefunden – bitte zuerst anmelden.")?;
    let root = PathBuf::from(&cwd);
    let files = tokio::task::spawn_blocking({
        let root = root.clone();
        move || project_files(&root)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Vorhandene Vektoren unveränderter Dateien übernehmen.
    let old = load_index(&cwd).filter(|i| i.meta.model == model);
    let mut keep: HashMap<String, Vec<(Entry, Vec<f32>)>> = HashMap::new();
    if let Some(old) = &old {
        for (n, e) in old.meta.entries.iter().enumerate() {
            let unchanged = files.iter().any(|(rel, _, st)| {
                rel == &e.path && old.meta.files.get(rel).is_some_and(|o| o.mtime == st.mtime && o.size == st.size)
            });
            if unchanged {
                keep.entry(e.path.clone()).or_default().push((e.clone(), old.vectors[n * old.meta.dim..(n + 1) * old.meta.dim].to_vec()));
            }
        }
    }

    let mut pending: Vec<(Entry, String)> = Vec::new();
    let mut stamps = HashMap::new();
    for (rel, path, st) in &files {
        stamps.insert(rel.clone(), st.clone());
        if keep.contains_key(rel) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        if bytes.contains(&0) {
            continue;
        }
        pending.extend(chunk_file(rel, &String::from_utf8_lossy(&bytes)));
        if pending.len() > MAX_CHUNKS {
            return Err(format!("Projekt ist zu groß für den Index (über {MAX_CHUNKS} Abschnitte)."));
        }
    }

    let total = pending.len();
    let _ = app.emit("index:progress", json!({ "cwd": cwd, "done": 0, "total": total }));
    let client = reqwest::Client::new();
    let mut fresh: Vec<(Entry, Vec<f32>)> = Vec::with_capacity(total);
    let mut batch: Vec<(Entry, String)> = Vec::new();
    let mut chars = 0;
    let mut iter = pending.into_iter().peekable();
    while let Some(item) = iter.next() {
        chars += item.1.len();
        batch.push(item);
        let full = batch.len() >= BATCH_ITEMS || chars >= BATCH_CHARS || iter.peek().is_none();
        if full {
            let inputs: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
            let vectors = embed(&client, &key, &model, &inputs, ("Index", &cwd)).await?;
            fresh.extend(batch.drain(..).map(|(e, _)| e).zip(vectors));
            chars = 0;
            let _ = app.emit("index:progress", json!({ "cwd": cwd, "done": fresh.len(), "total": total }));
        }
    }

    let dim = fresh.first().map(|(_, v)| v.len()).or_else(|| old.as_ref().map(|o| o.meta.dim)).unwrap_or(0);
    let mut entries = Vec::new();
    let mut vectors = Vec::new();
    for (e, v) in keep.into_values().flatten().chain(fresh) {
        if v.len() == dim {
            entries.push(e);
            vectors.extend(v);
        }
    }
    let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let index = Index { meta: Meta { model, dim, cwd: cwd.clone(), updated_at: now, files: stamps, entries }, vectors };
    save_index(&cwd, &index)?;
    Ok(index_status(cwd))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    path: String,
    start: usize,
    end: usize,
    score: f32,
    snippet: String,
}

async fn search(cwd: &str, query: &str, limit: usize, feature: &str) -> CmdResult<Vec<Hit>> {
    let index = load_index(cwd).ok_or("Dieses Projekt ist noch nicht indexiert.")?;
    let key = read_key().ok_or("Kein Mistral-Schlüssel gefunden.")?;
    let q = embed(&reqwest::Client::new(), &key, &index.meta.model, &[query.to_string()], (feature, cwd)).await?.pop().ok_or("Leere Antwort")?;
    if q.len() != index.meta.dim {
        return Err("Index passt nicht zum Modell – bitte neu indexieren.".into());
    }
    let mut scored: Vec<(f32, usize)> = (0..index.meta.entries.len())
        .map(|n| (index.vectors[n * index.meta.dim..(n + 1) * index.meta.dim].iter().zip(&q).map(|(a, b)| a * b).sum(), n))
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));

    // Überlappende Treffer derselben Datei zusammenfassen.
    let mut hits: Vec<Hit> = Vec::new();
    for (score, n) in scored {
        let e = &index.meta.entries[n];
        if hits.iter().any(|h| h.path == e.path && h.start <= e.end && e.start <= h.end) {
            continue;
        }
        let snippet = std::fs::read_to_string(Path::new(cwd).join(&e.path))
            .map(|t| t.lines().skip(e.start - 1).take(e.end + 1 - e.start).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        hits.push(Hit { path: e.path.clone(), start: e.start, end: e.end, score, snippet });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn semantic_search(cwd: String, query: String, limit: Option<usize>) -> CmdResult<Vec<Hit>> {
    search(&cwd, &query, limit.unwrap_or(12), "Suche").await
}

// ---------- MCP-Server für Vibe ----------

/// `brise --mcp-search <ordner>`: minimaler MCP-Server (stdio, JSON pro Zeile).
pub fn run_mcp_server(cwd: String) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("Tokio-Runtime");
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // Notifications ignorieren
        let method = msg["method"].as_str().unwrap_or("");
        let result = match method {
            "initialize" => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "brise-search", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Semantische Codesuche über Mistral-Embeddings. Nutze sie, um Code nach Bedeutung statt nach exaktem Text zu finden."
            }),
            "ping" => json!({}),
            "tools/list" => json!({ "tools": [{
                "name": "semantic_code_search",
                "description": "Findet Codestellen im Projekt nach Bedeutung (Mistral codestral-embed). Gut für Fragen wie 'wo wird die Anmeldung geprüft?'. Liefert Dateipfade mit Zeilenbereichen und Ausschnitten.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Wonach gesucht wird, in natürlicher Sprache oder als Code" },
                        "limit": { "type": "integer", "description": "Anzahl Treffer (Standard 8, maximal 20)" }
                    },
                    "required": ["query"]
                },
                "annotations": { "readOnlyHint": true }
            }]}),
            "tools/call" => {
                let args = &msg["params"]["arguments"];
                let query = args["query"].as_str().unwrap_or("").to_string();
                let limit = args["limit"].as_u64().unwrap_or(8).clamp(1, 20) as usize;
                match rt.block_on(search(&cwd, &query, limit, "Suche (Agent)")) {
                    Ok(hits) => {
                        let text = hits
                            .iter()
                            .map(|h| format!("{}:{}-{} (Ähnlichkeit {:.2})\n```\n{}\n```", h.path, h.start, h.end, h.score, h.snippet))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        json!({ "content": [{ "type": "text", "text": if text.is_empty() { "Keine Treffer.".into() } else { text } }] })
                    }
                    Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                }
            }
            _ => {
                let err = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Unbekannte Methode {method}") } });
                let _ = writeln!(stdout, "{err}");
                let _ = stdout.flush();
                continue;
            }
        };
        let _ = writeln!(stdout, "{}", json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        let _ = stdout.flush();
    }
}

/// MCP-Eintrag für `session/new`, wenn das Projekt indexiert ist.
pub fn mcp_entry(cwd: &str) -> Option<Value> {
    if !index_dir(cwd).join("meta.json").exists() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    Some(json!({ "name": "brise-search", "command": exe.display().to_string(), "args": ["--mcp-search", cwd], "env": crate::agent::child_env() }))
}
