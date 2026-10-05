//! The desktop build's Telo Cloud transport: the webview names a method, a
//! path under the API base, headers and a body; the shell attaches the bearer
//! and streams the answer back. The webview chooses neither the host nor the
//! credential, so nothing it holds is worth sending elsewhere.

use futures_util::{FutureExt, StreamExt};
use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};
use url::Url;

use crate::cloud_auth::{transport_reason, Cloud, CloudState};
use crate::cloud_error::CloudError;

/// Body bytes are gathered up to this size before one channel message is
/// sent: each message above 1 KiB costs the webview a fetch of its own.
const CHUNK_TARGET: usize = 256 * 1024;

/// Never taken from the webview. The first three are the credential and the
/// destination; the rest describe a body and a connection the shell frames
/// itself, and an `accept-encoding` would return bytes nothing here decodes.
const SHELL_OWNED_HEADERS: [&str; 7] = [
    "authorization",
    "cookie",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "accept-encoding",
];

#[derive(Debug, Deserialize)]
pub struct CloudRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CloudResponseHead {
    status: u16,
    headers: Vec<(String, String)>,
}

/// What was sent on the chunk channel. A chunk reaches the webview through a
/// fetch of its own, so the command can resolve before the last one lands;
/// the count is how the webview knows it has them all.
#[derive(Debug, Clone, Serialize)]
pub struct CloudResponseEnd {
    chunks: u64,
    bytes: u64,
}

/// The URL for a webview-supplied path, or a refusal. Only a plain absolute
/// path is accepted, and the result must still sit under the API base.
fn api_url(api_base: &Url, api_base_text: &str, path: &str) -> Result<Url, CloudError> {
    let refuse = |reason: &str| {
        CloudError::invalid_request(format!("The Telo Cloud path was refused: {reason}."))
    };
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(refuse("it must start with a single '/'"));
    }
    if path.contains('\\') {
        return Err(refuse("it contains a backslash"));
    }
    if path.chars().any(char::is_control) {
        return Err(refuse("it contains a control character"));
    }
    if path.contains('#') {
        return Err(refuse("it contains a fragment"));
    }
    let segments = path.split_once('?').map_or(path, |(segments, _)| segments);
    // A URL parser reads the percent-encoded spellings as dot segments too.
    let climbs = segments.split('/').any(|segment| {
        matches!(segment.to_ascii_lowercase().as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
    });
    if climbs {
        return Err(refuse("it contains a '..' segment"));
    }

    let url = Url::parse(&format!("{api_base_text}{path}"))
        .map_err(|error| refuse(&error.to_string()))?;
    let base_path = api_base.path().trim_end_matches('/');
    let under_base = url.path() == base_path
        || url.path().strip_prefix(base_path).is_some_and(|rest| rest.starts_with('/'));
    if url.origin() != api_base.origin()
        || !under_base
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(refuse("it does not stay under the API base"));
    }
    Ok(url)
}

fn forwarded_headers(headers: &[(String, String)]) -> Result<Vec<(HeaderName, HeaderValue)>, CloudError> {
    let mut forwarded = Vec::new();
    for (name, value) in headers {
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            CloudError::invalid_request(format!("'{name}' is not a valid header name."))
        })?;
        if SHELL_OWNED_HEADERS.contains(&header.as_str()) {
            continue;
        }
        let value = HeaderValue::from_str(value).map_err(|_| {
            CloudError::invalid_request(format!("The value of header '{name}' is not valid."))
        })?;
        forwarded.push((header, value));
    }
    Ok(forwarded)
}

struct PreparedRequest {
    method: reqwest::Method,
    url: Url,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Option<String>,
}

impl PreparedRequest {
    fn new(cloud: &Cloud, request: CloudRequest) -> Result<Self, CloudError> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| {
            CloudError::invalid_request(format!("'{}' is not an HTTP method.", request.method))
        })?;
        Ok(Self {
            method,
            url: api_url(&cloud.settings.api_base, &cloud.settings.api_base_text, &request.path)?,
            headers: forwarded_headers(&request.headers)?,
            body: request.body,
        })
    }

    async fn send(&self, cloud: &Cloud, bearer: Option<&str>) -> Result<reqwest::Response, CloudError> {
        let mut builder = cloud.http.request(self.method.clone(), self.url.clone());
        for (name, value) in &self.headers {
            builder = builder.header(name, value);
        }
        if let Some(bearer) = bearer {
            builder = builder.bearer_auth(bearer);
        }
        if let Some(body) = &self.body {
            builder = builder.body(body.clone());
        }
        builder.send().await.map_err(|error| {
            CloudError::api_unreachable(format!(
                "Telo Cloud could not be reached: {}",
                transport_reason(&error)
            ))
        })
    }
}

