mod accounts;
mod agent;
mod collab;
mod assist;
mod backends;
mod bench;
mod decision;
mod git;
mod computer;
mod config;
mod cortecs;
mod credentials;
mod council;
mod design;
mod customize;
mod embeddings;
mod files;
mod meter;
mod mistral;
mod mistral_proxy;
mod thinking;
mod model3d;
mod models;
mod orchestra;
mod skills;
mod terminal;
mod usage;
mod policy;
mod profile;
mod providers;
mod installer;
mod rpc;
mod selftest;
mod secrets;
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(agent::AgentState::default())
        .manage(terminal::Terminals::default())
        .manage(meter::Meter::default())
        .manage(collab::CollabState::default())
        .setup(|app| {
            customize::watch(app.handle().clone());
            secrets::startup_cleanup();
            secrets::watch(app.handle().clone());
            providers::migrate();
            match cortecs::start_proxy() {
                Ok(_) => {
                    tauri::async_runtime::spawn(async {
                        if let Err(e) = providers::sync_vibe().await {
                            eprintln!("Anbieter in Vibe eintragen: {e}");
                        }
                    });
                }
                Err(e) => eprintln!("Cortecs-Proxy: {e}"),
            }
            collab::start(app.handle());
            orchestra::start(app.handle());
            computer::start(app.handle());
            if let Err(err) = policy::apply() {
                eprintln!("Team-Richtlinie anwenden: {err}");
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
            profile::profile_get,
            profile::profile_save,
            profile::profile_skip,
            providers::providers_list,
            providers::provider_save,
            providers::provider_delete,
            providers::provider_set_key,
            providers::provider_delete_key,
            providers::provider_check,
            providers::provider_models,
            providers::provider_test_model,
            providers::provider_function_model,
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
            secrets::secrets_pending,
            secrets::secret_answer,
            secrets::secret_save,
            secrets::secrets_list,
            secrets::secret_delete,
            secrets::secret_set_scope,
            secrets::secret_scan,
            collab::collab_share,
            collab::collab_publish,
            collab::collab_set_role,
            collab::collab_set_default_role,
            collab::collab_remove,
            collab::collab_queue_take,
            collab::collab_unshare,
            collab::collab_join,
            collab::collab_guest_prompt,
            collab::collab_guest_cancel,
            collab::collab_leave,
            collab::collab_status,
            collab::collab_set_policy,
            collab::collab_session_meta,
            collab::team::collab_team_create,
            collab::team::collab_team_join,
            collab::team::collab_team_leave,
            collab::team::collab_team_projects,
            collab::team::collab_team_profile,
            collab::team::collab_teams,
            collab::team::collab_team_set_admin,
            collab::team::collab_team_remove_member,
            collab::team::collab_team_set_policy,
            collab::team::collab_team_claim,
            collab::team::collab_team_usage,
            policy::policy_effective,
            design::design_root,
            design::design_read,
            design::design_write,
            design::design_write_base64,
            design::design_data_url,
            design::design_list,
            design::design_dirs,
            design::design_copy,
            design::design_remove,
            design::design_export,
            design::design_import_tokens,
            model3d::model_root,
            model3d::model_read,
            model3d::model_bytes,
            model3d::model_write,
            model3d::model_write_base64,
            model3d::model_list,
            model3d::model_dirs,
            model3d::model_copy,
            model3d::model_remove,
            model3d::model_export,
            model3d::model_tools,
            model3d::model_openscad,
            bench::bench_list,
            bench::bench_get,
            bench::bench_save,
            bench::bench_delete,
            bench::bench_dir,
            bench::bench_runs,
            bench::bench_delete_run,
            bench::bench_status,
            bench::bench_run,
            bench::bench_cancel,
            orchestra::orch_state,
            orchestra::orch_reply,
            orchestra::orch_register,
            orchestra::orch_status,
            orchestra::orch_accept,
            orchestra::orch_decline,
            orchestra::orch_merge,
            orchestra::orch_reject,
            orchestra::orch_forget,
            orchestra::orch_costs,
            computer::cu_status,
            computer::cu_set_enabled,
            computer::cu_set_project,
            computer::cu_stop,
            computer::cu_request_access,
            computer::cu_prepare,
        ])
        .run(tauri::generate_context!())
        .expect("Brise konnte nicht gestartet werden");
}
