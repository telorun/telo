//! serde through the typed frame: any `Serialize` value written as a frame, and
//! any `Deserialize` value read from one.
//!
//! No Node twin: serde is how a Rust type states its shape, and a JavaScript
//! value needs no bridge to reach the frame. The value types in
//! `cel_value_identity` are recognised by the newtype name they serialize under.
//!
//! A struct, and a map whose keys are all strings, becomes a `CelRecord`; a map
//! with any other key becomes a `CelMap`. The union is `telorun-cel-value`'s, so
//! serde's `Deserializer` is implemented for a private wrapper around it. A type
//! value, an optional, an error and a host value have no serde form and are
//! refused.
//!
//! Writing tracks where it stands in the value, so every refusal the bridge raises
//! names the JSON Pointer of the node it is about, in the frame writer's words. A
//! map key is judged where it arrives, and a refusal about one names the map.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fmt;

use serde::de::{self, DeserializeOwned, IntoDeserializer, Visitor};
use serde::ser::{self, Serialize};

use telorun_cel_value::{cel_map_from_entries, CelRecord};

use super::{
    decode_typed_frame, encode_typed_frame, key_segment, map_key_identity, unencodable, write_map_key,
    CelValue, TypedFrameError,
};
use crate::cel_value_identity::{BYTES_TOKEN, DURATION_TOKEN, TIMESTAMP_TOKEN, UINT_TOKEN};
use crate::plain_encoding::{base64url, cel_duration, rfc3339};

/// The frame text of any serde value. A `u64` beyond `i64` is refused, since a
/// plain integer is a CEL `int`; a CEL `uint` is `Uint64`.
pub fn to_frame<T: Serialize + ?Sized>(value: &T) -> Result<String, TypedFrameError> {
    encode_typed_frame(&to_value(value)?)
}

/// A serde value as a CEL value.
pub fn to_value<T: Serialize + ?Sized>(value: &T) -> Result<CelValue, TypedFrameError> {
    value.serialize(ValueSerializer { path: &Path::default(), key: false })
}

/// A serde value read from frame text.
pub fn from_frame<T: DeserializeOwned>(text: &str) -> Result<T, TypedFrameError> {
    from_value(decode_typed_frame(text)?)
}

/// A serde value read from a CEL value.
pub fn from_value<T: DeserializeOwned>(value: CelValue) -> Result<T, TypedFrameError> {
    T::deserialize(ValueDeserializer(value))
}

/// Where in the value being written the serializer stands, as JSON Pointer segments —
/// what a refusal names.
type Path = RefCell<Vec<String>>;

fn refuse(path: &Path, detail: impl fmt::Display) -> TypedFrameError {
    unencodable(&path.borrow(), detail)
}

/// A refusal about what is being written: the node at the path, or — while a map's
/// key is being written — a key of the map at the path.
fn refuse_node(path: &Path, key: bool, detail: impl fmt::Display) -> TypedFrameError {
    if key {
        refuse(path, format!("is a map with a key that {detail}"))
    } else {
        refuse(path, detail)
    }
}

/// A member, element or variant payload, written one segment deeper.
fn child<T: Serialize + ?Sized>(path: &Path, segment: String, value: &T) -> Result<CelValue, TypedFrameError> {
    path.borrow_mut().push(segment);
    let written = value.serialize(ValueSerializer { path, key: false });
    path.borrow_mut().pop();
    written
}

#[derive(Clone, Copy)]
struct ValueSerializer<'p> {
    path: &'p Path,
    /// Writing a key of the map at `path`: an aggregate is refused where it arrives,
    /// before anything beneath it is written, and every refusal is about the key.
    key: bool,
}

