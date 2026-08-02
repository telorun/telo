//! `Telo.JsonSchema` — the built-in that lets a kind declare a shape without
//! importing anything. Mirrors `../../../nodejs/src/controllers/type/json-schema-controller.ts`.
//!
//! A type field may be written four ways (`resolveTypeFieldToSchema` in the Node
//! analyzer): a bare type name, a reference, an inline `{kind, schema}`
//! declaration, or raw JSON Schema. Only the last two resolve without a type
//! registry, so a named reference is reported rather than guessed at.

use serde_json::Value;
use telo_analyzer::system_kinds::JSON_SCHEMA;

use crate::error::KernelError;

/// Resolve a `inputType:` / `outputType:` field to the JSON Schema it denotes.
/// `None` means the field was absent — the contract is simply undeclared.
pub fn resolve_type_field(field: Option<&Value>) -> Result<Option<Value>, KernelError> {
    let Some(field) = field else {
        return Ok(None);
    };
    if field.is_null() {
        return Ok(None);
    }
    match field {
        Value::String(name) => Err(KernelError::undefined_kind(format!(
            "named type reference '{name}' cannot be resolved: this kernel has no type registry yet. Declare the type inline as `kind: {JSON_SCHEMA}` with a `schema:` block."
        ))),
        Value::Object(map) => {
            // An inline type declaration is `{kind: Telo.JsonSchema, schema: …}`.
            // Both halves are checked: a `kind` this kernel cannot construct must
            // not be read as raw JSON Schema, where `kind` would be an unknown
            // keyword, silently ignored, and the resulting contract would accept
            // everything.
            if let Some(kind) = map.get("kind").and_then(Value::as_str) {
                if kind != JSON_SCHEMA {
                    return Err(KernelError::undefined_kind(format!(
                        "inline type declares kind '{kind}'; this kernel resolves only `{JSON_SCHEMA}`"
                    )));
                }
                return map.get("schema").cloned().ok_or_else(|| {
                    KernelError::manifest_validation_failed(format!(
                        "inline `{JSON_SCHEMA}` type has no `schema:` block"
                    ))
                }).map(Some);
            }
            if let Some(name) = map.get("name").and_then(Value::as_str) {
                return Err(KernelError::undefined_kind(format!(
                    "type reference to resource '{name}' cannot be resolved: this kernel has no type registry yet."
                )));
            }
            if let Some(schema) = map.get("schema") {
                return Ok(Some(schema.clone()));
            }
            Ok(Some(field.clone()))
        }
        other => Err(KernelError::manifest_validation_failed(format!(
            "a type field must be a schema, an inline type declaration, or a reference; got {other}"
        ))),
    }
}
