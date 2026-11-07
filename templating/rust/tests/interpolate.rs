//! Twin of `templating/nodejs/tests/interpolate.test.ts` — the `!interpolate` and `!sql`
//! engines. Its reader half (`readInterpolationHoles`, `interpolationShape`) is
//! `interpolation_holes.rs`'s.
//!
//! The expectations are the Node tests', which pass at commit `2093db60` under Node v24.21.0.
//!
//! Node cases with no twin: the Symbol-returning function, the one way Node meets a value of
//! no CEL type. Here the domain is a closed union, so only a host object of no CEL type can
//! take that branch, and that case stands in for it.

use std::sync::Arc;

use serde_json::json;
use telo_templating::{
    build_cel_environment, cel_expressions_of, AnalyzeEnv, CallError, CelHandlers, CompileEnv, CompileOutcome,
    InterpolateEngine, SqlEngine, TemplatingEngine, TemplatingError,
};
use telorun_cel::{CelEnvironment, EvaluateOptions, PropertyMap};
use telorun_cel_value::{CelHostValue, CelValue};
use telorun_sdk_core::compiled_value::ParameterizedSql;

fn env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

fn value_of(source: &str, env: &CelEnvironment) -> CelValue {
    env.evaluate(source, &PropertyMap::new(), &EvaluateOptions::default()).unwrap()
}

fn run(engine: &dyn TemplatingEngine, source: &str, activation: &PropertyMap<CelValue>) -> Result<CelValue, TemplatingError> {
    let env = env();
    match engine.compile(source, &CompileEnv { cel_env: &env, module_names: None }).unwrap() {
        CompileOutcome::Compiled(compiled) => compiled.call::<String>(activation, None).map_err(|error| match error {
            CallError::Templating(error) => error,
            CallError::Module(_) => unreachable!("no module table is bound"),
        }),
        other => panic!("{source} compiled to {other:?}"),
    }
}

fn text(source: &str, activation: &PropertyMap<CelValue>) -> String {
    match run(&InterpolateEngine, source, activation) {
        Ok(CelValue::String(text)) => text.to_string(),
        other => panic!("{source} answered {other:?}"),
    }
}

#[test]
fn joins_text_with_each_hole_converted_by_cels_string() {
    let env = env();
    let activation: PropertyMap<CelValue> = [
        ("n", CelValue::Int(42)),
        ("t", value_of("timestamp('2026-01-02T03:04:05Z')", &env)),
        ("d", value_of("duration('90m')", &env)),
        ("b", CelValue::Bytes(b"hi".to_vec().into())),
        ("ok", CelValue::Bool(true)),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        text("${{ n }} at ${{ t }} after ${{ d }}: ${{ b }} ${{ ok }}", &activation),
        "42 at 2026-01-02T03:04:05Z after 5400s: hi true"
    );
}

#[test]
fn refuses_a_hole_that_is_null_at_runtime_naming_it() {
    let activation: PropertyMap<CelValue> = [("x", CelValue::Null)].into_iter().collect();
    let error = run(&InterpolateEngine, "id ${{ x }}", &activation).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE"));
    assert!(error.message.contains("'${{ x }}'"), "{}", error.message);
    assert!(error.message.contains("null"), "{}", error.message);
}

#[test]
fn words_the_refusal_in_full() {
    let activation: PropertyMap<CelValue> = [("x", CelValue::Null)].into_iter().collect();
    let error = run(&InterpolateEngine, "a ${{ x }} b", &activation).unwrap_err();
    assert_eq!(
        error.message,
        "the hole '${{ x }}' at offset 2 of !interpolate \"a ${{ x }} b\" evaluated to null, which CEL's string() cannot convert to text. Declare outputType on the resource producing it so the check sees its type, or guard it inside the hole."
    );
}

