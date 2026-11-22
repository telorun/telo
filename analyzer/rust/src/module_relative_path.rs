//! The manifest-relative POSIX form of a `path` / `source` / `local_path` value, so a
//! claim's membership is a string comparison. Node writes this function out in each of
//! `module-library.ts`, `module-browser.ts` and `module-file-claims.ts`; Rust names it once.
//! Those files' Rust twins are the callers.

/// `./` dropped from the front, then every backslash a slash.
pub fn normalize_relative(value: &str) -> String {
    value.strip_prefix("./").unwrap_or(value).replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::normalize_relative;

    #[test]
    fn drops_one_leading_dot_slash_and_flips_backslashes() {
        assert_eq!(normalize_relative("./nodejs/a.mjs"), "nodejs/a.mjs");
        assert_eq!(normalize_relative("./.\\x"), "./x");
        assert_eq!(normalize_relative("a\\b"), "a/b");
    }
}
