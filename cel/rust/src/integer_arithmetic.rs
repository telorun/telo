//! Integer arithmetic: 64-bit, checked, and **never wrapped** — `integer-arithmetic.ts`.
//!
//! CEL's `int` is a signed 64-bit integer and its `uint` an unsigned one. A result
//! outside the range is an error, not a wrap, and the error names the exact result: an
//! intermediate is computed wide enough to hold it — 128 bits for a sum, a difference, a
//! quotient or an `int` product, and a `uint` product's own 128 unsigned bits — and a
//! decimal text of any length is named as it reads.
//!
//! Division truncates toward zero and the modulo takes the dividend's sign; division
//! and modulo by zero are errors of their own, so a reader knows which one happened.
//!
//! Node items with no twin: `fitsUint` / `fitsInt` — nothing calls them; the range is
//! the type.
//!
//! Two crate-private companions stand where Node holds every intermediate as a
//! `bigint`: `uint_product`, the one result 128 signed bits cannot hold, and
//! `decimal_result`, the result of a decimal text of any length.

use std::fmt::Display;

use telorun_cel_value::{cel_error, CelEvaluationCode, CelValue, SourceRange};

fn overflow(range: Option<SourceRange>, result: impl Display, what: &str) -> CelValue {
    cel_error(CelEvaluationCode::NumericOverflow, format!("{what} overflow: {result}"), range).into()
}

/// An int result, or the overflow it is outside the range.
pub fn int_result(value: i128, range: Option<SourceRange>) -> CelValue {
    match i64::try_from(value) {
        Ok(value) => CelValue::Int(value),
        Err(_) => overflow(range, value, "integer"),
    }
}

/// A uint result, or the overflow it is outside the range.
pub fn uint_result(value: i128, range: Option<SourceRange>) -> CelValue {
    match u64::try_from(value) {
        Ok(value) => CelValue::Uint(value),
        Err(_) => overflow(range, value, "unsigned integer"),
    }
}

/// The product of two uints, or the overflow naming it exactly.
pub(crate) fn uint_product(left: u64, right: u64, range: Option<SourceRange>) -> CelValue {
    let product = u128::from(left) * u128::from(right);
    match u64::try_from(product) {
        Ok(value) => CelValue::Uint(value),
        Err(_) => overflow(range, product, "unsigned integer"),
    }
}

/// The int or uint a decimal text names — an optional sign, then ASCII digits, as a
/// conversion reads it — or the overflow naming it as the shortest decimal of its value.
/// A text that is not such a decimal is the caller's to refuse; here it panics.
pub(crate) fn decimal_result(text: &str, unsigned: bool, range: Option<SourceRange>) -> CelValue {
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    assert!(!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()), "{text:?} is not a decimal");
    let digits = digits.trim_start_matches('0');
    let magnitude: Option<i128> = digits.parse().ok().or(digits.is_empty().then_some(0));
    let what = if unsigned { "unsigned integer" } else { "integer" };
    match magnitude {
        Some(magnitude) => {
            let value = if negative { -magnitude } else { magnitude };
            if unsigned {
                uint_result(value, range)
            } else {
                int_result(value, range)
            }
        }
        None => overflow(range, format_args!("{}{digits}", if negative { "-" } else { "" }), what),
    }
}

pub fn int_divide(left: i64, right: i64, range: Option<SourceRange>) -> CelValue {
    if right == 0 {
        return cel_error(CelEvaluationCode::DivisionByZero, "division by zero", range).into();
    }
    int_result(i128::from(left) / i128::from(right), range)
}

pub fn int_modulo(left: i64, right: i64, range: Option<SourceRange>) -> CelValue {
    if right == 0 {
        return cel_error(CelEvaluationCode::ModuloByZero, "modulus by zero", range).into();
    }
    int_result(i128::from(left) % i128::from(right), range)
}

pub fn uint_divide(left: u64, right: u64, range: Option<SourceRange>) -> CelValue {
    if right == 0 {
        return cel_error(CelEvaluationCode::DivisionByZero, "division by zero", range).into();
    }
    CelValue::Uint(left / right)
}

pub fn uint_modulo(left: u64, right: u64, range: Option<SourceRange>) -> CelValue {
    if right == 0 {
        return cel_error(CelEvaluationCode::ModuloByZero, "modulus by zero", range).into();
    }
    CelValue::Uint(left % right)
}
