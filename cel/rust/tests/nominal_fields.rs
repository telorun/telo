//! Twin of `cel/nodejs/tests/nominal-fields.test.ts`: every case but the one that
//! evaluates on both backends, which arrives with evaluation, and the digest half of the
//! third, which has no twin because there is no emitter here.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. Past the Node file: the range of each refusal.

mod check_support;

use check_support::{assert_rows, environment, found, optional_types};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{CelEnvironment, FunctionMetadata, NominalTypeDefinition, PropertyMap, TypeDefinitionListing};

/// Invented names: the engine owns the mechanism and knows no host's vocabulary.
fn place() -> NominalTypeDefinition {
    NominalTypeDefinition {
        name: "Place".into(),
        base: "dyn".into(),
        fields: Some(
            [("street", "string"), ("number", "int"), ("tags", "map<string, string>")]
                .into_iter()
                .map(|(name, ty)| (name, ty.to_string()))
                .collect(),
        ),
        ..Default::default()
    }
}

fn places() -> CelEnvironment {
    let mut environment = environment(optional_types());
    environment.register_type(place()).unwrap();
    environment.register_variable("p", "Place", None).unwrap();
    environment.register_function("string(Place): string", FunctionMetadata::default()).unwrap();
    environment
}

#[test]
fn types_each_field_in_every_select_form_and_refuses_a_name_it_does_not_declare() {
    const MISSING: &str = "\"missing\" is not a field of Place (fields: street, number, tags)";
    assert_rows(
        &places(),
        vec![
            ("p.street", "string", vec![]),
            ("p['street']", "string", vec![]),
            ("p.number", "int", vec![]),
            ("p.?number", "optional<int>", vec![]),
            ("has(p.number)", "bool", vec![]),
            ("p.tags.kind", "string", vec![]),
            ("p.missing", "dyn", vec![found(UnknownField, MISSING, 2, 9)]),
            ("p.?missing", "optional<dyn>", vec![found(UnknownField, MISSING, 3, 10)]),
            ("has(p.missing)", "bool", vec![found(UnknownField, MISSING, 6, 13)]),
            ("p['missing']", "dyn", vec![found(UnknownField, MISSING, 2, 11)]),
        ],
    );
}

#[test]
fn lists_its_declared_fields() {
    let fields: PropertyMap<String> =
        [("street", "string"), ("number", "int"), ("tags", "map<string, string>")].into_iter().map(|(k, v)| (k, v.to_string())).collect();
    assert_eq!(
        places().definitions().types,
        [TypeDefinitionListing {
            name: "Place".into(),
            base: "dyn".into(),
            parameters: vec![],
            fields: Some(fields),
            description: None,
        }]
    );
}
