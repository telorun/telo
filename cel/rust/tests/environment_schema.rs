//! An environment's field-map and schema declarations: the type each declares, as
//! listed; the schema reports, by name; the schema resolver option and the environment's
//! named types behind a resolver's answer; every refusal with its class.
//!
//! No Node test file is the twin of this one — `json-schema-type.test.ts` and
//! `environment.test.ts` check expressions in every case, and arrive with the checker.
//! Every expected value is the Node build's answer, executed: `@telorun/cel 0.118.0 at
//! 63c81d00`. What is this crate's own: the variant of `CelRegistrationError` each
//! refusal is, the Rust spelling of Node's error class.

mod schema_support;

use std::sync::Arc;

use schema_support::{described, json, recursive_line, unjudged_line};
use telorun_cel::{
    CelEnvironment, CelEnvironmentOptions, CelRegistrationError, FieldDeclaration, JsonSchemaDocument, JsonValue,
    NominalTypeDefinition, SchemaTypeAnswer, SchemaTypeResolver, TypeDeclaration,
};
use telorun_cel_value::PropertyMap;

fn schema(text: &str) -> TypeDeclaration {
    TypeDeclaration::Schema(JsonSchemaDocument { node: json(text), root: None })
}

/// `(name, every report line)` per registration, as `schemaReports` lists them.
fn reports(environment: &CelEnvironment) -> Vec<(String, Vec<String>)> {
    environment
        .schema_reports()
        .iter()
        .map(|report| {
            let lines = report.unjudged.iter().map(unjudged_line).chain(report.recursive.iter().map(recursive_line));
            (report.name.clone(), lines.collect())
        })
        .collect()
}

/// `(name, the type written out, its listed name, constant, description)`.
fn listed(environment: &CelEnvironment, names: &[&str]) -> Vec<(String, String, String, bool, Option<String>)> {
    environment
        .definitions()
        .variables
        .into_iter()
        .filter(|variable| names.contains(&variable.name.as_str()))
        .map(|variable| {
            (variable.name, described(&variable.ty), variable.type_name, variable.constant, variable.description)
        })
        .collect()
}

fn entry(name: &str, written: &str, listed: &str, constant: bool, description: Option<&str>) -> (String, String, String, bool, Option<String>) {
    (name.into(), written.into(), listed.into(), constant, description.map(Into::into))
}

fn lines(name: &str, reported: &[&str]) -> (String, Vec<String>) {
    (name.into(), reported.iter().map(|line| line.to_string()).collect())
}

fn class(error: &CelRegistrationError) -> &'static str {
    match error {
        CelRegistrationError::Expression(_) => "CelTypeExpressionError",
        CelRegistrationError::UnknownName(_) => "CelUnknownTypeNameError",
        CelRegistrationError::Registration(_) => "CelTypeRegistrationError",
        CelRegistrationError::Engine(_) => "CelEngineError",
        CelRegistrationError::Namespace(_) => "CelNamespaceError",
    }
}

fn refusal(answer: Result<(), CelRegistrationError>) -> (&'static str, String) {
    let error = answer.expect_err("refused");
    (class(&error), error.to_string())
}

/// A named type for a node carrying `brand`, with `args` as its type arguments.
fn branded() -> SchemaTypeResolver {
    Arc::new(|document: &JsonSchemaDocument| {
        let JsonValue::Object(entries) = &*document.node else { return None };
        let Some(JsonValue::String(brand)) = entries.get("brand").map(|value| &**value) else { return None };
        let args = match entries.get("args").map(|value| &**value) {
            Some(JsonValue::Array(items)) => items
                .iter()
                .map(|item| match &**item {
                    JsonValue::String(text) => text.clone(),
                    _ => panic!("a type argument is text"),
                })
                .collect(),
            _ => Vec::new(),
        };
        Some(SchemaTypeAnswer::Named { name: brand.clone(), args })
    })
}

fn named(name: &str, base: &str, parameters: &[&str]) -> NominalTypeDefinition {
    NominalTypeDefinition {
        name: name.into(),
        base: base.into(),
        parameters: parameters.iter().map(|parameter| parameter.to_string()).collect(),
        ..Default::default()
    }
}

