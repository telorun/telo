//! One authorization-code request over a loopback redirect (RFC 8252): the
//! PKCE pair, the authorize URL, and the listener that waits for the single
//! callback carrying this request's `state`. Redeeming the code is
//! `cloud_auth`'s — this module never sees a token.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use url::Url;

use crate::cloud_error::CloudError;

pub const CLIENT_ID: &str = "telo-studio-desktop";
const SCOPE: &str = "openid profile email offline_access cloud:access cloud:projects.admin";
const CALLBACK_PATH: &str = "/callback";
const AUTHORIZATION_WINDOW: Duration = Duration::from_secs(5 * 60);
const REQUEST_HEAD_LIMIT: usize = 16 * 1024;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const ERROR_TEXT_LIMIT: usize = 200;

pub struct AuthorizationRequest {
    /// Where the system browser is sent.
    pub url: String,
    pub redirect_uri: String,
    pub code_verifier: String,
    state: String,
    issuer: String,
    listener: TcpListener,
}

impl AuthorizationRequest {
    /// Binds the loopback port first: the redirect URI names it.
    pub async fn bind(accounts_url: &str, resource: &str) -> Result<Self, CloudError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| {
            CloudError::authorization_failed(format!(
                "Could not listen on 127.0.0.1 for the sign-in callback: {error}"
            ))
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| {
                CloudError::authorization_failed(format!(
                    "Could not read the sign-in callback port: {error}"
                ))
            })?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let code_verifier = random_token()?;
        let state = random_token()?;
        let nonce = random_token()?;

        let mut url = Url::parse(&format!("{accounts_url}/oauth2/authorize")).map_err(|error| {
            CloudError::authorization_failed(format!("The identity provider URL is invalid: {error}"))
        })?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", SCOPE)
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &code_challenge(&code_verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", resource);

        Ok(Self {
            url: url.into(),
            redirect_uri,
            code_verifier,
            state,
            issuer: accounts_url.to_string(),
            listener,
        })
    }

    /// Resolves with the authorization code of the one callback that carries
    /// this request's `state`. The listener closes when this returns.
    pub async fn wait_for_code(self) -> Result<String, CloudError> {
        match tokio::time::timeout(AUTHORIZATION_WINDOW, self.accept_callback()).await {
            Ok(outcome) => outcome,
            Err(_) => Err(CloudError::authorization_timeout(
                "The sign-in was not completed in the browser within 5 minutes.",
            )),
        }
    }

    async fn accept_callback(&self) -> Result<String, CloudError> {
        // Each connection is served on its own task: browsers open idle
        // speculative connections that would otherwise stall the real one.
        let (settled, mut outcomes) = mpsc::channel::<Result<String, CloudError>>(1);
        loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted.map_err(|error| {
                        CloudError::authorization_failed(format!(
                            "The sign-in callback listener failed: {error}"
                        ))
                    })?;
                    let settled = settled.clone();
                    let state = self.state.clone();
                    let issuer = self.issuer.clone();
                    tokio::spawn(async move {
                        if let Some(outcome) = serve_connection(stream, &state, &issuer).await {
                            // Only the first callback counts; a later one finds
                            // the slot taken or the wait over.
                            let _ = settled.try_send(outcome);
                        }
                    });
                }
                Some(outcome) = outcomes.recv() => return outcome,
            }
        }
    }
}

/// 32 random bytes, base64url: a PKCE verifier (RFC 7636 §4.1) or a `state`.
fn random_token() -> Result<String, CloudError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        CloudError::authorization_failed(format!(
            "The system random source is unavailable: {error}"
        ))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn code_challenge(code_verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()))
}

#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Denied { error: String, description: Option<String> },
    NotFound,
    /// A request for the callback path that is not this authorization's.
    Rejected,
}

/// Reads a request target (`/callback?code=…&state=…`).
fn read_callback(target: &str, expected_state: &str, issuer: &str) -> Callback {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Callback::NotFound;
    }
    let parameter = |name: &str| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if parameter("state").as_deref() != Some(expected_state) {
        return Callback::Rejected;
    }
    // RFC 9207: a response naming another issuer is not ours.
    if parameter("iss").is_some_and(|iss| iss != issuer) {
        return Callback::Rejected;
    }
    if let Some(error) = parameter("error") {
        return Callback::Denied { error, description: parameter("error_description") };
    }
    match parameter("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Rejected,
    }
}

/// Answers one connection. `Some` ends the wait; `None` leaves it running.
async fn serve_connection(
    mut stream: TcpStream,
    expected_state: &str,
    issuer: &str,
) -> Option<Result<String, CloudError>> {
    // A connection that never sends a request is not a callback.
    let head = tokio::time::timeout(REQUEST_HEAD_TIMEOUT, read_request_head(&mut stream))
        .await
        .ok()??;
    let mut request_line = head.lines().next().unwrap_or("").split(' ');
    let method = request_line.next().unwrap_or("");
    let target = request_line.next().unwrap_or("");

    let (status, page, outcome) = if method != "GET" {
        ("405 Method Not Allowed", NOT_FOUND_PAGE, None)
    } else {
        match read_callback(target, expected_state, issuer) {
            Callback::Code(code) => ("200 OK", SIGNED_IN_PAGE, Some(Ok(code))),
            Callback::Denied { error, description } => {
                let mut message = format!(
                    "The identity provider did not complete the sign-in: {}",
                    truncated(&error)
                );
                if let Some(description) = description.filter(|text| !text.is_empty()) {
                    message.push_str(&format!(" ({})", truncated(&description)));
                }
                ("200 OK", FAILED_PAGE, Some(Err(CloudError::authorization_denied(message))))
            }
            Callback::NotFound => ("404 Not Found", NOT_FOUND_PAGE, None),
            Callback::Rejected => ("400 Bad Request", REJECTED_PAGE, None),
        }
    };

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    // The page is a courtesy; the callback's outcome stands without it.
    if let Err(error) = write_response(&mut stream, response.as_bytes()).await {
        eprintln!("telo cloud: could not answer the sign-in callback: {error}");
    }
    outcome
}

