//! A registration's guard over the arguments written as literals — the seam
//! `checkArguments` is in Node's checker, a table past `cel/nodejs/tests`, which reaches it
//! only through the function catalog.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`, the guard recording what it was handed. The one
//! exception is this crate's own: a hand-built range cutting a character, named where it
//! is asserted.

mod check_support;

use std::sync::{Arc, Mutex};

use check_support::{environment, found, range, unlisted_dyn};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelCallNode, CelEnvironment, CelExpression, CelLiteral, CelLiteralNode, CelNode, CelValue, FunctionMetadata,
    LiteralArgumentCheck, NamespaceOptions,
};

type Seen = Arc<Mutex<Vec<Vec<Option<CelValue>>>>>;

/// A guard refusing a first argument written as the literal `'x'`, recording every list of
/// values it is handed.
fn guard(seen: &Seen) -> LiteralArgumentCheck {
    let seen = Arc::clone(seen);
    Arc::new(move |values: &[Option<CelValue>]| {
        seen.lock().unwrap().push(values.to_vec());
        matches!(values.first(), Some(Some(CelValue::String(text))) if &**text == "x").then(|| "f: \"x\" is refused".to_string())
    })
}

fn guarded() -> (CelEnvironment, Seen) {
    let seen: Seen = Arc::default();
    let metadata = || FunctionMetadata { check_arguments: Some(guard(&seen)), ..Default::default() };
    let mut environment = environment(unlisted_dyn());
    environment.register_function("f(string): string", metadata()).unwrap();
    environment.register_function("g(dyn, dyn, dyn, dyn): string", metadata()).unwrap();
    environment.register_function("string.h(dyn): string", metadata()).unwrap();
    environment.register_operator("+", &["string", "int"], "string", metadata()).unwrap();
    environment.register_namespace("Ns", vec!["f(string): string".into()], NamespaceOptions::default()).unwrap();
    (environment, seen)
}

fn refused(start: u32, end: u32, written: &str) -> telorun_cel::CelCheckDiagnostic {
    found(InvalidArgument, &format!("f: \"x\" is refused (in `{written}`)"), start, end)
}

fn string(text: &str) -> Option<CelValue> {
    Some(CelValue::String(text.into()))
}

#[test]
fn refuses_a_literal_and_skips_an_argument_that_is_not_one() {
    let (environment, seen) = guarded();
    assert_eq!(environment.check("f('x')").diagnostics, [refused(0, 6, "f('x')")]);
    assert_eq!(environment.check("f(a)").diagnostics, []);
    assert_eq!(environment.check("f('y')").diagnostics, []);
    assert_eq!(*seen.lock().unwrap(), [vec![string("x")], vec![None], vec![string("y")]]);
}

#[test]
fn hands_each_literal_its_value_and_a_minus_over_a_parenthesis_as_no_literal() {
    let (environment, seen) = guarded();
    assert_eq!(environment.check("g(1, 2u, 1.5, b'ab')").diagnostics, []);
    assert_eq!(environment.check("g(true, null, -(1), -1)").diagnostics, []);
    assert_eq!(
        *seen.lock().unwrap(),
        [
            vec![Some(CelValue::Int(1)), Some(CelValue::Uint(2)), Some(CelValue::Double(1.5)), Some(CelValue::Bytes(b"ab".to_vec().into()))],
            vec![Some(CelValue::Bool(true)), Some(CelValue::Null), None, Some(CelValue::Int(-1))],
        ]
    );
}

#[test]
fn hands_a_receiver_call_its_receiver_first() {
    let (environment, seen) = guarded();
    assert_eq!(environment.check("'x'.h(a)").diagnostics, [refused(0, 8, "'x'.h(a)")]);
    assert_eq!(environment.check("a.h('x')").diagnostics, []);
    assert_eq!(*seen.lock().unwrap(), [vec![string("x"), None], vec![None, string("x")]]);
}

#[test]
fn is_asked_only_where_a_global_or_receiver_call_resolved() {
    let (environment, seen) = guarded();
    // An operator, a namespaced call and a call that resolves to nothing ask no guard.
    assert_eq!(environment.check("'x' + 1").diagnostics, []);
    assert_eq!(environment.check("Ns.f('x')").diagnostics, []);
    assert_eq!(
        environment.check("f(1)").diagnostics,
        [found(TypeError, "no overload of \"f\" takes f(int): f(string): string", 0, 4)]
    );
    assert_eq!(*seen.lock().unwrap(), Vec::<Vec<Option<CelValue>>>::new());
}

#[test]
fn names_the_call_as_written_by_its_utf16_range_once_per_call() {
    let (environment, seen) = guarded();
    assert_eq!(environment.check("'é😀' + f('x')").diagnostics, [refused(8, 14, "f('x')")]);
    assert_eq!(environment.check("f('x') + f('x')").diagnostics, [refused(0, 6, "f('x')"), refused(9, 15, "f('x')")]);
    let mapped = environment.check("[f('x')].map(e, f('x'))");
    assert_eq!(mapped.diagnostics, [refused(1, 7, "f('x')"), refused(16, 22, "f('x')")]);
    assert_eq!(mapped.type_name, "list<string>");
    assert_eq!(seen.lock().unwrap().len(), 5);
}

/// `f('x')` built by hand, ranged over `[start, end)` of `source`.
fn hand_built(source: &str, start: u32, end: u32) -> CelExpression {
    let argument = Arc::new(CelNode::Literal(CelLiteralNode { literal: CelLiteral::String("x".into()), range: range(0, 0) }));
    let call = CelNode::Call(CelCallNode { name: "f".into(), name_range: range(0, 0), args: vec![argument], range: range(start, end) });
    CelExpression { source: source.into(), root: Arc::new(call), namespaces: Arc::new([]), diagnostic: None }
}

#[test]
fn slices_a_hand_built_range_as_ecmascript_slices_a_string() {
    let mut environment = environment(unlisted_dyn());
    environment.register_function("f(string): string", FunctionMetadata { check_arguments: Some(guard(&Seen::default())), ..Default::default() }).unwrap();
    // Past the end, or empty, is an empty slice, as on Node.
    let check = |source: &str, start: u32, end: u32| environment.check_parsed(&hand_built(source, start, end)).unwrap().diagnostics;
    assert_eq!(check("ab", 5, 99), [refused(5, 99, "")]);
    assert_eq!(check("ab", 2, 1), [refused(2, 1, "")]);
    assert_eq!(check("a😀b", 1, 4), [refused(1, 4, "😀b")]);
}

#[test]
fn difference_a_hand_built_range_cutting_a_character_slices_a_replacement_character() {
    let mut environment = environment(unlisted_dyn());
    environment.register_function("f(string): string", FunctionMetadata { check_arguments: Some(guard(&Seen::default())), ..Default::default() }).unwrap();
    // Node slices the lone high surrogate into its message (`in \`a\ud83d\``); a Rust
    // string cannot hold one, so the half character is U+FFFD.
    let diagnostics = environment.check_parsed(&hand_built("a😀b", 0, 2)).unwrap().diagnostics;
    assert_eq!(diagnostics, [refused(0, 2, "a\u{fffd}")]);
}
