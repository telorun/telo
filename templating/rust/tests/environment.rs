//! Twin of `templating/nodejs/tests/environment.test.ts`, with one difference named as one
//! and the dialect's listing pinned against Node.
//!
//! Every expectation Node decides was recorded by running the Node build at `1ba031dc`
//! under Node v24.21.0.

use std::sync::Arc;

use telo_templating::{build_cel_environment, build_cel_language_environment, CelHandlers};
use telorun_cel::{CelEnvironment, CelEvaluateError, CelHostValue, EvaluateOptions, PropertyMap};
use telorun_cel_value::CelValue;

fn s(text: &str) -> CelValue {
    CelValue::String(text.into())
}

fn list(items: Vec<CelValue>) -> CelValue {
    CelValue::List(items.into())
}

fn eval(env: &CelEnvironment, source: &str) -> CelValue {
    eval_with(env, source, vec![])
}

fn eval_with(env: &CelEnvironment, source: &str, bindings: Vec<(&str, CelValue)>) -> CelValue {
    let activation: PropertyMap<CelValue> = bindings.into_iter().collect();
    env.evaluate(source, &activation, &EvaluateOptions::default()).unwrap_or_else(|error| panic!("{source}: {error}"))
}

fn text(value: CelValue) -> String {
    match value {
        CelValue::String(text) => text.to_string(),
        other => panic!("not a string: {other:?}"),
    }
}

fn dialect() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

