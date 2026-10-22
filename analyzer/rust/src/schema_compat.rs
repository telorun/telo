//! The schema readers a walk over a value shares: union branches, reference
//! resolution and the properties an object node declares. Mirrors those readers
//! in `../../nodejs/src/schema-compat.ts`; the compatibility check itself has no
//! Rust counterpart yet.

use std::borrow::Cow;

use serde_json::{Map, Value};

use crate::manifest_navigation::resolve_schema_pointer;

/// Looks a registered schema up by its `$id`.
pub type ExternalSchemaResolver<'s> = dyn Fn(&str) -> Option<&'s Value> + 's;

/// The branches of a union node (`anyOf`, else `oneOf`), or `None` when the node
/// is not one. `anyOf` and `oneOf` are one question here — which branches could
/// accept a value.
pub fn union_branches(schema: &Value) -> Option<Vec<&Value>> {
    let branches = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))?
        .as_array()
        .filter(|branches| !branches.is_empty())?;
    Some(branches.iter().filter(|b| b.is_object()).collect())
}

/// `schema` with its `$ref` followed, and the root the result's own `#/…`
/// references resolve against: the same root for a local reference, the
/// referenced document for an external one. A reference that resolves to nothing
/// leaves the node as it is.
pub fn resolve_ref_in<'s: 'a, 'a>(
    schema: &'a Value,
    root: &'a Value,
    external: Option<&ExternalSchemaResolver<'s>>,
) -> (&'a Value, &'a Value) {
    let Some(reference) = schema.get("$ref").and_then(Value::as_str) else {
        return (schema, root);
    };
    if reference.starts_with('#') {
        return match resolve_schema_pointer(root, reference) {
            Some(resolved) if resolved.is_object() => (resolved, root),
            _ => (schema, root),
        };
    }
    match external.and_then(|resolve| resolve(reference)) {
        Some(target) => (target, target),
        None => (schema, root),
    }
}

/// The `oneOf` / `anyOf` branch `data` is written against, when exactly one
/// fits; otherwise the union unchanged. A union beside a shared base returns the
/// base with the branch merged over it.
pub fn select_union_branch<'s: 'a, 'a>(
    schema: &'a Value,
    data: &Value,
    root: &'a Value,
    external: Option<&ExternalSchemaResolver<'s>>,
) -> Cow<'a, Value> {
    match fitting_union_branches(schema, data, root, external) {
        Some(mut fits) if fits.len() == 1 => fits.remove(0),
        _ => Cow::Borrowed(schema),
    }
}

/// Every branch `data` may be written against — each merged over the union's
/// shared base — or `None` when `schema` is not a union. Selection is structural
/// and conservative: a branch must agree with the data's kind, a constant branch
/// reads exactly one scalar, and an object must hold every `required` key.
pub fn fitting_union_branches<'s: 'a, 'a>(
    schema: &'a Value,
    data: &Value,
    root: &'a Value,
    external: Option<&ExternalSchemaResolver<'s>>,
) -> Option<Vec<Cow<'a, Value>>> {
    let union_key = if schema.get("oneOf").is_some() { "oneOf" } else { "anyOf" };
    let branches = schema.get(union_key)?.as_array().filter(|b| !b.is_empty())?;
    let kind = match data {
        Value::Array(_) => "array",
        Value::Null => "null",
        Value::Object(_) => "object",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
    };
    let fits: Vec<&'a Value> = branches
        .iter()
        .map(|branch| resolve_ref_in(branch, root, external).0)
        .filter(|branch| {
            let types: Vec<&str> = match branch.get("type") {
                Some(Value::Array(types)) => types.iter().filter_map(Value::as_str).collect(),
                Some(Value::String(t)) => vec![t.as_str()],
                _ => Vec::new(),
            };
            if !types.is_empty() && !types.contains(&kind) {
                return false;
            }
            if let Some(constant) = branch.get("const") {
                if !data.is_object() && !data.is_array() && constant != data {
                    return false;
                }
            }
            if let (Value::Object(entries), Some(Value::Array(required))) = (data, branch.get("required")) {
                if !required.iter().filter_map(Value::as_str).all(|key| entries.contains_key(key)) {
                    return false;
                }
            }
            true
        })
        .collect();
    if schema.get("type").is_none() && schema.get("properties").is_none() {
        return Some(fits.into_iter().map(Cow::Borrowed).collect());
    }
    let mut base = schema.as_object().cloned().unwrap_or_default();
    base.remove(union_key);
    Some(fits.into_iter().map(|branch| Cow::Owned(merged_over(&base, branch))).collect())
}

