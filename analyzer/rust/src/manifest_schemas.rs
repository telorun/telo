//! The manifest root every validator registers under `telo://manifest`, so a schema can
//! `$ref` the shared fragments (`telo://manifest#/$defs/<Name>`). Mirrors
//! `ManifestRootSchema` of `../../nodejs/src/manifest-schemas.ts`: the fragments of
//! `sdk/builtins/fragments/`, each as written, lexically by name.

use std::sync::{Arc, OnceLock};

use telorun_cel::{read_json_text, JsonValue};
use telorun_cel_value::PropertyMap;

include!(concat!(env!("OUT_DIR"), "/manifest_fragments.rs"));

/// The id the manifest root is registered under.
pub const MANIFEST_SCHEMA_URI: &str = "telo://manifest";

/// The manifest root: `{ $id: telo://manifest, $defs: { <fragment>… } }`.
pub fn manifest_root_schema() -> Arc<JsonValue> {
    static ROOT: OnceLock<Arc<JsonValue>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let defs: PropertyMap<Arc<JsonValue>> = MANIFEST_FRAGMENT_FILES
            .iter()
            .map(|(name, text)| {
                let fragment = read_json_text(text).unwrap_or_else(|_| panic!("sdk/builtins/fragments/{name}.json: a fragment is JSON"));
                assert!(matches!(&*fragment, JsonValue::Object(_)), "sdk/builtins/fragments/{name}.json: a fragment is a JSON Schema object.");
                (*name, fragment)
            })
            .collect();
        let root: PropertyMap<Arc<JsonValue>> = [
            ("$id", Arc::new(JsonValue::String(MANIFEST_SCHEMA_URI.into()))),
            ("$defs", Arc::new(JsonValue::Object(defs))),
        ]
        .into_iter()
        .collect();
        Arc::new(JsonValue::Object(root))
    })
    .clone()
}
