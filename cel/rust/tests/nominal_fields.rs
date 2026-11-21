//! Twin of `cel/nodejs/tests/nominal-fields.test.ts`: every case, less the half of the
//! second that compares the emitted module with the closure backend, the digest half of
//! the third, the emitted halves of the constructible type's cases and its digest case,
//! which have no twin because there is no emitter here.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`, and for what evaluation answers
//! `@telorun/cel 0.120.1 at b4a2b6e9`; the constructible type's cases are this branch's
//! Node build. Past the Node file: the range of each refusal, and the construction listing.

mod check_support;
mod evaluation_support;

use std::sync::{Arc, Mutex};

use check_support::{assert_rows, environment, found, optional_types};
use evaluation_support::program_answer;
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    cel_error, CelCallContext, CelConstruct, CelEnvironment, CelEvaluationCode, CelEvaluationError,
    CelHostValue, CelImplementation, CelRecord, CelRegistrationError, CelValue, ConstructibleListing, EvaluateOptions,
    FunctionMetadata, NominalTypeDefinition, PropertyMap, RegisterCatalogOptions, RegisterTypeOptions, SourceRange,
    TypeDefinitionListing, register_function_catalog,
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
            constructible: None,
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

// --- a constructible named type -------------------------------------------------------

/// A constructible Place: the same fields, and `street` must be written.
fn constructible_place() -> NominalTypeDefinition {
    NominalTypeDefinition { constructible: true, required: vec!["street".into()], ..place() }
}

fn constructible_places(options: RegisterTypeOptions) -> CelEnvironment {
    let mut environment = environment(optional_types());
    environment.register_type_with(constructible_place(), options).unwrap();
    environment
}

fn json_quote(text: &str) -> String {
    serde_json::Value::String(text.into()).to_string()
}

/// A value as Node's `JSON.stringify` writes it, an int as `"<n>n"`.
fn json_of(value: &CelValue) -> String {
    match value {
        CelValue::Null => "null".into(),
        CelValue::Bool(held) => held.to_string(),
        CelValue::Int(held) => format!("\"{held}n\""),
        CelValue::String(held) => json_quote(held),
        CelValue::Host(host) => {
            let entries: Vec<String> = host.entries().iter().map(|(key, held)| format!("{}:{}", json_quote(key), json_of(held))).collect();
            format!("{{{}}}", entries.join(","))
        }
        other => unreachable!("no construction here holds {other:?}"),
    }
}

/// Each program's answer, as Node's test writes it: the value with its type, or the
/// error's code, range and message.
fn answers(environment: &CelEnvironment, sources: &[&str]) -> Vec<String> {
    sources
        .iter()
        .map(|source| {
            let answer = match environment.compile(source).unwrap().evaluate(&(), &EvaluateOptions::default()) {
                Ok(value) => {
                    let as_type = match &value {
                        CelValue::Host(host) => format!(" as {}", host.type_name().unwrap()),
                        _ => String::new(),
                    };
                    format!("value {}{as_type}", json_of(&value))
                }
                Err(CelEvaluationError::Error(error)) => {
                    let range = error.range.unwrap();
                    format!("error {} [{}, {}] {}", error.code.as_str(), range.start, range.end, error.message)
                }
                Err(CelEvaluationError::Host(_)) => unreachable!("no host function is called"),
            };
            format!("{source} → {answer}")
        })
        .collect()
}

