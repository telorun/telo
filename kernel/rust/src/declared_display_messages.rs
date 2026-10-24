//! The display messages a kind declares for its codes —
//! `throws.codes.<CODE>.displayMessage` — and the one rule that attaches them to
//! a failure. Mirrors `../../nodejs/src/declared-display-messages.ts`.
//!
//! A kind's display messages are read once, when it registers: each is judged as
//! its module writes it (its syntax, its plural cases against the module's
//! `lang:`, its placeholders against the required string and number properties
//! of the code's `data` schema) and kept as the record a renderer receives. Where
//! an error leaves a dispatch, a code the kind declares with a `displayMessage`
//! gets it unless the error already carries one, its `data` held to the declared
//! schema first — a mismatch is `ERR_OUTPUT_INVALID` naming the original code. An
//! ambient code gets its built-in one (`sdk/error-codes/`).

use std::collections::BTreeMap;

use serde_json::{json, Value};
use telorun_message_format::{
    invalid_plural_categories, message_variables, parse_json, read_text, Message, MessageProblem,
};

use crate::error::KernelError;
use crate::schema_validator::SchemaValidator;

/// The language every built-in display message is written in.
const BUILTIN_LANG: &str = "en";

/// The built-in error code entries, as `sdk/error-codes/` holds them.
const BUILTIN_ENTRIES: &[&str] = &[
    include_str!("../../../sdk/error-codes/ERR_CONTRACT_UNRESOLVABLE.json"),
    include_str!("../../../sdk/error-codes/ERR_FUNCTION_FAILED.json"),
    include_str!("../../../sdk/error-codes/ERR_INPUT_INVALID.json"),
    include_str!("../../../sdk/error-codes/ERR_OUTPUT_INVALID.json"),
    include_str!("../../../sdk/error-codes/ERR_PREDICATE_NOT_BOOLEAN.json"),
    include_str!("../../../sdk/error-codes/ERR_SCHEMA_PROJECTION_UNRESOLVED.json"),
];

/// One code's declared display message.
#[derive(Clone, Debug)]
pub struct DeclaredDisplayMessage {
    /// The record: `{ text, context, lang, computed }`.
    pub record: Value,
    /// The code's declared `data` schema.
    pub data: Option<Value>,
    /// `<module>.<Name>` of the declaring kind, for messages.
    pub declarer: String,
}

fn record_of(message: &Value, lang: &str) -> Value {
    match message.as_object() {
        Some(object) if object.contains_key("text") => json!({
            "text": object.get("text").cloned().unwrap_or(Value::Null),
            "context": object.get("context").cloned().unwrap_or(Value::Null),
            "lang": lang,
            "computed": false,
        }),
        _ => json!({ "text": message, "context": null, "lang": lang, "computed": false }),
    }
}

fn selectors(message: &Message, out: &mut Vec<String>) {
    if let Message::Selection(selection) = message {
        out.push(selection.plural.clone());
        for (_, case) in &selection.cases {
            selectors(case, out);
        }
    }
}

fn first_problem(label: &str, code: &str, problems: &[MessageProblem]) -> Option<KernelError> {
    problems.first().map(|problem| {
        KernelError::new(
            format!("ERR_{}", problem.code.as_str()),
            format!("{label}: the text at 'throws.codes.{code}.displayMessage' is refused: {}.", problem.message),
        )
    })
}

