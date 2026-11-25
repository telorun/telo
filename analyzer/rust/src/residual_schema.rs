//! The residual JSON Schema of a `variables` / `secrets` entry. Mirrors
//! `residualEntrySchema` in `../../nodejs/src/residual-schema.ts`; the map and nullable
//! forms beside it have no Rust reader yet.

use serde_json::{Map, Value};
use telorun_sdk_core::value_type::is_instance_slot;

/// An Application host-binding entry (one with `env:` or `arg:`) without the kernel's
/// wrapper keys — `env`, `arg`, and `default`, which there is the fallback host TEXT rather
/// than a schema annotation — and, at an instance slot, without the `type:` that names how
/// text is read. A Library entry keeps its `default:`.
pub fn residual_entry_schema(entry: &Value) -> Value {
    let Some(entry) = entry.as_object() else {
        return serde_json::json!({ "type": "object", "additionalProperties": true });
    };
    let binding = entry.contains_key("env") || entry.contains_key("arg");
    let coercion_only = is_instance_slot(&Value::Object(entry.clone()));
    let mut out = Map::new();
    for (key, value) in entry {
        if binding && matches!(key.as_str(), "env" | "arg" | "default") {
            continue;
        }
        if coercion_only && key == "type" {
            continue;
        }
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}
