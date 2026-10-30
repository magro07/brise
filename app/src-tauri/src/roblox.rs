//! Roblox Studio bringt einen eigenen MCP-Server mit. Brise sucht ihn selbst,
//! damit niemand Pfade oder JSON eintragen muss.

use std::path::PathBuf;

use serde_json::{json, Value};

fn off_flag() -> PathBuf {
    crate::installer::data_dir().join("roblox-mcp-off")
}

fn launcher() -> Option<PathBuf> {
    let path = if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Roblox").join("mcp.bat")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP")
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".local/bin/roblox-studio-mcp")
    };
    path.exists().then_some(path)
}

/// Schon in Vibes Konfiguration eingetragen? Dann nicht doppelt anmelden.
fn external() -> bool {
    crate::config::config_path().ok().and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|t| t.contains("name = \"roblox-studio\""))
}

pub fn mcp_entry() -> Option<Value> {
    if off_flag().exists() || external() {
        return None;
    }
    let path = launcher()?;
    let env = crate::agent::child_env();
    Some(if cfg!(windows) {
        json!({ "name": "Roblox_Studio", "command": "cmd.exe", "args": ["/c", path.display().to_string()], "env": env })
    } else {
        json!({ "name": "Roblox_Studio", "command": path.display().to_string(), "args": [], "env": env })
    })
}

#[tauri::command]
pub fn roblox_status() -> Value {
    json!({ "path": launcher().map(|p| p.display().to_string()), "enabled": !off_flag().exists(), "external": external() })
}

#[tauri::command]
pub fn roblox_set_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        let _ = std::fs::remove_file(off_flag());
        Ok(())
    } else {
        std::fs::write(off_flag(), "").map_err(|e| e.to_string())
    }
}
