//! Twin of `cel/nodejs/tests/json-schema-type.test.ts`, case for case: a variable typed
//! from a schema, checked.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. A schema is JSON text read with `read_json_text`,
//! and the host's resolvers read the test-only `brand` key, as Node's file does.

mod check_support;

use std::sync::Arc;

use check_support::{codes, first_code, found, json, schema};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelEnvironment, CelEnvironmentOptions, FunctionMetadata, JsonSchemaDocument, JsonValue, NominalTypeDefinition,
    RecursiveSchemaReference, SchemaRegistrationReport, SchemaTypeAnswer, SchemaTypeResolver, UnjudgedReason,
    UnjudgedSchemaNode,
};

const REQUEST: &str = r#"{"type":"object","properties":{
    "query":{"type":"object","properties":{"limit":{"type":"integer"},"tags":{"type":"array","items":{"type":"string"}}}},
    "headers":{"type":"object","additionalProperties":{"type":"string"}},
    "body":{"type":["object","null"],"properties":{"id":{"type":"string"}}},
    "anything":{"type":"object","additionalProperties":true,"properties":{"known":{"type":"integer"}}},
    "either":{"anyOf":[{"type":"string"},{"type":"integer"}]}}}"#;

fn environment() -> CelEnvironment {
    let mut environment = CelEnvironment::default();
    environment.register_variable("request", schema(REQUEST), None).unwrap();
    environment
}

fn with_resolver(resolver: SchemaTypeResolver) -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions { resolve_schema_type: Some(resolver), ..Default::default() })
}

/// The `brand` a node carries, if any.
fn brand(document: &JsonSchemaDocument) -> Option<String> {
    let JsonValue::Object(entries) = &*document.node else { return None };
    match entries.get("brand").map(|value| &**value) {
        Some(JsonValue::String(brand)) => Some(brand.clone()),
        _ => None,
    }
}

fn named(name: &str) -> Option<SchemaTypeAnswer> {
    Some(SchemaTypeAnswer::Named { name: name.into(), args: Vec::new() })
}

