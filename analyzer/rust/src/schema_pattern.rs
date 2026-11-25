//! The pattern language of a JSON Schema in Telo: RE2, through one seam. Twins
//! `@telorun/sdk`'s `schema-pattern.ts`; it lives here rather than in `sdk/rust/core`
//! because no Rust controller compiles a schema pattern — this crate's validator is the
//! only reader, of `pattern`, the keys of `patternProperties` and `format: regex`.
//!
//! A match is an unanchored search, compiled by `telorun-cel`'s RE2 and its one bounded
//! cache. The `u` flag a validator passes is accepted and changes nothing; any other is
//! refused. A refusal reads `invalid RE2 pattern "<pattern>": <RE2's parse-error kind>`.

use std::sync::Arc;

use telorun_cel::{re2_pattern, Re2Flags, Re2Program};

/// Why `pattern` is not a schema pattern under `flags`, or `None` when it is one.
pub fn schema_pattern_refusal(pattern: &str, flags: &str) -> Option<String> {
    if let Some(flag) = flags.chars().find(|flag| *flag != 'u') {
        return Some(format!("invalid RE2 pattern \"{pattern}\": flag \"{flag}\" is not supported"));
    }
    re2_pattern(pattern, Re2Flags::NONE)
        .err()
        .map(|refused| format!("invalid RE2 pattern \"{pattern}\": {}", refused.kind))
}

/// A compiled schema pattern, or the refusal's sentence.
pub fn schema_pattern(pattern: &str, flags: &str) -> Result<Arc<Re2Program>, String> {
    if let Some(refusal) = schema_pattern_refusal(pattern, flags) {
        return Err(refusal);
    }
    re2_pattern(pattern, Re2Flags::NONE).map_err(|refused| format!("invalid RE2 pattern \"{pattern}\": {}", refused.message))
}

/// `format: regex` as the seam reads it: a schema pattern RE2 accepts.
pub fn schema_regex_format(value: &str) -> bool {
    schema_pattern_refusal(value, "").is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_re2_refuses_in_re2_words() {
        assert_eq!(
            schema_pattern_refusal("^(?!x)", "").as_deref(),
            Some("invalid RE2 pattern \"^(?!x)\": invalid or unsupported Perl syntax")
        );
        assert_eq!(schema_pattern_refusal("a", "g").as_deref(), Some("invalid RE2 pattern \"a\": flag \"g\" is not supported"));
        assert!(schema_pattern("b+", "u").unwrap().is_match("abbc"));
        assert!(schema_regex_format("\\x{41}"));
    }
}
