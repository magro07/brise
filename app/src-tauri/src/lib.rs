mod accounts;
mod agent;
mod assist;
mod backends;
mod decision;
mod git;
mod config;
mod cortecs;
mod credentials;
mod council;
mod customize;
mod embeddings;
mod files;
mod meter;
mod mistral;
mod models;
mod skills;
mod terminal;
mod usage;
mod installer;
mod rpc;
mod selftest;
mod sensitive;

pub fn run_mcp_search(cwd: String) {
    embeddings::run_mcp_server(cwd);
}

pub fn run_self_test() -> i32 {
    #[cfg(unix)]
    adopt_shell_path();
    selftest::run()
}

pub fn run_mcp_council(cwd: String) {
    council::run_mcp_server(cwd);
}

pub fn run_mcp_app() {
    customize::run_mcp_server();
}

/// Aus dem Finder bzw. Startmenü gestartete Apps erben unter macOS (und teils
/// Linux) nicht den PATH der Shell – ohne ihn fehlen Homebrew, ~/.local/bin,
/// nvm usw. Deshalb einmal die Login-Shell fragen und ihren PATH übernehmen.
#[cfg(unix)]
fn adopt_shell_path() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", "printf '__BRISE_PATH__%s__END__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while std::time::Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        return;
    }
    let mut out = String::new();
    let _ = child.stdout.take().map(|mut s| s.read_to_string(&mut out));
    let Some(found) = out.split("__BRISE_PATH__").nth(1).and_then(|r| r.split("__END__").next()) else { return };
    let mut paths: Vec<std::path::PathBuf> = std::env::split_paths(found).collect();
    if let Some(current) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&current) {
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        // SAFETY: läuft ganz am Anfang von `run`, bevor weitere Threads starten.
        unsafe { std::env::set_var("PATH", joined) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(unix)]
    adopt_shell_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(agent::AgentState::default())
        .manage(terminal::Terminals::default())
        .manage(meter::Meter::default())
        .setup(|app| {
            customize::watch(app.handle().clone());
            if let Err(e) = cortecs::start_proxy() {
                eprintln!("Cortecs-Proxy: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::agent_connect,
            agent::startup_project,
            agent::auth_status,
            agent::login,
            agent::sign_out,
            agent::new_session,
            agent::load_session,
            agent::list_sessions,
            agent::prompt,
            agent::cancel,
            agent::set_mode,
            agent::respond_permission,
            agent::set_config_option,
            agent::config_schema,
            agent::delete_session,
            agent::disconnect_backend,
            backends::backends_list,
            backends::backend_auth,
            backends::backend_login_command,
            backends::install_backend,
            decision::decision_providers,
            config::read_config,
            config::write_config_value,
            config::list_project_files,
            config::read_image,
            credentials::save_api_key,
            credentials::api_key_info,
            accounts::list_accounts,
            accounts::add_account,
            accounts::update_account,
            accounts::remove_account,
            accounts::set_default_account,
            accounts::set_project_account,
            accounts::set_auto_switch,
            accounts::session_account,
            agent::switch_account,
            agent::reserve_account,
            installer::install_vibe,
            installer::upgrade_vibe,
            installer::install_info,
            embeddings::index_project,
            embeddings::index_status,
            embeddings::delete_index,
            embeddings::semantic_search,
            agent::ext,
            models::model_catalog,
            models::configured_models,
            models::add_model,
            models::remove_model,
            models::startup_check,
            skills::list_skills,
            skills::npx_available,
            assist::classify_task,
            assist::project_suggestions,
            assist::commit_message,
            assist::adjust_reasoning,
            git::git_status,
            git::git_diff,
            git::git_show_head,
            git::git_run,
            git::git_log,
            git::git_branches,
            git::install_git,
            git::git_available,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            files::read_project_file,
            files::write_project_file,
            files::external_editors,
            files::open_in_external,
            mistral::fim_complete,
            mistral::ocr_document,
            files::create_project,
            files::create_path,
            files::default_projects_dir,
            meter::meter_start,
            meter::meter_stop,
            customize::read_customization,
            customize::sync_prefs,
            usage::usage_turn,
            usage::usage_baseline,
            usage::usage_record,
            usage::usage_overview,
            usage::usage_save_settings,
            usage::usage_prices,
            usage::usage_save_prices,
            usage::usage_model_prices,
            usage::usage_import,
            council::council_start,
            council::council_run,
            council::council_find,
            council::council_today,
            cortecs::cortecs_save_key,
            cortecs::cortecs_delete_key,
            cortecs::cortecs_check_key,
            cortecs::cortecs_save_settings,
            cortecs::cortecs_models,
            cortecs::cortecs_add_model,
            cortecs::cortecs_utility_active,
            cortecs::cortecs_status,
            cortecs::cortecs_project_config,
            cortecs::cortecs_classify_task,
            cortecs::cortecs_adjust_reasoning,
            sensitive::sensitivity_check,
        ])
        .run(tauri::generate_context!())
        .expect("Brise konnte nicht gestartet werden");
}
