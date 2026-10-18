//! The registry: registration and its refusal, replacement in place, removal,
//! resolution with its three failures and its loose pass, the candidates offered for an
//! unknown name, and the printed listings, against the standard library.
//!
//! No Node test file is the twin of this one: Node's tests reach the registry through
//! `check`. Every row is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`.

use std::collections::HashMap;

use telorun_cel::{
    describe_arguments, describe_candidates, format_signature, format_type, list_of, parameter_of, parse_signature,
    parse_type_expression, register_standard_library, substitute, union_of, CallForm, CelEngineError,
    CelEngineErrorCode, CelType, FunctionMetadata, FunctionRegistry, StandardLibraryOptions, DYN, INT, NULL,
    STRING, UNKNOWN_FUNCTION_CANDIDATES,
};

fn ty(text: &str) -> CelType {
    parse_type_expression(text, None).unwrap_or_else(|error| panic!("{text}: {error}"))
}

fn standard() -> FunctionRegistry {
    let mut registry = FunctionRegistry::new();
    register_standard_library(&mut registry, StandardLibraryOptions { optional_types: true, resolve_nominal: None });
    registry
}

fn registered(text: &str) -> telorun_cel::CelSignature {
    parse_signature(text, None).unwrap_or_else(|error| panic!("{text}: {error}"))
}

#[test]
fn resolves_each_call_as_node_does() {
    // `(name, form, arguments, receiver, the signature resolved and the type returned —
    // or the failure's reason and its candidates described)`.
    type Answer = Result<(&'static str, &'static str), (&'static str, &'static str)>;
    const NODE_RESOLVED: [(&str, CallForm, &[&str], Option<&str>, Answer); 22] = [
        ("size", CallForm::Global, &["string"], None, Ok(("size(string): int", "int"))),
        ("size", CallForm::Receiver, &[], Some("list<int>"), Ok(("list<A>.size(): int", "int"))),
        ("size", CallForm::Global, &["int"], None, Err(("no-overload", "size(string): int, size(bytes): int, size(list<A>): int, size(map<K, V>): int"))),
        ("nope", CallForm::Global, &[], None, Err(("unknown", ""))),
        ("startsWith", CallForm::Global, &["string", "string"], None, Err(("wrong-form", "string.startsWith(string): bool"))),
        ("size", CallForm::Global, &["string", "string"], None, Err(("no-overload", "size(string): int, size(bytes): int, size(list<A>): int, size(map<K, V>): int"))),
        ("+", CallForm::Global, &["dyn", "dyn"], None, Ok(("+(int, int): int", "dyn"))),
        ("+", CallForm::Global, &["int", "dyn"], None, Ok(("+(int, int): int", "int"))),
        ("+", CallForm::Global, &["list<int>", "list<string>"], None, Err(("no-overload", "+(int, int): int, +(uint, uint): uint, +(double, double): double, +(string, string): string, +(bytes, bytes): bytes, +(list<A>, list<A>): list<A>, +(google.protobuf.Timestamp, google.protobuf.Duration): google.protobuf.Timestamp, +(google.protobuf.Duration, google.protobuf.Timestamp): google.protobuf.Timestamp, +(google.protobuf.Duration, google.protobuf.Duration): google.protobuf.Duration"))),
        ("+", CallForm::Global, &["list<A>", "list<int>"], None, Ok(("+(list<A>, list<A>): list<A>", "list<int>"))),
        ("orValue", CallForm::Receiver, &["int"], Some("optional<A>"), Ok(("optional<A>.orValue(A): A", "int"))),
        ("value", CallForm::Receiver, &[], Some("optional<string>"), Ok(("optional<A>.value(): A", "string"))),
        ("size", CallForm::Global, &["dyn"], None, Ok(("size(string): int", "int"))),
        ("in", CallForm::Global, &["int", "map<int, string>"], None, Ok(("in(K, map<K, V>): bool", "bool"))),
        ("in", CallForm::Global, &["string", "map<int, string>"], None, Err(("no-overload", "in(A, list<A>): bool, in(K, map<K, V>): bool"))),
        ("==", CallForm::Global, &["int", "double"], None, Err(("no-overload", "==(optional<A>, optional<A>): bool, ==(int, int): bool, ==(uint, uint): bool, ==(double, double): bool, ==(bool, bool): bool, ==(string, string): bool, ==(bytes, bytes): bool, ==(null, null): bool, ==(type, type): bool, ==(list<A>, list<A>): bool, ==(map<K, V>, map<K, V>): bool, ==(google.protobuf.Timestamp, google.protobuf.Timestamp): bool, ==(google.protobuf.Duration, google.protobuf.Duration): bool"))),
        ("<", CallForm::Global, &["int", "double"], None, Ok(("<(int, double): bool", "bool"))),
        ("string", CallForm::Global, &["dyn"], None, Ok(("string(string): string", "string"))),
        ("getDate", CallForm::Receiver, &[], Some("dyn"), Ok(("google.protobuf.Timestamp.getDate(): int", "int"))),
        ("dyn", CallForm::Global, &["list<int>"], None, Ok(("dyn(A): dyn", "dyn"))),
        ("-", CallForm::Global, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], None, Ok(("-(google.protobuf.Timestamp, google.protobuf.Timestamp): google.protobuf.Duration", "google.protobuf.Duration"))),
        ("size", CallForm::Receiver, &["int"], Some("string"), Err(("no-overload", "string.size(): int, bytes.size(): int, list<A>.size(): int, map<K, V>.size(): int"))),
    ];
    let registry = standard();
    for (name, form, args, receiver, expected) in NODE_RESOLVED {
        let args: Vec<CelType> = args.iter().map(|text| ty(text)).collect();
        let receiver = receiver.map(ty);
        let answer = match registry.resolve(name, form, &args, receiver.as_ref()) {
            Ok(resolution) => Ok((format_signature(&resolution.resolved.signature), format_type(&resolution.returns, false))),
            Err(failure) => Err((failure.reason.as_str(), describe_candidates(&failure.candidates))),
        };
        let expected = expected.map(|(a, b)| (a.to_string(), b.to_string())).map_err(|(a, b)| (a, b.to_string()));
        assert_eq!(answer, expected, "{name} {args:?} on {receiver:?}");
    }
}

