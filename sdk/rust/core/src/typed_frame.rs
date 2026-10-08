//! The typed frame — `kernel/specs/durable-execution.md` §6.1–§6.6.
//!
//! The Rust half of `sdk/nodejs/src/typed-frame.ts`, byte-identical to it on the
//! conformance vectors (`kernel/specs/durable-execution-typed-frame-vectors.json`).
//! One schema-independent JSON form over the whole CEL value domain, for a
//! boundary whose reader turns a value back into a live value inside a Telo
//! runtime: a value's CEL type survives the trip, two different values never
//! share a frame, and the text is canonical, so two runtimes writing one value
//! write the same bytes. A tagged payload is the type's plain encoding.
//!
//! It refuses rather than approximates, in both directions — and so it reads JSON
//! with its own reader (`typed_frame/json_reader.rs`) rather than `serde_json`'s:
//! the frame's rules are stated over what `JSON.parse` yields (a negative zero, an
//! unpaired surrogate escape, the order members are visited in), and a
//! general-purpose reader answers each of those differently.
//!
//! The value domain it is defined over is `telorun-cel-value`'s: [`CelValue`] here
//! is that crate's union, re-exported. Four of its variants have no frame — a type
//! value, an optional, an error and a host value are refused on write — and a map
//! has two representations: an untagged object reads as a `CelRecord`, a tagged map
//! as a `CelMap`.
//!
//! [`to_frame`] and [`from_frame`] carry any serde type through the frame
//! (`typed_frame/serde_bridge.rs`).

mod json_reader;
mod serde_bridge;

use std::fmt;

use serde::{de, ser};

use telorun_cel_value::{cel_map_from_entries, json_quote, CelDuration, CelMap, CelRecord, CelTimestamp};

pub use telorun_cel_value::CelValue;

use crate::plain_encoding::{base64url, cel_duration, rfc3339};
use json_reader::{Json, JsonReader, JsonText};

pub use serde_bridge::{from_frame, from_value, to_frame, to_value};

/// The key marking a tagged value. A map holding it as a key is itself tagged.
pub const TYPED_FRAME_TAG: &str = "$telo";

pub const TAG_INT: &str = "int";
pub const TAG_UINT: &str = "uint";
pub const TAG_DOUBLE: &str = "double";
pub const TAG_BYTES: &str = "bytes";
pub const TAG_TIMESTAMP: &str = "google.protobuf.Timestamp";
pub const TAG_DURATION: &str = "google.protobuf.Duration";
pub const TAG_MAP: &str = "map";

/// The closed tag vocabulary. A frame carrying any other tag is refused.
pub const TYPED_FRAME_TAGS: &[&str] =
    &[TAG_INT, TAG_UINT, TAG_DOUBLE, TAG_BYTES, TAG_TIMESTAMP, TAG_DURATION, TAG_MAP];

pub const ERR_TYPED_FRAME_UNENCODABLE: &str = "ERR_TYPED_FRAME_UNENCODABLE";
pub const ERR_TYPED_FRAME_UNDECODABLE: &str = "ERR_TYPED_FRAME_UNDECODABLE";

/// A refusal to write or read a frame, naming the node it is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypedFrameError {
    /// `ERR_TYPED_FRAME_UNENCODABLE` or `ERR_TYPED_FRAME_UNDECODABLE`.
    pub code: &'static str,
    pub message: String,
    /// The JSON Pointer of the offending node — inside the value when writing,
    /// inside the frame when reading.
    pub path: String,
}

impl fmt::Display for TypedFrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} [{}]", self.message, self.code)
    }
}

impl std::error::Error for TypedFrameError {}

impl ser::Error for TypedFrameError {
    fn custom<T: fmt::Display>(message: T) -> Self {
        Self { code: ERR_TYPED_FRAME_UNENCODABLE, message: format!("Cannot write a typed frame: {message}."), path: String::new() }
    }
}

impl de::Error for TypedFrameError {
    fn custom<T: fmt::Display>(message: T) -> Self {
        Self { code: ERR_TYPED_FRAME_UNDECODABLE, message: format!("Cannot read a typed frame: {message}."), path: String::new() }
    }
}

fn pointer(path: &[String]) -> String {
    path.iter().map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1"))).collect()
}

fn unencodable(path: &[String], detail: impl fmt::Display) -> TypedFrameError {
    let at = if path.is_empty() { "the value itself".to_string() } else { format!("the value at '{}'", pointer(path)) };
    TypedFrameError {
        code: ERR_TYPED_FRAME_UNENCODABLE,
        message: format!("Cannot write a typed frame: {at} {detail}."),
        path: pointer(path),
    }
}

fn undecodable(path: &[String], detail: impl fmt::Display) -> TypedFrameError {
    let at = if path.is_empty() { "the frame".to_string() } else { format!("'{}'", pointer(path)) };
    TypedFrameError {
        code: ERR_TYPED_FRAME_UNDECODABLE,
        message: format!("Cannot read a typed frame: {at} {detail}."),
        path: pointer(path),
    }
}

// ---------------------------------------------------------------------------
// Writing

/// The canonical frame text of a CEL value.
pub fn encode_typed_frame(value: &CelValue) -> Result<String, TypedFrameError> {
    write_value(value, &mut Vec::new())
}

