//! Telo Cloud sign-in for the desktop build. The shell is the OAuth client:
//! it runs the authorization, holds the access token in memory and the
//! refresh token in the credential store, and tells the webview only who is
//! signed in. No command here returns or accepts a token.
//!
//! Both endpoints are build settings. The webview cannot name either one: a
//! base it supplied would let page content send the bearer anywhere.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::watch;
use url::Url;

use crate::cloud_authorization::{AuthorizationRequest, CLIENT_ID};
use crate::cloud_error::CloudError;
use crate::cloud_token_store::{lock_refresh, TokenStore};

const DEFAULT_API_URL: &str = "https://console.telo.cloud/api";
const DEFAULT_ACCOUNTS_URL: &str = "https://accounts.telo.run";

/// An access token this close to expiry is renewed before it is used.
const EXPIRY_MARGIN: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest silence tolerated on any connection, streamed bodies included.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Whole-request bound for the small sign-in calls.
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(30);

pub struct CloudSettings {
    /// The API base, without a trailing slash. Also the OAuth `resource`.
    pub api_base: Url,
    pub api_base_text: String,
    /// The identity provider, without a trailing slash.
    pub accounts_url: String,
}

impl CloudSettings {
    fn from_build() -> Result<Self, CloudError> {
        let api_base_text = build_setting(option_env!("VITE_TELO_CLOUD_API_URL"), DEFAULT_API_URL);
        let accounts_url = build_setting(option_env!("VITE_TELO_ACCOUNTS_URL"), DEFAULT_ACCOUNTS_URL);
        let api_base = base_url("VITE_TELO_CLOUD_API_URL", &api_base_text)?;
        base_url("VITE_TELO_ACCOUNTS_URL", &accounts_url)?;
        Ok(Self { api_base, api_base_text, accounts_url })
    }
}

/// An unset or empty build variable means the default.
fn build_setting(value: Option<&'static str>, default: &str) -> String {
    let value = value.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(default);
    value.trim_end_matches('/').to_string()
}

