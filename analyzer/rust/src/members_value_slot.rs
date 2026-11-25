//! A slot holding a value type that declares `members` — a URL — and why a value there is
//! not one. Mirrors `../../nodejs/src/members-value-slot.ts` (`membersSlotOf`,
//! `readMembersValue`, `membersValueRefusal`, `boundArgumentRefusal`,
//! `membersRefusalCode`): read by the schema-error phraser, and by the kernel, which builds
//! a value of the type at a contract boundary. Named by nothing but the entry: no type is
//! spelled here, and every refusal names what is wrong without quoting the value.

use std::sync::Arc;

use serde_json::{Map, Value};
use telorun_cel_value::{CelHostValue, CelValue};
use telorun_sdk_core::plain_encoding::{host_members, url_text, PLAIN_ENCODINGS};
use telorun_sdk_core::value_type::{value_type_of, ValueType, X_TELO_TYPE};

use crate::value_type_keyword::binding_holds;

/// A slot whose value type declares members, read off its schema node.
pub struct MembersSlot {
    pub entry: &'static ValueType,
    /// The slot's type arguments, by parameter name.
    pub args: Map<String, Value>,
    encoding: &'static str,
    form: &'static str,
    binding: &'static str,
}

/// The members slot a schema node declares, or `None` when it declares none.
pub fn members_slot_of(schema: &Value) -> Option<MembersSlot> {
    let entry = value_type_of(schema)?;
    entry.members.as_ref()?;
    let encoding = PLAIN_ENCODINGS.iter().find(|e| Some(e.name) == entry.encoding.as_deref()).filter(|e| e.composes)?;
    let binding = entry.binding.as_deref()?;
    let args = schema.get(X_TELO_TYPE).and_then(Value::as_object).cloned().unwrap_or_default();
    Some(MembersSlot { entry, args, encoding: encoding.name, form: encoding.form, binding })
}

/// What a value at the slot builds, or why it builds nothing.
enum MembersRead {
    Value(Map<String, Value>),
    Refusal(String),
}

fn read_text(encoding: &str, text: &str) -> Result<Map<String, Value>, String> {
    match encoding {
        "url-text" => url_text::read(text).map(|url| url_text::members(&url)),
        _ => Err(String::new()),
    }
}

fn compose(encoding: &str, members: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    match encoding {
        "url-text" => url_text::compose(members).map(|url| url_text::members(&url)),
        _ => Err(String::new()),
    }
}

/// A plain value as the members object a codec composes from, or `None` when it is not one.
fn plain_members(value: &CelValue) -> Option<Map<String, Value>> {
    let CelValue::Record(record) = value else { return None };
    let mut out = Map::new();
    for (key, item) in record.iter() {
        out.insert(key.to_string(), plain_json(item)?);
    }
    Some(out)
}

fn plain_json(value: &CelValue) -> Option<Value> {
    Some(match value {
        CelValue::Null => Value::Null,
        CelValue::Bool(b) => Value::Bool(*b),
        CelValue::Int(i) => Value::from(*i),
        CelValue::Uint(u) => Value::from(*u),
        CelValue::Double(d) => serde_json::Number::from_f64(*d).map_or(Value::Null, Value::Number),
        CelValue::String(s) => Value::String(s.to_string()),
        CelValue::List(items) => Value::Array(items.iter().map(plain_json).collect::<Option<_>>()?),
        CelValue::Record(_) => Value::Object(plain_members(value)?),
        _ => return None,
    })
}

/// `describeKind`: what a value that is neither text nor an object of members is.
fn describe_kind(value: &CelValue) -> String {
    match value {
        CelValue::Null => "null".into(),
        CelValue::List(_) => "a list".into(),
        CelValue::Bool(_) => "a boolean".into(),
        CelValue::Int(_) | CelValue::Uint(_) => "a bigint".into(),
        CelValue::Double(_) => "a number".into(),
        CelValue::String(_) => "a string".into(),
        _ => "a value of another type".into(),
    }
}

