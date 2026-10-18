//! Twin of `cel/nodejs/tests/environment.test.ts`, case for case.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`.

mod check_support;

use std::sync::Arc;

use check_support::{codes, environment, first_code};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelEnvironment, CelEnvironmentOptions, CelType, FunctionMetadata, NominalType, NominalTypeDefinition,
    TypeDefinitionListing, VariableDefinition, INT,
};

/// A name no host of this engine uses, so a test's vocabulary is its own.
fn money() -> NominalTypeDefinition {
    NominalTypeDefinition {
        name: "Money".into(),
        base: "int".into(),
        description: Some("an amount in the smallest unit".into()),
        ..Default::default()
    }
}

#[test]
fn registers_a_function_overrides_one_signature_exactly_and_removes_one() {
    let mut environment = CelEnvironment::default();
    assert_eq!(environment.check("duration('30d')").type_name, "google.protobuf.Duration");

    // A standard signature is replaceable.
    environment.register_type(money()).unwrap();
    environment.register_function("duration(string): Money", FunctionMetadata::default()).unwrap();
    assert_eq!(environment.check("duration('30d')").type_name, "Money");
    let signatures: Vec<String> = environment.definitions().functions.into_iter().map(|entry| entry.signature).collect();
    assert!(signatures.iter().any(|signature| signature == "duration(string): Money"));
    assert!(!signatures.iter().any(|signature| signature == "duration(string): google.protobuf.Duration"));

    // Removal is by the same exact key: the name's other overload stays...
    assert_eq!(environment.remove_function("duration(string): Money"), Ok(true));
    assert_eq!(codes(&environment.check("duration('30d')")), [TypeError]);
    // ...and emptying the name is what makes a call to it unknown.
    assert_eq!(environment.remove_functions_named("duration"), 1);
    assert_eq!(codes(&environment.check("duration('30d')")), [UnknownFunction]);
}

#[test]
fn removes_every_overload_of_a_name_so_a_call_to_it_is_unknown() {
    let mut environment = CelEnvironment::default();
    assert_eq!(environment.remove_functions_named("size"), 8);
    assert_eq!(first_code(&environment.check("size('abc')")), Some(UnknownFunction));
    assert_eq!(first_code(&environment.check("'abc'.size()")), Some(UnknownFunction));
}

#[test]
fn adds_an_overload_beside_an_existing_one_rather_than_replacing_it() {
    let mut environment = CelEnvironment::default();
    environment.register_type(money()).unwrap();
    environment.register_function("string(Money): string", FunctionMetadata::default()).unwrap();
    assert_eq!(environment.check("string(1)").type_name, "string");
    let named: Vec<String> = environment
        .definitions()
        .functions
        .into_iter()
        .filter(|entry| entry.name == "string")
        .map(|entry| entry.signature)
        .collect();
    assert!(named.iter().any(|signature| signature == "string(Money): string"));
    assert_eq!(named.len(), 10);
}

#[test]
fn lets_a_clone_diverge_without_touching_its_parent() {
    let mut parent = CelEnvironment::default();
    parent.register_variable("port", "int", None).unwrap();
    let mut child = parent.clone();
    child.remove_functions_named("size");
    child.register_variable("host", "string", None).unwrap();
    assert!(parent.check("size('a')").valid);
    assert!(!child.check("size('a')").valid);
    assert!(!parent.has_variable("host"));
    assert!(child.has_variable("port"));
}

#[test]
fn registers_an_operator_a_constant_and_a_described_variable_and_lists_them() {
    let mut environment = CelEnvironment::default();
    environment.register_type(money()).unwrap();
    environment.register_operator("+", &["Money", "Money"], "Money", FunctionMetadata::default()).unwrap();
    environment.register_constant("zero", "Money", Some("no money at all".into())).unwrap();
    environment.register_variable("paid", "Money", Some("what was paid".into())).unwrap();
    assert_eq!(environment.check("paid + zero").type_name, "Money");
    assert!(environment.has_variable("zero"));
    let definitions = environment.definitions();
    let zero: Vec<&VariableDefinition> = definitions.variables.iter().filter(|variable| variable.name == "zero").collect();
    assert_eq!(
        zero,
        [&VariableDefinition {
            name: "zero".into(),
            ty: CelType::Nominal(NominalType { name: "Money".into(), base: Arc::new(INT), args: Arc::new([]), fields: None }),
            type_name: "Money".into(),
            description: Some("no money at all".into()),
            constant: true,
        }]
    );
    assert_eq!(definitions.variables.iter().find(|variable| variable.name == "paid").map(|variable| variable.constant), Some(false));
    assert_eq!(
        definitions.types,
        [TypeDefinitionListing {
            name: "Money".into(),
            base: "int".into(),
            parameters: vec![],
            fields: None,
            description: Some("an amount in the smallest unit".into()),
        }]
    );
}

#[test]
fn carries_the_options_the_host_asked_for_and_defaults_to_the_languages_own() {
    let strict = CelEnvironment::default();
    let options = strict.options();
    assert_eq!(
        (options.unlisted_variables_are_dyn, options.homogeneous_aggregate_literals, options.enable_optional_types),
        (false, false, false)
    );
    assert_eq!(first_code(&strict.check("whatever")), Some(UnknownIdentifier));
    assert_eq!(strict.check("[1, 'a']").type_name, "list");
    assert_eq!(first_code(&strict.check("optional.of(1)")), Some(UnknownFunction));

    let loose = environment(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        homogeneous_aggregate_literals: true,
        enable_optional_types: true,
        ..Default::default()
    });
    assert_eq!(loose.check("whatever").type_name, "dyn");
    assert_eq!(first_code(&loose.check("[1, 'a']")), Some(TypeError));
    assert_eq!(loose.check("optional.of(1).hasValue()").type_name, "bool");
    assert!(loose.clone().options().unlisted_variables_are_dyn);
}

#[test]
fn holds_the_well_known_type_names_under_google() {
    let environment = CelEnvironment::default();
    assert_eq!(
        environment.check("type(timestamp('2026-01-01T00:00:00Z')) == google.protobuf.Timestamp").type_name,
        "bool"
    );
    assert_eq!(
        environment.definitions().variables.iter().find(|variable| variable.name == "google").map(|variable| variable.type_name.as_str()),
        Some("map<string, map<string, type>>")
    );
}

#[test]
fn answers_whether_a_type_converts_to_text_which_is_the_environments_own_string() {
    let mut environment = CelEnvironment::default();
    environment.register_type(money()).unwrap();
    let type_of = |environment: &CelEnvironment, source: &str| environment.check(source).ty;
    assert!(environment.converts_to_string(&type_of(&environment, "1")));
    assert!(!environment.converts_to_string(&type_of(&environment, "[1]")));
    assert!(environment.converts_to_string(&type_of(&environment, "dyn(1)")));
    // A named type converts only once its host registers the conversion.
    environment.register_variable("paid", "Money", None).unwrap();
    assert!(!environment.converts_to_string(&type_of(&environment, "paid")));
    environment.register_function("string(Money): string", FunctionMetadata::default()).unwrap();
    assert!(environment.converts_to_string(&type_of(&environment, "paid")));
}
