//! Binds a kind's declared call signature to an instance at `create()`.
//! Mirrors `../../nodejs/src/invocation-contract-binding.ts`; the normative rules
//! are `kernel/specs/invocation-contract.md`.
//!
//! Two of those rules are load-bearing here. The contract is bound at the single
//! instance-production site, so an instance is never observable unbound —
//! enforcing at a handoff would mean enforcing at every handoff. And a contract
//! REPLACES rather than merges: an instance that declares its own `inputType`
//! narrows one call site, it does not add to the kind's.

use serde_json::Value;

use crate::controllers::r#type::json_schema_controller::resolve_type_field;
use crate::error::KernelError;
use crate::schema_validator::{apply_defaults, SchemaValidator};

#[derive(Default)]
pub struct InvocationContract {
    input: Option<ContractSide>,
    output: Option<ContractSide>,
}

struct ContractSide {
    schema: Value,
    validator: SchemaValidator,
}

impl ContractSide {
    fn new(schema: Value) -> Result<Self, KernelError> {
        let validator = SchemaValidator::compile(&schema)?;
        Ok(Self { schema, validator })
    }
}

impl InvocationContract {
    /// Resolve the contract for one instance: its own declaration wins over the
    /// kind's, and an undeclared side stays unchecked.
    pub fn resolve(
        definition: &Value,
        instance_manifest: &Value,
    ) -> Result<Self, KernelError> {
        let input = resolve_side(definition, instance_manifest, "inputType")?;
        let output = resolve_side(definition, instance_manifest, "outputType")?;
        Ok(Self {
            input: input.map(ContractSide::new).transpose()?,
            output: output.map(ContractSide::new).transpose()?,
        })
    }

    /// Fill declared defaults, then check the filled value. Returns the value to
    /// hand the controller — the caller's own object is never mutated.
    pub fn prepare_inputs(&self, inputs: &Value) -> Result<Value, KernelError> {
        let Some(input) = &self.input else {
            return Ok(inputs.clone());
        };
        let filled = apply_defaults(&input.schema, inputs);
        input
            .validator
            .validate(&filled)
            .map_err(KernelError::input_invalid)?;
        Ok(filled)
    }

    pub fn check_output(&self, output: &Value) -> Result<(), KernelError> {
        let Some(contract) = &self.output else {
            return Ok(());
        };
        contract
            .validator
            .validate(output)
            .map_err(KernelError::output_invalid)
    }
}

fn resolve_side(
    definition: &Value,
    instance_manifest: &Value,
    field: &str,
) -> Result<Option<Value>, KernelError> {
    if let Some(schema) = resolve_type_field(instance_manifest.get(field))? {
        return Ok(Some(schema));
    }
    resolve_type_field(definition.get(field))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition_with_input_type() -> Value {
        json!({
            "inputType": {
                "kind": "Telo.JsonSchema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "output": { "type": "string" },
                        "trailingNewline": { "type": "boolean", "default": true }
                    },
                    "required": ["output"],
                    "additionalProperties": false
                }
            }
        })
    }

    #[test]
    fn rejects_inputs_that_violate_the_declared_signature() {
        let contract =
            InvocationContract::resolve(&definition_with_input_type(), &json!({})).unwrap();
        let err = contract
            .prepare_inputs(&json!({ "output": 42 }))
            .expect_err("a number is not a string");
        assert_eq!(err.code, "ERR_INPUT_INVALID", "{err}");
    }

    #[test]
    fn fills_declared_defaults_without_touching_the_callers_value() {
        let contract =
            InvocationContract::resolve(&definition_with_input_type(), &json!({})).unwrap();
        let inputs = json!({ "output": "hi" });
        let prepared = contract.prepare_inputs(&inputs).unwrap();
        assert_eq!(prepared["trailingNewline"], json!(true));
        assert!(inputs.get("trailingNewline").is_none());
    }

    /// An instance's own declaration REPLACES the kind's, it does not merge —
    /// merging two call signatures yields a union no caller can satisfy.
    #[test]
    fn an_instance_declaration_replaces_the_kinds() {
        let instance = json!({
            "inputType": { "kind": "Telo.JsonSchema", "schema": { "type": "object" } }
        });
        let contract =
            InvocationContract::resolve(&definition_with_input_type(), &instance).unwrap();
        contract
            .prepare_inputs(&json!({ "anything": true }))
            .expect("the kind's `required: [output]` must not apply");
    }

    #[test]
    fn an_undeclared_side_is_unchecked() {
        let contract = InvocationContract::resolve(&json!({}), &json!({})).unwrap();
        contract.prepare_inputs(&json!({ "whatever": 1 })).unwrap();
        contract.check_output(&json!(null)).unwrap();
    }
}
