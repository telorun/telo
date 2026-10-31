//! The objects an author wrote at a reference slot as a reference: the legacy
//! `{ kind, name }` form and the `__ref` key. Mirrors the object-form half of
//! `../../nodejs/src/validate-reference-forms.ts`, worded as it is, and the
//! legacy reading of `../../nodejs/src/normalize-inline-resources.ts`: a
//! dependency's `{ kind, name }` is marked as the reference it means
//! ([`mark_legacy_references`]).
//!
//! Only reference slots are judged — the nodes a kind's schema marks
//! `x-telo-ref`, found through `properties`, `additionalProperties`, `items`,
//! local `$ref`s and union and `allOf` branches — never a whole document: a
//! resource whose own kind declares a `name` field carries `kind` and `name` at
//! its root. Where a union gives a slot value branches beside its reference
//! branch, an object one of them accepts is a value, not a reference.

use serde_json::Value;

use crate::resolved_reference::{carries_reference_marker, RESOLVED_REFERENCE_MARKER};
use crate::schema_compat::{collect_properties, resolve_ref_in, union_branches};

/// Which spelling an author wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceForm {
    /// `{ kind, name }` for a kind whose schema declares no `name` field.
    Object,
    /// An object holding the `__ref` key.
    Marker,
}

/// One refused object, located for the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidReferenceForm {
    /// The slot's path in the resource, `mounts[0].mount`.
    pub path: String,
    /// The same place as a JSON Pointer into the resource.
    pub pointer: String,
    pub form: ReferenceForm,
    /// The name it holds — the `!ref` repair names it.
    pub name: Option<String>,
}

/// Whether a value branch of a union accepts a value: the branch, the document
/// it was written in (its local `$ref`s resolve there), and the value. A branch
/// that cannot be compiled accepts nothing.
pub type AcceptsValue<'a> = dyn Fn(&Value, &Value, &Value) -> bool + 'a;

/// The reference spelling an author wrote, or `None` for an inline
/// declaration. `kind_declares_name` answers for the object's own `kind`, `None`
/// when that kind does not resolve — a `name` beside a misspelled kind is no
/// evidence of a reference.
pub fn authored_object_form(
    value: &Value,
    kind_declares_name: &dyn Fn(&str) -> Option<bool>,
) -> Option<(ReferenceForm, Option<String>)> {
    let object = value.as_object()?;
    let name = object.get("name").and_then(Value::as_str).map(str::to_string);
    if carries_reference_marker(value) {
        return Some((ReferenceForm::Marker, name));
    }
    let kind = object.get("kind").and_then(Value::as_str)?;
    let name = name?;
    (kind_declares_name(kind) == Some(false)).then_some((ReferenceForm::Object, Some(name)))
}

/// Every refused object at a reference slot of `resource`, its kind's author
/// schema being `schema`.
pub fn find_invalid_reference_forms(
    resource: &Value,
    schema: &Value,
    kind_declares_name: &dyn Fn(&str) -> Option<bool>,
    accepts: &AcceptsValue,
) -> Vec<InvalidReferenceForm> {
    let mut found: Vec<InvalidReferenceForm> = Vec::new();
    if let Value::Object(entries) = resource {
        let properties = collect_properties(schema);
        let additional = schema.get("additionalProperties").filter(|a| a.is_object());
        for (key, child) in entries {
            if key == "kind" || key == "metadata" {
                continue;
            }
            if let Some(child_schema) = properties.get(key).or(additional) {
                let at = Place { path: key.clone(), pointer: format!("/{}", escape_pointer(key)) };
                let walk = Walk { kind_declares_name, accepts };
                walk.visit(child, child_schema, schema, &at, &mut found, 0);
            }
        }
    }
    found
}

/// Mark every legacy `{ kind, name }` at a reference slot of `resource` as the
/// resolved reference it means, in place, and return what is left refused: an
/// author-written `__ref` key, which only resolution may write. How a
/// dependency's documents are read — the entry's own refuse both spellings.
pub fn mark_legacy_references(
    resource: &mut Value,
    schema: &Value,
    kind_declares_name: &dyn Fn(&str) -> Option<bool>,
    accepts: &AcceptsValue,
) -> Vec<InvalidReferenceForm> {
    let found = find_invalid_reference_forms(resource, schema, kind_declares_name, accepts);
    let mut refused = Vec::new();
    for form in found {
        match form.form {
            ReferenceForm::Object => {
                if let Some(Value::Object(object)) = resource.pointer_mut(&form.pointer) {
                    // As the Node half marks one: the marker first, every key it
                    // holds kept, and the empty indexes every resolved reference carries.
                    let mut marked = serde_json::Map::with_capacity(object.len() + 2);
                    marked.insert(RESOLVED_REFERENCE_MARKER.to_string(), Value::Bool(true));
                    marked.extend(std::mem::take(object));
                    marked.insert("indexes".to_string(), Value::Array(Vec::new()));
                    *object = marked;
                }
            }
            ReferenceForm::Marker => refused.push(form),
        }
    }
    refused
}