fn base_url(setting: &str, text: &str) -> Result<Url, CloudError> {
    let refuse = |reason: &str| {
        CloudError::invalid_request(format!(
            "This build's {setting} ({text}) is not usable: {reason}."
        ))
    };
    let url = Url::parse(text).map_err(|error| refuse(&error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(refuse("it must be an http or https URL"));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(refuse("it must carry no credentials, query or fragment"));
    }
    Ok(url)
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CloudSession {
    Anonymous,
    #[serde(rename_all = "camelCase")]
    SignedIn {
        user: SessionUser,
        org: SessionOrg,
        permissions: Vec<String>,
        expires_at: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionUser {
    id: String,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionOrg {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Principal {
    user: PrincipalUser,
    org: SessionOrg,
    permissions: Vec<String>,
    expires_at: String,
}

#[derive(Deserialize)]
struct PrincipalUser {
    id: String,
}

#[derive(Deserialize)]
struct UserInfo {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

#[derive(Deserialize)]
struct TokenRefusal {
    error: String,
}

enum TokenFailure {
    /// No usable answer: a network failure, a 5xx, a body that is not a token
    /// response.
    Unreachable(String),
    /// The identity provider answered with an OAuth error code.
    Refused(String),
}

struct AccessToken {
    token: String,
    expires_at: Instant,
}

/// An authorization in progress: a second sign-in joins it instead of binding
/// a second listener.
struct InFlight {
    url: String,
    done: watch::Receiver<Option<Result<(), CloudError>>>,
}

pub struct Cloud {
    pub settings: CloudSettings,
    pub http: reqwest::Client,
    store: TokenStore,
    access: Mutex<Option<AccessToken>>,
    /// In-process half of the refresh lock; the file lock is the other.
    refresh_gate: tokio::sync::Mutex<()>,
    authorization: tokio::sync::Mutex<Option<InFlight>>,
}

pub struct CloudState {
    cloud: Result<Arc<Cloud>, CloudError>,
}

impl Default for CloudState {
    fn default() -> Self {
        Self { cloud: Cloud::from_build().map(Arc::new) }
    }
}

impl CloudState {
    /// A build with unusable settings still starts: only Cloud is refused.
    pub fn cloud(&self) -> Result<Arc<Cloud>, CloudError> {
        self.cloud.clone()
    }
}

impl Cloud {
    fn from_build() -> Result<Self, CloudError> {
        let settings = CloudSettings::from_build()?;
        // reqwest is built without a TLS provider of its own; an `Err` here
        // only means another component installed one first.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            // A redirect would carry the request off the API base; the
            // webview gets the 3xx as it is.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .map_err(|error| {
                CloudError::api_unreachable(format!("The HTTP client could not be built: {error}"))
            })?;
        let store = TokenStore::new(settings.accounts_url.clone());
        Ok(Self {
            settings,
            http,
            store,
            access: Mutex::new(None),
            refresh_gate: tokio::sync::Mutex::new(()),
            authorization: tokio::sync::Mutex::new(None),
        })
    }

    /// The access token to send, renewed first when missing or about to
    /// expire. `rejected` is a token the API just answered 401 to: it is
    /// never returned again. `None` means there is no grant.
    pub async fn bearer(
        &self,
        app: &AppHandle,
        rejected: Option<&str>,
    ) -> Result<Option<String>, CloudError> {
        if let Some(token) = self.usable_access(rejected) {
            return Ok(Some(token));
        }
        let _gate = self.refresh_gate.lock().await;
        let _lock = lock_refresh(lock_directory(app)?).await?;
        // Another task of this process may have renewed while this one waited.
        if let Some(token) = self.usable_access(rejected) {
            return Ok(Some(token));
        }
        // Read under the lock: this is the token another Studio process
        // stored if it rotated first.
        let Some(refresh_token) = self.store.load().await? else {
            *self.access.lock().unwrap() = None;
            return Ok(None);
        };
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", CLIENT_ID),
            ("resource", self.settings.api_base_text.as_str()),
        ];
        match self.token_request(&form).await {
            Ok(tokens) => {
                self.store.save(&tokens.refresh_token).await?;
                Ok(Some(self.hold_access(tokens)))
            }
            Err(TokenFailure::Refused(error)) if error == "invalid_grant" => {
                self.store.delete().await?;
                *self.access.lock().unwrap() = None;
                Ok(None)
            }
            Err(TokenFailure::Refused(error)) => Err(CloudError::authorization_failed(format!(
                "The identity provider refused to renew the sign-in: {error}"
            ))),
            Err(TokenFailure::Unreachable(reason)) => {
                Err(CloudError::identity_provider_unreachable(format!(
                    "The identity provider could not be reached to renew the sign-in: {reason}"
                )))
            }
        }
    }

    fn usable_access(&self, rejected: Option<&str>) -> Option<String> {
        let access = self.access.lock().unwrap();
        let access = access.as_ref()?;
        let fresh = access.expires_at > Instant::now() + EXPIRY_MARGIN;
        (fresh && rejected != Some(access.token.as_str())).then(|| access.token.clone())
    }

    fn hold_access(&self, tokens: TokenResponse) -> String {
        *self.access.lock().unwrap() = Some(AccessToken {
            token: tokens.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(tokens.expires_in),
        });
        tokens.access_token
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse, TokenFailure> {
        let response = self
            .http
            .post(format!("{}/oauth2/token", self.settings.accounts_url))
            .header(reqwest::header::ACCEPT, "application/json")
            .form(form)
            .timeout(IDENTITY_TIMEOUT)
            .send()
            .await
            .map_err(|error| TokenFailure::Unreachable(transport_reason(&error)))?;
        let status = response.status();
        if status.is_server_error() {
            return Err(TokenFailure::Unreachable(format!("the token endpoint answered {status}")));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| TokenFailure::Unreachable(transport_reason(&error)))?;
        if !status.is_success() {
            // The body is never echoed: only the OAuth error code is read.
            return match serde_json::from_slice::<TokenRefusal>(&body) {
                Ok(refusal) => Err(TokenFailure::Refused(refusal.error)),
                Err(_) => {
                    Err(TokenFailure::Unreachable(format!("the token endpoint answered {status}")))
                }
            };
        }
        let tokens: TokenResponse = serde_json::from_slice(&body).map_err(|_| {
            TokenFailure::Unreachable("the token response is malformed".to_string())
        })?;
        if tokens.expires_in == 0 {
            return Err(TokenFailure::Unreachable("the token response is malformed".to_string()));
        }
        Ok(tokens)
    }

    /// RFC 7009. The identity provider answers 200 for any token.
    async fn revoke(&self, refresh_token: &str) -> Result<(), String> {
        let form =
            [("token", refresh_token), ("token_type_hint", "refresh_token"), ("client_id", CLIENT_ID)];
        let response = self
            .http
            .post(format!("{}/oauth2/revoke", self.settings.accounts_url))
            .form(&form)
            .timeout(IDENTITY_TIMEOUT)
            .send()
            .await
            .map_err(|error| transport_reason(&error))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("the revocation endpoint answered {}", response.status()))
        }
    }

    /// Runs a new authorization, or joins the one already waiting, and
    /// resolves once its grant is stored.
    async fn authorize(self: &Arc<Self>, app: &AppHandle) -> Result<(), CloudError> {
        let mut done = {
            let mut slot = self.authorization.lock().await;
            if let Some(in_flight) = slot.as_ref() {
                // The user may have closed the first tab: show the same
                // authorization again rather than start a second.
                open_browser(app, &in_flight.url)?;
                in_flight.done.clone()
            } else {
                let request =
                    AuthorizationRequest::bind(&self.settings.accounts_url, &self.settings.api_base_text)
                        .await?;
                let (settle, done) = watch::channel(None);
                *slot = Some(InFlight { url: request.url.clone(), done: done.clone() });
                let cloud = self.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = cloud.complete_authorization(&app, request).await;
                    *cloud.authorization.lock().await = None;
                    settle.send_replace(Some(result));
                });
                done
            }
        };
        let settled = done.wait_for(Option::is_some).await.map_err(|_| {
            CloudError::authorization_failed("The sign-in ended without a result.")
        })?;
        settled.clone().unwrap_or_else(|| {
            Err(CloudError::authorization_failed("The sign-in ended without a result."))
        })
    }

    async fn complete_authorization(
        &self,
        app: &AppHandle,
        request: AuthorizationRequest,
    ) -> Result<(), CloudError> {
        open_browser(app, &request.url)?;
        let redirect_uri = request.redirect_uri.clone();
        let code_verifier = request.code_verifier.clone();
        let code = request.wait_for_code().await?;

        let form = [
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("client_id", CLIENT_ID),
            ("resource", self.settings.api_base_text.as_str()),
        ];
        let tokens = self.token_request(&form).await.map_err(|failure| match failure {
            TokenFailure::Refused(error) => CloudError::authorization_failed(format!(
                "The identity provider refused the authorization code: {error}"
            )),
            TokenFailure::Unreachable(reason) => CloudError::identity_provider_unreachable(format!(
                "The identity provider could not be reached to finish the sign-in: {reason}"
            )),
        })?;

        // The previous grant goes only now that a new one is in hand.
        let previous = {
            let _gate = self.refresh_gate.lock().await;
            let _lock = lock_refresh(lock_directory(app)?).await?;
            let previous = self.store.load().await?;
            self.store.save(&tokens.refresh_token).await?;
            let replacement = tokens.refresh_token.clone();
            self.hold_access(tokens);
            previous.filter(|previous| *previous != replacement)
        };
        if let Some(previous) = previous {
            self.revoke_or_log(&previous).await;
        }
        Ok(())
    }

    async fn sign_out(&self, app: &AppHandle) -> Result<(), CloudError> {
        let _gate = self.refresh_gate.lock().await;
        let _lock = lock_refresh(lock_directory(app)?).await?;
        if let Some(refresh_token) = self.store.load().await? {
            self.revoke_or_log(&refresh_token).await;
        }
        self.store.delete().await?;
        *self.access.lock().unwrap() = None;
        Ok(())
    }

    /// A grant that could not be revoked is still forgotten locally; it
    /// expires at the identity provider on its own.
    async fn revoke_or_log(&self, refresh_token: &str) {
        if let Err(reason) = self.revoke(refresh_token).await {
            eprintln!("telo cloud: the previous grant was not revoked: {reason}");
        }
    }

    async fn session(&self, app: &AppHandle) -> Result<CloudSession, CloudError> {
        let Some(mut token) = self.bearer(app, None).await? else {
            return Ok(CloudSession::Anonymous);
        };
        let mut response = self.principal(&token).await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            let Some(renewed) = self.bearer(app, Some(&token)).await? else {
                return Ok(CloudSession::Anonymous);
            };
            token = renewed;
            response = self.principal(&token).await?;
        }
        if !response.status().is_success() {
            return Err(CloudError::api_unreachable(format!(
                "Telo Cloud answered {} when asked who is signed in.",
                response.status()
            )));
        }
        let principal: Principal = response.json().await.map_err(|error| {
            CloudError::api_unreachable(format!(
                "Telo Cloud's answer about who is signed in could not be read: {}",
                transport_reason(&error)
            ))
        })?;

        let unreachable = |reason: String| {
            CloudError::identity_provider_unreachable(format!(
                "The identity provider could not be asked for the signed-in user's name: {reason}"
            ))
        };
        let response = self
            .http
            .get(format!("{}/oauth2/userinfo", self.settings.accounts_url))
            .bearer_auth(&token)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(IDENTITY_TIMEOUT)
            .send()
            .await
            .map_err(|error| unreachable(transport_reason(&error)))?;
        if !response.status().is_success() {
            return Err(unreachable(format!("it answered {}", response.status())));
        }
        let user_info: UserInfo =
            response.json().await.map_err(|error| unreachable(transport_reason(&error)))?;

        Ok(CloudSession::SignedIn {
            user: SessionUser { id: principal.user.id, name: user_info.name, email: user_info.email },
            org: principal.org,
            permissions: principal.permissions,
            expires_at: principal.expires_at,
        })
    }

    async fn principal(&self, token: &str) -> Result<reqwest::Response, CloudError> {
        self.http
            .get(format!("{}/v1/principal", self.settings.api_base_text))
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(IDENTITY_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                CloudError::api_unreachable(format!(
                    "Telo Cloud could not be reached: {}",
                    transport_reason(&error)
                ))
            })
    }
}

