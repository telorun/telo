//! The `.origins.json` record beside the manifest cache: which OCI manifest digest
//! produced each cached copy of a mutable tag. Mirrors
//! `../../../nodejs/src/manifest-sources/origin-digests.ts`; both kernels write one
//! record format.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};
use telo_analyzer::sources::oci_ref::{parse_oci_ref, OciRefError};

/// Sits beside `.validated.json` inside `<cacheRoot>/manifests/`.
pub const ORIGINS_FILE: &str = ".origins.json";
const ORIGINS_VERSION: u64 = 1;

/// Identity under which a mutable ref's origin digest is recorded: `host/repo@tag`,
/// independent of scheme spelling.
pub fn origin_key(reference: &str) -> Result<String, OciRefError> {
    let parsed = parse_oci_ref(reference)?;
    Ok(format!("{}/{}@{}", parsed.host, parsed.repo, parsed.reference))
}

/// The recorded origin digests of one manifest cache directory. A missing, unreadable or
/// version-mismatched record is empty: a cached tag with no record is one nothing has
/// verified, which every reader treats as unknown.
pub fn read_origin_digests(manifests_dir: &Path) -> BTreeMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(manifests_dir.join(ORIGINS_FILE)) else {
        return BTreeMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return BTreeMap::new();
    };
    if parsed.get("version").and_then(Value::as_u64) != Some(ORIGINS_VERSION) {
        return BTreeMap::new();
    }
    let Some(digests) = parsed.get("digests").and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    digests
        .iter()
        .filter_map(|(key, digest)| digest.as_str().map(|digest| (key.clone(), digest.to_string())))
        .collect()
}

/// Persist origin digests, merging over what the record already held so a write for one
/// entry never drops another's.
pub fn write_origin_digests(manifests_dir: &Path, digests: &BTreeMap<String, String>) -> std::io::Result<()> {
    if digests.is_empty() {
        return Ok(());
    }
    let mut merged = read_origin_digests(manifests_dir);
    merged.extend(digests.iter().map(|(key, digest)| (key.clone(), digest.clone())));
    let mut entries: Vec<(String, String)> = merged.into_iter().collect();
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let digests: serde_json::Map<String, Value> =
        entries.into_iter().map(|(key, digest)| (key, Value::String(digest))).collect();
    let record = json!({ "version": ORIGINS_VERSION, "digests": digests });
    std::fs::create_dir_all(manifests_dir)?;
    let text = serde_json::to_string_pretty(&record).expect("a JSON value serializes");
    std::fs::write(manifests_dir.join(ORIGINS_FILE), format!("{text}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_merges_over_the_record_and_a_read_returns_it_sorted() {
        let dir = std::env::temp_dir().join(format!("telo-origins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read_origin_digests(&dir).is_empty());
        write_origin_digests(&dir, &BTreeMap::from([("b".to_string(), "sha256:2".to_string())])).unwrap();
        write_origin_digests(&dir, &BTreeMap::from([("a".to_string(), "sha256:1".to_string())])).unwrap();
        let text = std::fs::read_to_string(dir.join(ORIGINS_FILE)).unwrap();
        assert_eq!(
            text,
            "{\n  \"version\": 1,\n  \"digests\": {\n    \"a\": \"sha256:1\",\n    \"b\": \"sha256:2\"\n  }\n}\n"
        );
        assert_eq!(origin_key("oci://ghcr.io/telorun/console@0.9.0#sha256-abc").unwrap(), "ghcr.io/telorun/console@0.9.0");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
