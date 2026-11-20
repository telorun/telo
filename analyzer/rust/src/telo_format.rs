//! The registry of Telo validating formats this crate checks, binding a format name
//! to its checker (`package_url_format`, `cpe_format`, `vcs_url_format`,
//! `vcs_revision_format`). Mirrors
//! `../../nodejs/src/telo-format.ts`.
//!
//! This crate reads a manifest with no JSON Schema pass, so the formats a
//! `sources:` entry's identity declares are checked where its reader reads them.
//! The other Telo formats have no checker here yet.

use crate::{cpe_format, package_url_format, vcs_revision_format, vcs_url_format};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatFailure {
    pub reason: String,
    /// Zero-based character offset into the value where the checker stopped.
    pub offset: usize,
}

pub(crate) fn text(chars: &[char]) -> String {
    chars.iter().collect()
}

pub(crate) fn fail(reason: impl Into<String>, offset: usize) -> Option<FormatFailure> {
    Some(FormatFailure { reason: reason.into(), offset })
}

/// The sentence a refusal prints, after the value's path, as Node's
/// `describeTeloFormatFailure` words it.
pub fn describe_failure(name: &str, value: &str, failure: &FormatFailure) -> String {
    format!(
        "must be a {name}: {} at offset {} of {}",
        failure.reason,
        failure.offset,
        serde_json::to_string(value).unwrap_or_default()
    )
}

/// Why `value` is not in the grammar of the Telo format `name`, or `None` when it is
/// (or when `name` is not one this crate checks).
pub fn format_failure(name: &str, value: &str) -> Option<FormatFailure> {
    match name {
        "package-url" => package_url_format::check(value),
        "cpe" => cpe_format::check(value),
        "vcs-url" => vcs_url_format::check(value),
        "vcs-revision" => vcs_revision_format::check(value),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn assert_conformance(name: &str, text: &str) {
    let entry: serde_json::Value = serde_json::from_str(text).unwrap();
    let list = |key: &str| -> Vec<String> {
        entry["conformance"][key]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    };
    let accepted: Vec<String> =
        list("valid").into_iter().filter(|v| format_failure(name, v).is_some()).collect();
    let refused: Vec<String> =
        list("invalid").into_iter().filter(|v| format_failure(name, v).is_none()).collect();
    assert_eq!((accepted, refused), (vec![], vec![]));
    let stand_in = entry["standIn"].as_str().unwrap();
    assert_eq!(format_failure(name, stand_in), None);
}
