//! The one renderer for schema validation failures. Mirrors
//! `../../nodejs/src/schema-error-report.ts`: own prose for `additionalProperties`,
//! `required`, `enum`, `type`, a `false` schema and `not`, the validator's own message for
//! every other keyword, a Telo format's reason from its checker, and a value type's from
//! its bounds or its members — so a failure is phrased identically by `telo check` and by
//! the kernel. It renders findings the judge (`schema_findings_judge`) already decided and
//! decides nothing itself.

use std::collections::HashSet;

use serde_json::Value;
use telorun_cel_value::{es_number, CelValue};
use telorun_sdk_core::value_type::{value_types, X_TELO_TYPE};

use crate::ajv_runtime::SchemaError;
use crate::members_value_slot::{members_slot_of, members_value_refusal};
use crate::nearest_name::nearest_names;
use crate::schema_opaque_value::JsValue;
use crate::schema_pattern::schema_pattern_refusal;
use crate::telo_format::{describe_failure, format_failure, is_telo_format};
use crate::value_type_keyword::value_type_bound_refusal;

/// The most allowed values an enum refusal lists; past it the message says how many there
/// are and names the nearest instead.
pub const LISTED_ENUM_VALUES: usize = 20;

/// The most nearest values one refusal names.
const SUGGESTED_ENUM_VALUES: usize = 5;

/// A schema validation issue with a dotted-path pointer to the offending field.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SchemaIssue {
    pub message: String,
    /// Dotted path to the field (`config.handler`); empty means the root.
    pub path: String,
    /// The same place as a JSON Pointer, lossless where the dotted path is not.
    pub pointer: Option<String>,
    /// The keyword that produced it.
    pub keyword: Option<String>,
    /// For `required`, the property that is missing.
    pub missing_property: Option<String>,
    /// For `additionalProperties`, the property that is not allowed.
    pub additional_property: Option<String>,
    /// For `x-telo-type`, the value type the value failed.
    pub value_type: Option<String>,
    /// The message after the pointer it opens with.
    pub prose: Option<String>,
    /// How many trailing keys of `path` lie beneath the place the message quotes.
    pub quote_trail: Option<usize>,
}

/// JavaScript's `String(value)` of a JSON value.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Array(items) => join_text(items, ","),
        other => element_text(other),
    }
}

/// `Array.prototype.join`'s text of one element: `null` as nothing.
fn element_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => es_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => join_text(items, ","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `items.join(separator)`.
pub(crate) fn join_text(items: &[Value], separator: &str) -> String {
    items.iter().map(element_text).collect::<Vec<_>>().join(separator)
}

/// `JSON.stringify(value)`, `undefined` for an absent one as a template prints it.
pub(crate) fn json_stringify(value: Option<&Value>) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Number(n) => {
                let number = n.as_f64().unwrap_or(f64::NAN);
                out.push_str(&if number.is_finite() { es_number(number) } else { "null".into() });
            }
            Value::String(s) => out.push_str(&serde_json::to_string(s).expect("a string serializes")),
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            Value::Object(map) => {
                out.push('{');
                for (i, (key, item)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).expect("a key serializes"));
                    out.push(':');
                    write(item, out);
                }
                out.push('}');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let Some(value) = value else { return "undefined".into() };
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// RFC 6901 unescaping of one segment, `~0` expanded last.
pub(crate) fn unescape_segment(part: &str) -> String {
    part.replace("~1", "/").replace("~0", "~")
}

fn unescape_pointer(pointer: &str) -> String {
    pointer
        .split('/')
        .enumerate()
        .map(|(i, segment)| if i == 0 { segment.to_string() } else { unescape_segment(segment) })
        .collect::<Vec<_>>()
        .join("/")
}

/// A finding as it is rendered: the validator's error, its message explained, and — for an
/// `enum` refusal — the text it refused when that text is in hand.
#[derive(Clone, Debug)]
struct Rendered {
    error: SchemaError,
    refused: Option<String>,
}

