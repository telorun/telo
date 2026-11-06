//! A registration's guard over the arguments written as literals — the seam
//! `checkArguments` is in Node's checker, a table past `cel/nodejs/tests`, which reaches it
//! through the function catalog — and the catalog's twelve guards themselves.
//!
//! Every expected value is the Node build's answer, executed: the seam's
//! `@telorun/cel 0.118.0 at 63c81d00`, the guard recording what it was handed; the
//! catalog's `@telorun/cel 0.129.0 at 2ee5ef49` under Node v24.21.0 (V8
//! 13.6.233.17-node.53, ICU 78.3, tz 2026c), d3-format 3.1.2, re2js 2.8.3. The one
//! exception is this crate's own: a hand-built range cutting a character, named where it
//! is asserted.

mod check_support;

use std::sync::{Arc, Mutex};

use check_support::{environment, found, range, unlisted_dyn};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    catalog_literal_check, register_function_catalog, RegisterCatalogOptions, CelCallNode, CelEnvironment, CelExpression, CelLiteral, CelLiteralNode, CelNode, CelValue, FunctionMetadata,
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

/// `(source, every diagnostic Node's check reports)`, in a catalog environment whose unlisted
/// names are `dyn`.
const CATALOG_GUARD_ROWS: [(&str, &[(telorun_cel::CelCheckCode, &str, u32, u32)]); 46] = [
    ("1 + size(fixed(1.0, 11))", &[(InvalidArgument, "fixed: decimal places must be an integer 0-10, got 11 (in `fixed(1.0, 11)`)", 9, 23)]),
    ("fixed(1.0, digits)", &[]),
    ("fixed(9007199254740992, 2)", &[(InvalidArgument, "fixed: integer 9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double (in `fixed(9007199254740992, 2)`)", 0, 26)]),
    ("fixed(9007199254740992, 11)", &[(InvalidArgument, "fixed: decimal places must be an integer 0-10, got 11 (in `fixed(9007199254740992, 11)`)", 0, 27)]),
    ("fixed(x, -1)", &[(InvalidArgument, "fixed: decimal places must be an integer 0-10, got -1 (in `fixed(x, -1)`)", 0, 12)]),
    ("regexReplace('a', '[', 'b')", &[(InvalidArgument, "regexReplace: invalid RE2 pattern \"[\": missing closing ] (in `regexReplace('a', '[', 'b')`)", 0, 27)]),
    ("regexReplace('a', '[', 'b', 'q')", &[(InvalidArgument, "regexReplace: unknown regex flag 'q' (supported: i, m, s) (in `regexReplace('a', '[', 'b', 'q')`)", 0, 32)]),
    ("regexReplace('a', '[', 'b', flags)", &[(InvalidArgument, "regexReplace: invalid RE2 pattern \"[\": missing closing ] (in `regexReplace('a', '[', 'b', flags)`)", 0, 34)]),
    ("regexReplace('a', p, 'b', 'x')", &[(InvalidArgument, "regexReplace: unknown regex flag 'x' (supported: i, m, s) (in `regexReplace('a', p, 'b', 'x')`)", 0, 30)]),
    ("regexReplace('a', '(?i)a', 'b', 'gim')", &[]),
    ("regexExtract('a', '(?<x', 'i')", &[(InvalidArgument, "regexExtract: invalid RE2 pattern \"(?<x\": invalid named capture (in `regexExtract('a', '(?<x', 'i')`)", 0, 30)]),
    ("regexExtract('a', 'a', 'q')", &[(InvalidArgument, "regexExtract: unknown regex flag 'q' (supported: i, m, s) (in `regexExtract('a', 'a', 'q')`)", 0, 27)]),
    ("regexExtract(s, 'a{1001}')", &[(InvalidArgument, "regexExtract: invalid RE2 pattern \"a{1001}\": invalid repeat count (in `regexExtract(s, 'a{1001}')`)", 0, 26)]),
    ("regexExtractAll('a', '\\\\', 'g')", &[(InvalidArgument, "regexExtractAll: invalid RE2 pattern \"\\\\\": trailing backslash at end of expression (in `regexExtractAll('a', '\\\\', 'g')`)", 0, 31)]),
    ("regexExtractAll('a', 'a*')", &[]),
    ("regexGroups('a', '(a)|(b')", &[(InvalidArgument, "regexGroups: invalid RE2 pattern \"(a)|(b\": missing closing ) (in `regexGroups('a', '(a)|(b')`)", 0, 26)]),
    ("regexGroups('a', '(a)', '😀')", &[(InvalidArgument, "regexGroups: unknown regex flag '😀' (supported: i, m, s) (in `regexGroups('a', '(a)', '😀')`)", 0, 29)]),
    ("round(1.5, 11)", &[(InvalidArgument, "round: decimal places must be an integer 0-10, got 11 (in `round(1.5, 11)`)", 0, 14)]),
    ("round(9007199254740992)", &[(InvalidArgument, "round: integer 9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double (in `round(9007199254740992)`)", 0, 23)]),
    ("round(9007199254740992, 11)", &[(InvalidArgument, "round: decimal places must be an integer 0-10, got 11 (in `round(9007199254740992, 11)`)", 0, 27)]),
    ("round(-9007199254740992, 2)", &[(InvalidArgument, "round: integer -9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double (in `round(-9007199254740992, 2)`)", 0, 27)]),
    ("round(9007199254740991, 2)", &[]),
    ("round(x, 11)", &[(InvalidArgument, "round: decimal places must be an integer 0-10, got 11 (in `round(x, 11)`)", 0, 12)]),
    ("round(2.5, n)", &[]),
    ("format(1.0, '.2q')", &[(InvalidArgument, "format: unknown format type 'q' (one of efgrs%pbodxXcn) (in `format(1.0, '.2q')`)", 0, 18)]),
    ("format(1.0, '.11f')", &[(InvalidArgument, "format: decimal places must be an integer 0-10, got 11 (in `format(1.0, '.11f')`)", 0, 19)]),
    ("format(1.0, 'x>8.1f')", &[]),
    ("format(9007199254740992, ',d')", &[(InvalidArgument, "format: integer 9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double (in `format(9007199254740992, ',d')`)", 0, 30)]),
    ("format(9007199254740992, '.2q')", &[(InvalidArgument, "format: unknown format type 'q' (one of efgrs%pbodxXcn) (in `format(9007199254740992, '.2q')`)", 0, 31)]),
    ("format(x, '.2q')", &[(InvalidArgument, "format: unknown format type 'q' (one of efgrs%pbodxXcn) (in `format(x, '.2q')`)", 0, 16)]),
    ("format(1.0, spec)", &[]),
    ("format(1.0, ',.2f')", &[]),
    ("formatDuration(10, 0)", &[(InvalidArgument, "formatDuration: minutesPerDay must be a positive number, got 0 (in `formatDuration(10, 0)`)", 0, 21)]),
    ("formatDuration(x, 0)", &[(InvalidArgument, "formatDuration: minutesPerDay must be a positive number, got 0 (in `formatDuration(x, 0)`)", 0, 20)]),
    ("formatDuration(9007199254740992, 1440)", &[(InvalidArgument, "formatDuration: integer 9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double (in `formatDuration(9007199254740992, 1440)`)", 0, 38)]),
    ("formatDuration(1.5, n)", &[]),
    ("formatDuration(90.5, -3)", &[(InvalidArgument, "formatDuration: minutesPerDay must be a positive number, got -3 (in `formatDuration(90.5, -3)`)", 0, 24)]),
    ("dateIn(timestamp('2024-03-04T05:06:07Z'), 'Nowhere/Zone')", &[(InvalidArgument, "dateIn: unknown IANA time zone \"Nowhere/Zone\" (in `dateIn(timestamp('2024-03-04T05:06:07Z'), 'Nowhere/Zone')`)", 0, 57)]),
    ("isoIn(timestamp('2024-03-04T05:06:07Z'), 'Z')", &[(InvalidArgument, "isoIn: unknown IANA time zone \"Z\" (in `isoIn(timestamp('2024-03-04T05:06:07Z'), 'Z')`)", 0, 45)]),
    ("startOfMonth(timestamp('2024-03-04T05:06:07Z'), '+24:00')", &[(InvalidArgument, "startOfMonth: unknown IANA time zone \"+24:00\" (in `startOfMonth(timestamp('2024-03-04T05:06:07Z'), '+24:00')`)", 0, 57)]),
    ("addMonths(timestamp('2024-03-04T05:06:07Z'), 1, 'utc ')", &[(InvalidArgument, "addMonths: unknown IANA time zone \"utc \" (in `addMonths(timestamp('2024-03-04T05:06:07Z'), 1, 'utc ')`)", 0, 55)]),
    ("addMonths(timestamp('2024-03-04T05:06:07Z'), n, z)", &[]),
    ("dateIn(timestamp('2024-03-04T05:06:07Z'), zone)", &[]),
    ("isoIn(timestamp('2024-03-04T05:06:07Z'), 'Europe/Brussels')", &[]),
    ("[fixed(1.0, 11), format(2.0, '.2q')]", &[(InvalidArgument, "fixed: decimal places must be an integer 0-10, got 11 (in `fixed(1.0, 11)`)", 1, 15), (InvalidArgument, "format: unknown format type 'q' (one of efgrs%pbodxXcn) (in `format(2.0, '.2q')`)", 17, 35)]),
    ("fixed(1.0, 11) + format(2.0, '.2q')", &[(InvalidArgument, "fixed: decimal places must be an integer 0-10, got 11 (in `fixed(1.0, 11)`)", 0, 14), (InvalidArgument, "format: unknown format type 'q' (one of efgrs%pbodxXcn) (in `format(2.0, '.2q')`)", 17, 35)]),
];

