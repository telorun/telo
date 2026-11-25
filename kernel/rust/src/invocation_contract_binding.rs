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
use telorun_cel_value::CelValue;
use telorun_sdk_core::value_type::X_TELO_TYPE;

use crate::controllers::r#type::json_schema_controller::resolve_type_field;
use crate::error::KernelError;
use crate::members_values::{build_members_values, members_entry_text, members_issues, AnnotationAcceptance, MembersRefusalEntry};
use telo_analyzer::schema_validation::cel_value_of;

use crate::schema_validator::{json_of_cel, SchemaRefusal, SchemaValidator};
use crate::schema_value_issues::schema_refusal_data;

#[derive(Default)]
pub struct InvocationContract {
    input: Option<ContractSide>,
    output: Option<ContractSide>,
}

struct ContractSide {
    validator: SchemaValidator,
    /// Whether the contract reaches a slot of a value type with members, which a value is
    /// built at before it is validated (`reachesMembersSlot`).
    members: bool,
    acceptance: AnnotationAcceptance,
}

impl ContractSide {
    fn new(schema: Value) -> Result<Self, KernelError> {
        let validator = SchemaValidator::compile(&schema).map_err(KernelError::manifest_validation_failed)?;
        let members = reaches_members_slot(validator.canonical_schema());
        Ok(Self { validator, members, acceptance: AnnotationAcceptance::default() })
    }

    /// `value` with every value of a type with members built at its slot, or the entries
    /// of those that do not build.
    fn built(&self, written: &Value, value: CelValue) -> Result<Result<CelValue, Vec<MembersRefusalEntry>>, KernelError> {
        if !self.members {
            return Ok(Ok(value));
        }
        let build = build_members_values(written, &value, self.validator.canonical_schema(), &self.acceptance)
            .map_err(KernelError::manifest_validation_failed)?;
        Ok(if build.refusals.is_empty() { Ok(build.value) } else { Err(build.refusals) })
    }
}

/// Whether any node of `schema` declares a value type with members.
fn reaches_members_slot(schema: &Value) -> bool {
    let mut pending = vec![schema];
    while let Some(node) = pending.pop() {
        match node {
            Value::Object(map) => {
                if map.contains_key(X_TELO_TYPE) && telo_analyzer::members_value_slot::members_slot_of(node).is_some() {
                    return true;
                }
                pending.extend(map.values());
            }
            Value::Array(items) => pending.extend(items),
            _ => {}
        }
    }
    false
}

/// `contractViolation`: the target, the direction and the judged sentence, the issues as
/// the refusal's data — none when the validation could not finish.
fn contract_violation(code: &str, target: &str, side: &str, direction: &str, refusal: SchemaRefusal) -> KernelError {
    let mut err = KernelError::new(code, format!("{target}: {side} do not satisfy the declared {direction}: {}", refusal.message));
    err.data = schema_refusal_data(&refusal);
    err
}

/// `membersContractViolation`: values of a type with members that do not build, raised as
/// the direction's ambient code with each value's entry in its data and its text — never
/// the value itself.
fn members_contract_violation(code: &str, target: &str, side: &str, direction: &str, refusals: &[MembersRefusalEntry]) -> KernelError {
    let detail = refusals.iter().map(|entry| format!("{}: {}", entry.pointer, members_entry_text(entry))).collect::<Vec<_>>().join("; ");
    let mut err = KernelError::new(code, format!("{target}: {side} do not satisfy the declared {direction}: {detail}"));
    err.data = Some(serde_json::json!({ "issues": members_issues(refusals) }));
    err
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

    /// Fill declared defaults — a value type's decoded — then check the filled value, the
    /// inputs a manifest writes read through each instance type's plain encoding first, as
    /// the validator's `primary` configuration does, and every value of a type with members
    /// built. Returns the value to hand the controller; the caller's own object is never
    /// mutated. `target` names the resource a refusal is about (`<Kind>/<name>`).
    pub fn prepare_inputs(&self, inputs: &Value, target: &str) -> Result<Value, KernelError> {
        let Some(input) = &self.input else {
            return Ok(inputs.clone());
        };
        let built = match input.built(inputs, input.validator.decoded(inputs))? {
            Ok(built) => built,
            Err(refusals) => return Err(members_contract_violation("ERR_INPUT_INVALID", target, "inputs", "inputType", &refusals)),
        };
        match input.validator.check(&built) {
            Ok(filled) => Ok(json_of_cel(&filled)),
            Err(refusal) => Err(contract_violation("ERR_INPUT_INVALID", target, "inputs", "inputType", refusal)),
        }
    }

    pub fn check_output(&self, output: &Value, target: &str) -> Result<(), KernelError> {
        let Some(contract) = &self.output else {
            return Ok(());
        };
        // A result is the value its controller produced, judged as it is: only a literal a
        // manifest writes is read through its plain encoding, and a value of a type with
        // members is built.
        let built = match contract.built(output, cel_value_of(output))? {
            Ok(built) => built,
            Err(refusals) => return Err(members_contract_violation("ERR_OUTPUT_INVALID", target, "result", "outputType", &refusals)),
        };
        match contract.validator.check(&built) {
            Ok(_) => Ok(()),
            Err(refusal) => Err(contract_violation("ERR_OUTPUT_INVALID", target, "result", "outputType", refusal)),
        }
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
            .prepare_inputs(&json!({ "output": 42 }), "Console/x")
            .expect_err("a number is not a string");
        assert_eq!(err.code, "ERR_INPUT_INVALID", "{err}");
        assert_eq!(
            err.message,
            r#"Console/x: inputs do not satisfy the declared inputType: Invalid value passed: {"output":42,"trailingNewline":true}. Error: /output must be string"#
        );
        assert_eq!(err.data.as_ref().map(|d| &d["issues"][0]["pointer"]), Some(&json!("/output")));
    }

    #[test]
    fn fills_declared_defaults_without_touching_the_callers_value() {
        let contract =
            InvocationContract::resolve(&definition_with_input_type(), &json!({})).unwrap();
        let inputs = json!({ "output": "hi" });
        let prepared = contract.prepare_inputs(&inputs, "Console/x").unwrap();
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
            .prepare_inputs(&json!({ "anything": true }), "Console/x")
            .expect("the kind's `required: [output]` must not apply");
    }

    /// A schema nesting without end over the value cannot be judged: the refusal says so,
    /// locating nothing, rather than stopping the process.
    #[test]
    fn a_validation_that_cannot_finish_is_a_refusal_carrying_no_issues() {
        let refused = std::thread::Builder::new()
            .stack_size(64 << 20)
            .spawn(|| {
                let schema = json!({ "kind": "Telo.JsonSchema", "schema": { "$ref": "#", "properties": { "a": { "$ref": "#" } }, "type": "object" } });
                let contract = InvocationContract::resolve(&json!({}), &json!({ "inputType": schema })).unwrap();
                let mut inputs = json!({});
                for _ in 0..1_100 {
                    inputs = json!({ "a": inputs });
                }
                contract.prepare_inputs(&inputs, "Console/x").expect_err("the validation cannot finish")
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(refused.code, "ERR_INPUT_INVALID");
        assert_eq!(refused.message, "Console/x: inputs do not satisfy the declared inputType: Maximum call stack size exceeded");
        assert_eq!(refused.data, None);
    }

    #[test]
    fn an_undeclared_side_is_unchecked() {
        let contract = InvocationContract::resolve(&json!({}), &json!({})).unwrap();
        contract.prepare_inputs(&json!({ "whatever": 1 }), "Console/x").unwrap();
        contract.check_output(&json!(null), "Console/x").unwrap();
    }
}
