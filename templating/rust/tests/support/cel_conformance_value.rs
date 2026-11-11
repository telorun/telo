//! The conformance value (`templating/cel-conformance/README.md`): the typed frame held as a
//! JSON value, plus the `$cel` forms for a type, an optional and a host value — the twin of
//! `templating/nodejs/tests/cel-conformance-value.ts`.
//!
//! The typed frame is the writer: a row pins exactly what a host is handed, in the
//! encoding every Telo boundary uses. Every value is canonical — a plain map's keys in
//! ECMAScript's order over the code-unit-sorted keys (array indices first, as a JavaScript
//! object holds them), a tagged map's pairs by the code units of each key's JSON text — and
//! a node that is not the canonical writing of what it reads is refused, compared
//! order-sensitively.
//!
//! Node items with no twin: `unpairedSurrogateAt` — a Rust string holds no unpaired
//! surrogate, so a file holding one fails to read (as UTF-8, or as JSON on an escape)
//! before any value is decoded; and `forFrame`, the identity step Node keeps for its frame.

#![allow(dead_code)]

use serde_json::{Map, Value};
use std::sync::Arc;

use telorun_cel_value::{
    cel_map_from_entries, cel_none, cel_some, cel_type_value, compare_code_units, CelHostValue, CelRecord, CelValue,
    PropertyMap, CEL_VALUE_KEYS,
};
use telorun_sdk_core::typed_frame::{decode_typed_frame, encode_typed_frame, TYPED_FRAME_TAG};

const CEL_TAG: &str = "$cel";

fn refuse(path: &[String], detail: impl std::fmt::Display) -> String {
    format!("Cannot write a conformance value: '/{}' {detail}.", path.join("/"))
}

fn unreadable(path: &[String], detail: impl std::fmt::Display) -> String {
    format!("Cannot read a conformance value: '/{}' {detail}.", path.join("/"))
}

/// How a type value is spelled in the vectors, which is not how the engine names it.
fn recorded_type_name(name: &str) -> &str {
    if name == "null_type" {
        "null"
    } else {
        name
    }
}

fn engine_type_name(recorded: &str) -> &str {
    if recorded == "null" {
        "null_type"
    } else {
        recorded
    }
}

/// A value as the typed frame writes it — the text a handler row pins.
pub fn typed_frame_text(value: &CelValue) -> Result<String, String> {
    encode_typed_frame(value).map_err(|error| error.message)
}

/// What makes two keys one key, as CEL equality does: an int and a uint of one number.
fn map_key_identity(key: &CelValue) -> Option<String> {
    match key {
        CelValue::String(text) => Some(format!("s{text}")),
        CelValue::Bool(held) => Some(format!("b{held}")),
        CelValue::Int(held) => Some(format!("n{held}")),
        CelValue::Uint(held) => Some(format!("n{held}")),
        _ => None,
    }
}

fn scalar(value: &CelValue, path: &[String]) -> Result<Value, String> {
    let text = typed_frame_text(value).map_err(|message| refuse(path, format!("is refused by the typed frame ({message})")))?;
    serde_json::from_str(&text).map_err(|error| refuse(path, format!("is frame text JSON does not read ({error})")))
}

fn write(value: &CelValue, path: &[String]) -> Result<Value, String> {
    let mut at = path.to_vec();
    Ok(match value {
        CelValue::Type(held) => tagged_cel("type", Some(Value::String(recorded_type_name(held.name()).into()))),
        CelValue::Optional(optional) => match optional.held() {
            None => tagged_cel("optional", None),
            Some(held) => {
                at.push("value".into());
                tagged_cel("optional", Some(write(held, &at)?))
            }
        },
        CelValue::List(list) => {
            let mut items = Vec::with_capacity(list.len());
            for (index, item) in list.iter().enumerate() {
                at.push(index.to_string());
                items.push(write(item, &at)?);
                at.pop();
            }
            Value::Array(items)
        }
        CelValue::Map(map) => write_map(map.iter().map(|(key, value)| (key.clone(), value.clone())).collect(), path)?,
        CelValue::Record(record) => write_map(
            record.iter().map(|(key, value)| (CelValue::String(key.into()), value.clone())).collect(),
            path,
        )?,
        CelValue::Host(host) if host.type_name().is_some() => {
            let mut at = path.to_vec();
            at.push("value".into());
            let entries = write_map(
                host.entries().iter().map(|(key, value)| (CelValue::String(key.into()), value.clone())).collect(),
                &at,
            )?;
            let mut object = Map::new();
            object.insert(CEL_TAG.into(), Value::String("host".into()));
            object.insert("type".into(), Value::String(host.type_name().expect("named").into()));
            object.insert("value".into(), entries);
            Value::Object(object)
        }
        CelValue::Error(error) => return Err(refuse(path, format!("is the CEL error '{}', which is not a value", error.message))),
        _ => scalar(value, path)?,
    })
}

