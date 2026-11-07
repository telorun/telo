//! Twin of `templating/nodejs/tests/diagnose.test.ts`, case for case, and one interim
//! reading of the call audit, recorded by running the Node build at `1ba031dc` under Node
//! v24.21.0.

use telo_templating::cel::diagnose::{audit_calls, map_value_type};
use telo_templating::{analyze_cel_expression, build_cel_environment, AnalyzeEnv, CelHandlers};
use telo_templating::cel::verdict_codes::CelAnalyzeResult;
use telorun_cel::{CelEnvironment, EvaluateOptions, NamespaceOptions};
use telorun_cel_value::CelValue;

fn env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

fn analyze(source: &str) -> CelAnalyzeResult {
    analyze_cel_expression(source, &AnalyzeEnv::new(&env()))
}

fn codes(source: &str) -> Vec<&'static str> {
    analyze(source).diagnostics.iter().map(|diagnostic| diagnostic.code.as_str()).collect()
}

fn first(source: &str) -> (&'static str, String, Option<String>) {
    let diagnostic = analyze(source).diagnostics.into_iter().next().unwrap_or_else(|| panic!("{source}: clean"));
    (diagnostic.code.as_str(), diagnostic.message, diagnostic.fix.map(|fix| fix.replacement))
}

#[test]
fn a_rejected_read_names_the_undeclared_field_and_what_is_declared() {
    let mut typed = env();
    typed.register_variable("variables", telorun_cel::TypeDeclaration::Fields([("db", "string".into())].into_iter().collect()), None).unwrap();
    let diagnostics = analyze_cel_expression("variables.dbb", &AnalyzeEnv::new(&typed)).diagnostics;
    let read: Vec<(&str, &str)> = diagnostics.iter().map(|d| (d.code.as_str(), d.message.as_str())).collect();
    assert_eq!(read, [("CEL_UNKNOWN_FIELD", "\"dbb\" is not declared here (declared: db)")]);
}

#[test]
fn reads_a_global_call_of_a_method_as_a_call_form_error_not_a_type_error() {
    let (code, _, fix) = first("startsWith(key, 'uploads/')");
    assert_eq!(code, "CEL_WRONG_CALL_FORM");
    assert_eq!(fix.as_deref(), Some("key.startsWith(\"uploads/\")"));
}

#[test]
fn classifies_by_registry_not_by_argument_types() {
    assert_eq!(codes("startsWith('abc', 'x')"), ["CEL_WRONG_CALL_FORM"]);
}

#[test]
fn reads_a_method_call_of_a_global_function_as_the_mirror_error() {
    let (code, _, fix) = first("name.lower()");
    assert_eq!(code, "CEL_WRONG_CALL_FORM");
    assert_eq!(fix.as_deref(), Some("lower(name)"));
}

#[test]
fn parenthesizes_a_receiver_that_would_otherwise_reparse() {
    assert_eq!(first("startsWith(a + b, 'x')").2.as_deref(), Some("(a + b).startsWith(\"x\")"));
}

#[test]
fn accepts_a_name_registered_in_both_forms_either_way_round() {
    assert!(codes("s.trim()").is_empty());
    assert!(codes("trim(s)").is_empty());
}

#[test]
fn leaves_macros_alone() {
    assert!(codes("items.filter(x, x > 1)").is_empty());
}

#[test]
fn says_an_unknown_name_does_not_exist_rather_than_blaming_the_arguments() {
    let (code, message, _) = first("no()");
    assert_eq!(code, "CEL_UNKNOWN_FUNCTION");
    assert_eq!(
        message,
        "no function named \"no\" is registered — the closest taking no arguments: now, nowIso, today, uuidv1, uuidv4"
    );
}

#[test]
fn reports_every_bad_call_in_one_pass() {
    assert_eq!(codes("startsWith(key, 'u') && nosuchfn() > 5"), ["CEL_WRONG_CALL_FORM", "CEL_UNKNOWN_FUNCTION"]);
}