fn unjudged(pointer: &str, keywords: &[&'static str], reason: UnjudgedReason) -> UnjudgedSchemaNode {
    UnjudgedSchemaNode { pointer: pointer.into(), through_reference: None, keywords: keywords.to_vec(), type_name: None, reason }
}

fn report(name: &str, unjudged: Vec<UnjudgedSchemaNode>, recursive: Vec<RecursiveSchemaReference>) -> SchemaRegistrationReport {
    SchemaRegistrationReport { name: name.into(), unjudged, recursive }
}

#[test]
fn a_schema_variable_is_typed_to_full_depth_unions_carried_as_unions() {
    let check = |source: &str| environment().check(source).type_name;
    assert_eq!(check("request"), "map");
    assert_eq!(check("request.query"), "map");
    assert_eq!(check("request.query.limit"), "int");
    assert_eq!(check("request.query.tags"), "list<string>");
    assert_eq!(check("request.query.tags[0]"), "string");
    assert_eq!(check("request.headers"), "map<string, string>");
    assert_eq!(check("request.headers['accept']"), "string");
    assert_eq!(check("request.either"), "string|int");
}

#[test]
fn a_typo_two_levels_in_is_a_ranged_error_naming_what_is_declared() {
    assert_eq!(
        environment().check("request.query.limti").diagnostics,
        [found(UnknownField, "\"limti\" is not declared here (declared: limit, tags)", 14, 19)]
    );
}

#[test]
fn a_hosts_own_property_name_is_reached_because_it_is_undeclared_not_because_of_its_name() {
    let result = environment().check("request.__proto__");
    let diagnostic = &result.diagnostics[0];
    assert_eq!((diagnostic.code, diagnostic.range.start, diagnostic.range.end), (UnknownField, 8, 17));
    assert_eq!(first_code(&environment().check("request.whatever")), Some(UnknownField));
}

#[test]
fn nothing_below_a_schema_that_says_a_name_may_be_anything_is_judged() {
    let check = |source: &str| environment().check(source);
    assert_eq!(check("request.anything.known").type_name, "int");
    assert!(check("request.anything.unknown").valid);
    assert_eq!(check("request.anything.unknown.deeper").type_name, "dyn");
}

#[test]
fn a_dereference_of_a_nullable_field_is_reported_and_takes_the_guard_it_is_given() {
    assert_eq!(
        environment().check("request.body.id").diagnostics,
        [found(
            NullableAccess,
            "\"request.body\" may be null \u{2014} guard it (e.g. 'request.body != null && \u{2026}' or 'request.body == null ? \u{2026} : request.body.id') before reading .id",
            13,
            15
        )]
    );
    for guarded in [
        "request.body != null && request.body.id == 'x'",
        "request.body == null || request.body.id == 'x'",
        "request.body != null ? request.body.id : 'x'",
        "request.body == null ? 'x' : request.body.id",
        "!(request.body == null) && request.body.id == 'x'",
    ] {
        assert_eq!(environment().check(guarded).diagnostics, [], "{guarded}");
    }
    // Exactly three constructs prove it: a guard written as a call proves nothing.
    let mut by_call = environment().clone();
    by_call.register_function("present(dyn): bool", FunctionMetadata::default()).unwrap();
    assert_eq!(codes(&by_call.check("present(request.body) && request.body.id == 'x'")), [NullableAccess]);
}

#[test]
fn a_flat_field_map_is_still_accepted_so_a_host_can_type_exactly_as_shallowly_as_it_must() {
    use telorun_cel::{FieldDeclaration, PropertyMap};
    let fields = |entries: Vec<(&str, FieldDeclaration)>| entries.into_iter().collect::<PropertyMap<FieldDeclaration>>();
    let mut shallow = CelEnvironment::default();
    shallow
        .register_variable("self", fields(vec![("columns", "map".into()), ("name", "string".into())]), None)
        .unwrap();
    assert_eq!(shallow.check("self.columns.anything.at.all").type_name, "dyn");
    assert_eq!(shallow.check("self.name").type_name, "string");
    assert_eq!(first_code(&shallow.check("self.nmae")), Some(UnknownField));
    let mut nested = CelEnvironment::default();
    nested
        .register_variable("self", fields(vec![("columns", fields(vec![("id", "string".into())]).into())]), None)
        .unwrap();
    assert_eq!(nested.check("self.columns.id").type_name, "string");
    assert_eq!(first_code(&nested.check("self.columns.di")), Some(UnknownField));
}

#[test]
fn the_hosts_resolver_is_asked_at_every_node_before_the_structure_is_read() {
    let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let held = Arc::clone(&seen);
    let mut environment = with_resolver(Arc::new(move |document| {
        let marker = brand(document)?;
        held.lock().unwrap().push(marker.clone());
        named(&marker)
    }));
    environment.register_type(NominalTypeDefinition { name: "Port".into(), base: "int".into(), ..Default::default() }).unwrap();
    environment
        .register_variable(
            "config",
            schema(
                r#"{"type":"object","properties":{"port":{"type":"object","properties":{"ignored":{"type":"string"}},"brand":"Port"},"name":{"type":"string"}}}"#,
            ),
            None,
        )
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), ["Port"]);
    assert_eq!(environment.check("config.port").type_name, "Port");
    assert_eq!(first_code(&environment.check("config.port.ignored")), Some(TypeError));
    assert_eq!(environment.check("config.name").type_name, "string");
}

const WITH_LOCAL_REF: &str = r##"{"type":"object","properties":{"user":{"$ref":"#/$defs/User"}},
    "$defs":{"User":{"type":"object","properties":{"name":{"type":"string"},"email":{"type":"string"}}}}}"##;

#[test]
fn a_reference_is_followed_inside_its_own_document() {
    let mut typed = CelEnvironment::default();
    typed.register_variable("subject", schema(WITH_LOCAL_REF), None).unwrap();
    assert_eq!(typed.check("subject.user.name").type_name, "string");
    assert_eq!(
        typed.check("subject.user.nmae").diagnostics,
        [found(UnknownField, "\"nmae\" is not declared here (declared: name, email)", 13, 17)]
    );
    assert_eq!(typed.schema_reports(), []);
}