impl ValueSerializer<'_> {
    fn refuse(self, detail: impl fmt::Display) -> TypedFrameError {
        refuse_node(self.path, self.key, detail)
    }

    fn int_of<T: TryInto<i64> + fmt::Display + Copy>(self, value: T) -> Result<CelValue, TypedFrameError> {
        value.try_into().map(CelValue::Int).map_err(|_| {
            self.refuse(format!("is the integer {value}, outside CEL's int64 range; a CEL uint is Uint64"))
        })
    }

    /// Refuses an aggregate arriving as a map key, in the frame writer's words.
    fn not_a_key(self, what: &str) -> Result<(), TypedFrameError> {
        if self.key {
            return Err(self.refuse(format!("is {what}; a CEL map key is an int, uint, bool or string")));
        }
        Ok(())
    }
}

impl<'p> ser::Serializer for ValueSerializer<'p> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    type SerializeSeq = ListBuilder<'p>;
    type SerializeTuple = ListBuilder<'p>;
    type SerializeTupleStruct = ListBuilder<'p>;
    type SerializeTupleVariant = VariantBuilder<ListBuilder<'p>>;
    type SerializeMap = MapBuilder<'p>;
    type SerializeStruct = MapBuilder<'p>;
    type SerializeStructVariant = VariantBuilder<MapBuilder<'p>>;

    fn serialize_bool(self, v: bool) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_i16(self, v: i16) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_i32(self, v: i32) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_i64(self, v: i64) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_i128(self, v: i128) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_u8(self, v: u8) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_u16(self, v: u16) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_u32(self, v: u32) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_u64(self, v: u64) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_u128(self, v: u128) -> Result<CelValue, TypedFrameError> {
        self.int_of(v)
    }
    fn serialize_f32(self, v: f32) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Double(v as f64))
    }
    fn serialize_f64(self, v: f64) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Double(v))
    }
    fn serialize_char(self, v: char) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::String(v.to_string()))
    }
    fn serialize_str(self, v: &str) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::String(v.to_string()))
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Bytes(v.to_vec()))
    }
    fn serialize_none(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Null)
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<CelValue, TypedFrameError> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Null)
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Null)
    }
    fn serialize_unit_variant(self, _name: &'static str, _index: u32, variant: &'static str) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::String(variant.to_string()))
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, name: &'static str, value: &T) -> Result<CelValue, TypedFrameError> {
        let text = || -> Result<String, TypedFrameError> {
            match value.serialize(self)? {
                CelValue::String(text) => Ok(text),
                _ => Err(self.refuse(format!("is a {name} that serialized no text"))),
            }
        };
        let refused =
            |text: &str| -> TypedFrameError { self.refuse(format!("is '{text}', which is not the plain text of {name}")) };
        match name {
            TIMESTAMP_TOKEN => {
                let text = text()?;
                rfc3339::decode(&text).map(|t| CelValue::Timestamp(t.into())).ok_or_else(|| refused(&text))
            }
            DURATION_TOKEN => {
                let text = text()?;
                cel_duration::decode(&text).map(|d| CelValue::Duration(d.into())).ok_or_else(|| refused(&text))
            }
            BYTES_TOKEN => {
                let text = text()?;
                base64url::decode(&text).map(CelValue::Bytes).ok_or_else(|| refused(&text))
            }
            UINT_TOKEN => value.serialize(UintCapture { path: self.path, key: self.key }),
            _ => value.serialize(self),
        }
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _name: &'static str, _index: u32, variant: &'static str, value: &T) -> Result<CelValue, TypedFrameError> {
        self.not_a_key("a map")?;
        Ok(one_variant(variant, child(self.path, variant.to_string(), value)?))
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<ListBuilder<'p>, TypedFrameError> {
        self.not_a_key("a list")?;
        Ok(ListBuilder { path: self.path, items: Vec::with_capacity(len.unwrap_or(0)) })
    }
    fn serialize_tuple(self, len: usize) -> Result<ListBuilder<'p>, TypedFrameError> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<ListBuilder<'p>, TypedFrameError> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(self, _name: &'static str, _index: u32, variant: &'static str, len: usize) -> Result<VariantBuilder<ListBuilder<'p>>, TypedFrameError> {
        self.not_a_key("a map")?;
        self.path.borrow_mut().push(variant.to_string());
        Ok(VariantBuilder { variant, inner: self.serialize_seq(Some(len))? })
    }
    fn serialize_map(self, len: Option<usize>) -> Result<MapBuilder<'p>, TypedFrameError> {
        self.not_a_key("a map")?;
        Ok(MapBuilder { path: self.path, entries: Vec::with_capacity(len.unwrap_or(0)), key: None })
    }
    fn serialize_struct(self, _name: &'static str, len: usize) -> Result<MapBuilder<'p>, TypedFrameError> {
        self.serialize_map(Some(len))
    }
    fn serialize_struct_variant(self, _name: &'static str, _index: u32, variant: &'static str, len: usize) -> Result<VariantBuilder<MapBuilder<'p>>, TypedFrameError> {
        self.not_a_key("a map")?;
        self.path.borrow_mut().push(variant.to_string());
        Ok(VariantBuilder { variant, inner: self.serialize_map(Some(len))? })
    }
}