fn param<'a>(error: &'a SchemaError, name: &str) -> Option<&'a Value> {
    error.params.get(name)
}

/// `formatSingleError`: the place, unescaped, then what is wrong there.
pub fn format_single_error(error: &SchemaError) -> String {
    let refused = error.data.as_ref().and_then(|data| match data {
        JsValue::String(text) => Some(text.to_string()),
        _ => None,
    });
    single(&Rendered { error: error.clone(), refused })
}

fn single(rendered: &Rendered) -> String {
    let place = unescape_pointer(&rendered.error.instance_path);
    format!("{} {}", if place.is_empty() { "/" } else { place.as_str() }, error_prose(rendered))
}

fn error_prose(rendered: &Rendered) -> String {
    let error = &rendered.error;
    match error.keyword.as_str() {
        "additionalProperties" => format!(
            "must NOT have additional properties ('{}' is not allowed)",
            param(error, "additionalProperty").map_or("undefined".into(), js_string)
        ),
        "required" => format!(
            "is missing required property '{}'",
            param(error, "missingProperty").map_or("undefined".into(), js_string)
        ),
        "enum" => {
            let allowed: &[Value] = param(error, "allowedValues").and_then(Value::as_array).map_or(&[], Vec::as_slice);
            if allowed.len() <= LISTED_ENUM_VALUES {
                format!("{} ({})", error.message, join_text(allowed, " | "))
            } else {
                format!("must be one of {} allowed values{}", allowed.len(), suggested_values(rendered.refused.as_deref(), allowed))
            }
        }
        "type" => format!(
            "must be {}{}",
            param(error, "type").map_or("undefined".into(), js_string),
            describe_actual(error)
        ),
        "false schema" => "is not allowed here".into(),
        "not" => "matches a shape that is not allowed here".into(),
        _ => error.message.clone(),
    }
}

/// `; did you mean 'house'?` — the allowed strings nearest the refused one.
fn suggested_values(value: Option<&str>, allowed: &[Value]) -> String {
    let Some(value) = value else { return String::new() };
    let near: Vec<&str> = nearest_names(value, allowed.iter().filter_map(Value::as_str)).into_iter().take(SUGGESTED_ENUM_VALUES).collect();
    if near.is_empty() {
        return String::new();
    }
    format!("; did you mean {}?", near.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(" or "))
}

/// ` (got string)`, or nothing when the value is not in hand (a configuration that is not
/// verbose).
fn describe_actual(error: &SchemaError) -> String {
    let Some(data) = &error.data else { return String::new() };
    let kind = match data {
        JsValue::Null => "null",
        JsValue::Array(_) => "array",
        JsValue::Undefined => "undefined",
        JsValue::Bool(_) => "boolean",
        JsValue::Number(_) => "number",
        JsValue::String(_) => "string",
        JsValue::Object(_) | JsValue::Opaque(_) => "object",
        JsValue::Function(_) => "function",
    };
    format!(" (got {kind})")
}

/// `ajvErrorToPath`: an instance path as the dotted path a position index keys on, a
/// `required` finding's missing property appended.
pub fn error_path(error: &SchemaError) -> String {
    let mut result = String::new();
    for part in error.instance_path.split('/').filter(|p| !p.is_empty()) {
        if part.bytes().all(|b| b.is_ascii_digit()) {
            result.push_str(&format!("[{part}]"));
        } else if result.is_empty() {
            result.push_str(&unescape_segment(part));
        } else {
            result.push_str(&format!(".{}", unescape_segment(part)));
        }
    }
    if error.keyword == "required" {
        if let Some(missing) = missing_property(error) {
            if result.is_empty() {
                result = missing;
            } else {
                result.push_str(&format!(".{missing}"));
            }
        }
    }
    result
}

/// A `missingProperty` JavaScript reads as truthy.
fn missing_property(error: &SchemaError) -> Option<String> {
    match param(error, "missingProperty")? {
        Value::Null | Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        other => Some(js_string(other)),
    }
}