#[test]
fn refuses_each_catalog_guards_literal_at_check_and_skips_a_computed_argument() {
    let mut environment = environment(unlisted_dyn());
    register_function_catalog(&mut environment, RegisterCatalogOptions::default());
    for (source, expected) in CATALOG_GUARD_ROWS {
        let expected: Vec<_> =
            expected.iter().map(|(code, message, start, end)| found(*code, message, *start, *end)).collect();
        assert_eq!(environment.check(source).diagnostics, expected, "{source}");
    }
}

#[test]
fn judges_a_number_a_catalog_guard_is_handed_only_as_an_int_literal() {
    let check = |name: &str, literals: &[Option<CelValue>]| catalog_literal_check(name).unwrap()(literals);
    let uint = Some(CelValue::Uint(9007199254740993));
    let int = Some(CelValue::Int(9007199254740993));
    assert_eq!(check("round", &[uint.clone(), None]), None);
    assert_eq!(
        check("round", &[int.clone(), None]),
        Some("round: integer 9007199254740993 exceeds 2^53-1 and cannot be formatted exactly as a double".into())
    );
    assert_eq!(check("fixed", &[uint.clone(), Some(CelValue::Int(2))]), None);
    assert_eq!(check("format", &[uint, string(".2f")]), None);
    assert_eq!(
        check("format", &[int, string(".2f")]),
        Some("format: integer 9007199254740993 exceeds 2^53-1 and cannot be formatted exactly as a double".into())
    );
    // `formatDuration` judges its day length with an absent first argument read as 0.
    assert_eq!(check("formatDuration", &[None, Some(CelValue::Uint(5))]), None);
    assert_eq!(
        check("formatDuration", &[None, Some(CelValue::Int(0))]),
        Some("formatDuration: minutesPerDay must be a positive number, got 0".into())
    );
    assert_eq!(check("dateIn", &[None, Some(CelValue::Int(5))]), None);
}