/// Reads the `u64` inside a `Uint64`, which a CEL `int` serializer would refuse.
struct UintCapture<'p> {
    path: &'p Path,
    key: bool,
}

impl UintCapture<'_> {
    fn not_uint(&self) -> TypedFrameError {
        refuse_node(self.path, self.key, "is a Uint64 that serialized something other than a u64")
    }
}

impl ser::Serializer for UintCapture<'_> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    type SerializeSeq = ser::Impossible<CelValue, TypedFrameError>;
    type SerializeTuple = ser::Impossible<CelValue, TypedFrameError>;
    type SerializeTupleStruct = ser::Impossible<CelValue, TypedFrameError>;
    type SerializeTupleVariant = ser::Impossible<CelValue, TypedFrameError>;
    type SerializeMap = ser::Impossible<CelValue, TypedFrameError>;
    type SerializeStruct = ser::Impossible<CelValue, TypedFrameError>;
    type SerializeStructVariant = ser::Impossible<CelValue, TypedFrameError>;

    fn serialize_u64(self, v: u64) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Uint(v))
    }
    fn serialize_bool(self, _v: bool) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_i8(self, _v: i8) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_i16(self, _v: i16) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_i32(self, _v: i32) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_i64(self, _v: i64) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_u8(self, _v: u8) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_u16(self, _v: u16) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_u32(self, _v: u32) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_f32(self, _v: f32) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_f64(self, _v: f64) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_char(self, _v: char) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_str(self, _v: &str) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_bytes(self, _v: &[u8]) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_none(self) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_some<T: Serialize + ?Sized>(self, _value: &T) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_unit(self) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_unit_variant(self, _name: &'static str, _index: u32, _variant: &'static str) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _name: &'static str, _value: &T) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _name: &'static str, _index: u32, _variant: &'static str, _value: &T) -> Result<CelValue, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_tuple_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeTupleStruct, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_tuple_variant(self, _name: &'static str, _index: u32, _variant: &'static str, _len: usize) -> Result<Self::SerializeTupleVariant, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeStruct, TypedFrameError> { Err(self.not_uint()) }
    fn serialize_struct_variant(self, _name: &'static str, _index: u32, _variant: &'static str, _len: usize) -> Result<Self::SerializeStructVariant, TypedFrameError> { Err(self.not_uint()) }
}

struct ListBuilder<'p> {
    path: &'p Path,
    items: Vec<CelValue>,
}

impl ser::SerializeSeq for ListBuilder<'_> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        self.items.push(child(self.path, self.items.len().to_string(), value)?);
        Ok(())
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::List(self.items))
    }
}

impl ser::SerializeTuple for ListBuilder<'_> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for ListBuilder<'_> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        ser::SerializeSeq::end(self)
    }
}

struct MapBuilder<'p> {
    path: &'p Path,
    entries: Vec<(CelValue, CelValue)>,
    key: Option<CelValue>,
}

