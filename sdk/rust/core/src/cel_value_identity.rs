//! The CEL value domain as a Rust function or controller holds it.
//!
//! The twin of `sdk/nodejs/src/cel-value-identity.ts`, which re-exports the engine's
//! value domain. The domain here is `telorun-cel-value`'s, re-exported by name below:
//! the union `CelValue`, every type a variant holds, and the functions that build,
//! read and write a timestamp, a duration and a map. Every re-exported type is
//! constructible through the list: a type with private fields has its constructor
//! re-exported (`cel_type_value`, `cel_some` / `cel_none`, `cel_map_from_entries`, …),
//! and a type whose fields are all public (`CelError`) is built by literal. Every type a re-exported item's
//! signature names is re-exported with it — `ReservedTypeName` among them, the refusal
//! of `CelHostValue::named`, which is a Rust-only name: Node throws that refusal from
//! the engine's type registration.
//!
//! Four types are DECLARED here rather than re-exported — `Timestamp`, `Duration`,
//! `Bytes` and `Uint64` — because they are what a `#[derive(Serialize, Deserialize)]`
//! struct holds, and a serde impl decides what plain text a type reads: strict RFC
//! 3339, protobuf's duration range, the typed frame's tagged form. Those are this
//! package's plain encodings, which the value crate carries none of, and a serde impl
//! for a type must live in the crate that declares it. So `Timestamp` and `Duration`
//! are thin wrappers over the domain's `CelTimestamp` and `CelDuration`, converting
//! both ways, and `Uint64` and `Bytes` are markers over a `u64` and a `Vec<u8>` (the
//! domain's uint and bytes are variants of the union, not types).
//!
//! Each of the four reads BOTH encodings through serde — its plain text (an HTTP body,
//! a manifest literal) and the typed frame's tagged form (`{"$telo": …, "value": …}`)
//! — and writes its plain form to any serializer. The typed frame's own serializer
//! (`typed_frame::to_frame`) recognises the type by the newtype name it serializes
//! under and writes the tag, so one `Serialize` impl serves both boundaries.

use std::fmt;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use telorun_cel_value::{
    cel_duration_from_nanos, cel_map_from_entries, cel_map_keys, cel_none, cel_some, cel_timestamp,
    cel_timestamp_from_millis, cel_type_value, duration_nanos, duration_nanos_from_text, format_duration, format_timestamp, parse_duration,
    parse_timestamp, timestamp_nanos, CelDuration, CelError, CelEvaluationCode, CelHostValue, CelMap,
    CelMapKey, CelOptional, CelRecord, CelTimestamp, CelTypeValue, CelValue, ReservedTypeName, SourceRange,
};

use crate::plain_encoding::{base64url, cel_duration, rfc3339};
use crate::typed_frame::{self, TAG_BYTES, TAG_DURATION, TAG_TIMESTAMP, TAG_UINT, TYPED_FRAME_TAG};

/// The newtype names the typed frame's serializer recognises. A name no struct
/// in a crate could declare, so an author's own newtype is never mistaken for one.
pub(crate) const TIMESTAMP_TOKEN: &str = "$telo::google.protobuf.Timestamp";
pub(crate) const DURATION_TOKEN: &str = "$telo::google.protobuf.Duration";
pub(crate) const BYTES_TOKEN: &str = "$telo::bytes";
pub(crate) const UINT_TOKEN: &str = "$telo::uint";

/// A CEL `google.protobuf.Timestamp`: an instant between 0001-01-01T00:00:00Z
/// and 9999-12-31T23:59:59.999999999Z, held to the nanosecond — the precision
/// every Telo runtime holds one at, so a value never changes on a round trip.
/// Ordered and compared as an instant, whatever offset it was written with.
/// The serde-facing form of the domain's `CelTimestamp`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Timestamp {
    instant: CelTimestamp,
}

impl Timestamp {
    pub const MIN_UNIX_NANOS: i128 = CelTimestamp::MIN_UNIX_NANOS;
    pub const MAX_UNIX_NANOS: i128 = CelTimestamp::MAX_UNIX_NANOS;

    /// The instant `nanos` past `seconds` after the epoch, or `None` when
    /// `nanos` is a whole second or more, or the instant is outside CEL's range.
    pub fn new(seconds: i64, nanos: u32) -> Option<Self> {
        CelTimestamp::new(seconds, nanos).map(Self::from)
    }

    /// The instant `unix_nanos` after the epoch, or `None` outside CEL's range.
    pub fn from_unix_nanos(unix_nanos: i128) -> Option<Self> {
        CelTimestamp::from_unix_nanos(unix_nanos).map(Self::from)
    }

    pub fn unix_nanos(&self) -> i128 {
        self.instant.unix_nanos()
    }

    /// Whole seconds since the epoch, rounded toward negative infinity.
    pub fn seconds(&self) -> i64 {
        self.instant.seconds()
    }

