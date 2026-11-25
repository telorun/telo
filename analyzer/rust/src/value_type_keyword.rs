//! The `x-telo-type` validation keyword and how a value type's refusals read. Mirrors
//! `../../nodejs/src/value-type-keyword.ts`: the keyword's code, compiled into the
//! validator tree (`ajv_keywords`), and its message builders. The no-op `x-telo-*`
//! annotations it registers on Node are no rules here either: `ajv_keywords` knows none.

use std::sync::Arc;

use serde_json::Value;
use telorun_cel::JsonValue;
use telorun_cel_value::{duration_nanos, CelValue};
use telorun_sdk_core::plain_encoding::{cel_duration, host_members, url_text, PLAIN_ENCODINGS};
use telorun_sdk_core::value_type::{is_absolute_host_path, value_type_of, Representation, ValueType, X_TELO_TYPE};

use crate::ajv_core::Ajv;
use crate::ajv_keywords::{subschema, It, Place};
use crate::ajv_runtime::{json_of, Code};
use crate::schema_opaque_value::{is_integer, is_safe_integer, JsValue};

/// Why a relative path is refused at a host-path slot, after the path.
pub fn host_path_relative_message(entry: &ValueType) -> String {
    let name = &entry.name;
    format!(
        "must be an absolute {name} — a relative path names nothing fixed here. Write a \
         file that ships with the module as !module-path <path>, or read a location on the host \
         from a variable declared x-telo-type: {name}, which resolves a relative value \
         against the working directory"
    )
}

// The keyword's code: a twin of `valueTypeKeyword` and the parts of `@telorun/sdk`'s
// `value-type.ts` it emits (the bindings' predicates, `CEL_SCALAR_FORMS`'s uint range, the
// bounds and their words).

/// The instance representations Node's binding table names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binding {
    Bytes,
    Duration,
    Stream,
    Timestamp,
    Url,
}

impl Binding {
    fn read(name: &str) -> Option<Binding> {
        Some(match name {
            "bytes" => Binding::Bytes,
            "duration" => Binding::Duration,
            "stream" => Binding::Stream,
            "timestamp" => Binding::Timestamp,
            "url" => Binding::Url,
            _ => return None,
        })
    }

    /// `VALUE_TYPE_BINDINGS[binding].holds`. No value of the domain is a live stream.
    fn holds(self, value: &CelValue) -> bool {
        match (self, value) {
            (Binding::Bytes, CelValue::Bytes(_)) => true,
            (Binding::Duration, CelValue::Duration(_)) => true,
            (Binding::Timestamp, CelValue::Timestamp(_)) => true,
            (Binding::Url, CelValue::Host(host)) => host.type_name() == Some(url_text::URL_TYPE_KEY),
            _ => false,
        }
    }
}

/// A bound a slot states: its kind and the limit as a duration's nanoseconds.
#[derive(Clone, Debug)]
pub struct ValueTypeBound {
    kind: String,
    limit: i128,
}

/// What an `x-telo-type` keyword checks of a value.
#[derive(Clone, Debug)]
pub enum TeloTypeCheck {
    /// A host path is absolute wherever it is held.
    HostPath,
    /// An unsigned 64-bit integer, a view's exact rendering admitted beyond 2^53.
    Uint,
    Instance { binding: Binding, bounds: Vec<ValueTypeBound> },
}

impl TeloTypeCheck {
    pub fn holds(&self, data: &JsValue) -> bool {
        match self {
            TeloTypeCheck::HostPath => match data {
                JsValue::String(text) => is_absolute_host_path(text),
                _ => true,
            },
            TeloTypeCheck::Uint => match data {
                JsValue::Number(n) => {
                    if n.value < 0.0 {
                        return false;
                    }
                    is_safe_integer(n.value) || (n.marked_exact() && is_integer(n.value) && n.value <= 18_446_744_073_709_551_615f64)
                }
                _ => false,
            },
            TeloTypeCheck::Instance { binding, bounds } => {
                let held = held_value(data);
                let Some(held) = held.filter(|held| binding.holds(held)) else { return false };
                bounds.iter().all(|bound| {
                    let CelValue::Duration(duration) = held else { return true };
                    let order = duration_nanos(*duration).cmp(&bound.limit);
                    match bound.kind.as_str() {
                        "minimum" => order.is_ge(),
                        "maximum" => order.is_le(),
                        "exclusiveMinimum" => order.is_gt(),
                        "exclusiveMaximum" => order.is_lt(),
                        _ => true,
                    }
                })
            }
        }
    }
}

/// `schemaHeldValue`: the instance a stand-in holds.
fn held_value(data: &JsValue) -> Option<&CelValue> {
    match data {
        JsValue::Opaque(opaque) => Some(&opaque.held),
        _ => None,
    }
}