#[test]
fn offers_the_nearest_names_a_call_could_be_written_with() {
    // `(name written, form, arity, candidateNames on Node)`.
    const NODE_CANDIDATES: [(&str, CallForm, usize, &[&str]); 9] = [
        ("sise", CallForm::Global, 1, &["size", "int", "type", "uint", "bool"]),
        ("sise", CallForm::Receiver, 0, &["size", "base64", "hex", "join", "json"]),
        ("szie", CallForm::Global, 1, &["size", "type", "bool", "bytes", "dyn"]),
        ("timestmp", CallForm::Global, 1, &["timestamp", "bytes", "int", "size", "type"]),
        // An operator registers under its symbol, and is never offered.
        ("no", CallForm::Global, 1, &["int", "bool", "dyn", "uint", "size"]),
        ("x", CallForm::Global, 2, &["matches"]),
        ("getdate", CallForm::Receiver, 0, &["getDate", "getMonth", "getHours", "getMinutes", "hasValue"]),
        ("string", CallForm::Global, 1, &["int", "size", "uint", "dyn", "type"]),
        ("\u{1f600}a", CallForm::Global, 1, &["dyn", "int", "bool", "size", "type"]),
    ];
    let registry = standard();
    for (wanted, form, arity, expected) in NODE_CANDIDATES {
        assert_eq!(registry.candidate_names(wanted, form, arity), expected, "{wanted}");
    }
    assert_eq!(UNKNOWN_FUNCTION_CANDIDATES, 5);
}

#[test]
fn replaces_a_registration_in_place_and_removes_by_the_same_key() {
    let mut registry = FunctionRegistry::new();
    for text in ["f(int): int", "f(string): int"] {
        registry.register(registered(text), FunctionMetadata::default()).expect("registers");
    }
    let again = FunctionMetadata { description: Some("again".into()), ..FunctionMetadata::default() };
    registry.register(registered("f(int): string"), again).expect("registers");
    registry.register(registered("int.f(): int"), FunctionMetadata::default()).expect("registers");
    let listed: Vec<String> = registry.list().iter().map(|entry| format_signature(&entry.signature)).collect();
    assert_eq!(listed, ["f(int): string", "f(string): int", "int.f(): int"]);
    assert_eq!(registry.named("f")[0].metadata.description.as_deref(), Some("again"));
    // The key leaves the return type out.
    assert!(registry.remove(&registered("f(string): bool")));
    assert!(!registry.remove(&registered("f(bytes): int")));
    assert_eq!(registry.remove_name("f"), 2);
    assert!(!registry.has("f"));
    assert_eq!(registry.remove_name("f"), 0);
}

#[test]
fn refuses_a_signature_wider_than_an_implementation_receives() {
    let mut registry = FunctionRegistry::new();
    // `(signature, Node's CelEngineError message)`; the receiver counts as a value.
    const NODE_REFUSED: [(&str, &str); 2] = [
        ("f(int, int, int, int, int): int", "f(int, int, int, int, int): int takes 5 values and an implementation receives at most 4"),
        ("string.f(int, int, int, int): int", "string.f(int, int, int, int): int takes 5 values and an implementation receives at most 4"),
    ];
    for (text, message) in NODE_REFUSED {
        assert_eq!(
            registry.register(registered(text), FunctionMetadata::default()),
            Err(CelEngineError { code: CelEngineErrorCode::SignatureTooWide, message: message.into() })
        );
    }
    // Node's four codes, in Node's order.
    let codes = [
        CelEngineErrorCode::NamespacesMismatch,
        CelEngineErrorCode::UnreadableExpression,
        CelEngineErrorCode::EmittedModuleRejected,
        CelEngineErrorCode::SignatureTooWide,
    ];
    assert_eq!(codes.map(CelEngineErrorCode::as_str), [
        "namespaces_mismatch",
        "unreadable_expression",
        "emitted_module_rejected",
        "signature_too_wide"
    ]);
    registry.register(registered("string.f(int, int, int): int"), FunctionMetadata::default()).expect("four values");
    assert!(registry.list().len() == 1);
}

#[test]
fn substitutes_and_describes_as_node_does() {
    let bindings: HashMap<String, CelType> = [("K".to_string(), STRING)].into_iter().collect();
    assert_eq!(format_type(&substitute(&ty("map<K, list<V>>"), &bindings), false), "map<string, list<V>>");
    // A union is left as it is.
    let bindings: HashMap<String, CelType> = [("A".to_string(), STRING)].into_iter().collect();
    assert_eq!(format_type(&substitute(&union_of([parameter_of("A"), INT]), &bindings), false), "A|int");
    assert_eq!(describe_arguments(&[INT, list_of(DYN), union_of([INT, NULL])]), "int, list<dyn>, int|null");
    assert_eq!(standard().list().len(), 214);
}
