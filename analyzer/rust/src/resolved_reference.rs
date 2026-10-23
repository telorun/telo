//! What a value at a reference slot IS: a resolved reference or an inline
//! declaration. Mirrors `../../nodejs/src/resolved-reference.ts`.
//!
//! A resolved reference carries the marker `__ref: true`, written by `!ref`
//! resolution and by reading a dependency's legacy `{ kind, name }`. Every
//! other object with a string `kind` is an inline declaration, whatever else it
//! holds: a `name` decides nothing, so a kind may declare a configuration field
//! called `name`. This kernel extracts no inline declaration, so the reader is
//! the marker's half alone.
//!
//! `declares_name_field` takes the kind's author schema rather than a
//! definition and a resolver: this kernel refuses `extends`, so a kind's own
//! schema is its author schema.

use std::collections::HashSet;

use serde_json::Value;

use crate::manifest_navigation::resolve_schema_pointer;

/// The key a resolved reference is marked with. An author never writes it.
pub const RESOLVED_REFERENCE_MARKER: &str = "__ref";

/// True when `value` is a resolved reference — read off the marker alone.
pub fn is_resolved_reference(value: &Value) -> bool {
    value.get(RESOLVED_REFERENCE_MARKER).and_then(Value::as_bool) == Some(true)
        && value.get("kind").is_some_and(Value::is_string)
        && value.get("name").is_some_and(Value::is_string)
}

/// True when an author wrote the marker key themselves.
pub fn carries_reference_marker(value: &Value) -> bool {
    value.as_object().is_some_and(|object| object.contains_key(RESOLVED_REFERENCE_MARKER))
}

/// True when a kind's author schema declares a top-level `name` property: in
/// its own `properties`, or in those of a node it is through a local `$ref`,
/// an `allOf` conjunct or an `anyOf` / `oneOf` branch. What it decides is which
/// spelling an object holding a `name` is — for a kind declaring none, the
/// legacy `{ kind, name }` reference form.
pub fn declares_name_field(author_schema: &Value) -> bool {
    declares_top_level(author_schema, "name")
}

fn declares_top_level(root: &Value, key: &str) -> bool {
    let mut seen: HashSet<*const Value> = HashSet::new();
    let mut pending: Vec<&Value> = vec![root];
    while let Some(node) = pending.pop() {
        if !node.is_object() || !seen.insert(node as *const Value) {
            continue;
        }
        if node.get("properties").and_then(Value::as_object).is_some_and(|p| p.contains_key(key)) {
            return true;
        }
        if let Some(target) = node
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|reference| resolve_schema_pointer(root, reference))
        {
            pending.push(target);
        }
        for keyword in ["allOf", "anyOf", "oneOf"] {
            pending.extend(node.get(keyword).and_then(Value::as_array).into_iter().flatten());
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_marker_alone_tells_a_reference() {
        let marked = json!({ "__ref": true, "kind": "fx.Named", "name": "house" });
        let written = json!({ "kind": "fx.Named", "name": "house" });
        assert!(is_resolved_reference(&marked));
        assert!(!is_resolved_reference(&written));
    }

    #[test]
    fn reads_a_name_field_through_references_conjuncts_and_branches() {
        let own = json!({ "properties": { "name": { "type": "string" } } });
        let through_ref = json!({
            "$ref": "#/$defs/Shape",
            "$defs": { "Shape": { "properties": { "name": { "type": "string" } } } }
        });
        let through_conjunct = json!({
            "allOf": [{ "$ref": "#/$defs/Named" }],
            "$defs": { "Named": { "properties": { "name": { "type": "string" } } } }
        });
        let through_branch = json!({
            "anyOf": [{ "properties": { "path": {} } }, { "properties": { "name": {} } }]
        });
        let nested = json!({ "properties": { "inner": { "properties": { "name": {} } } } });
        let looping = json!({ "$ref": "#", "allOf": [{ "$ref": "#" }] });
        assert!(declares_name_field(&own));
        assert!(declares_name_field(&through_ref));
        assert!(declares_name_field(&through_conjunct));
        assert!(declares_name_field(&through_branch));
        assert!(!declares_name_field(&nested));
        assert!(!declares_name_field(&looping));
    }
}
