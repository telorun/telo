//! A Docker ignore file read as Telo glob exclude patterns.
//!
//! Docker anchors every pattern at the build-context root, and a pattern
//! naming a directory excludes everything beneath it, so each line is rewritten
//! into its anchored form plus that form's subtree. Last-match-wins is shared
//! by both, so a `!` re-include keeps its meaning.

use crate::ReleaseError;

pub fn dockerignore_patterns(text: &str, file: &str) -> Result<Vec<String>, ReleaseError> {
    let mut patterns = Vec::new();
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains(['[', ']', '\\']) {
            return Err(ReleaseError::new(format!(
                "{file}:{}: '{line}' uses a character class or an escape, which the image digest cannot read the way Docker does — rewrite it with '*', '?' and '**' only",
                index + 1
            )));
        }
        let negated = line.starts_with('!');
        let body = if negated { &line[1..] } else { line };
        let body = body.trim_start_matches('/').trim_end_matches('/');
        let prefix = if negated { "!/" } else { "/" };
        patterns.push(format!("{prefix}{body}"));
        patterns.push(format!("{prefix}{body}/"));
    }
    Ok(patterns)
}
