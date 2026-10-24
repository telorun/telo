//! Access tokens for runners, for the desktop build. The shell holds the
//! sign-in; the webview signs a DPoP proof per token request with the
//! installation's non-extractable key and receives the access token only —
//! bound to that key, so it is worthless anywhere else. No refresh token ever
//! crosses into the webview.
//!
//! A runner's token comes from that runner's own grant, never from the
//! sign-in's: its refresh token (from an earlier authorization naming the
//! runner, in the credential store), or — with none — one authorization naming
//! only the runner, silent first (`prompt=none`), in the system browser, its
//! code redeemed with the webview's proof. A refresh the identity provider
//! refuses as unusable (`invalid_grant`, `invalid_dpop_proof`) deletes the
//! grant and answers `reauthorizing`, so the webview says so before the next
//! request authorizes the runner again. Each token request carries a fresh
//! proof, so the webview is asked for another whenever one was spent.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::cloud_auth::{open_browser, BoundTokenResponse, Cloud, CloudState, TokenFailure};
use crate::cloud_authorization::{AuthorizationRequest, CLIENT_ID, RUNNER_SCOPE};
use crate::cloud_error::CloudError;
use crate::cloud_token_store::TokenStore;
use crate::runner_identity_rules::{
    check_runner_resource, grant_account, grant_index_with, is_dpop_token_type, read_grant_index,
    token_refusal, TokenRefusal, GRANT_INDEX_ACCOUNT,
};

/// An authorization code waits this long for the proof that redeems it.
const PENDING_CODE_LIFETIME: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RunnerTokenAnswer {
    #[serde(rename_all = "camelCase")]
    Token { access_token: String, expires_in: u64 },
    /// Sign a proof for `token_endpoint` (with `nonce`) and ask again.
    #[serde(rename_all = "camelCase")]
    ProofRequired { token_endpoint: String, nonce: Option<String> },
    /// The runner's grant was refused and deleted: tell the user, then sign a
    /// proof for `token_endpoint` (with `nonce`) and ask again, which
    /// authorizes the runner again.
    #[serde(rename_all = "camelCase")]
    Reauthorizing { token_endpoint: String, nonce: Option<String> },
}

struct PendingCode {
    code: String,
    redirect_uri: String,
    code_verifier: String,
    received: Instant,
}

struct RunnerGrants {
    /// One store per runner, kept so a machine without a credential store
    /// still holds a runner's grant for the life of the process.
    stores: HashMap<String, Arc<TokenStore>>,
    /// Every runner a grant is kept for.
    index: TokenStore,
    /// An authorization completed for a runner, waiting for a fresh proof.
    pending: HashMap<String, PendingCode>,
}

impl RunnerGrants {
    fn store(&mut self, resource: &str) -> Arc<TokenStore> {
        self.stores
            .entry(resource.to_string())
            .or_insert_with(|| {
                Arc::new(TokenStore::labelled(grant_account(resource), "a runner's sign-in"))
            })
            .clone()
    }

    /// Keeps a runner's refresh token, listing the runner first so sign-out
    /// finds it.
    async fn keep(&mut self, resource: &str, refresh_token: &str) -> Result<(), CloudError> {
        let listed = read_grant_index(self.index.load().await?.as_deref())
            .map_err(CloudError::credential_store)?;
        if let Some(next) = grant_index_with(&listed, resource) {
            self.index.save(&next).await?;
        }
        self.store(resource).save(refresh_token).await
    }
}

/// Serializes runner token requests: an authorization in the browser is
/// never started twice for one runner.
pub struct RunnerIdentityState {
    grants: tokio::sync::Mutex<RunnerGrants>,
}

impl Default for RunnerIdentityState {
    fn default() -> Self {
        Self {
            grants: tokio::sync::Mutex::new(RunnerGrants {
                stores: HashMap::new(),
                index: TokenStore::labelled(GRANT_INDEX_ACCOUNT.to_string(), "the list of runner sign-ins"),
                pending: HashMap::new(),
            }),
        }
    }
}

