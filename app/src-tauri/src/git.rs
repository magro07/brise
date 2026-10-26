//! Git-Anbindung über die git-Kommandozeile. Unter Windows bringt Brise bei
//! Bedarf MinGit (Git for Windows, portable) in den eigenen Datenordner mit.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

fn managed_git() -> PathBuf {
    data_dir().join("mingit").join("cmd").join("git.exe")
}

pub fn find_git() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "git.exe" } else { "git" };
    if let Some(paths) = std::env::var_os("PATH") {
        if let Some(p) = std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()) {
            return Some(p);
        }
    }
    let managed = managed_git();
    managed.is_file().then_some(managed)
}

/// Ordner, den Vibe zusätzlich im PATH braucht, wenn Git von Brise kommt.
pub fn extra_path() -> Option<PathBuf> {
    let managed = managed_git();
    (managed.is_file() && find_git().as_deref() == Some(managed.as_path())).then(|| managed.parent().unwrap().to_path_buf())
}

fn git(cwd: &Path) -> CmdResult<Command> {
    let bin = find_git().ok_or("Git ist nicht installiert.")?;
    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    Ok(cmd)
}

pub fn git_output(cwd: &Path, args: &[&str]) -> CmdResult<String> {
    let out = git(cwd)?.args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    /// Index- und Arbeitsbaum-Status aus `git status --porcelain` (z. B. "M", "A", "?")
    index: String,
    worktree: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    available: bool,
    is_repo: bool,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
}

#[tauri::command]
pub fn git_status(cwd: String) -> GitStatus {
    let root = PathBuf::from(&cwd);
    let empty = |available, is_repo| GitStatus { available, is_repo, branch: None, upstream: None, ahead: 0, behind: 0, files: vec![] };
    if find_git().is_none() {
        return empty(false, false);
    }
    let Ok(text) = git_output(&root, &["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]) else {
        return empty(true, false);
    };
    let mut status = empty(true, true);
    let mut parts = text.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(entry) = parts.next() {
        if let Some(head) = entry.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" oder "No commits yet on main"
            let head = head.trim_start_matches("No commits yet on ");
            let (names, track) = head.split_once(" [").map_or((head, ""), |(a, b)| (a, b));
            let (branch, upstream) = names.split_once("...").map_or((names, None), |(b, u)| (b, Some(u.to_string())));
            status.branch = Some(branch.to_string());
            status.upstream = upstream;
            for part in track.trim_end_matches(']').split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (&entry[0..1], &entry[1..2]);
        let path = entry[3..].to_string();
        if x == "R" || x == "C" {
            parts.next(); // Ursprungspfad bei Umbenennungen
        }
        status.files.push(GitFile { path, index: x.trim().to_string(), worktree: y.trim().to_string() });
    }
    status
}

#[tauri::command]
pub fn git_diff(cwd: String, path: String, staged: bool) -> CmdResult<String> {
    let root = PathBuf::from(&cwd);
    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path.as_str()]);
    git_output(&root, &args)
}

/// Inhalt einer Datei im letzten Commit (für den Vergleich im Editor).
#[tauri::command]
pub fn git_show_head(cwd: String, path: String) -> CmdResult<String> {
    git_output(Path::new(&cwd), &["show", &format!("HEAD:{path}")])
}

#[tauri::command]
pub fn git_run(cwd: String, action: String, paths: Option<Vec<String>>, arg: Option<String>) -> CmdResult<String> {
    let root = PathBuf::from(&cwd);
    let paths = paths.unwrap_or_default();
    let p: Vec<&str> = paths.iter().map(String::as_str).collect();
    let with_paths = |base: &[&str]| -> Vec<String> { base.iter().map(|s| s.to_string()).chain(std::iter::once("--".into())).chain(p.iter().map(|s| s.to_string())).collect() };
    let args: Vec<String> = match action.as_str() {
        "init" => vec!["init".into()],
        "stage" => with_paths(&["add"]),
        "stage_all" => vec!["add".into(), "-A".into()],
        "unstage" => with_paths(&["restore", "--staged"]),
        "discard" => with_paths(&["restore"]),
        "commit" => vec!["commit".into(), "-m".into(), arg.ok_or("Commit-Nachricht fehlt")?],
        "checkout" => vec!["switch".into(), arg.ok_or("Branch fehlt")?],
        "create_branch" => vec!["switch".into(), "-c".into(), arg.ok_or("Branch fehlt")?],
        "push" => vec!["push".into()],
        "push_upstream" => vec!["push".into(), "-u".into(), "origin".into(), "HEAD".into()],
        "pull" => vec!["pull".into(), "--ff-only".into()],
        "fetch" => vec!["fetch".into()],
        other => return Err(format!("Unbekannte Git-Aktion {other}")),
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git_output(&root, &refs)
}

#[tauri::command]
pub fn git_log(cwd: String, limit: Option<u32>) -> CmdResult<Vec<serde_json::Value>> {
    let n = format!("-{}", limit.unwrap_or(30));
    let text = git_output(Path::new(&cwd), &["log", &n, "--date=iso-strict", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s"]).unwrap_or_default();
    Ok(text
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            (f.len() == 4).then(|| json!({ "hash": f[0], "author": f[1], "date": f[2], "subject": f[3] }))
        })
        .collect())
}

#[tauri::command]
pub fn git_branches(cwd: String) -> CmdResult<Vec<String>> {
    Ok(git_output(Path::new(&cwd), &["branch", "--format=%(refname:short)"])?.lines().map(str::to_string).collect())
}

/// Installiert MinGit unter Windows (offizielles Release von git-for-windows).
#[tauri::command]
pub async fn install_git(app: AppHandle) -> CmdResult<()> {
    if !cfg!(windows) {
        return Err(if cfg!(target_os = "macos") {
            "Unter macOS bringt Apple Git mit: Im Terminal „xcode-select --install“ ausführen.".into()
        } else {
            "Bitte Git über die Paketverwaltung installieren (z. B. „sudo apt install git“ oder „sudo dnf install git“).".into()
        });
    }
    let _ = app.emit("install:progress", json!({ "stage": "git", "line": "Suche aktuelles MinGit …" }));
    let client = reqwest::Client::builder().user_agent("Brise").build().map_err(|e| e.to_string())?;
    let release: serde_json::Value = client
        .get("https://api.github.com/repos/git-for-windows/git/releases/latest")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "64-bit" };
    let asset = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.starts_with("MinGit-") && n.ends_with(&format!("-{arch}.zip")) && !n.contains("busybox")))
        .ok_or("MinGit-Download nicht gefunden")?;
    let url = asset["browser_download_url"].as_str().ok_or("Keine Download-URL")?;
    let _ = app.emit("install:progress", json!({ "stage": "git", "line": format!("Lade {} …", asset["name"].as_str().unwrap_or("MinGit")) }));
    let bytes = client.get(url).send().await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    let dest = data_dir().join("mingit");
    let _ = std::fs::remove_dir_all(&dest);
    zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec()))
        .and_then(|mut z| z.extract(&dest))
        .map_err(|e| format!("Entpacken fehlgeschlagen: {e}"))?;
    let _ = app.emit("install:progress", json!({ "stage": "done", "line": "Git ist installiert." }));
    Ok(())
}

#[tauri::command]
pub fn git_available() -> bool {
    find_git().is_some()
}