/// `held[member]` of a value with members, as the validator reads it, or `None` for
/// `undefined`.
pub(crate) fn held_member(data: &JsValue, member: &str) -> Option<JsValue> {
    let CelValue::Host(host) = held_value(data)? else { return None };
    let encoding = telorun_sdk_core::value_type::value_types_in_order()
        .find(|entry| entry.members.is_some() && Some(telorun_sdk_core::value_type::cel_type_of_value_type(entry)) == host.type_name())
        .and_then(|entry| entry.encoding.clone())?;
    let members = host_members(&encoding, host)?;
    let value = members.get(member)?;
    Some(js_of_json(value))
}

fn js_of_json(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::Null,
        Value::Bool(b) => JsValue::Bool(*b),
        Value::Number(n) => JsValue::number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => JsValue::string(s),
        Value::Array(items) => JsValue::Array(items.iter().map(js_of_json).collect()),
        Value::Object(map) => {
            let mut out = crate::schema_opaque_value::JsObject::new();
            for (k, v) in map {
                out.insert(k, js_of_json(v));
            }
            JsValue::Object(out)
        }
    }
}

fn plain_encoding(name: &str) -> Option<&'static telorun_sdk_core::plain_encoding::PlainEncoding> {
    PLAIN_ENCODINGS.iter().find(|encoding| encoding.name == name)
}

/// `decodeWritten` for a duration's bound: the limit as nanoseconds, or `None` when the
/// written argument does not read.
fn decoded_limit(entry: &telorun_sdk_core::value_type::ValueType, written: &JsonValue) -> Option<i128> {
    if entry.encoding.as_deref() != Some("cel-duration") {
        return None;
    }
    let text = match written {
        JsonValue::String(text) => text.clone(),
        JsonValue::Number(n) if entry.integer_unit.is_some() && is_safe_integer(*n) => {
            format!("{}{}", telorun_cel_value::es_number(*n), entry.integer_unit.as_deref().unwrap())
        }
        _ => return None,
    };
    cel_duration::decode(&text).map(|duration| duration_nanos(duration.into()))
}

fn bound_words(kind: &str) -> &'static str {
    match kind {
        "minimum" => "at least",
        "maximum" => "at most",
        "exclusiveMinimum" => "greater than",
        _ => "less than",
    }
}

/// The tags whose produced type is this value type, as the closing hint.
fn producing_tags(name: &str) -> String {
    let tags: Vec<String> = telo_templating::BUILTIN_ENGINES
        .iter()
        .filter(|engine| engine.produced_type().as_ref().and_then(value_type_of).is_some_and(|entry| entry.name == name))
        .map(|engine| format!("!{}", engine.name()))
        .collect();
    if tags.is_empty() {
        String::new()
    } else {
        format!("; embed a file with {}", tags.join(" or "))
    }
}