fn tagged(tag: &str, payload: &str) -> String {
    format!("{{\"{TYPED_FRAME_TAG}\":\"{tag}\",\"value\":{payload}}}")
}

fn write_value(value: &CelValue, path: &mut Vec<String>) -> Result<String, TypedFrameError> {
    Ok(match value {
        CelValue::Null => "null".into(),
        CelValue::Bool(b) => b.to_string(),
        CelValue::String(s) => json_quote(s),
        CelValue::Double(d) => {
            if d.is_finite() && !(*d == 0.0 && d.is_sign_negative()) {
                es_number(*d)
            } else {
                tagged(TAG_DOUBLE, &json_quote(tagged_double_text(*d)))
            }
        }
        CelValue::Int(i) => tagged(TAG_INT, &format!("\"{i}\"")),
        CelValue::Uint(u) => tagged(TAG_UINT, &format!("\"{u}\"")),
        CelValue::Bytes(bytes) => tagged(TAG_BYTES, &format!("\"{}\"", base64url::encode(bytes))),
        CelValue::Timestamp(t) => tagged(TAG_TIMESTAMP, &format!("\"{}\"", rfc3339::encode(&(*t).into()))),
        CelValue::Duration(d) => {
            if d.seconds().unsigned_abs() > cel_duration::MAX_SECONDS {
                return Err(unencodable(
                    path,
                    format!("is a duration outside protobuf's range of ±{}s", cel_duration::MAX_SECONDS),
                ));
            }
            tagged(TAG_DURATION, &format!("\"{}\"", cel_duration::encode(&(*d).into())))
        }
        CelValue::List(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                parts.push(write_value(item, path)?);
                path.pop();
            }
            format!("[{}]", parts.join(","))
        }
        CelValue::Map(map) => write_map(map, path)?,
        CelValue::Record(record) => write_record(record, path)?,
        // No frame carries these: each is refused, never approximated.
        CelValue::Type(_) => return Err(unencodable(path, "is a type value")),
        CelValue::Optional(_) => return Err(unencodable(path, "is an optional")),
        CelValue::Error(_) => return Err(unencodable(path, "is an error value")),
        CelValue::Host(_) => return Err(unencodable(path, "is a host value")),
    })
}

fn tagged_double_text(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value == f64::INFINITY {
        "Infinity"
    } else if value == f64::NEG_INFINITY {
        "-Infinity"
    } else {
        "-0"
    }
}

struct Pair {
    /// What the pair is ordered by: a string key's own text, else the key as written.
    order: String,
    key: String,
    value: String,
}

/// A map with only string keys, none of them the tag key, is a plain object; any
/// other map is a tagged list of pairs ordered by key text. The order is the
/// writer's own, so neither representation's iteration order reaches the text.
fn write_pairs(mut pairs: Vec<Pair>, plain: bool) -> String {
    if plain {
        pairs.sort_by(|a, b| compare_code_units(&a.order, &b.order));
        let members: Vec<String> = pairs.iter().map(|p| format!("{}:{}", p.key, p.value)).collect();
        return format!("{{{}}}", members.join(","));
    }
    pairs.sort_by(|a, b| compare_code_units(&a.key, &b.key));
    let members: Vec<String> = pairs.iter().map(|p| format!("[{},{}]", p.key, p.value)).collect();
    tagged(TAG_MAP, &format!("[{}]", members.join(",")))
}

/// A `CelMap` holds no two keys that are one key, by construction, so the writer
/// compares none.
fn write_map(map: &CelMap, path: &mut Vec<String>) -> Result<String, TypedFrameError> {
    let mut pairs = Vec::with_capacity(map.len());
    let mut plain = true;
    for (key, value) in map.iter() {
        let key_text = write_map_key(key, path)?;
        if !matches!(key, CelValue::String(s) if s != TYPED_FRAME_TAG) {
            plain = false;
        }
        path.push(key_segment(key));
        let written = write_value(value, path)?;
        path.pop();
        let order = match key {
            CelValue::String(s) => s.clone(),
            _ => key_text.clone(),
        };
        pairs.push(Pair { order, key: key_text, value: written });
    }
    Ok(write_pairs(pairs, plain))
}

fn write_record(record: &CelRecord, path: &mut Vec<String>) -> Result<String, TypedFrameError> {
    let mut pairs = Vec::with_capacity(record.len());
    let mut plain = true;
    for (key, value) in record.iter() {
        if key == TYPED_FRAME_TAG {
            plain = false;
        }
        path.push(key.to_string());
        let written = write_value(value, path)?;
        path.pop();
        pairs.push(Pair { order: key.to_string(), key: json_quote(key), value: written });
    }
    Ok(write_pairs(pairs, plain))
}

fn key_segment(key: &CelValue) -> String {
    match key {
        CelValue::String(s) => s.clone(),
        CelValue::Bool(b) => b.to_string(),
        CelValue::Int(i) => i.to_string(),
        CelValue::Uint(u) => u.to_string(),
        _ => String::new(),
    }
}

fn write_map_key(key: &CelValue, path: &[String]) -> Result<String, TypedFrameError> {
    match key {
        CelValue::String(s) => Ok(json_quote(s)),
        CelValue::Bool(b) => Ok(b.to_string()),
        CelValue::Int(i) => Ok(tagged(TAG_INT, &format!("\"{i}\""))),
        CelValue::Uint(u) => Ok(tagged(TAG_UINT, &format!("\"{u}\""))),
        other => Err(unencodable(
            path,
            format!("is a map with a key that is {}; a CEL map key is an int, uint, bool or string", describe(other)),
        )),
    }
}