/// reqwest's own text names the URL; a URL here never carries a secret, but
/// the cause chain is what explains a failure.
pub fn transport_reason(error: &reqwest::Error) -> String {
    let mut reason = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        reason.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    reason
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), CloudError> {
    app.opener().open_url(url, None::<&str>).map_err(|error| {
        CloudError::authorization_failed(format!(
            "The system browser could not be opened for the sign-in: {error}"
        ))
    })
}

fn lock_directory(app: &AppHandle) -> Result<PathBuf, CloudError> {
    app.path().app_local_data_dir().map_err(|error| {
        CloudError::credential_store(format!(
            "The app's data directory, where the refresh lock lives, is unknown: {error}"
        ))
    })
}

#[tauri::command]
pub async fn cloud_session(
    app: AppHandle,
    state: State<'_, CloudState>,
) -> Result<CloudSession, CloudError> {
    state.cloud()?.session(&app).await
}

#[tauri::command]
pub async fn cloud_sign_in(
    app: AppHandle,
    state: State<'_, CloudState>,
) -> Result<CloudSession, CloudError> {
    let cloud = state.cloud()?;
    cloud.authorize(&app).await?;
    cloud.session(&app).await
}

/// The identity provider's organization picker decides; a new authorization
/// replaces the grant either way, so this is sign-in under another name.
#[tauri::command]
pub async fn cloud_switch_organization(
    app: AppHandle,
    state: State<'_, CloudState>,
) -> Result<CloudSession, CloudError> {
    let cloud = state.cloud()?;
    cloud.authorize(&app).await?;
    cloud.session(&app).await
}