#[test]
fn is_built_by_the_engine_without_a_builder_in_the_form_a_host_builds_one() {
    let environment = constructible_places(RegisterTypeOptions::default());
    let built = environment.evaluate("Place{street: 'Main', number: 4}", &(), &EvaluateOptions::default()).unwrap();
    let CelValue::Host(host) = &built else { panic!("a construction builds a host value: {built:?}") };
    assert_eq!(host.type_name(), Some("Place"));
    let entries: Vec<(&str, &CelValue)> = host.entries().iter().collect();
    assert_eq!(entries, [("street", &CelValue::String("Main".into())), ("number", &CelValue::Int(4))]);
    // Unchecked, a construction the check refuses answers the refusal's own words.
    assert_eq!(
        answers(
            &environment,
            &[
                "Place{street: 'Main', number: 4}",
                "Place{?number: optional.none(), street: 'x'}",
                "Place{street: 'x', number: 1 / 0}",
                "Shop{street: 1 / 0}",
                "Shop{}",
                "Place{street: 'x', floor: 2}",
                "Place{street: 'x', street: 'y'}",
                "Place{street: 'x', ?number: 1}",
            ],
        ),
        [
            "Place{street: 'Main', number: 4} → value {\"street\":\"Main\",\"number\":\"4n\"} as Place",
            "Place{?number: optional.none(), street: 'x'} → value {\"street\":\"x\"} as Place",
            "Place{street: 'x', number: 1 / 0} → error division_by_zero [27, 32] division by zero",
            "Shop{street: 1 / 0} → error division_by_zero [13, 18] division by zero",
            "Shop{} → error no_matching_overload [0, 6] no type named \"Shop\" is registered \u{2014} the closest constructible: Place",
            "Place{street: 'x', floor: 2} → error invalid_argument [0, 28] \"floor\" is not a field of Place (fields: street, number, tags)",
            "Place{street: 'x', street: 'y'} → error invalid_argument [0, 31] field \"street\" of Place is written more than once",
            "Place{street: 'x', ?number: 1} → error no_matching_overload [0, 30] an entry written with '?' holds an optional",
        ]
    );
}

#[test]
fn is_built_by_the_hosts_builder_handed_the_constructions_range_and_the_fields_written() {
    let handed: Arc<Mutex<Vec<(Option<SourceRange>, Vec<(String, CelValue)>)>>> = Arc::default();
    let recorded = Arc::clone(&handed);
    let construct: CelConstruct = Arc::new(move |context: &CelCallContext, fields: &PropertyMap<CelValue>| {
        let written: Vec<(String, CelValue)> = fields.iter().map(|(name, value)| (name.to_string(), value.clone())).collect();
        recorded.lock().unwrap().push((context.range, written));
        match fields.get("street") {
            Some(CelValue::String(street)) if street.is_empty() => {
                cel_error(CelEvaluationCode::InvalidArgument, "Place: street must not be empty", context.range).into()
            }
            _ => CelValue::Host(CelHostValue::with_entries("Place", Arc::new(()), fields.clone()).unwrap()),
        }
    });
    let environment = constructible_places(RegisterTypeOptions { construct: Some(construct) });
    assert_eq!(
        answers(&environment, &["Place{street: 'Main', ?number: optional.none()}", "Place{street: ''}"]),
        [
            "Place{street: 'Main', ?number: optional.none()} → value {\"street\":\"Main\"} as Place",
            "Place{street: ''} → error invalid_argument [0, 17] Place: street must not be empty",
        ]
    );
    assert_eq!(
        *handed.lock().unwrap(),
        [
            (Some(SourceRange { start: 0, end: 47 }), vec![("street".into(), CelValue::String("Main".into()))]),
            (Some(SourceRange { start: 0, end: 17 }), vec![("street".into(), CelValue::String("".into()))]),
        ]
    );
}

fn registration_refusal(result: Result<(), CelRegistrationError>) -> String {
    match result {
        Err(CelRegistrationError::Registration(refused)) => refused.message,
        other => panic!("refused as a registration: {other:?}"),
    }
}

#[test]
fn refuses_an_equality_or_inequality_that_would_compare_its_values_before_or_after_the_type() {
    let places = constructible_places(RegisterTypeOptions::default());
    let refused = |signature: &str| {
        format!(
            "{signature} cannot be registered: it would compare values of Place, which is constructible, and a constructible type's values are equal exactly when their fields are; normalise the fields in its builder, or register Place without constructible"
        )
    };
    for (operator, parameters, signature) in [
        ("==", ["Place", "Place"], "==(Place, Place)"),
        ("==", ["Place", "string"], "==(Place, string)"),
        ("==", ["dyn", "dyn"], "==(dyn, dyn)"),
        ("!=", ["A", "A"], "!=(A, A)"),
    ] {
        let mut clone = places.clone();
        assert_eq!(
            registration_refusal(clone.register_operator(operator, &parameters, "bool", FunctionMetadata::default())),
            refused(signature)
        );
    }
    let mut lists = places.clone();
    lists.register_operator("==", &["list<A>", "list<A>"], "bool", FunctionMetadata::default()).unwrap();
    let mut hosted = environment(optional_types());
    hosted.register_type(place()).unwrap();
    let never: CelImplementation = Arc::new(|_: &CelCallContext, _: &[CelValue]| CelValue::Bool(false));
    hosted
        .register_operator("==", &["Place", "Place"], "bool", FunctionMetadata { implementation: Some(never), ..FunctionMetadata::default() })
        .unwrap();
    assert_eq!(
        registration_refusal(hosted.register_type(constructible_place())),
        "Place cannot be constructible: ==(Place, Place) is registered and would compare its values, and a constructible type's values are equal exactly when their fields are"
    );
}

