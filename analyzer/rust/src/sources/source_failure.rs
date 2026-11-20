//! Why a manifest source could not hand over a module, from one closed set. Mirrors
//! `../../../nodejs/src/sources/source-failure.ts`; `file_url` stands in for Node's
//! `pathToFileURL`, since a location is always written as a URL and this crate's
//! sources hand over paths.

use std::fmt;
use std::path::Path;

/// The kind of failure, as both halves name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFailureKind {
    NotFound,
    NotAModule,
    Unreadable,
    Refused,
    Unreachable,
}

impl SourceFailureKind {
    /// The kind as `data.sourceFailure` writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            SourceFailureKind::NotFound => "not-found",
            SourceFailureKind::NotAModule => "not-a-module",
            SourceFailureKind::Unreadable => "unreadable",
            SourceFailureKind::Refused => "refused",
            SourceFailureKind::Unreachable => "unreachable",
        }
    }
}

/// A source's failure to read what it was asked for: the kind, the canonical URL asked
/// for (`file://`, `oci://`), and for `Refused` the status the host answered. The
/// transport's own text is never part of it. An integrity mismatch is not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestSourceFailure {
    pub kind: SourceFailureKind,
    pub location: String,
    pub status: Option<u16>,
}

impl ManifestSourceFailure {
    pub fn new(kind: SourceFailureKind, location: impl Into<String>) -> Self {
        Self { kind, location: location.into(), status: None }
    }

    /// The sentence the failure is reported with, after
    /// `Cannot resolve import '<alias>' → '<source>': `.
    pub fn sentence(&self) -> String {
        let loc = &self.location;
        match self.kind {
            SourceFailureKind::NotFound => format!("nothing exists at {loc}."),
            SourceFailureKind::NotAModule => format!("{loc} is not a module: it holds no telo.yaml."),
            SourceFailureKind::Unreadable => format!("{loc} exists but cannot be read."),
            SourceFailureKind::Refused => format!(
                "the host refused the request for {loc} (HTTP {}).",
                self.status.map_or_else(|| "error".to_string(), |status| status.to_string())
            ),
            SourceFailureKind::Unreachable => {
                format!("{loc} cannot be reached: no connection to its host could be made.")
            }
        }
    }
}

impl fmt::Display for ManifestSourceFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.sentence())
    }
}

/// A filesystem read's failure: a path that does not exist, or runs through a file, is
/// `NotFound`, anything else `Unreadable`.
pub fn file_source_failure(error: &std::io::Error, location: impl Into<String>) -> ManifestSourceFailure {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => SourceFailureKind::NotFound,
        _ => SourceFailureKind::Unreadable,
    };
    ManifestSourceFailure::new(kind, location)
}

/// A request answered with a non-2xx status: `NotFound` for 404, else `Refused`.
pub fn http_source_failure(status: u16, location: impl Into<String>) -> ManifestSourceFailure {
    if status == 404 {
        ManifestSourceFailure::new(SourceFailureKind::NotFound, location)
    } else {
        ManifestSourceFailure { kind: SourceFailureKind::Refused, location: location.into(), status: Some(status) }
    }
}

/// The `file://` URL of an absolute path, encoded as Node's `pathToFileURL` encodes it.
pub fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = if cfg!(windows) { text.replace('\\', "/") } else { text.into_owned() };
    let mut out = String::from("file://");
    if !text.starts_with('/') {
        out.push('/');
    }
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@[]|^".contains(&byte);
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_each_kind_as_node_does() {
        let at = |kind| ManifestSourceFailure::new(kind, "file:///ws/lib").sentence();
        assert_eq!(at(SourceFailureKind::NotFound), "nothing exists at file:///ws/lib.");
        assert_eq!(at(SourceFailureKind::NotAModule), "file:///ws/lib is not a module: it holds no telo.yaml.");
        assert_eq!(at(SourceFailureKind::Unreadable), "file:///ws/lib exists but cannot be read.");
        assert_eq!(
            http_source_failure(403, "oci://r.test/a@1").sentence(),
            "the host refused the request for oci://r.test/a@1 (HTTP 403)."
        );
        assert_eq!(http_source_failure(404, "oci://r.test/a@1").kind, SourceFailureKind::NotFound);
        assert_eq!(
            at(SourceFailureKind::Unreachable),
            "file:///ws/lib cannot be reached: no connection to its host could be made."
        );
    }

    #[test]
    fn encodes_a_path_as_path_to_file_url_does() {
        assert_eq!(file_url(Path::new("/a b/c#d%e/ü.yaml")), "file:///a%20b/c%23d%25e/%C3%BC.yaml");
    }
}
