//! The on-disk shape of a migration entry, and its reader. Mirrors
//! `../../../nodejs/src/migrations/entry-data.ts`.
//!
//! Reading is STRICT and closed at every level: a malformed entry is an authoring mistake,
//! and the alternative to refusing it is a migration that silently does not run — which
//! looks exactly like one that ran. Every refusal is Node's sentence.

use serde_json::{Map, Value};
use telorun_cel_value::{es_number, es_trim};

use crate::types::DiagnosticSeverity;

use super::r#match::{read_migration_match, MigrationSurface, ScalarShape};
use super::types::{
    MigrationEntry, MigrationEntryError, MigrationOperation, MigrationRule, SetValue, TagSource, MIGRATION_OPS,
};

/// How an entry file names a severity, in the order a refusal lists them.
const SEVERITIES: [(&str, DiagnosticSeverity); 4] = [
    ("error", DiagnosticSeverity::Error),
    ("warning", DiagnosticSeverity::Warning),
    ("info", DiagnosticSeverity::Information),
    ("hint", DiagnosticSeverity::Hint),
];

/// Top-level entry keys; `$comment` is the sanctioned place for author notes.
const ENTRY_KEYS: [&str; 6] = ["id", "code", "severity", "reason", "rules", "$comment"];

fn entry_error(file: &str, detail: impl std::fmt::Display) -> MigrationEntryError {
    MigrationEntryError::new(format!("Invalid migration entry '{file}': {detail}"))
}

fn require_string<'v>(file: &str, node: &'v Map<String, Value>, key: &str) -> Result<&'v str, MigrationEntryError> {
    node.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| entry_error(file, format!("'{key}' must be a non-empty string")))
}

fn operation_keys(op: &str) -> &'static [&'static str] {
    match op {
        "rename-key" => &["to"],
        "set-value" => &["value", "qualify"],
        "set-tag" => &["tag", "source"],
        "insert-item" => &["value", "at"],
        "add-key" => &["key", "value"],
        _ => &[],
    }
}

fn is_scalar(value: &Value) -> bool {
    !value.is_array() && !value.is_object()
}

fn is_literal_data(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().all(is_literal_data),
        Value::Object(map) => map.values().all(is_literal_data),
        _ => true,
    }
}

/// A value `set-value` / `insert-item` may write: a scalar, since the file applier re-quotes
/// it in the author's style at the node's own span.
fn require_scalar_value(file: &str, index: usize, op: &str, value: &Value) -> Result<(), MigrationEntryError> {
    if is_scalar(value) {
        return Ok(());
    }
    Err(entry_error(
        file,
        format!(
            "patch[{index}] ('{op}') value must be a scalar (string, number, boolean or null) — a mapping or sequence has no in-place YAML edit form, so `telo migrate` could never apply it"
        ),
    ))
}

/// What JavaScript's `String(value)` writes for a value read from JSON, `undefined` for none.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.as_f64().map(es_number).unwrap_or_default(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

fn read_operation(file: &str, raw: &Value, index: usize) -> Result<MigrationOperation, MigrationEntryError> {
    let Some(raw) = raw.as_object() else {
        return Err(entry_error(file, format!("patch[{index}] must be a mapping")));
    };
    let op = match raw.get("op").and_then(Value::as_str) {
        Some(op) if MIGRATION_OPS.contains(&op) => op,
        _ => {
            return Err(entry_error(
                file,
                format!("patch[{index}].op '{}' is not one of {}", js_string(raw.get("op")), MIGRATION_OPS.join(", ")),
            ))
        }
    };
    let allowed = operation_keys(op);
    for key in raw.keys() {
        if key != "op" && !allowed.contains(&key.as_str()) {
            return Err(entry_error(file, format!("patch[{index}] ('{op}') has no parameter '{key}'")));
        }
    }

    Ok(match op {
        "rename-key" => MigrationOperation::RenameKey { to: require_string(file, raw, "to")?.to_string() },
        "set-value" => {
            let has_value = raw.contains_key("value");
            if has_value == raw.contains_key("qualify") {
                return Err(entry_error(file, format!("patch[{index}] ('set-value') takes exactly one of 'value' or 'qualify'")));
            }
            if !has_value {
                MigrationOperation::SetValue(SetValue::Qualify(require_string(file, raw, "qualify")?.to_string()))
            } else {
                require_scalar_value(file, index, op, &raw["value"])?;
                MigrationOperation::SetValue(SetValue::Value(raw["value"].clone()))
            }
        }
        "set-tag" => {
            let tag = require_string(file, raw, "tag")?.to_string();
            let source = match raw.get("source") {
                None => TagSource::Text,
                Some(Value::String(source)) if source == "text" => TagSource::Text,
                Some(Value::String(source)) if source == "hole" => TagSource::Hole,
                Some(_) => {
                    return Err(entry_error(file, format!("patch[{index}].source must be 'text' or 'hole' when present")))
                }
            };
            MigrationOperation::SetTag { tag, source }
        }
        "insert-item" => {
            let Some(value) = raw.get("value") else {
                return Err(entry_error(file, format!("patch[{index}] ('insert-item') requires 'value'")));
            };
            require_scalar_value(file, index, op, value)?;
            let at = match raw.get("at") {
                None => None,
                Some(at) => match at.as_f64() {
                    Some(at) if at >= 0.0 && at.fract() == 0.0 => Some(at as usize),
                    _ => {
                        return Err(entry_error(file, format!("patch[{index}].at must be a non-negative integer when present")))
                    }
                },
            };
            MigrationOperation::InsertItem { value: value.clone(), at }
        }
        "add-key" => {
            let key = require_string(file, raw, "key")?.to_string();
            let Some(value) = raw.get("value") else {
                return Err(entry_error(file, format!("patch[{index}] ('add-key') requires 'value'")));
            };
            if !(is_scalar(value) || (value.is_object() && is_literal_data(value))) {
                return Err(entry_error(
                    file,
                    format!(
                        "patch[{index}] ('add-key') value must be a scalar or a mapping of plain data (mappings, sequences, strings, numbers, booleans, null)"
                    ),
                ));
            }
            MigrationOperation::AddKey { key, value: value.clone() }
        }
        _ => MigrationOperation::RemoveEntry,
    })
}