    /// The nanoseconds past [`Timestamp::seconds`], always non-negative.
    pub fn subsec_nanos(&self) -> u32 {
        self.instant.subsec_nanos()
    }

    /// The timestamp RFC 3339 `text` names, at any offset — the strict plain form.
    pub fn parse(text: &str) -> Option<Self> {
        rfc3339::decode(text)
    }
}

impl From<CelTimestamp> for Timestamp {
    fn from(instant: CelTimestamp) -> Self {
        Self { instant }
    }
}

impl From<Timestamp> for CelTimestamp {
    fn from(timestamp: Timestamp) -> Self {
        timestamp.instant
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&rfc3339::encode(self))
    }
}

/// A CEL `google.protobuf.Duration`, to the nanosecond, with seconds and nanos
/// carrying one sign. The serde-facing form of the domain's `CelDuration`: it holds
/// any span whose whole seconds fit an `i64`, and its plain encoding bounds what is
/// read and written to protobuf's range.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Duration {
    span: CelDuration,
}

impl Duration {
    /// The duration of `seconds` and `nanos`, or `None` when their signs differ
    /// or `nanos` is a whole second or more.
    pub fn new(seconds: i64, nanos: i32) -> Option<Self> {
        CelDuration::new(seconds, nanos).map(Self::from)
    }

    /// The duration of `total_nanos`, or `None` when its seconds exceed an `i64`.
    pub fn from_total_nanos(total_nanos: i128) -> Option<Self> {
        CelDuration::from_total_nanos(total_nanos).map(Self::from)
    }

    pub fn total_nanos(&self) -> i128 {
        self.span.total_nanos()
    }

    /// Whole seconds, truncated toward zero.
    pub fn seconds(&self) -> i64 {
        self.span.seconds()
    }

    /// The nanoseconds past [`Duration::seconds`], with the same sign.
    pub fn nanos(&self) -> i32 {
        self.span.nanos()
    }

    /// The duration a CEL duration string names (`1h30m`, `250ms`, `5400s`) — the
    /// `cel-duration` plain encoding.
    pub fn parse(text: &str) -> Option<Self> {
        cel_duration::decode(text)
    }
}

impl From<CelDuration> for Duration {
    fn from(span: CelDuration) -> Self {
        Self { span }
    }
}

impl From<Duration> for CelDuration {
    fn from(duration: Duration) -> Self {
        duration.span
    }
}

impl fmt::Display for Duration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&cel_duration::encode(self))
    }
}

/// CEL `bytes`. Written as base64url; a `Vec<u8>` field is a list of numbers.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Bytes(pub Vec<u8>);

/// A CEL `uint`: the unsigned 64-bit domain JSON Schema cannot name
/// (`Telo.Uint64`). A plain `u64` field is a CEL `int`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Uint64(pub u64);

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(TIMESTAMP_TOKEN, &rfc3339::encode(self))
    }
}

impl Serialize for Duration {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(DURATION_TOKEN, &cel_duration::encode(self))
    }
}

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(BYTES_TOKEN, &base64url::encode(&self.0))
    }
}

impl Serialize for Uint64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(UINT_TOKEN, &self.0)
    }
}

/// Reads one of the four types from its plain text, its tagged typed-frame form,
/// or — for a typed frame decoded to a value first — the host value itself.
struct TypedVisitor<T> {
    tag: &'static str,
    expecting: &'static str,
    plain: fn(&str) -> Option<T>,
    from_u64: Option<fn(u64) -> T>,
    from_bytes: Option<fn(Vec<u8>) -> T>,
}

impl<'de, T> Visitor<'de> for TypedVisitor<T> {
    type Value = T;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.expecting)
    }

    fn visit_newtype_struct<D: Deserializer<'de>>(self, deserializer: D) -> Result<T, D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<T, E> {
        (self.plain)(text).ok_or_else(|| E::custom(format!("'{text}' is not {}", self.expecting)))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<T, E> {
        match self.from_u64 {
            Some(from) => Ok(from(value)),
            None => Err(E::invalid_type(de::Unexpected::Unsigned(value), &self)),
        }
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<T, E> {
        match (self.from_u64, u64::try_from(value)) {
            (Some(from), Ok(unsigned)) => Ok(from(unsigned)),
            _ => Err(E::invalid_type(de::Unexpected::Signed(value), &self)),
        }
    }

    fn visit_byte_buf<E: de::Error>(self, value: Vec<u8>) -> Result<T, E> {
        match self.from_bytes {
            Some(from) => Ok(from(value)),
            None => Err(E::invalid_type(de::Unexpected::Bytes(&value), &self)),
        }
    }

    fn visit_bytes<E: de::Error>(self, value: &[u8]) -> Result<T, E> {
        self.visit_byte_buf(value.to_vec())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<T, A::Error> {
        let mut tag: Option<String> = None;
        let mut value: Option<serde_json::Value> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                TYPED_FRAME_TAG => tag = Some(map.next_value()?),
                "value" => value = Some(map.next_value()?),
                other => {
                    return Err(de::Error::custom(format!(
                        "a tagged value carries exactly '{TYPED_FRAME_TAG}' and 'value', not '{other}'"
                    )))
                }
            }
        }
        match (tag.as_deref(), value) {
            (Some(tag), Some(serde_json::Value::String(text))) if tag == self.tag => {
                typed_frame::read_canonical_payload(self.tag, &text)
                    .map_err(de::Error::custom)
                    .and_then(|_| self.visit_str(&text))
            }
            _ => Err(de::Error::custom(format!("expected a '{}' tagged value", self.tag))),
        }
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_newtype_struct(
            TIMESTAMP_TOKEN,
            TypedVisitor { tag: TAG_TIMESTAMP, expecting: "an RFC 3339 timestamp", plain: rfc3339::decode, from_u64: None, from_bytes: None },
        )
    }
}

