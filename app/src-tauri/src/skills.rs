//! Agent Skills: Brise liefert eine Auswahl mit (rea, ponytail, gauntlet-loop,
//! frontend-design …), kopiert sie in den eigenen Datenordner und trägt diesen
//! in Vibes `skill_paths` ein. Vibe bietet sie dem Modell dann automatisch an.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use toml_edit::{Array, Item, Value as TomlValue};

use crate::config::{edit_config, vibe_home};
use crate::installer::data_dir;

type CmdResult<T> = Result<T, String>;

pub fn skills_dir() -> PathBuf {
    data_dir().join("skills")
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Kopiert die mitgelieferten Skills (bei jedem Start, damit Updates ankommen)
/// und sorgt dafür, dass Vibe den Ordner kennt. Liefert `true`, wenn
/// config.toml geändert wurde.
pub fn install_bundled(app: &tauri::AppHandle) -> CmdResult<bool> {
    let source = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("skills");
    let target = skills_dir();
    if source.is_dir() {
        for entry in std::fs::read_dir(&source).map_err(|e| e.to_string())?.flatten() {
            if entry.path().is_dir() {
                let dest = target.join(entry.file_name());
                let _ = std::fs::remove_dir_all(&dest);
                copy_dir(&entry.path(), &dest).map_err(|e| e.to_string())?;
            }
        }
        let _ = std::fs::copy(source.join("NOTICE.md"), target.join("NOTICE.md"));
    }

    let wanted = target.display().to_string();
    edit_config(|doc| {
        let has = doc
            .get("skill_paths")
            .and_then(Item::as_array)
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(wanted.as_str())));
        if !has {
            let mut arr = doc.get("skill_paths").and_then(Item::as_array).cloned().unwrap_or_else(Array::new);
            arr.push(wanted.as_str());
            doc.insert("skill_paths", Item::Value(TomlValue::Array(arr)));
        }
        Ok(())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    description: String,
    path: String,
    /// "brise", "user" oder "project"
    source: String,
    license: Option<String>,
}

/// Liest `name`, `description` und `license` aus dem YAML-Kopf von SKILL.md.
fn frontmatter(text: &str) -> (Option<String>, String, Option<String>) {
    let mut name = None;
    let mut desc = String::new();
    let mut license = None;
    let Some(rest) = text.strip_prefix("---") else { return (None, desc, None) };
    let head = rest.split("\n---").next().unwrap_or("");
    let mut in_desc = false;
    for line in head.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').to_string());
            in_desc = false;
        } else if let Some(v) = line.strip_prefix("license:") {
            license = Some(v.trim().trim_matches('"').to_string());
            in_desc = false;
        } else if let Some(v) = line.strip_prefix("description:") {
            let v = v.trim();
            // YAML-Blockschreibweisen: >, |, >-, |-, >+, |+
            in_desc = matches!(v, "" | ">" | "|" | ">-" | "|-" | ">+" | "|+");
            desc = if in_desc { String::new() } else { v.trim_matches('"').to_string() };
        } else if in_desc && (line.starts_with(' ') || line.starts_with('\t')) {
            if !desc.is_empty() {
                desc.push(' ');
            }
            desc.push_str(line.trim());
        } else {
            in_desc = false;
        }
    }
    (name, desc, license)
}

fn scan(dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.path().join("SKILL.md");
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let (name, description, license) = frontmatter(&text);
        let name = name.unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
        if out.iter().any(|s| s.name == name) {
            continue;
        }
        out.push(SkillInfo { name, description, path: entry.path().display().to_string(), source: source.into(), license });
    }
}

/// Alle Skills, die Vibe für dieses Projekt findet.
#[tauri::command]
pub fn list_skills(cwd: Option<String>) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    if let Some(cwd) = &cwd {
        let root = PathBuf::from(cwd);
        scan(&root.join(".vibe/skills"), "project", &mut out);
        scan(&root.join(".agents/skills"), "project", &mut out);
    }
    if let Some(home) = vibe_home() {
        scan(&home.join("skills"), "user", &mut out);
    }
    if let Some(home) = dirs::home_dir() {
        scan(&home.join(".agents/skills"), "user", &mut out);
    }
    scan(&skills_dir(), "brise", &mut out);
    out.sort_by(|a, b| a.source.cmp(&b.source).then(a.name.cmp(&b.name)));
    out
}

/// Ist `npx` (Node.js) vorhanden? Nötig für die REA-Werkzeuge.
pub fn find_npx() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "npx.cmd" } else { "npx" };
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()))
}

#[tauri::command]
pub fn npx_available() -> bool {
    find_npx().is_some()
}

// ---------- Subagent-Profile ----------

pub fn agents_dir() -> PathBuf {
    data_dir().join("agents")
}

/// Schreibt Brises Subagent-Profile (explore, researcher) und trägt den
/// Ordner in Vibes `agent_paths` ein. Ein eigenes Modell pro Subagent setzt
/// Vibe derzeit nicht um (`active_model` wird für Subagents ignoriert).
pub fn write_agent_profiles() -> CmdResult<bool> {
    let dir = agents_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let m = "";
    let explore = format!(
        r#"# Von Brise verwaltet – Änderungen in Brise unter Einstellungen → Agents.
display_name = "Explore"
description = "Read-only subagent for codebase exploration (grep, read, semantic search)"
safety = "safe"
agent_type = "subagent"
enabled_tools = ["grep", "read_file", "skill", "mcp_brise_search*"]
system_prompt_id = "explore"
{m}"#
    );
    let researcher = format!(
        r#"# Von Brise verwaltet – Änderungen in Brise unter Einstellungen → Agents.
display_name = "Researcher"
description = "Read-only web research subagent: searches the web, reads primary sources and returns findings with URLs. Use one per sub-question; run several in parallel."
safety = "safe"
agent_type = "subagent"
enabled_tools = ["web_search", "web_fetch", "read_file", "grep", "skill"]
{m}instructions = """
You research one well-defined question on the web.
1. Run several targeted web searches (vary wording, include the current year for recent topics, try English and the user's language).
2. Open the most authoritative sources with web_fetch (official docs, standards, papers, original announcements) – not only snippets.
3. Cross-check every important claim with at least two independent sources; note disagreements and dates.
4. Return concise findings as bullet points, each with the source URL and publication date, plus a short list of open questions and a confidence rating (high/medium/low).
Never invent sources. Prefer recent information and say when something may be outdated.
"""

[tools.web_search]
permission = "always"

[tools.web_fetch]
permission = "always"
"#
    );
    std::fs::write(dir.join("explore.toml"), explore).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("researcher.toml"), researcher).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dir.join(".model"));

    let wanted = dir.display().to_string();
    edit_config(|doc| {
        let has = doc.get("agent_paths").and_then(Item::as_array).is_some_and(|a| a.iter().any(|v| v.as_str() == Some(wanted.as_str())));
        if !has {
            let mut arr = doc.get("agent_paths").and_then(Item::as_array).cloned().unwrap_or_else(Array::new);
            arr.push(wanted.as_str());
            doc.insert("agent_paths", Item::Value(TomlValue::Array(arr)));
        }
        Ok(())
    })
}
