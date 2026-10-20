//! Equality and ordering over values — **one comparison, serving both** —
//! `value-equality.ts`.
//!
//! `<`, `<=`, `>`, `>=`, cross-numeric equality, `in` over a list and a list index all
//! read the same rule, because two readers of "is this the same value" is how a
//! container and an operator come to disagree about one expression.
//!
//! **Across the numeric types it CONVERTS.** Where the double lies outside the integer
//! type's range the sign decides; otherwise the integer becomes a double — rounded to
//! the nearest, a tie to even, as ECMAScript's `Number(bigint)` rounds — and two doubles
//! are compared, **lossily**, so `dyn(9223372036854775807) < 9223372036854775808.0` is
//! `false`. That is cel-spec's own rule.
//!
//! A map's key identity is NOT this comparison and does not convert: see
//! `map_key_identity`.
//!
//! Equality across unrelated types is `false`, not an error. Ordering across unrelated
//! types has no answer, so the caller reports no overload.
//!
//! `cel_equal` walks lists, maps and optionals on a heap list, so a value of any depth
//! is compared on a small stack. Rust's `PartialEq` on a value is identity in the
//! domain, not this.

use std::cmp::Ordering;

use telorun_cel_value::{
    cel_type_name_of, compare_code_units, duration_nanos, map_key_identity, timestamp_nanos, CelMapKey, CelValue,
};

/// The int64 and uint64 extremes as doubles. Each reads as the nearest double there is.
const MIN_INT_AS_DOUBLE: f64 = -9223372036854775808.0;
const MAX_INT_AS_DOUBLE: f64 = 9223372036854775807.0;
const MAX_UINT_AS_DOUBLE: f64 = 18446744073709551615.0;

/// The numeric magnitude of a value, where it has one, and which range it belongs to.
enum Numeric {
    Integer { value: i128, unsigned: bool },
    Double(f64),
}

fn numeric(value: &CelValue) -> Option<Numeric> {
    match value {
        CelValue::Int(held) => Some(Numeric::Integer { value: i128::from(*held), unsigned: false }),
        CelValue::Uint(held) => Some(Numeric::Integer { value: i128::from(*held), unsigned: true }),
        CelValue::Double(held) => Some(Numeric::Double(*held)),
        _ => None,
    }
}

/// Comparing an integer against a double, cel-spec's way: outside the integer type's
/// range the sign decides, inside it both sides are doubles. Nothing for NaN.
fn compare_integer_double(left: i128, unsigned: bool, right: f64) -> Option<Ordering> {
    if right.is_nan() {
        return None;
    }
    if right < if unsigned { 0.0 } else { MIN_INT_AS_DOUBLE } {
        return Some(Ordering::Greater);
    }
    if right > if unsigned { MAX_UINT_AS_DOUBLE } else { MAX_INT_AS_DOUBLE } {
        return Some(Ordering::Less);
    }
    (left as f64).partial_cmp(&right)
}

fn compare_numeric(left: Numeric, right: Numeric) -> Option<Ordering> {
    match (left, right) {
        // An int and a uint are both exact integers, so one comparison serves both.
        (Numeric::Integer { value: a, .. }, Numeric::Integer { value: b, .. }) => Some(a.cmp(&b)),
        (Numeric::Integer { value, unsigned }, Numeric::Double(right)) => compare_integer_double(value, unsigned, right),
        (Numeric::Double(left), Numeric::Integer { value, unsigned }) => {
            compare_integer_double(value, unsigned, left).map(Ordering::reverse)
        }
        (Numeric::Double(a), Numeric::Double(b)) => a.partial_cmp(&b),
    }
}

