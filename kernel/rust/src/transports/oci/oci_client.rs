//! A minimal OCI distribution (registry v2) client. Mirrors
//! `../../../../nodejs/src/transports/oci/oci-client.ts`.
//!
//! **Read-only and anonymous.** `pull_manifest` and `pull_blob`, with the
//! `WWW-Authenticate` bearer-token handshake answered without credentials — what
//! a public registry such as ghcr.io serves an anonymous pull. The Node client's
//! push, tag listing and HEAD requests serve publishing and upgrades, and its
//! Docker credential chain serves private registries; this kernel does neither.
//!
//! One divergence from Node, stated rather than hidden: a **loopback** registry
//! host (`localhost`, `127.0.0.0/8`, `::1`) is spoken to over plain HTTP, the
//! rule Docker applies to local registries. Every other host is HTTPS only.
//!
//! Every request honours `TELO_EGRESS=public-only` (`transports/egress_guard.rs`)
//! — the registry URL, the token realm, and each redirect hop, which this client
//! follows itself so that no hop escapes the check. The same rule decides a hop's
//! scheme: a redirect may lead to HTTPS, or to plain HTTP only on a loopback
//! host, so an HTTPS registry cannot hand a blob off over an unencrypted link.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use ureq::http::Response;
use ureq::{Agent, Body};

use crate::transports::egress_guard::assert_public_egress;

/// Establishing a connection, TLS included.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// One whole request, body included. Generous, because a layer may be a large
/// native binary; bounded, because this kernel is synchronous and a registry
/// that accepts a connection and stops answering would otherwise hang the run.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Redirect hops followed before giving up, as ureq's own default.
const MAX_REDIRECTS: usize = 10;

/// The blob carrying `telo.yaml` — the only layer located through the OCI
/// manifest. Its bytes are verified against the import pin.
pub const TELO_MANIFEST_LAYER_MEDIA_TYPE: &str = "application/vnd.telo.module.manifest.v1+tar";

/// The pre-layers single-blob artifact: `telo.yaml` and the whole payload in one
/// layer. Still read, because it contains `telo.yaml`.
pub const TELO_LEGACY_LAYER_MEDIA_TYPE: &str = "application/vnd.telo.module.v1+tar";

const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.manifest.v1+json, \
    application/vnd.oci.image.index.v1+json, \
    application/vnd.docker.distribution.manifest.v2+json, \
    application/vnd.docker.distribution.manifest.list.v2+json";

#[derive(Debug, Clone)]
pub struct OciDescriptor {
    pub media_type: String,
    pub digest: String,
}