#[tauri::command]
pub async fn cloud_request(
    app: AppHandle,
    state: State<'_, CloudState>,
    request: CloudRequest,
    on_head: Channel<CloudResponseHead>,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<CloudResponseEnd, CloudError> {
    let cloud = state.cloud()?;
    let prepared = PreparedRequest::new(&cloud, request)?;

    // With no grant the request goes out bare and the API's own 401 is the
    // answer.
    let bearer = cloud.bearer(&app, None).await?;
    let mut response = prepared.send(&cloud, bearer.as_deref()).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        if let Some(rejected) = bearer {
            if let Some(renewed) = cloud.bearer(&app, Some(&rejected)).await? {
                response = prepared.send(&cloud, Some(&renewed)).await?;
            }
        }
    }

    let undeliverable = |error: tauri::Error| {
        CloudError::api_unreachable(format!(
            "Telo Cloud's answer could not be handed to the editor: {error}"
        ))
    };
    let head = CloudResponseHead {
        status: response.status().as_u16(),
        headers: response
            .headers()
            .iter()
            .map(|(name, value)| {
                (name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned())
            })
            .collect(),
    };
    on_head.send(head).map_err(undeliverable)?;

    let mut end = CloudResponseEnd { chunks: 0, bytes: 0 };
    let mut send_chunk = |chunk: Vec<u8>| -> Result<(), CloudError> {
        end.chunks += 1;
        end.bytes += chunk.len() as u64;
        on_chunk.send(InvokeResponseBody::Raw(chunk)).map_err(undeliverable)
    };
    let mut body = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        // Gather what has already arrived; wait only with nothing to send.
        let next = if pending.is_empty() {
            body.next().await
        } else {
            match body.next().now_or_never() {
                Some(next) => next,
                None => {
                    send_chunk(std::mem::take(&mut pending))?;
                    continue;
                }
            }
        };
        match next {
            Some(Ok(bytes)) => {
                pending.extend_from_slice(&bytes);
                if pending.len() >= CHUNK_TARGET {
                    send_chunk(std::mem::take(&mut pending))?;
                }
            }
            Some(Err(error)) => {
                return Err(CloudError::api_unreachable(format!(
                    "Telo Cloud's answer was cut short: {}",
                    transport_reason(&error)
                )));
            }
            None => break,
        }
    }
    if !pending.is_empty() {
        send_chunk(pending)?;
    }
    Ok(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://console.telo.cloud/api";

    fn resolve(path: &str) -> Result<String, CloudError> {
        api_url(&Url::parse(BASE).unwrap(), BASE, path).map(String::from)
    }

    #[test]
    fn accepts_a_plain_path_under_the_api_base() {
        assert_eq!(resolve("/v1/workspaces").unwrap(), "https://console.telo.cloud/api/v1/workspaces");
        assert_eq!(resolve("/session").unwrap(), "https://console.telo.cloud/api/session");
        assert_eq!(
            resolve("/v1/workspaces/wks_1/repository/head?branch=feature/a..b").unwrap(),
            "https://console.telo.cloud/api/v1/workspaces/wks_1/repository/head?branch=feature/a..b"
        );
    }

    #[test]
    fn refuses_anything_that_is_not_a_plain_absolute_path() {
        for path in [
            "//evil.com",
            "/../x",
            "/v1/../../x",
            "/v1/%2e%2E/x",
            "/v1/..?a=1",
            "https://x",
            "v1/workspaces",
            "",
            "/v1\\x",
            "/v1\nx",
            "/v1\tx",
            "/v1#fragment",
            "@evil.com/x",
        ] {
            assert_eq!(resolve(path).unwrap_err().code, "invalid_request", "{path:?}");
        }
    }

    #[test]
    fn drops_the_headers_the_shell_owns_and_forwards_the_rest() {
        let headers = [
            ("Authorization", "Bearer stolen"),
            ("cookie", "a=b"),
            ("HOST", "evil.com"),
            ("Content-Length", "3"),
            ("Accept-Encoding", "gzip"),
            ("Content-Type", "application/json"),
            ("Idempotency-Key", "k1"),
        ]
        .map(|(name, value)| (name.to_string(), value.to_string()));
        let forwarded: Vec<(String, String)> = forwarded_headers(&headers)
            .unwrap()
            .into_iter()
            .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_string()))
            .collect();
        assert_eq!(
            forwarded,
            [("content-type", "application/json"), ("idempotency-key", "k1")]
                .map(|(name, value)| (name.to_string(), value.to_string()))
        );
    }

    #[test]
    fn refuses_a_header_that_cannot_be_sent() {
        for (name, value) in [("bad name", "x"), ("x-a", "line\nbreak")] {
            let headers = [(name.to_string(), value.to_string())];
            assert_eq!(forwarded_headers(&headers).unwrap_err().code, "invalid_request");
        }
    }
}