/// A discriminated union over a shared base: the base with the branch's own keys
/// over it, their `properties` and `required` combined.
fn merged_over(base: &Map<String, Value>, branch: &Value) -> Value {
    let mut out = base.clone();
    let own = branch.as_object().cloned().unwrap_or_default();
    let mut properties = base.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(branch_properties) = own.get("properties").and_then(Value::as_object) {
        properties.extend(branch_properties.clone());
    }
    let mut required: Vec<Value> = Vec::new();
    for list in [base.get("required"), own.get("required")] {
        for key in list.and_then(Value::as_array).into_iter().flatten() {
            if !required.contains(key) {
                required.push(key.clone());
            }
        }
    }
    out.extend(own);
    out.insert("properties".into(), Value::Object(properties));
    if required.is_empty() {
        out.remove("required");
    } else {
        out.insert("required".into(), Value::Array(required));
    }
    Value::Object(out)
}

/// The property schemas an object node declares: its own `properties`, each
/// intersected with what an `allOf` branch says of it, then whatever a
/// `oneOf` / `anyOf` branch alone contributes.
pub fn collect_properties(schema: &Value) -> Map<String, Value> {
    let mut properties = schema.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
    for sub in schema.get("allOf").and_then(Value::as_array).into_iter().flatten() {
        let Some(sub_properties) = sub.get("properties").and_then(Value::as_object) else {
            continue;
        };
        for (key, value) in sub_properties {
            match (properties.get_mut(key), value.as_object()) {
                (Some(Value::Object(existing)), Some(more)) => existing.extend(more.clone()),
                (Some(_), _) => {}
                (None, _) => {
                    properties.insert(key.clone(), value.clone());
                }
            }
        }
    }
    let alternatives = schema.get("oneOf").or_else(|| schema.get("anyOf"));
    for sub in alternatives.and_then(Value::as_array).into_iter().flatten() {
        for (key, value) in sub.get("properties").and_then(Value::as_object).into_iter().flatten() {
            properties.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    properties
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sqlite_file() -> Value {
        json!({ "anyOf": [{ "const": ":memory:" }, { "type": "string", "x-telo-type": "Telo.HostPath" }] })
    }

    #[test]
    fn selects_the_one_branch_a_scalar_fits() {
        let schema = sqlite_file();
        let chosen = select_union_branch(&schema, &json!("/srv/app.db"), &schema, None);
        assert_eq!(chosen.as_ref(), &json!({ "type": "string", "x-telo-type": "Telo.HostPath" }));
    }

    #[test]
    fn leaves_an_ambiguous_union_as_it_is() {
        let schema = sqlite_file();
        let chosen = select_union_branch(&schema, &json!(":memory:"), &schema, None);
        assert_eq!(chosen.as_ref(), &schema);
    }

    #[test]
    fn merges_a_branch_over_a_shared_base() {
        let schema = json!({
            "type": "object",
            "properties": { "name": { "type": "string" } },
            "oneOf": [{ "required": ["a"], "properties": { "a": { "type": "string" } } }]
        });
        let chosen = select_union_branch(&schema, &json!({ "a": "x" }), &schema, None);
        assert_eq!(
            chosen.as_ref(),
            &json!({
                "type": "object",
                "properties": { "name": { "type": "string" }, "a": { "type": "string" } },
                "required": ["a"]
            })
        );
    }

    #[test]
    fn follows_a_local_reference_keeping_its_root() {
        let root = json!({ "$defs": { "P": { "type": "string" } } });
        let node = json!({ "$ref": "#/$defs/P" });
        let (resolved, _) = resolve_ref_in(&node, &root, None);
        assert_eq!(resolved, &json!({ "type": "string" }));
    }

    #[test]
    fn intersects_all_of_and_adds_union_only_properties() {
        let schema = json!({
            "properties": { "score": { "type": "integer" } },
            "allOf": [{ "properties": { "score": { "minimum": 10 } } }],
            "anyOf": [{ "properties": { "score": { "type": "string" }, "extra": { "type": "boolean" } } }]
        });
        let properties = collect_properties(&schema);
        assert_eq!(properties["score"], json!({ "type": "integer", "minimum": 10 }));
        assert_eq!(properties["extra"], json!({ "type": "boolean" }));
    }
}
