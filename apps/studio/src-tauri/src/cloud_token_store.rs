//! Where the Telo Cloud refresh token lives: the OS credential store, or —
//! when the machine has none (a headless Linux session with no Secret
//! Service) — this process's memory until Studio quits. Never a file, never
//! the webview.
//!
//! The refresh token is deliberately not cached beside the credential store:
//! every reader asks the store, so a token another Studio process rotated is
//! the one this process presents next. `lock_refresh` is the cross-process
//! half of that — the lock file itself holds nothing.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::sync::Mutex;

use keyring::{Entry, Error as KeyringError};

use crate::cloud_error::CloudError;

const SERVICE: &str = "com.telo.studio";
const LOCK_FILE: &str = "cloud-refresh.lock";

pub struct TokenStore {
    /// The identity provider's URL: one grant per provider.
    account: String,
    /// Used only when the process has no credential store.
    memory: Mutex<Option<String>>,
}

enum Outcome<T> {
    Done(T),
    NoStore,
}

impl TokenStore {
    pub fn new(account: String) -> Self {
        Self { account, memory: Mutex::new(None) }
    }

    pub async fn load(&self) -> Result<Option<String>, CloudError> {
        let outcome = self
            .with_entry("read", |entry| match entry.get_password() {
                Ok(token) => Ok(Some(token)),
                Err(KeyringError::NoEntry) => Ok(None),
                Err(error) => Err(error),
            })
            .await?;
        Ok(match outcome {
            Outcome::Done(token) => token,
            Outcome::NoStore => self.memory.lock().unwrap().clone(),
        })
    }

    pub async fn save(&self, token: &str) -> Result<(), CloudError> {
        let secret = token.to_string();
        let outcome = self.with_entry("write", move |entry| entry.set_password(&secret)).await?;
        if let Outcome::NoStore = outcome {
            *self.memory.lock().unwrap() = Some(token.to_string());
        }
        Ok(())
    }

    pub async fn delete(&self) -> Result<(), CloudError> {
        let outcome = self
            .with_entry("delete", |entry| match entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                Err(error) => Err(error),
            })
            .await?;
        if let Outcome::NoStore = outcome {
            *self.memory.lock().unwrap() = None;
        }
        Ok(())
    }

    /// Credential stores block (D-Bus, an unlock prompt), so every operation
    /// runs off the async runtime.
    async fn with_entry<T, F>(&self, action: &'static str, operation: F) -> Result<Outcome<T>, CloudError>
    where
        T: Send + 'static,
        F: FnOnce(&Entry) -> Result<T, KeyringError> + Send + 'static,
    {
        let account = self.account.clone();
        let result = tokio::task::spawn_blocking(move || {
            let entry = match Entry::new(SERVICE, &account) {
                Ok(entry) => entry,
                Err(KeyringError::NoDefaultStore) => return Ok(Outcome::NoStore),
                Err(error) => return Err(error),
            };
            operation(&entry).map(Outcome::Done)
        })
        .await
        .map_err(|error| {
            CloudError::credential_store(format!("The credential store task failed: {error}"))
        })?;
        result.map_err(|error| {
            CloudError::credential_store(format!(
                "Could not {action} the Telo Cloud sign-in in the system credential store: {}",
                describe(&error)
            ))
        })
    }
}

/// Two variants carry the stored bytes; their text must not reach a message.
fn describe(error: &KeyringError) -> String {
    match error {
        KeyringError::BadEncoding(_) | KeyringError::BadDataFormat(_, _) => {
            "the stored value is not readable".to_string()
        }
        other => other.to_string(),
    }
}

/// Held for the length of one refresh, across every Studio process of this
/// user.
pub struct RefreshLock {
    file: File,
}

impl Drop for RefreshLock {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            eprintln!("telo cloud: could not release the refresh lock: {error}");
        }
    }
}

pub async fn lock_refresh(directory: PathBuf) -> Result<RefreshLock, CloudError> {
    let failed = |error: String| {
        CloudError::credential_store(format!("Could not take the Telo Cloud refresh lock: {error}"))
    };
    tokio::task::spawn_blocking(move || -> std::io::Result<RefreshLock> {
        std::fs::create_dir_all(&directory)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join(LOCK_FILE))?;
        file.lock()?;
        Ok(RefreshLock { file })
    })
    .await
    .map_err(|error| failed(error.to_string()))?
    .map_err(|error| failed(error.to_string()))
}
