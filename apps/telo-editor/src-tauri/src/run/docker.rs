use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
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

#[derive(Debug, Clone, Serialize)]
pub struct OutputChunk {
    pub chunk: String,
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
) -> Result<(), String> {
    let container_name = format!("telo-run-{session_id}");
    let mount_spec = format!("{}:/srv", bundle_dir.path().display());
    let entry_arg = format!("./{}", entry_relative_path.trim_start_matches("./"));

    let mut cmd = Command::new("docker");
    cmd.arg("run").arg("--rm").arg("-i");
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
    // FORCE_COLOR / CLICOLOR_FORCE: telo's CLI sees a pipe (not a TTY) on
    // stdout/stderr — most CLIs strip ANSI in that case. Injecting these
    // env vars is the standard way to keep color output flowing without
    // allocating a PTY (`-t`), which would muddle stdout/stderr separation.
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

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
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

    let user_stop = Arc::new(AtomicBool::new(false));
    registry.insert(
        session_id.clone(),
        SessionEntry {
            container_name: container_name.clone(),
            docker_host: config.docker_host.clone(),
            user_stop: user_stop.clone(),
            _bundle: bundle_dir,
        },
    );

    spawn_reader(app.clone(), stdout, format!("run:{session_id}:stdout"));
    spawn_reader(app.clone(), stderr, format!("run:{session_id}:stderr"));

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

fn spawn_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    app: AppHandle,
    mut reader: R,
    event_name: String,
) {
    tauri::async_runtime::spawn(async move {
        // `tail` holds the trailing bytes of the last read that looked like
        // the start of a multi-byte UTF-8 sequence whose continuation bytes
        // hadn't arrived yet. Without it, CJK/emoji/box-drawing characters
        // straddling a buffer boundary decode as U+FFFD replacement chars.
        let mut buf = vec![0u8; 8192];
        let mut tail: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => {
                    if !tail.is_empty() {
                        // Final flush: emit whatever's left, lossy — any
                        // unterminated sequence at EOF is genuinely broken.
                        let chunk = String::from_utf8_lossy(&tail).into_owned();
                        let _ = app.emit(&event_name, OutputChunk { chunk });
                    }
                    break;
                }
                Ok(n) => {
                    let mut combined = std::mem::take(&mut tail);
                    combined.extend_from_slice(&buf[..n]);
                    let (valid_up_to, pending) = split_at_incomplete_utf8(&combined);
                    tail = combined[valid_up_to..].to_vec();
                    // `combined[..valid_up_to]` is valid UTF-8 by construction.
                    let chunk = match std::str::from_utf8(&combined[..valid_up_to]) {
                        Ok(s) => s.to_owned(),
                        Err(_) => String::from_utf8_lossy(&combined[..valid_up_to]).into_owned(),
                    };
                    let _ = (pending, app.emit(&event_name, OutputChunk { chunk }));
                }
                Err(_) => break,
            }
        }
    });
}

/// Returns `(valid_up_to, pending_len)` such that `bytes[..valid_up_to]` is
/// complete, valid UTF-8 and `bytes[valid_up_to..]` is either empty or the
/// start of a multi-byte sequence whose continuation bytes haven't arrived.
fn split_at_incomplete_utf8(bytes: &[u8]) -> (usize, usize) {
    match std::str::from_utf8(bytes) {
        Ok(_) => (bytes.len(), 0),
        Err(e) => {
            let valid = e.valid_up_to();
            // If `error_len` is `Some`, the invalid sequence is genuinely
            // malformed (not just incomplete). In that case we let the lossy
            // decoder handle it in the next iteration — buffer only if the
            // tail is the start of a cut-off multi-byte sequence.
            match e.error_len() {
                None => (valid, bytes.len() - valid),
                Some(_) => (bytes.len(), 0),
            }
        }
    }
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
