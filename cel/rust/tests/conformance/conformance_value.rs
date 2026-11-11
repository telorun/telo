//! The conformance value: the vectors' one encoding for every value, read into this
//! engine's domain and written back out of it — the twin of
//! `cel/nodejs/conformance/conformance-value.ts`.
//!
//! It is the typed frame (`kernel/specs/durable-execution.md` §6) held as a JSON value,
//! plus three `$cel` forms: a type value, an optional, and a value of a host's own named
//! type — its type name and its entries. Writing is **canonical** — one text per value —
//! so comparing a row's recorded answer against the engine's is a comparison of two
//! texts: an int, a uint and a double never encode alike, NaN and `-0` are written as
//! tags, a plain map's keys are written in ECMAScript's order over the keys sorted by
//! UTF-16 code unit (array indices first, as a JavaScript object holds them), and a tagged
//! map's pairs are ordered by the code units of each key's JSON text.
//!
//! It is written here, in the driver, rather than taken from a Telo crate: this engine
//! depends on nothing in the repository but its value crate, and a conformance row is
//! data the driver reads. Text is written by [`json_text`] with the value crate's
//! ECMAScript number text and JSON quoting, never by serde_json's writer (`100.0`, `1e21`).
//!
//! **The recording spells the null type `null`**, where this engine names the type value
//! `null_type`. Both directions map it.
//!
//! Rust-only: a node is read in the order the file writes its keys (serde_json's
//! `preserve_order`), where Node's `JSON.parse` moves array-index keys first — so a plain
//! map written in another order is refused here and read by Node.

#![allow(dead_code)]

use std::sync::Arc;

use serde_json::{Map, Number, Value};
use telorun_cel::{
    cel_none, cel_some, cel_type_value, format_timestamp, parse_timestamp, CelHostValue, CelValue,
    PropertyMap, CEL_VALUE_KEYS,
};
use telorun_cel_value::{
    cel_map_from_entries, compare_code_units, es_number, format_duration, json_quote, parse_duration,
};

const FRAME_TAG: &str = "$telo";
const CEL_TAG: &str = "$cel";

/// A value the encoding cannot carry, or a node it does not define. Refusing is never a
/// stand-in.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ConformanceValueError(pub String);

impl std::fmt::Display for ConformanceValueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refuse<T>(message: impl Into<String>) -> Result<T, ConformanceValueError> {
    Err(ConformanceValueError(message.into()))
}

/// A JSON value as `JSON.stringify` writes it: numbers as ECMAScript writes them,
/// strings JSON-quoted, an object's keys in the order it holds them, no space.
pub fn json_text(node: &Value) -> String {
    let mut out = String::new();
    write_json(node, &mut out);
    out
}

fn write_json(node: &Value, out: &mut String) {
    match node {
        Value::Null => out.push_str("null"),
        Value::Bool(held) => out.push_str(if *held { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&es_number(number_value(number))),
        Value::String(text) => out.push_str(&json_quote(text)),
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            out.push('{');
            for (at, (key, item)) in object.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&json_quote(key));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// A JSON number as the double `JSON.parse` reads it as.
pub fn number_value(number: &Number) -> f64 {
    number.as_f64().expect("serde_json holds every number it reads as a double, an i64 or a u64")
}

/// Deep equality as `isDeepStrictEqual` answers it over parsed JSON: an object's keys in
/// any order, numbers by `Object.is`.
pub fn json_deep_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (number_value(a), number_value(b));
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
        }
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_deep_equal(a, b)),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(key, held)| b.get(key).is_some_and(|other| json_deep_equal(held, other)))
        }
        (a, b) => a == b,
    }
}

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied();
        let c = chunk.get(2).copied();
        out.push(BASE64URL[usize::from(a >> 2)] as char);
        out.push(BASE64URL[usize::from(((a & 3) << 4) | (b.unwrap_or(0) >> 4))] as char);
        let Some(b) = b else { break };
        out.push(BASE64URL[usize::from(((b & 15) << 2) | (c.unwrap_or(0) >> 6))] as char);
        let Some(c) = c else { break };
        out.push(BASE64URL[usize::from(c & 63)] as char);
    }
    out
}

fn unbase64url(text: &str) -> Result<Vec<u8>, ConformanceValueError> {
    let mut bits = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let Some(at) = BASE64URL.iter().position(|held| u32::from(*held) == u32::from(ch)) else {
            return refuse(format!("{} is not base64url", json_quote(text)));
        };
        bits.push(at as u8);
    }
    let mut out = Vec::with_capacity(bits.len() * 3 / 4);
    for group in bits.chunks(4) {
        let a = group[0];
        if let Some(&b) = group.get(1) {
            out.push((a << 2) | (b >> 4));
            if let Some(&c) = group.get(2) {
                out.push((b << 4) | (c >> 2));
                if let Some(&d) = group.get(3) {
                    out.push((c << 6) | d);
                }
            }
        }
    }
    Ok(out)
}

/// How a type value is spelled in the vectors, which is not always how it is here.
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

