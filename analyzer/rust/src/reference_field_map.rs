//! Whether a value at a reference slot is one of the slot's VALUE branches — a storage class
//! beside a `!ref`, so it is a value and not a malformed reference. Mirrors the value-branch half
//! of `../../nodejs/src/reference-field-map.ts` (`satisfiesValueBranch`); the rest of that file,
//! the reference field map itself, has no twin here yet.

use serde_json::Value;

use crate::schema_validation::{cel_value_of, SchemaValidation, SchemaValidationConfiguration};

/// Whether a value branch takes a value: it accepts it, refuses it, or the validation could not
/// finish and holds no verdict either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueBranchOutcome {
    Accepts,
    Refuses,
    Unfinished,
}

/// Whether one value branch of a union accepts `value`, validated against the branch with the
/// `$defs` / `definitions` of `root`, the document it was written in. A branch that does not
/// compile accepts nothing; its compile failure is reported where the schema is declared.
pub fn value_branch_accepts(branch: &Value, root: &Value, value: &Value) -> ValueBranchOutcome {
    let mut schema = branch.clone();
    if let Some(object) = schema.as_object_mut() {
        for key in ["$defs", "definitions"] {
            if let Some(definitions) = root.get(key) {
                object.entry(key.to_string()).or_insert_with(|| definitions.clone());
            }
        }
    }
    let mut validation = SchemaValidation::new(SchemaValidationConfiguration::Analysis);
    let Ok(compiled) = validation.compile(&schema) else { return ValueBranchOutcome::Refuses };
    match compiled.validate(&cel_value_of(value)) {
        Ok(result) if result.valid => ValueBranchOutcome::Accepts,
        Ok(_) => ValueBranchOutcome::Refuses,
        Err(_) => ValueBranchOutcome::Unfinished,
    }
}

/// Any of several branches: accepts when one accepts, else unfinished when one could not finish,
/// else refuses — each asked in order, none after the first that accepts.
pub fn value_branches_accept<'b>(
    branches: impl IntoIterator<Item = &'b Value>,
    root: &Value,
    value: &Value,
) -> ValueBranchOutcome {
    let mut unfinished = false;
    for branch in branches {
        match value_branch_accepts(branch, root, value) {
            ValueBranchOutcome::Accepts => return ValueBranchOutcome::Accepts,
            ValueBranchOutcome::Unfinished => unfinished = true,
            ValueBranchOutcome::Refuses => {}
        }
    }
    if unfinished {
        ValueBranchOutcome::Unfinished
    } else {
        ValueBranchOutcome::Refuses
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_each_of_the_three_outcomes() {
        let root = json!({ "$defs": { "Loop": { "type": "object", "$ref": "#/$defs/Loop" } } });
        let value = json!({ "leaf": 1 });
        let refusing = json!({ "type": "object", "required": ["other"] });
        let accepting = json!({ "type": "object" });
        let looping = json!({ "$ref": "#/$defs/Loop" });
        assert_eq!(value_branches_accept([&refusing], &root, &value), ValueBranchOutcome::Refuses);
        assert_eq!(value_branches_accept([&refusing, &looping], &root, &value), ValueBranchOutcome::Unfinished);
        assert_eq!(value_branches_accept([&looping, &accepting], &root, &value), ValueBranchOutcome::Accepts);
    }
}
