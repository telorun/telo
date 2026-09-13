//! The `oci://host/repo@reference[#sha256-…]` module ref grammar.
//! Mirrors `../../../nodejs/src/sources/oci-ref.ts`.

use crate::sources::integrity::split_integrity;

pub const OCI_SCHEME: &str = "oci://";

/// A parsed `oci://host/repo@reference` module ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOciRef {
    /// The registry host (`ghcr.io`, `127.0.0.1:5000`).
    pub host: String,
    /// The repository path, possibly multi-segment (`aws/telo-s3`).
    pub repo: String,
    /// A tag or a `sha256:` digest — the OCI address.
    pub reference: String,
    /// Telo's inline `sha256-<base64url>` pin, authoritative across transports.
    pub integrity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OciRefError {
    pub message: String,
}

/// True when `reference` uses the `oci://` scheme (integrity fragment tolerated).
pub fn is_oci_ref(reference: &str) -> bool {
    split_integrity(reference).base.starts_with(OCI_SCHEME)
}

/// Parse `oci://host/repo@reference[#sha256-...]`. A missing `@reference`
/// defaults to `latest`, matching OCI tooling.
pub fn parse_oci_ref(reference: &str) -> Result<ParsedOciRef, OciRefError> {
    let split = split_integrity(reference);
    let invalid = |detail: &str| OciRefError {
        message: format!("Invalid OCI reference '{reference}', {detail}"),
    };
    let rest = split
        .base
        .strip_prefix(OCI_SCHEME)
        .ok_or_else(|| invalid("expected oci://host/repo@reference"))?;
    let slash = match rest.find('/') {
        Some(slash) if slash > 0 => slash,
        _ => return Err(invalid("missing repository path after host")),
    };
    let host = &rest[..slash];
    let mut repo = &rest[slash + 1..];

    let mut address = "latest";
    // A digest reference is `repo@sha256:...` — the `@` before `sha256:` is the
    // separator, not part of the repo.
    if let Some(at) = repo.rfind('@') {
        if at > 0 {
            address = &repo[at + 1..];
            repo = &repo[..at];
        }
    }
    if host.is_empty() || repo.is_empty() || address.is_empty() {
        return Err(invalid("expected oci://host/repo@reference"));
    }
    Ok(ParsedOciRef {
        host: host.to_string(),
        repo: repo.to_string(),
        reference: address.to_string(),
        integrity: split.integrity.map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors `kernel/nodejs/tests/oci-transport.test.ts` § OCI ref parsing.
    #[test]
    fn parses_host_repo_reference_and_integrity() {
        assert_eq!(
            parse_oci_ref("oci://ghcr.io/aws/telo-s3@1.2.0#sha256-abc").unwrap(),
            ParsedOciRef {
                host: "ghcr.io".into(),
                repo: "aws/telo-s3".into(),
                reference: "1.2.0".into(),
                integrity: Some("sha256-abc".into()),
            }
        );
        let digest = format!("sha256:{}", "a".repeat(64));
        let parsed = parse_oci_ref(&format!("oci://127.0.0.1:5000/acme/mod@{digest}")).unwrap();
        assert_eq!((parsed.host.as_str(), parsed.repo.as_str()), ("127.0.0.1:5000", "acme/mod"));
        assert_eq!(parsed.reference, digest);
    }

    #[test]
    fn defaults_the_reference_to_latest_and_recognizes_the_scheme() {
        assert_eq!(parse_oci_ref("oci://ghcr.io/aws/telo-s3").unwrap().reference, "latest");
        assert!(is_oci_ref("oci://ghcr.io/x/y@1"));
        assert!(!is_oci_ref("std/console@0.9.0"));
    }
}
