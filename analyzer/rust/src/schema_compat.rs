//! The schema readers a walk over a value shares: union branches, reference
//! resolution and the properties an object node declares. Mirrors those readers
//! in `../../nodejs/src/schema-compat.ts`; the compatibility check itself has no
//! Rust counterpart yet.

use std::borrow::Cow;

use serde_json::{Map, Value};

use telorun_sdk_core::plain_encoding::reads_text;
use telorun_sdk_core::value_type::{value_type_of, ValueType, MAX_EXACT_INTEGER};

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
/// shared base — or `None` when `schema` is not a union. A branch is dropped only
/// where the written data proves it cannot validate ([`branch_fits`]): its `type`
/// excludes the data's kind, a `required` key is absent, or a `const` / `enum` pin
/// refuses a literal. Where every branch a text or number fits is a value type
/// with a plain encoding, the value is the type of the one whose encoding reads it
/// ([`encoded_reading`]).
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
    let shared: Vec<Declared<'a>> = match schema.get("properties") {
        Some(properties @ Value::Object(_)) => vec![Declared { properties, root }],
        _ => Vec::new(),
    };
    let fits: Vec<&'a Value> = branches
        .iter()
        .map(|branch| resolve_ref_in(branch, root, external))
        .filter(|(branch, branch_root)| branch_fits(branch, branch_root, data, kind, &shared, external, &[]))
        .map(|(branch, _)| branch)
        .collect();
    let fits = match encoded_reading(&fits, data) {
        Some(read) => vec![read],
        None => fits,
    };
    if schema.get("type").is_none() && schema.get("properties").is_none() {
        return Some(fits.into_iter().map(Cow::Borrowed).collect());
    }
    let mut base = schema.as_object().cloned().unwrap_or_default();
    base.remove(union_key);
    Some(fits.into_iter().map(|branch| Cow::Owned(merged_over(&base, branch))).collect())
}

/// The `properties` a branch inherits, in the document they were written in.
#[derive(Clone, Copy)]
struct Declared<'a> {
    properties: &'a Value,
    root: &'a Value,
}

/// Whether `branch` may validate `data`, judged from the written data alone: its
/// `type`, its `required` keys, and every `const` / `enum` pin it carries over a
/// literal scalar — its own for a scalar, a member's for an object member, both
/// read through the inherited `shared` properties and the branch's `allOf` parts.
/// A branch that is itself a union fits when one of its branches does. `chain`
/// holds the nodes judged above this one, so a recursive shape is admitted rather
/// than walked again.
fn branch_fits<'s: 'a, 'a>(
    branch: &'a Value,
    root: &'a Value,
    data: &Value,
    kind: &str,
    shared: &[Declared<'a>],
    external: Option<&ExternalSchemaResolver<'s>>,
    chain: &[*const Value],
) -> bool {
    let identity = branch as *const Value;
    if chain.contains(&identity) {
        return true;
    }
    let inner: Vec<*const Value> = chain.iter().copied().chain([identity]).collect();
    let types: Vec<&str> = match branch.get("type") {
        Some(Value::Array(types)) => types.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(t)) => vec![t.as_str()],
        _ => Vec::new(),
    };
    if !types.is_empty() && !types.contains(&kind) {
        return false;
    }
    // The branch's own declaration of a member replaces an inherited one, and a
    // nearer inherited one a further one: the last entry declaring it wins.
    let mut declaring: Vec<Declared<'a>> = shared.to_vec();
    if let Some(properties @ Value::Object(_)) = branch.get("properties") {
        declaring.push(Declared { properties, root });
    }
    if let Value::Object(members) = data {
        if let Some(Value::Array(required)) = branch.get("required") {
            if !required.iter().filter_map(Value::as_str).all(|key| members.contains_key(key)) {
                return false;
            }
        }
        for (key, value) in members {
            if !is_literal_scalar(value) {
                continue;
            }
            let at = declaring.iter().rev().find_map(|entry| {
                entry.properties.get(key).filter(|member| member.is_object()).map(|member| (member, entry.root))
            });
            if let Some((member, member_root)) = at {
                if literal_refused(member, member_root, value, external, &[]) {
                    return false;
                }
            }
        }
    } else if kind != "array" && pin_refuses(branch, data) {
        return false;
    }
    for part in branch.get("allOf").and_then(Value::as_array).into_iter().flatten() {
        if !part.is_object() {
            continue;
        }
        let (entered, entered_root) = resolve_ref_in(part, root, external);
        if !branch_fits(entered, entered_root, data, kind, &[], external, &inner) {
            return false;
        }
    }
    let nested = branch.get("oneOf").filter(|n| !n.is_null()).or_else(|| branch.get("anyOf"));
    let Some(nested) = nested.and_then(Value::as_array).filter(|n| !n.is_empty()) else {
        return true;
    };
    nested.iter().any(|sub| {
        if !sub.is_object() {
            return true;
        }
        let (entered, entered_root) = resolve_ref_in(sub, root, external);
        branch_fits(entered, entered_root, data, kind, &declaring, external, &inner)
    })
}

