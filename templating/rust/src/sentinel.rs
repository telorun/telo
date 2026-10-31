//! Tagged-sentinel representation, mirroring `../../nodejs/src/sentinel.ts`.
//!
//! A YAML tag such as `!ref writeLine` cannot survive as a tag once the document
//! becomes plain JSON, so the parser rewrites it to a marker object carrying the
//! engine name and the original source text. Keeping the same shape as the Node
//! implementation means a manifest tree is the same value on either kernel.

use serde_json::{json, Map, Value};

use crate::engines::r#ref::{parse_ref_source, ParsedRef, RefIndex, RefVerdict};

/// Engine name for the reference tag, `!ref`.
pub const REF_ENGINE: &str = "ref";

/// Build the marker object a tagged scalar becomes. A `!ref` one carries the
/// `!ref` engine's verdict on its text (`parsed` or `refusal`), so no reader
/// keeps a grammar of its own.
pub fn make_tagged_sentinel(engine: &str, source: &str) -> Value {
    let mut sentinel = Map::new();
    sentinel.insert("__tagged".to_string(), Value::Bool(true));
    sentinel.insert("engine".to_string(), json!(engine));
    sentinel.insert("source".to_string(), json!(source));
    if engine == REF_ENGINE {
        let (key, verdict) = parse_ref_source(source).to_json_entry();
        sentinel.insert(key.to_string(), verdict);
    }
    Value::Object(sentinel)
}

/// The engine's verdict a `!ref` sentinel carries — read off `parsed` /
/// `refusal`, or, for a sentinel built without one, the engine's verdict on its
/// text. `None` for anything that is not a `!ref` sentinel.
pub fn ref_sentinel_verdict(value: &Value) -> Option<RefVerdict> {
    let source = ref_sentinel_source(value)?;
    if let Some(parsed) = value.get("parsed").and_then(parsed_from_json) {
        return Some(RefVerdict::Parsed(parsed));
    }
    if let Some(offset) = value
        .get("refusal")
        .and_then(|refusal| refusal.get("offset"))
        .and_then(Value::as_u64)
    {
        return Some(RefVerdict::Refusal { offset: offset as usize });
    }
    Some(parse_ref_source(source))
}

fn parsed_from_json(value: &Value) -> Option<ParsedRef> {
    let name = value.get("name")?.as_str()?.to_string();
    let alias = value.get("alias").and_then(Value::as_str).map(str::to_string);
    let mut indexes = Vec::new();
    for index in value.get("indexes")?.as_array()? {
        let binding = index.get("binding")?.as_str()?.to_string();
        let member = match index.get("member")?.as_str()? {
            "key" => "key",
            "index" => "index",
            _ => return None,
        };
        indexes.push(RefIndex { binding, member });
    }
    Some(ParsedRef { alias, name, indexes })
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
