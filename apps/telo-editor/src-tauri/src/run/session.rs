use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::bundle::BundleWorkdir;

pub struct SessionEntry {
    pub container_name: String,
    pub docker_host: Option<String>,
    /// Set by `run_stop` before issuing `docker kill`, so the exit-waiter task
    /// can distinguish a user-initiated stop from a container crash / clean
    /// exit when it chooses between `Stopped` and `Exited` / `Failed`.
    pub user_stop: Arc<AtomicBool>,
    // Held only for its Drop impl — deleting the tempdir when the session ends.
    pub _bundle: BundleWorkdir,
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