/// What a required data property admits as a placeholder value: `Some(true)` a
/// number, `Some(false)` a string, `None` neither.
fn scalar_kind(schema: Option<&Value>) -> Option<bool> {
    let types: Vec<&str> = match schema.and_then(|s| s.get("type")) {
        Some(Value::String(t)) => vec![t.as_str()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        _ => return None,
    };
    if types.is_empty() {
        return None;
    }
    if types.iter().all(|t| *t == "integer" || *t == "number") {
        return Some(true);
    }
    if types.iter().all(|t| matches!(*t, "string" | "integer" | "number")) {
        return Some(false);
    }
    None
}

/// The display messages `definition` (a `Telo.Definition` document) declares,
/// judged and read as records in `lang` (`und` when the module declares none).
pub fn declared_display_messages(
    definition: &Value,
    declarer: &str,
    lang: Option<&str>,
) -> Result<BTreeMap<String, DeclaredDisplayMessage>, KernelError> {
    let mut out = BTreeMap::new();
    let Some(codes) = definition.pointer("/throws/codes").and_then(Value::as_object) else {
        return Ok(out);
    };
    let label = format!("Telo.Definition '{declarer}'");
    for (code, entry) in codes {
        let Some(message) = entry.get("displayMessage") else { continue };
        let parsed = parse_json(&message.to_string()).map_err(|err| {
            KernelError::manifest_validation_failed(format!("{label}: throws.codes.{code}.displayMessage: {err:?}"))
        })?;
        let text = match read_text(&parsed) {
            Ok(text) => text,
            Err(problems) => return Err(first_problem(&label, code, &problems).expect("a refused text has a problem")),
        };
        let mut readings = Vec::new();
        selectors(&text.message, &mut readings);
        match lang {
            Some(lang) => {
                if let Some(err) = first_problem(&label, code, &invalid_plural_categories(&text.message, lang)) {
                    return Err(err);
                }
            }
            None if !readings.is_empty() => {
                return Err(KernelError::new(
                    "ERR_MESSAGE_SOURCE_LANGUAGE_MISSING",
                    format!(
                        "{label}: the text at 'throws.codes.{code}.displayMessage' is refused: it selects a plural case, but the module that writes it declares no lang:."
                    ),
                ))
            }
            None => {}
        }
        let data = entry.get("data");
        let required: Vec<&str> = data
            .and_then(|d| d.get("required"))
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        for name in message_variables(&text.message) {
            if !required.contains(&name.as_str()) {
                return Err(KernelError::new(
                    "ERR_MESSAGE_PLACEHOLDER_UNBOUND",
                    format!(
                        "{label}: the text at 'throws.codes.{code}.displayMessage' is refused: no value is given for {name}, which the message reads, but this text is formatted with the required properties of 'throws.codes.{code}.data'."
                    ),
                ));
            }
            let property = data.and_then(|d| d.pointer(&format!("/properties/{}", name.replace('~', "~0").replace('/', "~1"))));
            match scalar_kind(property) {
                Some(number) if number || !readings.contains(&name) => {}
                _ => {
                    return Err(KernelError::new(
                        "ERR_MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED",
                        format!(
                            "{label}: the text at 'throws.codes.{code}.displayMessage.{name}' is refused: the value given for {name} is not declared {}.",
                            if readings.contains(&name) { "a number, and it selects a plural case" } else { "a string or a number" }
                        ),
                    ))
                }
            }
        }
        out.insert(
            code.clone(),
            DeclaredDisplayMessage {
                record: record_of(message, lang.unwrap_or("und")),
                data: data.cloned(),
                declarer: declarer.to_string(),
            },
        );
    }
    Ok(out)
}

/// The built-in entry of an ambient code.
fn builtin_display_message(code: &str) -> Option<DeclaredDisplayMessage> {
    BUILTIN_ENTRIES.iter().find_map(|raw| {
        let entry: Value = serde_json::from_str(raw).expect("a built-in error code entry parses");
        (entry.get("code").and_then(Value::as_str) == Some(code)).then(|| DeclaredDisplayMessage {
            record: record_of(
                entry.get("displayMessage").expect("a built-in entry declares a displayMessage"),
                BUILTIN_LANG,
            ),
            data: entry.get("data").cloned(),
            declarer: "Telo".to_string(),
        })
    })
}

/// The rule at a dispatch exit: hold the error's data to the declared schema and
/// give it its display message, unless it already carries one.
pub fn settle_display_message(
    mut err: KernelError,
    declared: &BTreeMap<String, DeclaredDisplayMessage>,
    where_: &str,
) -> KernelError {
    let Some(entry) = declared.get(&err.code).cloned().or_else(|| builtin_display_message(&err.code)) else {
        return err;
    };
    if let Some(schema) = &entry.data {
        let data = err.data.clone().unwrap_or(Value::Null);
        let issues = match SchemaValidator::compile(schema) {
            Ok(validator) => validator.errors(&data),
            Err(compile) => return compile,
        };
        if !issues.is_empty() {
            let mut refusal = KernelError::new(
                "ERR_OUTPUT_INVALID",
                format!(
                    "{where_}: the error '{}' carries data its kind does not declare (declared by {}): {}",
                    err.code,
                    entry.declarer,
                    issues.join("; ")
                ),
            );
            refusal.data = Some(json!({ "code": err.code, "data": data, "issues": issues }));
            if let Some(own) = builtin_display_message("ERR_OUTPUT_INVALID") {
                refusal.display_message = Some(own.record);
            }
            return refusal;
        }
    }
    if err.display_message.is_none() {
        err.display_message = Some(entry.record);
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(message: Value, data: Value) -> Value {
        json!({ "throws": { "codes": { "NOT_FOUND": { "description": "x", "displayMessage": message, "data": data } } } })
    }

    #[test]
    fn reads_a_declared_display_message_as_its_record() {
        let data = json!({ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } });
        let texts = declared_display_messages(&definition(json!("Item {$id} is missing."), data), "Lib.Lookup", Some("en"))
            .expect("the text reads");
        assert_eq!(
            texts["NOT_FOUND"].record,
            json!({ "text": "Item {$id} is missing.", "context": null, "lang": "en", "computed": false })
        );
    }

    #[test]
    fn refuses_a_placeholder_the_data_may_lack() {
        let data = json!({ "type": "object", "properties": { "id": { "type": "string" } } });
        let err = declared_display_messages(&definition(json!("Item {$id} is missing."), data), "Lib.Lookup", Some("en"))
            .expect_err("an optional property is no value");
        assert_eq!(err.code, "ERR_MESSAGE_PLACEHOLDER_UNBOUND");
    }

    #[test]
    fn refuses_a_placeholder_of_no_declared_type() {
        let data = json!({ "type": "object", "required": ["id"], "properties": { "id": {} } });
        let err = declared_display_messages(&definition(json!("Item {$id} is missing."), data), "Lib.Lookup", Some("en"))
            .expect_err("an untyped property is no value");
        assert_eq!(err.code, "ERR_MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED");
    }

    #[test]
    fn attaches_a_display_message_and_keeps_one_already_attached() {
        let data = json!({ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } });
        let texts = declared_display_messages(&definition(json!("Item {$id} is missing."), data), "Lib.Lookup", Some("en")).unwrap();
        let mut err = KernelError::new("NOT_FOUND", "missing");
        err.data = Some(json!({ "id": "42" }));
        let settled = settle_display_message(err, &texts, "Lib.Lookup 'lookup'");
        assert_eq!(settled.display_message.as_ref().unwrap()["text"], json!("Item {$id} is missing."));

        let mut inner = KernelError::new("NOT_FOUND", "missing");
        inner.data = Some(json!({ "id": "42" }));
        inner.display_message = Some(json!({ "text": "Inner.", "context": null, "lang": "en", "computed": false }));
        let kept = settle_display_message(inner, &texts, "Lib.Lookup 'lookup'");
        assert_eq!(kept.display_message.unwrap()["text"], json!("Inner."));
    }

    #[test]
    fn refuses_data_the_kind_does_not_declare() {
        let data = json!({ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } });
        let texts = declared_display_messages(&definition(json!("Item {$id} is missing."), data), "Lib.Lookup", Some("en")).unwrap();
        let settled = settle_display_message(KernelError::new("NOT_FOUND", "missing"), &texts, "Lib.Lookup 'lookup'");
        assert_eq!(settled.code, "ERR_OUTPUT_INVALID");
        assert_eq!(settled.data.unwrap()["code"], json!("NOT_FOUND"));
    }

    #[test]
    fn embeds_every_built_in_error_code_entry() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sdk/error-codes");
        let files = std::fs::read_dir(dir)
            .expect("sdk/error-codes is readable")
            .filter(|entry| entry.as_ref().expect("an entry").path().extension().is_some_and(|ext| ext == "json"))
            .count();
        assert_eq!(files, BUILTIN_ENTRIES.len(), "sdk/error-codes holds an entry this kernel does not embed");
    }

    #[test]
    fn attaches_the_built_in_display_message_of_an_ambient_code() {
        let settled = settle_display_message(KernelError::input_invalid("bad"), &BTreeMap::new(), "x");
        assert_eq!(settled.display_message.unwrap()["lang"], json!("en"));
    }
}
