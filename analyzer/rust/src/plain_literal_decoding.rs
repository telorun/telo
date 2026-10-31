//! The walk over a value's text leaves, each paired with the schema node it sits
//! at. Mirrors `mapTextLeaves` in `../../nodejs/src/plain-literal-decoding.ts`,
//! read-only: this crate decodes no plain encodings yet, so its one use is a
//! question about each leaf (is this host path absolute? does it name what its
//! slot says?), and the walk stops where Node's does — at a reference slot and
//! at a tagged sentinel — choosing the same union branch.

use serde_json::Value;
use telo_templating::is_tagged_sentinel;

use crate::schema_compat::{collect_properties, resolve_ref_in, select_union_branch, ExternalSchemaResolver};

const NOTHING: Value = Value::Null;

/// Call `leaf` with every string under `value`, the schema node it sits at and
/// its JSON Pointer from `value`'s root, stopping at the first error.
pub fn walk_text_leaves<'s, E>(
    value: &Value,
    schema: &'s Value,
    leaf: &mut dyn FnMut(&Value, &str, &str) -> Result<(), E>,
    external: Option<&ExternalSchemaResolver<'s>>,
) -> Result<(), E> {
    walk(value, schema, schema, "", leaf, external)
}

fn walk<'s: 'a, 'a, E>(
    node: &Value,
    raw: &'a Value,
    root: &'a Value,
    pointer: &str,
    leaf: &mut dyn FnMut(&Value, &str, &str) -> Result<(), E>,
    external: Option<&ExternalSchemaResolver<'s>>,
) -> Result<(), E> {
    let (entered, entered_root) = resolve_ref_in(raw, root, external);
    let selected = select_union_branch(entered, node, entered_root, external);
    let (here, root) = resolve_ref_in(&selected, entered_root, external);

    if let Value::String(text) = node {
        return leaf(here, text, pointer);
    }
    if !node.is_array() && !node.is_object() {
        return Ok(());
    }
    if here.get("x-telo-ref").is_some() || is_tagged_sentinel(node) {
        return Ok(());
    }
    if let Value::Array(items) = node {
        let (item, item_root) = resolve_ref_in(here.get("items").unwrap_or(&NOTHING), root, external);
        for (i, child) in items.iter().enumerate() {
            walk(child, item, item_root, &format!("{pointer}/{i}"), leaf, external)?;
        }
        return Ok(());
    }
    let Value::Object(entries) = node else {
        return Ok(());
    };
    let properties = collect_properties(here);
    let additional = here.get("additionalProperties").filter(|a| a.is_object());
    for (key, child) in entries {
        let Some(child_schema) = properties.get(key).or(additional) else {
            continue;
        };
        let escaped = key.replace('~', "~0").replace('/', "~1");
        walk(child, child_schema, root, &format!("{pointer}/{escaped}"), leaf, external)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn leaves(value: &Value, schema: &Value) -> Vec<(String, String, Value)> {
        let mut out = Vec::new();
        walk_text_leaves::<()>(
            value,
            schema,
            &mut |slot, text, pointer| {
                out.push((pointer.to_string(), text.to_string(), slot.clone()));
                Ok(())
            },
            None,
        )
        .unwrap();
        out
    }

    #[test]
    fn pairs_each_leaf_with_its_slot_through_references_and_arrays() {
        let schema = json!({
            "type": "object",
            "$defs": { "P": { "type": "string", "x-telo-type": "Telo.HostPath" } },
            "properties": {
                "roots": { "type": "array", "items": { "$ref": "#/$defs/P" } },
                "a/b": { "type": "string" }
            }
        });
        let found = leaves(&json!({ "roots": ["/x"], "a/b": "t" }), &schema);
        assert_eq!(
            found,
            // In written order, as the Node half walks it.
            vec![
                ("/roots/0".into(), "/x".into(), json!({ "type": "string", "x-telo-type": "Telo.HostPath" })),
                ("/a~1b".into(), "t".into(), json!({ "type": "string" })),
            ]
        );
    }

    #[test]
    fn stops_at_a_reference_slot_and_a_tagged_sentinel() {
        let schema = json!({
            "type": "object",
            "properties": {
                "target": { "type": "object", "x-telo-ref": "Self.X" },
                "file": { "type": "string" }
            }
        });
        let value = json!({
            "target": { "name": "x" },
            "file": { "__tagged": true, "engine": "module-path", "source": "./a" }
        });
        assert!(leaves(&value, &schema).is_empty());
    }

    #[test]
    fn reads_an_undeclared_key_by_additional_properties_only() {
        let schema = json!({ "type": "object", "additionalProperties": { "type": "string", "title": "any" } });
        let found = leaves(&json!({ "k": "v" }), &schema);
        assert_eq!(found[0].2, json!({ "type": "string", "title": "any" }));
        assert!(leaves(&json!({ "k": "v" }), &json!({ "type": "object" })).is_empty());
    }
}