fn described(value: CelValue) -> String {
    let activation: PropertyMap<CelValue> = [("x", value)].into_iter().collect();
    let message = run(&InterpolateEngine, "${{ x }}", &activation).unwrap_err().message;
    let tail = message.split("evaluated to ").nth(1).expect("the message says what it evaluated to");
    tail.split(", which").next().unwrap().to_string()
}

#[test]
fn names_a_holes_value_in_cels_terms_when_it_cannot_be_converted() {
    let env = env();
    assert_eq!(
        [
            described(CelValue::Null),
            described(CelValue::List(vec![CelValue::Int(1)].into())),
            described(CelValue::Record([("a", CelValue::Int(1))].into_iter().collect())),
            described(value_of("optional.of(1)", &env)),
            described(value_of("int", &env)),
        ],
        ["null", "a list", "a map", "a value of type optional_type", "a value of type type"]
    );
}

#[test]
fn names_a_value_of_no_cel_type_as_outside_the_value_domain() {
    assert_eq!(described(CelValue::Host(CelHostValue::unnamed(Arc::new(())))), "a value outside the CEL value domain");
}

#[test]
fn carries_every_holes_roots_and_declares_a_string() {
    let env = env();
    let compiled = match InterpolateEngine.compile("${{ a.x }}-${{ b }}", &CompileEnv { cel_env: &env, module_names: None }).unwrap() {
        CompileOutcome::Compiled(compiled) => compiled,
        other => panic!("{other:?}"),
    };
    assert_eq!(compiled.refs(), ["a", "b"]);
    assert_eq!(InterpolateEngine.produced_type(), Some(json!({ "type": "string" })));
}

fn codes(source: &str) -> Vec<String> {
    let env = env();
    InterpolateEngine
        .analyze(source, &AnalyzeEnv::new(&env))
        .diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.code.unwrap())
        .collect()
}

#[test]
fn refuses_a_hole_cel_cannot_convert_and_passes_one_it_can() {
    assert_eq!(codes("${{ {'a': 1} }}"), ["INTERPOLATION_HOLE_NOT_CONVERTIBLE"]);
    assert_eq!(codes("${{ [1] }}"), ["INTERPOLATION_HOLE_NOT_CONVERTIBLE"]);
    assert!(codes("${{ duration('1s') }} ${{ timestamp('2026-01-01T00:00:00Z') }} ${{ 1 }}").is_empty());
    assert_eq!(codes("${{ x"), ["CEL_SYNTAX_ERROR"]);
}

#[test]
fn reports_a_nullable_hole() {
    let env = env();
    let schema = json!({
        "type": "object",
        "properties": { "variables": { "type": "object", "properties": { "x": { "type": ["string", "null"] } } } }
    });
    let result = InterpolateEngine.analyze("${{ variables.x }}", &AnalyzeEnv { context_schema: Some(&schema), ..AnalyzeEnv::new(&env) });
    let codes: Vec<_> = result.diagnostics.iter().map(|diagnostic| diagnostic.code.as_deref().unwrap()).collect();
    assert_eq!(codes, ["CEL_NULLABLE_ACCESS"]);
}

#[test]
fn exposes_its_holes_as_expression_regions() {
    assert_eq!(cel_expressions_of("interpolate", "a ${{ x.y }} b ${{ z }}"), ["x.y", "z"]);
    assert_eq!(cel_expressions_of("cel", "x + 1"), ["x + 1"]);
    assert!(cel_expressions_of("literal", "${{ x }}").is_empty());
}

#[test]
fn sql_binds_each_hole_and_keeps_the_text_between_them() {
    let activation: PropertyMap<CelValue> = [("id", CelValue::Int(7))].into_iter().collect();
    let value = run(&SqlEngine, "WHERE id = ${{ id }} AND tag = '}'", &activation).unwrap();
    assert_eq!(
        ParameterizedSql::from_value(&value),
        Some(ParameterizedSql {
            fragments: vec!["WHERE id = ".into(), " AND tag = '}'".into()],
            values: vec![CelValue::Int(7)],
        })
    );
}
