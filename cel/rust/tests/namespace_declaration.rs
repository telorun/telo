//! Twin of `cel/nodejs/tests/namespace-declaration.test.ts`: the cases that need no
//! `check`. Every other case but one checks expressions and arrives here with the
//! checker; the digest case has no twin, because there is no emitter here.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. Past the Node file: the listing of an open, a
//! closed and a withheld namespace together, in name order, and a `NamespaceFunction`
//! built from its public fields.

use telorun_cel::{
    list_of, CelEnvironment, CelEnvironmentOptions, CelRegistrationError, CelTypeExpressionError, NamespaceFunction,
    NamespaceFunctionDeclaration, NamespaceListing, NamespaceOptions, DYN, INT, STRING,
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
