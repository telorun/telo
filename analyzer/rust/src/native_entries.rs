//! Mirrors `../../nodejs/src/native-entries.ts`. Only the module-relative path
//! normalizer has a Rust counterpart: this kernel resolves no native file by name,
//! and reads the paths a `sources:` block stages through it.

/// A normalized module-root-relative POSIX path, or why the written path names
/// no single file inside the module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathVerdict {
    Path(String),
    Invalid(String),
    Escape(String),
}

fn has_uri_scheme(raw: &str) -> bool {
    let Some(colon) = raw.find(':') else {
        return false;
    };
    let scheme = &raw[..colon];
    scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Normalize a module-relative path, deciding confinement from the written path
/// alone: the module root is the one directory every path is measured from, so
/// `..` below depth zero is an escape wherever the module sits.
pub fn normalize_native_path(raw: &str) -> PathVerdict {
    if has_uri_scheme(raw) || raw.starts_with('/') || raw.starts_with('\\') {
        return PathVerdict::Escape(format!(
            "path '{raw}' is not relative to the module root. A native file ships inside the module artifact, so name it relative to the directory holding telo.yaml."
        ));
    }
    if raw.contains(['*', '?', '[', ']', '{', '}']) {
        return PathVerdict::Invalid(format!(
            "path '{raw}' looks like a pattern. A native entry names exactly one file."
        ));
    }
    let mut out: Vec<&str> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.pop().is_none() {
                    return PathVerdict::Escape(format!(
                        "path '{raw}' points above the module root. A native file must ship inside the module directory."
                    ));
                }
            }
            other => out.push(other),
        }
    }
    if out.is_empty() {
        return PathVerdict::Invalid(format!(
            "path '{raw}' resolves to the module root, not to a file."
        ));
    }
    PathVerdict::Path(out.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_as_the_node_reader_does() {
        assert_eq!(normalize_native_path("./native/../native//x.node"), PathVerdict::Path("native/x.node".into()));
        assert!(matches!(normalize_native_path("../x"), PathVerdict::Escape(_)));
        assert!(matches!(normalize_native_path("file:x"), PathVerdict::Escape(_)));
        assert!(matches!(normalize_native_path("native/*.node"), PathVerdict::Invalid(_)));
        assert!(matches!(normalize_native_path("./"), PathVerdict::Invalid(_)));
    }
}