fn error_pointer(error: &SchemaError) -> String {
    match (error.keyword.as_str(), param(error, "missingProperty")) {
        ("required", Some(Value::String(missing))) => {
            format!("{}/{}", error.instance_path, missing.replace('~', "~0").replace('/', "~1"))
        }
        _ => error.instance_path.clone(),
    }
}

/// The value at a JSON Pointer under `root`, read as a plain object reads it.
pub(crate) fn value_at<'v>(root: &'v CelValue, pointer: &str) -> Option<&'v CelValue> {
    let mut current = root;
    for segment in pointer.split('/').skip(1) {
        let key = unescape_segment(segment);
        current = match current {
            CelValue::Record(record) => record.get(&key)?,
            CelValue::List(items) => {
                let index: usize = key.parse().ok().filter(|i: &usize| i.to_string() == key)?;
                items.get(index)?
            }
            CelValue::Map(map) => map.iter().find(|(k, _)| matches!(k, CelValue::String(s) if **s == *key)).map(|(_, v)| v)?,
            _ => return None,
        };
    }
    Some(current)
}

/// `explainFormatErrors` then `explainValueTypeErrors`, then `withEnumValues`.
fn rendered_errors(findings: &[SchemaError], data: Option<&CelValue>) -> Vec<Rendered> {
    let explained: Vec<SchemaError> = findings
        .iter()
        .enumerate()
        .map(|(at, error)| {
            let mut error = error.clone();
            if is_regex_format(&error) {
                explain_pattern(&mut error, data, &findings[at + 1..]);
            } else if let Some(data) = data {
                explain_format(&mut error, data);
            }
            if let Some(data) = data {
                explain_value_type(&mut error, data);
            }
            error
        })
        .collect();
    explained
        .iter()
        .filter(|error| !restates_explained_key(error, &explained))
        .cloned()
        .map(|error| {
            let refused = match &error.data {
                Some(JsValue::String(text)) => Some(text.to_string()),
                Some(_) => None,
                None if error.keyword == "enum" => data.and_then(|data| match value_at(data, &error.instance_path) {
                    Some(CelValue::String(text)) => Some(text.to_string()),
                    _ => None,
                }),
                None => None,
            };
            Rendered { error, refused }
        })
        .collect()
}

fn is_regex_format(error: &SchemaError) -> bool {
    error.keyword == "format" && param(error, "format").and_then(Value::as_str) == Some("regex")
}

/// `format: regex` explained by the schema pattern seam: why RE2 refuses the pattern. A
/// `patternProperties` key is the finding's property name; a pattern value is read from the
/// validated root. `later` holds the findings recorded after this one.
fn explain_pattern(error: &mut SchemaError, data: Option<&CelValue>, later: &[SchemaError]) {
    let pattern = error.property_name.clone().or_else(|| key_of(error, later)).or_else(|| {
        match data.and_then(|data| value_at(data, &error.instance_path)) {
            Some(CelValue::String(text)) => Some(text.to_string()),
            _ => None,
        }
    });
    if let Some(refusal) = pattern.and_then(|pattern| schema_pattern_refusal(&pattern, "")) {
        error.message = refusal;
    }
}

/// The property name a `propertyNames` finding after `error` names, for a finding raised
/// under it that does not carry the name itself.
fn key_of(error: &SchemaError, later: &[SchemaError]) -> Option<String> {
    let companion = later.iter().find(|other| is_companion(other, error))?;
    param(companion, "propertyName").and_then(Value::as_str).map(str::to_string)
}

/// Whether `outer` is the `propertyNames` finding `inner` was raised beneath.
fn is_companion(outer: &SchemaError, inner: &SchemaError) -> bool {
    !std::ptr::eq(outer, inner)
        && outer.keyword == "propertyNames"
        && outer.instance_path == inner.instance_path
        && inner.schema_path.starts_with(&format!("{}/", outer.schema_path))
}

