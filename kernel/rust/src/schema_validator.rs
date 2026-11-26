//! JSON Schema compilation and validation through the analyzer's validator twin.
//! Mirrors `../../nodejs/src/schema-validator.ts`: a schema is compiled on a `primary`
//! instance (the first error, defaults filled, a value type's decoded first); a refusal is
//! judged on a `locating` twin, its defaults filled by a `filling` instance first, so its
//! unions read as `telo check` reports them; and the refusal is phrased by the one
//! renderer. Node's on-disk validator cache, its BigInt view and the hoisted fragments of
//! named shapes have no counterpart: this kernel compiles in process, its view renders an
//! int64 as Node's does, and it registers no named shape.
//!
//! A validation that could not finish is a [`SchemaRefusal`] with no issues, never read as a
//! verdict: creation raises `ERR_SCHEMA_NESTING_EXCEEDED`, a members value's build passes it up
//! as its error, and a dispatch's contract refuses it under its direction's code with no issues.

use std::cell::RefCell;
use std::sync::Arc;

use serde_json::{Map, Value};
use telo_analyzer::ajv_runtime::SchemaError;
use telo_analyzer::schema_error_report::{format_schema_errors, schema_issues, SchemaIssue};
use telo_analyzer::schema_findings_judge::{judge_schema_findings, SchemaJudgment};
use telo_analyzer::schema_node_validator::{NodeValidatorOptions, SchemaNodeValidator};
use telo_analyzer::schema_tag_text::schema_with_tags_as_text;
use telo_analyzer::schema_validation::{
    cel_value_of, check_value_depth, json_value_of, CompiledSchema, SchemaValidation, SchemaValidationConfiguration,
};
use telo_analyzer::stand_in_findings::StandIns;
use telo_analyzer::value_type_defaults::decode_plain_literal;
use telorun_cel::JsonValue;
use telorun_cel_value::{es_number, CelList, CelRecord, CelValue};
use telorun_sdk_core::plain_encoding::{base64url, cel_duration, host_text, rfc3339};
use telorun_sdk_core::value_type::{holds_sensitive_member, value_types, X_TELO_TYPE};

/// What a redacted value is written as.
const REDACTED: &str = "[redacted]";

/// A value its schema refuses: the sentence, and the path-anchored issues it was
/// rendered from — `None` when the validation could not finish (the value nests past the
/// shared limit, or the engine's bound was reached), the sentence then being the error.
#[derive(Debug, Clone)]
pub struct SchemaRefusal {
    pub message: String,
    pub issues: Option<Vec<SchemaIssue>>,
}

impl SchemaRefusal {
    fn unfinished(message: String) -> Self {
        Self { message, issues: None }
    }
}

pub struct SchemaValidator {
    host: SchemaValidation,
    canonical_json: Value,
    canonical: Arc<JsonValue>,
    primary: CompiledSchema,
}

/// Annotations that emit validation code, kept by the strip.
const VALIDATING_ANNOTATIONS: [&str; 1] = [X_TELO_TYPE];
const NAME_KEYED_SCHEMA_KEYWORDS: [&str; 6] = ["properties", "patternProperties", "dependentSchemas", "dependentRequired", "$defs", "definitions"];
const DATA_VALUE_KEYWORDS: [&str; 4] = ["const", "default", "enum", "examples"];

/// `stripTeloAnnotations`: a copy without the `x-telo-*` annotations that emit no code.
fn strip_telo_annotations(value: &Value, name_keyed: bool) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| strip_telo_annotations(item, false)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if !name_keyed && key.starts_with("x-telo-") && !VALIDATING_ANNOTATIONS.contains(&key.as_str()) {
                    continue;
                }
                let kept = if !name_keyed && DATA_VALUE_KEYWORDS.contains(&key.as_str()) {
                    item.clone()
                } else {
                    strip_telo_annotations(item, !name_keyed && NAME_KEYED_SCHEMA_KEYWORDS.contains(&key.as_str()))
                };
                out.insert(key.clone(), kept);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `canonicalSchema`: a bare property map widened to an object schema, the implicit
/// `kind` / `metadata` admitted beside a closed one, annotations stripped and tagged
/// carriers read as text.
pub fn canonical_schema(schema: &Value) -> Value {
    let full = schema.get("type").is_some_and(Value::is_string)
        || ["allOf", "anyOf", "oneOf", "$ref", X_TELO_TYPE].iter().any(|key| schema.get(*key).is_some());
    let normalized = if full || !schema.is_object() {
        schema.clone()
    } else {
        let keys: Vec<Value> = schema.as_object().into_iter().flat_map(|m| m.keys()).map(|k| Value::String(k.clone())).collect();
        serde_json::json!({ "type": "object", "properties": schema, "required": keys, "additionalProperties": false })
    };
    let with_implicit = match normalized.as_object() {
        Some(object) if object.get("additionalProperties") == Some(&Value::Bool(false)) => {
            let mut properties = Map::new();
            properties.insert("kind".into(), serde_json::json!({ "type": "string" }));
            properties.insert("metadata".into(), serde_json::json!({ "type": "object" }));
            if let Some(declared) = object.get("properties").and_then(Value::as_object) {
                for (key, value) in declared {
                    properties.insert(key.clone(), value.clone());
                }
            }
            let mut out = object.clone();
            out.insert("properties".into(), Value::Object(properties));
            Value::Object(out)
        }
        _ => normalized,
    };
    schema_with_tags_as_text(&strip_telo_annotations(&with_implicit, false))
}

