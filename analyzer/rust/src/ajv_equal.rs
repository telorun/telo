//! Deep equality as AJV judges `const`, `enum` and `uniqueItems`: a twin of
//! `fast-deep-equal` 3.1.3, the package ajv 8.20.0 pins for it, over the validator's view
//! of a value (`schema_opaque_value`).
//!
//! `a === b` first, so `0` equals `-0`; two NaN are equal at the end; containers of
//! different constructors never are (an array, a plain object and a stand-in each have
//! their own); a stand-in is compared by its `valueOf`, the identity of the instance value
//! it holds; a plain object by its own keys and their values, in any order.

use crate::schema_opaque_value::{opaque_identical, JsValue};

/// JavaScript's `a === b`.
pub fn strict_equal(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(x), JsValue::Bool(y)) => x == y,
        (JsValue::Number(x), JsValue::Number(y)) => x.value == y.value,
        (JsValue::String(x), JsValue::String(y)) => x == y,
        (JsValue::Function(x), JsValue::Function(y)) => x == y,
        // Two containers are one object only by reference, which a view never shares.
        _ => false,
    }
}

/// `fast-deep-equal`'s `equal(a, b)`, judged on a work list of the pairs still to compare,
/// so no depth of nesting reaches the native stack. An array's items are compared from the
/// last, as the package compares them, and an object's members in its own order.
pub fn deep_equal(a: &JsValue, b: &JsValue) -> bool {
    let mut pending = vec![(a, b)];
    while let Some((a, b)) = pending.pop() {
        if strict_equal(a, b) {
            continue;
        }
        let equal = match (a, b) {
            (JsValue::Array(x), JsValue::Array(y)) => {
                let equal = x.len() == y.len();
                if equal {
                    pending.extend(x.iter().zip(y.iter()));
                }
                equal
            }
            (JsValue::Opaque(x), JsValue::Opaque(y)) => opaque_identical(&x.held, &y.held),
            (JsValue::Object(x), JsValue::Object(y)) => {
                let equal = x.len() == y.len() && x.iter().all(|(key, _)| y.contains_key(key));
                if equal {
                    let pairs: Vec<(&JsValue, &JsValue)> = x.iter().filter_map(|(key, value)| Some((value, y.get(key)?))).collect();
                    pending.extend(pairs.into_iter().rev());
                }
                equal
            }
            (JsValue::Number(x), JsValue::Number(y)) => x.value.is_nan() && y.value.is_nan(),
            _ => false,
        };
        if !equal {
            return false;
        }
    }
    true
}
