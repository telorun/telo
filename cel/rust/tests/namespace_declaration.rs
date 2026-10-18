//! Twin of `cel/nodejs/tests/namespace-declaration.test.ts`, case for case but one: the
//! digest case has no twin, because there is no emitter here.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. Past the Node file: the listing of an open, a
//! closed and a withheld namespace together, in name order, a `NamespaceFunction` built
//! from its public fields, and a withheld result declared as a `CelType`.

mod check_support;

use check_support::{assert_rows, first_code, found};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    list_of, CallForm, CelEnvironment, CelEnvironmentOptions, CelRegistrationError, CelTypeExpressionError,
    NamespaceFunction, NamespaceFunctionDeclaration, NamespaceListing, NamespaceOptions, NominalTypeDefinition,
    ResolvedCall, SourceRange, DYN, INT, STRING,
};

fn loose() -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions { unlisted_variables_are_dyn: true, ..Default::default() })
}

fn closed() -> CelEnvironment {
    let mut environment = loose();
    environment.register_namespace("Alias", vec!["total(double, int): double".into()], NamespaceOptions::default()).expect("registers");
    environment
}

fn withheld() -> CelEnvironment {
    let mut environment = loose();
    environment
        .register_namespace("Alias", vec![NamespaceFunctionDeclaration::withheld("total", "double")], NamespaceOptions::default())
        .expect("registers");
    environment
}

#[test]
fn is_listed_by_what_it_declares_never_as_a_function_of_no_arguments() {
    assert_eq!(withheld().definitions().namespaces[0].functions, ["total(…): double"]);
    // A full declaration still prints its signature.
    assert_eq!(closed().definitions().namespaces[0].functions, ["total(double, int): double"]);
}

#[test]
fn leaves_a_type_expression_that_does_not_parse_a_throw() {
    // `(the withheld result, the CelTypeExpressionError message Node throws)`.
    const NODE_REFUSED: [(&str, &str, &str); 2] = [
        ("broken", "list<int", "\"list<int\" has no closing '>' for its type arguments"),
        ("nameless", "<int>", "\"<int>\" names no type at offset 0"),
    ];
    for (name, returns, message) in NODE_REFUSED {
        let mut environment = loose();
        assert_eq!(
            environment.register_namespace(
                "Alias",
                vec![NamespaceFunctionDeclaration::withheld(name, returns)],
                NamespaceOptions::default()
            ),
            Err(CelRegistrationError::Expression(CelTypeExpressionError { message: message.into() }))
        );
    }
}

#[test]
fn lists_open_closed_and_withheld_namespaces_in_name_order() {
    let mut environment = CelEnvironment::default();
    environment
        .register_namespace(
            "Zed",
            vec![
                "total(double, int): double".into(),
                // The same name declared again keeps its first place and takes the new form.
                NamespaceFunctionDeclaration::withheld("total", "int"),
                NamespaceFunctionDeclaration::withheld("rows", list_of(STRING)),
                "count(Cents): Receipt".into(),
            ],
            NamespaceOptions { open: true },
        )
        .expect("registers");
    let flagged = NamespaceFunctionDeclaration {
        deterministic: false,
        host_backed: true,
        throws: Some(vec!["E".into()]),
        ..NamespaceFunctionDeclaration::withheld("x", "Nope")
    };
    environment.register_namespace("Alias", vec![flagged], NamespaceOptions::default()).expect("registers");
    environment.register_namespace("Empty", vec![], NamespaceOptions::default()).expect("registers");
    let listing = |name: &str, functions: &[&str], open: bool| NamespaceListing {
        name: name.into(),
        functions: functions.iter().map(|function| function.to_string()).collect(),
        open,
    };
    assert_eq!(
        environment.definitions().namespaces,
        [
            listing("Alias", &["x(…): dyn"], false),
            listing("Empty", &[], false),
            listing("Zed", &["total(…): int", "rows(…): list<string>", "count(dyn): dyn"], true),
        ]
    );
    assert_eq!(environment.namespaces(), ["Alias", "Empty", "Zed"]);
    // The namespace's name is read as the front end reads one.
    assert_eq!(
        environment.register_namespace("cel", vec![], NamespaceOptions::default()).map_err(|error| error.to_string()),
        Err("\"cel\" is reserved: the standard macros are written on it, and a namespace would capture them".into())
    );
    // A namespaced function is a global one.
    assert_eq!(
        environment
            .register_namespace("Alias", vec!["int.total(): int".into()], NamespaceOptions::default())
            .map_err(|error| error.to_string()),
        Err("a namespaced function is declared without a receiver: \"int.total(): int\"".into())
    );
}

