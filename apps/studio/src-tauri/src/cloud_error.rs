//! The one error shape every Telo Cloud command rejects with. The webview
//! branches on `code`; `message` is for the user.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CloudError {
    pub code: &'static str,
    pub message: String,
}

impl CloudError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn identity_provider_unreachable(message: impl Into<String>) -> Self {
        Self::new("identity_provider_unreachable", message)
    }

    pub fn api_unreachable(message: impl Into<String>) -> Self {
        Self::new("api_unreachable", message)
    }

    pub fn authorization_denied(message: impl Into<String>) -> Self {
        Self::new("authorization_denied", message)
    }

    pub fn authorization_timeout(message: impl Into<String>) -> Self {
        Self::new("authorization_timeout", message)
    }

    pub fn authorization_failed(message: impl Into<String>) -> Self {
        Self::new("authorization_failed", message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }

    pub fn credential_store(message: impl Into<String>) -> Self {
        Self::new("credential_store", message)
    }
}
