//! Installiert Mistral Vibe ohne Terminal: Brise lädt `uv` (Astral) herunter
//! und lässt es Vibe samt passendem Python in Brises eigenen Datenordner
//! installieren. An Systemdateien und am PATH ändert das nichts.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

type CmdResult<T> = Result<T, String>;

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
const PYTHON: &str = "3.13";

/// Brises Datenordner, z. B. `~/.local/share/Brise` oder `%LOCALAPPDATA%\Brise`.
pub fn data_dir() -> PathBuf {
    match std::env::var_os("BRISE_DATA_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("Brise"),
    }
}

pub fn managed_bin_dir() -> PathBuf {
    data_dir().join("bin")
}

fn managed_uv() -> PathBuf {
    data_dir().join("uv").join(format!("uv{EXE}"))
}

fn find_uv() -> Option<PathBuf> {
    let managed = managed_uv();
    if managed.is_file() {
        return Some(managed);
    }
    if let Some(paths) = std::env::var_os("PATH") {
        if let Some(p) = std::env::split_paths(&paths).map(|d| d.join(format!("uv{EXE}"))).find(|p| p.is_file()) {
            return Some(p);
        }
    }
    let home = dirs::home_dir()?;
    [home.join(".local/bin").join(format!("uv{EXE}")), home.join(".cargo/bin").join(format!("uv{EXE}"))]
        .into_iter()
        .find(|p| p.is_file())
}

fn uv_target() -> CmdResult<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        (os, arch) => return Err(format!("Keine automatische Installation für {os}/{arch}")),
    })
}

/// Fortschrittsmeldung (Stufe, Zeile) – in der App als Event, im Selbsttest auf stdout.
pub type Progress = Arc<dyn Fn(&str, String) + Send + Sync>;

fn app_progress(app: &AppHandle) -> Progress {
    let app = app.clone();
    Arc::new(move |stage: &str, line: String| {
        let _ = app.emit("install:progress", json!({ "stage": stage, "line": line }));
    })
}

async fn download(url: &str) -> CmdResult<Vec<u8>> {
    let resp = reqwest::get(url).await.map_err(|e| format!("Download fehlgeschlagen: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download fehlgeschlagen ({}): {url}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Lädt das offizielle uv-Release, prüft die SHA-256-Summe und entpackt `uv`.
async fn install_uv(progress: &Progress) -> CmdResult<PathBuf> {
    let target = uv_target()?;
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let name = format!("uv-{target}.{ext}");
    let url = format!("https://github.com/astral-sh/uv/releases/latest/download/{name}");
    progress("uv", format!("Lade uv ({name}) …"));
    let archive = download(&url).await?;
    let sums = String::from_utf8(download(&format!("{url}.sha256")).await?).map_err(|e| e.to_string())?;
    let expected = sums.split_whitespace().next().unwrap_or_default().to_lowercase();
    let actual: String = Sha256::digest(&archive).iter().map(|b| format!("{b:02x}")).collect();
    if expected != actual {
        return Err("Prüfsumme von uv stimmt nicht – Download abgebrochen.".into());
    }
    progress("uv", "Prüfsumme in Ordnung, entpacke …".into());

    let dest = managed_uv();
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    let wanted = format!("uv{EXE}");
    let mut found = false;
    if cfg!(windows) {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
            if Path::new(file.name()).file_name().and_then(|n| n.to_str()) == Some(wanted.as_str()) {
                let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
                found = true;
                break;
            }
        }
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(std::io::Cursor::new(archive)));
        for file in tar.entries().map_err(|e| e.to_string())? {
            let mut file = file.map_err(|e| e.to_string())?;
            let is_uv = file.path().ok().and_then(|p| p.file_name().map(|n| n == wanted.as_str())).unwrap_or(false);
            if is_uv {
                file.unpack(&dest).map_err(|e| e.to_string())?;
                found = true;
                break;
            }
        }
    }
    if !found {
        return Err("uv nicht im Archiv gefunden".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}

/// Führt uv mit Brises eigenen Ordnern aus und reicht die Ausgabe zeilenweise weiter.
async fn run_uv(progress: &Progress, uv: &Path, args: &[&str]) -> CmdResult<()> {
    let data = data_dir();
    let mut cmd = tokio::process::Command::new(uv);
    cmd.args(args)
        .env("UV_TOOL_DIR", data.join("tools"))
        .env("UV_TOOL_BIN_DIR", managed_bin_dir())
        .env("UV_PYTHON_INSTALL_DIR", data.join("python"))
        .env("UV_CACHE_DIR", data.join("cache"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_MODIFY_PATH", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("uv konnte nicht starten: {e}"))?;

    let mut tasks = Vec::new();
    for reader in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)]
        .into_iter()
        .flatten()
    {
        let progress = progress.clone();
        tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    progress("vibe", line);
                }
            }
        }));
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    for t in tasks {
        let _ = t.await;
    }
    // Der Download-Cache wird danach nicht mehr gebraucht und ist oft mehrere 100 MB groß.
    let _ = std::fs::remove_dir_all(data.join("cache"));
    if !status.success() {
        return Err(format!("uv {} ist fehlgeschlagen ({status})", args.join(" ")));
    }
    Ok(())
}

/// Installiert Mistral Vibe in Brises Datenordner.
#[tauri::command]
pub async fn install_vibe(app: AppHandle) -> CmdResult<String> {
    install_vibe_with(&app_progress(&app)).await
}

pub async fn install_vibe_with(progress: &Progress) -> CmdResult<String> {
    let uv = match find_uv() {
        Some(uv) => {
            progress("uv", format!("uv gefunden: {}", uv.display()));
            uv
        }
        None => install_uv(progress).await?,
    };
    progress("vibe", "Installiere Mistral Vibe (lädt beim ersten Mal auch Python, ca. 1–2 Minuten) …".into());
    // Feste Python-Version: Für brandneue Versionen fehlen teils fertige Pakete
    // (z. B. textual-speedups), dann müsste uv sie mit Rust selbst bauen.
    run_uv(progress, &uv, &["tool", "install", "--force", "--python", PYTHON, "mistral-vibe"]).await?;
    let acp = managed_bin_dir().join(format!("vibe-acp{EXE}"));
    if !acp.is_file() {
        return Err(format!("Installation beendet, aber {} fehlt", acp.display()));
    }
    progress("done", "Mistral Vibe ist installiert.".into());
    Ok(acp.display().to_string())
}

/// Aktualisiert die von Brise installierte Vibe-Version.
#[tauri::command]
pub async fn upgrade_vibe(app: AppHandle) -> CmdResult<()> {
    let uv = find_uv().ok_or("uv nicht gefunden")?;
    let progress = app_progress(&app);
    run_uv(&progress, &uv, &["tool", "upgrade", "--python", PYTHON, "mistral-vibe"]).await?;
    progress("done", "Mistral Vibe ist aktuell.".into());
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    /// `vibe-acp`, den Brise benutzt (falls gefunden).
    path: Option<String>,
    /// Liegt Vibe in Brises eigenem Ordner?
    managed: bool,
    data_dir: String,
}

#[tauri::command]
pub fn install_info() -> InstallInfo {
    let path = crate::agent::find_vibe_acp();
    let managed = path.as_ref().is_some_and(|p| p.starts_with(managed_bin_dir()));
    InstallInfo { path: path.map(|p| p.display().to_string()), managed, data_dir: data_dir().display().to_string() }
}