/// The refusal, after the resource label — the Node analyzer's sentence.
pub fn reference_form_message(form: &InvalidReferenceForm) -> String {
    match form.form {
        ReferenceForm::Marker => format!(
            "'{RESOLVED_REFERENCE_MARKER}' at '{}' is not supported — it marks a reference the loader resolved; write a reference as '!ref {}'",
            form.path,
            form.name.as_deref().unwrap_or("<name>")
        ),
        ReferenceForm::Object => format!(
            "object reference '{{ kind, name }}' at '{}' is not supported; write it as '!ref {}'",
            form.path,
            form.name.as_deref().unwrap_or_default()
        ),
    }
}

/// A schema hop that consumes no value — a `$ref`, a union branch, an `allOf`
/// member — beyond this many in a row is a schema referring to itself in place.
const MAX_HOPS: usize = 64;

/// Where a value sits: its path for the message and its JSON Pointer.
struct Place {
    path: String,
    pointer: String,
}

impl Place {
    fn index(&self, index: usize) -> Place {
        Place { path: format!("{}[{index}]", self.path), pointer: format!("{}/{index}", self.pointer) }
    }

    fn key(&self, key: &str) -> Place {
        let path = if self.path.is_empty() { key.to_string() } else { format!("{}.{key}", self.path) };
        Place { path, pointer: format!("{}/{}", self.pointer, escape_pointer(key)) }
    }
}

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

struct Walk<'a, 'b> {
    kind_declares_name: &'a dyn Fn(&str) -> Option<bool>,
    accepts: &'a AcceptsValue<'b>,
}

