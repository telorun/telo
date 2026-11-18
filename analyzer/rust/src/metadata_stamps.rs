//! The loader's and the analyzer's stamps on a document's `metadata`, and the
//! refusal of one an author wrote. Mirrors `../../nodejs/src/metadata-stamps.ts`,
//! messages included, reading the same list in place
//! (`../../nodejs/src/metadata-stamps.json`).

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use crate::types::{kind_of, name_of, ResourceManifest};

pub const METADATA_RESERVED_FIELD: &str = "METADATA_RESERVED_FIELD";

const STAMPS_TEXT: &str = include_str!("../../nodejs/src/metadata-stamps.json");

#[derive(Deserialize)]
struct Stamp {
    field: String,
    holds: String,
}

fn stamps() -> &'static [Stamp] {
    static STAMPS: OnceLock<Vec<Stamp>> = OnceLock::new();
    STAMPS.get_or_init(|| serde_json::from_str(STAMPS_TEXT).expect("metadata-stamps.json"))
}

/// Every key the loader or the analyzer stamps onto `metadata`.
pub fn metadata_stamps() -> impl Iterator<Item = &'static str> {
    stamps().iter().map(|stamp| stamp.field.as_str())
}

/// The stamp keys a document's `metadata` holds, in written order.
pub fn written_metadata_stamps(manifest: &ResourceManifest) -> Vec<&str> {
    let Some(Value::Object(metadata)) = manifest.get("metadata") else {
        return Vec::new();
    };
    metadata
        .keys()
        .filter(|key| stamps().iter().any(|stamp| stamp.field == **key))
        .map(String::as_str)
        .collect()
}

/// Why a written stamp is refused, naming the document.
pub fn metadata_stamp_message(manifest: &ResourceManifest, field: &str) -> String {
    let kind = kind_of(manifest).unwrap_or("undefined");
    let label = match name_of(manifest) {
        Some(name) => format!("{kind}/{name}"),
        None => kind.to_string(),
    };
    let holds = stamps()
        .iter()
        .find(|stamp| stamp.field == field)
        .map(|stamp| stamp.holds.as_str())
        .unwrap_or_default();
    format!(
        "{label}: 'metadata.{field}' is written by the loader — {holds} — and cannot be written in a manifest. Remove it."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refuses_every_listed_stamp_in_written_order() {
        let fields: Vec<&str> = metadata_stamps().collect();
        let mut metadata = serde_json::Map::new();
        metadata.insert("name".into(), json!("Greeter"));
        for field in &fields {
            metadata.insert((*field).into(), json!("x"));
        }
        let manifest = json!({ "kind": "Telo.Definition", "metadata": metadata });
        assert_eq!(written_metadata_stamps(&manifest), fields);
    }

    #[test]
    fn words_the_refusal_as_node_does() {
        let manifest = json!({ "kind": "Telo.Definition", "metadata": { "name": "Greeter", "module": "Elsewhere" } });
        assert_eq!(
            metadata_stamp_message(&manifest, "module"),
            "Telo.Definition/Greeter: 'metadata.module' is written by the loader — the module the document belongs to — and cannot be written in a manifest. Remove it."
        );
    }
}