impl RunnerIdentityState {
    /// Sign-out, or a new sign-in: every runner's grant belongs to the user
    /// who was signed in, so none outlives them.
    pub async fn forget_all(&self) -> Result<(), CloudError> {
        let mut grants = self.grants.lock().await;
        grants.pending.clear();
        let listed = read_grant_index(grants.index.load().await?.as_deref());
        let mut resources: Vec<String> = grants.stores.keys().cloned().collect();
        if let Ok(listed) = &listed {
            resources.extend(listed.iter().cloned());
        }
        for resource in resources {
            grants.store(&resource).delete().await?;
        }
        grants.stores.clear();
        grants.index.delete().await?;
        // An unreadable index is reported once everything known is gone.
        listed.map(|_| ()).map_err(CloudError::credential_store)
    }
}

#[tauri::command]
pub async fn runner_token(
    app: AppHandle,
    cloud: State<'_, CloudState>,
    state: State<'_, RunnerIdentityState>,
    resource: String,
    proof: Option<String>,
) -> Result<RunnerTokenAnswer, CloudError> {
    check_runner_resource(&resource).map_err(CloudError::invalid_request)?;
    let cloud = cloud.cloud()?;
    let proof_required = |nonce: Option<String>| RunnerTokenAnswer::ProofRequired {
        token_endpoint: cloud.token_endpoint(),
        nonce,
    };
    let Some(proof) = proof else {
        return Ok(proof_required(None));
    };
    if !cloud.signed_in().await? {
        return Err(CloudError::not_signed_in("Studio is not signed in, so no runner token can be had."));
    }
    let mut grants = state.grants.lock().await;

    if let Some(pending) = grants.pending.remove(&resource) {
        if pending.received.elapsed() < PENDING_CODE_LIFETIME {
            return redeem_code(&cloud, &mut grants, &resource, pending, &proof).await;
        }
    }

    let store = grants.store(&resource);
    if let Some(refresh_token) = store.load().await? {
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", CLIENT_ID),
            ("resource", resource.as_str()),
        ];
        return match cloud.token_request::<BoundTokenResponse>(&form, Some(&proof)).await {
            Ok(tokens) => issued(&mut grants, &resource, tokens).await,
            Err(TokenFailure::Refused { error, nonce }) => match token_refusal(&error) {
                TokenRefusal::UseNonce => Ok(proof_required(nonce)),
                TokenRefusal::GrantUnusable => {
                    store.delete().await?;
                    Ok(RunnerTokenAnswer::Reauthorizing { token_endpoint: cloud.token_endpoint(), nonce })
                }
                TokenRefusal::Other => Err(refused(&error)),
            },
            Err(TokenFailure::Unreachable(reason)) => Err(unreachable(&reason)),
        };
    }

    // No grant for this runner: the proof in hand is left unspent, since the
    // authorization may take the user a while and the code is redeemed with a
    // fresh one.
    let pending = authorize_runner(&app, &cloud, &resource).await?;
    grants.pending.insert(resource.clone(), pending);
    Ok(proof_required(None))
}

/// One authorization naming the runner: silent first, then — when the user
/// has to take part — with the identity provider's own prompt.
async fn authorize_runner(
    app: &AppHandle,
    cloud: &Cloud,
    resource: &str,
) -> Result<PendingCode, CloudError> {
    match authorize_once(app, cloud, resource, Some("none")).await {
        Err(error) if error.code == "interaction_required" => {
            authorize_once(app, cloud, resource, None).await
        }
        outcome => outcome,
    }
}

