//! Local CLI runner supervisor: runs `telo runner` — the Telo CLI shipped
//! inside this application — as a child process, and hands its loopback base URL
//! to the webview. The editor talks to it through the ordinary http-runner
//! adapter; this module only owns the process's lifecycle.
//!
//! **Which `telo` is not a question about the machine.** The executable is the
//! sidecar bundled beside this binary, or one the user named explicitly in the
//! runner's settings — never a `PATH` lookup and never a version comparison. A
//! second install at another version silently driving a session is exactly what
//! that rules out; a manifest whose `requires: telo:` floor is above the
//! bundled runtime says so itself, at the manifest, with the floor named.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

/// Where session workspaces are staged, under the OS temp directory. Named so a
/// leftover from a crashed editor is identifiable rather than anonymous; the
/// runner owns a PID-named subdirectory inside it and reclaims dead ones.
const STATE_DIR_NAME: &str = "telo-studio-runner";

/// The origins this editor's webview sends, and the only ones the runner it
/// starts will accept.
///
/// The runner refuses browser origins by default, because every page the user
/// visits can reach `127.0.0.1` and this API runs code. Naming the editor's own
/// origins here — rather than having the CLI default to something friendly — is
/// what keeps that decision with the client that needs it. Tauri serves the
/// webview from `tauri://localhost` (macOS, Linux) or `http://tauri.localhost`
/// (Windows); `https://` covers a build configured for it.
const WEBVIEW_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// The dev server the shell loads in a development build, which is a third
/// origin and only exists there.
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:5173";

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
pub struct CliRunnerStatus {
    pub state: &'static str, // "stopped" | "starting" | "ready"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// The executable behind a running runner, so the editor can report WHAT it
    /// is running rather than assert it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
}

#[derive(Default)]
struct StateInner {
    child: Option<Child>,
    base_url: Option<String>,
    executable: Option<String>,
    starting: bool,
}

#[derive(Clone, Default)]
pub struct CliRunnerState {
    inner: Arc<Mutex<StateInner>>,
    /// Serializes concurrent `ensure` calls (settings button + run banner).
    ensure_lock: Arc<tokio::sync::Mutex<()>>,
}

/// The `telo` this editor runs: the explicit override, else the bundled
/// sidecar, else — in a development build only — the workspace CLI.
fn resolve_executable(override_path: Option<String>) -> Result<(PathBuf, Vec<String>), String> {
    if let Some(path) = override_path.filter(|p| !p.trim().is_empty()) {
        let path = PathBuf::from(path.trim());
        if !path.exists() {
            return Err(format!(
                "The configured telo executable does not exist: {}",
                path.display()
            ));
        }
        return Ok((path, Vec::new()));
    }

    // Tauri places an `externalBin` sidecar beside the application binary, with
    // the target triple stripped.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(if cfg!(windows) { "telo.exe" } else { "telo" });
            if sidecar.exists() {
                return Ok((sidecar, Vec::new()));
            }
        }
    }

    // No sidecar beside this binary: a development build run without one
    // staged (`cargo run`, or a tree where `pnpm stage:cli` has not run). The
    // fallback is the CLI of THIS checkout, named explicitly — still not a PATH
    // search, so a dev build cannot quietly pick up an installed telo either.
    // When a sidecar IS staged, the branch above wins and dev behaves exactly
    // like a release build.
    if cfg!(debug_assertions) {
        let workspace_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../cli/nodejs/bin/telo.mjs");
        if workspace_cli.exists() {
            let cli = workspace_cli
                .canonicalize()
                .unwrap_or(workspace_cli)
                .to_string_lossy()
                .to_string();
            return Ok((PathBuf::from("node"), vec![cli]));
        }
    }

    Err("This build carries no telo executable.".into())
}

#[tauri::command]
pub async fn cli_runner_probe(executable: Option<String>) -> Result<AvailabilityReport, String> {
    Ok(match resolve_executable(executable) {
        Ok(_) => AvailabilityReport::Ready,
        Err(message) => AvailabilityReport::Unavailable {
            message,
            remediation: Some(
                "Set the runner's `executable` to a telo binary, or reinstall Telo Studio.".into(),
            ),
        },
    })
}

#[tauri::command]
pub async fn cli_runner_status(state: State<'_, CliRunnerState>) -> Result<CliRunnerStatus, String> {
    let state = state.inner().clone();
    let mut inner = state.inner.lock().unwrap();
    if inner.starting {
        return Ok(CliRunnerStatus { state: "starting", base_url: None, executable: None });
    }
    let Some(base_url) = inner.base_url.clone() else {
        return Ok(CliRunnerStatus { state: "stopped", base_url: None, executable: None });
    };
    // The process can die out from under the cached URL (a crash, an OOM kill).
    // `try_wait` answers without blocking; anything but "still running" clears
    // the URL, so the editor is never pointed at a port nothing serves.
    let alive = match inner.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        _ => false,
    };
    if !alive {
        inner.base_url = None;
        inner.child = None;
        inner.executable = None;
        return Ok(CliRunnerStatus { state: "stopped", base_url: None, executable: None });
    }
    Ok(CliRunnerStatus {
        state: "ready",
        base_url: Some(base_url),
        executable: inner.executable.clone(),
    })
}