fn describe(value: &CelValue) -> String {
    match value {
        CelValue::Null => "null".into(),
        CelValue::Double(d) => format!("the number {}", es_number(*d)),
        CelValue::Bytes(_) => "bytes".into(),
        CelValue::Timestamp(_) => "a timestamp".into(),
        CelValue::Duration(_) => "a duration".into(),
        CelValue::List(_) => "a list".into(),
        CelValue::Map(_) | CelValue::Record(_) => "a map".into(),
        CelValue::Type(_) => "a type value".into(),
        CelValue::Optional(_) => "an optional".into(),
        CelValue::Error(_) => "an error value".into(),
        CelValue::Host(_) => "a host value".into(),
        CelValue::Bool(_) | CelValue::String(_) | CelValue::Int(_) | CelValue::Uint(_) => "a key".into(),
    }
}

/// What makes two keys ONE key in a payload being READ. An `int` and a `uint` of the
/// same number compare equal in CEL, so a payload carrying both is refused. It is the
/// frame's own rule on purpose, as in the Node half: the refusal names the path it
/// was found at, which is the frame's wire contract, and a payload from another
/// writer can carry anything.
fn map_key_identity(key: &CelValue) -> Option<String> {
    match key {
        CelValue::String(s) => Some(format!("s{s}")),
        CelValue::Bool(b) => Some(format!("b{b}")),
        CelValue::Int(i) => Some(format!("n{i}")),
        CelValue::Uint(u) => Some(format!("n{u}")),
        _ => None,
    }
}

/// UTF-16 code unit order, RFC 8785's property order.
fn compare_code_units(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A finite double as ECMAScript's `Number.prototype.toString` writes it — the
/// number form RFC 8785 adopts. The digits are the value domain's, written once.
pub fn es_number(value: f64) -> String {
    telorun_cel_value::es_number(value)
}

// ---------------------------------------------------------------------------
// Reading

/// The value a frame encodes. Accepts any JSON syntax for the frame's structure
/// (whitespace, member order); a tagged payload must be in its canonical form.
pub fn decode_typed_frame(text: &str) -> Result<CelValue, TypedFrameError> {
    let mut reader = JsonReader::new(text);
    let parsed = reader.document().map_err(|detail| TypedFrameError {
        code: ERR_TYPED_FRAME_UNDECODABLE,
        message: format!("A typed frame is not valid JSON: {detail}"),
        path: String::new(),
    })?;
    if let Some(path) = reader.repeated() {
        return Err(undecodable(&path, "repeats a member name of its object, which no writer produces"));
    }
    read_value(&parsed, &mut Vec::new())
}

/// Checks a tagged scalar payload is in its canonical form, and reads it.
pub(crate) fn read_canonical_payload(tag: &str, text: &str) -> Result<CelValue, TypedFrameError> {
    read_scalar(tag, text, &[])
}

fn read_value(node: &Json, path: &mut Vec<String>) -> Result<CelValue, TypedFrameError> {
    match node {
        Json::Null => Ok(CelValue::Null),
        Json::Bool(b) => Ok(CelValue::Bool(*b)),
        Json::Number(n) if !n.is_finite() => Err(undecodable(
            path,
            "is a number beyond the range of a double; a non-finite double is tagged 'double'",
        )),
        Json::Number(n) => Ok(CelValue::Double(*n)),
        Json::Text(text) => read_string(text, path).map(CelValue::String),
        Json::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                out.push(read_value(item, path)?);
                path.pop();
            }
            Ok(CelValue::List(out))
        }
        Json::Object(members) => {
            if members.iter().any(|(k, _)| k.is(TYPED_FRAME_TAG)) {
                return read_tagged(members, path);
            }
            // The reader has already refused a repeated member name.
            let mut out = CelRecord::new();
            for (key, value) in members {
                path.push(key.lossy());
                let key = read_string(key, path)?;
                out.insert(key, read_value(value, path)?);
                path.pop();
            }
            Ok(CelValue::Record(out))
        }
    }
}

fn read_string(text: &JsonText, path: &[String]) -> Result<String, TypedFrameError> {
    if text.unpaired() {
        return Err(undecodable(path, "holds an unpaired UTF-16 surrogate"));
    }
    Ok(text.lossy())
}

fn read_tagged(members: &[(JsonText, Json)], path: &mut Vec<String>) -> Result<CelValue, TypedFrameError> {
    let tag = members.iter().find(|(k, _)| k.is(TYPED_FRAME_TAG)).map(|(_, v)| v);
    let payload = members.iter().find(|(k, _)| k.is("value")).map(|(_, v)| v);
    let (Some(Json::Text(tag)), Some(payload), 2) = (tag, payload, members.len()) else {
        return Err(undecodable(
            path,
            format!("is a tagged value, which carries exactly a string '{TYPED_FRAME_TAG}' and a 'value'"),
        ));
    };
    let tag = tag.lossy();
    if !TYPED_FRAME_TAGS.contains(&tag.as_str()) {
        path.push(TYPED_FRAME_TAG.into());
        return Err(undecodable(
            path,
            format!("names the tag '{tag}', which is not one of {}", TYPED_FRAME_TAGS.join(", ")),
        ));
    }
    path.push("value".into());
    let value = if tag == TAG_MAP {
        read_map(payload, path)?
    } else {
        let Json::Text(text) = payload else {
            return Err(undecodable(path, format!("is not a string, and a '{tag}' payload is text")));
        };
        read_scalar(&tag, &text.lossy(), path)?
    };
    path.pop();
    Ok(value)
}