/// The `x-telo-type` keyword's code at `it`, or `None` where it emits none — an unknown
/// name, a `json` type JSON Schema already states, a live type outside static analysis.
pub(crate) fn compile_telo_type(ajv: &mut Ajv, it: &It, written: &Arc<JsonValue>, slots: &mut usize) -> Result<Option<Code>, String> {
    let slot = serde_json::json!({ X_TELO_TYPE: json_of(written) });
    let Some(entry) = value_type_of(&slot) else { return Ok(None) };
    let args = match &**written {
        JsonValue::Object(map) => Some(map),
        _ => None,
    };
    let params = match args {
        Some(_) => serde_json::json!({ "valueType": entry.name, "typeArguments": json_of(written) }),
        None => serde_json::json!({ "valueType": entry.name }),
    };
    let encoding = entry.encoding.as_deref().and_then(plain_encoding);
    let mut bounds = Vec::new();
    let mut bound_texts = Vec::new();
    for parameter in &entry.parameters {
        let (Some(kind), Some(argument)) = (&parameter.bound, args.and_then(|a| a.get(&parameter.name))) else { continue };
        if let Some(limit) = decoded_limit(entry, argument) {
            let duration = telorun_sdk_core::Duration::from(telorun_cel_value::CelDuration::from_total_nanos(limit).expect("a decoded duration"));
            bound_texts.push(format!("{} {}", bound_words(kind), cel_duration::encode(&duration)));
            bounds.push(ValueTypeBound { kind: kind.clone(), limit });
        }
    }
    let bound_members: Vec<(String, String)> = entry
        .parameters
        .iter()
        .filter_map(|parameter| {
            let member = parameter.member.clone()?;
            matches!(args.and_then(|a| a.get(&parameter.name)).map(|a| &**a), Some(JsonValue::Object(_))).then(|| (parameter.name.clone(), member))
        })
        .collect();
    let message = if entry.live {
        format!(
            "must be a live {} — a value written in the manifest can never be one; pass the result of a step that produces it, with a !cel expression",
            entry.name
        )
    } else if entry.from_host.is_some() {
        host_path_relative_message(entry)
    } else if let Some(members) = &entry.members {
        let constrained: Vec<String> = bound_members
            .iter()
            .map(|(parameter, member)| match args.and_then(|a| a.get(parameter)).and_then(|a| crate::ajv_keywords::get(a, "enum")).map(|e| &**e) {
                Some(JsonValue::Array(values)) => format!(
                    "its {member} one of {}",
                    values.iter().map(|v| crate::ajv_runtime::template_text(v)).collect::<Vec<_>>().join(", ")
                ),
                _ => format!("its {member} as the slot's '{parameter}' argument says"),
            })
            .collect();
        format!(
            "must be a {}{} — written as its text ({}) or as an object of its members ({})",
            entry.name,
            if constrained.is_empty() { String::new() } else { format!(", {}", constrained.join(" and ")) },
            encoding.map_or("its plain encoding", |e| e.form),
            members.keys().cloned().collect::<Vec<_>>().join(", ")
        )
    } else if entry.representation == Representation::Json && entry.cel_type.as_deref() == Some("uint") {
        format!(
            "must be a {}, an integer from 0 to 18446744073709551615; a plain number beyond 9007199254740991 is not exact, so write a wider one as a CEL uint (!cel \"18446744073709551615u\")",
            entry.name
        )
    } else {
        let named = if bound_texts.is_empty() { entry.name.clone() } else { format!("{} {}", entry.name, bound_texts.join(" and ")) };
        match encoding {
            None => format!("must be a {named}"),
            Some(encoding) => format!(
                "must be a {named} — text written in the manifest or an environment variable is read only as {}{}, and a computed value must already be one{}",
                encoding.form,
                entry.integer_unit.as_deref().map_or(String::new(), |unit| format!(", a number written in the manifest only as an integer, read as that many {unit}")),
                producing_tags(&entry.name)
            ),
        }
    };
    let check = if entry.representation == Representation::Json {
        if entry.from_host.is_some() {
            TeloTypeCheck::HostPath
        } else if entry.cel_type.as_deref() == Some("uint") {
            TeloTypeCheck::Uint
        } else {
            return Ok(None);
        }
    } else {
        if entry.live && !ajv.current_options().assert_live {
            return Ok(None);
        }
        let Some(binding) = entry.binding.as_deref().and_then(Binding::read) else { return Ok(None) };
        TeloTypeCheck::Instance { binding, bounds }
    };
    let mut members = Vec::new();
    for (parameter, member) in bound_members {
        let place = Place::at(X_TELO_TYPE).prop(&parameter).quiet();
        members.push((member, subschema(ajv, it, place, slots)?));
    }
    Ok(Some(Code::TeloType { message, params, check, members }))
}

/// `valueTypeBoundRefusal`: why `value` — a value of the type `annotation` names — lies
/// outside the bounds its arguments state (`must be a Telo.Duration greater than 0s, not
/// 0s`), or `None` when it is within them or is no value of the type.
pub(crate) fn value_type_bound_refusal(annotation: &Value, value: &CelValue) -> Option<String> {
    let entry = value_type_of(&serde_json::json!({ X_TELO_TYPE: annotation }))?;
    let binding = entry.binding.as_deref().and_then(Binding::read)?;
    if !binding.holds(value) {
        return None;
    }
    let CelValue::Duration(held) = value else { return None };
    let args = annotation.as_object()?;
    let mut missed = false;
    let mut texts = Vec::new();
    for parameter in &entry.parameters {
        let (Some(kind), Some(written)) = (&parameter.bound, args.get(&parameter.name)) else { continue };
        let Some(limit) = decoded_limit(entry, &crate::schema_validation::json_value_of(written)) else { continue };
        let duration = telorun_sdk_core::Duration::from(telorun_cel_value::CelDuration::from_total_nanos(limit).expect("a decoded duration"));
        texts.push(format!("{} {}", bound_words(kind), cel_duration::encode(&duration)));
        let order = duration_nanos(*held).cmp(&limit);
        missed |= !match kind.as_str() {
            "minimum" => order.is_ge(),
            "maximum" => order.is_le(),
            "exclusiveMinimum" => order.is_gt(),
            "exclusiveMaximum" => order.is_lt(),
            _ => true,
        };
    }
    if !missed {
        return None;
    }
    Some(format!(
        "must be a {} {}, not {}",
        entry.name,
        texts.join(" and "),
        cel_duration::encode(&telorun_sdk_core::Duration::from(*held))
    ))
}

/// `VALUE_TYPE_BINDINGS[binding].holds(value)` for a binding named as an entry names it.
pub(crate) fn binding_holds(binding: &str, value: &CelValue) -> bool {
    Binding::read(binding).is_some_and(|binding| binding.holds(value))
}