fn tagged_cel(form: &str, value: Option<Value>) -> Value {
    let mut object = Map::new();
    object.insert(CEL_TAG.into(), Value::String(form.into()));
    if let Some(value) = value {
        object.insert("value".into(), value);
    }
    Value::Object(object)
}

fn write_map(entries: Vec<(CelValue, CelValue)>, path: &[String]) -> Result<Value, String> {
    let mut seen: Vec<String> = Vec::new();
    // Each pair: its encoded key, the text it orders by, the key as a plain string where it
    // is one, and its encoded value.
    let mut pairs: Vec<(Value, String, Option<String>, Value)> = Vec::new();
    let mut plain = true;
    for (key, entry) in entries {
        let identity = map_key_identity(&key)
            .ok_or_else(|| refuse(path, "holds a key that is not an int, uint, bool or string"))?;
        if seen.contains(&identity) {
            return Err(refuse(path, format!("holds two keys equal to {}", key_text(&key))));
        }
        seen.push(identity);
        let text = match &key {
            CelValue::String(text) => Some(text.to_string()),
            _ => None,
        };
        if text.as_deref().is_none_or(|text| text == TYPED_FRAME_TAG || text == CEL_TAG) {
            plain = false;
        }
        let encoded_key = scalar(&key, path)?;
        let order = text.clone().unwrap_or_else(|| encoded_key.to_string());
        let mut at = path.to_vec();
        at.push(key_text(&key));
        pairs.push((encoded_key, order, text, write(&entry, &at)?));
    }
    if plain {
        pairs.sort_by(|left, right| compare_code_units(&left.1, &right.1));
        let mut object = Map::new();
        for key in es_key_order(pairs.iter().map(|pair| pair.2.as_deref().expect("a plain key is a string"))) {
            let pair = pairs.iter().find(|pair| pair.2.as_deref() == Some(key)).expect("each key is held");
            object.insert(key.into(), pair.3.clone());
        }
        return Ok(Value::Object(object));
    }
    pairs.sort_by(|left, right| compare_code_units(&left.0.to_string(), &right.0.to_string()));
    let mut object = Map::new();
    object.insert(TYPED_FRAME_TAG.into(), Value::String("map".into()));
    object.insert(
        "value".into(),
        Value::Array(pairs.into_iter().map(|(key, _, _, value)| Value::Array(vec![key, value])).collect()),
    );
    Ok(Value::Object(object))
}

/// How a JavaScript object orders keys it was given in this order: array indices
/// ascending, then the rest as given.
fn es_key_order<'k>(keys: impl Iterator<Item = &'k str>) -> Vec<&'k str> {
    let keys: Vec<&str> = keys.collect();
    let mut indices: Vec<(u32, &str)> = keys.iter().filter_map(|key| array_index(key).map(|index| (index, *key))).collect();
    indices.sort_unstable();
    let mut out: Vec<&str> = indices.into_iter().map(|(_, key)| key).collect();
    out.extend(keys.iter().filter(|key| array_index(key).is_none()));
    out
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_digit()) || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// A key as JavaScript's `String(key)` writes it, for a path or a refusal.
fn key_text(key: &CelValue) -> String {
    match key {
        CelValue::String(text) => text.to_string(),
        CelValue::Bool(held) => held.to_string(),
        CelValue::Int(held) => held.to_string(),
        CelValue::Uint(held) => held.to_string(),
        other => format!("{other:?}"),
    }
}

fn read(node: &Value, path: &[String]) -> Result<CelValue, String> {
    match node {
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let mut at = path.to_vec();
                at.push(index.to_string());
                out.push(read(item, &at)?);
            }
            Ok(CelValue::List(out.into()))
        }
        Value::Object(object) if object.contains_key(CEL_TAG) => read_cel(object, path),
        Value::Object(object) if object.contains_key(TYPED_FRAME_TAG) => {
            if object.get(TYPED_FRAME_TAG) == Some(&Value::String("map".into())) {
                read_map(object, path)
            } else {
                read_scalar(node, path)
            }
        }
        Value::Object(object) => {
            let mut record = CelRecord::new();
            for (key, entry) in object {
                let mut at = path.to_vec();
                at.push(key.clone());
                record.insert(key.clone(), read(entry, &at)?);
            }
            Ok(CelValue::Record(record))
        }
        _ => read_scalar(node, path),
    }
}