fn is_int_text(text: &str, signed: bool) -> bool {
    let digits = if signed { text.strip_prefix('-').unwrap_or(text) } else { text };
    if text == "0" {
        return true;
    }
    !digits.is_empty()
        && digits.bytes().all(|c| c.is_ascii_digit())
        && !digits.starts_with('0')
}

fn read_scalar(tag: &str, text: &str, path: &[String]) -> Result<CelValue, TypedFrameError> {
    match tag {
        TAG_INT => is_int_text(text, true)
            .then(|| text.parse::<i64>().ok())
            .flatten()
            .map(CelValue::Int)
            .ok_or_else(|| undecodable(path, format!("is '{text}', not a canonical int64 decimal"))),
        TAG_UINT => is_int_text(text, false)
            .then(|| text.parse::<u64>().ok())
            .flatten()
            .map(CelValue::Uint)
            .ok_or_else(|| undecodable(path, format!("is '{text}', not a canonical uint64 decimal"))),
        TAG_DOUBLE => match text {
            "NaN" => Ok(CelValue::Double(f64::NAN)),
            "Infinity" => Ok(CelValue::Double(f64::INFINITY)),
            "-Infinity" => Ok(CelValue::Double(f64::NEG_INFINITY)),
            "-0" => Ok(CelValue::Double(-0.0)),
            _ => Err(undecodable(path, format!("is '{text}'; a tagged double is one of NaN, Infinity, -Infinity, -0"))),
        },
        TAG_BYTES => base64url::decode(text)
            .filter(|bytes| base64url::encode(bytes) == text)
            .map(CelValue::Bytes)
            .ok_or_else(|| undecodable(path, format!("is '{text}', not base64url text without padding in its canonical written form"))),
        TAG_TIMESTAMP => rfc3339::decode(text)
            .filter(|t| rfc3339::encode(t) == text)
            .map(|t| CelValue::Timestamp(CelTimestamp::from(t)))
            .ok_or_else(|| undecodable(path, format!("is '{text}', not RFC 3339 text (2026-01-15T09:30:00Z) in its canonical written form"))),
        TAG_DURATION => cel_duration::decode(text)
            .filter(|d| cel_duration::encode(d) == text)
            .map(|d| CelValue::Duration(CelDuration::from(d)))
            .ok_or_else(|| {
                undecodable(
                    path,
                    format!("is '{text}', not a CEL duration string within ±{}s (1h30m, 250ms, 5400s) in its canonical written form", cel_duration::MAX_SECONDS),
                )
            }),
        _ => Err(undecodable(path, format!("names the tag '{tag}', which has no scalar payload"))),
    }
}

