//! The one pass a value takes where this kernel consumes it: a twin of Node's precompile.
//!
//! No Node twin as a file: Node compiles every tagged sentinel when a file is loaded and
//! evaluates the result. Here each sentinel is compiled through the engine table and the
//! engine's own answer decides what happens — a `Compiled` value is an expression this
//! kernel has no engine to evaluate and is refused (`ERR_UNSUPPORTED_MANIFEST_FEATURE`), a
//! `Resolved` one (`!literal`) is replaced by its value, an `Unchanged` one (`!ref`,
//! `!include-*`, `!module-path`) is left for its own resolver, and a compile refusal
//! (a hole-less `!interpolate`, an unreadable expression) propagates with the engine's
//! message. No tag is recognised by name.
//!
//! A value is consumed where it is read — a resource at creation, a kind document at
//! registration, a module-doc field, a `targets:` entry when it runs, an import's supplied
//! `variables:` / `secrets:` — and a file read but never consumed is not walked. The walk
//! descends into every object under a consumed value; it skips exactly the positions the
//! kernel itself extracts and creates as resources of their own, which today are none.
//!
//! A plain string left holding `${{` after the loader's migration is refused with
//! `ERR_UNTAGGED_INTERPOLATION` in the words of Node's compile backstop. Only authored
//! plain strings are read as one: a sentinel is replaced where it stands, so the text a
//! `!literal` produces is never walked.

use serde_json::Value;
use telo_analyzer::untagged_interpolation::untagged_interpolation_message;
use telo_templating::{
    build_cel_language_environment, default_registry, interpolation_shape, is_tagged_sentinel,
    tagged_sentinel_parts, CelEnvironment, CompileEnv, CompileOutcome, InterpolationShape,
};

use crate::error::KernelError;

thread_local! {
    /// The CEL language environment every compile is handed, built on first use: the
    /// engines that resolve a text never read it.
    static LANGUAGE: CelEnvironment = build_cel_language_environment();
}

/// Where a walk reports from: the resource's label (`<Kind>/<name>`) and the file it is in.
#[derive(Clone, Copy)]
pub struct Owner<'a> {
    pub label: &'a str,
    pub source: &'a str,
}

/// Take every sentinel and untagged interpolation under `value` through the pass, naming a
/// path as the analyzer prints one (`a.b[0]`) after `prefix`. `skip` lists top-level keys
/// of `value` consumed elsewhere.
pub fn compile_sentinels(
    owner: Owner,
    value: &mut Value,
    prefix: &str,
    skip: &[&str],
) -> Result<(), KernelError> {
    let mut path = prefix.to_string();
    walk(owner, value, &mut path, skip)
}

/// Take `value` itself, at `path`, through the pass as a member of a walked value is.
pub fn compile_sentinels_at(owner: Owner, value: &mut Value, path: &str) -> Result<(), KernelError> {
    visit(owner, value, &mut path.to_string())
}

