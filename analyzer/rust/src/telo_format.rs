//! The registry of Telo validating formats, binding each format name of
//! `sdk/formats/*.json` to its checker. Mirrors `../../nodejs/src/telo-format.ts`: the
//! JSON Schema validator (`schema_validation`) checks every one, and the readers of a
//! `sources:` entry's identity ask the same checkers.

use crate::{
    cpe_format, css_selector_format, language_tag_format, message_pattern_format, package_url_format, path_template_format,
    re2_pattern_format, vcs_revision_format, vcs_url_format,
};

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

/// Every Telo format, lexically by name — the vocabulary `sdk/formats/` declares.
pub const TELO_FORMATS: [&str; 9] = [
    "cpe",
    "css-selector",
    "language-tag",
    "message-pattern",
    "package-url",
    "path-template",
    "re2-pattern",
    "vcs-revision",
    "vcs-url",
];

/// Whether `name` is a Telo format.
pub fn is_telo_format(name: &str) -> bool {
    TELO_FORMATS.contains(&name)
}

/// Why `value` is not in the grammar of the Telo format `name`, or `None` when it is
/// (or when `name` is not a Telo format).
pub fn format_failure(name: &str, value: &str) -> Option<FormatFailure> {
    match name {
        "cpe" => cpe_format::check(value),
        "css-selector" => css_selector_format::check(value),
        "language-tag" => language_tag_format::check(value),
        "message-pattern" => message_pattern_format::check(value),
        "package-url" => package_url_format::check(value),
        "path-template" => path_template_format::check(value),
        "re2-pattern" => re2_pattern_format::check(value),
        "vcs-revision" => vcs_revision_format::check(value),
        "vcs-url" => vcs_url_format::check(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn checks_every_format_the_vocabulary_declares() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdk/formats");
        let mut declared: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
            .collect();
        declared.sort();
        assert_eq!(declared, super::TELO_FORMATS);
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