impl MapBuilder<'_> {
    /// A record when every key is a string, a typed-key map otherwise. Each key was
    /// judged when it arrived; two keys that are one key are refused here, at the
    /// map's own pointer, in the frame writer's words and by the frame's own key rule
    /// — so the value domain's builder is handed nothing it refuses.
    fn finish(self) -> Result<CelValue, TypedFrameError> {
        let mut seen = HashSet::new();
        for (key, _) in &self.entries {
            let key_text = write_map_key(key, &self.path.borrow())?;
            let identity = map_key_identity(key).expect("a written key has an identity");
            if !seen.insert(identity) {
                return Err(refuse(self.path, format!("is a map with two keys equal to {key_text}")));
            }
        }
        if !self.entries.iter().all(|(key, _)| matches!(key, CelValue::String(_))) {
            // Unreachable while the checks above hold; if it fires, the builder says why.
            return cel_map_from_entries(self.entries).map(CelValue::Map).map_err(|error| {
                refuse(self.path, format!("is a map the value domain refused after the bridge accepted its keys: {error}"))
            });
        }
        let mut record = CelRecord::new();
        for (key, value) in self.entries {
            let CelValue::String(key) = key else {
                // Unreachable: this path is entered only when every key is a string.
                return Err(refuse(
                    self.path,
                    format!("is a map taken for a record although it holds the key {key:?}"),
                ));
            };
            record.insert(key, value);
        }
        Ok(CelValue::Record(record))
    }
}

impl ser::SerializeMap for MapBuilder<'_> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), TypedFrameError> {
        // Judged here, before its value is written: no pointer is derived from a
        // key the frame refuses.
        let key = key.serialize(ValueSerializer { path: self.path, key: true })?;
        write_map_key(&key, &self.path.borrow())?;
        self.key = Some(key);
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        let key = self.key.take().ok_or_else(|| refuse(self.path, "is a map whose value arrived before its key"))?;
        let value = child(self.path, key_segment(&key), value)?;
        self.entries.push((key, value));
        Ok(())
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        self.finish()
    }
}

impl ser::SerializeStruct for MapBuilder<'_> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), TypedFrameError> {
        let value = child(self.path, key.to_string(), value)?;
        self.entries.push((CelValue::String(key.to_string()), value));
        Ok(())
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        self.finish()
    }
}

/// An enum variant carrying data: a record of the variant's name to its value.
fn one_variant(variant: &'static str, value: CelValue) -> CelValue {
    CelValue::Record(CelRecord::from_iter([(variant, value)]))
}

/// A variant's payload under construction. The variant's name is the path segment
/// its builder was opened under, and is left when the payload ends.
struct VariantBuilder<B> {
    variant: &'static str,
    inner: B,
}

impl ser::SerializeTupleVariant for VariantBuilder<ListBuilder<'_>> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeSeq::serialize_element(&mut self.inner, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        let path = self.inner.path;
        let payload = ser::SerializeSeq::end(self.inner);
        path.borrow_mut().pop();
        Ok(one_variant(self.variant, payload?))
    }
}

impl ser::SerializeStructVariant for VariantBuilder<MapBuilder<'_>> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeStruct::serialize_field(&mut self.inner, key, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        let path = self.inner.path;
        let payload = ser::SerializeStruct::end(self.inner);
        path.borrow_mut().pop();
        Ok(one_variant(self.variant, payload?))
    }
}

/// A value being read by serde. The union is another crate's, so the
/// `Deserializer` role is this wrapper's.
struct ValueDeserializer(CelValue);

fn uncarried(what: &str) -> TypedFrameError {
    de::Error::custom(format!("the value is {what}, which has no serde form"))
}