fn walk(owner: Owner, value: &mut Value, path: &mut String, skip: &[&str]) -> Result<(), KernelError> {
    let length = path.len();
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                path.truncate(length);
                path.push_str(&format!("[{index}]"));
                visit(owner, item, path)?;
            }
        }
        Value::Object(entries) => {
            for (key, item) in entries.iter_mut() {
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

fn visit(owner: Owner, item: &mut Value, path: &mut String) -> Result<(), KernelError> {
    if let Some((engine, source)) = tagged_sentinel_parts(item).map(|(e, s)| (e.to_string(), s.to_string())) {
        return compile(owner, item, path, &engine, &source);
    }
    if is_tagged_sentinel(item) {
        return Ok(());
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
    walk(owner, item, path, &[])
}

fn compile(owner: Owner, item: &mut Value, path: &str, engine: &str, source: &str) -> Result<(), KernelError> {
    // A tag no engine claims is opaque here, as the reader refuses an unknown one earlier.
    let Some(table_engine) = default_registry().get(engine) else { return Ok(()) };
    let outcome = LANGUAGE
        .with(|cel_env| table_engine.compile(source, &CompileEnv { cel_env, module_names: None }))
        .map_err(|err| {
            KernelError::manifest_validation_failed(format!(
                "Failed to compile manifest in {}: {}: field `{path}`: {err}",
                owner.source, owner.label
            ))
        })?;
    match outcome {
        CompileOutcome::Compiled(_) => Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!("{}: field `{path}` holds `!{engine}`, and this kernel has no expression engine", owner.label),
        )),
        CompileOutcome::Resolved(value) => {
            *item = value;
            Ok(())
        }
        CompileOutcome::Unchanged => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OWNER: Owner = Owner { label: "X/x", source: "/m/telo.yaml" };

    fn sentinel(engine: &str, source: &str) -> Value {
        json!({ "__tagged": true, "engine": engine, "source": source })
    }

    fn refused(mut doc: Value) -> KernelError {
        compile_sentinels(OWNER, &mut doc, "", &[]).expect_err("refused")
    }

    #[test]
    fn names_the_field_the_way_the_analyzer_prints_a_path() {
        let err = refused(json!({ "kind": "X", "a": { "b": [1, sentinel("cel", "1 + 1")] } }));
        assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE");
        assert_eq!(err.message, "X/x: field `a.b[1]` holds `!cel`, and this kernel has no expression engine");
    }

    #[test]
    fn refuses_an_expression_inside_a_nested_declaration_with_the_path_through_it() {
        let err = refused(json!({ "kind": "X", "nested": { "kind": "Y", "v": [sentinel("interpolate", "a ${{ b }}")] } }));
        assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE");
        assert_eq!(err.message, "X/x: field `nested.v[0]` holds `!interpolate`, and this kernel has no expression engine");
    }

    #[test]
    fn a_hole_less_interpolate_or_sql_is_an_expression_and_an_unreadable_one_the_engines_refusal() {
        for engine in ["interpolate", "sql"] {
            let err = refused(json!({ "kind": "X", "a": sentinel(engine, "no holes here") }));
            assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
            let err = refused(json!({ "kind": "X", "a": sentinel(engine, "unclosed ${{ 1") }));
            assert_eq!(err.code, "ERR_MANIFEST_VALIDATION_FAILED", "{err}");
            assert!(err.message.starts_with("Failed to compile manifest in /m/telo.yaml: X/x: field `a`: "), "{err}");
            assert!(err.message.contains(&format!("!{engine}")), "{err}");
        }
    }

    #[test]
    fn resolves_a_literal_at_any_depth_and_leaves_the_other_markers_alone() {
        let mut doc = json!({
            "kind": "X",
            "r": sentinel("ref", "Other"),
            "t": sentinel("include-text", "a.txt"),
            "deep": { "kind": "Y", "list": [sentinel("literal", "${{ not an expression }}")] },
            "skipped": sentinel("cel", "1"),
        });
        compile_sentinels(OWNER, &mut doc, "", &["skipped"]).expect("nothing refused");
        assert_eq!(doc["deep"]["list"][0], json!("${{ not an expression }}"));
        assert_eq!(doc["r"], sentinel("ref", "Other"));
        assert_eq!(doc["t"], sentinel("include-text", "a.txt"));
    }

    #[test]
    fn refuses_a_plain_string_left_holding_an_interpolation_in_the_compile_backstops_words() {
        let err = refused(json!({ "kind": "X", "a": ["ok", "costs ${{ 5"] }));
        assert_eq!(err.code, "ERR_UNTAGGED_INTERPOLATION");
        assert_eq!(
            err.message,
            "Failed to compile manifest in /m/telo.yaml: 'a[1]' is a plain string holding '${{', which is never evaluated. Untagged interpolation is a legacy spelling the 'untagged-interpolation' migration rewrites (a lone hole to !cel, text with holes to !interpolate); run 'telo migrate' to apply it, or tag the value !literal if the text is meant literally."
        );
    }
}