async fn authorize_once(
    app: &AppHandle,
    cloud: &Cloud,
    resource: &str,
    prompt: Option<&str>,
) -> Result<PendingCode, CloudError> {
    let request =
        AuthorizationRequest::bind(&cloud.settings.accounts_url, resource, RUNNER_SCOPE, prompt).await?;
    open_browser(app, &request.url)?;
    let redirect_uri = request.redirect_uri.clone();
    let code_verifier = request.code_verifier.clone();
    let code = request.wait_for_code().await?;
    Ok(PendingCode { code, redirect_uri, code_verifier, received: Instant::now() })
}

async fn redeem_code(
    cloud: &Cloud,
    grants: &mut RunnerGrants,
    resource: &str,
    pending: PendingCode,
    proof: &str,
) -> Result<RunnerTokenAnswer, CloudError> {
    let outcome = {
        let form = [
            ("grant_type", "authorization_code"),
            ("code", pending.code.as_str()),
            ("redirect_uri", pending.redirect_uri.as_str()),
            ("code_verifier", pending.code_verifier.as_str()),
            ("client_id", CLIENT_ID),
            ("resource", resource),
        ];
        cloud.token_request::<BoundTokenResponse>(&form, Some(proof)).await
    };
    match outcome {
        Ok(tokens) => issued(grants, resource, tokens).await,
        Err(TokenFailure::Refused { error, nonce }) if token_refusal(&error) == TokenRefusal::UseNonce => {
            // The code is still good: it waits for the proof with the nonce.
            grants.pending.insert(resource.to_string(), pending);
            Ok(RunnerTokenAnswer::ProofRequired { token_endpoint: cloud.token_endpoint(), nonce })
        }
        Err(TokenFailure::Refused { error, .. }) => Err(CloudError::authorization_failed(format!(
            "The identity provider refused the runner's authorization code: {error}"
        ))),
        Err(TokenFailure::Unreachable(reason)) => Err(unreachable(&reason)),
    }
}

/// The runner's own refresh token is rotated into the store before the
/// access token is answered.
async fn issued(
    grants: &mut RunnerGrants,
    resource: &str,
    tokens: BoundTokenResponse,
) -> Result<RunnerTokenAnswer, CloudError> {
    if !is_dpop_token_type(tokens.token_type.as_deref()) {
        return Err(not_bound());
    }
    if let Some(refresh_token) = tokens.refresh_token.as_deref() {
        grants.keep(resource, refresh_token).await?;
    }
    Ok(RunnerTokenAnswer::Token { access_token: tokens.access_token, expires_in: tokens.expires_in })
}

fn not_bound() -> CloudError {
    CloudError::authorization_failed(
        "The identity provider issued a runner token that is not bound to Studio's key; it is not used.",
    )
}

fn refused(error: &str) -> CloudError {
    CloudError::authorization_failed(format!(
        "The identity provider refused a token for the runner: {error}"
    ))
}

fn unreachable(reason: &str) -> CloudError {
    CloudError::identity_provider_unreachable(format!(
        "The identity provider could not be reached for a runner token: {reason}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_serializes_as_the_webview_reads_it() {
        assert_eq!(
            serde_json::to_value(RunnerTokenAnswer::Token { access_token: "at".into(), expires_in: 300 })
                .unwrap(),
            serde_json::json!({ "status": "token", "accessToken": "at", "expiresIn": 300 })
        );
        assert_eq!(
            serde_json::to_value(RunnerTokenAnswer::ProofRequired {
                token_endpoint: "https://accounts.example/oauth2/token".into(),
                nonce: Some("n".into()),
            })
            .unwrap(),
            serde_json::json!({
                "status": "proofRequired",
                "tokenEndpoint": "https://accounts.example/oauth2/token",
                "nonce": "n"
            })
        );
        assert_eq!(
            serde_json::to_value(RunnerTokenAnswer::Reauthorizing {
                token_endpoint: "https://accounts.example/oauth2/token".into(),
                nonce: None,
            })
            .unwrap(),
            serde_json::json!({
                "status": "reauthorizing",
                "tokenEndpoint": "https://accounts.example/oauth2/token",
                "nonce": null
            })
        );
    }
}