fn object(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

fn tagged(tag: &str, payload: String) -> Value {
    object([(FRAME_TAG, Value::String(tag.into())), ("value", Value::String(payload))])
}

/// A value as the vectors write it, canonically. Refuses a value outside the domain.
pub fn encode_conformance_value(value: &CelValue) -> Result<Value, ConformanceValueError> {
    Ok(match value {
        CelValue::Null => Value::Null,
        CelValue::Bool(held) => Value::Bool(*held),
        CelValue::String(text) => Value::String(text.to_string()),
        CelValue::Double(held) => {
            if held.is_nan() {
                tagged("double", "NaN".into())
            } else if *held == f64::INFINITY {
                tagged("double", "Infinity".into())
            } else if *held == f64::NEG_INFINITY {
                tagged("double", "-Infinity".into())
            } else if *held == 0.0 && held.is_sign_negative() {
                tagged("double", "-0".into())
            } else {
                Value::Number(Number::from_f64(*held).expect("a finite double is a JSON number"))
            }
        }
        CelValue::Int(held) => tagged("int", held.to_string()),
        CelValue::Uint(held) => tagged("uint", held.to_string()),
        CelValue::Bytes(bytes) => tagged("bytes", base64url(bytes)),
        CelValue::Timestamp(instant) => tagged("google.protobuf.Timestamp", format_timestamp(*instant)),
        CelValue::Duration(span) => tagged("google.protobuf.Duration", format_duration(*span)),
        CelValue::Type(held) => object([
            (CEL_TAG, Value::String("type".into())),
            ("value", Value::String(recorded_type_name(held.name()).into())),
        ]),
        CelValue::Optional(optional) => match optional.held() {
            Some(held) => object([(CEL_TAG, Value::String("optional".into())), ("value", encode_conformance_value(held)?)]),
            None => object([(CEL_TAG, Value::String("optional".into()))]),
        },
        CelValue::List(items) => {
            Value::Array(items.iter().map(encode_conformance_value).collect::<Result<_, _>>()?)
        }
        CelValue::Map(map) => encode_map(map.iter().map(|(key, held)| (key.clone(), held.clone())).collect())?,
        CelValue::Record(record) => {
            encode_map(record.iter().map(|(key, held)| (CelValue::String(key.into()), held.clone())).collect())?
        }
        CelValue::Error(error) => return refuse(format!("an error is not a value: {}", error.message)),
        CelValue::Host(host) => match host.type_name() {
            Some(name) if !CEL_VALUE_KEYS.contains(&name) => object([
                (CEL_TAG, Value::String("host".into())),
                ("type", Value::String(name.into())),
                (
                    "value",
                    encode_map(
                        host.entries().iter().map(|(key, held)| (CelValue::String(key.into()), held.clone())).collect(),
                    )?,
                ),
            ]),
            _ => return refuse("this value is of no CEL type"),
        },
    })
}

fn encode_map(pairs: Vec<(CelValue, CelValue)>) -> Result<Value, ConformanceValueError> {
    let mut written = Vec::with_capacity(pairs.len());
    for (key, held) in &pairs {
        written.push((encode_conformance_value(key)?, encode_conformance_value(held)?));
    }
    let plain = written
        .iter()
        .all(|(key, _)| matches!(key, Value::String(text) if text != FRAME_TAG && text != CEL_TAG));
    if plain {
        let text_of = |key: &Value| key.as_str().expect("a plain key is a string").to_string();
        written.sort_by(|left, right| compare_code_units(&text_of(&left.0), &text_of(&right.0)));
        let mut indices: Vec<(u32, String, Value)> = Vec::new();
        let mut named: Vec<(String, Value)> = Vec::new();
        for (key, held) in written {
            let key = text_of(&key);
            match array_index(&key) {
                Some(index) => indices.push((index, key, held)),
                None => named.push((key, held)),
            }
        }
        indices.sort_by_key(|(index, _, _)| *index);
        let mut out = Map::new();
        for (_, key, held) in indices {
            out.insert(key, held);
        }
        for (key, held) in named {
            out.insert(key, held);
        }
        return Ok(Value::Object(out));
    }
    written.sort_by(|left, right| compare_code_units(&json_text(&left.0), &json_text(&right.0)));
    Ok(object([
        (FRAME_TAG, Value::String("map".into())),
        ("value", Value::Array(written.into_iter().map(|(key, held)| Value::Array(vec![key, held])).collect())),
    ]))
}

/// A key a JavaScript object holds as an array index, before every other key.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_digit()) || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// A recorded node as a value of this engine. Refuses a node the encoding does not define.
fn decode_conformance_value(node: &Value) -> Result<CelValue, ConformanceValueError> {
    match node {
        Value::Null => Ok(CelValue::Null),
        Value::Bool(held) => Ok(CelValue::Bool(*held)),
        Value::String(text) => Ok(CelValue::String(text.as_str().into())),
        Value::Number(number) => Ok(CelValue::Double(number_value(number))),
        Value::Array(items) => Ok(CelValue::List(items.iter().map(decode_conformance_value).collect::<Result<Vec<_>, _>>()?.into())),
        Value::Object(fields) if fields.contains_key(CEL_TAG) => decode_cel(fields),
        Value::Object(fields) if fields.contains_key(FRAME_TAG) => decode_frame(fields),
        Value::Object(fields) => {
            let mut entries = Vec::with_capacity(fields.len());
            for (key, held) in fields {
                entries.push((CelValue::String(key.as_str().into()), decode_conformance_value(held)?));
            }
            built_map(entries)
        }
    }
}

fn built_map(entries: Vec<(CelValue, CelValue)>) -> Result<CelValue, ConformanceValueError> {
    cel_map_from_entries(entries).map(CelValue::Map).map_err(|error| ConformanceValueError(error.message))
}

/// A recorded node as a value of this engine, read only in its canonical writing: it must
/// be exactly what the writer writes for the value it reads, so a file holds one text per
/// value. This is the codec's one reader.
pub fn read_canonical_conformance_value(node: &Value) -> Result<CelValue, ConformanceValueError> {
    let value = decode_conformance_value(node)?;
    let written = json_text(&encode_conformance_value(&value)?);
    if written != json_text(node) {
        return refuse(format!("{} is not the canonical writing of its value, which is {written}", json_text(node)));
    }
    Ok(value)
}

fn decode_cel(fields: &Map<String, Value>) -> Result<CelValue, ConformanceValueError> {
    let form = fields.get(CEL_TAG).and_then(Value::as_str);
    match (form, fields.get("value")) {
        (Some("type"), Some(Value::String(name))) => return Ok(CelValue::Type(cel_type_value(engine_type_name(name)))),
        (Some("optional"), None) => return Ok(CelValue::Optional(cel_none())),
        (Some("optional"), Some(held)) => return Ok(CelValue::Optional(cel_some(decode_conformance_value(held)?))),
        (Some("host"), Some(Value::Object(entries)))
            if !entries.contains_key(CEL_TAG) && !entries.contains_key(FRAME_TAG) =>
        {
            if let Some(Value::String(name)) = fields.get("type") {
                if CEL_VALUE_KEYS.contains(&name.as_str()) {
                    return refuse(format!("{} is a type of the engine's own values, not a host's", json_quote(name)));
                }
                let mut held = PropertyMap::new();
                for (key, entry) in entries {
                    held.insert(key.clone(), decode_conformance_value(entry)?);
                }
                let host = CelHostValue::with_entries(name.clone(), Arc::new(()), held)
                    .map_err(|refusal| ConformanceValueError(refusal.to_string()))?;
                return Ok(CelValue::Host(host));
            }
        }
        _ => {}
    }
    refuse(format!("{} is not a '{CEL_TAG}' form", json_text(&Value::Object(fields.clone()))))
}

fn decode_frame(fields: &Map<String, Value>) -> Result<CelValue, ConformanceValueError> {
    let tag = fields.get(FRAME_TAG).cloned().unwrap_or(Value::Null);
    let payload = fields.get("value");
    if tag == Value::String("map".into()) {
        let Some(Value::Array(pairs)) = payload else { return refuse("a tagged map carries its pairs") };
        let mut entries = Vec::with_capacity(pairs.len());
        for pair in pairs {
            let Some([key, held]) = pair.as_array().map(Vec::as_slice) else {
                return refuse("a tagged map's entry is a [key, value] pair");
            };
            entries.push((decode_conformance_value(key)?, decode_conformance_value(held)?));
        }
        return built_map(entries);
    }
    let Some(Value::String(payload)) = payload else {
        return refuse(format!("the tag {} carries its payload as text", json_text(&tag)));
    };
    let not_read = || ConformanceValueError(format!("{} is not the payload of the tag {}", json_quote(payload), json_text(&tag)));
    match tag.as_str().unwrap_or("") {
        "int" => payload.parse::<i64>().map(CelValue::Int).map_err(|_| not_read()),
        "uint" => payload.parse::<u64>().map(CelValue::Uint).map_err(|_| not_read()),
        "double" => match payload.as_str() {
            "NaN" => Ok(CelValue::Double(f64::NAN)),
            "Infinity" => Ok(CelValue::Double(f64::INFINITY)),
            "-Infinity" => Ok(CelValue::Double(f64::NEG_INFINITY)),
            "-0" => Ok(CelValue::Double(-0.0)),
            _ => refuse(format!("{} is not a tagged double", json_quote(payload))),
        },
        "bytes" => Ok(CelValue::Bytes(unbase64url(payload)?.into())),
        "google.protobuf.Timestamp" => {
            parse_timestamp(payload).map(CelValue::Timestamp).map_err(|error| ConformanceValueError(error.message))
        }
        "google.protobuf.Duration" => {
            parse_duration(payload).map(CelValue::Duration).map_err(|error| ConformanceValueError(error.message))
        }
        _ => refuse(format!("{} is not a tag of the encoding", json_text(&tag))),
    }
}

/// The canonical text of a value: what the conformance handler set hands back for an
/// argument.
pub fn conformance_text(value: &CelValue) -> Result<String, ConformanceValueError> {
    Ok(json_text(&encode_conformance_value(value)?))
}

