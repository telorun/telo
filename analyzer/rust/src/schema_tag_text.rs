//! A copy of a JSON Schema with every tagged value reduced to its source text, for the
//! validator to compile. Mirrors `../../nodejs/src/schema-tag-text.ts`: a published kind's
//! `description` may quote `${{ }}` prose a migration reads as `!interpolate`, and the
//! meta-schema refuses an object where a keyword expects a string. Never removes a
//! structural node, so the validator accepts exactly the data it would have.

use serde_json::{Map, Value};
use telo_templating::tagged_sentinel_parts;

pub fn schema_with_tags_as_text(value: &Value) -> Value {
    if let Some((_, source)) = tagged_sentinel_parts(value) {
        return Value::String(source.to_string());
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(schema_with_tags_as_text).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), schema_with_tags_as_text(v))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}
