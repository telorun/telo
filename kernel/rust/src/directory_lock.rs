//! The cross-process lock guarding mutation of a shared cache directory.
//! Mirrors `../../nodejs/src/directory-lock.ts`.
//!
//! **Protocol-compatible with the Node lock, not merely similar**: both kernels
//! populate one `.telo` cache, so a lock only one of them can see is no lock.
//! Same file (`<dir>/.lock`), same exclusive create, same JSON body, same
//! mtime heartbeat and staleness threshold, same rename-to-tombstone reclaim —
//! an OS `flock` would be invisible to the Node kernel and the two would race.
//!
//! Node's in-process queue ahead of the file lock has no counterpart: it
//! serializes concurrent async callers inside one process, and this kernel is
//! synchronous, so there is never a second caller to queue.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::KernelError;

/// A lock whose mtime is older than this has lost its holder's heartbeat and is
/// reclaimed. mtime age is the only reclaim signal: the recorded pid is
/// meaningless across containers and PID namespaces.
const LOCK_STALE: Duration = Duration::from_secs(30);
/// How often a holder bumps the lock's mtime.
const LOCK_HEARTBEAT: Duration = Duration::from_secs(5);
/// Total wait before giving up on a lock with a live heartbeat.
const LOCK_WAIT_MAX: Duration = Duration::from_secs(5 * 60);
const LOCK_RETRY: Duration = Duration::from_millis(500);
/// After this long waiting, say so once, so a slow wait is not a silent hang.
const LOCK_WAIT_NOTICE: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("[telo] {operation} for {label} lock at {path}: {source}")]
    Io {
        operation: &'static str,
        label: String,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(
        "[telo] timed out waiting for {label} lock at {path} (held >{minutes} min with a live heartbeat). \
         Inspect the lock file or remove it manually if no other Telo process is running."
    )]
    TimedOut {
        label: String,
        path: PathBuf,
        minutes: u64,
    },
}

impl From<LockError> for KernelError {
    fn from(err: LockError) -> Self {
        KernelError::new("ERR_DIRECTORY_LOCK_FAILED", err.to_string())
    }
}

/// Acquire the lock for `dir` and run `body` under it. `label` names the
/// operation in the wait notice and the timeout error.
///
/// The lock guards writes into the directory; reads of already-populated
/// content run lock-free.
pub fn with_directory_lock<T, E: From<LockError>>(
    dir: &Path,
    label: &str,
    body: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let lock_path = dir.join(".lock");
    let io = |operation, source| LockError::Io {
        operation,
        label: label.to_string(),
        path: lock_path.clone(),
        source,
    };
    fs::create_dir_all(dir).map_err(|err| io("creating the directory", err))?;

    // Monotonic: a wall clock stepped backwards would otherwise stretch the wait
    // past its bound, and one stepped forwards would time out a live holder.
    let waited_since = Instant::now();
    let mut noticed = false;
    let mut held = loop {
        match OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(mut file) => {
                // Owned from the moment the file exists, so a failed write still
                // removes it rather than leaving every later kernel to wait it out.
                let held = HeldLock {
                    path: lock_path.clone(),
                    label: label.to_string(),
                    heartbeat: None,
                };
                file.write_all(lock_body().as_bytes())
                    .map_err(|err| io("writing", err))?;
                break held;
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                if reclaim_if_stale(&lock_path).map_err(|err| io("reclaiming a stale lock", err))? {
                    continue;
                }
                let waited = waited_since.elapsed();
                if waited > LOCK_WAIT_MAX {
                    return Err(LockError::TimedOut {
                        label: label.to_string(),
                        path: lock_path,
                        minutes: LOCK_WAIT_MAX.as_secs() / 60,
                    }
                    .into());
                }
                if !noticed && waited > LOCK_WAIT_NOTICE {
                    noticed = true;
                    eprintln!("telo: waiting for {label} lock at {}", lock_path.display());
                }
                thread::sleep(LOCK_RETRY);
            }
            Err(err) => return Err(io("creating", err).into()),
        }
    };

    held.heartbeat = Some(Heartbeat::start(lock_path.clone(), label.to_string()));
    // Released by `held`'s drop on every exit, a panicking body included.
    body()
}

/// A lock this process holds: dropping it stops the heartbeat and removes the
/// file, however the holder's work ended.
struct HeldLock {
    path: PathBuf,
    label: String,
    heartbeat: Option<Heartbeat>,
}

impl Drop for HeldLock {
    fn drop(&mut self) {
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.stop();
        }
        // A lock left behind makes every later kernel wait out LOCK_STALE, so a
        // failure to remove it is reported rather than dropped.
        if let Err(err) = fs::remove_file(&self.path) {
            if err.kind() != ErrorKind::NotFound {
                eprintln!(
                    "telo: failed to release {} lock at {}: {err}",
                    self.label,
                    self.path.display()
                );
            }
        }
    }
}