#[test]
fn a_reference_is_read_against_the_document_a_node_belongs_to() {
    let root = json(WITH_LOCAL_REF);
    let JsonValue::Object(top) = &*root else { unreachable!() };
    let JsonValue::Object(properties) = &**top.get("properties").unwrap() else { unreachable!() };
    let node = Arc::clone(properties.get("user").unwrap());
    let mut typed = CelEnvironment::default();
    typed.register_variable("subject", JsonSchemaDocument { node, root: Some(Arc::clone(&root)) }, None).unwrap();
    assert_eq!(typed.check("subject.email").type_name, "string");
}

#[test]
fn a_reference_leaving_the_document_is_answered_by_the_host_with_the_document_to_read_instead() {
    let shared = json(r#"{"$defs":{"Id":{"type":"object","properties":{"value":{"type":"string"},"note":{"not":{}}}}}}"#);
    let JsonValue::Object(top) = &*shared else { unreachable!() };
    let JsonValue::Object(defs) = &**top.get("$defs").unwrap() else { unreachable!() };
    let id = Arc::clone(defs.get("Id").unwrap());
    let mut typed = with_resolver(Arc::new(move |document| {
        let JsonValue::Object(entries) = &*document.node else { return None };
        match entries.get("$ref").map(|value| &**value) {
            Some(JsonValue::String(reference)) if reference == "shared.json#/$defs/Id" => {
                Some(SchemaTypeAnswer::Document(JsonSchemaDocument { node: Arc::clone(&id), root: Some(Arc::clone(&shared)) }))
            }
            _ => None,
        }
    }));
    typed
        .register_variable(
            "subject",
            schema(r##"{"type":"object","properties":{"id":{"$ref":"shared.json#/$defs/Id"}}}"##),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.id.value").type_name, "string");
    assert_eq!(first_code(&typed.check("subject.id.vlaue")), Some(UnknownField));
    assert_eq!(
        typed.schema_reports(),
        [report(
            "subject",
            vec![UnjudgedSchemaNode {
                through_reference: Some("/properties/id".into()),
                ..unjudged("/properties/note", &["not"], UnjudgedReason::KeywordNotRead)
            }],
            vec![]
        )]
    );
}

#[test]
fn a_reference_the_host_does_not_answer_is_reported_by_pointer_never_typed_dyn_in_silence() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable(
            "subject",
            schema(r##"{"type":"object","properties":{"id":{"$ref":"shared.json#/$defs/Id"}}}"##),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.id.anything").type_name, "dyn");
    assert_eq!(
        typed.schema_reports(),
        [report("subject", vec![unjudged("/properties/id", &["$ref"], UnjudgedReason::ReferenceUnresolved)], vec![])]
    );
}

#[test]
fn a_reference_naming_nothing_in_its_own_document_is_reported_the_same_way() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable("subject", schema(r##"{"type":"object","properties":{"id":{"$ref":"#/$defs/Missing"}}}"##), None)
        .unwrap();
    assert_eq!(
        typed.schema_reports()[0].unjudged,
        [unjudged("/properties/id", &["$ref"], UnjudgedReason::ReferenceUnresolved)]
    );
}

#[test]
fn a_reference_re_entered_on_the_descent_terminates_declared_as_recursive_rather_than_reported() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable(
            "subject",
            schema(
                r##"{"$ref":"#/$defs/Node","$defs":{"Node":{"type":"object","properties":{"name":{"type":"string"},"child":{"$ref":"#/$defs/Node"}}}}}"##,
            ),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.name").type_name, "string");
    assert_eq!(typed.check("subject.child.child.name").type_name, "dyn");
    assert_eq!(
        typed.schema_reports(),
        [report(
            "subject",
            vec![],
            vec![RecursiveSchemaReference {
                pointer: "/$defs/Node".into(),
                through_reference: None,
                reference: Some("#/$defs/Node".into()),
            }]
        )]
    );
}

#[test]
fn all_of_composes_a_field_of_each_half_is_read_and_a_third_is_not_declared() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable(
            "subject",
            schema(
                r#"{"allOf":[{"type":"object","properties":{"left":{"type":"string"}}},{"type":"object","properties":{"right":{"type":"integer"}}}]}"#,
            ),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.left").type_name, "string");
    assert_eq!(typed.check("subject.right").type_name, "int");
    assert_eq!(first_code(&typed.check("subject.absent")), Some(UnknownField));
    assert_eq!(typed.schema_reports(), []);
}

#[test]
fn a_reference_intersects_with_what_the_node_says_beside_it() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable(
            "subject",
            schema(
                r##"{"$ref":"#/$defs/Named","type":"object","properties":{"count":{"type":"integer"}},"$defs":{"Named":{"type":"object","properties":{"name":{"type":"string"}}}}}"##,
            ),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.name").type_name, "string");
    assert_eq!(typed.check("subject.count").type_name, "int");
}

#[test]
fn two_things_a_node_says_that_cannot_both_hold_are_reported() {
    let mut typed = CelEnvironment::default();
    typed.register_variable("subject", schema(r#"{"allOf":[{"type":"string"},{"type":"integer"}]}"#), None).unwrap();
    assert_eq!(typed.check("subject").type_name, "dyn");
    assert_eq!(typed.schema_reports()[0].unjudged, [unjudged("", &["allOf"], UnjudgedReason::IntersectionEmpty)]);
}

#[test]
fn a_constant_and_an_enumeration_are_typed_from_their_values_beside_a_host_typed_branch() {
    let mut typed = with_resolver(Arc::new(|document| brand(document).and(named("Path"))));
    typed.register_type(NominalTypeDefinition { name: "Path".into(), base: "string".into(), ..Default::default() }).unwrap();
    typed.register_variable("file", schema(r#"{"anyOf":[{"const":":memory:"},{"brand":"Path"}]}"#), None).unwrap();
    typed.register_variable("mode", schema(r#"{"enum":["read",1,null]}"#), None).unwrap();
    assert_eq!(typed.check("file").type_name, "string|Path");
    assert_eq!(typed.check("mode").type_name, "string|int|null");
    assert_eq!(typed.schema_reports(), []);
}

#[test]
fn a_keyword_it_has_no_rule_for_is_reported_beside_the_type_it_did_produce() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable(
            "subject",
            schema(
                r#"{"type":"object","properties":{
                    "name":{"type":"string","not":{"const":"root"}},
                    "pair":{"type":"array","items":[{"type":"string"},{"type":"integer"}]},
                    "either":{"if":{"type":"string"},"then":{"type":"string"},"else":{"type":"integer"}}}}"#,
            ),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.name").type_name, "string");
    assert_eq!(typed.check("subject.pair").type_name, "list");
    assert_eq!(
        typed.schema_reports()[0].unjudged,
        [
            unjudged("/properties/name", &["not"], UnjudgedReason::KeywordNotRead),
            unjudged("/properties/pair", &["items"], UnjudgedReason::ShapeNotRead),
            unjudged("/properties/either", &["else", "if", "then"], UnjudgedReason::KeywordNotRead),
        ]
    );
}

#[test]
fn a_type_name_the_host_answered_and_nothing_registered_is_reported() {
    let mut typed = with_resolver(Arc::new(|document| brand(document).and(named("Port"))));
    typed
        .register_variable(
            "subject",
            schema(r#"{"type":"object","properties":{"port":{"type":"integer","brand":"Port"}}}"#),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.port").type_name, "int");
    assert_eq!(
        typed.schema_reports()[0].unjudged,
        [UnjudgedSchemaNode {
            type_name: Some("Port".into()),
            ..unjudged("/properties/port", &[], UnjudgedReason::NamedTypeUnregistered)
        }]
    );
}

#[test]
fn a_node_that_constrains_no_type_says_nothing_and_reports_nothing_either() {
    let mut typed = CelEnvironment::default();
    typed
        .register_variable(
            "subject",
            schema(r#"{"type":"object","properties":{"free":{"description":"anything","minLength":2}}}"#),
            None,
        )
        .unwrap();
    assert_eq!(typed.check("subject.free.whatever").type_name, "dyn");
    assert_eq!(typed.schema_reports(), []);
}
