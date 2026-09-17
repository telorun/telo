//! serde through the typed frame: any `Serialize` value written as a frame, and
//! any `Deserialize` value read from one.
//!
//! No Node twin: serde is how a Rust type states its shape, and a JavaScript
//! value needs no bridge to reach the frame. The value types in
//! `cel_value_identity` are recognised by the newtype name they serialize under.

use std::fmt;

use serde::de::{self, DeserializeOwned, IntoDeserializer, Visitor};
use serde::ser::{self, Serialize};

use super::{decode_typed_frame, encode_typed_frame, CelValue, TypedFrameError};
use crate::cel_value_identity::{BYTES_TOKEN, DURATION_TOKEN, TIMESTAMP_TOKEN, UINT_TOKEN};
use crate::plain_encoding::{base64url, cel_duration, rfc3339};

/// The frame text of any serde value. A `u64` beyond `i64` is refused, since a
/// plain integer is a CEL `int`; a CEL `uint` is `Uint64`.
pub fn to_frame<T: Serialize + ?Sized>(value: &T) -> Result<String, TypedFrameError> {
    encode_typed_frame(&to_value(value)?)
}

/// A serde value as a CEL value.
pub fn to_value<T: Serialize + ?Sized>(value: &T) -> Result<CelValue, TypedFrameError> {
    value.serialize(ValueSerializer)
}

/// A serde value read from frame text.
pub fn from_frame<T: DeserializeOwned>(text: &str) -> Result<T, TypedFrameError> {
    from_value(decode_typed_frame(text)?)
}

/// A serde value read from a CEL value.
pub fn from_value<T: DeserializeOwned>(value: CelValue) -> Result<T, TypedFrameError> {
    T::deserialize(value)
}

fn int_of<T: TryInto<i64> + fmt::Display + Copy>(value: T) -> Result<CelValue, TypedFrameError> {
    value.try_into().map(CelValue::Int).map_err(|_| {
        ser::Error::custom(format!("the integer {value} is outside CEL's int64 range; a CEL uint is Uint64"))
    })
}

struct ValueSerializer;

impl ser::Serializer for ValueSerializer {
    type Ok = CelValue;
    type Error = TypedFrameError;
    type SerializeSeq = ListBuilder;
    type SerializeTuple = ListBuilder;
    type SerializeTupleStruct = ListBuilder;
    type SerializeTupleVariant = VariantBuilder<ListBuilder>;
    type SerializeMap = MapBuilder;
    type SerializeStruct = MapBuilder;
    type SerializeStructVariant = VariantBuilder<MapBuilder>;

