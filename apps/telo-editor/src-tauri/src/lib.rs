mod local_runner;

use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
