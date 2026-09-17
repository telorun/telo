//! The CEL value types a Rust function or controller holds — `Timestamp`,
//! `Duration`, `Bytes` and `Uint64` — beside the plain JSON types serde already
//! maps (`i64` is a CEL `int`, `f64` a `double`, `String`, `bool`, lists, maps).
//!
//! The twin of `sdk/nodejs/src/cel-value-identity.ts`, which is where the Node SDK
//! obtains the classes those values are in memory. In Rust a value's type is its
//! identity, so this file declares the types rather than re-exporting an engine's.
//!
//! Each type reads BOTH encodings through serde — its plain text (an HTTP body, a
//! manifest literal) and the typed frame's tagged form (`{"$telo": …, "value": …}`)
//! — and writes its plain form to any serializer. The typed frame's own serializer
//! (`typed_frame::to_frame`) recognises the type by the newtype name it serializes
//! under and writes the tag, so one `Serialize` impl serves both boundaries.

use std::fmt;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::plain_encoding::{base64url, cel_duration, rfc3339};
use crate::typed_frame::{self, TAG_BYTES, TAG_DURATION, TAG_TIMESTAMP, TAG_UINT, TYPED_FRAME_TAG};

/// The newtype names the typed frame's serializer recognises. A name no struct
/// in a crate could declare, so an author's own newtype is never mistaken for one.
pub(crate) const TIMESTAMP_TOKEN: &str = "$telo::google.protobuf.Timestamp";
pub(crate) const DURATION_TOKEN: &str = "$telo::google.protobuf.Duration";
pub(crate) const BYTES_TOKEN: &str = "$telo::bytes";
pub(crate) const UINT_TOKEN: &str = "$telo::uint";

/// A CEL `google.protobuf.Timestamp`: an instant between 0001-01-01T00:00:00Z
/// and 9999-12-31T23:59:59.999Z, held to the millisecond — the precision every
/// Telo runtime holds one at, so a value never changes on a round trip.
/// Ordered and compared as an instant, whatever offset it was written with.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Timestamp {
    unix_millis: i64,
}

impl Timestamp {
    pub const MIN_UNIX_MILLIS: i64 = -62_135_596_800_000;
    pub const MAX_UNIX_MILLIS: i64 = 253_402_300_799_999;

    /// The instant `unix_millis` after the epoch, or `None` outside CEL's range.
    pub fn from_unix_millis(unix_millis: i64) -> Option<Self> {
        (Self::MIN_UNIX_MILLIS..=Self::MAX_UNIX_MILLIS)
            .contains(&unix_millis)
            .then_some(Self { unix_millis })
    }

    pub fn unix_millis(&self) -> i64 {
        self.unix_millis
    }

    /// Whole seconds since the epoch, rounded toward negative infinity.
    pub fn seconds(&self) -> i64 {
        self.unix_millis.div_euclid(1000)
    }

    /// The nanoseconds past [`Timestamp::seconds`], always non-negative.
    pub fn subsec_nanos(&self) -> u32 {
        (self.unix_millis.rem_euclid(1000) * 1_000_000) as u32
    }

    /// The timestamp RFC 3339 `text` names, at any offset.
    pub fn parse(text: &str) -> Option<Self> {
        rfc3339::decode(text)
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&rfc3339::encode(self))
    }
}

/// A CEL `google.protobuf.Duration`, to the nanosecond, with seconds and nanos
/// carrying one sign.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Duration {
    total_nanos: i128,
}

impl Duration {
    /// The duration of `seconds` and `nanos`, or `None` when their signs differ
    /// or `nanos` is a whole second or more.
    pub fn new(seconds: i64, nanos: i32) -> Option<Self> {
        if nanos.unsigned_abs() >= 1_000_000_000 || (seconds > 0 && nanos < 0) || (seconds < 0 && nanos > 0) {
            return None;
        }
        Some(Self { total_nanos: seconds as i128 * 1_000_000_000 + nanos as i128 })
    }

    /// The duration of `total_nanos`, or `None` when its seconds exceed an `i64`.
    pub fn from_total_nanos(total_nanos: i128) -> Option<Self> {
        i64::try_from(total_nanos / 1_000_000_000).ok().map(|_| Self { total_nanos })
    }

    pub fn total_nanos(&self) -> i128 {
        self.total_nanos
    }

    /// Whole seconds, truncated toward zero.
    pub fn seconds(&self) -> i64 {
        (self.total_nanos / 1_000_000_000) as i64
    }

    /// The nanoseconds past [`Duration::seconds`], with the same sign.
    pub fn nanos(&self) -> i32 {
        (self.total_nanos % 1_000_000_000) as i32
    }

    /// The duration a CEL duration string names (`1h30m`, `250ms`, `5400s`).
    pub fn parse(text: &str) -> Option<Self> {
        cel_duration::decode(text)
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
            r#"{"at":"2026-01-15T07:30:00.000Z","took":"5400s","raw":"AQL_","count":18446744073709551615}"#
        );
        assert_eq!(serde_json::from_str::<Args>(&plain).unwrap(), args);

        let frame = typed_frame::to_frame(&args).unwrap();
        assert_eq!(serde_json::from_str::<Args>(&frame).unwrap(), args);
        assert_eq!(typed_frame::from_frame::<Args>(&frame).unwrap(), args);
    }
}
