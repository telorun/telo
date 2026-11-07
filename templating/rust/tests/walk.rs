//! Twin of `templating/nodejs/tests/walk.test.ts` — the walk over a manifest value for its
//! tagged scalars.
//!
//! Node cases with no twin: the live instance with a cyclic graph, and the null-prototype
//! object — a `serde_json::Value` holds neither. A deep-nesting case replaces them: the walk
//! keeps a work list.

use serde_json::{json, Value};
use telo_templating::{make_tagged_sentinel, walk_cel_expressions};

fn collect(value: &Value) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    walk_cel_expressions(value, "", &mut |source, path, engine| out.push((source.into(), path.into(), engine.into())));
    out
}

fn found(source: &str, path: &str, engine: &str) -> (String, String, String) {
    (source.into(), path.into(), engine.into())
}

#[test]
fn never_reads_a_plain_string_as_an_expression() {
    assert!(collect(&json!({ "greeting": "Hello ${{ variables.name }}!" })).is_empty());
}

#[test]
fn recurses_into_arrays_with_index_segments_in_the_path() {
    let value = json!({ "steps": [{ "x": make_tagged_sentinel("cel", "a") }, { "x": make_tagged_sentinel("cel", "b") }] });
    assert_eq!(collect(&value), [found("a", "steps[0].x", "cel"), found("b", "steps[1].x", "cel")]);
}

#[test]
fn emits_the_source_of_a_cel_sentinel() {
    assert_eq!(collect(&json!({ "port": make_tagged_sentinel("cel", "variables.port") })), [found("variables.port", "port", "cel")]);
}

#[test]
fn emits_the_source_of_a_literal_sentinel() {
    let value = json!({ "greeting": make_tagged_sentinel("literal", "Hello ${{ x }}") });
    assert_eq!(collect(&value), [found("Hello ${{ x }}", "greeting", "literal")]);
}

#[test]
fn emits_unknown_engine_sentinels_for_forward_compat_dispatch() {
    assert_eq!(collect(&json!({ "x": make_tagged_sentinel("future-engine", "expr") })), [found("expr", "x", "future-engine")]);
}

#[test]
fn skips_compiled_values_to_avoid_rewalking_precompiled_trees() {
    let compiled = json!({ "__compiled": true, "source": "x", "nested": make_tagged_sentinel("cel", "y") });
    assert!(collect(&json!({ "field": compiled })).is_empty());
}

#[test]
fn returns_no_callbacks_for_plain_primitives() {
    assert!(collect(&json!({ "port": 8080, "host": "localhost", "flag": true })).is_empty());
}

#[test]
fn does_not_double_emit_when_a_sentinel_sits_inside_a_deeply_nested_array() {
    let value = json!({
        "routes": [
            { "handler": { "body": make_tagged_sentinel("cel", "request.query.name") } },
            { "handler": { "body": "literal" } },
        ]
    });
    assert_eq!(collect(&value), [found("request.query.name", "routes[0].handler.body", "cel")]);
}

#[test]
fn visits_in_document_order_and_starts_from_the_given_path() {
    let value = json!({ "b": make_tagged_sentinel("cel", "1"), "a": [make_tagged_sentinel("cel", "2")], "c": make_tagged_sentinel("cel", "3") });
    let mut out = Vec::new();
    walk_cel_expressions(&value, "doc", &mut |source, path, _| out.push(format!("{path}={source}")));
    assert_eq!(out, ["doc.b=1", "doc.a[0]=2", "doc.c=3"]);
}

#[test]
fn walks_a_value_nested_far_deeper_than_a_stack_holds() {
    let mut value = make_tagged_sentinel("cel", "deep");
    for _ in 0..100_000 {
        value = Value::Array(vec![value]);
    }
    let mut count = 0;
    walk_cel_expressions(&value, "", &mut |source, _, _| {
        assert_eq!(source, "deep");
        count += 1;
    });
    assert_eq!(count, 1);
    // Dropping a value this deep recurses too; leak it rather than overflow the test.
    std::mem::forget(value);
}
