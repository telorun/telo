use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tokio::process::ChildStdin;

use super::bundle::BundleWorkdir;
use super::docker::RunnerEndpoint;

/// Cap on the per-session byte transcript retained for replay. Bounds memory
/// against a chatty workload while a webview is detached (between reload and
/// re-attach). Matches the editor-side `TerminalBuffer` cap.
const OUTPUT_BUFFER_BYTES: usize = 2 * 1024 * 1024;

/// Decouples the container's byte output from the editor webview's Channel.
///
/// The reader tasks push into the hub for the whole life of the container, so
/// the stdout pipe is never dropped while the workload runs — a webview reload
/// (which kills the old Channel) cannot SIGPIPE the `docker run` process and
/// tear the container down. The hub retains a capped transcript so a re-attach
/// after reload replays the scrollback into a fresh Channel and resumes live.
pub struct OutputHub {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    /// The live subscriber, or `None` once its send fails (webview gone) until
    /// the next `attach`.
    channel: Option<Channel<Vec<u8>>>,
}

impl OutputHub {
    fn new(channel: Channel<Vec<u8>>) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            channel: Some(channel),
        }
    }

    pub fn push(&mut self, chunk: Vec<u8>) {
        if chunk.is_empty() {
            return;
        }
        if let Some(channel) = &self.channel {
            // A failed send means the webview is gone (reload / close). Keep the
            // pipe draining and buffer for a later re-attach — never propagate
            // the error up, which would end the reader and drop the pipe.
            if channel.send(chunk.clone()).is_err() {
                self.channel = None;
            }
        }
        self.bytes += chunk.len();
        self.chunks.push_back(chunk);
        while self.bytes > OUTPUT_BUFFER_BYTES && self.chunks.len() > 1 {
            if let Some(dropped) = self.chunks.pop_front() {
                self.bytes -= dropped.len();
            }
        }
    }

    /// Replay the retained transcript into a fresh Channel, then make it the
    /// live subscriber. Called on re-attach after a webview reload.
    pub fn attach(&mut self, channel: Channel<Vec<u8>>) {
        for chunk in &self.chunks {
            if channel.send(chunk.clone()).is_err() {
                return;
            }
        }
        self.channel = Some(channel);
    }
}

pub struct SessionEntry {
    pub container_name: String,
    pub docker_host: Option<String>,
    /// Set by `run_stop` before issuing `docker kill`, so the exit-waiter task
    /// can distinguish a user-initiated stop from a container crash / clean
    /// exit when it chooses between `Stopped` and `Exited` / `Failed`.
    pub user_stop: Arc<AtomicBool>,
    /// Stdin handle taken from the spawned `docker run -it` child. `Option`
    /// so `run_close_input` can consume it (drop = EOF). `tokio::Mutex` because
    /// `write_all` requires `&mut self` and we serialize multiple `run_send_input`
    /// callers across one pipe.
    pub stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    /// The session's output hub — the swappable seam between the container's
    /// byte stream and the editor webview, enabling re-attach after a reload.
    pub output: Arc<Mutex<OutputHub>>,
    /// Forwarded-port endpoints, re-emitted on re-attach so the editor restores
    /// the running banner.
    pub endpoints: Vec<RunnerEndpoint>,
    /// The workload's published `--inspect` base URL (loopback), re-emitted on
    /// re-attach so the editor's debug panel reconnects its event stream.
    pub inspect_url: Option<String>,
    // Held only for its Drop impl — deleting the tempdir when the session ends.
    pub _bundle: BundleWorkdir,
}

/// What `reattach` needs to restore a session after a webview reload: the output
/// hub to re-bind a fresh channel to, plus the status/debug details to re-emit.
pub struct ReattachInfo {
    pub endpoints: Vec<RunnerEndpoint>,
    pub inspect_url: Option<String>,
    pub output: Arc<Mutex<OutputHub>>,
}

impl OutputHub {
    pub fn new_shared(channel: Channel<Vec<u8>>) -> Arc<Mutex<OutputHub>> {
        Arc::new(Mutex::new(OutputHub::new(channel)))
    }
}

#[derive(Clone, Default)]
pub struct SessionRegistry {
    inner: Arc<Mutex<HashMap<String, SessionEntry>>>,
}

impl SessionRegistry {
    pub fn insert(&self, session_id: String, entry: SessionEntry) {
        self.inner.lock().unwrap().insert(session_id, entry);
    }

    pub fn remove(&self, session_id: &str) -> Option<SessionEntry> {
        self.inner.lock().unwrap().remove(session_id)
    }

    /// Returns (container_name, docker_host, user_stop-flag) for the live
    /// session, if any. The returned `Arc<AtomicBool>` is the same one stored
    /// on the entry, so `user_stop.store(true)` from the caller flips the
    /// flag observed by the exit waiter.
    pub fn kill_info(
        &self,
        session_id: &str,
    ) -> Option<(String, Option<String>, Arc<AtomicBool>)> {
        self.inner.lock().unwrap().get(session_id).map(|e| {
            (
                e.container_name.clone(),
                e.docker_host.clone(),
                e.user_stop.clone(),
            )
        })
    }

    /// Returns the same Arc-Mutex stdin handle stored on the entry, so a
    /// command writing input doesn't have to hold the registry lock for the
    /// duration of the write.
    pub fn stdin_handle(
        &self,
        session_id: &str,
    ) -> Option<Arc<tokio::sync::Mutex<Option<ChildStdin>>>> {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .map(|e| e.stdin.clone())
    }

    /// Everything `reattach` needs to re-bind a live session to a fresh webview
    /// Channel after a reload. `None` when the session is gone (its exit-waiter
    /// removed it, or the editor process restarted) — the caller reports the
    /// run as no longer available.
    pub fn reattach_info(&self, session_id: &str) -> Option<ReattachInfo> {
        self.inner.lock().unwrap().get(session_id).map(|e| ReattachInfo {
            endpoints: e.endpoints.clone(),
            inspect_url: e.inspect_url.clone(),
            output: e.output.clone(),
        })
    }

    /// Returns just the docker host + container name, used by `run_resize`
    /// which shells out to `docker resize <name>` independent of the session
    /// entry's lifetime in the registry.
    pub fn container_for_resize(
        &self,
        session_id: &str,
    ) -> Option<(String, Option<String>)> {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .map(|e| (e.container_name.clone(), e.docker_host.clone()))
    }

    /// Snapshot of all live sessions' kill info. Used by the window-close hook
    /// to fire `docker kill` for every running container before the editor exits.
    pub fn all_kill_info(&self) -> Vec<(String, Option<String>)> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .map(|e| {
                // Mark each as user-stopped so any exit-waiter that hasn't yet
                // observed child exit reports `Stopped` rather than `Exited 137`.
                e.user_stop.store(true, Ordering::SeqCst);
                (e.container_name.clone(), e.docker_host.clone())
            })
            .collect()
    }
}