fn with_named_types(options: CelEnvironmentOptions) -> CelEnvironment {
    let mut environment = CelEnvironment::new(options);
    environment.register_type(named("Money", "int", &[])).expect("registers");
    environment.register_type(named("Pair", "list<A>", &["A", "B"])).expect("registers");
    environment
}

#[test]
fn declares_a_schema_and_lists_what_it_could_not_judge_by_name() {
    let mut environment = CelEnvironment::default();
    assert_eq!(environment.schema_reports(), []);
    environment.register_variable("zeta", schema(r#"{"properties":{"a":{"if":{}}}}"#), None).expect("registers");
    environment.register_variable("\u{e9}", schema(r##"{"$ref":"#"}"##), None).expect("registers");
    environment.register_variable("Alpha", schema(r#"{"type":"string"}"#), None).expect("registers");
    environment
        .register_constant(
            "beta",
            schema(r##"{"properties":{"x":{"$ref":"#/$defs/S"}},"$defs":{"S":{"type":"strng"}}}"##),
            Some("a constant".into()),
        )
        .expect("registers");
    environment
        .register_variable(
            "doc",
            TypeDeclaration::Schema(JsonSchemaDocument {
                node: json(r##"{"$ref":"#/$defs/S"}"##),
                root: Some(json(r#"{"$defs":{"S":{"type":"integer","not":{}}}}"#)),
            }),
            None,
        )
        .expect("registers");
    environment.register_variable("plain", "int", None).expect("registers");
    assert_eq!(
        reports(&environment),
        [
            lines("beta", &["shape-not-read pointer=/$defs/S keywords=type"]),
            lines("doc", &["keyword-not-read pointer=/$defs/S keywords=not"]),
            lines("zeta", &["keyword-not-read pointer=/properties/a keywords=if"]),
            lines("\u{e9}", &["recursive pointer= reference=#"]),
        ]
    );
    assert_eq!(
        listed(&environment, &["zeta", "\u{e9}", "Alpha", "beta", "doc", "plain"]),
        [
            entry("Alpha", "string", "string", false, None),
            entry("beta", "{x: dyn}", "map", true, Some("a constant")),
            entry("doc", "int", "int", false, None),
            entry("plain", "int", "int", false, None),
            entry("zeta", "{a: dyn}", "map", false, None),
            entry("\u{e9}", "dyn", "dyn", false, None),
        ]
    );
}

#[test]
fn replaces_a_report_with_its_registration_and_a_clone_diverges() {
    let mut environment = CelEnvironment::default();
    environment.register_variable("v", schema(r#"{"if":{}}"#), None).expect("registers");
    let mut child = environment.clone();
    child.register_variable("w", schema(r#"{"not":{}}"#), None).expect("registers");
    environment.register_variable("v", schema(r#"{"type":"string"}"#), None).expect("registers");
    assert_eq!(reports(&environment), []);
    assert_eq!(
        reports(&child),
        [lines("v", &["keyword-not-read pointer= keywords=if"]), lines("w", &["keyword-not-read pointer= keywords=not"])]
    );
}

fn fields(entries: Vec<(&str, FieldDeclaration)>) -> PropertyMap<FieldDeclaration> {
    entries.into_iter().collect()
}

#[test]
fn declares_a_field_map_and_refuses_one_it_cannot_read() {
    let mut environment = CelEnvironment::default();
    environment.register_type(named("Money", "int", &[])).expect("registers");
    let row = fields(vec![
        ("b", "Money".into()),
        ("10", "list<int>".into()),
        ("a", FieldDeclaration::Fields(fields(vec![("y", "string".into())]))),
    ]);
    environment.register_variable("row", row, None).expect("registers");
    assert_eq!(listed(&environment, &["row"]), [entry("row", "{10: list<int>, b: Money, a: {y: string}}", "map", false, None)]);
    assert_eq!(environment.schema_reports(), []);

    // `(field map, the class and text Node throws)`.
    let node_refused = [
        (fields(vec![("a", "Nope".into())]), "CelUnknownTypeNameError", "no type is registered under the name \"Nope\""),
        (
            fields(vec![("a", FieldDeclaration::Fields(fields(vec![("b", "map<int".into())])))]),
            "CelTypeExpressionError",
            "\"map<int\" has no closing '>' for its type arguments",
        ),
        (fields(vec![("a", "Money<int>".into())]), "CelTypeRegistrationError", "Money takes 0 type arguments"),
    ];
    for (map, class, message) in node_refused {
        let answer = environment.register_variable("refused", map, None);
        assert_eq!(refusal(answer), (class, message.to_string()));
        assert!(!environment.has_variable("refused"));
    }
}

#[test]
fn types_a_named_node_by_the_environment_s_own_types() {
    let mut environment =
        with_named_types(CelEnvironmentOptions { resolve_schema_type: Some(branded()), ..Default::default() });
    environment
        .register_variable(
            "m",
            schema(
                r#"{"properties":{"price":{"brand":"Money","type":"integer"},"pair":{"brand":"Pair","args":["string","Money"]},"plain":{"brand":"Pair"},"other":{"brand":"Nope","type":"string"}}}"#,
            ),
            None,
        )
        .expect("registers");
    assert_eq!(
        listed(&environment, &["m"]),
        [entry("m", "{price: Money, pair: Pair<string, Money>, plain: Pair<A, B>, other: string}", "map", false, None)]
    );
    assert_eq!(reports(&environment), [lines("m", &["named-type-unregistered pointer=/properties/other keywords= type=Nope"])]);

    // `(schema, the class and text Node throws)`.
    const NODE_REFUSED: [(&str, &str, &str); 5] = [
        (r#"{"brand":"Pair","args":["int"]}"#, "CelTypeRegistrationError", "Pair takes 2 type arguments"),
        (r#"{"brand":"Pair","args":["int","list<"]}"#, "CelTypeExpressionError", "\"list<\" names no type at offset 5"),
        (
            r#"{"brand":"Pair","args":["Nope","int"]}"#,
            "CelUnknownTypeNameError",
            "no type is registered under the name \"Nope\"",
        ),
        (r#"{"brand":"Nope","args":["list<"]}"#, "CelTypeExpressionError", "\"list<\" names no type at offset 5"),
        (r#"{"brand":"Money","args":["int"]}"#, "CelTypeRegistrationError", "Money takes 0 type arguments"),
    ];
    for (text, class, message) in NODE_REFUSED {
        assert_eq!(refusal(environment.register_variable("v", schema(text), None)), (class, message.to_string()), "{text}");
        assert!(!environment.has_variable("v"));
    }
}

#[test]
fn reads_a_schema_with_no_resolver_by_its_structure_and_a_clone_takes_the_resolver_it_is_given() {
    let mut bare = with_named_types(CelEnvironmentOptions::default());
    bare.register_variable("v", schema(r#"{"brand":"Money","type":"integer"}"#), None).expect("registers");
    assert_eq!(listed(&bare, &["v"]), [entry("v", "int", "int", false, None)]);
    assert_eq!(bare.schema_reports(), []);

    let parent = with_named_types(CelEnvironmentOptions { resolve_schema_type: Some(branded()), ..Default::default() });
    let declines: SchemaTypeResolver = Arc::new(|_: &JsonSchemaDocument| None);
    let mut child = parent
        .clone_with_options(CelEnvironmentOptions { resolve_schema_type: Some(declines), ..parent.options().clone() });
    child.register_variable("v", schema(r#"{"brand":"Money","type":"integer"}"#), None).expect("registers");
    assert_eq!(listed(&child, &["v"]), [entry("v", "int", "int", false, None)]);
    let mut same = parent.clone();
    same.register_variable("v", schema(r#"{"brand":"Money","type":"integer"}"#), None).expect("registers");
    assert_eq!(listed(&same, &["v"]), [entry("v", "Money", "Money", false, None)]);
    assert_eq!(same.options(), parent.options());
    assert_ne!(child.options(), parent.options());
}
