//! The `vcs-revision` Telo format: a full commit id, 40 (SHA-1) or 64 (SHA-256)
//! lower-case hexadecimal digits. Mirrors `../../nodejs/src/vcs-revision-format.ts`
//! and runs the same conformance set, `sdk/formats/vcs-revision.json`.

use crate::telo_format::{fail, FormatFailure};

const REASON: &str = "a revision is a full commit id of 40 (SHA-1) or 64 (SHA-256) lower-case hexadecimal digits; a tag, a branch or an abbreviated id is not accepted";

pub(crate) fn check(value: &str) -> Option<FormatFailure> {
    let chars: Vec<char> = value.chars().collect();
    if let Some(bad) = chars.iter().position(|c| !matches!(c, '0'..='9' | 'a'..='f')) {
        return fail(REASON, bad);
    }
    if chars.len() != 40 && chars.len() != 64 {
        return fail(format!("{REASON} (this one has {})", chars.len()), chars.len().min(40));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telo_format::assert_conformance;

    #[test]
    fn agrees_with_the_shared_conformance_set() {
        assert_conformance("vcs-revision", include_str!("../../../sdk/formats/vcs-revision.json"));
    }

    #[test]
    fn refuses_a_tag() {
        assert!(check("version-3.51.3").unwrap().reason.starts_with("a revision is a full commit id"));
    }
}
