//! Twin of `cel/nodejs/tests/nominal-type.test.ts`: the cases that need no `check`. The
//! other two — a named type is not its base, and its arguments are invariant — check
//! expressions, and arrive here with the checker.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. Node's case asserts only the error's class; the
//! messages are pinned here too, from the same run.

use telorun_cel::{
    CelEnvironment, CelRegistrationError, CelTypeRegistrationError, FunctionDefinition, NominalTypeDefinition,
    TypeDefinitionListing,
};

fn holder() -> NominalTypeDefinition {
    NominalTypeDefinition {
        name: "Holder".into(),
        base: "list<A>".into(),
        parameters: vec!["A".into()],
        members: vec!["Self.first(): A".into(), "Self.plus(Self): Self".into()],
        ..Default::default()
    }
}

#[test]
fn refuses_a_registration_that_would_redefine_the_language_or_hide_a_parameter() {
    let definition = |name: &str, base: &str, parameters: &[&str]| NominalTypeDefinition {
        name: name.into(),
        base: base.into(),
        parameters: parameters.iter().map(|parameter| parameter.to_string()).collect(),
        ..Default::default()
    };
    // `(definition, the message of the CelTypeRegistrationError Node throws)`.
    let node_refused = [
        (definition("map", "int", &[]), "\"map\" is the type key of a value this engine builds"),
        (definition("T", "int", &[]), "\"T\" is a single capital letter, which a signature reads as a type parameter"),
        (
            definition("Weird", "Unknown", &[]),
            "the base of Weird does not read as a type: no type is registered under the name \"Unknown\"",
        ),
        (definition("Bad", "int", &["Element"]), "type parameter \"Element\" of Bad must be a single capital letter"),
    ];
    let mut environment = CelEnvironment::default();
    for (definition, message) in node_refused {
        assert_eq!(
            environment.register_type(definition),
            Err(CelRegistrationError::Registration(CelTypeRegistrationError { message: message.into() }))
        );
    }
}

#[test]
fn names_the_hosts_own_type_in_the_definition_listing_with_its_base() {
    let mut environment = CelEnvironment::default();
    environment.register_type(holder()).expect("registers");
    let listing = environment.definitions();
    assert_eq!(
        listing.types,
        [TypeDefinitionListing {
            name: "Holder".into(),
            base: "list<A>".into(),
            parameters: vec!["A".into()],
            fields: None,
            description: None,
        }]
    );
    let first: Vec<FunctionDefinition> = listing.functions.into_iter().filter(|entry| entry.name == "first").collect();
    assert_eq!(
        first,
        [FunctionDefinition {
            name: "first".into(),
            signature: "Holder<A>.first(): A".into(),
            receiver_type: Some("Holder<A>".into()),
            parameters: vec![],
            returns: "A".into(),
            deterministic: true,
            host_backed: false,
            throws: None,
            description: None,
            origin: Some("type:Holder".into()),
        }]
    );
}
