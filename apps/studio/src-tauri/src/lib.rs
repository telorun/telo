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
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window
                    .state::<local_runner::LocalRunnerState>()
                    .inner()
                    .clone();
                local_runner::teardown_on_close(state);
            }
        })
        .invoke_handler(tauri::generate_handler![
            local_runner::local_runner_probe,
            local_runner::local_runner_status,
            local_runner::local_runner_ensure,
            local_runner::local_runner_teardown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
