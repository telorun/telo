//! Twin of `templating/nodejs/tests/analyze.test.ts`, case for case.

use serde_json::{json, Value};
use telo_templating::cel::analyze::{extract_access_chains, find_nullable_access_issues, validate_chain_against_schema, NullableIssue};
use telo_templating::{build_cel_environment, CelHandlers};
use telorun_cel::CelEnvironment;

fn env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

fn chains(source: &str) -> Vec<Vec<String>> {
    extract_access_chains(&env().parse(source).root)
}

fn chain(segments: &[&str]) -> Vec<String> {
    segments.iter().map(|segment| segment.to_string()).collect()
}

fn validate(segments: &[&str], schema: &Value) -> Option<String> {
    validate_chain_against_schema(&chain(segments), schema)
}

fn issue(path: &str, member: &str) -> NullableIssue {
    NullableIssue { path: path.into(), member: member.into() }
}

// --- extractAccessChains ------------------------------------------------------

#[test]
fn returns_a_single_chain_for_a_dotted_member_access() {
    assert_eq!(chains("request.query.name"), [chain(&["request", "query", "name"])]);
}

#[test]
fn treats_bracket_index_access_as_a_sentinel_segment() {
    assert_eq!(chains("items[0].value"), [chain(&["items", "[*]", "value"])]);
}

#[test]
fn returns_multiple_chains_when_several_roots_are_referenced() {
    let found = chains("variables.a + secrets.b");
    assert!(found.contains(&chain(&["variables", "a"])));
    assert!(found.contains(&chain(&["secrets", "b"])));
}

#[test]
fn ignores_variables_bound_by_comprehension_macros() {
    let found = chains("items.filter(x, x.valid)");
    assert!(found.contains(&chain(&["items"])));
    assert!(!found.iter().any(|held| held[0] == "x"));
}

#[test]
fn descends_through_unary_operators() {
    assert_eq!(chains("!steps.parseManifest.result"), [chain(&["steps", "parseManifest", "result"])]);
    assert_eq!(chains("-counter.value"), [chain(&["counter", "value"])]);
}

#[test]
fn recovers_chains_from_inside_optional_access() {
    assert!(chains("steps.x.result.docs[?0].?kind.orValue('')").contains(&chain(&["steps", "x", "result", "docs"])));
}

// --- validateChainAgainstSchema -------------------------------------------------

fn request_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "request": {
                "type": "object",
                "properties": { "query": { "type": "object", "properties": { "name": { "type": "string" } } } }
            }
        }
    })
}

#[test]
fn returns_nothing_for_a_chain_that_resolves_cleanly_through_the_schema() {
    assert_eq!(validate(&["request", "query", "name"], &request_schema()), None);
}

#[test]
fn reports_an_unknown_leaf_field_on_a_closed_schema() {
    let closed = json!({ "type": "object", "properties": { "a": { "type": "string" } }, "additionalProperties": false });
    assert!(validate(&["b"], &closed).unwrap().contains("'b' is not defined"));
}

#[test]
fn returns_nothing_when_additional_properties_true_opens_the_parent() {
    let open = json!({ "type": "object", "properties": {}, "additionalProperties": true });
    assert_eq!(validate(&["anything"], &open), None);
}

#[test]
fn judges_nothing_below_an_index_into_an_object_that_declares_properties() {
    let settings = json!({
        "type": "object",
        "properties": {
            "settings": {
                "type": "object",
                "properties": { "theme": { "type": "object", "properties": { "mode": { "type": "string" } } } },
                "additionalProperties": { "type": "object", "properties": { "enabled": { "type": "boolean" } } }
            }
        }
    });
    assert_eq!(validate(&["settings", "[*]", "mode"], &settings), None);
}

#[test]
fn flags_member_access_past_a_live_typed_property() {
    let stream = json!({
        "type": "object",
        "properties": { "result": { "type": "object", "properties": { "output": { "x-telo-type": "Telo.Stream" } } } }
    });
    assert_eq!(validate(&["result", "output"], &stream), None);
    assert!(validate(&["result", "output", "text"], &stream).unwrap().contains("yields a stream"));
}

// --- findNullableAccessIssues -------------------------------------------------

fn nullable_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "error": { "type": ["object", "null"], "properties": { "code": { "type": "string" } }, "additionalProperties": false },
            "value": { "type": "object", "properties": { "code": { "type": "string" } } }
        }
    })
}

fn issues(source: &str) -> Vec<NullableIssue> {
    find_nullable_access_issues(&env().parse(source).root, &nullable_schema())
}

#[test]
fn flags_an_unguarded_member_access_on_a_nullable_value() {
    assert_eq!(issues("error.code"), [issue("error", "code")]);
}

#[test]
fn flags_unguarded_index_access_on_a_nullable_value() {
    assert_eq!(issues("error[0]"), [issue("error", "[index]")]);
}

#[test]
fn descends_into_an_index_expression_to_catch_a_nullable_used_as_the_index() {
    assert_eq!(issues("value[error.code]"), [issue("error", "code")]);
}

