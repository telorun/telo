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
//! [`to_frame`] and [`from_frame`] carry any serde type through the frame
//! (`typed_frame/serde_bridge.rs`).

mod json_reader;
mod serde_bridge;

use std::fmt;

use serde::{de, ser};

use crate::cel_value_identity::{Duration, Timestamp};
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

/// A value in the CEL value domain.
#[derive(Clone, Debug)]
pub enum CelValue {
    Null,
    Bool(bool),
    String(String),
    Double(f64),
    Int(i64),
    Uint(u64),
    Bytes(Vec<u8>),
    Timestamp(Timestamp),
    Duration(Duration),
    List(Vec<CelValue>),
    /// Entries in the order given. A key is an int, uint, bool or string.
    Map(Vec<(CelValue, CelValue)>),
}

impl PartialEq for CelValue {
    /// Equal when a frame reads back as the other: a double compares by its bits,
    /// so a negative zero is not a zero and NaN is itself.
    fn eq(&self, other: &Self) -> bool {
        use CelValue::*;
        match (self, other) {
            (Null, Null) => true,
            (Bool(a), Bool(b)) => a == b,
            (String(a), String(b)) => a == b,
            (Double(a), Double(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            (Int(a), Int(b)) => a == b,
            (Uint(a), Uint(b)) => a == b,
            (Bytes(a), Bytes(b)) => a == b,
            (Timestamp(a), Timestamp(b)) => a == b,
            (Duration(a), Duration(b)) => a == b,
            (List(a), List(b)) => a == b,
            (Map(a), Map(b)) => {
                a.len() == b.len() && a.iter().all(|(key, value)| b.iter().any(|(k, v)| k == key && v == value))
            }
            _ => false,
        }
    }
}

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
        CelValue::String(s) => json_string(s),
        CelValue::Double(d) => {
            if d.is_finite() && !(*d == 0.0 && d.is_sign_negative()) {
                es_number(*d)
            } else {
                tagged(TAG_DOUBLE, &json_string(tagged_double_text(*d)))
            }
        }
        CelValue::Int(i) => tagged(TAG_INT, &format!("\"{i}\"")),
        CelValue::Uint(u) => tagged(TAG_UINT, &format!("\"{u}\"")),
        CelValue::Bytes(bytes) => tagged(TAG_BYTES, &format!("\"{}\"", base64url::encode(bytes))),
        CelValue::Timestamp(t) => tagged(TAG_TIMESTAMP, &format!("\"{}\"", rfc3339::encode(t))),
        CelValue::Duration(d) => {
            if d.seconds().unsigned_abs() > cel_duration::MAX_SECONDS {
                return Err(unencodable(path, format!("is a Duration outside CEL's range of ±{}s", cel_duration::MAX_SECONDS)));
            }
            tagged(TAG_DURATION, &format!("\"{}\"", cel_duration::encode(d)))
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
        CelValue::Map(entries) => write_map(entries, path)?,
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

/// A map with only string keys, none of them the tag key, is a plain object; any
/// other map is a tagged list of pairs ordered by key text.
fn write_map(entries: &[(CelValue, CelValue)], path: &mut Vec<String>) -> Result<String, TypedFrameError> {
    struct Pair {
        order: String,
        key: String,
        value: String,
    }
    let mut pairs = Vec::with_capacity(entries.len());
    let mut seen = std::collections::HashSet::new();
    let mut plain = true;
    for (key, value) in entries {
        let key_text = write_map_key(key, path)?;
        let identity = map_key_identity(key).expect("a written key has an identity");
        if !seen.insert(identity) {
            return Err(unencodable(path, format!("is a map with two keys equal to {key_text}")));
        }
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
    if plain {
        pairs.sort_by(|a, b| compare_code_units(&a.order, &b.order));
        let members: Vec<String> = pairs.iter().map(|p| format!("{}:{}", p.key, p.value)).collect();
        return Ok(format!("{{{}}}", members.join(",")));
    }
    pairs.sort_by(|a, b| compare_code_units(&a.key, &b.key));
    let members: Vec<String> = pairs.iter().map(|p| format!("[{},{}]", p.key, p.value)).collect();
    Ok(tagged(TAG_MAP, &format!("[{}]", members.join(","))))
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
        CelValue::String(s) => Ok(json_string(s)),
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
        CelValue::Map(_) => "a map".into(),
        CelValue::Bool(_) | CelValue::String(_) | CelValue::Int(_) | CelValue::Uint(_) => "a key".into(),
    }
}

/// What makes two keys ONE key. An `int` and a `uint` of the same number compare
/// equal in CEL, so a map carrying both is refused at both ends.
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

/// A string as `JSON.stringify` writes it.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A finite double as ECMAScript's `Number.prototype.toString` writes it — the
/// number form RFC 8785 adopts.
pub fn es_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let (digits, exponent) = shortest_digits(value.abs());
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// The significant digits and decimal exponent ECMAScript's `Number::toString`
/// chooses for a finite positive double: the fewest digits that read back as it,
/// and — where two candidates of that length read back and lie equally close to
/// it — the one ending in an even digit. `{:e}` finds the fewest digits but
/// settles that tie upward, so a tie is detected on the exact expansion and
/// settled here.
fn shortest_digits(magnitude: f64) -> (String, i32) {
    let split = |text: &str| -> (Vec<u8>, i32) {
        let (mantissa, exponent) = text.split_once('e').expect("scientific notation has an exponent");
        (
            mantissa.bytes().filter(|b| *b != b'.').collect(),
            exponent.parse().expect("exponent is an integer"),
        )
    };
    let (shortest, exponent) = split(&format!("{magnitude:e}"));
    let as_string = |digits: &[u8]| String::from_utf8(digits.to_vec()).expect("decimal digits are ASCII");
    // 767 significant digits hold the exact value of any double.
    let (exact, exact_exponent) = split(&format!("{magnitude:.766e}"));
    let k = shortest.len();
    let tie = exact_exponent == exponent
        && exact.len() > k
        && exact[k] == b'5'
        && exact[k + 1..].iter().all(|d| *d == b'0');
    if !tie || shortest[k - 1] % 2 == 0 {
        return (as_string(&shortest), exponent);
    }
    // The other candidate of the same length on the far side of the value.
    let truncated = &exact[..k];
    let other = if shortest.as_slice() == truncated {
        let mut up = truncated.to_vec();
        let mut at = k;
        loop {
            if at == 0 {
                // A carry past the first digit leaves no candidate of this length.
                return (as_string(&shortest), exponent);
            }
            at -= 1;
            if up[at] == b'9' {
                up[at] = b'0';
            } else {
                up[at] += 1;
                break;
            }
        }
        up
    } else {
        truncated.to_vec()
    };
    let text = format!("{}e{}", as_string(&other), exponent - (k as i32 - 1));
    if text.parse::<f64>() == Ok(magnitude) {
        (as_string(&other), exponent)
    } else {
        (as_string(&shortest), exponent)
    }
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
            let mut out = Vec::with_capacity(members.len());
            for (key, value) in members {
                path.push(key.lossy());
                let key = read_string(key, path)?;
                out.push((CelValue::String(key), read_value(value, path)?));
                path.pop();
            }
            Ok(CelValue::Map(out))
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
            .map(CelValue::Timestamp)
            .ok_or_else(|| undecodable(path, format!("is '{text}', not RFC 3339 text (2026-01-15T09:30:00Z) in its canonical written form"))),
        TAG_DURATION => cel_duration::decode(text)
            .filter(|d| cel_duration::encode(d) == text)
            .map(CelValue::Duration)
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
    Ok(CelValue::Map(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as Json;

    const VECTORS: &str = include_str!("../../../kernel/specs/durable-execution-typed-frame-vectors.json");

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
                let nanos = body["nanos"].as_i64().unwrap();
                CelValue::Timestamp(Timestamp::from_unix_millis(seconds * 1000 + nanos / 1_000_000).unwrap())
            }
            "duration" => {
                let seconds: i64 = decimal(&body["seconds"]).parse().unwrap();
                CelValue::Duration(Duration::new(seconds, body["nanos"].as_i64().unwrap() as i32).unwrap())
            }
            "list" => CelValue::List(body.as_array().unwrap().iter().map(notation).collect()),
            "map" => CelValue::Map(
                body.as_array().unwrap().iter().map(|pair| (notation(&pair[0]), notation(&pair[1]))).collect(),
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
                Timestamp::from_unix_millis(
                    Timestamp::MIN_UNIX_MILLIS
                        + (random.next() % (Timestamp::MAX_UNIX_MILLIS - Timestamp::MIN_UNIX_MILLIS) as u64) as i64,
                )
                .unwrap(),
            ),
            8 => CelValue::Duration(
                Duration::from_total_nanos(
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
                CelValue::Map(entries)
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