/// How two values order, or nothing when they do not order at all — unrelated types,
/// or a NaN, which orders with nothing including itself.
pub fn cel_compare(left: &CelValue, right: &CelValue) -> Option<Ordering> {
    if let (Some(a), Some(b)) = (numeric(left), numeric(right)) {
        return compare_numeric(a, b);
    }
    match (left, right) {
        (CelValue::String(a), CelValue::String(b)) => Some(compare_code_units(a, b)),
        (CelValue::Bool(a), CelValue::Bool(b)) => Some(a.cmp(b)),
        (CelValue::Bytes(a), CelValue::Bytes(b)) => Some(a.cmp(b)),
        (CelValue::Timestamp(a), CelValue::Timestamp(b)) => Some(timestamp_nanos(*a).cmp(&timestamp_nanos(*b))),
        (CelValue::Duration(a), CelValue::Duration(b)) => Some(duration_nanos(*a).cmp(&duration_nanos(*b))),
        _ => None,
    }
}

/// A map's or a record's entries as equality walks them: an identity and a value.
fn map_entries(value: &CelValue) -> Option<Vec<(CelMapKey, &CelValue)>> {
    match value {
        CelValue::Map(map) => Some(
            map.iter()
                .map(|(key, value)| (map_key_identity(key).expect("a map's key names an entry"), value))
                .collect(),
        ),
        CelValue::Record(record) => {
            Some(record.iter().map(|(key, value)| (CelMapKey::String(key.into()), value)).collect())
        }
        _ => None,
    }
}

fn map_size(value: &CelValue) -> usize {
    match value {
        CelValue::Map(map) => map.len(),
        CelValue::Record(record) => record.len(),
        _ => 0,
    }
}

/// The value a map or a record holds under an identity.
fn map_lookup<'a>(value: &'a CelValue, identity: &CelMapKey) -> Option<&'a CelValue> {
    match (value, identity) {
        (CelValue::Map(map), _) => map.get(identity),
        (CelValue::Record(record), CelMapKey::String(key)) => record.get(key),
        _ => None,
    }
}

/// CEL equality: by value, across the numeric types, and `false` across unrelated ones.
pub fn cel_equal(left: &CelValue, right: &CelValue) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((left, right)) = pending.pop() {
        if let (Some(a), Some(b)) = (numeric(left), numeric(right)) {
            if compare_numeric(a, b) != Some(Ordering::Equal) {
                return false;
            }
            continue;
        }
        if matches!(left, CelValue::Null) || matches!(right, CelValue::Null) {
            if !(matches!(left, CelValue::Null) && matches!(right, CelValue::Null)) {
                return false;
            }
            continue;
        }
        if cel_type_name_of(left) != cel_type_name_of(right) {
            return false;
        }
        let same = match (left, right) {
            (CelValue::Bool(a), CelValue::Bool(b)) => a == b,
            (CelValue::String(a), CelValue::String(b)) => a == b,
            (CelValue::Bytes(a), CelValue::Bytes(b)) => a == b,
            (CelValue::Timestamp(a), CelValue::Timestamp(b)) => timestamp_nanos(*a) == timestamp_nanos(*b),
            (CelValue::Duration(a), CelValue::Duration(b)) => duration_nanos(*a) == duration_nanos(*b),
            (CelValue::Type(a), CelValue::Type(b)) => a.name() == b.name(),
            (CelValue::List(a), CelValue::List(b)) => {
                let same = a.len() == b.len();
                if same {
                    pending.extend(a.iter().zip(b.iter()));
                }
                same
            }
            (CelValue::Map(_) | CelValue::Record(_), CelValue::Map(_) | CelValue::Record(_)) => {
                let entries = map_entries(left).expect("a map has entries");
                entries.len() == map_size(right)
                    && entries.into_iter().all(|(identity, value)| match map_lookup(right, &identity) {
                        Some(other) => {
                            pending.push((value, other));
                            true
                        }
                        None => false,
                    })
            }
            (CelValue::Optional(a), CelValue::Optional(b)) => match (a.held(), b.held()) {
                (None, None) => true,
                (Some(a), Some(b)) => {
                    pending.push((a, b));
                    true
                }
                _ => false,
            },
            // A host's own named type: equal when the host's operator says so, which it
            // registers itself. With none registered, identity is all this engine knows.
            _ => left == right,
        };
        if !same {
            return false;
        }
    }
    true
}