/// A value the author wrote as a plain scalar — never an expression, a reference
/// or a decoded instance, each of which is an object here.
fn is_literal_scalar(value: &Value) -> bool {
    matches!(value, Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_))
}

/// A `const` / `enum` on `schema` itself that `literal` falls outside.
fn pin_refuses(schema: &Value, literal: &Value) -> bool {
    if let Some(constant) = schema.get("const") {
        if !same_json_scalar(constant, literal) {
            return true;
        }
    }
    match schema.get("enum") {
        Some(Value::Array(values)) => !values.iter().any(|allowed| same_json_scalar(allowed, literal)),
        _ => false,
    }
}

/// JSON Schema equality against a written scalar: a number is its value whatever
/// its spelling (`1` is `1.0`), and text never equals a boolean or a number.
fn same_json_scalar(pin: &Value, literal: &Value) -> bool {
    match (pin, literal) {
        (Value::Number(a), Value::Number(b)) => match (a.as_i64(), b.as_i64(), a.as_u64(), b.as_u64()) {
            (Some(x), Some(y), _, _) => x == y,
            (_, _, Some(x), Some(y)) => x == y,
            _ => a.as_f64() == b.as_f64(),
        },
        _ => pin == literal,
    }
}

/// Whether the member schema refuses the literal it was written with: a pin it
/// falls outside, read through `$ref`, through a union none of whose branches
/// admits it and through an `allOf` part that refuses it. Nothing else — a
/// member's `type` may be read through a plain encoding, which its own walk
/// decides.
fn literal_refused<'s: 'a, 'a>(
    written: &'a Value,
    root: &'a Value,
    literal: &Value,
    external: Option<&ExternalSchemaResolver<'s>>,
    chain: &[*const Value],
) -> bool {
    let (schema, at) = resolve_ref_in(written, root, external);
    let identity = schema as *const Value;
    if chain.contains(&identity) {
        return false;
    }
    let inner: Vec<*const Value> = chain.iter().copied().chain([identity]).collect();
    if pin_refuses(schema, literal) {
        return true;
    }
    let refused_by = |sub: &'a Value| sub.is_object() && literal_refused(sub, at, literal, external, &inner);
    if schema.get("allOf").and_then(Value::as_array).is_some_and(|parts| parts.iter().any(refused_by)) {
        return true;
    }
    let union = schema.get("oneOf").filter(|u| !u.is_null()).or_else(|| schema.get("anyOf"));
    union.and_then(Value::as_array).is_some_and(|branches| !branches.is_empty() && branches.iter().all(refused_by))
}

