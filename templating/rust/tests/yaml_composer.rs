//! The composer's behaviours no tag-conformance row can pin: those whose JSON text or whose
//! refusal is the Rust reader's alone, and the bounds that keep it off the stack.

use serde_json::{json, Value};
use telo_templating::{
    compose_yaml, document_to_json, JsonRefusal, ReadFailure, TagRefusal, UnsupportedConstruct, YamlErrorKind,
};

fn load(text: &str) -> (Vec<ReadFailure>, Result<Option<Value>, JsonRefusal>) {
    let stream = compose_yaml(text);
    let kinds = stream.errors.iter().map(|error| error.failure.clone()).collect();
    (kinds, document_to_json(&stream.documents[0]))
}

#[test]
fn a_key_written_twice_keeps_its_first_place_and_its_last_value() {
    let (errors, json) = load("a: 1\nb: 2\na: 3\n");
    assert_eq!(errors, vec![ReadFailure::Yaml(YamlErrorKind::DuplicateKey)]);
    assert_eq!(serde_json::to_string(&json.unwrap().unwrap()).unwrap(), r#"{"a":3,"b":2}"#);
}

#[test]
fn keys_are_duplicates_by_value_not_by_spelling() {
    // `yaml` compares key scalars with `===`: `1` and `1.0` are one number, `1` and `"1"`
    // a number and a string.
    assert_eq!(load("1: a\n1.0: b\n").0, vec![ReadFailure::Yaml(YamlErrorKind::DuplicateKey)]);
    assert_eq!(load("1: a\n\"1\": b\n").0, vec![]);
    assert_eq!(load("~: a\nnull: b\n").0, vec![ReadFailure::Yaml(YamlErrorKind::DuplicateKey)]);
}

#[test]
fn an_integer_past_double_precision_is_the_double_node_reads() {
    let (_, json) = load("a: 9007199254740993\n");
    assert_eq!(json.unwrap().unwrap()["a"], json!(9007199254740992_i64));
}

#[test]
fn a_non_finite_number_has_no_json_tree() {
    for text in ["a: .inf\n", "a: -.Inf\n", "a: .nan\n"] {
        match load(text).1 {
            Err(JsonRefusal::Tag(error)) => assert!(
                matches!(error.refusal, TagRefusal::Unsupported(UnsupportedConstruct::NonFiniteNumber { .. })),
                "{error}"
            ),
            other => panic!("{text}: {other:?}"),
        }
    }
}

#[test]
fn an_alias_inside_its_own_anchor_is_refused() {
    match load("a: &x [1, *x]\n").1 {
        Err(JsonRefusal::Tag(error)) => {
            assert_eq!(error.refusal, TagRefusal::Unsupported(UnsupportedConstruct::SelfContainingAlias))
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn nesting_of_any_depth_composes_and_a_tree_past_the_bound_is_refused() {
    let mut block = String::new();
    for level in 0..2_000 {
        block.push_str(&" ".repeat(level));
        block.push_str("k:\n");
    }
    let (errors, json) = load(&block);
    assert_eq!(errors, vec![]);
    assert!(matches!(json, Err(JsonRefusal::Tag(error)) if error.refusal == TagRefusal::Unsupported(UnsupportedConstruct::TreeDepth)));

    let flow = format!("a: {}{}\n", "[".repeat(200), "]".repeat(200));
    let (errors, json) = load(&flow);
    assert_eq!(errors, vec![]);
    assert!(matches!(json, Err(JsonRefusal::Tag(error)) if error.refusal == TagRefusal::Unsupported(UnsupportedConstruct::TreeDepth)));
}

#[test]
fn flow_nesting_past_the_parser_s_bound_is_refused_as_too_deep() {
    let flow = format!("a: {}{}\n", "[".repeat(200_000), "]".repeat(200_000));
    assert_eq!(
        compose_yaml(&flow).errors.iter().map(|error| error.failure.clone()).collect::<Vec<_>>(),
        vec![ReadFailure::Unsupported(UnsupportedConstruct::FlowDepth)]
    );
}

#[test]
fn an_alias_copying_a_deep_tree_is_held_to_the_bound() {
    let deep = format!("{}1{}", "[".repeat(100), "]".repeat(100));
    let text = format!("a: &d {deep}\nb: {}*d{}\n", "[".repeat(60), "]".repeat(60));
    assert!(matches!(load(&text).1, Err(JsonRefusal::Tag(error)) if error.refusal == TagRefusal::Unsupported(UnsupportedConstruct::TreeDepth)));
}
