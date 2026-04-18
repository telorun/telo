mod run;

use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(run::session::SessionRegistry::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let registry = window.state::<run::session::SessionRegistry>().inner().clone();
                run::kill_all_on_close(registry);
            }
        })
        .invoke_handler(tauri::generate_handler![
            run::run_start,
            run::run_stop,
            run::run_probe_docker,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