fn read_scalar(node: &Value, path: &[String]) -> Result<CelValue, String> {
    decode_typed_frame(&node.to_string())
        .map_err(|error| unreadable(path, format!("is refused by the typed frame ({})", error.message)))
}

fn read_cel(object: &Map<String, Value>, path: &[String]) -> Result<CelValue, String> {
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_by(|left, right| compare_code_units(left, right));
    let form = object.get(CEL_TAG).and_then(Value::as_str);
    match (form, keys.as_slice(), object.get("value")) {
        (Some("type"), ["$cel", "value"], Some(Value::String(name))) => {
            Ok(CelValue::Type(cel_type_value(engine_type_name(name))))
        }
        (Some("optional"), ["$cel"], None) => Ok(CelValue::Optional(cel_none())),
        (Some("optional"), ["$cel", "value"], Some(held)) => {
            let mut at = path.to_vec();
            at.push("value".into());
            Ok(CelValue::Optional(cel_some(read(held, &at)?)))
        }
        (Some("host"), ["$cel", "type", "value"], Some(Value::Object(entries))) => {
            let name = object.get("type").and_then(Value::as_str);
            let plain = !entries.contains_key(CEL_TAG) && !entries.contains_key(TYPED_FRAME_TAG);
            match name {
                Some(name) if plain && !CEL_VALUE_KEYS.contains(&name) => {
                    let mut held = PropertyMap::new();
                    for (key, entry) in entries {
                        let mut at = path.to_vec();
                        at.extend(["value".to_string(), key.clone()]);
                        held.insert(key.clone(), read(entry, &at)?);
                    }
                    CelHostValue::with_entries(name, Arc::new(()), held)
                        .map(CelValue::Host)
                        .map_err(|refusal| unreadable(path, format!("is a host value ({refusal:?})")))
                }
                _ => Err(unreadable(path, "is a host value, which carries a host's type name and a plain map of its entries")),
            }
        }
        _ => Err(unreadable(path, format!("is not a '{CEL_TAG}' type, optional or host form"))),
    }
}

fn read_map(object: &Map<String, Value>, path: &[String]) -> Result<CelValue, String> {
    let Some(Value::Array(pairs)) = object.get("value").filter(|_| object.len() == 2) else {
        return Err(unreadable(path, "is a tagged map, which carries exactly a list of pairs as its 'value'"));
    };
    let mut entries = Vec::with_capacity(pairs.len());
    for (index, pair) in pairs.iter().enumerate() {
        let mut at = path.to_vec();
        at.extend(["value".to_string(), index.to_string()]);
        let Some([key, value]) = pair.as_array().map(Vec::as_slice) else {
            return Err(unreadable(&at, "is not a [key, value] pair"));
        };
        let mut key_at = at.clone();
        key_at.push("0".into());
        let key = read_scalar(key, &key_at)?;
        if map_key_identity(&key).is_none() {
            return Err(unreadable(&at, "holds a key that is not an int, uint, bool or string"));
        }
        let mut value_at = at;
        value_at.push("1".into());
        entries.push((key, read(value, &value_at)?));
    }
    cel_map_from_entries(entries)
        .map(CelValue::Map)
        .map_err(|error| unreadable(path, format!("is a map the CEL domain refuses ({})", error.message)))
}

/// A value as the vectors write it. Refuses a value that does not read back to the same
/// writing.
pub fn encode(value: &CelValue) -> Result<Value, String> {
    let encoded = write(value, &[])?;
    let again = write(&read(&encoded, &[])?, &[])?;
    if again.to_string() != encoded.to_string() {
        return Err(refuse(&[], format!("does not survive the round trip: {encoded} reads back as {again}")));
    }
    Ok(encoded)
}

/// The value a node writes. Refuses a node that is not the canonical writing of it.
pub fn decode(node: &Value) -> Result<CelValue, String> {
    let value = read(node, &[])?;
    let canonical = write(&value, &[])?;
    if canonical.to_string() != node.to_string() {
        return Err(unreadable(&[], format!("is not in its canonical form {canonical}")));
    }
    Ok(value)
}