fn read_rule(file: &str, raw: &Value, index: usize, surface: MigrationSurface) -> Result<MigrationRule, MigrationEntryError> {
    let Some(raw) = raw.as_object() else {
        return Err(entry_error(file, format!("rules[{index}] must be a mapping")));
    };
    let Some(ops) = raw.get("patch").and_then(Value::as_array).filter(|ops| !ops.is_empty()) else {
        return Err(entry_error(file, format!("rules[{index}].patch must be a non-empty sequence")));
    };
    let matcher =
        read_migration_match(&format!("Invalid migration entry '{file}': rules[{index}]"), raw.get("match"), surface)?;
    let patch = ops.iter().enumerate().map(|(i, op)| read_operation(file, op, i)).collect::<Result<Vec<_>, _>>()?;
    // A hole's expression exists only where the rule matched a lone hole.
    let reads_hole = patch.iter().any(|op| matches!(op, MigrationOperation::SetTag { source: TagSource::Hole, .. }));
    if reads_hole && matcher.scalar != Some(ScalarShape::LoneHole) {
        return Err(entry_error(file, format!("rules[{index}]: 'set-tag' with 'source: hole' needs 'match.scalar: lone-hole'")));
    }
    Ok(MigrationRule { r#match: matcher, patch })
}

/// Read one entry file's parsed data. `file` names the entry file, so a failure says which.
pub fn parse_migration_entry(
    file: &str,
    data: &Value,
    surface: MigrationSurface,
) -> Result<MigrationEntry, MigrationEntryError> {
    let Some(data) = data.as_object() else {
        return Err(entry_error(file, "an entry must be a mapping"));
    };
    for key in data.keys() {
        if !ENTRY_KEYS.contains(&key.as_str()) {
            return Err(entry_error(file, format!("an entry has no key '{key}'. Known keys: {}.", ENTRY_KEYS.join(", "))));
        }
    }
    let severity_name = require_string(file, data, "severity")?;
    let Some((_, severity)) = SEVERITIES.iter().find(|(name, _)| *name == severity_name) else {
        let names: Vec<&str> = SEVERITIES.iter().map(|(name, _)| *name).collect();
        return Err(entry_error(file, format!("severity '{severity_name}' must be one of {}", names.join(", "))));
    };
    let Some(rules) = data.get("rules").and_then(Value::as_array).filter(|rules| !rules.is_empty()) else {
        return Err(entry_error(file, "'rules' must be a non-empty sequence"));
    };
    let id = require_string(file, data, "id")?.to_string();
    let code = require_string(file, data, "code")?.to_string();
    let reason = es_trim(require_string(file, data, "reason")?).to_string();
    let rules = rules
        .iter()
        .enumerate()
        .map(|(index, rule)| read_rule(file, rule, index, surface))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MigrationEntry { id, code, severity: *severity, reason, rules })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(rules: Value) -> Value {
        json!({ "id": "x", "code": "X", "severity": "warning", "reason": "r", "rules": rules })
    }

    fn refusal(data: Value) -> String {
        parse_migration_entry("bad.json", &data, MigrationSurface::Core).expect_err("refused").message
    }

    fn rule(op: Value) -> Value {
        json!([{ "match": { "key": "k", "inKind": ["Telo.Application"], "under": ["legacy"] }, "patch": [op] }])
    }

    #[test]
    fn refuses_what_the_closed_vocabulary_does_not_define_in_nodes_words() {
        assert_eq!(
            refusal(entry(rule(json!({ "op": "move", "to": "y" })))),
            "Invalid migration entry 'bad.json': patch[0].op 'move' is not one of rename-key, set-value, set-tag, insert-item, add-key, remove-entry"
        );
        assert_eq!(
            refusal(entry(rule(json!({ "op": "rename-key", "too": "y" })))),
            "Invalid migration entry 'bad.json': patch[0] ('rename-key') has no parameter 'too'"
        );
        assert_eq!(
            refusal(entry(rule(json!({ "op": "set-value", "value": 1, "qualify": "T." })))),
            "Invalid migration entry 'bad.json': patch[0] ('set-value') takes exactly one of 'value' or 'qualify'"
        );
        assert!(refusal(entry(rule(json!({ "op": "set-value", "value": { "a": 1 } })))).contains("must be a scalar"));
        let mut extra = entry(rule(json!({ "op": "remove-entry" })));
        extra["sinceVersion"] = json!("0.5.0");
        assert_eq!(
            refusal(extra),
            "Invalid migration entry 'bad.json': an entry has no key 'sinceVersion'. Known keys: id, code, severity, reason, rules, $comment."
        );
        assert_eq!(
            refusal(entry(json!([{ "patch": [{ "op": "remove-entry" }] }]))),
            "Invalid migration entry 'bad.json': rules[0]: 'match' must be a mapping"
        );
        let mut commented = entry(rule(json!({ "op": "remove-entry" })));
        commented["$comment"] = json!("why");
        assert!(parse_migration_entry("ok.json", &commented, MigrationSurface::Core).is_ok());
    }
}