    fn serialize_bool(self, v: bool) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_i16(self, v: i16) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_i32(self, v: i32) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_i64(self, v: i64) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_i128(self, v: i128) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_u8(self, v: u8) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_u16(self, v: u16) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_u32(self, v: u32) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_u64(self, v: u64) -> Result<CelValue, TypedFrameError> {
        int_of(v)
    }
    fn serialize_u128(self, v: u128) -> Result<CelValue, TypedFrameError> {
        int_of(v)
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
            match value.serialize(ValueSerializer)? {
                CelValue::String(text) => Ok(text),
                _ => Err(<TypedFrameError as ser::Error>::custom(format!("{name} serialized no text"))),
            }
        };
        let refused = |text: &str| -> TypedFrameError {
            <TypedFrameError as ser::Error>::custom(format!("'{text}' is not the plain text of {name}"))
        };
        match name {
            TIMESTAMP_TOKEN => {
                let text = text()?;
                rfc3339::decode(&text).map(CelValue::Timestamp).ok_or_else(|| refused(&text))
            }
            DURATION_TOKEN => {
                let text = text()?;
                cel_duration::decode(&text).map(CelValue::Duration).ok_or_else(|| refused(&text))
            }
            BYTES_TOKEN => {
                let text = text()?;
                base64url::decode(&text).map(CelValue::Bytes).ok_or_else(|| refused(&text))
            }
            UINT_TOKEN => value.serialize(UintCapture),
            _ => value.serialize(self),
        }
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _name: &'static str, _index: u32, variant: &'static str, value: &T) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Map(vec![(CelValue::String(variant.to_string()), value.serialize(self)?)]))
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<ListBuilder, TypedFrameError> {
        Ok(ListBuilder(Vec::with_capacity(len.unwrap_or(0))))
    }
    fn serialize_tuple(self, len: usize) -> Result<ListBuilder, TypedFrameError> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<ListBuilder, TypedFrameError> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(self, _name: &'static str, _index: u32, variant: &'static str, len: usize) -> Result<VariantBuilder<ListBuilder>, TypedFrameError> {
        Ok(VariantBuilder { variant, inner: ListBuilder(Vec::with_capacity(len)) })
    }
    fn serialize_map(self, len: Option<usize>) -> Result<MapBuilder, TypedFrameError> {
        Ok(MapBuilder { entries: Vec::with_capacity(len.unwrap_or(0)), key: None })
    }
    fn serialize_struct(self, _name: &'static str, len: usize) -> Result<MapBuilder, TypedFrameError> {
        self.serialize_map(Some(len))
    }
    fn serialize_struct_variant(self, _name: &'static str, _index: u32, variant: &'static str, len: usize) -> Result<VariantBuilder<MapBuilder>, TypedFrameError> {
        Ok(VariantBuilder { variant, inner: MapBuilder { entries: Vec::with_capacity(len), key: None } })
    }
}

/// Reads the `u64` inside a `Uint64`, which a CEL `int` serializer would refuse.
struct UintCapture;

impl ser::Serializer for UintCapture {
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
    fn serialize_bool(self, _v: bool) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_i8(self, _v: i8) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_i16(self, _v: i16) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_i32(self, _v: i32) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_i64(self, _v: i64) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_u8(self, _v: u8) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_u16(self, _v: u16) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_u32(self, _v: u32) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_f32(self, _v: f32) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_f64(self, _v: f64) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_char(self, _v: char) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_str(self, _v: &str) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_bytes(self, _v: &[u8]) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_none(self) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_some<T: Serialize + ?Sized>(self, _value: &T) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_unit(self) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_unit_variant(self, _name: &'static str, _index: u32, _variant: &'static str) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _name: &'static str, _value: &T) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _name: &'static str, _index: u32, _variant: &'static str, _value: &T) -> Result<CelValue, TypedFrameError> { Err(not_uint()) }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, TypedFrameError> { Err(not_uint()) }
    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple, TypedFrameError> { Err(not_uint()) }
    fn serialize_tuple_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeTupleStruct, TypedFrameError> { Err(not_uint()) }
    fn serialize_tuple_variant(self, _name: &'static str, _index: u32, _variant: &'static str, _len: usize) -> Result<Self::SerializeTupleVariant, TypedFrameError> { Err(not_uint()) }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, TypedFrameError> { Err(not_uint()) }
    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeStruct, TypedFrameError> { Err(not_uint()) }
    fn serialize_struct_variant(self, _name: &'static str, _index: u32, _variant: &'static str, _len: usize) -> Result<Self::SerializeStructVariant, TypedFrameError> { Err(not_uint()) }
}

fn not_uint() -> TypedFrameError {
    ser::Error::custom("a Uint64 serialized something other than a u64")
}

struct ListBuilder(Vec<CelValue>);

impl ser::SerializeSeq for ListBuilder {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        self.0.push(value.serialize(ValueSerializer)?);
        Ok(())
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::List(self.0))
    }
}

impl ser::SerializeTuple for ListBuilder {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for ListBuilder {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        ser::SerializeSeq::end(self)
    }
}

struct MapBuilder {
    entries: Vec<(CelValue, CelValue)>,
    key: Option<CelValue>,
}

impl ser::SerializeMap for MapBuilder {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), TypedFrameError> {
        self.key = Some(key.serialize(ValueSerializer)?);
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        let key = self.key.take().ok_or_else(|| ser::Error::custom("a map value arrived before its key"))?;
        self.entries.push((key, value.serialize(ValueSerializer)?));
        Ok(())
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Map(self.entries))
    }
}

