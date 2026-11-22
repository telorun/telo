//! Where a module requested by an http(s) URL is read from. A PARTIAL twin of
//! `../../../nodejs/src/sources/http-source.ts`: only `httpManifestUrl`, the rule the module-file
//! walk asks of every module's requested ref. The source itself has no Rust twin — no Rust host
//! reads a manifest over HTTP, and an import through it is refused as a construct this build
//! cannot read.

use crate::sources::integrity::split_integrity;
use crate::types::DEFAULT_MANIFEST_FILENAME;

/// The URL a module requested as `reference` is read from, or `None` when `reference` is not an
/// http(s) URL: the URL itself when it names a YAML file, else the `telo.yaml` beneath it.
pub fn http_manifest_url(reference: &str) -> Option<String> {
    let base = split_integrity(reference).base;
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return None;
    }
    Some(if base.contains(".yaml") { base.to_string() } else { format!("{base}/{DEFAULT_MANIFEST_FILENAME}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_yaml_url_as_itself_and_a_directory_url_as_its_telo_yaml() {
        assert_eq!(http_manifest_url("https://example.test/chat/telo.yaml").as_deref(), Some("https://example.test/chat/telo.yaml"));
        assert_eq!(http_manifest_url("https://example.test/chat").as_deref(), Some("https://example.test/chat/telo.yaml"));
        assert_eq!(http_manifest_url("./chat"), None);
        assert_eq!(http_manifest_url("oci://example.test/chat@1.0.0"), None);
    }
}
