//! Fetching from a registry, with a refusal that names the URL and the reason.

use std::io::Read;
use std::time::Duration;

use ureq::Agent;

use crate::ReleaseError;

const USER_AGENT: &str = "telorun-release (https://github.com/telorun/telo)";

fn agent() -> Agent {
    Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(Duration::from_secs(300)))
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// The response body, or `None` for a 404; any other failure is refused.
pub fn fetch_or_absent(url: &str) -> Result<Option<Vec<u8>>, ReleaseError> {
    let mut response = agent()
        .get(url)
        .call()
        .map_err(|err| ReleaseError::new(format!("{url} cannot be reached: {err}")))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(ReleaseError::new(format!("{url} answered {} {}.", status.as_u16(), status.canonical_reason().unwrap_or(""))));
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .read_to_end(&mut bytes)
        .map_err(|err| ReleaseError::new(format!("{url} cannot be reached: {err}")))?;
    Ok(Some(bytes))
}

pub fn fetch_bytes(url: &str) -> Result<Vec<u8>, ReleaseError> {
    fetch_or_absent(url)?.ok_or_else(|| ReleaseError::new(format!("{url} answered 404.")))
}

/// A JSON document, or `None` for a 404.
pub fn fetch_json(url: &str) -> Result<Option<serde_json::Value>, ReleaseError> {
    let Some(bytes) = fetch_or_absent(url)? else { return Ok(None) };
    serde_json::from_slice(&bytes).map(Some).map_err(|err| ReleaseError::new(format!("{url} answered no JSON: {err}")))
}