/// A value as the JSON a controller reads: an integral double as JavaScript writes one,
/// an instance value as its plain text.
pub fn json_of_cel(value: &CelValue) -> Value {
    match value {
        CelValue::Null => Value::Null,
        CelValue::Bool(b) => Value::Bool(*b),
        CelValue::Int(i) => Value::from(*i),
        CelValue::Uint(u) => Value::from(*u),
        CelValue::Double(d) if d.is_finite() && d.trunc() == *d && d.abs() <= 9_007_199_254_740_991.0 => Value::from(*d as i64),
        CelValue::Double(d) => serde_json::Number::from_f64(*d).map_or(Value::Null, Value::Number),
        CelValue::String(s) => Value::String(s.to_string()),
        CelValue::List(items) => Value::Array(items.iter().map(json_of_cel).collect()),
        CelValue::Record(record) => Value::Object(record.iter().map(|(k, v)| (k.to_string(), json_of_cel(v))).collect()),
        CelValue::Map(map) => Value::Object(
            map.iter()
                .filter_map(|(k, v)| match k {
                    CelValue::String(k) => Some((k.to_string(), json_of_cel(v))),
                    _ => None,
                })
                .collect(),
        ),
        other => instance_text(other).map_or(Value::Null, Value::String),
    }
}

/// An instance value's plain text.
fn instance_text(value: &CelValue) -> Option<String> {
    Some(match value {
        CelValue::Bytes(bytes) => base64url::encode(bytes),
        CelValue::Timestamp(timestamp) => rfc3339::encode(&(*timestamp).into()),
        CelValue::Duration(duration) => cel_duration::encode(&(*duration).into()),
        CelValue::Host(host) => {
            let entry = host.type_name().and_then(|name| value_types().get(name))?;
            host_text(entry.encoding.as_deref()?, host)?
        }
        _ => return None,
    })
}