impl<'de> Deserialize<'de> for Duration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_newtype_struct(
            DURATION_TOKEN,
            TypedVisitor { tag: TAG_DURATION, expecting: "a CEL duration string", plain: cel_duration::decode, from_u64: None, from_bytes: None },
        )
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_newtype_struct(
            BYTES_TOKEN,
            TypedVisitor {
                tag: TAG_BYTES,
                expecting: "base64url bytes",
                plain: |text| base64url::decode(text).map(Bytes),
                from_u64: None,
                from_bytes: Some(Bytes),
            },
        )
    }
}

impl<'de> Deserialize<'de> for Uint64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_newtype_struct(
            UINT_TOKEN,
            TypedVisitor {
                tag: TAG_UINT,
                expecting: "an unsigned 64-bit integer",
                plain: |text| {
                    let canonical = text == "0" || (!text.starts_with('0') && text.bytes().all(|c| c.is_ascii_digit()));
                    canonical.then(|| text.parse().ok().map(Uint64)).flatten()
                },
                from_u64: Some(Uint64),
                from_bytes: None,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Args {
        at: Timestamp,
        took: Duration,
        raw: Bytes,
        count: Uint64,
    }

    /// Every variant of the union, built with nothing but names at this crate's root.
    #[test]
    fn builds_every_variant_of_the_union_through_the_re_exported_names() {
        use crate::{
            cel_duration_from_nanos, cel_map_from_entries, cel_none, cel_some, cel_timestamp, cel_type_value,
            CelError, CelEvaluationCode, CelHostValue, CelRecord, CelValue, SourceRange,
        };
        let error = CelError {
            code: CelEvaluationCode::NoSuchKey,
            message: "missing".into(),
            range: Some(SourceRange { start: 0, end: 1 }),
        };
        let built = [
            CelValue::Null,
            CelValue::Bool(true),
            CelValue::Int(-1),
            CelValue::Uint(1),
            CelValue::Double(1.5),
            CelValue::String("s".into()),
            CelValue::Bytes(vec![1]),
            CelValue::List(vec![CelValue::Null]),
            CelValue::Map(cel_map_from_entries([(CelValue::Int(1), CelValue::Null)]).unwrap()),
            CelValue::Record(CelRecord::from_iter([("a", CelValue::Null)])),
            CelValue::Timestamp(cel_timestamp(0, 0).unwrap()),
            CelValue::Duration(cel_duration_from_nanos(1).unwrap()),
            CelValue::Type(cel_type_value("int")),
            CelValue::Optional(cel_some(CelValue::Int(1))),
            CelValue::Optional(cel_none()),
            CelValue::Error(error),
            CelValue::Host(CelHostValue::named("Money", std::sync::Arc::new(5i64)).unwrap()),
            CelValue::Host(CelHostValue::unnamed(std::sync::Arc::new(()))),
        ];
        let variants: std::collections::HashSet<_> = built.iter().map(std::mem::discriminant).collect();
        assert_eq!(variants.len(), 16);
    }

    #[test]
    fn writes_the_plain_form_and_reads_both_forms() {
        let args = Args {
            at: Timestamp::parse("2026-01-15T09:30:00+02:00").unwrap(),
            took: Duration::parse("1h30m").unwrap(),
            raw: Bytes(vec![1, 2, 255]),
            count: Uint64(u64::MAX),
        };
        let plain = serde_json::to_string(&args).unwrap();
        assert_eq!(
            plain,
            r#"{"at":"2026-01-15T07:30:00Z","took":"5400s","raw":"AQL_","count":18446744073709551615}"#
        );
        assert_eq!(serde_json::from_str::<Args>(&plain).unwrap(), args);

        let frame = typed_frame::to_frame(&args).unwrap();
        assert_eq!(serde_json::from_str::<Args>(&frame).unwrap(), args);
        assert_eq!(typed_frame::from_frame::<Args>(&frame).unwrap(), args);
    }
}
