//! Twin of `cel/nodejs/tests/qualified-names.test.ts`: every case.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`, and for what the activation answers at evaluation
//! `@telorun/cel 0.120.1 at b4a2b6e9`. Past the Node file: each refusal's whole
//! diagnostic.

mod check_support;

use check_support::{assert_rows, environment, found, schema, unlisted_dyn};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    qualified_calls, root_references, serialize_tree, CelEnvironment, CelRecord, CelValue, EvaluateOptions,
    FieldDeclaration, NamespaceOptions, PropertyMap,
};

fn declaring(declarations: &[(&str, &str)]) -> CelEnvironment {
    let mut environment = CelEnvironment::default();
    for (name, ty) in declarations {
        environment.register_variable(name, *ty, None).unwrap();
    }
    environment
}

#[test]
fn a_dotted_declaration_is_one_name_and_the_longest_declared_prefix_wins() {
    assert_rows(&declaring(&[("a.b.c", "string")]), vec![("a.b.c", "string", vec![])]);
    assert_rows(&declaring(&[("a.b", "map<string, string>")]), vec![("a.b.c", "string", vec![])]);
    assert_rows(
        &declaring(&[("a.b", "map<string, string>"), ("a.b.c", "int")]),
        vec![("a.b.c", "int", vec![]), ("a.b.d", "string", vec![])],
    );
}

#[test]
fn a_dotted_declaration_reads_its_members_from_there_and_refuses_one_a_declared_type_does_not_hold() {
    let mut environment = declaring(&[("a.b", "list<string>")]);
    environment
        .register_variable("cfg.http", schema(r#"{"type":"object","properties":{"port":{"type":"integer"}}}"#), None)
        .unwrap();
    assert_rows(
        &environment,
        vec![
            ("cfg.http.port", "int", vec![]),
            ("cfg.http.prot", "dyn", vec![found(UnknownField, "\"prot\" is not declared here (declared: port)", 9, 13)]),
            // A member read on a list is a type error, whatever the chain that reached it.
            ("a.b.pancakes", "dyn", vec![found(TypeError, "list<string> holds no members", 4, 12)]),
        ],
    );
}

#[test]
fn a_dotted_declaration_yields_to_a_name_the_expression_itself_bound() {
    let mut environment = environment(unlisted_dyn());
    environment.register_variable("a.b", "map<string, string>", None).unwrap();
    // `a` is the comprehension's element in the second, which holds an int at `b.c`.
    assert_rows(
        &environment,
        vec![("a.b.c", "string", vec![]), ("[{'b': {'c': 1}}].map(a, a.b.c)", "list<int>", vec![])],
    );
}

#[test]
fn a_root_declaration_is_the_name_a_chain_reads() {
    let mut root_only = CelEnvironment::default();
    let fields: PropertyMap<FieldDeclaration> = [("b", FieldDeclaration::from("int"))].into_iter().collect();
    root_only.register_variable("a", fields.clone(), None).unwrap();
    assert_rows(&root_only, vec![("a.b", "int", vec![])]);
    // **The declared name wins at evaluation, not just at check**: an activation holding
    // both `a` and the key `"a.b"` reads the name the checker typed.
    let activation: PropertyMap<CelValue> = [
        ("a", CelValue::Record([("b", CelValue::Int(1))].into_iter().collect::<CelRecord>())),
        ("a.b", CelValue::Int(99)),
    ]
    .into_iter()
    .collect();
    let read = |environment: &CelEnvironment| environment.evaluate("a.b", &activation, &EvaluateOptions::default());
    assert_eq!(read(&root_only), Ok(CelValue::Int(1)));
    // And a dotted declaration still wins over a shorter one, which is the same rule.
    let mut dotted = CelEnvironment::default();
    dotted.register_variable("a", fields, None).unwrap();
    dotted.register_variable("a.b", "int", None).unwrap();
    assert_eq!(read(&dotted), Ok(CelValue::Int(99)));
}

#[test]
fn a_dotted_declaration_reads_as_one_name_for_the_free_variable_query() {
    let environment = declaring(&[("a.b.c", "string")]);
    assert_eq!(root_references(&environment.parse("a.b.c").root), ["a"]);
}

fn absolute() -> CelEnvironment {
    let mut environment = declaring(&[("y", "string"), ("outer", "int")]);
    environment.register_namespace("Alias", vec!["fn(int): int".into()], NamespaceOptions::default()).unwrap();
    environment
}

#[test]
fn an_absolute_name_resolves_against_the_environment_never_against_a_binding() {
    assert_rows(
        &absolute(),
        vec![
            (".y", "string", vec![]),
            ("['a'].exists(y, .y == 'y')", "bool", vec![]),
            ("[1].map(outer, .outer + 1)", "list<int>", vec![]),
            // Without the dot the binding wins, which is what the dot is for.
            ("['a'].exists(y, y == 'y')", "bool", vec![]),
        ],
    );
}

#[test]
fn an_absolute_name_reads_a_member_of_what_it_resolved() {
    let mut nested = CelEnvironment::default();
    nested.register_variable("y", schema(r#"{"type":"object","properties":{"z":{"type":"string"}}}"#), None).unwrap();
    assert_rows(&nested, vec![(".y.z", "string", vec![]), ("[1].map(y, .y.z)", "list<string>", vec![])]);
}

#[test]
fn an_absolute_name_is_a_name_nothing_declares_when_nothing_declares_it() {
    assert_rows(
        &CelEnvironment::default(),
        vec![(
            ".nope",
            "dyn",
            vec![found(
                UnknownIdentifier,
                "\"nope\" is not declared here (declared: bool, bytes, double, google, int, list, map, null_type, string, type, uint)",
                0,
                5,
            )],
        )],
    );
    assert_rows(&environment(unlisted_dyn()), vec![(".nope", "dyn", vec![])]);
}

#[test]
fn an_absolute_name_is_never_a_namespaced_call() {
    assert_rows(
        &absolute(),
        vec![(
            ".Alias.fn(1)",
            "dyn",
            vec![
                found(
                    UnknownIdentifier,
                    "\"Alias\" is not declared here (declared: bool, bytes, double, google, int, list, map, null_type, outer, string, type, uint, y)",
                    0,
                    6,
                ),
                found(
                    UnknownFunction,
                    "no function named \"fn\" is registered \u{2014} the closest written on a value with 1 argument: at, join, split, indexOf, contains",
                    0,
                    12,
                ),
            ],
        )],
    );
    assert_eq!(qualified_calls(&absolute().parse(".Alias.fn(1)").root), []);
    // The one spelling still resolves.
    assert_rows(&absolute(), vec![("Alias.fn(1)", "int", vec![])]);
    assert_eq!(qualified_calls(&absolute().parse("Alias.fn(1)").root).len(), 1);
}

#[test]
fn an_absolute_name_writes_back_with_its_dot() {
    for source in [".y", ".y.z", "[1].map(y, .y)"] {
        let expression = absolute().parse(source);
        assert_eq!(expression.diagnostic, None, "{source}");
        assert_eq!(serialize_tree(&expression.root).as_deref(), Ok(source));
    }
}
