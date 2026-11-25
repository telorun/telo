//! A value type with members, at a contract boundary — the dispatch half of
//! `../../nodejs/src/members-values.ts` (`settleMembersValue`, `membersArgumentRefusal`,
//! `membersRefusalEntry`, `membersEntryText`, `buildMembersValues`, `membersIssues`). Text
//! or an object of members at such a slot is BUILT into the value before validation and
//! held to the slot's type arguments; one that does not build is an entry carrying the
//! type's own code, its pointer and its reason, never the value. This kernel creates no
//! resource holding one and keeps no redaction set, so the creation and redaction halves
//! have no counterpart.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Value};
use telo_analyzer::members_value_slot::{members_refusal_code, members_value_refusal, read_members_value, MembersSlot};
use telo_analyzer::value_type_defaults::map_members_slots;
use telorun_cel_value::CelValue;
use telorun_sdk_core::value_type::X_TELO_TYPE;

use crate::schema_validator::SchemaValidator;
use crate::schema_value_issues::value_issue;

/// A value of a type with members that does not build: where it is, the type's own
/// runtime code, and why.
#[derive(Clone, Debug, PartialEq)]
pub struct MembersRefusalEntry {
    /// JSON Pointer of the value inside what was built (`/url`, `/` for the whole).
    pub pointer: String,
    /// The type's code, `ERR_`-prefixed (`ERR_URL_INVALID`).
    pub code: String,
    /// The type's name (`Telo.Url`).
    pub type_name: String,
    pub reason: String,
}

/// `membersEntryText`: an entry as one line of a refusal.
pub fn members_entry_text(entry: &MembersRefusalEntry) -> String {
    format!("{}: not a {} — {}", entry.code, entry.type_name, entry.reason)
}

/// `membersRefusalEntry`: the entry a members slot's refusal is carried as.
fn members_refusal_entry(slot: &MembersSlot, pointer: &str, reason: String) -> MembersRefusalEntry {
    MembersRefusalEntry {
        pointer: pointer.to_string(),
        code: members_refusal_code(slot).map_or_else(|| "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED".to_string(), |code| format!("ERR_{code}")),
        type_name: slot.entry.name.clone(),
        reason,
    }
}

/// `membersIssues`: entries as the `issues` an error's data carries.
pub fn members_issues(refusals: &[MembersRefusalEntry]) -> Value {
    Value::Array(
        refusals
            .iter()
            .map(|entry| {
                let pointer = if entry.pointer == "/" { "" } else { entry.pointer.as_str() };
                let mut issue = value_issue(pointer, "format", json!({ "format": entry.type_name }));
                issue["code"] = Value::String(entry.code.clone());
                issue
            })
            .collect(),
    )
}

/// Whether a value satisfies a slot's own type annotation, one validator per annotation.
#[derive(Default)]
pub struct AnnotationAcceptance {
    validators: RefCell<HashMap<String, SchemaValidator>>,
}

impl AnnotationAcceptance {
    /// `membersArgumentRefusal`: why `value`, already of the slot's type, is refused by the
    /// slot's type arguments — or `None` when every argument accepts it. An error is a compile
    /// that failed or a validation that could not finish.
    fn argument_refusal(&self, schema: &Value, slot: &MembersSlot, value: &CelValue) -> Result<Option<String>, String> {
        let Some(annotation) = schema.get(X_TELO_TYPE).filter(|annotation| annotation.is_object()) else { return Ok(None) };
        let key = annotation.to_string();
        let mut validators = self.validators.borrow_mut();
        if !validators.contains_key(&key) {
            validators.insert(key.clone(), SchemaValidator::compile(&json!({ X_TELO_TYPE: annotation }))?);
        }
        match validators[&key].check(value) {
            Ok(_) => Ok(None),
            Err(refusal) if refusal.issues.is_some() => Ok(Some(members_value_refusal(slot, value))),
            // A validation that could not finish holds no verdict on the value.
            Err(refusal) => Err(refusal.message),
        }
    }
}

/// What building a value's members-type values found.
pub struct MembersBuild {
    pub value: CelValue,
    /// Every value that did not build, left as written.
    pub refusals: Vec<MembersRefusalEntry>,
}

/// `buildMembersValues`: every value of a type with members `value` holds as text or as an
/// object of members built, and each — built here or already one — held to its slot's
/// arguments. `written` is the value as plain JSON; `schema` the contract it is read
/// against. An error is a compile of a slot's annotation that failed.
pub fn build_members_values(
    written: &Value,
    value: &CelValue,
    schema: &Value,
    acceptance: &AnnotationAcceptance,
) -> Result<MembersBuild, String> {
    let mut refusals = Vec::new();
    let mut failure = None;
    let built = map_members_slots(written, value, schema, &mut |slot_schema, slot, held, pointer| {
        let settled = read_members_value(slot, held).and_then(|built| {
            match acceptance.argument_refusal(slot_schema, slot, &built) {
                Ok(Some(reason)) => Err(reason),
                Ok(None) => Ok(built),
                Err(compile) => {
                    failure.get_or_insert(compile);
                    Ok(built)
                }
            }
        });
        match settled {
            Ok(built) => built,
            Err(reason) => {
                refusals.push(members_refusal_entry(slot, if pointer.is_empty() { "/" } else { pointer }, reason));
                held.clone()
            }
        }
    });
    match failure {
        Some(compile) => Err(compile),
        None => Ok(MembersBuild { value: built, refusals }),
    }
}
