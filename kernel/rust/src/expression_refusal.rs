//! The interim refusal of an expression this kernel has no engine to evaluate.
//!
//! No Node twin: Node compiles `!cel` / `!interpolate` / `!sql` at creation. Here a sentinel
//! of an engine holding CEL (the engine table's own `expression_regions` say so, never a tag
//! name) is refused wherever the kernel consumes the value, and nowhere else — a file read
//! but never consumed loads. A nested `{ kind, … }` declaration is its own to refuse when
//! it is created, the line `resolve_include_sentinels` draws.

use serde_json::Value;
use telo_templating::{cel_expressions_of, tagged_sentinel_parts};

use crate::error::KernelError;

/// Refuse the first expression sentinel under `value`, naming `label` (`<Kind>/<name>`) and
/// its path — `prefix` followed by the keys and indexes down to it, as the analyzer prints
/// one (`a.b[0]`). `skip` lists top-level keys of `value` consumed elsewhere.
pub fn refuse_expression_sentinels(
    label: &str,
    value: &Value,
    prefix: &str,
    skip: &[&str],
) -> Result<(), KernelError> {
    let mut path = prefix.to_string();
    walk(label, value, &mut path, skip)
}

fn walk(label: &str, value: &Value, path: &mut String, skip: &[&str]) -> Result<(), KernelError> {
    let length = path.len();
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.truncate(length);
                path.push_str(&format!("[{index}]"));
                visit(label, item, path)?;
            }
        }
        Value::Object(entries) => {
            for (key, item) in entries {
                if skip.contains(&key.as_str()) {
                    continue;
                }
                path.truncate(length);
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(key);
                visit(label, item, path)?;
            }
        }
        _ => {}
    }
    path.truncate(length);
    Ok(())
}

fn visit(label: &str, item: &Value, path: &mut String) -> Result<(), KernelError> {
    if let Some((engine, source)) = tagged_sentinel_parts(item) {
        if cel_expressions_of(engine, source).is_empty() {
            return Ok(());
        }
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!("{label}: field `{path}` holds `!{engine}`, and this kernel has no expression engine"),
        ));
    }
    if is_nested_declaration(item) {
        return Ok(());
    }
    walk(label, item, path, &[])
}

fn is_nested_declaration(value: &Value) -> bool {
    value.as_object().is_some_and(|entries| entries.get("kind").and_then(Value::as_str).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sentinel(engine: &str, source: &str) -> Value {
        json!({ "__tagged": true, "engine": engine, "source": source })
    }

    #[test]
    fn names_the_field_the_way_the_analyzer_prints_a_path() {
        let doc = json!({ "kind": "X", "a": { "b": [1, sentinel("cel", "1 + 1")] } });
        let err = refuse_expression_sentinels("X/x", &doc, "", &[]).expect_err("refused");
        assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE");
        assert_eq!(err.message, "X/x: field `a.b[1]` holds `!cel`, and this kernel has no expression engine");
    }

    #[test]
    fn leaves_markers_that_hold_no_expression_and_nested_declarations_alone() {
        let doc = json!({
            "kind": "X",
            "r": sentinel("ref", "Other"),
            "t": sentinel("include-text", "a.txt"),
            "nested": { "kind": "Y", "v": sentinel("cel", "1") },
            "skipped": sentinel("cel", "1"),
        });
        refuse_expression_sentinels("X/x", &doc, "", &["skipped"]).expect("nothing refused");
    }
}