async fn read_request_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        if head.len() > REQUEST_HEAD_LIMIT {
            return None;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(read) => head.extend_from_slice(&chunk[..read]),
        }
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}

async fn write_response(stream: &mut TcpStream, response: &[u8]) -> std::io::Result<()> {
    stream.write_all(response).await?;
    stream.shutdown().await
}

fn truncated(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(ERROR_TEXT_LIMIT).collect()
}

// Static pages only: nothing from the request is ever written back.
const SIGNED_IN_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Telo Studio</title></head><body style=\"font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; text-align: center\"><h1>You are signed in</h1><p>You can close this tab and return to Telo Studio.</p></body></html>";
const FAILED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Telo Studio</title></head><body style=\"font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; text-align: center\"><h1>Sign-in was not completed</h1><p>Return to Telo Studio to see why, and to try again.</p></body></html>";
const REJECTED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Telo Studio</title></head><body style=\"font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; text-align: center\"><h1>Not a Telo Studio sign-in</h1><p>This request does not belong to the sign-in Telo Studio is waiting for.</p></body></html>";
const NOT_FOUND_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Telo Studio</title></head><body style=\"font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; text-align: center\"><h1>Not found</h1></body></html>";

#[cfg(test)]
mod tests {
    use super::*;

    const ISSUER: &str = "https://accounts.telo.run";

    #[test]
    fn derives_the_rfc_7636_appendix_b_challenge() {
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn reads_the_code_of_a_callback_with_the_matching_state() {
        assert_eq!(
            read_callback("/callback?code=abc%2B1&state=s1", "s1", ISSUER),
            Callback::Code("abc+1".to_string())
        );
        assert_eq!(
            read_callback(
                "/callback?state=s1&code=abc&iss=https%3A%2F%2Faccounts.telo.run",
                "s1",
                ISSUER
            ),
            Callback::Code("abc".to_string())
        );
    }

    #[test]
    fn reads_an_oauth_error_as_a_denial() {
        assert_eq!(
            read_callback(
                "/callback?error=access_denied&error_description=The+user+said+no&state=s1",
                "s1",
                ISSUER
            ),
            Callback::Denied {
                error: "access_denied".to_string(),
                description: Some("The user said no".to_string()),
            }
        );
    }

    #[test]
    fn rejects_a_callback_that_is_not_this_authorization() {
        for target in [
            "/callback?code=abc&state=other",
            "/callback?code=abc",
            "/callback?error=access_denied&state=other",
            "/callback?state=s1",
            "/callback?code=&state=s1",
            "/callback?code=abc&state=s1&iss=https%3A%2F%2Fevil.example",
            "/callback",
        ] {
            assert_eq!(read_callback(target, "s1", ISSUER), Callback::Rejected, "{target}");
        }
    }

    async fn get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response.lines().next().unwrap_or("").to_string()
    }

    #[tokio::test]
    async fn the_wait_ends_only_on_the_callback_carrying_its_state() {
        let request =
            AuthorizationRequest::bind(ISSUER, "https://console.telo.cloud/api").await.unwrap();
        let authorize = Url::parse(&request.url).unwrap();
        let parameter = |name: &str| {
            authorize.query_pairs().find(|(key, _)| key == name).unwrap().1.into_owned()
        };
        let redirect = Url::parse(&parameter("redirect_uri")).unwrap();
        assert_eq!(redirect.host_str(), Some("127.0.0.1"));
        assert_eq!(redirect.path(), "/callback");
        assert_eq!(parameter("code_challenge"), code_challenge(&request.code_verifier));
        let port = redirect.port().unwrap();
        let state = parameter("state");

        let waiting = tokio::spawn(request.wait_for_code());
        // An idle connection, as a browser's preconnect leaves one.
        let idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert_eq!(get(port, "/favicon.ico").await, "HTTP/1.1 404 Not Found");
        assert_eq!(get(port, "/callback?code=stolen&state=guess").await, "HTTP/1.1 400 Bad Request");
        assert!(!waiting.is_finished());
        assert_eq!(get(port, &format!("/callback?code=c1&state={state}")).await, "HTTP/1.1 200 OK");
        assert_eq!(waiting.await.unwrap(), Ok("c1".to_string()));
        drop(idle);
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[test]
    fn answers_not_found_off_the_callback_path() {
        for target in ["/", "/favicon.ico", "/callback/x?code=abc&state=s1", "/other?state=s1"] {
            assert_eq!(read_callback(target, "s1", ISSUER), Callback::NotFound, "{target}");
        }
    }
}
