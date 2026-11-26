//! Whether a value at a reference slot is one of the slot's VALUE branches — a storage class
//! beside a `!ref`, so it is a value and not a malformed reference. Mirrors the value-branch half
//! of `../../nodejs/src/reference-field-map.ts` (`satisfiesValueBranch`); the rest of that file,
//! the reference field map itself, has no twin here yet.

use serde_json::Value;

use crate::schema_at_pointer::schema_within_document;
use crate::schema_in_place_cycle::{recurses_in_place, written_references};
use crate::schema_validation::{cel_value_of, check_value_depth, SchemaValidation, SchemaValidationConfiguration, ValidationUnfinished};

/// Whether a value branch takes a value: it accepts it, refuses it, or the validation could not
/// finish and holds no verdict either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueBranchOutcome {
    Accepts,
    Refuses,
    Unfinished(ValidationUnfinished),
}

/// Whether one value branch of a union accepts `value`, the branch read where it sits in
/// `root`, the document it was written in, so a `#` or `#/$defs/…` it writes names that
/// document's node (`schema_at_pointer`). A branch that does not compile accepts nothing; its
/// compile failure is reported where the schema is declared. A branch recursing in place
/// accepts the value: its declaration is refused (`SCHEMA_IN_PLACE_CYCLE`), and nothing is
/// validated against it.
pub fn value_branch_accepts(branch: &Value, root: &Value, value: &Value) -> ValueBranchOutcome {
    let local = written_references(branch).iter().any(|written| written.reference == "#" || written.reference.starts_with("#/"));
    let schema = if local { schema_within_document(branch, root) } else { branch.clone() };
    if recurses_in_place(&schema, &|_| None) {
        return ValueBranchOutcome::Accepts;
    }
    let mut validation = SchemaValidation::new(SchemaValidationConfiguration::Analysis);
    let Ok(compiled) = validation.compile(&schema) else { return ValueBranchOutcome::Refuses };
    let value = cel_value_of(value);
    match check_value_depth(&value).and_then(|()| compiled.validate(&value)) {
        Ok(result) if result.valid => ValueBranchOutcome::Accepts,
        Ok(_) => ValueBranchOutcome::Refuses,
        Err(error) => ValueBranchOutcome::Unfinished(ValidationUnfinished::of(&error)),
    }
}

/// Any of several branches: accepts when one accepts, else unfinished when one could not finish,
/// else refuses — each asked in order, none after the first that accepts.
pub fn value_branches_accept<'b>(
    branches: impl IntoIterator<Item = &'b Value>,
    root: &Value,
    value: &Value,
) -> ValueBranchOutcome {
    let mut unfinished = None;
    for branch in branches {
        match value_branch_accepts(branch, root, value) {
            ValueBranchOutcome::Accepts => return ValueBranchOutcome::Accepts,
            ValueBranchOutcome::Unfinished(cause) => unfinished = unfinished.or(Some(cause)),
            ValueBranchOutcome::Refuses => {}
        }
    }
    unfinished.map_or(ValueBranchOutcome::Refuses, ValueBranchOutcome::Unfinished)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_each_of_the_three_outcomes() {
        // A tree whose every level descends, read through the document it was written in.
        let root = json!({ "$defs": { "Tree": { "type": "object", "properties": { "tree": { "$ref": "#/$defs/Tree" } } } } });
        let tree = |depth: usize| (0..depth).fold(json!({ "leaf": 1 }), |inner, _| json!({ "tree": inner }));
        let refusing = json!({ "type": "object", "required": ["other"] });
        let looping = json!({ "$ref": "#/$defs/Tree" });
        assert_eq!(value_branches_accept([&refusing], &root, &tree(50)), ValueBranchOutcome::Refuses);
        assert_eq!(value_branches_accept([&refusing, &looping], &root, &tree(50)), ValueBranchOutcome::Accepts);
        // Nested past the limit, no branch is asked.
        assert_eq!(
            value_branches_accept([&refusing, &looping], &root, &tree(600)),
            ValueBranchOutcome::Unfinished(ValidationUnfinished::ValueDepth)
        );
    }
}
