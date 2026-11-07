//! Twin of `templating/nodejs/tests/compile.test.ts`, case for case.

use telo_templating::{build_cel_environment, compile_expression, CelHandlers};
use telorun_cel::PropertyMap;
use telorun_cel_value::CelValue;

#[test]
fn answers_a_compiled_value_that_evaluates_against_a_runtime_context() {
    let env = build_cel_environment(CelHandlers::default());
    let compiled = compile_expression("variables.port", &env, None).unwrap();
    let activation: PropertyMap<CelValue> =
        [("variables", CelValue::Record([("port", CelValue::Int(8080))].into_iter().collect()))].into_iter().collect();
    assert_eq!(compiled.call::<String>(&activation, None).unwrap(), CelValue::Int(8080));
}

#[test]
fn captures_the_source_text_on_the_compiled_value() {
    let env = build_cel_environment(CelHandlers::default());
    assert_eq!(compile_expression("a + b", &env, None).unwrap().source(), "a + b");
}

#[test]
fn fails_on_a_syntax_error() {
    let env = build_cel_environment(CelHandlers::default());
    let refused = compile_expression("variables.", &env, None).unwrap_err();
    assert_eq!(refused.code, None);
    assert!(refused.message.starts_with("\"variables.\" could not be read: "), "{}", refused.message);
}