#[test]
fn does_not_flag_access_on_a_non_nullable_value() {
    assert_eq!(issues("value.code"), []);
}

#[test]
fn flags_a_member_access_on_a_union_holding_a_null_branch() {
    let union = json!({ "type": "object", "properties": { "message": { "anyOf": [{ "type": "null" }, { "type": "object" }] } } });
    assert_eq!(find_nullable_access_issues(&env().parse("message.orderId").root, &union), [issue("message", "orderId")]);
}

#[test]
fn recognises_a_not_null_guard_in_a_ternary_true_branch() {
    assert_eq!(issues("error != null ? error.code : 'x'"), []);
}

#[test]
fn recognises_an_is_null_guard_in_a_ternary_false_branch() {
    assert_eq!(issues("error == null ? 'x' : error.code"), []);
}

#[test]
fn recognises_an_and_short_circuit_guard() {
    assert_eq!(issues("error != null && error.code == 'X'"), []);
}

#[test]
fn recognises_an_or_short_circuit_guard() {
    assert_eq!(issues("error == null || error.code == 'X'"), []);
}

#[test]
fn still_flags_an_access_outside_the_guarded_branch() {
    assert_eq!(issues("error == null ? error.code : 'x'"), [issue("error", "code")]);
}

// --- cel.bind ---------------------------------------------------------------------

fn nullable_error() -> Value {
    json!({ "type": "object", "properties": { "error": { "type": ["object", "null"], "properties": { "code": { "type": "string" } } } } })
}

#[test]
fn scopes_the_bound_name_to_the_body_and_leaves_init_in_the_enclosing_scope() {
    let found = chains("cel.bind(c, request.q, string(c) + item.x)");
    assert!(found.contains(&chain(&["request", "q"])));
    assert!(found.contains(&chain(&["item", "x"])));
    assert!(!found.contains(&chain(&["c"])));
}

#[test]
fn does_not_emit_a_chain_for_the_cel_pseudo_receiver() {
    assert!(!chains("cel.bind(c, 150, string(c))").contains(&chain(&["cel"])));
}

#[test]
fn still_reports_a_name_used_in_init_which_the_binding_does_not_cover() {
    assert_eq!(chains("cel.bind(c, c, string(c))"), [chain(&["c"])]);
}

#[test]
fn resolves_both_names_when_binds_are_nested() {
    assert_eq!(chains("cel.bind(a, variables.x, cel.bind(b, a + 1, string(a) + string(b)))"), [chain(&["variables", "x"])]);
}

#[test]
fn does_not_treat_a_bound_name_as_a_nullable_context_field() {
    let root = env().parse("cel.bind(e, 1, error.code)").root;
    assert_eq!(find_nullable_access_issues(&root, &nullable_error()), [issue("error", "code")]);
}

#[test]
fn carries_a_null_guard_from_init_into_the_body() {
    let root = env().parse("error == null ? '' : cel.bind(c, 1, error.code)").root;
    assert_eq!(find_nullable_access_issues(&root, &nullable_error()), []);
}

// --- conjuncts, local references and unions -------------------------------------------

#[test]
fn reads_a_member_through_an_all_of_of_a_reference_into_the_documents_defs() {
    let contract = json!({
        "$defs": { "reached": { "type": "object", "properties": { "total": { "type": "integer" } } } },
        "type": "object",
        "properties": { "result": { "allOf": [{ "$ref": "#/$defs/reached" }] } }
    });
    let context = json!({ "type": "object", "properties": { "out": contract } });
    assert_eq!(validate(&["out", "result", "total"], &context), None);
    assert!(validate(&["out", "result", "missing"], &context)
        .unwrap()
        .contains("'out.result.missing' is not defined (available: total)"));
    let named = json!({
        "type": "object",
        "properties": { "out": { "properties": { "result": { "allOf": [{ "$ref": "telo:Lib/Shape" }] } } } }
    });
    assert_eq!(validate(&["out", "result", "missing"], &named), None);
}

fn union_context() -> (Value, Value) {
    let message = json!({ "type": "object", "additionalProperties": false, "properties": { "orderId": { "type": "string" } } });
    let context = json!({
        "type": "object",
        "properties": {
            "result": {
                "$defs": { "reached": message },
                "type": "object",
                "properties": { "message": { "anyOf": [{ "type": "null" }, { "allOf": [{ "$ref": "#/$defs/reached" }] }] } }
            }
        }
    });
    (message, context)
}

#[test]
fn reads_a_member_through_the_alternatives_that_can_hold_an_object() {
    let (_, context) = union_context();
    assert_eq!(validate(&["result", "message", "orderId"], &context), None);
    assert!(validate(&["result", "message", "orderIdd"], &context)
        .unwrap()
        .contains("'result.message.orderIdd' is not defined (available: orderId)"));
}

#[test]
fn leaves_the_chain_unjudged_when_an_alternative_is_open() {
    let (message, _) = union_context();
    let open = json!({ "type": "object", "properties": { "m": { "anyOf": [message, { "type": "object" }] } } });
    assert_eq!(validate(&["m", "anything"], &open), None);
}
