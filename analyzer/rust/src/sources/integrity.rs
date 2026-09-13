//! Inline module integrity — the `#sha256-<base64url>` fragment carried on a
//! remote import ref. Mirrors `../../../nodejs/src/sources/integrity.ts`.
//!
//! The fragment is authoritative across every transport: a source hashes the
//! fetched bytes and compares against it before the manifest is parsed or
//! cached. A mismatch is a terminal error — never a cache miss.
//!
//! Only what the Rust kernel consumes is here. `verifiedFetch` and its
//! object-storage sniff belong to the Node analyzer's HTTP source, which has no
//! Rust counterpart; `foldIntegrity` and `isCanonicalIntegrity` serve the import
//! object form and pin writing, neither of which this kernel implements.

use sha2::{Digest, Sha256};

const SHA256_PREFIX: &str = "sha256-";

/// A failed integrity/tamper check — always terminal, never best-effort.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct IntegrityError {
    pub message: String,
}

impl IntegrityError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// A ref with its trailing integrity fragment split off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitRef<'a> {
    /// The bare ref, safe to build fetch URLs and cache paths from.
    pub base: &'a str,
    /// The fragment, e.g. `sha256-<base64url>`, when present.
    pub integrity: Option<&'a str>,
}

/// Split a trailing integrity fragment off a ref/URL. Only a
/// `#sha256-<base64url>` suffix is integrity; any other `#` fragment passes
/// through untouched. Tolerates the padded / standard-base64 spellings
/// [`verify_integrity`] normalizes.
pub fn split_integrity(reference: &str) -> SplitRef<'_> {
    // The fragment's alphabet excludes `#`, so only the last `#` can start one.
    if let Some(hash) = reference.rfind('#') {
        let fragment = &reference[hash + 1..];
        let digest = fragment.strip_prefix(SHA256_PREFIX).unwrap_or("");
        let is_integrity = !digest.is_empty()
            && digest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '/' | '=' | '-'));
        if is_integrity {
            return SplitRef {
                base: &reference[..hash],
                integrity: Some(fragment),
            };
        }
    }
    SplitRef {
        base: reference,
        integrity: None,
    }
}

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn to_base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let symbols = chunk.len() + 1;
        for i in 0..symbols {
            out.push(BASE64URL[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out
}

/// Normalize an encoded digest to unpadded base64url so a standard-base64 or
/// padded input still compares equal to the canonical form.
fn normalize_digest(value: &str) -> String {
    value
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

/// SHA-256 of `bytes` as unpadded base64url — the canonical inline-hash form.
pub fn sha256_base64url(bytes: &[u8]) -> String {
    to_base64url(&Sha256::digest(bytes))
}

/// Hash `bytes` and compare against `integrity` (`<alg>-<digest>`). `describe`
/// names the artifact in the error so the failure is actionable.
pub fn verify_integrity(bytes: &[u8], integrity: &str, describe: &str) -> Result<(), IntegrityError> {
    let (algorithm, expected) = match integrity.find('-') {
        Some(dash) if dash > 0 => (&integrity[..dash], &integrity[dash + 1..]),
        _ => ("", ""),
    };
    if algorithm != "sha256" {
        let named = if algorithm.is_empty() { integrity } else { algorithm };
        return Err(IntegrityError::new(format!(
            "Unsupported integrity algorithm '{named}' for {describe}. Only sha256 is supported (sha256-<base64url>)."
        )));
    }
    let actual = sha256_base64url(bytes);
    let expected = normalize_digest(expected);
    if actual != expected {
        return Err(IntegrityError::new(format!(
            "Integrity check failed for {describe}: expected sha256-{expected}, got sha256-{actual}. \
             The fetched bytes do not match the recorded hash — the module may have been tampered with or republished."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors `analyzer/nodejs/tests/integrity.test.ts` § splitIntegrity.
    #[test]
    fn splits_only_an_integrity_fragment() {
        assert_eq!(
            split_integrity("oci://ghcr.io/telorun/console@0.9.0#sha256-AAAA"),
            SplitRef {
                base: "oci://ghcr.io/telorun/console@0.9.0",
                integrity: Some("sha256-AAAA"),
            }
        );
        assert_eq!(
            split_integrity("oci://ghcr.io/telorun/console@0.9.0").integrity,
            None
        );
        assert_eq!(
            split_integrity("http://x/a.yaml#section"),
            SplitRef {
                base: "http://x/a.yaml#section",
                integrity: None,
            }
        );
    }

    /// Mirrors § verifyIntegrity: a match passes, a padded standard-base64
    /// spelling of the same digest passes, a mismatch and an unknown algorithm
    /// are terminal and name the artifact.
    #[test]
    fn verifies_a_pin() {
        let bytes = b"abc";
        // Node's `createHash("sha256").update("abc").digest("base64url")`.
        let pin = format!("sha256-{}", sha256_base64url(bytes));
        assert_eq!(pin, "sha256-ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
        verify_integrity(bytes, &pin, "ref").unwrap();
        verify_integrity(bytes, "sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", "ref").unwrap();

        let mismatch = verify_integrity(b"tampered", "sha256-AAAA", "oci://ghcr.io/aws/s3@1.0.0")
            .unwrap_err();
        assert!(
            mismatch
                .message
                .starts_with("Integrity check failed for oci://ghcr.io/aws/s3@1.0.0"),
            "{mismatch}"
        );
        let algorithm = verify_integrity(b"x", "md5-AAAA", "ref").unwrap_err();
        assert!(algorithm.message.starts_with("Unsupported integrity algorithm 'md5'"), "{algorithm}");
    }
}
