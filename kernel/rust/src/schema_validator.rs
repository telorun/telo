//! JSON Schema compilation and validation.
//! Mirrors `../../nodejs/src/schema-validator.ts`.

use serde_json::Value;

use crate::error::KernelError;

pub struct SchemaValidator {
    validator: jsonschema::Validator,
}

impl SchemaValidator {
    pub fn compile(schema: &Value) -> Result<Self, KernelError> {
        let validator = jsonschema::validator_for(schema).map_err(|err| {
            KernelError::manifest_validation_failed(format!("invalid JSON Schema: {err}"))
        })?;
        Ok(Self { validator })
    }

    /// All violations at once — a single message naming every offending path,
    /// so an author fixes the document in one pass rather than one field per run.
    pub fn errors(&self, data: &Value) -> Vec<String> {
        self.validator
            .iter_errors(data)
            .map(|err| {
                let path = err.instance_path().to_string();
                if path.is_empty() {
                    err.to_string()
                } else {
                    format!("{path}: {err}")
                }
            })
            .collect()
    }

    pub fn validate(&self, data: &Value) -> Result<(), String> {
        let errors = self.errors(data);
        if errors.is_empty() {
            return Ok(());
        }
        Err(errors.join("; "))
    }
}

/// Fill declared defaults into a copy of `value`, descending only along paths
/// that actually carry one. Mirrors the invocation contract's rule: a flat
/// shallow copy would let a nested default mutate the caller's object.
pub fn apply_defaults(schema: &Value, value: &Value) -> Value {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return value.clone();
    };
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let mut out = object.clone();
    for (name, property) in properties {
        match out.get(name) {
            None => {
                if let Some(default) = property.get("default") {
                    out.insert(name.clone(), default.clone());
                }
            }
            Some(existing) => {
                if existing.is_object() && property.get("properties").is_some() {
                    let filled = apply_defaults(property, existing);
                    out.insert(name.clone(), filled);
                }
            }
        }
    }
    Value::Object(out)
}
