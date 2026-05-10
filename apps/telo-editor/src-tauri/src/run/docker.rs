use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::bundle::BundleWorkdir;
use super::session::{SessionEntry, SessionRegistry};

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
) -> Result<(), String> {
    let container_name = format!("telo-run-{session_id}");
    let mount_spec = format!("{}:/srv", bundle_dir.path().display());
    let entry_arg = format!("./{}", entry_relative_path.trim_start_matches("./"));

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
    cmd.arg(&config.image);
    cmd.arg(&entry_arg);

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

    registry.insert(
        session_id.clone(),
        SessionEntry {
            container_name: container_name.clone(),
            docker_host: config.docker_host.clone(),
            user_stop: user_stop.clone(),
            stdin: stdin_handle,
            _bundle: bundle_dir,
        },
    );

    // Single Channel for both stdout (PTY-merged container output) and
    // stderr (docker CLI diagnostics) — semantically the same byte stream
    // the user would see running `docker run` interactively.
    //
    // The two reader tasks send concurrently into one Channel<Vec<u8>>. A
    // single `read()` is delivered as one channel message, so per-message
    // atomicity is preserved, but a logical line that spans multiple reads
    // (or a stderr line that lands between two stdout chunks) can interleave.
    // Accepted for v1: in normal operation the docker-CLI stderr is empty,
    // and matches what a user sees running `docker run` in a terminal.
    spawn_byte_reader(stdout, io_channel.clone());
    spawn_byte_reader(stderr, io_channel);

    let endpoints = build_endpoints(&ports, config.docker_host.as_deref());
    emit_status(&app, &session_id, &RunStatus::Running { endpoints });

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

fn apply_docker_host(cmd: &mut Command, docker_host: Option<&str>) {
    if let Some(host) = docker_host {
        if !host.is_empty() {
            cmd.env("DOCKER_HOST", host);
        }
    }
}

fn spawn_byte_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    channel: Channel<Vec<u8>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    // Send raw bytes through the Tauri Channel; the JS side
                    // attaches its handler at construction so no message is
                    // lost between spawn and the first delivery. Tauri JSON-
                    // encodes Vec<u8> as a number array on the wire — the JS
                    // adapter normalises that back to Uint8Array.
                    if channel.send(buf[..n].to_vec()).is_err() {
                        // Webview gone — channel send fails, no point continuing.
                        break;
                    }
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
