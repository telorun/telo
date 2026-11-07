//! Twin of the `!cel` half of `templating/nodejs/tests/engines.test.ts`: `celEngine` and its
//! repeatability verdict. The `!sql` and `!literal` halves are their engines'.

use serde_json::json;
use telo_templating::{build_cel_environment, AnalyzeEnv, CelEngine, CelHandlers, CompileEnv, CompileOutcome, TemplatingEngine};
use telorun_cel::{CelEnvironment, PropertyMap, TypeDeclaration};
use telorun_cel_value::CelValue;

fn env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

fn evaluated(source: &str, activation: &PropertyMap<CelValue>) -> CelValue {
    let env = env();
    match CelEngine.compile(source, &CompileEnv { cel_env: &env, module_names: None }).unwrap() {
        CompileOutcome::Compiled(compiled) => compiled.call::<String>(activation, None).unwrap(),
        other => panic!("{source} compiled to {other:?}"),
    }
}

#[test]
fn treats_the_entire_source_as_a_single_cel_expression() {
    assert_eq!(evaluated("1.0 + 2.0", &PropertyMap::new()), CelValue::Double(3.0));
}

#[test]
fn evaluates_against_a_runtime_context() {
    let activation: PropertyMap<CelValue> =
        [("variables", CelValue::Record([("port", CelValue::Double(21.0))].into_iter().collect()))].into_iter().collect();
    assert_eq!(evaluated("variables.port * 2.0", &activation), CelValue::Double(42.0));
}

#[test]
fn fails_on_a_cel_syntax_error_at_compile_time() {
    let env = env();
    assert!(CelEngine.compile("variables.", &CompileEnv { cel_env: &env, module_names: None }).is_err());
}

fn codes(source: &str, env: &CelEnvironment, context: Option<&serde_json::Value>) -> Vec<(Option<String>, String)> {
    CelEngine
        .analyze(source, &AnalyzeEnv { context_schema: context, ..AnalyzeEnv::new(env) })
        .diagnostics
        .into_iter()
        .map(|diagnostic| (diagnostic.code, diagnostic.message))
        .collect()
}

#[test]
fn returns_no_diagnostics_for_a_valid_expression_with_an_open_context() {
    assert!(codes("variables.port", &env(), None).is_empty());
}

#[test]
fn reports_cel_syntax_error_with_the_parsers_message() {
    let found = codes("variables.", &env(), None);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0.as_deref(), Some("CEL_SYNTAX_ERROR"));
}

#[test]
fn reports_cel_unknown_field_when_a_chain_steps_off_a_closed_context() {
    let closed = json!({
        "type": "object",
        "properties": { "request": { "type": "object", "properties": { "name": { "type": "string" } }, "additionalProperties": false } },
        "additionalProperties": false
    });
    let found = codes("request.missing", &env(), Some(&closed));
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0.as_deref(), Some("CEL_UNKNOWN_FIELD"));
    assert!(found[0].1.contains("missing"));
}

#[test]
fn reports_a_member_the_type_checker_refused_once_not_again_off_the_context() {
    let mut typed = env();
    typed.register_variable("variables", TypeDeclaration::Fields([("db", "string".into())].into_iter().collect()), None).unwrap();
    let closed = json!({
        "type": "object",
        "properties": {
            "variables": { "type": "object", "properties": { "db": { "type": "string" } }, "additionalProperties": false },
            "resources": { "type": "object", "properties": { "db": { "type": "object" } }, "additionalProperties": false }
        }
    });
    let messages: Vec<String> =
        codes("variables.dbb + string(resources.nope)", &typed, Some(&closed)).into_iter().map(|(_, message)| message).collect();
    assert_eq!(messages, ["\"dbb\" is not declared here (declared: db)", "'resources.nope' is not defined (available: db)"]);
}

#[test]
fn ignores_well_formed_chains_against_an_open_schema() {
    let open = json!({ "type": "object", "properties": {}, "additionalProperties": true });
    assert!(codes("anything.goes.here", &env(), Some(&open)).is_empty());
}

#[test]
fn says_whether_a_text_is_repeatable_from_the_text_alone() {
    let env = env();
    assert!(CelEngine.repeatable("variables.word.lowerAscii()", &env));
    assert!(!CelEngine.repeatable("uuidv4()", &env));
    // A method on a bare identifier may be a module's, whose determinism the text does not state.
    assert!(!CelEngine.repeatable("Billing.tag(variables.word)", &env));
    assert!(!CelEngine.repeatable("variables.", &env));
}
