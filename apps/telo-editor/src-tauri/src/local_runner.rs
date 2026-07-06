//! Local runner supervisor: runs the published docker-runner image as a local
//! container and hands its loopback base URL to the webview. The editor talks
//! to it through the ordinary http-runner adapter — this module only manages
//! the container's lifecycle (explicit user start, kill + cleanup on close).

use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const CONTAINER_NAME: &str = "telo-local-runner";
const VOLUME_NAME: &str = "telo-local-runner-bundles";
/// Port docker-runner listens on inside its container (its default).
const RUNNER_PORT: u16 = 8061;
/// Docker network spawned workload containers join. `bridge` always exists.
const CHILD_NETWORK: &str = "bridge";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AvailabilityReport {
    Ready,
    Unavailable {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        remediation: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunnerStatus {
    pub state: &'static str, // "stopped" | "starting" | "ready"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Default)]
struct StateInner {
    /// Loopback base URL of the adopted/started runner container, cached for
    /// the life of the Rust process (survives webview reloads).
    base_url: Option<String>,
    starting: bool,
}

#[derive(Clone, Default)]
pub struct LocalRunnerState {
    inner: Arc<Mutex<StateInner>>,
    /// Serializes concurrent `ensure` calls (settings button + run banner).
    ensure_lock: Arc<tokio::sync::Mutex<()>>,
}

#[tauri::command]
pub async fn local_runner_probe() -> Result<AvailabilityReport, String> {
    Ok(probe().await)
}

#[tauri::command]
pub async fn local_runner_status(
    state: State<'_, LocalRunnerState>,
) -> Result<LocalRunnerStatus, String> {
    let state = state.inner().clone();
    let base_url = {
        let inner = state.inner.lock().unwrap();
        if inner.starting {
            return Ok(LocalRunnerStatus { state: "starting", base_url: None });
        }
        inner.base_url.clone()
    };
    let Some(base_url) = base_url else {
        return Ok(LocalRunnerStatus { state: "stopped", base_url: None });
    };
    // The container can die out from under the cached URL (docker restarted,
    // user removed it) — verify before reporting ready.
    if container_running().await {
        Ok(LocalRunnerStatus { state: "ready", base_url: Some(base_url) })
    } else {
        let mut inner = state.inner.lock().unwrap();
        // Only clear the URL this probe actually checked — a concurrent
        // `ensure` may have replaced it while the inspect was in flight.
        if inner.base_url.as_deref() == Some(base_url.as_str()) {
            inner.base_url = None;
        }
        Ok(LocalRunnerStatus { state: "stopped", base_url: None })
    }
}

#[tauri::command]
pub async fn local_runner_ensure(
    state: State<'_, LocalRunnerState>,
    image: String,
) -> Result<LocalRunnerStatus, String> {
    let state = state.inner().clone();
    let _guard = state.ensure_lock.lock().await;
    state.inner.lock().unwrap().starting = true;
    let result = ensure(&image).await;
    let mut inner = state.inner.lock().unwrap();
    inner.starting = false;
    match result {
        Ok(base_url) => {
            inner.base_url = Some(base_url.clone());
            Ok(LocalRunnerStatus { state: "ready", base_url: Some(base_url) })
        }
        Err(e) => {
            inner.base_url = None;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn local_runner_teardown(state: State<'_, LocalRunnerState>) -> Result<(), String> {
    let state = state.inner().clone();
    // Serialize with `ensure` so Stop during a slow start waits for the start
    // to settle and then removes what it created, instead of racing it.
    let _guard = state.ensure_lock.lock().await;
    state.inner.lock().unwrap().base_url = None;
    teardown().await
}

/// Hook for Tauri's `WindowEvent::CloseRequested` — stops the runner container
/// (docker-runner's own SIGTERM handler stops all workload sessions) and
/// removes the bundle volume. Runs detached; we don't block the close, so this
/// is best-effort — there is no surface left to report a failure to.
pub fn teardown_on_close(state: LocalRunnerState) {
    let had_runner = state.inner.lock().unwrap().base_url.take().is_some();
    if !had_runner {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _guard = state.ensure_lock.lock().await;
        let _ = teardown().await;
    });
}

async fn ensure(image: &str) -> Result<String, String> {
    if let AvailabilityReport::Unavailable { message, remediation } = probe().await {
        return Err(match remediation {
            Some(r) => format!("{message} {r}"),
            None => message,
        });
    }

    docker(&["volume", "create", VOLUME_NAME])
        .await
        .map_err(|e| format!("Failed to run docker: {e}"))
        .and_then(|out| {
            out.status
                .success()
                .then_some(())
                .ok_or_else(|| format!("Failed to create bundle volume: {}", stderr_tail(&out)))
        })?;

    // Adopt a healthy leftover on the pinned image (crashed editor, or a
    // concurrent ensure that just won the lock); replace anything else.
    if let Some(existing) = inspect_existing().await {
        if existing.running && existing.image == image {
            if let Some(port) = existing.host_port {
                if health_ok(port).await {
                    return Ok(base_url(port));
                }
            }
        }
        if existing.running {
            // Graceful stop first so a previous runner's workload sessions are
            // torn down by its SIGTERM handler rather than orphaned.
            let _ = docker_ok(&["stop", CONTAINER_NAME]).await;
        }
        docker_ok(&["rm", "-f", CONTAINER_NAME])
            .await
            .map_err(|e| format!("Failed to replace the leftover runner container: {e}"))?;
    }

    let port = pick_free_loopback_port()
        .ok_or_else(|| "Could not allocate a free loopback port.".to_string())?;
    let publish = format!("127.0.0.1:{port}:{RUNNER_PORT}");
    let volume_mount = format!("{VOLUME_NAME}:/bundles");
    let bundle_volume_env = format!("BUNDLE_VOLUME={VOLUME_NAME}");
    let child_network_env = format!("RUNNER_CHILD_NETWORK={CHILD_NETWORK}");

    let mut args: Vec<String> = [
        "run", "-d", "--rm",
        "--name", CONTAINER_NAME,
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", &volume_mount,
        "-e", &bundle_volume_env,
        "-e", &child_network_env,
        "-p", &publish,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Forward the operator key so the local runner advertises `authoringAgent`
    // and injects the key into agent sessions. Name-only `-e` — docker reads
    // the value from this process's environment, keeping it out of the argv
    // (visible via /proc/*/cmdline). Best-effort — a GUI-launched editor often
    // has no such variable, which just leaves the agent hidden.
    if std::env::var("OPENAI_API_KEY").is_ok_and(|key| !key.trim().is_empty()) {
        args.push("-e".into());
        args.push("OPENAI_API_KEY".into());
    }
    args.push(image.to_string());

    // `docker run -d` pulls a missing image before starting — on first start
    // this blocks for the duration of the pull, which the UI reflects.
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = docker(&arg_refs)
        .await
        .map_err(|e| format!("Failed to run docker: {e}"))?;
    if !out.status.success() {
        return Err(format!("Failed to start the local runner: {}", stderr_tail(&out)));
    }

    // The image is already pulled at this point; boot is fast. A runner that
    // can't come up in this window is genuinely broken — surface its logs.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        if health_ok(port).await {
            return Ok(base_url(port));
        }
        if !container_running().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    let logs = docker(&["logs", "--tail", "40", CONTAINER_NAME])
        .await
        .map(|out| {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            text.trim().to_string()
        })
        .unwrap_or_default();
    let _ = docker_ok(&["rm", "-f", CONTAINER_NAME]).await;
    Err(if logs.is_empty() {
        "The local runner did not become healthy.".to_string()
    } else {
        format!("The local runner did not become healthy. Runner output:\n{logs}")
    })
}

async fn teardown() -> Result<(), String> {
    // Graceful stop first: docker-runner's SIGTERM handler stops all workload
    // session containers; a bare `rm -f` would SIGKILL it and orphan them
    // (they are sibling containers whose --rm only fires when they exit).
    docker_ok(&["stop", CONTAINER_NAME]).await?;
    docker_ok(&["rm", "-f", CONTAINER_NAME]).await?;
    // `--rm` removal finishes asynchronously after the stop; give the volume a
    // few chances to become unreferenced before giving up.
    let mut last_err = String::new();
    for _ in 0..3 {
        match docker_ok(&["volume", "rm", VOLUME_NAME]).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!("Failed to remove the bundle volume: {last_err}"))
}

async fn probe() -> AvailabilityReport {
    match docker_daemon_reachable().await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => AvailabilityReport::Unavailable {
            message: "Docker CLI not found in PATH.".into(),
            remediation: Some("Install Docker Desktop or the Docker Engine.".into()),
        },
        Err(e) => AvailabilityReport::Unavailable {
            message: format!("Docker daemon not reachable ({e})."),
            remediation: Some(
                "Start Docker Desktop or ensure the docker socket is accessible.".into(),
            ),
        },
        Ok(false) => AvailabilityReport::Unavailable {
            message: "Docker daemon not reachable.".into(),
            remediation: Some(
                "Start Docker Desktop or ensure the docker socket is accessible.".into(),
            ),
        },
        Ok(true) => AvailabilityReport::Ready,
    }
}

async fn docker_daemon_reachable() -> io::Result<bool> {
    let mut cmd = Command::new("docker");
    cmd.arg("version").arg("--format").arg("{{.Server.Version}}");
    let out = tokio::time::timeout(Duration::from_secs(2), cmd.output())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "docker version timed out"))??;
    Ok(out.status.success())
}

struct ExistingContainer {
    running: bool,
    image: String,
    host_port: Option<u16>,
}

/// Inspect the runner container by name. `None` when it doesn't exist.
async fn inspect_existing() -> Option<ExistingContainer> {
    let format = format!(
        "{{{{.State.Running}}}}\t{{{{.Config.Image}}}}\t{{{{(index (index .NetworkSettings.Ports \"{RUNNER_PORT}/tcp\") 0).HostPort}}}}",
    );
    let out = docker(&["inspect", "-f", &format, CONTAINER_NAME]).await.ok()?;
    if !out.status.success() {
        // Distinguish "no such container" from a template error on a container
        // without the expected port mapping — the latter still exists and must
        // be replaced, so report it as present-but-unusable.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("No such") {
            return None;
        }
        return Some(ExistingContainer { running: false, image: String::new(), host_port: None });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut parts = stdout.trim().split('\t');
    let running = parts.next() == Some("true");
    let image = parts.next().unwrap_or_default().to_string();
    let host_port = parts.next().and_then(|p| p.parse::<u16>().ok());
    Some(ExistingContainer { running, image, host_port })
}

async fn container_running() -> bool {
    match docker(&["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME]).await {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true",
        Err(_) => false,
    }
}

/// Minimal HTTP GET against the runner's `/v1/health`, checking for a 200
/// status line. Hand-rolled over a TCP stream to avoid an HTTP client
/// dependency for one loopback liveness check.
async fn health_ok(port: u16) -> bool {
    let connect = tokio::net::TcpStream::connect(("127.0.0.1", port));
    let Ok(Ok(mut stream)) = tokio::time::timeout(Duration::from_secs(2), connect).await else {
        return false;
    };
    let request =
        format!("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf));
    let Ok(Ok(n)) = read.await else {
        return false;
    };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
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

fn stderr_tail(out: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        "docker exited unsuccessfully".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn docker(args: &[&str]) -> io::Result<std::process::Output> {
    Command::new("docker").args(args).output().await
}

/// Run a docker command expecting success, treating a missing target ("No such
/// container/volume") as success so teardown paths stay idempotent.
async fn docker_ok(args: &[&str]) -> Result<(), String> {
    let out = docker(args)
        .await
        .map_err(|e| format!("Failed to run docker: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such") {
        return Ok(());
    }
    Err(format!("`docker {}` failed: {}", args.join(" "), stderr.trim()))
}