/// The part of an OCI manifest this kernel reads: its layer list, used only to
/// locate the manifest layer.
#[derive(Debug, Clone)]
pub struct OciManifest {
    pub layers: Vec<OciDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OciError {
    pub message: String,
}

fn oci_error(message: impl Into<String>) -> OciError {
    OciError {
        message: message.into(),
    }
}

/// A blob's OCI digest, `sha256:` + lowercase hex.
pub fn blob_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

/// Parse `Bearer realm="…",service="…",scope="…"` into lowercase-keyed params.
fn parse_bearer_challenge(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = header;
    // Each `<letters>="<value>"`; the key is the run of letters before `="`,
    // which also steps over the leading `Bearer ` scheme.
    while let Some(eq) = rest.find("=\"") {
        let key = rest[..eq]
            .rsplit(|c: char| !c.is_ascii_alphabetic())
            .next()
            .unwrap_or("");
        let value_start = eq + 2;
        let Some(len) = rest[value_start..].find('"') else {
            break;
        };
        if !key.is_empty() {
            out.insert(key.to_ascii_lowercase(), rest[value_start..value_start + len].to_string());
        }
        rest = &rest[value_start + len + 1..];
    }
    out
}

/// A redirect's `Location`, absolute, relative to the URL that answered it.
fn resolve_location(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_string();
    }
    let (scheme, rest) = base.split_once("://").unwrap_or(("https", base));
    if let Some(network_path) = location.strip_prefix("//") {
        return format!("{scheme}://{network_path}");
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if location.starts_with('/') {
        return format!("{scheme}://{authority}{location}");
    }
    let path = rest[authority.len()..].split(['?', '#']).next().unwrap_or("");
    let directory = path.rfind('/').map_or("/", |slash| &path[..=slash]);
    format!("{scheme}://{authority}{directory}{location}")
}

/// Whether `host` (with an optional port) names this machine.
fn is_loopback_host(host: &str) -> bool {
    let name = if let Some(bracketed) = host.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    name.eq_ignore_ascii_case("localhost")
        || name.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// One client per `(host, repo)`; bearer tokens are cached per scope for its
/// lifetime, so a repository pays one handshake rather than one per request.
pub struct OciClient {
    host: String,
    repo: String,
    agent: Agent,
    token_by_scope: RefCell<HashMap<String, String>>,
}

impl OciClient {
    pub fn new(host: &str, repo: &str) -> Self {
        let agent: Agent = Agent::config_builder()
            // A 401 is half of the handshake, not a failure to raise.
            .http_status_as_error(false)
            // Followed by `send`, so the egress policy sees every hop.
            .max_redirects(0)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into();
        Self {
            host: host.to_string(),
            repo: repo.to_string(),
            agent,
            token_by_scope: RefCell::new(HashMap::new()),
        }
    }

    fn origin(&self) -> String {
        let scheme = if is_loopback_host(&self.host) { "http" } else { "https" };
        format!("{scheme}://{}", self.host)
    }

    fn base(&self) -> String {
        format!("{}/v2/{}", self.origin(), self.repo)
    }

    fn pull_scope(&self) -> String {
        format!("repository:{}:pull", self.repo)
    }

    fn get(&self, url: &str, accept: Option<&str>, token: Option<&str>) -> Result<Response<Body>, OciError> {
        self.send("OCI registry request to", url, &[], accept, token)
    }

    /// GET `url`, following redirects here so each hop passes the egress check.
    /// `query` and the bearer token go to the first hop only: a redirect target
    /// is a full URL, and a registry's blob redirect points at storage that must
    /// not receive the registry's token.
    fn send(
        &self,
        what: &str,
        url: &str,
        query: &[(&str, &str)],
        accept: Option<&str>,
        token: Option<&str>,
    ) -> Result<Response<Body>, OciError> {
        let mut current = url.to_string();
        for hop in 0..=MAX_REDIRECTS {
            assert_public_egress(&current)
                .map_err(|err| oci_error(format!("{what} {current} refused: {err}")))?;
            let mut request = self.agent.get(&current);
            if let Some(accept) = accept {
                request = request.header("accept", accept);
            }
            if hop == 0 {
                for (key, value) in query {
                    request = request.query(*key, *value);
                }
                if let Some(token) = token {
                    request = request.header("authorization", format!("Bearer {token}"));
                }
            }
            let response = request.call().map_err(|err| {
                oci_error(format!(
                    "{what} {current} failed: {err}. Check the oci:// ref host."
                ))
            })?;
            let location = matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308)
                .then(|| response.headers().get("location"))
                .flatten()
                .and_then(|value| value.to_str().ok());
            let Some(location) = location else {
                return Ok(response);
            };
            let next = resolve_location(&current, location);
            let (scheme, rest) = next.split_once("://").unwrap_or(("", next.as_str()));
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
            if !scheme.eq_ignore_ascii_case("https") && !(scheme.eq_ignore_ascii_case("http") && is_loopback_host(host)) {
                return Err(oci_error(format!(
                    "{what} {url} was redirected to {next}, which is not HTTPS. A registry hop may use plain \
                     HTTP only on a loopback host, so this kernel refuses to follow it."
                )));
            }
            current = next;
        }
        Err(oci_error(format!(
            "{what} {url} failed: more than {MAX_REDIRECTS} redirects, the last to {current}"
        )))
    }

    /// GET with the bearer-token dance: try the cached token, and on a 401
    /// resolve a token from the challenge and retry once. A 401 no token could be
    /// obtained for is reported with why, since "401" alone names neither the
    /// token service nor what it said.
    fn authed_get(&self, url: &str, accept: Option<&str>, scope: &str) -> Result<Response<Body>, OciError> {
        let cached = self.token_by_scope.borrow().get(scope).cloned();
        let response = self.get(url, accept, cached.as_deref())?;
        if response.status().as_u16() != 401 {
            return Ok(response);
        }
        let unauthorized = |cause: &str| {
            oci_error(format!(
                "OCI registry request to {url} answered 401 Unauthorized, and no anonymous token was \
                 obtained: {cause}. This kernel pulls anonymously; a module a registry serves only with \
                 credentials cannot be imported here."
            ))
        };
        let Some(challenge) = response
            .headers()
            .get("www-authenticate")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
        else {
            return Err(unauthorized("the response carries no WWW-Authenticate challenge"));
        };
        let token = self.fetch_token(&challenge, scope)?.map_err(|cause| unauthorized(&cause))?;
        self.token_by_scope
            .borrow_mut()
            .insert(scope.to_string(), token.clone());
        self.get(url, accept, Some(&token))
    }

    /// Exchange a bearer challenge for an anonymous token. The inner `Err` says
    /// why the token service gave none — no realm, a refusal, or no token in its
    /// answer; the outer one is a request that could not be made at all.
    fn fetch_token(&self, challenge: &str, scope: &str) -> Result<Result<String, String>, OciError> {
        let params = parse_bearer_challenge(challenge);
        let Some(realm) = params.get("realm") else {
            return Ok(Err(format!("the challenge `{challenge}` names no token realm")));
        };
        let scope = params.get("scope").filter(|s| !s.is_empty()).map_or(scope, String::as_str);
        let mut query = Vec::new();
        if let Some(service) = params.get("service") {
            query.push(("service", service.as_str()));
        }
        query.push(("scope", scope));
        let mut response = self.send("OCI registry auth at", realm, &query, None, None)?;
        let status = response.status();
        if !status.is_success() {
            let body = read_body(&mut response, realm)?;
            let excerpt: String = String::from_utf8_lossy(&body).chars().take(200).collect();
            return Ok(Err(format!(
                "the token service at {realm} answered {status}{}",
                if excerpt.trim().is_empty() { String::new() } else { format!(": {}", excerpt.trim()) }
            )));
        }
        let body = read_body(&mut response, realm)?;
        let json: Value = serde_json::from_slice(&body).map_err(|err| {
            oci_error(format!("OCI registry auth at {realm} returned a body that is not JSON: {err}"))
        })?;
        Ok(json
            .get("token")
            .or_else(|| json.get("access_token"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("the token service at {realm} answered with no `token` or `access_token`")))
    }

    pub fn pull_manifest(&self, reference: &str) -> Result<OciManifest, OciError> {
        let url = format!("{}/manifests/{reference}", self.base());
        let mut response = self.authed_get(&url, Some(MANIFEST_ACCEPT), &self.pull_scope())?;
        if !response.status().is_success() {
            return Err(oci_error(format!(
                "OCI pull manifest {}:{reference} on {} failed: {}",
                self.repo,
                self.host,
                response.status()
            )));
        }
        let body = read_body(&mut response, &url)?;
        let json: Value = serde_json::from_slice(&body).map_err(|err| {
            oci_error(format!(
                "OCI manifest {}:{reference} on {} is not JSON: {err}",
                self.repo, self.host
            ))
        })?;
        let layers = json
            .get("layers")
            .and_then(Value::as_array)
            .map(|layers| {
                layers
                    .iter()
                    .map(|layer| {
                        let field = |name: &str| {
                            layer.get(name).and_then(Value::as_str).map(str::to_string).ok_or_else(|| {
                                oci_error(format!(
                                    "OCI manifest {}:{reference} on {} has a layer with no string `{name}`",
                                    self.repo, self.host
                                ))
                            })
                        };
                        Ok(OciDescriptor {
                            media_type: field("mediaType")?,
                            digest: field("digest")?,
                        })
                    })
                    .collect::<Result<Vec<_>, OciError>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(OciManifest { layers })
    }

    pub fn pull_blob(&self, digest: &str) -> Result<Vec<u8>, OciError> {
        let url = format!("{}/blobs/{digest}", self.base());
        let mut response = self.authed_get(&url, None, &self.pull_scope())?;
        if !response.status().is_success() {
            return Err(oci_error(format!(
                "OCI pull blob {digest} from {} on {} failed: {}",
                self.repo,
                self.host,
                response.status()
            )));
        }
        read_body(&mut response, &url)
    }
}

/// The whole body, unbounded as in Node: a layer may be a large native binary.
fn read_body(response: &mut Response<Body>, url: &str) -> Result<Vec<u8>, OciError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .read_to_end(&mut bytes)
        .map_err(|err| oci_error(format!("reading the response from {url} failed: {err}")))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaks_plain_http_to_loopback_registries_only() {
        for host in ["localhost:5000", "127.0.0.1:5000", "[::1]:5000", "127.1.2.3"] {
            assert!(OciClient::new(host, "r").origin().starts_with("http://"), "{host}");
        }
        for host in ["ghcr.io", "10.0.0.1:5000", "localhost.example.com"] {
            assert!(OciClient::new(host, "r").origin().starts_with("https://"), "{host}");
        }
    }
}
