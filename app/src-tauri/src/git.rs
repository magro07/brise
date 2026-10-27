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
    // Brise-Konto als Autor, wenn so eingestellt (profile.rs).
    let args: Vec<String> = if action == "commit" { crate::profile::commit_identity().into_iter().chain(args).collect() } else { args };
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

// ---------- Worktrees für Untersessions (siehe orchestra.rs) ----------

/// Wurzel des Repos, zu dem `cwd` gehört.
pub fn repo_root(cwd: &Path) -> Option<PathBuf> {
    git_output(cwd, &["rev-parse", "--show-toplevel"]).ok().map(|s| PathBuf::from(s.trim())).filter(|p| !p.as_os_str().is_empty())
}

/// Aktueller Branch; `None` ohne Commits oder bei losgelöstem HEAD.
pub fn current_branch(cwd: &Path) -> Option<String> {
    git_output(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Neuer Worktree auf neuem Branch, abgezweigt vom aktuellen Stand.
pub fn worktree_add(repo: &Path, path: &Path, branch: &str) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let path = path.to_string_lossy();
    git_output(repo, &["worktree", "add", "-b", branch, &path, "HEAD"]).map(|_| ())
}

/// Entfernt einen Worktree (nur, wenn er sauber ist) und danach den Branch, falls gemerged.
pub fn worktree_remove(repo: &Path, path: &Path, branch: &str) -> CmdResult<()> {
    git_output(repo, &["worktree", "remove", &path.to_string_lossy()])?;
    git_output(repo, &["branch", "-d", branch]).map(|_| ())
}

/// Commits auf `branch`, die `base` noch nicht hat.
pub fn ahead_of(cwd: &Path, base: &str, branch: &str) -> u32 {
    git_output(cwd, &["rev-list", "--count", &format!("{base}..{branch}")]).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Laut `git status`: geänderte versionierte Dateien und nicht versionierte.
pub fn dirty_files(cwd: &Path) -> (Vec<String>, Vec<String>) {
    let (mut changed, mut untracked) = (vec![], vec![]);
    for l in git_output(cwd, &["status", "--porcelain=v1", "--untracked-files=normal"]).unwrap_or_default().lines().filter(|l| l.len() > 3) {
        if l.starts_with("??") { &mut untracked } else { &mut changed }.push(l[3..].to_string());
    }
    (changed, untracked)
}

/// Kurzfassung der Änderungen von `branch` gegenüber `base` (Commits und Diffstat).
pub fn branch_summary(cwd: &Path, base: &str, branch: &str) -> (Vec<String>, String) {
    let range = format!("{base}..{branch}");
    let commits = git_output(cwd, &["log", "--pretty=format:%h %s", "-20", &range]).unwrap_or_default().lines().map(str::to_string).collect();
    let stat = git_output(cwd, &["diff", "--shortstat", &format!("{base}...{branch}")]).unwrap_or_default().trim().to_string();
    (commits, stat)
}

/// Merged `branch` in den aktuellen Branch von `repo` (immer mit Merge-Commit).
/// Bei Konflikten wird der Merge abgebrochen; der Fehler nennt die Dateien.
pub fn merge_branch(repo: &Path, branch: &str, message: &str) -> CmdResult<String> {
    match git_output(repo, &["merge", "--no-ff", "--no-edit", "-m", message, branch]) {
        Ok(_) => Ok(git_output(repo, &["rev-parse", "--short", "HEAD"]).unwrap_or_default().trim().to_string()),
        Err(err) => {
            let conflicts = git_output(repo, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
            let _ = git_output(repo, &["merge", "--abort"]);
            let files: Vec<&str> = conflicts.lines().filter(|l| !l.is_empty()).collect();
            Err(if files.is_empty() { err } else { format!("Konflikte in {} – Merge abgebrochen", files.join(", ")) })
        }
    }
}
