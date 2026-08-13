//! Tagged-sentinel representation, mirroring `../../nodejs/src/sentinel.ts`.
//!
//! A YAML tag such as `!ref writeLine` cannot survive as a tag once the document
//! becomes plain JSON, so the parser rewrites it to a marker object carrying the
//! engine name and the original source text. Keeping the same shape as the Node
//! implementation means a manifest tree is the same value on either kernel.

use serde_json::{json, Value};

/// Engine name for the reference tag, `!ref`.
pub const REF_ENGINE: &str = "ref";

/// Build the marker object a tagged scalar becomes.
pub fn make_tagged_sentinel(engine: &str, source: &str) -> Value {
    json!({ "__tagged": true, "engine": engine, "source": source })
}

/// True when `value` is any tagged sentinel.
pub fn is_tagged_sentinel(value: &Value) -> bool {
    value
        .get("__tagged")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && value.get("engine").and_then(Value::as_str).is_some()
        && value.get("source").and_then(Value::as_str).is_some()
}

/// The `(engine, source)` pair of any tagged sentinel, or `None` for anything
/// else. What a consumer needs to dispatch on the tag without re-deriving the
/// shape check.
pub fn tagged_sentinel_parts(value: &Value) -> Option<(&str, &str)> {
    if !is_tagged_sentinel(value) {
        return None;
    }
    Some((
        value.get("engine")?.as_str()?,
        value.get("source")?.as_str()?,
    ))
}

/// The source text of a `!ref` sentinel, or `None` for anything else.
pub fn ref_sentinel_source(value: &Value) -> Option<&str> {
    if !is_tagged_sentinel(value) {
        return None;
    }
    if value.get("engine").and_then(Value::as_str) != Some(REF_ENGINE) {
        return None;
    }
    value.get("source").and_then(Value::as_str)
}