/// `describeValue`: a value for a refusal's message — an instance value in its type's plain
/// encoding, one holding a member its type declares sensitive written as the censor, an
/// object's members in ECMAScript's own-property order. Written without recursion, so no
/// depth of nesting exhausts the stack.
pub fn describe_value(value: &CelValue) -> String {
    enum Step<'v> {
        Write(&'v CelValue),
        Text(String),
    }
    fn quoted(text: &str) -> String {
        serde_json::to_string(text).expect("a string serializes")
    }
    let mut out = String::new();
    let mut work = vec![Step::Write(value)];
    while let Some(step) = work.pop() {
        let value = match step {
            Step::Text(text) => {
                out.push_str(&text);
                continue;
            }
            Step::Write(value) => value,
        };
        let entries: Option<Vec<(String, &CelValue)>> = match value {
            CelValue::Record(record) => Some(record.iter().map(|(k, v)| (k.to_string(), v)).collect()),
            CelValue::Map(map) => Some(
                map.iter()
                    .filter_map(|(k, v)| match k {
                        CelValue::String(k) => Some((k.to_string(), v)),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        };
        if let Some(mut entries) = entries {
            order_own_properties(&mut entries);
            out.push('{');
            work.push(Step::Text("}".into()));
            for (i, (key, item)) in entries.into_iter().enumerate().rev() {
                work.push(Step::Write(item));
                work.push(Step::Text(format!("{}{}:", if i > 0 { "," } else { "" }, quoted(&key))));
            }
            continue;
        }
        match value {
            CelValue::Null => out.push_str("null"),
            CelValue::Bool(b) => out.push_str(&b.to_string()),
            CelValue::Int(i) => out.push_str(&i.to_string()),
            CelValue::Uint(u) => out.push_str(&u.to_string()),
            CelValue::Double(d) => out.push_str(&if d.is_finite() { es_number(*d) } else { "null".into() }),
            CelValue::String(s) => out.push_str(&quoted(s)),
            CelValue::List(items) => {
                out.push('[');
                work.push(Step::Text("]".into()));
                for (i, item) in items.iter().enumerate().rev() {
                    work.push(Step::Write(item));
                    if i > 0 {
                        work.push(Step::Text(",".into()));
                    }
                }
            }
            other if holds_sensitive_member(other) => out.push_str(&quoted(REDACTED)),
            other => match instance_text(other) {
                Some(text) => out.push_str(&quoted(&text)),
                None => out.push_str("null"),
            },
        }
    }
    out
}

/// ECMAScript's own-property order: canonical array indices first, ascending.
fn order_own_properties(entries: &mut [(String, &CelValue)]) {
    let index = |key: &str| -> Option<u32> {
        if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        key.parse::<u64>().ok().filter(|v| *v < u32::MAX as u64).map(|v| v as u32)
    };
    entries.sort_by(|a, b| match (index(&a.0), index(&b.0)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

impl SchemaValidator {
    /// Compile `schema` in its canonical form; the refusal is the validator's message.
    pub fn compile(schema: &Value) -> Result<Self, String> {
        let mut host = SchemaValidation::new(SchemaValidationConfiguration::Primary);
        let canonical_json = canonical_schema(schema);
        let canonical = json_value_of(&canonical_json);
        let primary = host.compile_json(canonical.clone())?;
        Ok(Self { host, canonical_json, canonical, primary })
    }

    /// `value` read as it is validated: every literal at an instance slot decoded.
    pub fn decoded(&self, value: &Value) -> CelValue {
        let decoded = decode_plain_literal(value, &self.canonical_json);
        merge_integers(value, decoded)
    }

    /// The schema as it was compiled, which a walk over the value reads.
    pub fn canonical_schema(&self) -> &Value {
        &self.canonical_json
    }

    /// Validate `data`: the value with its defaults filled, or the refusal. A value nested past
    /// the shared limit is refused unvalidated, whatever the engine could follow.
    pub fn check(&self, data: &CelValue) -> Result<CelValue, SchemaRefusal> {
        check_value_depth(data).map_err(SchemaRefusal::unfinished)?;
        let validation = self.primary.validate(data).map_err(SchemaRefusal::unfinished)?;
        if validation.valid {
            return Ok(validation.value);
        }
        Err(self.refusal(&validation.errors, validation.value).unwrap_or_else(SchemaRefusal::unfinished))
    }

    /// The refusal of `findings`, each union decided by the judge — or why judging could
    /// not finish.
    fn refusal(&self, findings: &[SchemaError], value: CelValue) -> Result<SchemaRefusal, String> {
        let mut filling = SchemaValidation::new(SchemaValidationConfiguration::Filling);
        let fill = filling.compile_json(self.canonical.clone())?;
        let twin = RefCell::new(SchemaNodeValidator::new(
            SchemaValidation::new(SchemaValidationConfiguration::Locating),
            NodeValidatorOptions {
                resolve_reference: Box::new(|id| self.host.registered_document(id)),
                canonical: None,
                fill_defaults: Some(Box::new(move |_, value| fill.validate(value).map(|filled| filled.value))),
            },
        ));
        let validate = |node: &Arc<JsonValue>, value: &mut CelValue| twin.borrow_mut().findings(&self.canonical, node, value);
        let reference = |node: &Arc<JsonValue>, reference: &str| twin.borrow_mut().reference(node, reference);
        let mut judgment =
            SchemaJudgment { value, schema: self.canonical.clone(), stand_ins: StandIns::new(), validate: &validate, reference: &reference };
        let judged = judge_schema_findings(findings, &mut judgment)?;
        let data = judgment.value;
        Ok(SchemaRefusal {
            message: format!("Invalid value passed: {}. Error: {}", describe_value(&data), format_schema_errors(&judged, Some(&data))),
            issues: Some(schema_issues(&judged, Some(&data))),
        })
    }
}

/// `decoded` with every integer the JSON held kept an integer: the decoding walk reads a
/// number as JavaScript does, a double.
fn merge_integers(written: &Value, decoded: CelValue) -> CelValue {
    match (written, decoded) {
        (Value::Number(n), CelValue::Double(_)) => cel_value_of(&Value::Number(n.clone())),
        (Value::Array(items), CelValue::List(list)) => {
            CelValue::List(items.iter().zip(list.iter().cloned()).map(|(w, d)| merge_integers(w, d)).collect::<CelList>())
        }
        (Value::Object(map), CelValue::Record(record)) => {
            let mut out = CelRecord::new();
            for (key, item) in record.iter() {
                let merged = match map.get(&*key) {
                    Some(written) => merge_integers(written, item.clone()),
                    None => item.clone(),
                };
                out.insert(key, merged);
            }
            CelValue::Record(out)
        }
        (_, decoded) => decoded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_value_nested_past_any_stack() {
        let mut value = CelValue::Null;
        for _ in 0..200_000 {
            value = CelValue::List(vec![value].into());
        }
        let described = describe_value(&value);
        assert_eq!(described.len(), 2 * 200_000 + 4);
        assert_eq!(&described[199_997..200_007], "[[[null]]]");
    }
}
