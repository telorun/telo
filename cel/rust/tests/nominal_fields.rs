//! Twin of `cel/nodejs/tests/nominal-fields.test.ts`: every case, less the half of the
//! second that compares the emitted module with the closure backend and the digest half of
//! the third, which have no twin because there is no emitter here.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`, and for what evaluation answers
//! `@telorun/cel 0.120.1 at b4a2b6e9`. Past the Node file: the range of each refusal.

mod check_support;
mod evaluation_support;

use std::sync::Arc;

use check_support::{assert_rows, environment, found, optional_types};
use evaluation_support::program_answer;
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelCallContext, CelEnvironment, CelHostValue, CelRecord, CelValue, FunctionMetadata, NominalTypeDefinition,
    PropertyMap, TypeDefinitionListing,
};

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

/// A value of the type: its own entries, one of them a name the type does not declare.
fn a_place() -> CelValue {
    let entries: PropertyMap<CelValue> = [
        ("street", CelValue::String("Main".into())),
        ("tags", CelValue::Record([("kind", CelValue::String("shop".into()))].into_iter().collect::<CelRecord>())),
        ("hidden", CelValue::String("not a field".into())),
    ]
    .into_iter()
    .collect();
    CelValue::Host(CelHostValue::with_entries("Place", Arc::new(()), entries).unwrap())
}

#[test]
fn answers_its_declared_fields_from_the_values_own_entries_and_nothing_else() {
    let mut environment = places();
    let implementation = Arc::new(|context: &CelCallContext, args: &[CelValue]| {
        let [CelValue::Host(place)] = args else { unreachable!("string(Place) is handed a place") };
        let Some(CelValue::String(street)) = place.entries().get("street") else { unreachable!("a place has a street") };
        assert!(context.range.is_some());
        CelValue::String(format!("place:{street}").into())
    });
    environment
        .register_function(
            "string(Place): string",
            FunctionMetadata { implementation: Some(implementation), ..FunctionMetadata::default() },
        )
        .unwrap();
    let activation: PropertyMap<CelValue> = [("p", a_place())].into_iter().collect();
    for (source, expected) in [
        ("p.street", "value string \"Main\""),
        ("p['street']", "value string \"Main\""),
        ("p.tags.kind", "value string \"shop\""),
        ("has(p.street)", "value bool true"),
        ("has(p.number)", "value bool false"),
        ("p.?number", "value optional()"),
        ("p.?street", "value optional(string \"Main\")"),
        ("p.number", "error no_such_key [0, 8] no such key: \"number\""),
        ("dyn(p).hidden", "error no_such_key [0, 13] no such key: \"hidden\""),
        ("has(dyn(p).hidden)", "value bool false"),
        ("string(p)", "value string \"place:Main\""),
    ] {
        assert_eq!(program_answer(&environment.compile(source).unwrap(), &activation), expected, "{source}");
    }
}