#[test]
fn refuses_a_written_value_its_fields_type_does_not_admit_before_the_builder_is_called() {
    let calls: Arc<Mutex<usize>> = Arc::default();
    let counted = Arc::clone(&calls);
    let construct: CelConstruct = Arc::new(move |_: &CelCallContext, fields: &PropertyMap<CelValue>| {
        *counted.lock().unwrap() += 1;
        CelValue::Host(CelHostValue::with_entries("Place", Arc::new(()), fields.clone()).unwrap())
    });
    let environment = constructible_places(RegisterTypeOptions { construct: Some(construct) });
    assert_eq!(
        answers(&environment, &["Place{street: 'a', number: dyn(1.5)}"]),
        ["Place{street: 'a', number: dyn(1.5)} → error invalid_argument [27, 35] field \"number\" of Place is int, and this value is double"]
    );
    assert_eq!(*calls.lock().unwrap(), 0);
}

#[test]
fn hands_its_field_wise_equality_to_the_catalogs_distinct() {
    let mut environment = constructible_places(RegisterTypeOptions::default());
    register_function_catalog(&mut environment, RegisterCatalogOptions::default());
    assert_eq!(
        answers(&environment, &["size(distinct([Place{street: 'Main'}, Place{street: 'Main'}, Place{street: 'Elm'}]))"]),
        ["size(distinct([Place{street: 'Main'}, Place{street: 'Main'}, Place{street: 'Elm'}])) → value \"2n\""]
    );
}

#[test]
fn lists_its_construction_the_required_fields_and_whether_the_host_builds_it() {
    let listed = |options: RegisterTypeOptions| constructible_places(options).definitions().types[0].constructible.clone();
    assert_eq!(listed(RegisterTypeOptions::default()), Some(ConstructibleListing { required: vec!["street".into()], builder: false }));
    let construct: CelConstruct = Arc::new(|_: &CelCallContext, _: &PropertyMap<CelValue>| CelValue::Null);
    assert_eq!(
        listed(RegisterTypeOptions { construct: Some(construct) }),
        Some(ConstructibleListing { required: vec!["street".into()], builder: true })
    );
}

#[test]
fn refuses_a_definition_no_construction_could_build_and_required_fields_or_a_builder_for_a_type_none_can() {
    let refusal = |definition: NominalTypeDefinition, options: RegisterTypeOptions| {
        match CelEnvironment::default().register_type_with(definition, options) {
            Err(CelRegistrationError::Registration(refused)) => refused.message,
            other => panic!("refused as a definition: {other:?}"),
        }
    };
    let construct: CelConstruct = Arc::new(|_: &CelCallContext, _: &PropertyMap<CelValue>| CelValue::Null);
    assert_eq!(
        refusal(
            NominalTypeDefinition { name: "Bare".into(), base: "dyn".into(), constructible: true, ..Default::default() },
            RegisterTypeOptions::default()
        ),
        "Bare is constructible and declares no fields; declare `fields`, an empty set for a type with none"
    );
    assert_eq!(
        refusal(
            NominalTypeDefinition {
                name: "Box".into(),
                base: "dyn".into(),
                parameters: vec!["A".into()],
                fields: Some([("held", "A".to_string())].into_iter().collect()),
                constructible: true,
                ..Default::default()
            },
            RegisterTypeOptions::default()
        ),
        "Box is constructible and takes type parameters, which a construction has no place to write"
    );
    assert_eq!(
        refusal(NominalTypeDefinition { required: vec!["floor".into()], ..constructible_place() }, RegisterTypeOptions::default()),
        "required field \"floor\" of Place is not one of its fields"
    );
    assert_eq!(
        refusal(NominalTypeDefinition { required: vec!["street".into()], ..place() }, RegisterTypeOptions::default()),
        "Place lists required fields and is not constructible"
    );
    assert_eq!(
        refusal(place(), RegisterTypeOptions { construct: Some(construct) }),
        "Place is given a builder and is not constructible"
    );
}
