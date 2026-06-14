use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::bundle::BundleWorkdir;
use super::session::{OutputHub, SessionEntry, SessionRegistry};

/// Port the workload's `--inspect` server binds inside the container. Published
/// only to host loopback (`127.0.0.1`) — the local editor reads it directly.
const INSPECT_PORT: u16 = 9230;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriDockerConfig {
    pub image: String,
    pub pull_policy: PullPolicy,
    #[serde(default)]
    pub docker_host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullPolicy {
    Missing,
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PortProtocol {
    Tcp,
    Udp,
}

impl PortProtocol {
    fn as_str(&self) -> &'static str {
        match self {
            PortProtocol::Tcp => "tcp",
            PortProtocol::Udp => "udp",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PortMapping {
    pub port: u16,
    pub protocol: PortProtocol,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunnerEndpoint {
    pub host: String,
    pub port: u16,
    pub protocol: PortProtocol,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RunStatus {
    Starting,
    Running { endpoints: Vec<RunnerEndpoint> },
    Exited { code: i32 },
    Failed { message: String },
    Stopped,
}

pub async fn start(
    app: AppHandle,
    registry: SessionRegistry,
    session_id: String,
    bundle_dir: BundleWorkdir,
    entry_relative_path: String,
    env: HashMap<String, String>,
    ports: Vec<PortMapping>,
    config: TauriDockerConfig,
    io_channel: Channel<Vec<u8>>,
    inspect: bool,
) -> Result<(), String> {
    let container_name = format!("telo-run-{session_id}");
    let mount_spec = format!("{}:/srv", bundle_dir.path().display());
    let entry_arg = format!("./{}", entry_relative_path.trim_start_matches("./"));
    // When inspecting, publish the in-container debug port to a free host
    // loopback port; the editor connects its debug panel straight to it.
    let inspect_host_port = if inspect { pick_free_loopback_port() } else { None };

    let mut cmd = Command::new("docker");
    // `-it` allocates a PTY on the container (stdout/stderr merge, line
    // editing + ANSI work, signals propagate). xterm.js consumes the merged
    // byte stream as-is.
    cmd.arg("run").arg("--rm").arg("-it");
    cmd.arg("--name").arg(&container_name);
    match config.pull_policy {
        PullPolicy::Always => {
            cmd.arg("--pull=always");
        }
        PullPolicy::Never => {
            cmd.arg("--pull=never");
        }
        PullPolicy::Missing => {}
    }
    cmd.arg("-v").arg(&mount_spec);
    cmd.arg("-w").arg("/srv");
    // Harmless under PTY mode (TTY is true so most CLIs honour it anyway),
    // kept for any tool that treats CLICOLOR_FORCE specially.
    cmd.arg("-e").arg("FORCE_COLOR=1");
    cmd.arg("-e").arg("CLICOLOR_FORCE=1");
    for (key, value) in &env {
        cmd.arg("-e").arg(format!("{key}={value}"));
    }
    for mapping in &ports {
        cmd.arg("-p").arg(format!(
            "{0}:{0}/{1}",
            mapping.port,
            mapping.protocol.as_str()
        ));
    }
    if let Some(host_port) = inspect_host_port {
        cmd.arg("-p")
            .arg(format!("127.0.0.1:{host_port}:{INSPECT_PORT}"));
    }
    cmd.arg(&config.image);
    cmd.arg(&entry_arg);
    if inspect {
        // 0.0.0.0 (not the CLI's loopback default) so the published port reaches
        // the kernel's debug server across the container boundary.
        cmd.arg("--inspect")
            .arg(format!("0.0.0.0:{INSPECT_PORT}"))
            .arg("--no-open");
    }

    apply_docker_host(&mut cmd, config.docker_host.as_deref());

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    // Container stderr is merged onto stdout under `-t`, but the docker CLI
    // itself still writes diagnostics (pull progress, image-not-found,
    // daemon errors) here. A draining reader keeps the 64 KB pipe from
    // filling — without it docker blocks on its own stderr write.
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    emit_status(&app, &session_id, &RunStatus::Starting);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let message = format!("Failed to spawn docker: {e}");
            emit_status(
                &app,
                &session_id,
                &RunStatus::Failed {
                    message: message.clone(),
                },
            );
            return Err(message);
        }
    };

    let Some(stdout) = child.stdout.take() else {
        return fail_missing_pipe(&app, &session_id, "stdout");
    };
    let Some(stderr) = child.stderr.take() else {
        return fail_missing_pipe(&app, &session_id, "stderr");
    };
    let Some(stdin) = child.stdin.take() else {
        return fail_missing_pipe(&app, &session_id, "stdin");
    };

    let user_stop = Arc::new(AtomicBool::new(false));
    let stdin_handle = Arc::new(tokio::sync::Mutex::new(Some(stdin)));

    let endpoints = build_endpoints(&ports, config.docker_host.as_deref());
    let inspect_url = inspect_host_port.map(|port| format!("http://127.0.0.1:{port}"));

    // The hub owns the seam between the container's byte stream and the editor
    // webview. The reader tasks push into it for the container's whole lifetime,
    // so the stdout pipe is never dropped while the workload runs — a webview
    // reload can't SIGPIPE `docker run` and tear the container down. A later
    // `reattach` swaps in a fresh Channel and replays the buffered scrollback.
    let hub = OutputHub::new_shared(io_channel);

    registry.insert(
        session_id.clone(),
        SessionEntry {
            container_name: container_name.clone(),
            docker_host: config.docker_host.clone(),
            user_stop: user_stop.clone(),
            stdin: stdin_handle,
            output: hub.clone(),
            endpoints: endpoints.clone(),
            inspect_url: inspect_url.clone(),
            _bundle: bundle_dir,
        },
    );

    // Single hub for both stdout (PTY-merged container output) and stderr
    // (docker CLI diagnostics) — semantically the same byte stream the user
    // would see running `docker run` interactively.
    //
    // The two reader tasks push concurrently into one hub. A single `read()`
    // becomes one buffered chunk, so per-chunk atomicity is preserved, but a
    // logical line spanning multiple reads (or a stderr line between two stdout
    // chunks) can interleave. Accepted for v1: in normal operation the docker-CLI
    // stderr is empty, and matches what a user sees running `docker run`.
    spawn_byte_reader(stdout, hub.clone());
    spawn_byte_reader(stderr, hub);

    emit_status(&app, &session_id, &RunStatus::Running { endpoints });

    // Announce the debug endpoint so the editor's debug panel can attach. The
    // workload's debug port is published to host loopback only.
    if let Some(url) = &inspect_url {
        let _ = app.emit(
            &format!("run:{session_id}:debug-endpoint"),
            serde_json::json!({ "url": url }),
        );
    }

    let exit_app = app.clone();
    let exit_registry = registry.clone();
    let exit_session_id = session_id.clone();
    let exit_user_stop = user_stop;
    tauri::async_runtime::spawn(async move {
        let final_status = match child.wait().await {
            Ok(exit) => {
                if exit_user_stop.load(Ordering::SeqCst) {
                    RunStatus::Stopped
                } else {
                    match exit.code() {
                        Some(code) => RunStatus::Exited { code },
                        None => RunStatus::Failed {
                            message: "docker process terminated by signal".into(),
                        },
                    }
                }
            }
            Err(e) => RunStatus::Failed {
                message: format!("failed to await docker: {e}"),
            },
        };
        emit_status(&exit_app, &exit_session_id, &final_status);
        exit_registry.remove(&exit_session_id);
    });

    Ok(())
}

/// Re-bind a session that survived a webview reload to a fresh output Channel.
///
/// The editor process (and thus the `SessionRegistry` + the container) outlives
/// the webview, so a reload only loses the JS-side Channel and event listeners.
/// This replays the buffered scrollback into the new Channel, makes it live, and
/// re-announces status + the debug endpoint so the editor restores the run.
/// Stdin keeps flowing through the original `docker run` pipe (`run_send_input`),
/// so the terminal stays interactive. Returns `false` when the session is gone
/// (exited and removed, or the editor process restarted) — the editor then marks
/// the run's history unavailable.
pub async fn reattach(
    app: AppHandle,
    registry: SessionRegistry,
    session_id: String,
    io_channel: Channel<Vec<u8>>,
) -> Result<bool, String> {
    let Some(info) = registry.reattach_info(&session_id) else {
        return Ok(false);
    };

    // Replay scrollback into the fresh Channel and make it the live subscriber.
    info.output.lock().unwrap().attach(io_channel);

    // Restore the running banner and reconnect the debug panel, mirroring the
    // tail of `start`. The session's own exit-waiter remains the source of truth
    // for the eventual terminal status, so we don't emit one here.
    emit_status(
        &app,
        &session_id,
        &RunStatus::Running {
            endpoints: info.endpoints,
        },
    );
    if let Some(url) = &info.inspect_url {
        let _ = app.emit(
            &format!("run:{session_id}:debug-endpoint"),
            serde_json::json!({ "url": url }),
        );
    }

    Ok(true)
}

pub async fn stop(registry: SessionRegistry, session_id: String) -> Result<(), String> {
    let Some((container_name, docker_host, user_stop)) = registry.kill_info(&session_id) else {
        return Ok(());
    };

    user_stop.store(true, Ordering::SeqCst);

    let mut cmd = Command::new("docker");
    cmd.arg("kill").arg(&container_name);
    apply_docker_host(&mut cmd, docker_host.as_deref());

    // Fire and forget — the exit task is the source of truth for the final
    // status event. If docker kill fails because the container already exited,
    // that's fine; the exit task has already (or is about to) emit `exited`.
    let _ = cmd.output().await;
    Ok(())
}

pub async fn send_input(
    registry: SessionRegistry,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let Some(handle) = registry.stdin_handle(&session_id) else {
        return Ok(());
    };
    let mut guard = handle.lock().await;
    let Some(stdin) = guard.as_mut() else {
        return Ok(());
    };
    if let Err(err) = stdin.write_all(&bytes).await {
        // Pipe may be gone (container exited mid-write). Drop the handle so
        // subsequent calls no-op rather than retry on a dead fd.
        guard.take();
        return Err(format!("failed to write stdin: {err}"));
    }
    Ok(())
}

pub async fn close_input(
    registry: SessionRegistry,
    session_id: String,
) -> Result<(), String> {
    let Some(handle) = registry.stdin_handle(&session_id) else {
        return Ok(());
    };
    let mut guard = handle.lock().await;
    // Drop the ChildStdin — the kernel closes the pipe and the container
    // sees EOF on its stdin.
    guard.take();
    Ok(())
}

pub async fn resize(
    registry: SessionRegistry,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let Some((container_name, docker_host)) = registry.container_for_resize(&session_id) else {
        return Ok(());
    };
    let mut cmd = Command::new("docker");
    cmd.arg("resize")
        .arg(&container_name)
        .arg("--height")
        .arg(rows.to_string())
        .arg("--width")
        .arg(cols.to_string());
    apply_docker_host(&mut cmd, docker_host.as_deref());

    // Best-effort: a resize against a freshly-exited container 404s, which
    // is fine — the exit task already drove the UI to a terminal status.
    let _ = cmd.output().await;
    Ok(())
}

pub async fn kill_all(sessions: Vec<(String, Option<String>)>) {
    for (container_name, docker_host) in sessions {
        let mut cmd = Command::new("docker");
        cmd.arg("kill").arg(&container_name);
        apply_docker_host(&mut cmd, docker_host.as_deref());
        let _ = cmd.output().await;
    }
}

/// Grab a free host loopback port by binding `:0` and reading the assigned
/// port, then releasing it. Mildly racy (another process could claim it before
/// docker publishes), but adequate for a local single-user dev runner.
fn pick_free_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

fn apply_docker_host(cmd: &mut Command, docker_host: Option<&str>) {
    if let Some(host) = docker_host {
        if !host.is_empty() {
            cmd.env("DOCKER_HOST", host);
        }
    }
}

fn spawn_byte_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    hub: Arc<Mutex<OutputHub>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    // Push into the hub, which forwards to the live webview
                    // Channel (if any) and retains a capped transcript. The
                    // reader runs until the pipe closes (container exit) — never
                    // bailing when the webview goes away — so the pipe stays open
                    // and the container survives a reload. The hub JSON-encodes
                    // Vec<u8> as a number array on the wire; the JS adapter
                    // normalises that back to Uint8Array.
                    hub.lock().unwrap().push(buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
    });
}

fn emit_status(app: &AppHandle, session_id: &str, status: &RunStatus) {
    let _ = app.emit(&format!("run:{session_id}:status"), status);
}

fn build_endpoints(ports: &[PortMapping], docker_host: Option<&str>) -> Vec<RunnerEndpoint> {
    if ports.is_empty() {
        return Vec::new();
    }
    let host = resolve_runner_host(docker_host);
    ports
        .iter()
        .map(|m| RunnerEndpoint {
            host: host.clone(),
            port: m.port,
            protocol: m.protocol,
        })
        .collect()
}

/// Resolves the hostname a user on the host machine should hit to reach a
/// forwarded container port. For a local socket (unset or `unix://...`) this
/// is `localhost`. For `tcp://host[:port]` it is the `host` component.
/// Unparseable values fall back to `localhost`.
fn resolve_runner_host(docker_host: Option<&str>) -> String {
    let Some(raw) = docker_host else {
        return "localhost".to_string();
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("unix://") || trimmed.starts_with("npipe://") {
        return "localhost".to_string();
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host_part = without_scheme.split('/').next().unwrap_or(without_scheme);
    // Strip trailing `:port` — but preserve an IPv6 literal like `[::1]:2375`.
    let host_only = if let Some(stripped) = host_part.strip_prefix('[') {
        match stripped.split_once(']') {
            Some((inside, _rest)) => format!("[{inside}]"),
            None => host_part.to_string(),
        }
    } else {
        match host_part.rsplit_once(':') {
            Some((h, _)) if !h.is_empty() => h.to_string(),
            _ => host_part.to_string(),
        }
    };
    if host_only.is_empty() {
        "localhost".to_string()
    } else {
        host_only
    }
}

fn fail_missing_pipe(app: &AppHandle, session_id: &str, which: &str) -> Result<(), String> {
    let message = format!("docker process missing {which} pipe");
    emit_status(
        app,
        session_id,
        &RunStatus::Failed {
            message: message.clone(),
        },
    );
    Err(message)
}
