pub mod availability;
pub mod bundle;
pub mod docker;
pub mod session;

use std::collections::HashMap;

use tauri::{AppHandle, State};

use availability::AvailabilityReport;
use bundle::{BundleWorkdir, RunBundlePayload};
use docker::{PortMapping, TauriDockerConfig};
use session::SessionRegistry;

#[tauri::command]
pub async fn run_start(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    session_id: String,
    bundle: RunBundlePayload,
    env: Option<HashMap<String, String>>,
    ports: Option<Vec<PortMapping>>,
    config: TauriDockerConfig,
) -> Result<(), String> {
    let workdir = BundleWorkdir::write(&bundle)
        .map_err(|e| format!("Failed to write bundle tempdir: {e}"))?;
    let entry = bundle.entry_relative_path.clone();
    let registry = registry.inner().clone();
    docker::start(
        app,
        registry,
        session_id,
        workdir,
        entry,
        env.unwrap_or_default(),
        ports.unwrap_or_default(),
        config,
    )
    .await
}

#[tauri::command]
pub async fn run_stop(
    registry: State<'_, SessionRegistry>,
    session_id: String,
) -> Result<(), String> {
    let registry = registry.inner().clone();
    docker::stop(registry, session_id).await
}

#[tauri::command]
pub async fn run_probe_docker(config: TauriDockerConfig) -> Result<AvailabilityReport, String> {
    Ok(availability::probe(&config).await)
}

/// Hook for Tauri's `WindowEvent::CloseRequested` — fires `docker kill` for
/// every live session before the editor exits. Runs detached; we don't block
/// the close.
pub fn kill_all_on_close(registry: SessionRegistry) {
    let sessions = registry.all_kill_info();
    if sessions.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        docker::kill_all(sessions).await;
    });
}
