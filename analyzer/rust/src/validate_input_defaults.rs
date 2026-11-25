//! A module input's `default:` checked against the input's own declaration — the static
//! twin of the kernel's resolution, which refuses the whole application at boot when the
//! default it falls back to does not fit. Mirrors `../../nodejs/src/validate-input-defaults.ts`.
//!
//! A default is read the way the kernel reads it: decoded through each instance type's
//! plain encoding — an Application binding's default against the residual schema, a
//! Library's against the rest of its entry — with a host path standing as the anchor it is
//! resolved against. Entry-module-scoped: a dependency's inputs are its author's to fix.

use std::collections::HashSet;

use serde_json::Value;
use telo_templating::is_tagged_sentinel;

use crate::host_path_slot::host_anchor_for;
use crate::plain_literal_decoding::walk_text_leaves;
use crate::residual_schema::residual_entry_schema;
use crate::schema_error_report::value_type_refusal_code;
use crate::schema_validation::{schema_nesting_exceeded_message, validate_against_schema, SCHEMA_NESTING_EXCEEDED};
use crate::types::{AnalysisDiagnostic, DiagnosticData, DiagnosticResource};
use crate::validate_requires::SourcedDocument;
use crate::value_type_defaults::decode_plain_literal;

const APPLICATION: &str = "Telo.Application";
const LIBRARY: &str = "Telo.Library";

/// Stands in for a host path, which is anchored rather than refused here.
const ANCHORED: &str = "/";

fn holds_tag(value: &Value) -> bool {
    if is_tagged_sentinel(value) {
        return true;
    }
    match value {
        Value::Array(items) => items.iter().any(holds_tag),
        Value::Object(map) => map.values().any(holds_tag),
        _ => false,
    }
}

/// `fallback` with every text at a host-path slot replaced by the anchor.
fn anchored(fallback: &Value, schema: &Value) -> Value {
    let mut pointers = Vec::new();
    walk_text_leaves::<()>(
        fallback,
        schema,
        &mut |slot, text, pointer| {
            if host_anchor_for(slot, text).is_some() {
                pointers.push(pointer.to_string());
            }
            Ok(())
        },
        None,
    )
    .expect("the walk raises nothing");
    let mut out = fallback.clone();
    for pointer in pointers {
        if let Some(leaf) = out.pointer_mut(&pointer) {
            *leaf = Value::String(ANCHORED.into());
        }
    }
    out
}

pub fn validate_input_defaults(documents: &[SourcedDocument], root_modules: &HashSet<String>) -> Vec<AnalysisDiagnostic> {
    let mut out = Vec::new();
    for document in documents {
        let manifest = document.manifest;
        let Some(kind) = manifest.get("kind").and_then(Value::as_str).filter(|k| *k == APPLICATION || *k == LIBRARY) else { continue };
        let name = manifest.pointer("/metadata/name").and_then(Value::as_str).unwrap_or("");
        if !root_modules.contains(name) {
            continue;
        }
        let at = |path: String| DiagnosticData {
            resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
            file_path: Some(document.source.to_string()),
            path: Some(path),
            ..Default::default()
        };
        for block in ["variables", "secrets"] {
            let Some(entries) = manifest.get(block).and_then(Value::as_object) else { continue };
            for (key, raw) in entries {
                let Some(entry) = raw.as_object() else { continue };
                // `default: null` declares that the input may be absent, whatever its type;
                // a default holding a tag is never read as a value.
                let Some(fallback) = entry.get("default").filter(|d| !d.is_null() && !holds_tag(d)) else { continue };
                let schema = if entry.contains_key("env") || entry.contains_key("arg") {
                    residual_entry_schema(raw)
                } else {
                    let mut rest = entry.clone();
                    rest.remove("default");
                    Value::Object(rest)
                };
                let value = decode_plain_literal(&anchored(fallback, &schema), &schema);
                // A validation that could not finish is the schema's own finding.
                let Ok(issues) = validate_against_schema(&value, &schema) else {
                    out.push(AnalysisDiagnostic::error(
                        SCHEMA_NESTING_EXCEEDED,
                        schema_nesting_exceeded_message(&format!("{kind}/{name}"), &format!("the default of {block}.{key}")),
                        at(format!("{block}.{key}.default")),
                    ));
                    continue;
                };
                for issue in issues {
                    let text = issue.message.strip_prefix("/ ").unwrap_or(&issue.message).to_string();
                    out.push(AnalysisDiagnostic::error(
                        value_type_refusal_code(&issue).as_deref().unwrap_or("DEFAULT_INVALID"),
                        format!(
                            "{kind}/{name}: the default of {block}.{key} {text}. A default is the value the input holds when nothing supplies one, so it must satisfy the input's own declaration."
                        ),
                        at(format!("{block}.{key}.default")),
                    ));
                }
            }
        }
        // Every declared port is assigned under a runner, so none may be absent.
        if kind != APPLICATION {
            continue;
        }
        let Some(ports) = manifest.get("ports").and_then(Value::as_object) else { continue };
        for (key, entry) in ports {
            if !entry.as_object().is_some_and(|entry| entry.get("default").is_some_and(Value::is_null)) {
                continue;
            }
            out.push(AnalysisDiagnostic::error(
                "DEFAULT_INVALID",
                format!(
                    "{kind}/{name}: the default of ports.{key} is null, but a port never admits absence — every declared port is assigned wherever the application runs. Give it a port number, or leave 'default:' out to require one."
                ),
                at(format!("ports.{key}.default")),
            ));
        }
    }
    out
}