#[test]
fn a_namespace_function_is_built_from_its_public_fields() {
    let declared = NamespaceFunction {
        name: "total".into(),
        returns: INT,
        parameters: Some(vec![DYN]),
        signature: Some("total(dyn): int".into()),
        unregistered_types: vec!["Cents".into()],
        deterministic: true,
        host_backed: false,
        throws: None,
    };
    assert_eq!(declared.clone(), declared);
}

fn open() -> CelEnvironment {
    let mut environment = loose();
    environment
        .register_namespace("Alias", vec!["total(double, int): double".into()], NamespaceOptions { open: true })
        .expect("registers");
    environment
}

/// A namespaced call as the listing holds it.
fn qualified(name: &str, arity: usize, end: u32, argument_types: &[&str]) -> ResolvedCall {
    ResolvedCall {
        name: name.into(),
        form: CallForm::Receiver,
        namespace: Some("Alias".into()),
        arity,
        range: SourceRange { start: 0, end },
        signature: None,
        returns: None,
        deterministic: None,
        host_backed: None,
        throws: None,
        argument_types: Some(argument_types.iter().map(|ty| ty.to_string()).collect()),
    }
}

#[test]
fn an_open_namespace_leaves_a_name_it_did_not_declare_to_the_host() {
    let result = open().check("Alias.whatever(1, 'two')");
    assert_eq!(result.diagnostics, []);
    assert_eq!(result.type_name, "dyn");
    // Listed, so the host can resolve the name against its own vocabulary.
    assert_eq!(result.calls, [qualified("Alias.whatever", 2, 24, &["int", "string"])]);
}

#[test]
fn an_open_namespace_still_judges_a_name_it_did_declare() {
    assert_rows(
        &open(),
        vec![
            ("Alias.total(1.0, 2)", "double", vec![]),
            ("Alias.total(1.0)", "double", vec![found(FunctionArityMismatch, "Alias.total takes 2 arguments, and 1 is written", 0, 16)]),
        ],
    );
}

#[test]
fn an_open_namespace_is_not_the_default_a_closed_one_refuses_an_undeclared_name() {
    let result = closed().check("Alias.whatever(1)");
    assert_eq!(result.diagnostics, [found(FunctionUnresolved, "\"Alias\" declares no function named \"whatever\"", 0, 17)]);
    assert_eq!(result.calls, [qualified("Alias.whatever", 1, 17, &["int"])]);
}

#[test]
fn openness_is_per_namespace_and_re_registering_closed_withdraws_it() {
    let mut held = loose();
    held.register_namespace("Open", vec![], NamespaceOptions { open: true }).unwrap();
    held.register_namespace("Closed", vec![], NamespaceOptions::default()).unwrap();
    assert_rows(
        &held,
        vec![
            ("Open.x()", "dyn", vec![]),
            ("Closed.x()", "dyn", vec![found(FunctionUnresolved, "\"Closed\" declares no function named \"x\"", 0, 10)]),
        ],
    );
    held.register_namespace("Open", vec![], NamespaceOptions::default()).unwrap();
    assert_eq!(first_code(&held.check("Open.x()")), Some(FunctionUnresolved));
}

#[test]
fn openness_is_inherited_by_a_clone_which_may_then_diverge() {
    let mut parent = loose();
    parent.register_namespace("Alias", vec![], NamespaceOptions { open: true }).unwrap();
    let mut child = parent.clone();
    assert_eq!(child.check("Alias.x()").diagnostics, []);
    child.register_namespace("Alias", vec![], NamespaceOptions::default()).unwrap();
    assert_eq!(first_code(&child.check("Alias.x()")), Some(FunctionUnresolved));
    assert_eq!(parent.check("Alias.x()").diagnostics, []);
}

