//! A workspace's resume secret on a runner, for the desktop build: kept in the
//! OS credential store (service `com.telo.studio`), one entry per runner and
//! workspace. The shell names each entry from those two parts itself, so these
//! commands reach resume secrets and never the sign-in the shell also keeps
//! there.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::cloud_error::CloudError;
use crate::cloud_token_store::TokenStore;
use crate::runner_identity_rules::{check_resume_secret, resume_secret_account};

/// One store per entry, kept so a machine without a credential store still
/// holds the secret for the life of the process.
#[derive(Default)]
pub struct RunnerSessionSecrets {
    stores: Mutex<HashMap<String, Arc<TokenStore>>>,
}

impl RunnerSessionSecrets {
    fn store(&self, runner: &str, workspace: &str) -> Result<Arc<TokenStore>, CloudError> {
        let account = resume_secret_account(runner, workspace).map_err(CloudError::invalid_request)?;
        let mut stores = self.stores.lock().unwrap();
        Ok(stores
            .entry(account.clone())
            .or_insert_with(|| Arc::new(TokenStore::labelled(account, "a workspace's resume secret")))
            .clone())
    }
}

#[tauri::command]
pub async fn runner_resume_secret_read(
    state: State<'_, RunnerSessionSecrets>,
    runner: String,
    workspace: String,
) -> Result<Option<String>, CloudError> {
    state.store(&runner, &workspace)?.load().await
}

/// `secret: null` deletes the entry.
#[tauri::command]
pub async fn runner_resume_secret_write(
    state: State<'_, RunnerSessionSecrets>,
    runner: String,
    workspace: String,
    secret: Option<String>,
) -> Result<(), CloudError> {
    let store = state.store(&runner, &workspace)?;
    match secret {
        Some(secret) => {
            check_resume_secret(&secret).map_err(CloudError::invalid_request)?;
            store.save(&secret).await
        }
        None => store.delete().await,
    }
}
