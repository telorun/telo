//! The pure half of the shell's runner credentials: which runner audiences a
//! token is asked for, how each credential is named in the OS credential
//! store, and what an identity provider's refusal means. No I/O, so it is
//! testable without the shell's runtime.

use url::Url;

/// The account a runner's own refresh token is kept under.
pub fn grant_account(resource: &str) -> String {
    format!("runner-grant:{resource}")
}

/// The account listing every runner a refresh token is kept for — the
/// credential store cannot be enumerated, and sign-out forgets them all.
pub const GRANT_INDEX_ACCOUNT: &str = "runner-grants";

/// The runners the index lists.
pub fn read_grant_index(text: Option<&str>) -> Result<Vec<String>, String> {
    match text {
        None => Ok(Vec::new()),
        Some(text) => serde_json::from_str::<Vec<String>>(text)
            .map_err(|_| "The list of runner sign-ins in the credential store is not readable.".to_string()),
    }
}

/// The index text with `resource` listed, or None when it already is.
pub fn grant_index_with(listed: &[String], resource: &str) -> Option<String> {
    if listed.iter().any(|known| known == resource) {
        return None;
    }
    let mut next = listed.to_vec();
    next.push(resource.to_string());
    serde_json::to_string(&next).ok()
}

/// The account a workspace's resume secret on one runner is kept under. The
/// two parts are JSON-encoded, so no runner id or workspace key can name
/// another entry — and no account here is ever the Cloud grant's, which is
/// the identity provider's URL.
pub fn resume_secret_account(runner: &str, workspace: &str) -> Result<String, String> {
    for (what, part) in [("runner", runner), ("workspace", workspace)] {
        if part.is_empty() || part.len() > 1024 || part.chars().any(char::is_control) {
            return Err(format!("The {what} a resume secret is kept for is not a usable name."));
        }
    }
    let parts = serde_json::to_string(&[runner, workspace])
        .map_err(|error| format!("The resume secret's name could not be written: {error}"))?;
    Ok(format!("runner-session:{parts}"))
}

/// A resume secret as a runner mints one: printable, bounded.
pub fn check_resume_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty() || secret.len() > 512 || !secret.chars().all(|c| c.is_ascii_graphic()) {
        return Err("The resume secret is not one a runner mints.".to_string());
    }
    Ok(())
}

/// `resource` is a runner audience a token may be asked for: an https base
/// URL written canonically — no credentials, query, fragment or trailing
/// slash. The webview checked it against the runner it connects to; the shell
/// refuses anything else outright.
pub fn check_runner_resource(resource: &str) -> Result<(), String> {
    let refuse = |reason: &str| Err(format!("The runner address {resource} is not usable: {reason}."));
    let Ok(url) = Url::parse(resource) else {
        return refuse("it is not a URL");
    };
    if url.scheme() != "https" {
        return refuse("a sign-in is only sent to an https runner");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return refuse("it carries credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return refuse("it carries a query or fragment");
    }
    let canonical = if url.path() == "/" {
        url.as_str().trim_end_matches('/').to_string()
    } else {
        url.as_str().to_string()
    };
    if canonical != resource || resource.ends_with('/') {
        return refuse("it is not written canonically");
    }
    Ok(())
}

/// The token type a runner token must have: one bound to the page's key.
pub fn is_dpop_token_type(token_type: Option<&str>) -> bool {
    token_type.is_some_and(|value| value.eq_ignore_ascii_case("DPoP"))
}

/// What an OAuth error from the token endpoint asks of the shell.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenRefusal {
    /// Sign again with the nonce handed out.
    UseNonce,
    /// The runner's grant cannot be used any more — revoked, expired, or
    /// bound to a key this installation no longer has: it is deleted and the
    /// runner authorized again.
    GrantUnusable,
    Other,
}

pub fn token_refusal(error: &str) -> TokenRefusal {
    match error {
        "use_dpop_nonce" => TokenRefusal::UseNonce,
        "invalid_grant" | "invalid_dpop_proof" => TokenRefusal::GrantUnusable,
        _ => TokenRefusal::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runner_resource_is_a_canonical_https_base() {
        for good in ["https://runner.example", "https://example.com/runner", "https://runner.example:8443"] {
            assert_eq!(check_runner_resource(good), Ok(()), "{good}");
        }
        for bad in [
            "http://runner.example",
            "https://runner.example/",
            "https://example.com/runner/",
            "https://Runner.example",
            "https://runner.example:443",
            "https://runner.example?x=1",
            "https://runner.example#x",
            "https://user@runner.example",
            "runner.example",
        ] {
            assert!(check_runner_resource(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_resume_secret_account_names_its_runner_and_workspace_and_nothing_else() {
        assert_eq!(
            resume_secret_account("r1", "/home/me/app").unwrap(),
            r#"runner-session:["r1","/home/me/app"]"#
        );
        assert_ne!(
            resume_secret_account("a\",\"b", "c").unwrap(),
            resume_secret_account("a", "b\",\"c").unwrap()
        );
        assert!(resume_secret_account("", "w").is_err());
        assert!(resume_secret_account("r", "w\n").is_err());
        assert!(!resume_secret_account("r", "w").unwrap().starts_with("https://"));
        assert_eq!(grant_account("https://runner.example"), "runner-grant:https://runner.example");
    }

    #[test]
    fn a_resume_secret_is_printable_and_bounded() {
        assert_eq!(check_resume_secret("abc-_DEF123"), Ok(()));
        for bad in ["", "has space", "line\nbreak"] {
            assert!(check_resume_secret(bad).is_err(), "{bad:?}");
        }
        assert!(check_resume_secret(&"x".repeat(513)).is_err());
    }

    #[test]
    fn the_grant_index_lists_each_runner_once() {
        assert_eq!(read_grant_index(None), Ok(vec![]));
        let listed = read_grant_index(Some(r#"["https://a.example"]"#)).unwrap();
        assert_eq!(grant_index_with(&listed, "https://a.example"), None);
        assert_eq!(
            grant_index_with(&listed, "https://b.example").as_deref(),
            Some(r#"["https://a.example","https://b.example"]"#)
        );
        assert!(read_grant_index(Some("not json")).is_err());
    }

    #[test]
    fn only_a_dpop_token_is_a_runner_token() {
        assert!(is_dpop_token_type(Some("DPoP")));
        assert!(is_dpop_token_type(Some("dpop")));
        assert!(!is_dpop_token_type(Some("Bearer")));
        assert!(!is_dpop_token_type(None));
    }

    #[test]
    fn reads_what_a_token_refusal_asks() {
        assert_eq!(token_refusal("use_dpop_nonce"), TokenRefusal::UseNonce);
        assert_eq!(token_refusal("invalid_grant"), TokenRefusal::GrantUnusable);
        assert_eq!(token_refusal("invalid_dpop_proof"), TokenRefusal::GrantUnusable);
        assert_eq!(token_refusal("invalid_target"), TokenRefusal::Other);
    }
}
