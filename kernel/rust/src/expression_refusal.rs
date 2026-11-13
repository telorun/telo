//! The interim refusal of an expression this kernel has no engine to evaluate, and of a
//! plain string left holding `${{`.
//!
//! No Node twin: Node compiles `!cel` / `!interpolate` / `!sql` at creation. Here a sentinel
//! of an engine holding CEL (the engine table's own `expression_regions` say so, never a tag
//! name) is refused wherever the kernel consumes the value, and nowhere else — a file read
//! but never consumed loads. A plain string holding `${{` that the loader's migration left
//! is refused there too, with `ERR_UNTAGGED_INTERPOLATION` in the words of Node's compile
//! backstop; the walk runs before `!literal` and `!include-text` resolve, so text they
//! produce is never read as one. A nested `{ kind, … }` declaration is its own to refuse
//! when it is created, the line `resolve_include_sentinels` draws.

use serde_json::Value;
use telo_analyzer::untagged_interpolation::untagged_interpolation_message;
use telo_templating::{cel_expressions_of, interpolation_shape, tagged_sentinel_parts, InterpolationShape};

use crate::error::KernelError;

/// Where a walk reports from: the resource's label (`<Kind>/<name>`) and the file it is in.
#[derive(Clone, Copy)]
pub struct Owner<'a> {
    pub label: &'a str,
    pub source: &'a str,
}

/// Refuse the first expression sentinel or untagged interpolation under `value`, naming its
/// path — `prefix` followed by the keys and indexes down to it, as the analyzer prints one
/// (`a.b[0]`). `skip` lists top-level keys of `value` consumed elsewhere.
pub fn refuse_expression_sentinels(
    owner: Owner,
    value: &Value,
    prefix: &str,
    skip: &[&str],
) -> Result<(), KernelError> {
    let mut path = prefix.to_string();
    walk(owner, value, &mut path, skip)
}

/// Refuse `value` itself, at `path`, as a member of a walked value is refused.
pub fn refuse_expression_at(owner: Owner, value: &Value, path: &str) -> Result<(), KernelError> {
    visit(owner, value, &mut path.to_string())
}

fn walk(owner: Owner, value: &Value, path: &mut String, skip: &[&str]) -> Result<(), KernelError> {
    let length = path.len();
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.truncate(length);
                path.push_str(&format!("[{index}]"));
                visit(owner, item, path)?;
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
                visit(owner, item, path)?;
            }
        }
        _ => {}
    }
    path.truncate(length);
    Ok(())
}

fn visit(owner: Owner, item: &Value, path: &mut String) -> Result<(), KernelError> {
    if let Some((engine, source)) = tagged_sentinel_parts(item) {
        if cel_expressions_of(engine, source).is_empty() {
            return Ok(());
        }
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!("{}: field `{path}` holds `!{engine}`, and this kernel has no expression engine", owner.label),
        ));
    }
    if let Value::String(text) = item {
        if interpolation_shape(text) != InterpolationShape::None {
            return Err(KernelError::new(
                "ERR_UNTAGGED_INTERPOLATION",
                format!("Failed to compile manifest in {}: {}", owner.source, untagged_interpolation_message(path)),
            ));
        }
        return Ok(());
    }
    if is_nested_declaration(item) {
        return Ok(());
    }
    walk(owner, item, path, &[])
}

fn is_nested_declaration(value: &Value) -> bool {
    value.as_object().is_some_and(|entries| entries.get("kind").and_then(Value::as_str).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OWNER: Owner = Owner { label: "X/x", source: "/m/telo.yaml" };

    fn sentinel(engine: &str, source: &str) -> Value {
        json!({ "__tagged": true, "engine": engine, "source": source })
    }

    #[test]
    fn names_the_field_the_way_the_analyzer_prints_a_path() {
        let doc = json!({ "kind": "X", "a": { "b": [1, sentinel("cel", "1 + 1")] } });
        let err = refuse_expression_sentinels(OWNER, &doc, "", &[]).expect_err("refused");
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
        refuse_expression_sentinels(OWNER, &doc, "", &["skipped"]).expect("nothing refused");
    }

    #[test]
    fn refuses_a_plain_string_left_holding_an_interpolation_in_the_compile_backstops_words() {
        let doc = json!({ "kind": "X", "a": ["ok", "costs ${{ 5"] });
        let err = refuse_expression_sentinels(OWNER, &doc, "", &[]).expect_err("refused");
        assert_eq!(err.code, "ERR_UNTAGGED_INTERPOLATION");
        assert_eq!(
            err.message,
            "Failed to compile manifest in /m/telo.yaml: 'a[1]' is a plain string holding '${{', which is never evaluated. Untagged interpolation is a legacy spelling the 'untagged-interpolation' migration rewrites (a lone hole to !cel, text with holes to !interpolate); run 'telo migrate' to apply it, or tag the value !literal if the text is meant literally."
        );
    }
}