/// A `propertyNames` finding whose name an explained pattern finding beneath it already
/// reports at the same place.
fn restates_explained_key(error: &SchemaError, all: &[SchemaError]) -> bool {
    if error.keyword != "propertyNames" {
        return false;
    }
    let Some(name) = param(error, "propertyName").and_then(Value::as_str) else { return false };
    let refusal = schema_pattern_refusal(name, "");
    all.iter().any(|other| {
        is_companion(error, other) && is_regex_format(other) && refusal.as_deref() == Some(other.message.as_str())
    })
}

/// A Telo format's failure, worded by its checker.
fn explain_format(error: &mut SchemaError, data: &CelValue) {
    if error.keyword != "format" {
        return;
    }
    let Some(name) = param(error, "format").and_then(Value::as_str).map(str::to_string) else { return };
    if !is_telo_format(&name) {
        return;
    }
    let Some(CelValue::String(value)) = value_at(data, &error.instance_path) else { return };
    if let Some(failure) = format_failure(&name, value) {
        error.message = describe_failure(&name, value, &failure);
    }
}

/// A value type's refusal, worded by its bounds or its members.
fn explain_value_type(error: &mut SchemaError, data: &CelValue) {
    if error.keyword != X_TELO_TYPE {
        return;
    }
    let Some(annotation) = param(error, "typeArguments").or_else(|| param(error, "valueType")).cloned() else { return };
    let value = value_at(data, &error.instance_path);
    if let Some(value) = value {
        if let Some(out_of_bounds) = value_type_bound_refusal(&annotation, value) {
            error.message = out_of_bounds;
            return;
        }
    }
    let Some(slot) = members_slot_of(&serde_json::json!({ X_TELO_TYPE: annotation })) else { return };
    let refusal = members_value_refusal(&slot, value.unwrap_or(&CelValue::Null));
    let refusal = if value.is_none() {
        format!("it is an undefined, where {} is written as text or as an object of its members", slot.entry.name)
    } else {
        refusal
    };
    error.message = format!("is not a {}: {refusal}", slot.entry.name);
}

/// `valueTypeRefusalCode`: the code a value type's own refusal reports under
/// (`URL_INVALID`), or `None` for every other finding.
pub fn value_type_refusal_code(issue: &SchemaIssue) -> Option<String> {
    if issue.keyword.as_deref() != Some(X_TELO_TYPE) {
        return None;
    }
    let name = issue.value_type.as_deref()?;
    value_types().get(name)?.accepts_text.clone()
}

/// `schemaIssues`: path-anchored issues over judged findings, one per place and message.
pub fn schema_issues(findings: &[SchemaError], data: Option<&CelValue>) -> Vec<SchemaIssue> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for rendered in rendered_errors(findings, data) {
        let error = &rendered.error;
        let prose = error_prose(&rendered);
        let value_type = param(error, "valueType").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        let issue = SchemaIssue {
            message: single(&rendered),
            path: error_path(error),
            pointer: Some(error_pointer(error)),
            prose: Some(prose),
            quote_trail: Some(if error.keyword == "required" && missing_property(error).is_some() { 1 } else { 0 }),
            keyword: (!error.keyword.is_empty()).then(|| error.keyword.clone()),
            missing_property: param(error, "missingProperty").and_then(Value::as_str).map(str::to_string),
            additional_property: (error.keyword == "additionalProperties")
                .then(|| param(error, "additionalProperty").and_then(Value::as_str).map(str::to_string))
                .flatten(),
            value_type,
        };
        if seen.insert(format!("{}\u{0}{}", issue.path, issue.message)) {
            out.push(issue);
        }
    }
    out
}

/// `formatAjvErrors`: judged findings rendered as one sentence.
pub fn format_schema_errors(findings: &[SchemaError], data: Option<&CelValue>) -> String {
    let rendered = rendered_errors(findings, data);
    if rendered.is_empty() {
        return "Unknown schema error".into();
    }
    let mut seen = HashSet::new();
    rendered.iter().map(single).filter(|text| seen.insert(text.clone())).collect::<Vec<_>>().join("; ")
}