/// `{pid, host, startedAt}` — diagnostics for a human, never a reclaim signal.
fn lock_body() -> String {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    serde_json::json!({
        "pid": std::process::id(),
        "host": hostname(),
        "startedAt": started_at,
    })
    .to_string()
}

/// The host name for the lock body. The standard library cannot ask the OS, so
/// the usual environment and file are consulted, and an unnamed host records
/// that it is unnamed.
fn hostname() -> String {
    ["HOSTNAME", "COMPUTERNAME"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// If the lock is stale, claim it by an atomic rename to a unique tombstone —
/// which only one racer wins — and remove it. `true` when the caller should
/// retry the create immediately.
fn reclaim_if_stale(lock_path: &Path) -> std::io::Result<bool> {
    let modified = match fs::metadata(lock_path).and_then(|meta| meta.modified()) {
        Ok(modified) => modified,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    };
    // A future mtime reads as fresh, as it does in Node.
    let age = SystemTime::now().duration_since(modified).unwrap_or_default();
    if age < LOCK_STALE {
        return Ok(false);
    }
    let modified_ms = modified
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let tombstone = PathBuf::from(format!(
        "{}.stale.{}.{modified_ms}",
        lock_path.display(),
        std::process::id()
    ));
    match fs::rename(lock_path, &tombstone) {
        Ok(()) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    }
    match fs::remove_file(&tombstone) {
        Err(err) if err.kind() != ErrorKind::NotFound => Err(err),
        _ => Ok(true),
    }
}

/// Keeps the lock's mtime fresh while the body runs, so a slow-but-live holder
/// is never reclaimed.
struct Heartbeat {
    stop: mpsc::Sender<()>,
    thread: thread::JoinHandle<()>,
}

impl Heartbeat {
    fn start(lock_path: PathBuf, label: String) -> Self {
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = thread::spawn(move || {
            let mut reported = false;
            while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(LOCK_HEARTBEAT) {
                let bumped = File::options()
                    .write(true)
                    .open(&lock_path)
                    .and_then(|file| file.set_modified(SystemTime::now()));
                // Reported once: a peer that judges this lock stale will take
                // it, and every later beat would repeat the same line.
                if let Err(err) = bumped {
                    if !reported {
                        reported = true;
                        eprintln!(
                            "telo: failed to refresh {label} lock at {}: {err}",
                            lock_path.display()
                        );
                    }
                }
            }
        });
        Self { stop, thread }
    }

    fn stop(self) {
        // The receiver lives until the thread exits, so a send can only fail
        // once the thread is already gone.
        let _ = self.stop.send(());
        if self.thread.join().is_err() {
            eprintln!("telo: the lock heartbeat thread panicked");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_the_lock_when_the_body_panics() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join(".lock");
        let path = dir.path().to_path_buf();
        let outcome = std::panic::catch_unwind(move || {
            with_directory_lock::<(), LockError>(&path, "module layer", || panic!("the body failed"))
        });
        assert!(outcome.is_err());
        assert!(!lock.exists(), "a panicking holder left its lock behind");
    }

    /// A lock file exactly as the Node kernel writes it.
    fn node_lock(dir: &Path) -> PathBuf {
        let path = dir.join(".lock");
        fs::write(&path, r#"{"pid":4242,"host":"node-kernel","startedAt":1757771234567}"#).unwrap();
        path
    }

    #[test]
    fn a_lock_held_by_the_node_kernel_blocks_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let lock = node_lock(dir.path());
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(1200));
            fs::remove_file(lock).unwrap();
        });
        let started = Instant::now();
        with_directory_lock::<_, LockError>(dir.path(), "module layer", || Ok(())).unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(1200),
            "entered after {:?}, while the Node holder still held the lock",
            started.elapsed()
        );
        release.join().unwrap();
    }

    #[test]
    fn a_stale_node_lock_is_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let lock = node_lock(dir.path());
        File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        let started = Instant::now();
        with_directory_lock::<_, LockError>(dir.path(), "module layer", || Ok(())).unwrap();
        assert!(started.elapsed() < LOCK_RETRY, "a stale lock must not be waited on");
    }

    /// The Node kernel reads the lock this kernel writes as its own: a JSON body
    /// at `<dir>/.lock` while held, and no file once released.
    #[test]
    fn writes_the_node_lock_format_and_releases_it() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join(".lock");
        let body = with_directory_lock::<_, LockError>(dir.path(), "module layer", || {
            Ok(fs::read_to_string(&lock).unwrap())
        })
        .unwrap();
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["pid"], std::process::id());
        assert!(body["host"].is_string() && body["startedAt"].is_u64(), "{body}");
        assert!(!lock.exists());
    }
}