#[tauri::command]
pub async fn cli_runner_ensure(
    state: State<'_, CliRunnerState>,
    executable: Option<String>,
) -> Result<CliRunnerStatus, String> {
    let state = state.inner().clone();
    let _guard = state.ensure_lock.lock().await;

    // Already up and still alive: starting a second runner would leave the first
    // one holding sessions nothing drives.
    {
        let mut inner = state.inner.lock().unwrap();
        let alive = matches!(inner.child.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
        if alive {
            if let Some(base_url) = inner.base_url.clone() {
                return Ok(CliRunnerStatus {
                    state: "ready",
                    base_url: Some(base_url),
                    executable: inner.executable.clone(),
                });
            }
        }
        inner.starting = true;
    }

    let result = start(executable).await;
    let mut inner = state.inner.lock().unwrap();
    inner.starting = false;
    match result {
        Ok(started) => {
            inner.base_url = Some(started.base_url.clone());
            inner.executable = Some(started.executable.clone());
            inner.child = Some(started.child);
            Ok(CliRunnerStatus {
                state: "ready",
                base_url: Some(started.base_url),
                executable: Some(started.executable),
            })
        }
        Err(e) => {
            inner.base_url = None;
            inner.child = None;
            inner.executable = None;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn cli_runner_teardown(state: State<'_, CliRunnerState>) -> Result<(), String> {
    let state = state.inner().clone();
    // Serialize with `ensure` so a Stop during a slow start waits for the start
    // to settle and then stops what it created, rather than racing it.
    let _guard = state.ensure_lock.lock().await;
    let child = {
        let mut inner = state.inner.lock().unwrap();
        inner.base_url = None;
        inner.executable = None;
        inner.child.take()
    };
    stop_child(child).await;
    Ok(())
}

/// Hook for Tauri's `WindowEvent::CloseRequested`. The runner stops every live
/// session on SIGTERM, so killing it is what keeps a `telo run --watch` from
/// outliving the editor holding a port.
pub fn teardown_on_close(state: CliRunnerState) {
    let child = {
        let mut inner = state.inner.lock().unwrap();
        inner.base_url = None;
        inner.executable = None;
        inner.child.take()
    };
    if child.is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _guard = state.ensure_lock.lock().await;
        stop_child(child).await;
    });
}

struct Started {
    child: Child,
    base_url: String,
    executable: String,
}

async fn start(executable: Option<String>) -> Result<Started, String> {
    let (program, prefix) = resolve_executable(executable)?;
    let port = pick_free_loopback_port()
        .ok_or_else(|| "Could not allocate a free loopback port.".to_string())?;
    let state_dir = std::env::temp_dir().join(STATE_DIR_NAME);

    let mut command = Command::new(&program);
    command
        .args(&prefix)
        .arg("runner")
        .arg("--port")
        .arg(port.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--state-dir")
        .arg(&state_dir);
    for origin in WEBVIEW_ORIGINS {
        command.arg("--allow-origin").arg(origin);
    }
    #[cfg(debug_assertions)]
    command.arg("--allow-origin").arg(DEV_ORIGIN);
    command
        // The runner's own diagnostics stay with the editor's process output;
        // nothing here parses them, because the port is ours to choose rather
        // than the runner's to report.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start `{} runner`: {e}", program.display()))?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        if health_ok(port).await {
            return Ok(Started {
                child,
                base_url: base_url(port),
                executable: program.to_string_lossy().to_string(),
            });
        }
        // A runner that exited has failed for a reason already on stderr;
        // reporting "not healthy yet" for 30s would bury it.
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "The local runner exited before it was ready ({status}). See the editor's log for its output."
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let _ = child.kill().await;
    Err("The local runner did not become healthy within 30s.".into())
}

/// Stop the runner in the way that leaves nothing behind.
///
/// This matters more than it looks: the runner's own SIGTERM handler stops every
/// live session, and each session is a `telo run --watch` CHILD of the runner.
/// A plain `kill()` is SIGKILL, which skips that handler and orphans those
/// children — still running, still holding the ports the user's applications
/// bound, with nothing left that knows about them.
async fn stop_child(child: Option<Child>) {
    let Some(mut child) = child else { return };

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: `kill(2)` with a pid this process owns; a dead pid is an
        // error return, never undefined behaviour.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_ok() {
            return;
        }
    }

    // Windows has no SIGTERM, so the graceful path does not exist — `taskkill`
    // walks the tree by pid instead, which at least takes the session processes
    // down with the runner rather than leaving them behind.
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_ok() {
            return;
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Minimal HTTP GET against the runner's `/v1/health`, checking for a 200 status
/// line. Hand-rolled over a TCP stream to avoid an HTTP client dependency for
/// one loopback liveness check.
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

/// Grab a free host loopback port by binding `:0` and reading the assigned port,
/// then releasing it. Mildly racy (another process could claim it before the
/// runner binds), but adequate for a local single-user runner — and the
/// alternative, parsing the port back out of the runner's own output, buys
/// nothing here because the editor is the one that must know it first.
fn pick_free_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}