fn read_members(slot: &MembersSlot, value: &CelValue) -> MembersRead {
    if binding_holds(slot.binding, value) {
        let CelValue::Host(host) = value else { return MembersRead::Value(Map::new()) };
        return MembersRead::Value(host_members(slot.encoding, host).unwrap_or_default());
    }
    if let CelValue::String(text) = value {
        return match read_text(slot.encoding, text) {
            Ok(members) => MembersRead::Value(members),
            Err(refusal) if !refusal.is_empty() => MembersRead::Refusal(refusal),
            Err(_) => MembersRead::Refusal(format!("it is not {}", slot.form)),
        };
    }
    if let Some(members) = plain_members(value) {
        return match compose(slot.encoding, &members) {
            Ok(built) => MembersRead::Value(built),
            Err(refusal) => MembersRead::Refusal(refusal),
        };
    }
    MembersRead::Refusal(format!(
        "it is {}, where {} is written as text or as an object of its members",
        describe_kind(value),
        slot.entry.name
    ))
}

/// Whether building reads `value` at the slot: text, a record of members, or a value the
/// type's binding already holds — what `mapTextLeaves` hands `buildMembersValues`.
pub fn settles_at(slot: &MembersSlot, value: &CelValue) -> bool {
    matches!(value, CelValue::String(_) | CelValue::Record(_)) || binding_holds(slot.binding, value)
}

/// `readMembersValue`: the value `value` builds at the slot — text decoded, an object of
/// members built, a value of the type as it is — or why it builds nothing.
pub fn read_members_value(slot: &MembersSlot, value: &CelValue) -> Result<CelValue, String> {
    if binding_holds(slot.binding, value) {
        return Ok(value.clone());
    }
    match read_members(slot, value) {
        MembersRead::Refusal(refusal) => Err(refusal),
        MembersRead::Value(_) => built_value(slot.encoding, value),
    }
}

/// The value of the type text or an object of members reads as, once it is known to read.
fn built_value(encoding: &str, value: &CelValue) -> Result<CelValue, String> {
    let url = match (encoding, value) {
        ("url-text", CelValue::String(text)) => url_text::read(text),
        ("url-text", _) => url_text::compose(&plain_members(value).unwrap_or_default()),
        (other, _) => return Err(format!("the encoding '{other}' builds no value in this build")),
    }?;
    CelHostValue::named(url_text::URL_TYPE_KEY, Arc::new(url)).map(CelValue::Host).map_err(|refused| refused.to_string())
}

/// `membersRefusalCode`: the code a value at the slot that does not build is refused under,
/// without its `ERR_` prefix.
pub fn members_refusal_code(slot: &MembersSlot) -> Option<&str> {
    slot.entry.accepts_text.as_deref()
}

/// `membersValueRefusal`: why a value at the slot is not one of its type.
pub fn members_value_refusal(slot: &MembersSlot, value: &CelValue) -> String {
    match read_members(slot, value) {
        MembersRead::Refusal(refusal) => refusal,
        MembersRead::Value(members) => {
            bound_argument_refusal(slot, &members).unwrap_or_else(|| "it does not satisfy the slot's type arguments".into())
        }
    }
}

/// JavaScript's `String(value)` of a schema value.
fn js_text(value: &Value) -> String {
    crate::schema_error_report::js_string(value)
}

/// `boundArgumentRefusal`: the first member a bound argument refuses, described.
fn bound_argument_refusal(slot: &MembersSlot, members: &Map<String, Value>) -> Option<String> {
    for parameter in &slot.entry.parameters {
        let Some(member) = &parameter.member else { continue };
        let Some(argument) = slot.args.get(&parameter.name).and_then(Value::as_object) else { continue };
        let Some(held) = members.get(member) else { continue };
        if let Some(allowed) = argument.get("enum").and_then(Value::as_array) {
            if !allowed.iter().any(|item| strict_equal(item, held)) {
                return Some(format!("its {member} must be one of {}", allowed.iter().map(js_text).collect::<Vec<_>>().join(", ")));
            }
        }
        if let Some(constant) = argument.get("const") {
            if !strict_equal(constant, held) {
                return Some(format!("its {member} must be {}", js_text(constant)));
            }
        }
        let refuses_everything = argument.len() == 1
            && argument.get("not").and_then(Value::as_object).is_some_and(Map::is_empty);
        if refuses_everything {
            return Some(format!("it must have no {member}"));
        }
    }
    None
}

/// `===` between two JSON values: primitives by value, containers never equal.
fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(_), _) | (Value::Object(_), _) => false,
        _ => a == b,
    }
}
