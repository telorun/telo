//! The member-read seam: **one** lookup, for every form a read is written in —
//! `member-read.ts`.
//!
//! `a.b`, `a['b']`, `a[expr]`, `a.?b`, `a[?expr]`, a macro's field read and the presence
//! question `has()` all resolve here, through a single lookup over the value's **own**
//! entries. A key the value does not hold is the `no_such_key` error **value**, which
//! participates in short-circuit.
//!
//! **What each of the four verdicts answers is written once here**, in
//! `lookup_absence`, and read by every presence caller.
//!
//! Node's four lookup symbols are [`Lookup`]'s four refusals; `Lookup::Found` is the
//! value Node answers beside them.
//!
//! A host's named type reaches the seam as a [`CelHostValue`](crate::CelHostValue)
//! carrying its own entries: a lookup answers an entry only when it is a field the
//! type declares — [`HostFields`] — and the value holds it.
//!
//! How a refusal names its key: a string as `JSON.stringify` quotes it, an int or a
//! uint in decimal, a double as ECMAScript writes it, `true`, `false` and `null` as
//! themselves — as on Node. Any other key is named in CEL's terms (`a list`, `a map`,
//! `a value of type bytes`, `a value outside the CEL value domain`), where Node writes
//! JavaScript's `String()` of it — an interim wording.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use telorun_cel_value::{
    cel_error, cel_map_keys, cel_type_name_of, es_number, json_quote, map_key_identity, CelError, CelEvaluationCode,
    CelValue, SourceRange,
};

/// What one lookup found: a value, or one of the four ways it found none. `Missing` is
/// a key the container does not hold — which `has()` answers `false` for and a read
/// turns into `no_such_key`; the other three are mistakes in the read itself.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Lookup<'a> {
    Found(&'a CelValue),
    Missing,
    OutOfRange,
    UnsupportedContainer,
    UnsupportedKey,
}

/// The fields a host's registered named types declare, by the type name their values
/// carry. A lookup without it reads no host value's members at all.
pub trait HostFields {
    /// The fields `type_name` declares, or nothing for a type that declares none.
    fn declared(&self, type_name: &str) -> Option<&HashSet<String>>;
}

impl HostFields for HashMap<String, HashSet<String>> {
    fn declared(&self, type_name: &str) -> Option<&HashSet<String>> {
        self.get(type_name)
    }
}

/// An int-valued index, or nothing when the value is of no index type. A double that
/// holds a whole number indexes a list; one beyond 128 bits saturates, which is past
/// every list's end.
fn index_of(key: &CelValue) -> Option<i128> {
    match key {
        CelValue::Int(held) => Some(i128::from(*held)),
        CelValue::Uint(held) => Some(i128::from(*held)),
        CelValue::Double(held) if held.is_finite() && held.trunc() == *held => Some(*held as i128),
        _ => None,
    }
}

/// The single lookup. It is total over the value domain: a container that holds no
/// members answers `UnsupportedContainer`.
///
/// A value of a host's named type that declares fields answers exactly those, from its
/// own entries: a declared field it does not hold is `Missing`, as is any other name.
pub fn cel_lookup<'a>(container: &'a CelValue, key: &CelValue, fields: Option<&dyn HostFields>) -> Lookup<'a> {
    match (container, key) {
        (CelValue::Record(record), CelValue::String(key)) => record.get(key).map_or(Lookup::Missing, Lookup::Found),
        (CelValue::Map(map), _) => match map_key_identity(key) {
            None => Lookup::UnsupportedKey,
            Some(identity) => map.get(&identity).map_or(Lookup::Missing, Lookup::Found),
        },
        (CelValue::List(list), _) => match index_of(key) {
            None => Lookup::UnsupportedKey,
            Some(at) if at < 0 || at >= list.len() as i128 => Lookup::OutOfRange,
            Some(at) => Lookup::Found(&list[at as usize]),
        },
        (CelValue::Record(_), _) => Lookup::UnsupportedKey,
        (CelValue::Host(host), _) => {
            let declared = fields.zip(host.type_name()).and_then(|(fields, name)| fields.declared(name));
            match (declared, key) {
                (None, _) => Lookup::UnsupportedContainer,
                (Some(_), key) if !matches!(key, CelValue::String(_)) => Lookup::UnsupportedKey,
                (Some(declared), CelValue::String(name)) if declared.contains(&**name) => {
                    host.entries().get(name).map_or(Lookup::Missing, Lookup::Found)
                }
                (Some(_), _) => Lookup::Missing,
            }
        }
        _ => Lookup::UnsupportedContainer,
    }
}