fn read_map(payload: &Json, path: &mut Vec<String>) -> Result<CelValue, TypedFrameError> {
    let Json::Array(pairs) = payload else {
        return Err(undecodable(path, "is not a list of key/value pairs"));
    };
    let mut out = Vec::with_capacity(pairs.len());
    let mut seen = std::collections::HashSet::new();
    let mut plain = true;
    for (index, pair) in pairs.iter().enumerate() {
        path.push(index.to_string());
        let Json::Array(pair) = pair else {
            return Err(undecodable(path, "is not a [key, value] pair"));
        };
        if pair.len() != 2 {
            return Err(undecodable(path, "is not a [key, value] pair"));
        }
        path.push("0".into());
        let key = read_value(&pair[0], path)?;
        let Some(identity) = map_key_identity(&key) else {
            return Err(undecodable(path, "is not an int, uint, bool or string map key"));
        };
        if !seen.insert(identity) {
            return Err(undecodable(path, "repeats a key already in the map"));
        }
        if !matches!(&key, CelValue::String(s) if s != TYPED_FRAME_TAG) {
            plain = false;
        }
        *path.last_mut().expect("the key segment") = "1".into();
        let value = read_value(&pair[1], path)?;
        path.pop();
        path.pop();
        out.push((key, value));
    }
    if plain {
        return Err(undecodable(
            path,
            format!("is a map whose keys are all strings other than '{TYPED_FRAME_TAG}', which is written untagged"),
        ));
    }
    // The frame's own refusals above leave nothing for the builder to refuse.
    cel_map_from_entries(out).map(CelValue::Map).map_err(|error| undecodable(path, format!("is not a map: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as Json;

    const VECTORS: &str = include_str!("../../../../kernel/specs/durable-execution-typed-frame-vectors.json");

    /// A value in the notation §6.6 defines.
    fn notation(node: &Json) -> CelValue {
        let (kind, body) = node.as_object().unwrap().iter().next().unwrap();
        let decimal = |v: &Json| v.as_str().unwrap().to_string();
        match kind.as_str() {
            "null" => CelValue::Null,
            "bool" => CelValue::Bool(body.as_bool().unwrap()),
            "string" => CelValue::String(body.as_str().unwrap().into()),
            "double" => CelValue::Double(match body {
                Json::String(s) if s == "NaN" => f64::NAN,
                Json::String(s) if s == "Infinity" => f64::INFINITY,
                Json::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
                Json::String(s) if s == "-0" => -0.0,
                n => n.as_f64().unwrap(),
            }),
            "int" => CelValue::Int(decimal(body).parse().unwrap()),
            "uint" => CelValue::Uint(decimal(body).parse().unwrap()),
            "bytes" => CelValue::Bytes(body.as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect()),
            "timestamp" => {
                let seconds: i64 = decimal(&body["seconds"]).parse().unwrap();
                CelValue::Timestamp(CelTimestamp::new(seconds, body["nanos"].as_u64().unwrap() as u32).unwrap())
            }
            "duration" => {
                let seconds: i64 = decimal(&body["seconds"]).parse().unwrap();
                CelValue::Duration(CelDuration::new(seconds, body["nanos"].as_i64().unwrap() as i32).unwrap())
            }
            "list" => CelValue::List(body.as_array().unwrap().iter().map(notation).collect()),
            "map" => CelValue::Map(
                cel_map_from_entries(body.as_array().unwrap().iter().map(|pair| (notation(&pair[0]), notation(&pair[1]))))
                    .unwrap(),
            ),
            other => panic!("unknown notation '{other}'"),
        }
    }

    fn vectors(table: &str) -> Vec<Json> {
        let all: Json = serde_json::from_str(VECTORS).unwrap();
        all[table].as_array().unwrap().clone()
    }

    #[test]
    fn writes_and_reads_every_encodable_vector_byte_identically() {
        for vector in vectors("encodable") {
            let value = notation(&vector["value"]);
            let frame = vector["frame"].as_str().unwrap();
            assert_eq!(encode_typed_frame(&value).unwrap(), frame, "{}", vector["name"]);
            assert_eq!(decode_typed_frame(frame).unwrap(), value, "{}", vector["name"]);
        }
    }

    #[test]
    fn writes_every_double_of_the_shared_corpus() {
        let mismatches: Vec<(String, String, String)> = vectors("doubles")
            .iter()
            .filter_map(|row| {
                let bits = u64::from_str_radix(row[0].as_str().unwrap(), 16).unwrap();
                let expected = row[1].as_str().unwrap();
                let written = encode_typed_frame(&CelValue::Double(f64::from_bits(bits))).unwrap();
                (written != expected).then(|| (row[0].as_str().unwrap().to_string(), expected.to_string(), written))
            })
            .collect();
        assert_eq!(mismatches, Vec::new());
    }

    #[test]
    fn refuses_every_undecodable_vector_at_its_path() {
        for vector in vectors("undecodable") {
            let error = decode_typed_frame(vector["frame"].as_str().unwrap()).unwrap_err();
            assert_eq!(error.code, ERR_TYPED_FRAME_UNDECODABLE, "{}", vector["name"]);
            assert_eq!(error.path, vector["path"].as_str().unwrap(), "{}", vector["name"]);
        }
    }

    #[test]
    fn reads_every_readable_vector_and_writes_its_canonical_frame() {
        for vector in vectors("readable") {
            let value = decode_typed_frame(vector["frame"].as_str().unwrap()).unwrap();
            assert_eq!(value, notation(&vector["value"]), "{}", vector["name"]);
            assert_eq!(encode_typed_frame(&value).unwrap(), vector["canonical"].as_str().unwrap(), "{}", vector["name"]);
        }
    }

    /// The twin of `sdk/nodejs/tests/typed-frame-map-key.test.ts`: the frame and the
    /// value domain answer "are these two keys ONE key" the same way, for every pair
    /// of its fifteen keys. The frame keeps its own rule on its read path, so either
    /// side moving alone fails here. The key frames, the merged pairs and the counts
    /// are what the Node SDK answers, executed; its second case is rows of this matrix.
    #[test]
    fn the_frame_and_the_domain_agree_on_which_two_keys_are_one_key() {
        let text = |value: &str| CelValue::String(value.into());
        let keys: [(&str, CelValue, &str); 15] = [
            ("\"1\"", text("1"), r#""1""#),
            ("\"2\"", text("2"), r#""2""#),
            ("\"true\"", text("true"), r#""true""#),
            ("\"n1\"", text("n1"), r#""n1""#),
            ("\"s1\"", text("s1"), r#""s1""#),
            ("\"b1\"", text("b1"), r#""b1""#),
            ("\"__proto__\"", text("__proto__"), r#""__proto__""#),
            ("\"\"", text(""), r#""""#),
            ("1 (int)", CelValue::Int(1), r#"{"$telo":"int","value":"1"}"#),
            ("2 (int)", CelValue::Int(2), r#"{"$telo":"int","value":"2"}"#),
            ("0 (int)", CelValue::Int(0), r#"{"$telo":"int","value":"0"}"#),
            ("1u (uint)", CelValue::Uint(1), r#"{"$telo":"uint","value":"1"}"#),
            ("2u (uint)", CelValue::Uint(2), r#"{"$telo":"uint","value":"2"}"#),
            ("true", CelValue::Bool(true), "true"),
            ("false", CelValue::Bool(false), "false"),
        ];
        let (mut pairs, mut merged, mut untagged, mut read) = (0, Vec::new(), 0, 0);
        for (i, (left_name, left, left_frame)) in keys.iter().enumerate() {
            assert_eq!(encode_typed_frame(left).unwrap(), *left_frame, "{left_name}");
            for (right_name, right, right_frame) in &keys[i + 1..] {
                pairs += 1;
                let domain = cel_map_from_entries([(left.clone(), text("a")), (right.clone(), text("b"))])
                    .is_err_and(|error| error.code == telorun_cel_value::CelEvaluationCode::DuplicateMapKey);
                let payload = format!(r#"{{"$telo":"map","value":[[{left_frame},"a"],[{right_frame},"b"]]}}"#);
                let frame = match decode_typed_frame(&payload) {
                    Ok(_) => {
                        read += 1;
                        false
                    }
                    Err(error) if error.message.contains("repeats a key already in the map") => true,
                    // Refused for its SHAPE before any key is compared: two strings.
                    Err(error) if error.message.contains("which is written untagged") => {
                        untagged += 1;
                        false
                    }
                    Err(error) => panic!("{left_name} vs {right_name}: {error}"),
                };
                assert_eq!(domain, frame, "{left_name} vs {right_name}");
                if domain {
                    merged.push((*left_name, *right_name));
                }
            }
        }
        assert_eq!(merged, [("1 (int)", "1u (uint)"), ("2 (int)", "2u (uint)")]);
        assert_eq!((pairs, untagged, read), (105, 28, 75));
    }

    #[test]
    fn refuses_to_write_a_value_no_frame_carries_at_its_path() {
        let host = telorun_cel_value::CelHostValue::unnamed(std::sync::Arc::new(()));
        let error = telorun_cel_value::cel_error(telorun_cel_value::CelEvaluationCode::NoSuchKey, "missing", None);
        for (value, what) in [
            (CelValue::Type(telorun_cel_value::cel_type_value("int")), "is a type value"),
            (CelValue::Optional(telorun_cel_value::cel_none()), "is an optional"),
            (CelValue::Error(error), "is an error value"),
            (CelValue::Host(host), "is a host value"),
        ] {
            let alone = encode_typed_frame(&value).unwrap_err();
            assert_eq!((alone.code, alone.path.as_str()), (ERR_TYPED_FRAME_UNENCODABLE, ""), "{what}");
            assert_eq!(alone.message, format!("Cannot write a typed frame: the value itself {what}."));

            let record = CelRecord::from_iter([("held", CelValue::List(vec![CelValue::Null, value.clone()]))]);
            let nested = encode_typed_frame(&CelValue::Record(record)).unwrap_err();
            assert_eq!((nested.code, nested.path.as_str()), (ERR_TYPED_FRAME_UNENCODABLE, "/held/1"), "{what}");
            assert_eq!(nested.message, format!("Cannot write a typed frame: the value at '/held/1' {what}."));

            let keyed = cel_map_from_entries([(CelValue::Int(7), CelValue::List(vec![value]))]).unwrap();
            assert_eq!(encode_typed_frame(&CelValue::Map(keyed)).unwrap_err().path, "/7/0", "{what}");
        }
    }

    #[test]
    fn reads_an_untagged_object_as_a_record_and_a_tagged_map_as_a_typed_key_map() {
        let CelValue::Record(record) = decode_typed_frame(r#"{"b":1,"10":2,"9":3}"#).unwrap() else {
            panic!("an untagged object is a record");
        };
        assert_eq!(record.get("10"), Some(&CelValue::Double(2.0)));
        // The writer orders the members itself, whatever order the record ranges in.
        assert_eq!(record.keys().collect::<Vec<_>>(), ["9", "10", "b"]);
        assert_eq!(encode_typed_frame(&CelValue::Record(record)).unwrap(), r#"{"10":2,"9":3,"b":1}"#);

        let tagged = r#"{"$telo":"map","value":[["k",1],[true,2],[{"$telo":"int","value":"1"},3]]}"#;
        let CelValue::Map(map) = decode_typed_frame(tagged).unwrap() else {
            panic!("a tagged map is a typed-key map");
        };
        assert_eq!(map.len(), 3);
        assert_eq!(map.get(&telorun_cel_value::CelMapKey::Integer(1)), Some(&CelValue::Double(3.0)));
        assert_eq!(encode_typed_frame(&CelValue::Map(map)).unwrap(), tagged);

        // A record holding the tag key cannot be written untagged, and reads back a map
        // that is the same value.
        let holding = CelValue::Record(CelRecord::from_iter([("$telo", CelValue::Null)]));
        let frame = encode_typed_frame(&holding).unwrap();
        assert_eq!(frame, r#"{"$telo":"map","value":[["$telo",null]]}"#);
        assert!(matches!(decode_typed_frame(&frame).unwrap(), CelValue::Map(_)));
        assert_eq!(decode_typed_frame(&frame).unwrap(), holding);
    }

    #[test]
    fn carries_a_serde_struct_as_a_record_and_a_typed_key_map_as_a_map() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Row {
            name: String,
            tags: std::collections::BTreeMap<String, i64>,
            by_id: std::collections::BTreeMap<i64, bool>,
        }
        let row = Row { name: "a".into(), tags: [("x".to_string(), 1)].into(), by_id: [(7, true)].into() };
        let CelValue::Record(record) = to_value(&row).unwrap() else {
            panic!("a struct is a record");
        };
        assert!(matches!(record.get("tags"), Some(CelValue::Record(_))));
        assert!(matches!(record.get("by_id"), Some(CelValue::Map(_))));
        assert_eq!(from_value::<Row>(CelValue::Record(record)).unwrap(), row);
        assert_eq!(from_frame::<Row>(&to_frame(&row).unwrap()).unwrap(), row);

        for (value, what) in [
            (CelValue::Type(telorun_cel_value::cel_type_value("int")), "a type value"),
            (CelValue::Optional(telorun_cel_value::cel_some(CelValue::Int(1))), "an optional"),
            (telorun_cel_value::cel_error(telorun_cel_value::CelEvaluationCode::NoSuchKey, "missing", None).into(), "an error value"),
            (CelValue::Host(telorun_cel_value::CelHostValue::unnamed(std::sync::Arc::new(()))), "a host value"),
        ] {
            let refused = from_value::<serde_json::Value>(CelValue::List(vec![value])).unwrap_err();
            assert_eq!(refused.code, ERR_TYPED_FRAME_UNDECODABLE, "{what}");
            assert_eq!(refused.message, format!("Cannot read a typed frame: the value is {what}, which has no serde form."));
        }
    }

    #[derive(serde::Serialize)]
    struct Holder<T> {
        rows: Vec<T>,
    }

    fn bridge_refusal<T: serde::Serialize>(value: &T) -> (&'static str, String, String) {
        let refused = to_value(value).unwrap_err();
        assert_eq!(to_frame(value).unwrap_err(), refused);
        (refused.code, refused.path, refused.message)
    }

    #[test]
    fn refuses_a_serde_map_with_a_key_no_map_is_keyed_by_at_the_maps_pointer() {
        let keyed_by_a_list: std::collections::BTreeMap<Vec<i64>, bool> = [(vec![1], true)].into();
        assert_eq!(
            bridge_refusal(&Holder { rows: vec![std::collections::BTreeMap::new(), keyed_by_a_list.clone()] }),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                "/rows/1".into(),
                "Cannot write a typed frame: the value at '/rows/1' is a map with a key that is a list; a CEL map key is an int, uint, bool or string.".into()
            )
        );
        assert_eq!(
            bridge_refusal(&keyed_by_a_list),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                String::new(),
                "Cannot write a typed frame: the value itself is a map with a key that is a list; a CEL map key is an int, uint, bool or string.".into()
            )
        );
    }

    #[test]
    fn refuses_a_key_where_it_arrives_as_a_key_of_the_map_at_its_pointer() {
        // A refusal raised while the key is written is about a key of the map.
        let beyond_int64: std::collections::BTreeMap<u64, bool> = [(u64::MAX, true)].into();
        assert_eq!(
            bridge_refusal(&Holder { rows: vec![beyond_int64] }),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                "/rows/0".into(),
                "Cannot write a typed frame: the value at '/rows/0' is a map with a key that is the integer 18446744073709551615, outside CEL's int64 range; a CEL uint is Uint64.".into()
            )
        );
        // The key is refused before its value is written: no pointer is derived from
        // it, and what is wrong beneath it does not hide it.
        let list_key_over_a_bad_value: std::collections::BTreeMap<Vec<i64>, u64> = [(vec![1], u64::MAX)].into();
        assert_eq!(
            bridge_refusal(&list_key_over_a_bad_value),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                String::new(),
                "Cannot write a typed frame: the value itself is a map with a key that is a list; a CEL map key is an int, uint, bool or string.".into()
            )
        );
        // A scalar no map is keyed by is judged the moment it has been written.
        let null_key: std::collections::BTreeMap<Option<i64>, u64> = [(None, u64::MAX)].into();
        assert_eq!(
            bridge_refusal(&Holder { rows: vec![null_key] }),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                "/rows/0".into(),
                "Cannot write a typed frame: the value at '/rows/0' is a map with a key that is null; a CEL map key is an int, uint, bool or string.".into()
            )
        );
    }

    #[test]
    fn refuses_a_serde_map_whose_keys_collapse_into_one_at_the_maps_pointer() {
        /// A map writing the int `1` and the uint `1`, which CEL equality makes one key.
        struct Collapsing;
        impl serde::Serialize for Collapsing {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry(&1i64, "a")?;
                map.serialize_entry(&crate::Uint64(1), "b")?;
                map.end()
            }
        }
        /// A map writing one string key twice, which a record cannot hold.
        struct Repeating;
        impl serde::Serialize for Repeating {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("k", &1i64)?;
                map.serialize_entry("k", &2i64)?;
                map.end()
            }
        }
        assert_eq!(
            bridge_refusal(&Holder { rows: vec![Collapsing] }),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                "/rows/0".into(),
                r#"Cannot write a typed frame: the value at '/rows/0' is a map with two keys equal to {"$telo":"uint","value":"1"}."#.into()
            )
        );
        assert_eq!(
            bridge_refusal(&Holder { rows: vec![Repeating] }),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                "/rows/0".into(),
                r#"Cannot write a typed frame: the value at '/rows/0' is a map with two keys equal to "k"."#.into()
            )
        );
    }

    #[test]
    fn refuses_what_the_bridge_cannot_carry_at_the_nodes_pointer() {
        #[derive(serde::Serialize)]
        enum Shape {
            Sized { count: u64 },
            Pair(i64, u64),
        }
        #[derive(serde::Serialize)]
        struct Count {
            count: u64,
        }
        let integer = |pointer: &str| {
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                pointer.to_string(),
                format!("Cannot write a typed frame: the value at '{pointer}' is the integer 18446744073709551615, outside CEL's int64 range; a CEL uint is Uint64."),
            )
        };
        assert_eq!(bridge_refusal(&Holder { rows: vec![Count { count: 1 }, Count { count: u64::MAX }] }), integer("/rows/1/count"));
        assert_eq!(bridge_refusal(&Holder { rows: vec![Shape::Sized { count: u64::MAX }] }), integer("/rows/0/Sized/count"));
        assert_eq!(bridge_refusal(&Holder { rows: vec![Shape::Pair(1, u64::MAX)] }), integer("/rows/0/Pair/1"));
        let by_key: std::collections::BTreeMap<i64, u64> = [(7, u64::MAX)].into();
        assert_eq!(bridge_refusal(&Holder { rows: vec![by_key] }), integer("/rows/0/7"));
        assert_eq!(
            bridge_refusal(&u64::MAX),
            (
                ERR_TYPED_FRAME_UNENCODABLE,
                String::new(),
                "Cannot write a typed frame: the value itself is the integer 18446744073709551615, outside CEL's int64 range; a CEL uint is Uint64.".into()
            )
        );
        // A sibling written after a refused-free variant is still located correctly.
        assert_eq!(
            bridge_refusal(&Holder { rows: vec![Shape::Pair(1, 2), Shape::Sized { count: u64::MAX }] }),
            integer("/rows/1/Sized/count")
        );
    }

    /// xorshift64*, so the property test needs no dependency and replays exactly.
    struct Random(u64);

    impl Random {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn random_string(random: &mut Random) -> String {
        const POOL: &[&str] = &["", "a", "$telo", "value", "é", "😀", "ｚ", "\"\\\n\u{1}", "__proto__", "0", "12"];
        (0..random.below(3)).map(|_| POOL[random.below(POOL.len() as u64) as usize]).collect()
    }

    fn random_value(random: &mut Random, depth: u32) -> CelValue {
        let kinds = if depth == 0 { 9 } else { 11 };
        match random.below(kinds) {
            0 => CelValue::Null,
            1 => CelValue::Bool(random.below(2) == 1),
            2 => CelValue::String(random_string(random)),
            3 => CelValue::Double(match random.below(6) {
                0 => f64::NAN,
                1 => f64::INFINITY,
                2 => -0.0,
                3 => random.next() as f64 / 7.0,
                4 => f64::from_bits(random.next()),
                _ => (random.below(2000) as f64 - 1000.0) / 8.0,
            }),
            4 => CelValue::Int(random.next() as i64),
            5 => CelValue::Uint(random.next()),
            6 => CelValue::Bytes((0..random.below(5)).map(|_| random.next() as u8).collect()),
            7 => CelValue::Timestamp(
                CelTimestamp::from_unix_nanos(
                    // Two draws, because the nanosecond range is wider than a u64.
                    CelTimestamp::MIN_UNIX_NANOS
                        + (((random.next() as u128) << 64 | random.next() as u128)
                            % (CelTimestamp::MAX_UNIX_NANOS - CelTimestamp::MIN_UNIX_NANOS) as u128)
                            as i128,
                )
                .unwrap(),
            ),
            8 => CelValue::Duration(
                CelDuration::from_total_nanos(
                    (random.next() as i128 % (cel_duration::MAX_SECONDS as i128 * 1_000_000_000))
                        * if random.below(2) == 0 { 1 } else { -1 },
                )
                .unwrap(),
            ),
            9 => CelValue::List((0..random.below(4)).map(|_| random_value(random, depth - 1)).collect()),
            _ => {
                let mut entries: Vec<(CelValue, CelValue)> = Vec::new();
                for _ in 0..random.below(4) {
                    let key = match random.below(4) {
                        0 => CelValue::String(random_string(random)),
                        1 => CelValue::Bool(random.below(2) == 1),
                        2 => CelValue::Int(random.below(5) as i64 - 2),
                        _ => CelValue::Uint(random.below(3)),
                    };
                    if entries.iter().any(|(k, _)| map_key_identity(k) == map_key_identity(&key)) {
                        continue;
                    }
                    entries.push((key, random_value(random, depth - 1)));
                }
                CelValue::Map(cel_map_from_entries(entries).unwrap())
            }
        }
    }

    #[test]
    fn every_value_reads_back_as_itself_and_writes_one_frame() {
        let mut random = Random(0x9E37_79B9_7F4A_7C15);
        for _ in 0..5000 {
            let value = random_value(&mut random, 3);
            let frame = encode_typed_frame(&value).unwrap();
            let read = decode_typed_frame(&frame).unwrap_or_else(|e| panic!("{frame}: {e}"));
            assert_eq!(read, value, "{frame}");
            assert_eq!(encode_typed_frame(&read).unwrap(), frame);
        }
    }
}
