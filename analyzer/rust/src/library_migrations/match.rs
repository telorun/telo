//! The recognizer of a library migration's legacy spelling: a rule's `match:`, evaluated as
//! data by this small matcher and never by a JSON Schema validator. Mirrors
//! `../../../nodejs/src/library-migrations/match.ts`, held to the matcher vectors in
//! `analyzer/library-migration-conformance/matcher.json`.
//!
//! The vocabulary is closed and spelled as a subset of the kind-schema grammar — `type`,
//! `required`, `const`, `enum`, and `properties` / `items` holding the same, with
//! `<key>: false` under `properties` for a key that is absent — and it reads as that grammar
//! does: `required` and `properties` judge a map and pass any other value, `items` judges a
//! list and passes any other value.
//!
//! A TAGGED value (`!cel`, `!ref`, an expansion tag) is opaque: it never satisfies `type`,
//! `const` or `enum`, it is never a map or a list, and as a member it is present, so it
//! satisfies `required`. Node's compiled value has no twin here: this loader compiles nothing.

use indexmap::IndexMap;
use serde_json::{Map, Value};
use telo_templating::{expansion_tag_of, is_tagged_sentinel};

/// A JSON value type `type:` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationMatchType {
    Null,
    Boolean,
    Object,
    Array,
    Number,
    Integer,
    String,
}

impl MigrationMatchType {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "null" => Self::Null,
            "boolean" => Self::Boolean,
            "object" => Self::Object,
            "array" => Self::Array,
            "number" => Self::Number,
            "integer" => Self::Integer,
            "string" => Self::String,
            _ => return None,
        })
    }
}

/// A rule's `match:`, as read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MigrationMatch {
    pub r#type: Option<Vec<MigrationMatchType>>,
    pub required: Option<Vec<String>>,
    /// Present when `const:` is written, `null` included.
    pub r#const: Option<Value>,
    pub r#enum: Option<Vec<Value>>,
    /// Each member's match, or `None` for `<key>: false`.
    pub properties: Option<IndexMap<String, Option<MigrationMatch>>>,
    pub items: Option<Box<MigrationMatch>>,
}

/// True for a value written behind a tag: content a migration may carry by position but
/// never reads as data.
pub fn is_opaque_migration_value(value: &Value) -> bool {
    is_tagged_sentinel(value) || expansion_tag_of(value).is_some()
}

/// A plain map of data: an object that is not opaque.
pub fn as_migration_map(value: &Value) -> Option<&Map<String, Value>> {
    if is_opaque_migration_value(value) {
        return None;
    }
    value.as_object()
}

/// True when the match pins its values with `const:` or `enum:`.
pub fn pins_values(r#match: &MigrationMatch) -> bool {
    r#match.r#const.is_some() || r#match.r#enum.is_some()
}

/// A whole number's exact value, as JSON Schema reads `integer`.
fn whole_number(value: &Value) -> Option<i128> {
    let number = value.as_number()?;
    if let Some(n) = number.as_i64() {
        return Some(n as i128);
    }
    if let Some(n) = number.as_u64() {
        return Some(n as i128);
    }
    let n = number.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() < 1.0e38).then_some(n as i128)
}

fn holds_type(r#type: MigrationMatchType, value: &Value) -> bool {
    match r#type {
        MigrationMatchType::Null => value.is_null(),
        MigrationMatchType::Boolean => value.is_boolean(),
        MigrationMatchType::String => value.is_string(),
        MigrationMatchType::Number => value.is_number(),
        MigrationMatchType::Integer => whole_number(value).is_some(),
        MigrationMatchType::Array => value.is_array(),
        MigrationMatchType::Object => as_migration_map(value).is_some(),
    }
}

/// JSON equality of two data values: an opaque value equals nothing, `1` equals `1.0` and
/// key order is ignored.
pub fn migration_values_equal(a: &Value, b: &Value) -> bool {
    if is_opaque_migration_value(a) || is_opaque_migration_value(b) {
        return false;
    }
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => match (whole_number(a), whole_number(b)) {
            (Some(x), Some(y)) => x == y,
            (None, None) => a.as_f64() == b.as_f64(),
            _ => false,
        },
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| migration_values_equal(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(key, a)| y.get(key).is_some_and(|b| migration_values_equal(a, b)))
        }
        _ => a == b,
    }
}

/// True when `value` satisfies `match`.
pub fn migration_match_holds(r#match: &MigrationMatch, value: &Value) -> bool {
    let opaque = is_opaque_migration_value(value);
    if let Some(types) = &r#match.r#type {
        if opaque || !types.iter().any(|t| holds_type(*t, value)) {
            return false;
        }
    }
    if let Some(expected) = &r#match.r#const {
        if !migration_values_equal(expected, value) {
            return false;
        }
    }
    if let Some(values) = &r#match.r#enum {
        if !values.iter().any(|candidate| migration_values_equal(candidate, value)) {
            return false;
        }
    }
    if let Some(map) = as_migration_map(value) {
        if let Some(required) = &r#match.required {
            if !required.iter().all(|key| map.contains_key(key)) {
                return false;
            }
        }
        for (key, member) in r#match.properties.iter().flatten() {
            match (member, map.get(key)) {
                (None, Some(_)) => return false,
                (Some(member), Some(present)) if !migration_match_holds(member, present) => return false,
                _ => {}
            }
        }
    }
    if let (Some(items), Value::Array(list)) = (&r#match.items, value) {
        if !list.iter().all(|item| migration_match_holds(items, item)) {
            return false;
        }
    }
    true
}
