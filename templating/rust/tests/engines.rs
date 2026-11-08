//! Twin of `templating/nodejs/tests/engines.test.ts`: `celEngine`, `sqlEngine`, `literalEngine`
//! and the repeatability verdict, at commit `2093db60` under Node v24.21.0.
//!
//! Node cases with no twin: a JavaScript number as a binding (`7`, `"x"`) — the sql cases bind
//! typed values; and `literalEngine.language` being `undefined`, which is `None`.

use serde_json::json;
use telo_templating::{
    build_cel_environment, produced_type_of, repeatable_source, AnalyzeEnv, CelEngine, CelHandlers, CompileEnv, CompileOutcome,
    LiteralEngine, SqlEngine, TemplatingEngine,
};
use telorun_sdk_core::compiled_value::ParameterizedSql;
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

fn sql_value(source: &str, activation: &PropertyMap<CelValue>) -> ParameterizedSql {
    let value = evaluated_by(&SqlEngine, source, activation);
    ParameterizedSql::from_value(&value).expect("a parameterized record")
}

fn evaluated_by(engine: &dyn TemplatingEngine, source: &str, activation: &PropertyMap<CelValue>) -> CelValue {
    let env = env();
    match engine.compile(source, &CompileEnv { cel_env: &env, module_names: None }).unwrap() {
        CompileOutcome::Compiled(compiled) => compiled.call::<String>(activation, None).unwrap(),
        other => panic!("{source} compiled to {other:?}"),
    }
}

fn variables(entries: Vec<(&'static str, CelValue)>) -> PropertyMap<CelValue> {
    [("variables", CelValue::Record(entries.into_iter().collect()))].into_iter().collect()
}

#[test]
fn sql_evaluates_to_a_parameterized_value_not_a_joined_string() {
    let result = sql_value(
        "WHERE id = ${{ variables.id }} AND n = ${{ variables.n }}",
        &variables(vec![("id", CelValue::Int(7)), ("n", CelValue::String("x".into()))]),
    );
    assert_eq!(result.fragments, ["WHERE id = ", " AND n = ", ""]);
    assert_eq!(result.values, [CelValue::Int(7), CelValue::String("x".into())]);
}

#[test]
fn sql_keeps_a_value_with_a_quote_intact() {
    let result = sql_value("name = ${{ variables.name }}", &variables(vec![("name", CelValue::String("O'Brien".into()))]));
    assert_eq!(result.values, [CelValue::String("O'Brien".into())]);
}

#[test]
fn sql_handles_a_plain_string_with_no_interpolation() {
    let result = sql_value("SELECT 1", &PropertyMap::new());
    assert_eq!(result.fragments, ["SELECT 1"]);
    assert!(result.values.is_empty());
}

fn sql_codes(source: &str, env: &CelEnvironment, context: Option<&serde_json::Value>) -> Vec<Option<String>> {
    SqlEngine
        .analyze(source, &AnalyzeEnv { context_schema: context, ..AnalyzeEnv::new(env) })
        .diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.code)
        .collect()
}

#[test]
fn sql_reports_a_syntax_error_for_a_malformed_interpolation() {
    assert_eq!(sql_codes("SELECT ${{ variables. }}", &env(), None), [Some("CEL_SYNTAX_ERROR".to_string())]);
}

#[test]
fn sql_reports_an_unknown_field_when_an_interpolation_steps_off_a_closed_context() {
    let closed = json!({
        "type": "object",
        "properties": { "request": { "type": "object", "properties": { "name": { "type": "string" } }, "additionalProperties": false } },
        "additionalProperties": false
    });
    assert_eq!(sql_codes("SELECT ${{ request.missing }}", &env(), Some(&closed)), [Some("CEL_UNKNOWN_FIELD".to_string())]);
}

#[test]
fn literal_compiles_to_the_source_verbatim_including_hole_text() {
    let env = env();
    for source in ["Hello ${{ x }}", ""] {
        match LiteralEngine.compile(source, &CompileEnv { cel_env: &env, module_names: None }).unwrap() {
            CompileOutcome::Resolved(value) => assert_eq!(value, json!(source)),
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn literal_analyzes_to_no_diagnostics_and_declares_it_produces_a_string() {
    let env = env();
    assert!(LiteralEngine.analyze("anything", &AnalyzeEnv::new(&env)).diagnostics.is_empty());
    assert_eq!(LiteralEngine.language(), None);
    assert_eq!(LiteralEngine.produced_type(), Some(json!({ "type": "string" })));
    assert_eq!(produced_type_of("literal"), Some(json!({ "type": "string" })));
}

#[test]
fn repeatable_source_is_the_engines_verdict_on_the_text_alone() {
    let env = env();
    assert!(repeatable_source("cel", "variables.word.lowerAscii()", &env));
    assert!(!repeatable_source("cel", "uuidv4()", &env));
    assert!(!repeatable_source("cel", "Billing.tag(variables.word)", &env));
    assert!(!repeatable_source("cel", "variables.", &env));
    assert!(repeatable_source("interpolate", "a-${{ variables.word }}", &env));
    assert!(!repeatable_source("interpolate", "a-${{ variables.word }}-${{ uuidv4() }}", &env));
    assert!(!repeatable_source("interpolate", "a-${{ variables.word", &env));
    assert!(!repeatable_source("literal", "text", &env));
}