#[tauri::command]
pub async fn cloud_sign_out(app: AppHandle, state: State<'_, CloudState>) -> Result<(), CloudError> {
    state.cloud()?.sign_out(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unset_or_empty_build_setting_is_the_default() {
        assert_eq!(build_setting(None, DEFAULT_API_URL), DEFAULT_API_URL);
        assert_eq!(build_setting(Some("  "), DEFAULT_API_URL), DEFAULT_API_URL);
        assert_eq!(
            build_setting(Some("https://console.telo.localhost:9050/api/"), DEFAULT_API_URL),
            "https://console.telo.localhost:9050/api"
        );
    }

    #[test]
    fn a_base_with_credentials_a_query_or_another_scheme_is_refused() {
        assert!(base_url("X", "https://console.telo.cloud/api").is_ok());
        for text in ["ftp://x/api", "https://user@x/api", "https://x/api?a=1", "not a url"] {
            assert_eq!(base_url("X", text).unwrap_err().code, "invalid_request", "{text}");
        }
    }

    #[test]
    fn the_session_serializes_as_the_webview_reads_it() {
        assert_eq!(
            serde_json::to_value(CloudSession::Anonymous).unwrap(),
            serde_json::json!({ "status": "anonymous" })
        );
        let signed_in = CloudSession::SignedIn {
            user: SessionUser { id: "usr_1".into(), name: None, email: Some("a@b.c".into()) },
            org: SessionOrg { id: "org_1".into() },
            permissions: vec!["cloud:access".into()],
            expires_at: "2026-01-01T00:00:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_value(signed_in).unwrap(),
            serde_json::json!({
                "status": "signedIn",
                "user": { "id": "usr_1", "name": null, "email": "a@b.c" },
                "org": { "id": "org_1" },
                "permissions": ["cloud:access"],
                "expiresAt": "2026-01-01T00:00:00.000Z"
            })
        );
    }
}
