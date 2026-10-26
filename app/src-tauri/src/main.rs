// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `brise --mcp-search <ordner>`: Suche als MCP-Server für Vibe, ohne Fenster.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--self-test") {
        std::process::exit(brise_lib::run_self_test());
    }
    if args.get(1).map(String::as_str) == Some("--mcp-app") {
        brise_lib::run_mcp_app();
        return;
    }
    if args.get(1).map(String::as_str) == Some("--mcp-council") {
        if let Some(cwd) = args.get(2) {
            brise_lib::run_mcp_council(cwd.clone());
            return;
        }
    }
    if args.get(1).map(String::as_str) == Some("--mcp-search") {
        if let Some(cwd) = args.get(2) {
            brise_lib::run_mcp_search(cwd.clone());
            return;
        }
    }
    brise_lib::run()
}
