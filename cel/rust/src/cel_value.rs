//! What a value is — `cel-value.ts`, its engine half.
//!
//! The value domain lives in `telorun-cel-value`, and the items of its `cel_value.rs` are
//! re-exported here — `SourceRange` through the syntax tree — so a host of this crate needs
//! no second dependency to build a value or a property map. What needs the syntax tree
//! lives here: a literal read as the value it denotes.
//!
//! Node items with no twin: those the value crate's README lists for `cel-value.ts` — the
//! type-key symbol, the `isCel*` predicates, `celUint`, `isThenable` and
//! `asyncValueRefused`.

pub use telorun_cel_value::{
    cel_error, cel_none, cel_some, cel_type_name_of, cel_type_value, CelDuration, CelError, CelEvaluationCode,
    CelHostValue, CelMap, CelMapKey, CelOptional, CelRecord, CelTimestamp, CelTypeValue, CelValue, PropertyMap,
    ReservedTypeName, CEL_EVALUATION_CODES, CEL_VALUE_KEYS,
};

use crate::syntax_tree::CelLiteral;

/// The value a literal denotes: `1` an int, `1u` a uint, `b'a'` bytes.
pub fn literal_value(literal: &CelLiteral) -> CelValue {
    match literal {
        CelLiteral::Int(value) => CelValue::Int(*value),
        CelLiteral::Uint(value) => CelValue::Uint(*value),
        CelLiteral::Double(value) => CelValue::Double(*value),
        CelLiteral::String(value) => CelValue::String(value.clone()),
        CelLiteral::Bytes(value) => CelValue::Bytes(value.clone()),
        CelLiteral::Bool(value) => CelValue::Bool(*value),
        CelLiteral::Null => CelValue::Null,
    }
}
