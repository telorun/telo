//! Twin of `cel/nodejs/tests/nominal-type.test.ts`, case for case.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. Where Node's case asserts only an error's class or a
//! diagnostic's code, the messages are pinned here too, from the same run.

mod check_support;

use check_support::{assert_rows, found};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelEnvironment, CelRegistrationError, CelTypeRegistrationError, FunctionDefinition, FunctionMetadata,
    NominalTypeDefinition, TypeDefinitionListing,
};

fn label() -> NominalTypeDefinition {
    NominalTypeDefinition {
        name: "Label".into(),
        base: "string".into(),
        comparisons: vec!["==".into(), "!=".into()],
        conversions: vec!["string(Self): string".into()],
        members: vec!["Self.withSuffix(string): Self".into()],
        ..Default::default()
    }
}

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

#[test]
fn is_not_its_base_the_bases_own_operators_and_slots_refuse_it() {
    let mut environment = CelEnvironment::default();
    environment.register_type(label()).unwrap();
    environment.register_variable("label", "Label", None).unwrap();
    environment.register_variable("text", "string", None).unwrap();
    environment.register_function("shout(Label): Label", FunctionMetadata::default()).unwrap();
    assert_rows(
        &environment,
        vec![
            ("label.withSuffix('-x')", "Label", vec![]),
            ("string(label)", "string", vec![]),
            ("label == label", "bool", vec![]),
            // A plain string does not stand where the named type is wanted...
            ("shout('plain')", "dyn", vec![found(TypeError, "no overload of \"shout\" takes shout(string): shout(Label): Label", 0, 14)]),
            // ...and the base's operators do not apply to it until its host registers them.
            ("label + text", "dyn", vec![found(TypeError, "no \"+\" is declared over Label, string", 0, 12)]),
            (
                "label.startsWith('x')",
                "dyn",
                vec![found(TypeError, "no overload of \"startsWith\" takes Label.startsWith(string): string.startsWith(string): bool", 0, 21)],
            ),
        ],
    );
}

#[test]
fn holds_its_type_arguments_invariantly_and_says_so_when_they_differ() {
    let mut environment = CelEnvironment::default();
    environment.register_type(holder()).unwrap();
    environment.register_variable("strings", "Holder<string>", None).unwrap();
    environment.register_variable("ints", "Holder<int>", None).unwrap();
    environment.register_function("firstText(Holder<string>): string", FunctionMetadata::default()).unwrap();
    assert_rows(
        &environment,
        vec![
            ("strings.first()", "string", vec![]),
            ("ints.first()", "int", vec![]),
            ("firstText(strings)", "string", vec![]),
            ("strings.plus(strings)", "Holder<string>", vec![]),
            (
                "strings.plus(ints)",
                "dyn",
                vec![found(TypeArgumentMismatch, "Holder<string> and Holder<int> are the same type with different type arguments, which never match", 0, 18)],
            ),
            (
                "firstText(ints)",
                "dyn",
                vec![found(TypeArgumentMismatch, "Holder<int> and Holder<string> are the same type with different type arguments, which never match", 0, 15)],
            ),
        ],
    );
}