impl<'de> de::Deserializer<'de> for ValueDeserializer {
    type Error = TypedFrameError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TypedFrameError> {
        match self.0 {
            CelValue::Null => visitor.visit_unit(),
            CelValue::Bool(b) => visitor.visit_bool(b),
            CelValue::String(s) => visitor.visit_string(s),
            CelValue::Double(d) => visitor.visit_f64(d),
            CelValue::Int(i) => visitor.visit_i64(i),
            CelValue::Uint(u) => visitor.visit_u64(u),
            CelValue::Bytes(bytes) => visitor.visit_byte_buf(bytes),
            CelValue::Timestamp(t) => visitor.visit_string(rfc3339::encode(&t.into())),
            CelValue::Duration(d) => visitor.visit_string(cel_duration::encode(&d.into())),
            CelValue::List(items) => {
                visitor.visit_seq(de::value::SeqDeserializer::new(items.into_iter().map(ValueDeserializer)))
            }
            CelValue::Map(map) => visitor.visit_map(de::value::MapDeserializer::new(
                map.into_iter().map(|(key, value)| (ValueDeserializer(key), ValueDeserializer(value))),
            )),
            CelValue::Record(record) => visitor.visit_map(de::value::MapDeserializer::new(
                record.into_iter().map(|(key, value)| (ValueDeserializer(CelValue::String(key)), ValueDeserializer(value))),
            )),
            CelValue::Type(_) => Err(uncarried("a type value")),
            CelValue::Optional(_) => Err(uncarried("an optional")),
            CelValue::Error(_) => Err(uncarried("an error value")),
            CelValue::Host(_) => Err(uncarried("a host value")),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TypedFrameError> {
        match self.0 {
            CelValue::Null => visitor.visit_none(),
            other => visitor.visit_some(ValueDeserializer(other)),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _name: &'static str, visitor: V) -> Result<V::Value, TypedFrameError> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TypedFrameError> {
        match self.0 {
            CelValue::Bytes(bytes) => visitor.visit_seq(de::value::SeqDeserializer::new(bytes.into_iter())),
            other => ValueDeserializer(other).deserialize_any(visitor),
        }
    }

    fn deserialize_enum<V: Visitor<'de>>(self, _name: &'static str, _variants: &'static [&'static str], visitor: V) -> Result<V::Value, TypedFrameError> {
        let one = |mut entries: std::vec::IntoIter<(CelValue, CelValue)>| entries.next().filter(|_| entries.len() == 0);
        let entry = match self.0 {
            CelValue::String(variant) => return visitor.visit_enum(variant.into_deserializer()),
            CelValue::Map(map) => one(map.into_iter()),
            CelValue::Record(record) => {
                one(record.into_iter().map(|(key, value)| (CelValue::String(key), value)).collect::<Vec<_>>().into_iter())
            }
            _ => None,
        };
        match entry {
            Some((variant, value)) => visitor.visit_enum(EnumValue { variant, value }),
            None => Err(de::Error::custom("an enum is a variant name, or a map of one variant to its value")),
        }
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct tuple tuple_struct map struct identifier ignored_any
    }
}

impl<'de> IntoDeserializer<'de, TypedFrameError> for ValueDeserializer {
    type Deserializer = ValueDeserializer;
    fn into_deserializer(self) -> ValueDeserializer {
        self
    }
}

struct EnumValue {
    variant: CelValue,
    value: CelValue,
}

impl<'de> de::EnumAccess<'de> for EnumValue {
    type Error = TypedFrameError;
    type Variant = ValueDeserializer;
    fn variant_seed<S: de::DeserializeSeed<'de>>(self, seed: S) -> Result<(S::Value, ValueDeserializer), TypedFrameError> {
        Ok((seed.deserialize(ValueDeserializer(self.variant))?, ValueDeserializer(self.value)))
    }
}

impl<'de> de::VariantAccess<'de> for ValueDeserializer {
    type Error = TypedFrameError;
    fn unit_variant(self) -> Result<(), TypedFrameError> {
        Ok(())
    }
    fn newtype_variant_seed<S: de::DeserializeSeed<'de>>(self, seed: S) -> Result<S::Value, TypedFrameError> {
        seed.deserialize(self)
    }
    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, TypedFrameError> {
        de::Deserializer::deserialize_any(self, visitor)
    }
    fn struct_variant<V: Visitor<'de>>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value, TypedFrameError> {
        de::Deserializer::deserialize_any(self, visitor)
    }
}
