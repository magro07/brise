mod agent;
mod config;
mod rpc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(agent::AgentState::default())
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
            config::read_config,
            config::write_config_value,
            config::list_project_files,
            config::read_image,
        ])
        .run(tauri::generate_context!())
        .expect("Brise konnte nicht gestartet werden");
}
