//! Every message template the checker words, each with its code and range — a table
//! past `cel/nodejs/tests`, whose cases assert most of them by code alone.
//!
//! Every row is the Node build's answer, executed: `@telorun/cel 0.118.0 at 63c81d00`.

mod check_support;

use check_support::{assert_rows, environment, fixed, found, optional_types, schema};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelEnvironment, CelEnvironmentOptions, FunctionMetadata, NamespaceFunctionDeclaration, NamespaceOptions,
    NominalTypeDefinition, PropertyMap,
};

/// A host declaring a little of everything: a parameterized type and one with fields,
/// scalars, a map keyed by int, a closed empty record, nullable members, and a namespace.
fn host() -> CelEnvironment {
    let mut environment = environment(optional_types());
    environment
        .register_type(NominalTypeDefinition {
            name: "Holder".into(),
            base: "list<A>".into(),
            parameters: vec!["A".into()],
            ..Default::default()
        })
        .unwrap();
    let fields: PropertyMap<String> = [("street", "string".to_string())].into_iter().collect();
    environment
        .register_type(NominalTypeDefinition { name: "Place".into(), base: "dyn".into(), fields: Some(fields), ..Default::default() })
        .unwrap();
    for (name, ty) in [
        ("strings", "Holder<string>"),
        ("ints", "Holder<int>"),
        ("p", "Place"),
        ("x", "int"),
        ("s", "string"),
        ("m", "map<int, string>"),
        ("l", "list<int>"),
        ("nothing", "null"),
    ] {
        environment.register_variable(name, ty, None).unwrap();
    }
    environment.register_variable("closed", schema(r#"{"type":"object","additionalProperties":false}"#), None).unwrap();
    environment
        .register_variable(
            "request",
            schema(
                r#"{"type":"object","properties":{"body":{"type":["object","null"],"properties":{"id":{"type":"string"}}},"list":{"type":["array","null"],"items":{"type":"string"}}}}"#,
            ),
            None,
        )
        .unwrap();
    environment.register_function("firstText(Holder<string>): string", FunctionMetadata::default()).unwrap();
    environment
        .register_namespace(
            "Billing",
            vec![
                "total(int, int): int".into(),
                "one(int): int".into(),
                "pair(Holder<string>): int".into(),
                NamespaceFunctionDeclaration::withheld("untyped", "NoSuchType"),
                "both(Cents): Receipt".into(),
            ],
            NamespaceOptions::default(),
        )
        .unwrap();
    environment
}

#[test]
fn every_template_is_worded_coded_and_ranged_as_on_node() {
    assert_rows(
        &host(),
        vec![
        ("[?1]", "list", vec![found(TypeError, "a list element written with '?' holds an optional, and this one is int", 2, 3)]),
        ("{?'k': 1}", "map<string, dyn>", vec![found(TypeError, "a map entry written with '?' holds an optional, and this one is int", 7, 8)]),
        ("m.a", "dyn", vec![found(TypeError, "map<int, string> is keyed by int, so \"a\" cannot name an entry of it", 2, 3)]),
        ("x.a", "dyn", vec![found(TypeError, "int holds no members", 2, 3)]),
        ("nothing.a", "dyn", vec![found(TypeError, "null holds no members", 8, 9)]),
        ("nothing[0]", "dyn", vec![found(TypeError, "null holds no members", 0, 10)]),
        ("l['a']", "int", vec![found(TypeError, "a list is indexed by int, and this index is string", 2, 5)]),
        ("m['a']", "string", vec![found(TypeError, "map<int, string> is indexed by int, and this index is string", 2, 5)]),
        ("p[1]", "dyn", vec![found(TypeError, "Place is read by field name, and this index is int", 2, 3)]),
        ("p[s]", "dyn", vec![]),
        ("x[0]", "dyn", vec![found(TypeError, "int holds no elements", 0, 4)]),
        ("1 && true", "bool", vec![found(TypeError, "&& joins bool values, and int is not one", 0, 9)]),
        ("true || 'a'", "bool", vec![found(TypeError, "|| joins bool values, and string is not one", 0, 11)]),
        ("1 ? 2 : 3", "int", vec![found(TypeError, "a condition must be bool, and this one is int", 0, 1)]),
        ("true ? 1 : 'a'", "dyn", vec![found(TypeError, "the branches of a condition answer int and string, which are not one type", 0, 14)]),
        ("-'a'", "dyn", vec![found(TypeError, "no \"-\" is declared over string", 0, 4)]),
        ("!1", "dyn", vec![found(TypeError, "no \"!\" is declared over int", 0, 2)]),
        ("Billing.untyped(1)", "dyn", vec![found(TypeError, "Billing.untyped is declared over the type \"NoSuchType\", and no type is registered under that name", 0, 18)]),
        ("Billing.both(1)", "dyn", vec![found(TypeError, "Billing.both is declared over the types \"Cents\", \"Receipt\", and no type is registered under those names", 0, 15)]),
        ("l.all(e, 1)", "bool", vec![found(TypeError, "all's test must be bool, and it is int", 9, 10)]),
        ("l.exists(e, 'a')", "bool", vec![found(TypeError, "exists's test must be bool, and it is string", 12, 15)]),
        ("l.exists_one(e, 1)", "bool", vec![found(TypeError, "exists_one's test must be bool, and it is int", 16, 17)]),
        ("l.filter(e, 1)", "list<int>", vec![found(TypeError, "filter's test must be bool, and it is int", 12, 13)]),
        ("l.map(e, 1, e)", "list<int>", vec![found(TypeError, "map's test must be bool, and it is int", 9, 10)]),
        ("x.all(e, true)", "bool", vec![found(TypeError, "a comprehension reads a list or a map, and int is neither", 0, 1)]),
        ("x.optMap(v, v)", "optional<dyn>", vec![found(TypeError, "optMap reads an optional, and int is not one", 0, 1)]),
        ("x.optFlatMap(v, v)", "dyn", vec![found(TypeError, "optFlatMap reads an optional, and int is not one", 0, 1)]),
        ("optional.of(1).optFlatMap(v, v)", "optional<dyn>", vec![found(TypeError, "optFlatMap's expression must answer an optional, and it answers int", 29, 30)]),
        ("size(x)", "dyn", vec![found(TypeError, "no overload of \"size\" takes size(int): size(string): int, size(bytes): int, size(list<A>): int, size(map<K, V>): int", 0, 7)]),
        ("x.size()", "dyn", vec![found(TypeError, "no overload of \"size\" takes int.size(): string.size(): int, bytes.size(): int, list<A>.size(): int, map<K, V>.size(): int", 0, 8)]),
        ("strings == ints", "dyn", vec![found(TypeArgumentMismatch, "Holder<string> and Holder<int> are the same type with different type arguments, which never match", 0, 15)]),
        ("firstText(ints)", "dyn", vec![found(TypeArgumentMismatch, "Holder<int> and Holder<string> are the same type with different type arguments, which never match", 0, 15)]),
        ("Billing.pair(ints)", "int", vec![found(TypeArgumentMismatch, "Holder<int> and Holder<string> are the same type with different type arguments, which never match", 13, 17)]),
        ("closed.a", "dyn", vec![found(UnknownField, "\"a\" is not declared here", 7, 8)]),
        ("p.nope", "dyn", vec![found(UnknownField, "\"nope\" is not a field of Place (fields: street)", 2, 6)]),
        ("request.body.id", "string", vec![found(NullableAccess, "\"request.body\" may be null \u{2014} guard it (e.g. 'request.body != null && \u{2026}' or 'request.body == null ? \u{2026} : request.body.id') before reading .id", 13, 15)]),
        ("request.list[0]", "string", vec![found(NullableAccess, "\"request.list\" may be null \u{2014} guard it (e.g. 'request.list != null && \u{2026}' or 'request.list == null ? \u{2026} : request.list[\u{2026}]') before reading [\u{2026}]", 0, 15)]),
        ("request.body.id + request.list[0]", "string", vec![found(NullableAccess, "\"request.body\" may be null \u{2014} guard it (e.g. 'request.body != null && \u{2026}' or 'request.body == null ? \u{2026} : request.body.id') before reading .id", 13, 15), found(NullableAccess, "\"request.list\" may be null \u{2014} guard it (e.g. 'request.list != null && \u{2026}' or 'request.list == null ? \u{2026} : request.list[\u{2026}]') before reading [\u{2026}]", 18, 33)]),
        ("nosuch()", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered", 0, 8)]),
        ("nosuch(1, 2, 3)", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered", 0, 15)]),
        ("x.nosuch()", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered \u{2014} the closest written on a value with no arguments: base64, join, json, size, value", 0, 10)]),
        ("x.nosuch(1)", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered \u{2014} the closest written on a value with 1 argument: endsWith, join, or, at, indexOf", 0, 11)]),
        ("x.nosuch(1, 2)", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered \u{2014} the closest written on a value with 2 arguments: indexOf, split, substring, lastIndexOf", 0, 14)]),
        ("startsWith('a', 'b')", "dyn", vec![fixed(WrongCallForm, "\"startsWith\" is called on a value: string.startsWith(string): bool", 0, 20, "\"a\".startsWith(\"b\")")]),
        ("'a'.size(1)", "dyn", vec![found(TypeError, "no overload of \"size\" takes string.size(int): string.size(): int, bytes.size(): int, list<A>.size(): int, map<K, V>.size(): int", 0, 11)]),
        ("Billing.nope()", "dyn", vec![found(FunctionUnresolved, "\"Billing\" declares no function named \"nope\"", 0, 14)]),
        ("Billing.one(1, 2)", "int", vec![found(FunctionArityMismatch, "Billing.one takes 1 argument, and 2 are written", 0, 17)]),
        ("Billing.total(1)", "int", vec![found(FunctionArityMismatch, "Billing.total takes 2 arguments, and 1 is written", 0, 16)]),
        ("Billing.total('a', 'b')", "int", vec![found(FunctionArgumentMismatch, "Billing.total takes int here, and this argument is string", 14, 17), found(FunctionArgumentMismatch, "Billing.total takes int here, and this argument is string", 19, 22)]),
        ("has(x)", "bool", vec![found(InvalidArgument, "has() asks whether a member is there, so it takes a member read: write has(a.b)", 4, 5)]),
        ("l.map(1, 1)", "dyn", vec![found(InvalidArgument, "map binds a name here, and this is not a name", 6, 7)]),
        ("cel.bind(1, 2, 3)", "dyn", vec![found(InvalidArgument, "bind binds a name here, and this is not a name", 9, 10)]),
        ("cel.bind(a, 1)", "dyn", vec![found(InvalidArgument, "cel.bind(name, value, body) takes three arguments: a name, its value, and the expression that reads it", 0, 14)]),
        ("optional.none(1)", "optional<dyn>", vec![found(InvalidArgument, "optional.none() takes no argument", 0, 16)]),
        ("optional.of()", "optional<dyn>", vec![found(InvalidArgument, "optional.of(value) takes one argument", 0, 13)]),
        ("optional.ofNonZeroValue(1, 2)", "optional<dyn>", vec![found(InvalidArgument, "optional.ofNonZeroValue(value) takes one argument", 0, 29)]),
        ("nope", "dyn", vec![found(UnknownIdentifier, "\"nope\" is not declared here (declared: bool, bytes, closed, double, google, int, ints, l, list, m, map, nothing, null_type, optional_type, p, request, s, string, strings, type, uint, x)", 0, 4)]),
        ("x.Size()", "dyn", vec![fixed(UnknownFunction, "no function named \"Size\" is registered \u{2014} the closest written on a value with no arguments: size, hex, join, json, trim", 0, 8, "x.size()")]),
        ("Size(x)", "dyn", vec![fixed(UnknownFunction, "no function named \"Size\" is registered \u{2014} the closest taking 1 argument: size, int, type, uint, bool", 0, 7, "size(x)")]),
        ],
    );
}

#[test]
fn a_mixed_aggregate_is_refused_where_the_environment_asks_for_homogeneous_ones() {
    assert_rows(
        &environment(CelEnvironmentOptions { homogeneous_aggregate_literals: true, ..Default::default() }),
        vec![
        ("[1, 'a']", "list", vec![found(TypeError, "this list is string where the others are int", 4, 7)]),
        ("{1: 'a', 'b': 'c'}", "map<dyn, string>", vec![found(TypeError, "this map key is string where the others are int", 9, 12)]),
        ("{'a': 1, 'b': 'c'}", "map<string, dyn>", vec![found(TypeError, "this map value is string where the others are int", 14, 17)]),
        ("[1, dyn('a')]", "list", vec![]),
        ],
    );
}

#[test]
fn an_environment_declaring_nothing_names_nothing() {
    assert_rows(
        &environment(CelEnvironmentOptions { standard_library: false, ..Default::default() }),
        vec![
        ("nope", "dyn", vec![found(UnknownIdentifier, "\"nope\" is not declared here", 0, 4)]),
        ("nosuch(1)", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered", 0, 9)]),
        ],
    );
    assert_rows(
        &CelEnvironment::default(),
        vec![
        ("optional.of(1)", "dyn", vec![found(UnknownFunction, "optional types are not enabled in this environment", 0, 14)]),
        ("x.optMap(v, v)", "dyn", vec![found(UnknownFunction, "optional types are not enabled in this environment", 0, 14)]),
        ],
    );
}

#[test]
fn a_tree_that_cannot_be_written_back_offers_no_fix_and_keeps_its_diagnostic() {
    // The source does not read whole, so its tree holds a hole and the repair has no text.
    assert_rows(
        &CelEnvironment::default(),
        vec![
            (
                "'abc'.startswith('a') +",
                "dyn",
                vec![
                    found(SyntaxError, "the expression ends before it is complete", 23, 23),
                    found(UnknownFunction, "no function named \"startswith\" is registered \u{2014} the closest written on a value with 1 argument: startsWith, endsWith, getMonth, split, substring", 0, 21),
                ],
            ),
            (
                "startsWith('abc', 'a') + ",
                "dyn",
                vec![
                    found(SyntaxError, "the expression ends before it is complete", 25, 25),
                    found(WrongCallForm, "\"startsWith\" is called on a value: string.startsWith(string): bool", 0, 22),
                ],
            ),
        ],
    );
}

#[test]
fn difference_a_receiver_named_like_an_object_prototype_key_is_a_name_like_any_other() {
    // Node looks the namespace a macro is written on up as a key of a plain object, so a
    // receiver named `constructor`, `toString`, `__proto__` or `hasOwnProperty` is taken for
    // one: `constructor.foo()` throws a `TypeError` out of `check` ("on.includes is not a
    // function"), and `constructor.map(x, x)` is refused as
    // `optional.map(value) takes one argument`. Here a receiver is a namespace macro's only
    // when it is `cel` or `optional`, so the call is an ordinary call, and `map` the
    // comprehension: Node's answer for a receiver of any other name (`ctor.foo()`).
    assert_rows(
        &environment(CelEnvironmentOptions { unlisted_variables_are_dyn: true, enable_optional_types: true, ..Default::default() }),
        vec![
            ("constructor.foo()", "dyn", vec![found(UnknownFunction, "no function named \"foo\" is registered \u{2014} the closest written on a value with no arguments: hex, join, json, size, trim", 0, 17)]),
            ("constructor.map(x, x)", "list", vec![]),
            ("toString.of(1)", "dyn", vec![found(UnknownFunction, "no function named \"of\" is registered \u{2014} the closest written on a value with 1 argument: or, at, join, split, indexOf", 0, 14)]),
            ("valueOf.map(x, x)", "list", vec![]),
        ],
    );
}