#[test]
fn suppresses_the_opaque_residual_when_the_audit_already_explained_it() {
    assert!(!codes("startsWith(key, 'u')").contains(&"CEL_TYPE_ERROR"));
}

#[test]
fn still_reports_a_genuine_type_mismatch() {
    assert_eq!(codes("'x' + 1"), ["CEL_TYPE_ERROR"]);
}

#[test]
fn explains_a_known_name_that_no_registered_signature_accepts() {
    let (code, message, _) = first("upper()");
    assert_eq!(code, "CEL_TYPE_ERROR");
    assert!(message.contains("upper(string): string"), "{message}");
}

#[test]
fn reports_the_checked_type_for_a_valid_expression() {
    assert_eq!(analyze("upper(a.b)").type_name.as_deref(), Some("string"));
}

#[test]
fn converts_an_instant_back_out() {
    assert_eq!(analyze("string(timestamp(nowSeconds()) + duration('24h'))").type_name.as_deref(), Some("string"));
    assert_eq!(analyze("int(timestamp(nowIso()))").type_name.as_deref(), Some("int"));
}

#[test]
fn reports_determinism_so_a_caller_can_apply_eval_mode_policy() {
    let calls = analyze("nowIso() + upper(x)").calls;
    let of = |name: &str| calls.iter().find(|call| call.name == name).and_then(|call| call.deterministic);
    assert_eq!(of("nowIso"), Some(false));
    assert_eq!(of("upper"), Some(true));
}

#[test]
fn leaves_determinism_absent_for_an_unregistered_name() {
    assert_eq!(analyze("nosuchfn()").calls[0].deterministic, None);
}

#[test]
fn never_classifies_cel_bind_as_an_unknown_method() {
    assert!(!codes("cel.bind(c, 150, string(c))").contains(&"CEL_UNKNOWN_FUNCTION"));
}

#[test]
fn reports_an_unrelated_bad_call_inside_a_bind_body_and_only_that_one() {
    let diagnostics = analyze("cel.bind(c, 150, nosuchfn(c))").diagnostics;
    assert_eq!(diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["CEL_UNKNOWN_FUNCTION"]);
    assert!(diagnostics[0].message.contains("nosuchfn"));
    assert!(!diagnostics[0].message.contains("`bind`"));
}

#[test]
fn evaluates_cel_bind_so_the_analyzer_and_the_runtime_agree_it_is_valid() {
    let answered =
        env().evaluate("cel.bind(c, 150, string(c / 100) + '.' + string(c % 100))", &(), &EvaluateOptions::default());
    assert_eq!(answered, Ok(CelValue::String("1.50".into())));
}

/// Interim, as Node answers: `map_value_type` reads a `map(K, V)` type while the engine
/// prints `map<K, V>`, so a map-literal argument's entry that is not itself a literal gets
/// no type even where the map's value type is known.
#[test]
fn interim_a_map_literal_arguments_computed_entry_gets_no_type() {
    assert_eq!(map_value_type("map<string, int>"), None);
    assert_eq!(map_value_type("map(string, int)").as_deref(), Some("int"));
    assert_eq!(map_value_type("map(string, dyn)"), None);
    let mut site = env();
    site.register_variable("x", "int", None).unwrap();
    site.register_namespace("Billing", Vec::new(), NamespaceOptions { open: true }).unwrap();
    let source = "Billing.f({'a': x, 'b': 1})";
    let audit = audit_calls(source, &site.parse(source).root, &site, None, None);
    let argument = &audit.calls[0].arguments.as_ref().unwrap()[0];
    assert_eq!(argument.type_name.as_deref(), Some("map<string, int>"));
    let entries: Vec<(&str, Option<&str>)> = argument
        .entries
        .as_ref()
        .unwrap()
        .iter()
        .map(|entry| (entry.key.as_str(), entry.type_name.as_deref()))
        .collect();
    assert_eq!(entries, [("a", None), ("b", Some("int"))]);
}
