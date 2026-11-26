//! The values a `Telo.Import` hands its library. Mirrors `../../nodejs/src/import-input-values.ts`.
//!
//! Its `variables:`, its `secrets:` and every need it supplies field by field are read when the
//! import initializes, in the importing module, so a file tag written there is a value as at a
//! resource field; every other field of the import is not one.

use serde_json::Value;
use telo_templating::is_tagged_sentinel;

/// Each input value of `import_doc` with its dotted path, in Node's order.
pub fn import_input_values(import_doc: &Value) -> Vec<(String, &Value)> {
    let mut out = Vec::new();
    for block in ["variables", "secrets"] {
        if let Some(value) = import_doc.get(block) {
            out.push((block.to_string(), value));
        }
    }
    if let Some(needs) = import_doc.get("needs").and_then(Value::as_object) {
        for (name, supply) in needs {
            // A whole supply is a `!ref`; a field-by-field one is a map of fields.
            if supply.is_object() && !is_tagged_sentinel(supply) {
                out.push((format!("needs.{name}"), supply));
            }
        }
    }
    out
}

/// The dotted paths of [`import_input_values`].
pub fn import_input_value_paths(import_doc: &Value) -> Vec<String> {
    import_input_values(import_doc).into_iter().map(|(path, _)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use telo_templating::{make_tagged_sentinel, MODULE_PATH_ENGINE, REF_ENGINE};

    #[test]
    fn lists_the_blocks_and_the_needs_supplied_field_by_field() {
        let import = json!({
            "kind": "Telo.Import",
            "metadata": { "name": "Lib" },
            "source": "./lib",
            "variables": { "root": make_tagged_sentinel(MODULE_PATH_ENGINE, "./a") },
            "needs": { "whole": make_tagged_sentinel(REF_ENGINE, "dir"), "fields": { "path": "/srv" } },
            "runtime": "nodejs",
        });
        assert_eq!(import_input_value_paths(&import), ["variables", "needs.fields"]);
    }
}