impl Walk<'_, '_> {
    fn visit(
        &self,
        value: &Value,
        raw: &Value,
        root: &Value,
        at: &Place,
        found: &mut Vec<InvalidReferenceForm>,
        hops: usize,
    ) {
        if hops > MAX_HOPS {
            return;
        }
        let (here, root) = resolve_ref_in(raw, root, None);
        if here.get("x-telo-ref").is_some() {
            if let Some((form, name)) = authored_object_form(value, self.kind_declares_name) {
                if !found.iter().any(|existing| existing.path == at.path) {
                    found.push(InvalidReferenceForm {
                        path: at.path.clone(),
                        pointer: at.pointer.clone(),
                        form,
                        name,
                    });
                }
            }
            return;
        }
        let branches = union_branches(here).unwrap_or_default();
        // A union delegating its reference constraint to a branch: an object a
        // value branch accepts is that value, so the reference branches beside
        // it are not asked about it.
        let as_value = branches.iter().any(|branch| branch.get("x-telo-ref").is_some())
            && value.is_object()
            && branches
                .iter()
                .filter(|branch| branch.get("x-telo-ref").is_none())
                .any(|branch| (self.accepts)(branch, root, value));
        for branch in branches {
            if as_value && branch.get("x-telo-ref").is_some() {
                continue;
            }
            self.visit(value, branch, root, at, found, hops + 1);
        }
        for member in here.get("allOf").and_then(Value::as_array).into_iter().flatten() {
            self.visit(value, member, root, at, found, hops + 1);
        }
        match value {
            Value::Array(items) => {
                let Some(item) = here.get("items") else {
                    return;
                };
                for (index, child) in items.iter().enumerate() {
                    self.visit(child, item, root, &at.index(index), found, 0);
                }
            }
            Value::Object(entries) => {
                let properties = collect_properties(here);
                let additional = here.get("additionalProperties").filter(|a| a.is_object());
                for (key, child) in entries {
                    if let Some(child_schema) = properties.get(key).or(additional) {
                        self.visit(child, child_schema, root, &at.key(key), found, 0);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn no_value(_branch: &Value, _root: &Value, _value: &Value) -> bool {
        false
    }

    fn forms(resource: Value) -> Vec<(String, ReferenceForm)> {
        let schema = json!({
            "type": "object",
            "properties": {
                "label": { "type": "object" },
                "mounts": {
                    "type": "array",
                    "items": { "$ref": "#/$defs/Mount" }
                }
            },
            "$defs": { "Mount": { "type": "object", "properties": { "mount": { "x-telo-ref": "Self.Api" } } } }
        });
        let declares = |kind: &str| match kind {
            "Self.Api" => Some(false),
            "Self.Named" => Some(true),
            _ => None,
        };
        find_invalid_reference_forms(&resource, &schema, &declares, &no_value)
            .into_iter()
            .map(|form| (form.path, form.form))
            .collect()
    }

    #[test]
    fn refuses_the_object_form_of_a_kind_without_a_name_field() {
        let resource = json!({ "mounts": [{ "mount": { "kind": "Self.Api", "name": "usersApi" } }] });
        assert_eq!(forms(resource), vec![("mounts[0].mount".to_string(), ReferenceForm::Object)]);
    }

    #[test]
    fn reads_a_kind_declaring_a_name_field_as_a_declaration() {
        let resource = json!({ "mounts": [{ "mount": { "kind": "Self.Named", "name": "house" } }] });
        assert!(forms(resource).is_empty());
    }

    #[test]
    fn refuses_an_authored_marker() {
        let resource = json!({ "mounts": [{ "mount": { "__ref": true, "kind": "Self.Named", "name": "house" } }] });
        assert_eq!(forms(resource), vec![("mounts[0].mount".to_string(), ReferenceForm::Marker)]);
    }

    /// Only a reference slot is judged — plain data holding `kind` and `name`,
    /// and the resource's own root, are not.
    #[test]
    fn judges_no_place_but_a_reference_slot() {
        let resource = json!({
            "kind": "Self.Named",
            "name": "house",
            "label": { "kind": "Self.Api", "name": "data" }
        });
        assert!(forms(resource).is_empty());
    }

    #[test]
    fn marks_the_legacy_form_and_leaves_the_marker_refused() {
        let schema = json!({
            "type": "object",
            "properties": {
                "a": { "x-telo-ref": "Self.Api" },
                "b": { "x-telo-ref": "Self.Api" },
                "c": { "x-telo-ref": "Self.Api" }
            }
        });
        let declares = |kind: &str| match kind {
            "Self.Api" => Some(false),
            "Self.Named" => Some(true),
            _ => None,
        };
        let mut resource = json!({
            "a": { "kind": "Self.Api", "name": "usersApi" },
            "b": { "kind": "Self.Named", "name": "house" },
            "c": { "__ref": true, "kind": "Self.Api", "name": "usersApi" }
        });
        let refused = mark_legacy_references(&mut resource, &schema, &declares, &no_value);
        assert_eq!(
            resource["a"],
            json!({ "__ref": true, "kind": "Self.Api", "name": "usersApi", "indexes": [] })
        );
        assert_eq!(resource["b"], json!({ "kind": "Self.Named", "name": "house" }));
        assert_eq!(
            refused.into_iter().map(|form| (form.pointer, form.form)).collect::<Vec<_>>(),
            vec![("/c".to_string(), ReferenceForm::Marker)]
        );
    }

    /// Where a union gives a slot a value branch beside its reference branch,
    /// an object the value branch accepts is a value.
    #[test]
    fn leaves_an_object_a_value_branch_accepts() {
        let schema = json!({
            "type": "object",
            "properties": {
                "type": {
                    "anyOf": [
                        { "type": "object", "required": ["kind", "name", "length"] },
                        { "x-telo-ref": "Self.Api" }
                    ]
                }
            }
        });
        let declares = |_: &str| Some(false);
        let accepts = |branch: &Value, _root: &Value, value: &Value| {
            branch["required"].as_array().is_some_and(|required| {
                required.iter().filter_map(Value::as_str).all(|key| value.get(key).is_some())
            })
        };
        let value = json!({ "type": { "kind": "Self.Api", "name": "text", "length": 3 } });
        let reference = json!({ "type": { "kind": "Self.Api", "name": "usersApi" } });
        assert!(find_invalid_reference_forms(&value, &schema, &declares, &accepts).is_empty());
        assert_eq!(find_invalid_reference_forms(&reference, &schema, &declares, &accepts).len(), 1);
    }
}
