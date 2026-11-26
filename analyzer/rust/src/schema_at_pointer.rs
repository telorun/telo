//! A place inside a schema document, as a schema of its own that still reads the document:
//! what a validator is handed for a node of a larger schema, so every reference the node
//! writes names what it names where it is written. Mirrors `../../nodejs/src/schema-at-pointer.ts`.
//!
//! JSON Schema resolves a `#…` reference against the document's root, never against the node
//! holding it, so a node read out of its document and validated alone would read `#` as
//! itself. The node is instead validated where it sits: the document is carried under a
//! reserved `$defs` key, each of its local references rebased onto that place, and its hoisted
//! fragment definitions beside it at the root, where their pointers resolve. The rebasing is
//! the Node analyzer's `slotAtPointer` (`manifest-schemas.ts`), which this crate has no other
//! reader of, so it is written here.

use serde_json::{Map, Value};

/// The `$defs` key the document is carried under.
const DOCUMENT_KEY: &str = "telo-within-document";
const DOCUMENT_PLACE: &str = "#/$defs/telo-within-document";

/// Keywords whose value is data, never a schema.
const DATA_KEYWORDS: [&str; 4] = ["default", "const", "enum", "examples"];
/// Keywords whose value maps names an author chose to schemas.
const NAME_MAP_KEYWORDS: [&str; 6] =
    ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];

/// A `$defs` key the analyzer reserves for a hoisted copy of a manifest fragment.
fn is_hoisted_fragment_def_key(key: &str) -> bool {
    key.starts_with("telo:")
}

/// `slot` placed at `pointer` of a schema composed over it, each document-local reference it
/// writes (`#`, `#/$defs/A`) rebased onto `pointer`; a hoisted fragment's pointer is left to
/// resolve at the composed root.
fn slot_at_pointer(slot: &Value, pointer: &str) -> Value {
    fn rebased(reference: &str, pointer: &str) -> String {
        if reference != "#" && !reference.starts_with("#/") {
            return reference.to_string();
        }
        let mut first = reference.get(2..).unwrap_or("").split('/');
        if first.next() == Some("$defs") && first.next().is_some_and(is_hoisted_fragment_def_key) {
            return reference.to_string();
        }
        format!("{pointer}{}", &reference[1..])
    }
    fn visit(node: &Value, names: bool, pointer: &str) -> Value {
        match node {
            Value::Array(items) => Value::Array(items.iter().map(|child| visit(child, false, pointer)).collect()),
            Value::Object(map) => {
                let mut out = Map::new();
                for (key, value) in map {
                    let next = if names {
                        visit(value, false, pointer)
                    } else if key == "$ref" && value.is_string() {
                        Value::String(rebased(value.as_str().expect("a string"), pointer))
                    } else if !DATA_KEYWORDS.contains(&key.as_str()) && !key.starts_with("x-telo-") {
                        visit(value, NAME_MAP_KEYWORDS.contains(&key.as_str()), pointer)
                    } else {
                        value.clone()
                    };
                    out.insert(key.clone(), next);
                }
                Value::Object(out)
            }
            _ => node.clone(),
        }
    }
    visit(slot, false, pointer)
}

/// `document` as it is carried: no identity of its own, its local references rebased onto its
/// place, and its hoisted fragments, which stay at the root.
fn carried_document(document: &Value) -> (Value, Map<String, Value>) {
    let mut body = document.as_object().cloned().unwrap_or_default();
    // An `$id` would make the carried copy a resource of its own, against which the rebased
    // references would resolve.
    body.remove("$id");
    body.remove("$schema");
    let mut hoisted = Map::new();
    let mut keep_defs = true;
    if let Some(Value::Object(defs)) = body.get_mut("$defs") {
        let mut own = Map::new();
        for (key, value) in std::mem::take(defs) {
            if is_hoisted_fragment_def_key(&key) {
                hoisted.insert(key, value);
            } else {
                own.insert(key, value);
            }
        }
        keep_defs = !own.is_empty();
        *defs = own;
    }
    if !keep_defs {
        body.shift_remove("$defs");
    }
    (slot_at_pointer(&Value::Object(body), DOCUMENT_PLACE), hoisted)
}

/// `schema`, every local reference of which is written in `document`, as a schema that
/// compiles on its own and resolves each as `document` does. `schema` is a node of
/// `document`, or composed over nodes of it.
pub fn schema_within_document(schema: &Value, document: &Value) -> Value {
    let (body, hoisted) = carried_document(document);
    let Value::Object(mut out) = slot_at_pointer(schema, DOCUMENT_PLACE) else { return schema.clone() };
    let mut defs = match out.remove("$defs") {
        Some(Value::Object(own)) => own,
        _ => Map::new(),
    };
    defs.extend(hoisted);
    defs.insert(DOCUMENT_KEY.to_string(), body);
    out.insert("$defs".to_string(), Value::Object(defs));
    Value::Object(out)
}

/// The node at `keys` of `document` (`["properties", "tree"]`) as a schema of its own, read
/// where it sits in `document`; `document` itself for no keys.
pub fn schema_at_pointer(document: &Value, keys: &[&str]) -> Value {
    if keys.is_empty() {
        return document.clone();
    }
    // Written as every other reference in a manifest is, unencoded: the readers following a
    // `$ref` take its fragment as a JSON Pointer as written.
    let pointer = keys
        .iter()
        .map(|key| key.replace('~', "~0").replace('/', "~1"))
        .collect::<Vec<_>>()
        .join("/");
    schema_within_document(&serde_json::json!({ "$ref": format!("#/{pointer}") }), document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema_validation::{cel_value_of, SchemaValidation, SchemaValidationConfiguration};

    fn valid(schema: &Value, value: &Value) -> bool {
        let mut validation = SchemaValidation::new(SchemaValidationConfiguration::Analysis);
        validation.compile(schema).expect("compiles").validate(&cel_value_of(value)).expect("finishes").valid
    }

    #[test]
    fn a_node_reads_hash_as_its_document_s_root() {
        let document = serde_json::json!({
            "type": "object",
            "required": ["root"],
            "properties": { "tree": { "type": "object", "properties": { "next": { "$ref": "#" } } } },
            "$defs": { "Leaf": { "type": "string" } }
        });
        let tree = schema_at_pointer(&document, &["properties", "tree"]);
        assert!(valid(&tree, &serde_json::json!({ "next": { "root": 1 } })));
        assert!(!valid(&tree, &serde_json::json!({ "next": {} })));
        let leaf = schema_within_document(&serde_json::json!({ "$ref": "#/$defs/Leaf" }), &document);
        assert!(!valid(&leaf, &serde_json::json!(5)));
    }
}