/// The one branch whose plain encoding reads `data`, where every fitting branch is
/// a value type with one; `None` otherwise. A branch of any other shape reads text
/// as itself, so a union holding one is never narrowed by encoding.
fn encoded_reading<'a>(fits: &[&'a Value], data: &Value) -> Option<&'a Value> {
    if fits.len() < 2 || !(data.is_string() || data.is_number()) {
        return None;
    }
    let encodings: Vec<(&'a Value, &'static ValueType)> = fits
        .iter()
        .map(|branch| value_type_of(branch).filter(|entry| entry.encoding.is_some()).map(|entry| (*branch, entry)))
        .collect::<Option<_>>()?;
    let reading: Vec<&'a Value> = encodings
        .into_iter()
        .filter(|(_, entry)| {
            let encoding = entry.encoding.as_deref().unwrap_or_default();
            match data {
                Value::String(text) => reads_text(encoding, text),
                Value::Number(number) => match (number.as_i64(), entry.integer_unit.as_deref()) {
                    (Some(n), Some(unit)) if n.abs() <= MAX_EXACT_INTEGER => {
                        reads_text(encoding, &format!("{n}{unit}"))
                    }
                    _ => false,
                },
                _ => false,
            }
        })
        .map(|(branch, _)| branch)
        .collect();
    (reading.len() == 1).then(|| reading[0])
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
    fn reads_a_union_of_encodings_by_the_one_that_reads_the_value() {
        let after = json!({ "anyOf": [{ "x-telo-type": "Telo.Duration" }, { "x-telo-type": "Telo.Timestamp" }] });
        let root = after.clone();
        let chosen = |data: Value| select_union_branch(&after, &data, &root, None)["x-telo-type"].clone();
        assert_eq!(chosen(json!("2s")), json!("Telo.Duration"));
        assert_eq!(chosen(json!("2026-01-01T00:00:00Z")), json!("Telo.Timestamp"));
        assert_eq!(chosen(json!(1500)), json!("Telo.Duration"));
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

    // Twins of `../../nodejs/tests/union-branch-pins.test.ts`.
    fn titles_of(schema: &Value, data: &Value, external: Option<&ExternalSchemaResolver<'_>>) -> Vec<String> {
        fitting_union_branches(schema, data, schema, external)
            .unwrap_or_default()
            .iter()
            .map(|branch| branch["title"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn cel(source: &str) -> Value {
        json!({ "__tagged": true, "engine": "cel", "source": source })
    }

    fn node() -> Value {
        json!({
            "type": "object",
            "oneOf": [
                { "title": "text", "required": ["type", "text"], "properties": { "type": { "enum": ["text", "badge"] } } },
                { "title": "link", "required": ["type", "text", "href"], "properties": { "type": { "const": "link" } } },
                { "title": "command", "required": ["type", "command", "text"], "properties": { "type": { "const": "command" } } },
                { "title": "bar", "required": ["type"], "properties": { "type": { "const": "bar" } } }
            ]
        })
    }

    #[test]
    fn selects_the_one_branch_a_const_tag_names() {
        let schema = json!({
            "oneOf": [
                { "title": "a", "required": ["type"], "properties": { "type": { "const": "a" } } },
                { "title": "b", "required": ["type"], "properties": { "type": { "const": "b" } } }
            ]
        });
        assert_eq!(titles_of(&schema, &json!({ "type": "b" }), None), ["b"]);
    }

    #[test]
    fn selects_the_one_branch_an_enum_tag_holds() {
        assert_eq!(titles_of(&node(), &json!({ "type": "badge", "text": "New" }), None), ["text"]);
    }

    #[test]
    fn fits_a_link_or_a_command_node_to_its_own_branch_only() {
        assert_eq!(titles_of(&node(), &json!({ "type": "link", "text": "Home", "href": "/" }), None), ["link"]);
        let command = json!({ "type": "command", "text": "Stop", "command": cel("chat.stop") });
        assert_eq!(titles_of(&node(), &command, None), ["command"]);
    }

    #[test]
    fn reads_a_branch_level_enum_for_a_scalar() {
        let schema = json!({ "anyOf": [{ "title": "mode", "enum": ["a", "b"] }, { "title": "other", "type": "string" }] });
        assert_eq!(titles_of(&schema, &json!("c"), None), ["other"]);
    }

    #[test]
    fn reads_a_tag_declared_through_a_reference() {
        let shape = json!({ "$id": "telo:M/Tag", "const": "one" });
        let schema = json!({
            "$defs": { "Two": { "const": "two" } },
            "oneOf": [
                { "title": "one", "required": ["type"], "properties": { "type": { "$ref": "telo:M/Tag" } } },
                { "title": "two", "required": ["type"], "properties": { "type": { "$ref": "#/$defs/Two" } } }
            ]
        });
        let external = |reference: &str| (reference == "telo:M/Tag").then_some(&shape);
        assert_eq!(titles_of(&schema, &json!({ "type": "two" }), Some(&external)), ["two"]);
        assert_eq!(titles_of(&schema, &json!({ "type": "one" }), Some(&external)), ["one"]);
    }

    #[test]
    fn reads_a_tag_declared_as_an_any_of_of_constants() {
        let schema = json!({
            "oneOf": [
                { "title": "ab", "required": ["type"], "properties": { "type": { "anyOf": [{ "const": "a" }, { "const": "b" }] } } },
                { "title": "c", "required": ["type"], "properties": { "type": { "const": "c" } } }
            ]
        });
        assert_eq!(titles_of(&schema, &json!({ "type": "b" }), None), ["ab"]);
    }

    #[test]
    fn fits_a_branch_that_is_itself_a_union_when_one_of_its_branches_fits() {
        let schema = json!({
            "oneOf": [
                {
                    "title": "shapes",
                    "oneOf": [
                        { "required": ["type"], "properties": { "type": { "const": "circle" } } },
                        { "required": ["type"], "properties": { "type": { "const": "square" } } }
                    ]
                },
                { "title": "line", "required": ["type"], "properties": { "type": { "const": "line" } } }
            ]
        });
        assert_eq!(titles_of(&schema, &json!({ "type": "square" }), None), ["shapes"]);
        assert_eq!(titles_of(&schema, &json!({ "type": "line" }), None), ["line"]);
    }

    #[test]
    fn reads_a_pin_in_a_branch_all_of_part() {
        let schema = json!({
            "oneOf": [
                { "title": "a", "allOf": [{ "required": ["type"] }, { "properties": { "type": { "const": "a" } } }] },
                { "title": "b", "allOf": [{ "required": ["type"] }, { "properties": { "type": { "const": "b" } } }] }
            ]
        });
        assert_eq!(titles_of(&schema, &json!({ "type": "b" }), None), ["b"]);
    }

    #[test]
    fn reads_a_pin_on_the_shared_base_under_the_branch_own() {
        let schema = json!({
            "type": "object",
            "properties": { "mode": { "enum": ["fast", "safe"] } },
            "oneOf": [
                { "title": "fast", "required": ["mode"], "properties": { "mode": { "const": "fast" } } },
                { "title": "safe", "required": ["mode"], "properties": { "mode": { "const": "safe" } } }
            ]
        });
        assert_eq!(titles_of(&schema, &json!({ "mode": "safe" }), None), ["safe"]);
    }

    #[test]
    fn compares_by_json_schema_equality() {
        let schema = json!({
            "oneOf": [
                { "title": "string", "required": ["v"], "properties": { "v": { "const": "true" } } },
                { "title": "boolean", "required": ["v"], "properties": { "v": { "const": true } } },
                { "title": "number", "required": ["v"], "properties": { "v": { "const": 1.0 } } }
            ]
        });
        assert_eq!(titles_of(&schema, &json!({ "v": true }), None), ["boolean"]);
        assert_eq!(titles_of(&schema, &json!({ "v": 1 }), None), ["number"]);
    }

    #[test]
    fn leaves_the_union_ambiguous_when_the_tag_is_an_expression() {
        assert_eq!(titles_of(&node(), &json!({ "type": cel("'bar'"), "text": "x" }), None), ["text", "bar"]);
    }
}