impl ser::SerializeStruct for MapBuilder {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), TypedFrameError> {
        self.entries.push((CelValue::String(key.to_string()), value.serialize(ValueSerializer)?));
        Ok(())
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Map(self.entries))
    }
}

struct VariantBuilder<B> {
    variant: &'static str,
    inner: B,
}

impl ser::SerializeTupleVariant for VariantBuilder<ListBuilder> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeSeq::serialize_element(&mut self.inner, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Map(vec![(CelValue::String(self.variant.to_string()), ser::SerializeSeq::end(self.inner)?)]))
    }
}

impl ser::SerializeStructVariant for VariantBuilder<MapBuilder> {
    type Ok = CelValue;
    type Error = TypedFrameError;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), TypedFrameError> {
        ser::SerializeStruct::serialize_field(&mut self.inner, key, value)
    }
    fn end(self) -> Result<CelValue, TypedFrameError> {
        Ok(CelValue::Map(vec![(CelValue::String(self.variant.to_string()), ser::SerializeStruct::end(self.inner)?)]))
    }
}

impl<'de> de::Deserializer<'de> for CelValue {
    type Error = TypedFrameError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TypedFrameError> {
        match self {
            CelValue::Null => visitor.visit_unit(),
            CelValue::Bool(b) => visitor.visit_bool(b),
            CelValue::String(s) => visitor.visit_string(s),
            CelValue::Double(d) => visitor.visit_f64(d),
            CelValue::Int(i) => visitor.visit_i64(i),
            CelValue::Uint(u) => visitor.visit_u64(u),
            CelValue::Bytes(bytes) => visitor.visit_byte_buf(bytes),
            CelValue::Timestamp(t) => visitor.visit_string(rfc3339::encode(&t)),
            CelValue::Duration(d) => visitor.visit_string(cel_duration::encode(&d)),
            CelValue::List(items) => visitor.visit_seq(de::value::SeqDeserializer::new(items.into_iter())),
            CelValue::Map(entries) => visitor.visit_map(de::value::MapDeserializer::new(entries.into_iter())),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TypedFrameError> {
        match self {
            CelValue::Null => visitor.visit_none(),
            other => visitor.visit_some(other),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _name: &'static str, visitor: V) -> Result<V::Value, TypedFrameError> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TypedFrameError> {
        match self {
            CelValue::Bytes(bytes) => visitor.visit_seq(de::value::SeqDeserializer::new(bytes.into_iter())),
            other => other.deserialize_any(visitor),
        }
    }

    fn deserialize_enum<V: Visitor<'de>>(self, _name: &'static str, _variants: &'static [&'static str], visitor: V) -> Result<V::Value, TypedFrameError> {
        match self {
            CelValue::String(variant) => visitor.visit_enum(variant.into_deserializer()),
            CelValue::Map(mut entries) if entries.len() == 1 => {
                let (variant, value) = entries.remove(0);
                visitor.visit_enum(EnumValue { variant, value })
            }
            _ => Err(de::Error::custom("an enum is a variant name, or a map of one variant to its value")),
        }
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct tuple tuple_struct map struct identifier ignored_any
    }
}

impl<'de> IntoDeserializer<'de, TypedFrameError> for CelValue {
    type Deserializer = CelValue;
    fn into_deserializer(self) -> CelValue {
        self
    }
}

struct EnumValue {
    variant: CelValue,
    value: CelValue,
}

impl<'de> de::EnumAccess<'de> for EnumValue {
    type Error = TypedFrameError;
    type Variant = CelValue;
    fn variant_seed<S: de::DeserializeSeed<'de>>(self, seed: S) -> Result<(S::Value, CelValue), TypedFrameError> {
        Ok((seed.deserialize(self.variant)?, self.value))
    }
}

impl<'de> de::VariantAccess<'de> for CelValue {
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