/// `d` a digit, anything else itself.
fn shaped(text: &str, shape: &str) -> bool {
    text.len() == shape.len()
        && text.bytes().zip(shape.bytes()).all(|(held, wanted)| if wanted == b'd' { held.is_ascii_digit() } else { held == wanted })
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(at, byte)| {
            if [8, 13, 18, 23].contains(&at) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[test]
fn registers_telos_stdlib_of_cel_functions() {
    let env = dialect();
    assert_eq!(eval(&env, "join(['a', 'b', 'c'], '-')"), s("a-b-c"));
    assert_eq!(eval(&env, "keys({'x': 1, 'y': 2})"), list(vec![s("x"), s("y")]));
    assert_eq!(eval(&env, "values({'x': 1, 'y': 2})"), list(vec![CelValue::Int(1), CelValue::Int(2)]));
}

#[test]
fn type_checks_heterogeneous_aggregate_literals() {
    let env = dialect();
    assert!(env.check("[1, 'two']").valid);
    assert!(env.check("{'a': 1, 'b': true}").valid);
    assert!(env.check("items.map(r, {'id': r.id, 'done': r.done == 1})").valid);
}

#[test]
fn calls_user_supplied_handlers_for_sha256() {
    let env = build_cel_environment(CelHandlers {
        sha256: Some(Arc::new(|text: &str| Ok(format!("H({text})")))),
        ..CelHandlers::default()
    });
    assert_eq!(eval(&env, "sha256('hello')"), s("H(hello)"));
}

#[test]
fn registers_stream_as_a_live_handle_carried_through_with_no_member_to_read() {
    let mut env = dialect();
    env.register_variable("input", "Stream", None).unwrap();
    let payload: Arc<dyn std::any::Any + Send + Sync> = Arc::new("a stream");
    let stream = CelValue::Host(CelHostValue::unnamed(Arc::clone(&payload)));
    let CelValue::Host(answered) = eval_with(&env, "input", vec![("input", stream)]) else { panic!("not the handle") };
    assert!(Arc::ptr_eq(answered.payload(), &payload));
    let diagnostics = env.check("input.text").diagnostics;
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code.as_str(), "CEL_TYPE_ERROR");
    assert_eq!(diagnostics[0].message, "Stream holds no members");
    assert_eq!((diagnostics[0].range.start, diagnostics[0].range.end), (6, 10));
}

/// A difference: Node's stub handlers throw `sha256() is not available in this
/// environment. Construct StaticAnalyzer or Loader with celHandlers to enable it.` out of
/// evaluation; here an unsupplied handler is the engine's own error value, naming the
/// function. No vector can observe it.
#[test]
fn difference_an_unsupplied_handler_answers_the_engines_unbound_function_error() {
    match dialect().evaluate("sha256('x')", &(), &EvaluateOptions::default()) {
        Err(CelEvaluateError::Evaluation(error)) => {
            assert_eq!(error.code.as_str(), "unbound_function");
            assert_eq!(error.message, "sha256() is supplied by the host, and this environment was given no implementation for it");
        }
        other => panic!("answered {other:?}"),
    }
}

#[test]
fn provides_current_time_functions_utc_by_default_and_zone_aware_on_demand() {
    let env = dialect();
    assert!(matches!(eval(&env, "now()"), CelValue::Timestamp(_)));
    let iso = text(eval(&env, "nowIso()"));
    assert!(iso.ends_with('Z') && shaped(&iso[..19], "dddd-dd-ddTdd:dd:dd"), "{iso}");
    assert!(shaped(&text(eval(&env, "today()")), "dddd-dd-dd"));
    assert!(matches!(eval(&env, "nowMillis()"), CelValue::Int(_)));
    assert!(matches!(eval(&env, "nowSeconds()"), CelValue::Int(_)));
    let zoned = text(eval(&env, "nowIso('America/New_York')"));
    assert!(shaped(&zoned[..23], "dddd-dd-ddTdd:dd:dd.ddd") && shaped(&zoned[24..], "dd:dd"), "{zoned}");
    assert!(matches!(zoned.as_bytes()[23], b'+' | b'-'), "{zoned}");
    assert!(shaped(&text(eval(&env, "today('Asia/Tokyo')")), "dddd-dd-dd"));
}

#[test]
fn provides_uuid_generators_for_every_version() {
    let env = dialect();
    for source in ["uuidv1()", "uuidv4()", "uuidv6()", "uuidv7()"] {
        assert!(is_uuid(&text(eval(&env, source))), "{source}");
    }
    let ns = eval(&env, "uuidv4()");
    let a = eval_with(&env, "uuidv5('alice', ns)", vec![("ns", ns.clone())]);
    let b = eval_with(&env, "uuidv5('alice', ns)", vec![("ns", ns)]);
    assert!(is_uuid(&text(a.clone())));
    assert_eq!(a, b);
}

#[test]
fn validates_and_reads_the_version_of_a_uuid() {
    let env = dialect();
    let v4 = eval(&env, "uuidv4()");
    assert_eq!(eval_with(&env, "uuidValidate(u)", vec![("u", v4.clone())]), CelValue::Bool(true));
    assert_eq!(eval(&env, "uuidValidate('nope')"), CelValue::Bool(false));
    assert_eq!(eval_with(&env, "uuidVersion(u)", vec![("u", v4)]), CelValue::Int(4));
}

#[test]
fn provides_string_functions() {
    let env = dialect();
    assert_eq!(eval(&env, "lower('AbC')"), s("abc"));
    assert_eq!(eval(&env, "upper('AbC')"), s("ABC"));
    assert_eq!(eval(&env, "trim('  x  ')"), s("x"));
    assert_eq!(eval(&env, "replace('a.b.c', '.', '-')"), s("a-b-c"));
    assert_eq!(eval(&env, "split('a,b,c', ',')"), list(vec![s("a"), s("b"), s("c")]));
}

#[test]
fn provides_math_functions() {
    let env = dialect();
    for (source, expected) in [
        ("abs(-3.5)", 3.5),
        ("floor(2.9)", 2.0),
        ("ceil(2.1)", 3.0),
        ("round(2.5)", 3.0),
        ("min([3.0, 1.0, 2.0])", 1.0),
        ("max([3.0, 1.0, 2.0])", 3.0),
    ] {
        assert_eq!(eval(&env, source), CelValue::Double(expected), "{source}");
    }
}

#[test]
fn provides_collection_functions_without_mutating_the_input() {
    let env = dialect();
    let ints = |items: &[i64]| list(items.iter().map(|item| CelValue::Int(*item)).collect());
    assert_eq!(eval(&env, "distinct([1, 1, 2, 3, 3])"), ints(&[1, 2, 3]));
    assert_eq!(eval(&env, "reverse([1, 2, 3])"), ints(&[3, 2, 1]));
    assert_eq!(eval(&env, "flatten([[1, 2], [3]])"), ints(&[1, 2, 3]));
    assert_eq!(
        eval(&env, "sort([3.0, 1.0, 2.0])"),
        list(vec![CelValue::Double(1.0), CelValue::Double(2.0), CelValue::Double(3.0)])
    );
}

#[test]
fn provides_json_parse_and_url_encoding() {
    let env = dialect();
    assert_eq!(eval(&env, "parseJson('{\"a\": 1}').a"), CelValue::Double(1.0));
    assert_eq!(eval(&env, "urlEncode('a b&c')"), s("a%20b%26c"));
    assert_eq!(eval(&env, "urlDecode('a%20b%26c')"), s("a b&c"));
}

#[test]
fn provides_null_handling_helpers() {
    let env = dialect();
    assert_eq!(eval_with(&env, "default(x, 'fallback')", vec![("x", CelValue::Null)]), s("fallback"));
    assert_eq!(eval_with(&env, "default(x, 'fallback')", vec![("x", s("value"))]), s("value"));
    assert_eq!(
        eval_with(&env, "coalesce(items)", vec![("items", list(vec![CelValue::Null, CelValue::Null, s("last")]))]),
        s("last")
    );
}

#[test]
fn routes_hashing_and_base64_through_host_handlers() {
    let env = build_cel_environment(CelHandlers {
        md5: Some(Arc::new(|text: &str| Ok(format!("md5({text})")))),
        hmac: Some(Arc::new(|algorithm: &str, key: &str, message: &str| Ok(format!("{algorithm}:{key}:{message}")))),
        base64_encode: Some(Arc::new(|text: &str| Ok(format!("b64({text})")))),
        ..CelHandlers::default()
    });
    assert_eq!(eval(&env, "md5('x')"), s("md5(x)"));
    assert_eq!(eval(&env, "hmac('sha256', 'k', 'm')"), s("sha256:k:m"));
    assert_eq!(eval(&env, "base64Encode('hi')"), s("b64(hi)"));
}

/// The dialect's listing, as Node lists it: the types in registration order, and as many
/// functions — the language's 214 and the dialect's 307.
#[test]
fn lists_the_dialects_types_in_nodes_order_and_its_functions_at_nodes_count() {
    let definitions = dialect().definitions();
    let names: Vec<&str> = definitions.types.iter().map(|listed| listed.name.as_str()).collect();
    assert_eq!(names, ["Telo.HostPath", "Telo.TcpPort", "Telo.UdpPort", "Telo.Url", "Stream"]);
    let bases: Vec<&str> = definitions.types.iter().map(|listed| listed.base.as_str()).collect();
    assert_eq!(bases, ["string", "int", "int", "dyn", "dyn"]);
    let url_fields: Vec<(String, String)> = definitions.types[3]
        .fields
        .as_ref()
        .unwrap()
        .iter()
        .map(|(name, ty)| (name.to_owned(), ty.clone()))
        .collect();
    let expected: Vec<(String, String)> = [
        ("scheme", "string"),
        ("host", "string"),
        ("port", "int"),
        ("user", "string"),
        ("password", "string"),
        ("path", "string"),
        ("query", "map<string, string>"),
    ]
    .into_iter()
    .map(|(name, ty)| (name.to_owned(), ty.to_owned()))
    .collect();
    assert_eq!(url_fields, expected);
    assert_eq!(definitions.functions.len(), 307);
    assert_eq!(build_cel_language_environment().definitions().functions.len(), 214);
    let conversions: Vec<String> =
        dialect().functions_named("string").into_iter().map(|function| function.signature).collect();
    assert_eq!(
        conversions,
        [
            "string(string): string",
            "string(bool): string",
            "string(int): string",
            "string(uint): string",
            "string(double): string",
            "string(bytes): string",
            "string(google.protobuf.Timestamp): string",
            "string(google.protobuf.Duration): string",
            "bytes.string(): string",
            "string(Telo.HostPath): string",
            "string(Telo.TcpPort): string",
            "string(Telo.UdpPort): string",
            "string(Telo.Url): string",
        ]
    );
}
