//! Values written briefly, and a call to the runtime library by dispatch key — shared by
//! the evaluation tables. Every expected value in them is the Node build's answer.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::LazyLock;

use telorun_cel::{
    cel_none, cel_some, cel_type_value, implementation_of, register_standard_library, signature_key, CelCallContext,
    CelError, CelEvaluationCode, CelSignature, CelTimestamp, CelValue, FunctionRegistry, SourceRange,
    StandardLibraryOptions, CEL_EVALUATION_CODES, DYN,
};
use telorun_cel_value::{cel_map_from_entries, CelDuration, CelRecord};

/// The range every table call is made about, so every error it answers carries it.
pub const RANGE: SourceRange = SourceRange { start: 3, end: 9 };

pub fn null() -> CelValue {
    CelValue::Null
}

pub fn b(value: bool) -> CelValue {
    CelValue::Bool(value)
}

pub fn i(value: i64) -> CelValue {
    CelValue::Int(value)
}

pub fn u(value: u64) -> CelValue {
    CelValue::Uint(value)
}

pub fn d(value: f64) -> CelValue {
    CelValue::Double(value)
}

pub fn s(value: &str) -> CelValue {
    CelValue::String(value.into())
}

pub fn by(value: &[u8]) -> CelValue {
    CelValue::Bytes(value.into())
}

pub fn l(items: Vec<CelValue>) -> CelValue {
    CelValue::List(items.into())
}

pub fn m(entries: Vec<(CelValue, CelValue)>) -> CelValue {
    CelValue::Map(cel_map_from_entries(entries).expect("a map the table writes"))
}

pub fn rec(entries: Vec<(&str, CelValue)>) -> CelValue {
    CelValue::Record(entries.into_iter().collect::<CelRecord>())
}

pub fn ts(seconds: i64, nanos: u32) -> CelValue {
    CelValue::Timestamp(CelTimestamp::new(seconds, nanos).expect("an instant in range"))
}

pub fn du(seconds: i64, nanos: i32) -> CelValue {
    CelValue::Duration(CelDuration::new(seconds, nanos).expect("a duration the carrier holds"))
}

pub fn ty(name: &str) -> CelValue {
    CelValue::Type(cel_type_value(name))
}

pub fn some(value: CelValue) -> CelValue {
    CelValue::Optional(cel_some(value))
}

pub fn none() -> CelValue {
    CelValue::Optional(cel_none())
}

fn code(written: &str) -> CelEvaluationCode {
    *CEL_EVALUATION_CODES.iter().find(|code| code.as_str() == written).expect("a code")
}

/// An error value about [`RANGE`].
pub fn err(written: &str, message: &str) -> CelValue {
    CelValue::Error(CelError { code: code(written), message: message.into(), range: Some(RANGE) })
}

/// An error value about no range.
pub fn bare_err(written: &str, message: &str) -> CelValue {
    CelValue::Error(CelError { code: code(written), message: message.into(), range: None })
}

/// The standard library's signature under a dispatch key — or, for a name the library
/// answers by name (`==`, `<`, `type`), a signature of that name.
pub fn signature(key: &str) -> CelSignature {
    static LIBRARY: LazyLock<HashMap<String, CelSignature>> = LazyLock::new(|| {
        let mut registry = FunctionRegistry::new();
        register_standard_library(&mut registry, StandardLibraryOptions { optional_types: true, resolve_nominal: None });
        registry.list().iter().map(|held| (signature_key(&held.signature), held.signature.clone())).collect()
    });
    match LIBRARY.get(key) {
        Some(held) => held.clone(),
        None => CelSignature { name: key.into(), receiver: None, parameters: vec![], returns: DYN },
    }
}

/// What the implementation behind a dispatch key answers, called about [`RANGE`].
pub fn call(key: &str, args: &[CelValue]) -> CelValue {
    let implementation = implementation_of(&signature(key)).unwrap_or_else(|| panic!("{key} has an implementation"));
    implementation(&CelCallContext { range: Some(RANGE) }, args)
}
