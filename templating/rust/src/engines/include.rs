//! The `!include-text` / `!include-bytes` file-embedding tags, mirroring
//! `../../../nodejs/src/engines/include.ts`.
//!
//! Only the path grammar lives here — the half that must give the same answer on
//! both kernels, because it decides what a manifest MEANS. Reading the file is
//! the kernel's, and the two kernels differ there: see
//! `kernel/rust/src/resolve_include_sentinels.rs`.

/// Engine name for the text-embedding tag, `!include-text`.
pub const INCLUDE_TEXT_ENGINE: &str = "include-text";
/// Engine name for the byte-embedding tag, `!include-bytes`.
pub const INCLUDE_BYTES_ENGINE: &str = "include-bytes";

/// True when `engine` names one of the two file-embedding tags.
pub fn is_include_engine(engine: &str) -> bool {
    engine == INCLUDE_TEXT_ENGINE || engine == INCLUDE_BYTES_ENGINE
}

/// Why a written path is not a usable module-relative reference.
#[derive(Debug, PartialEq, Eq)]
pub struct IncludePathError {
    pub message: String,
}

impl IncludePathError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Normalize an `!include-*` source to a module-root-relative path, or explain
/// why it is not one.
///
/// Pure string work, exactly as in the Node half: the path is root-relative by
/// definition, so `..` below depth zero is an escape regardless of where the
/// module sits on disk, and confinement never needs a filesystem to decide.
pub fn normalize_include_path(source: &str) -> Result<String, IncludePathError> {
    let raw = source.trim();
    if raw.is_empty() {
        return Err(IncludePathError::new(
            "the path is empty — name a file relative to the module root.",
        ));
    }
    if has_uri_scheme(raw) {
        return Err(IncludePathError::new(format!(
            "'{raw}' names a location outside the module. An include path is a file that ships \
             inside the module artifact, written relative to the module root."
        )));
    }
    if raw.contains(['*', '?', '[', ']', '{', '}']) {
        return Err(IncludePathError::new(format!(
            "'{raw}' looks like a pattern. An include path names exactly one file."
        )));
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(IncludePathError::new(format!(
            "'{raw}' is an absolute path. An include path is written relative to the module root, \
             so the same manifest resolves identically from a checkout and from a published artifact."
        )));
    }

    let mut out: Vec<&str> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => continue,
            ".." => {
                // Depth zero is the module root; popping past it names a file the
                // artifact could never carry.
                if out.pop().is_none() {
                    return Err(IncludePathError::new(format!(
                        "'{raw}' points above the module root. An include path may only name a \
                         file inside the module."
                    )));
                }
            }
            other => out.push(other),
        }
    }
    if out.is_empty() {
        return Err(IncludePathError::new(format!(
            "'{raw}' resolves to the module root, not to a file."
        )));
    }
    Ok(out.join("/"))
}

/// `scheme:` prefix — a URL, or a Windows drive letter.
fn has_uri_scheme(raw: &str) -> bool {
    let mut chars = raw.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_dot_segments_to_a_root_relative_path() {
        assert_eq!(normalize_include_path("./assets/logo.svg").unwrap(), "assets/logo.svg");
        assert_eq!(normalize_include_path("assets/./logo.svg").unwrap(), "assets/logo.svg");
    }

    #[test]
    fn resolves_an_interior_parent_segment() {
        assert_eq!(
            normalize_include_path("assets/fonts/../logo.svg").unwrap(),
            "assets/logo.svg"
        );
    }

    #[test]
    fn normalizes_backslash_separators() {
        assert_eq!(normalize_include_path("assets\\logo.svg").unwrap(), "assets/logo.svg");
    }

    #[test]
    fn rejects_paths_above_the_module_root() {
        assert!(normalize_include_path("../outside.txt").is_err());
        assert!(normalize_include_path("assets/../../outside.txt").is_err());
    }

    #[test]
    fn rejects_absolute_paths_urls_and_globs() {
        assert!(normalize_include_path("/etc/passwd").is_err());
        assert!(normalize_include_path("https://example.com/a.png").is_err());
        assert!(normalize_include_path("assets/*.svg").is_err());
    }

    #[test]
    fn rejects_an_empty_path_and_one_that_is_the_root() {
        assert!(normalize_include_path("").is_err());
        assert!(normalize_include_path("./").is_err());
    }

    #[test]
    fn a_dotted_filename_is_not_a_uri_scheme() {
        assert_eq!(normalize_include_path("assets/a.b.c.svg").unwrap(), "assets/a.b.c.svg");
    }
}