/// The value at a key, or the error a failed lookup is.
pub fn cel_read(
    container: &CelValue,
    key: &CelValue,
    range: Option<SourceRange>,
    fields: Option<&dyn HostFields>,
) -> CelValue {
    match cel_lookup(container, key, fields) {
        Lookup::Found(value) => value.clone(),
        refused => lookup_error(refused, key, range).into(),
    }
}

/// Whether a lookup that found nothing answers **absence** rather than an error.
///
/// - A **presence-shaped** read — `a.?b`, `a[?k]` and `has(a.b)` — answers absence for
///   *missing*, *out of range* and *holds no members* alike, and the error only for an
///   **unusable key**.
/// - A read **through a present optional, written in the ordinary form**, answers
///   absence for a key the held value does not hold and the error for a held value that
///   holds no members at all.
/// - A **plain** read never asks: each of the four is the error `lookup_error` words.
///
/// A lookup that found a value is not absent.
pub fn lookup_absence(found: Lookup<'_>, presence: bool) -> bool {
    match found {
        Lookup::Missing | Lookup::OutOfRange => true,
        Lookup::UnsupportedContainer => presence,
        Lookup::Found(_) | Lookup::UnsupportedKey => false,
    }
}

/// The error a refused lookup is.
///
/// # Panics
///
/// On `Lookup::Found`, which is no refusal.
pub fn lookup_error(found: Lookup<'_>, key: &CelValue, range: Option<SourceRange>) -> CelError {
    match found {
        Lookup::Missing => cel_error(CelEvaluationCode::NoSuchKey, format!("no such key: {}", describe(key)), range),
        Lookup::OutOfRange => {
            cel_error(CelEvaluationCode::IndexOutOfRange, format!("index out of range: {}", describe(key)), range)
        }
        Lookup::UnsupportedKey => cel_error(
            CelEvaluationCode::UnsupportedKeyType,
            format!("{} cannot name an entry of this value", describe(key)),
            range,
        ),
        Lookup::UnsupportedContainer => {
            cel_error(CelEvaluationCode::UnsupportedContainer, "this value holds no members", range)
        }
        Lookup::Found(_) => panic!("a lookup that found a value is no refusal"),
    }
}

/// Whether a key is there — `has(a.b)` — as `Bool`, or the error an unusable key is.
pub fn cel_has(
    container: &CelValue,
    key: &CelValue,
    range: Option<SourceRange>,
    fields: Option<&dyn HostFields>,
) -> CelValue {
    match cel_lookup(container, key, fields) {
        Lookup::Found(_) => CelValue::Bool(true),
        refused if lookup_absence(refused, true) => CelValue::Bool(false),
        refused => lookup_error(refused, key, range).into(),
    }
}

/// The elements a comprehension ranges over: a list's items, as they are, or a map's
/// keys — a record's in ECMAScript's own-property order, a map's in insertion order.
pub fn cel_iterable(container: &CelValue, range: Option<SourceRange>) -> Result<Cow<'_, [CelValue]>, CelError> {
    match container {
        CelValue::List(list) => Ok(Cow::Borrowed(list.as_slice())),
        CelValue::Map(map) => Ok(Cow::Owned(cel_map_keys(map))),
        CelValue::Record(record) => Ok(Cow::Owned(record.keys().map(|key| CelValue::String(key.into())).collect())),
        _ => Err(cel_error(CelEvaluationCode::UnsupportedContainer, "a comprehension reads a list or a map", range)),
    }
}

/// A value named in CEL's terms, where no wording of its own names it.
pub(crate) fn cel_terms(value: &CelValue) -> String {
    match value {
        CelValue::Null => "null".into(),
        CelValue::List(_) => "a list".into(),
        CelValue::Map(_) | CelValue::Record(_) => "a map".into(),
        other => match cel_type_name_of(other) {
            Some(name) => format!("a value of type {name}"),
            None => "a value outside the CEL value domain".into(),
        },
    }
}

fn describe(key: &CelValue) -> String {
    match key {
        CelValue::String(text) => json_quote(text),
        CelValue::Int(held) => held.to_string(),
        CelValue::Uint(held) => held.to_string(),
        CelValue::Double(held) => es_number(*held),
        CelValue::Bool(held) => held.to_string(),
        other => cel_terms(other),
    }
}
