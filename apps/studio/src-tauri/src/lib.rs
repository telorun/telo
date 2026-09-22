mod background_command;
mod cli_runner;
mod local_runner;

use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // A webview has no handler for external navigation, so every link to a
        // running app's endpoint is inert without this. Scoped to http/https
        // (plus mailto/tel) by `opener:allow-default-urls` in the capability.
        .plugin(tauri_plugin_opener::init())
        .manage(local_runner::LocalRunnerState::default())
        .manage(cli_runner::CliRunnerState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Both supervisors: a session of either kind outliving the
                // editor is a container or a process holding the user's ports
                // with nothing left that knows about it.
                let docker = window
                    .state::<local_runner::LocalRunnerState>()
                    .inner()
                    .clone();
                local_runner::teardown_on_close(docker);
                let cli = window.state::<cli_runner::CliRunnerState>().inner().clone();
                cli_runner::teardown_on_close(cli);
            }
        })
        .invoke_handler(tauri::generate_handler![
            local_runner::local_runner_probe,
            local_runner::local_runner_status,
            local_runner::local_runner_ensure,
            local_runner::local_runner_teardown,
            cli_runner::cli_runner_probe,
            cli_runner::cli_runner_status,
            cli_runner::cli_runner_ensure,
            cli_runner::cli_runner_teardown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