#[test]
fn a_withheld_declaration_types_the_calls_result_and_judges_neither_its_arity_nor_its_arguments() {
    let held = withheld();
    for (source, end, argument_types) in [
        ("Alias.total()", 13, vec![]),
        ("Alias.total(1.0, 2)", 19, vec!["double", "int"]),
        ("Alias.total('a', 'b', 'c')", 26, vec!["string", "string", "string"]),
    ] {
        let result = held.check(source);
        assert_eq!(result.diagnostics, [], "{source}");
        assert_eq!(result.type_name, "double", "{source}");
        // Listed with its arity, which is what lets the host judge what this engine did not.
        assert_eq!(
            result.calls,
            [ResolvedCall {
                returns: Some("double".into()),
                deterministic: Some(true),
                host_backed: Some(false),
                ..qualified("Alias.total", argument_types.len(), end, &argument_types)
            }],
            "{source}"
        );
    }
}

#[test]
fn a_withheld_declaration_types_an_operator_over_the_result() {
    assert_rows(
        &withheld(),
        vec![
            ("Alias.total(1) + 1.0", "double", vec![]),
            ("Alias.total(1) + 'x'", "dyn", vec![found(TypeError, "no \"+\" is declared over double, string", 0, 20)]),
        ],
    );
}

#[test]
fn a_withheld_declaration_carries_its_flags_exactly_as_a_full_signature_does() {
    let mut held = loose();
    held.register_namespace(
        "Alias",
        vec![NamespaceFunctionDeclaration {
            deterministic: false,
            host_backed: true,
            throws: Some(vec!["ERR_X".into()]),
            ..NamespaceFunctionDeclaration::withheld("clock", "int")
        }],
        NamespaceOptions::default(),
    )
    .unwrap();
    let call = &held.check("Alias.clock()").calls[0];
    assert_eq!((call.deterministic, call.host_backed, call.throws.clone()), (Some(false), Some(true), Some(vec!["ERR_X".into()])));
}

#[test]
fn a_withheld_declaration_takes_a_cel_type_as_readily_as_its_text() {
    for returns in [NamespaceFunctionDeclaration::withheld("rows", "list<string>"), NamespaceFunctionDeclaration::withheld("rows", list_of(STRING))] {
        let mut held = loose();
        held.register_namespace("Alias", vec![returns], NamespaceOptions::default()).unwrap();
        assert_eq!(held.check("Alias.rows()").type_name, "list<string>");
        assert_eq!(held.check("Alias.rows()[0]").type_name, "string");
    }
}

#[test]
fn a_declaration_naming_an_unregistered_type_is_accepted_and_the_call_carries_a_ranged_type_error() {
    let mut held = loose();
    held.register_namespace("Alias", vec![NamespaceFunctionDeclaration::withheld("untyped", "NoSuchType")], NamespaceOptions::default())
        .unwrap();
    let result = held.check("Alias.untyped(1)");
    assert_eq!(
        result.diagnostics,
        [found(TypeError, "Alias.untyped is declared over the type \"NoSuchType\", and no type is registered under that name", 0, 16)]
    );
    // Listed and read as `dyn`: the structural reading of the call still stands.
    assert_eq!(
        result.calls,
        [ResolvedCall {
            name: "Alias.untyped".into(),
            returns: Some("dyn".into()),
            deterministic: Some(true),
            host_backed: Some(false),
            ..qualified("Alias.untyped", 1, 16, &["int"])
        }]
    );
    assert_eq!(result.type_name, "dyn");
}

#[test]
fn a_declaration_naming_a_registered_type_reports_nothing() {
    let mut registered = loose();
    registered.register_type(NominalTypeDefinition { name: "NoSuchType".into(), base: "int".into(), ..Default::default() }).unwrap();
    registered
        .register_namespace("Alias", vec![NamespaceFunctionDeclaration::withheld("untyped", "NoSuchType")], NamespaceOptions::default())
        .unwrap();
    assert_rows(&registered, vec![("Alias.untyped(1)", "NoSuchType", vec![])]);
}

#[test]
fn an_unregistered_type_reads_the_same_in_the_full_signature_form_in_a_parameter_as_in_the_result() {
    let mut held = loose();
    held.register_namespace("Alias", vec!["total(Cents): Receipt".into()], NamespaceOptions::default()).unwrap();
    assert_eq!(
        held.check("Alias.total(1)").diagnostics,
        [found(TypeError, "Alias.total is declared over the types \"Cents\", \"Receipt\", and no type is registered under those names", 0, 14)]
    );
}
