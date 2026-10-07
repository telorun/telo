//! Building a CEL map, and the one identity a key has — `cel-map-value.ts`.
//!
//! A map's entries are keyed by each key's own typed value. So one container holds
//! CEL's four key types, an int key and a uint key of the same number are ONE key
//! (CEL equality makes them equal, so a literal writing both is a duplicate), and a
//! string `"1"` is never the int `1`.
//!
//! Node exports with no twin in this file:
//! - `celMapOf` — wraps an entries map Node's callers build themselves; here a map is
//!   built only by `cel_map_from_entries`, and the empty one is `CelMap::default()`.
//!
//! `cel_map_from_entries` takes key/value pairs where Node takes a flat list: the flat
//! shape is a JavaScript allocation device, and it admits an odd length.

use crate::cel_value::{cel_error, CelError, CelEvaluationCode, CelMap, CelMapKey, CelValue};
use crate::value_text::json_quote;

/// What identifies a key. The integer covers the numeric types together: `1`, `1u` and
/// `1.0` are one key, so a lookup by any of the three finds the entry. A double that is
/// not whole identifies nothing, since no entry can hold it; a whole double beyond the
/// integer's width answers an identity no entry holds.
pub fn map_key_identity(key: &CelValue) -> Option<CelMapKey> {
    match key {
        CelValue::String(text) => Some(CelMapKey::String(text.clone())),
        CelValue::Bool(held) => Some(CelMapKey::Bool(*held)),
        CelValue::Int(held) => Some(CelMapKey::Integer(i128::from(*held))),
        CelValue::Uint(held) => Some(CelMapKey::Integer(i128::from(*held))),
        // The cast saturates, and neither end of an `i128` is an int or a uint.
        CelValue::Double(held) if held.is_finite() && held.trunc() == *held => Some(CelMapKey::Integer(*held as i128)),
        _ => None,
    }
}

/// A map from its entries in written order, or the error that stops it: an entry whose
/// key or value is itself an error (the key's first), a key of a type no map is keyed
/// by, or two keys CEL equality makes one.
pub fn cel_map_from_entries(entries: impl IntoIterator<Item = (CelValue, CelValue)>) -> Result<CelMap, CelError> {
    let mut map = CelMap::default();
    for (key, value) in entries {
        if let CelValue::Error(error) = key {
            return Err(error);
        }
        if let CelValue::Error(error) = value {
            return Err(error);
        }
        // A map is BUILT with an int, uint, bool or string key: a double is not a key
        // type, even one that is whole. It still LOOKS one up.
        let identity = match &key {
            CelValue::Double(_) => None,
            other => map_key_identity(other),
        };
        let Some(identity) = identity else {
            return Err(cel_error(
                CelEvaluationCode::UnsupportedKeyType,
                "a map is keyed by an int, a uint, a bool or a string",
                None,
            ));
        };
        let described = describe_key(&key);
        if !map.insert_new(identity, key, value) {
            return Err(cel_error(
                CelEvaluationCode::DuplicateMapKey,
                format!("the key {described} is written twice"),
                None,
            ));
        }
    }
    Ok(map)
}

fn describe_key(key: &CelValue) -> String {
    match key {
        CelValue::String(text) => json_quote(text),
        CelValue::Uint(held) => format!("{held}u"),
        CelValue::Int(held) => held.to_string(),
        CelValue::Bool(held) => held.to_string(),
        _ => String::new(),
    }
}

/// Every key of a map, in insertion order — what a comprehension ranges over.
pub fn cel_map_keys(map: &CelMap) -> Vec<CelValue> {
    map.iter().map(|(key, _)| key.clone()).collect()
}
