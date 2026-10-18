//! An environment's registrations: every refusal a registration answers, with its class
//! and text; a named type's fields, members and operators as listed; namespaces, parsing,
//! conversion to text, clones and removal.
//!
//! No Node test file is the twin of this one — `environment.test.ts` checks expressions
//! in every case, and arrives with the checker. Every expected value is the Node build's
//! answer, executed: `@telorun/cel 0.118.0 at 63c81d00`. What is this crate's own: the
//! variant of `CelRegistrationError` each refusal is, which is the Rust spelling of
//! Node's error class.

use std::sync::Arc;

use telorun_cel::{
    list_of, map_of, parameter_of, union_of, CelEngineErrorCode, CelEnvironment, CelEnvironmentOptions,
    CelParseLimits, CelRegistrationError, CelSyntaxCode, CelType, FunctionDefinition, FunctionMetadata,
    NamespaceFunctionDeclaration, NamespaceOptions, NominalOperatorDeclaration, NominalType, NominalTypeDefinition,
    TypeDefinitionListing, TypeFields, VariableDefinition, DYN, INT, NULL, STRING, TIMESTAMP,
};
use telorun_cel_value::PropertyMap;

fn class(error: &CelRegistrationError) -> &'static str {
    match error {
        CelRegistrationError::Expression(_) => "CelTypeExpressionError",
        CelRegistrationError::UnknownName(_) => "CelUnknownTypeNameError",
        CelRegistrationError::Registration(_) => "CelTypeRegistrationError",
        CelRegistrationError::Engine(_) => "CelEngineError",
        CelRegistrationError::Namespace(_) => "CelNamespaceError",
    }
}

fn refusal<T: std::fmt::Debug>(answer: Result<T, CelRegistrationError>) -> (&'static str, String) {
    let error = answer.expect_err("refused");
    (class(&error), error.to_string())
}

fn fields(entries: &[(&str, &str)]) -> Option<PropertyMap<String>> {
    Some(entries.iter().map(|(name, text)| (*name, text.to_string())).collect())
}

fn named(name: &str, base: &str) -> NominalTypeDefinition {
    NominalTypeDefinition { name: name.into(), base: base.into(), ..Default::default() }
}

fn money() -> CelType {
    CelType::Nominal(NominalType { name: "Money".into(), base: Arc::new(INT), args: Arc::new([]), fields: None })
}

#[test]
fn refuses_each_named_type_as_node_does() {
    // `(definition, the class and message Node throws)`.
    let node_refused = [
        (named("uint", "int"), "CelTypeRegistrationError", "\"uint\" is the type key of a value this engine builds"),
        (named("optional", "int"), "CelTypeRegistrationError", "\"optional\" is the type key of a value this engine builds"),
        (named("error", "int"), "CelTypeRegistrationError", "\"error\" is the type key of a value this engine builds"),
        (named("1x", "int"), "CelTypeRegistrationError", "\"1x\" is not spelled as a type name"),
        (named("a-b", "int"), "CelTypeRegistrationError", "\"a-b\" is not spelled as a type name"),
        (named("", "int"), "CelTypeRegistrationError", "\"\" is not spelled as a type name"),
        (named("null_type", "int"), "CelTypeRegistrationError", "\"null_type\" is a type of the language and cannot be redefined"),
        (
            named("Odd", "list<int"),
            "CelTypeRegistrationError",
            "the base of Odd does not read as a type: \"list<int\" has no closing '>' for its type arguments",
        ),
        // The fields are read in JavaScript's own key order, so an index comes first.
        (
            NominalTypeDefinition { fields: fields(&[("b-", "int"), ("1", "int")]), ..named("Odd", "int") },
            "CelTypeRegistrationError",
            "field \"1\" of Odd is not spelled as a name",
        ),
        (
            NominalTypeDefinition { fields: fields(&[("ok", "Nope")]), ..named("Odd", "int") },
            "CelTypeRegistrationError",
            "field \"ok\" of Odd does not read as a type: no type is registered under the name \"Nope\"",
        ),
        (
            NominalTypeDefinition { fields: fields(&[("ok", "list<")]), ..named("Odd", "int") },
            "CelTypeRegistrationError",
            "field \"ok\" of Odd does not read as a type: \"list<\" names no type at offset 5",
        ),
        (
            NominalTypeDefinition {
                conversions: vec!["string(Self, Self, Self, Self, Self): string".into()],
                ..named("Odd", "int")
            },
            "CelEngineError",
            "string(Odd, Odd, Odd, Odd, Odd): string takes 5 values and an implementation receives at most 4",
        ),
    ];
    for (definition, expected_class, message) in node_refused {
        let label = definition.name.clone();
        assert_eq!(refusal(CelEnvironment::default().register_type(definition)), (expected_class, message.into()), "{label}");
    }
    let mut environment = CelEnvironment::default();
    let error = environment
        .register_type(NominalTypeDefinition { conversions: vec!["string(Self, Self, Self, Self, Self): string".into()], ..named("Odd", "int") })
        .expect_err("too wide");
    assert!(matches!(error, CelRegistrationError::Engine(error) if error.code == CelEngineErrorCode::SignatureTooWide));
    // Its own name in its base needs no arity: it is not yet registered when the base is read.
    for (name, base) in [("Odd", "Odd<int>"), ("a.b", "int")] {
        let mut environment = CelEnvironment::default();
        environment.register_type(named(name, base)).expect("registers");
        assert_eq!(environment.definitions().types[0].base, base);
    }
}

#[test]
fn refuses_each_use_of_a_type_as_node_does() {
    let with = |definition: NominalTypeDefinition| {
        let mut environment = CelEnvironment::default();
        environment.register_type(definition).expect("registers");
        environment
    };
    let holder = NominalTypeDefinition { parameters: vec!["A".into()], ..named("Holder", "list<A>") };
    let pair = NominalTypeDefinition { parameters: vec!["A".into(), "B".into()], ..named("Pair", "int") };
    let node_refused = [
        (with(holder).register_variable("v", "Holder<int, int>", None), "CelTypeRegistrationError", "Holder takes 1 type argument"),
        (with(named("Money", "int")).register_variable("v", "Money<int>", None), "CelTypeRegistrationError", "Money takes 0 type arguments"),
        (with(pair).register_variable("v", "Pair<int>", None), "CelTypeRegistrationError", "Pair takes 2 type arguments"),
        (CelEnvironment::default().register_variable("v", "Nope", None), "CelUnknownTypeNameError", "no type is registered under the name \"Nope\""),
        (
            with(named("Money", "int")).register_namespace(
                "Alias",
                vec![NamespaceFunctionDeclaration::withheld("f", "Money<int>")],
                NamespaceOptions::default(),
            ),
            "CelTypeRegistrationError",
            "Money takes 0 type arguments",
        ),
        (
            CelEnvironment::default().register_namespace("1a", vec![], NamespaceOptions::default()),
            "CelNamespaceError",
            "\"1a\" is not spelled as a name, so it names no namespace",
        ),
    ];
    for (answer, expected_class, message) in node_refused {
        assert_eq!(refusal(answer), (expected_class, message.into()));
    }
    assert_eq!(
        refusal(CelEnvironment::default().remove_function("size(Nope): int")),
        ("CelUnknownTypeNameError", "no type is registered under the name \"Nope\"".into())
    );
    // A namespace's own declarations are not the registry's, so no width is refused there.
    let mut environment = CelEnvironment::default();
    environment.register_namespace("Alias", vec!["f(int, int, int, int, int): int".into()], NamespaceOptions::default()).expect("registers");
    assert_eq!(environment.definitions().namespaces[0].functions, ["f(int, int, int, int, int): int"]);
}

fn function(name: &str, signature: &str, receiver: Option<&str>, parameters: &[&str], returns: &str, origin: Option<&str>) -> FunctionDefinition {
    FunctionDefinition {
        name: name.into(),
        signature: signature.into(),
        receiver_type: receiver.map(Into::into),
        parameters: parameters.iter().map(|parameter| parameter.to_string()).collect(),
        returns: returns.into(),
        deterministic: true,
        host_backed: false,
        throws: None,
        description: None,
        origin: origin.map(Into::into),
    }
}

#[test]
fn lists_a_named_types_fields_members_operators_and_variables() {
    let mut environment = CelEnvironment::default();
    environment
        .register_type(NominalTypeDefinition {
            fields: fields(&[("y", "int"), ("x", "Self"), ("label", "list<Point>")]),
            description: Some("a point".into()),
            ..named("Point", "map<string, int>")
        })
        .expect("registers");
    assert_eq!(
        environment.definitions().types,
        [TypeDefinitionListing {
            name: "Point".into(),
            base: "map<string, int>".into(),
            parameters: vec![],
            fields: fields(&[("y", "int"), ("x", "Point"), ("label", "list<Point>")]),
            description: Some("a point".into()),
        }]
    );

    let mut environment = CelEnvironment::default();
    environment
        .register_type(NominalTypeDefinition {
            comparisons: vec!["==".into(), "!=".into()],
            conversions: vec!["string(Self): string".into()],
            members: vec!["Self.withSuffix(string): Self".into()],
            operators: vec![NominalOperatorDeclaration { operator: "+".into(), parameters: vec!["Self".into(), "string".into()], returns: "Self".into() }],
            ..named("Label", "string")
        })
        .expect("registers");
    let origin = Some("type:Label");
    let listed: Vec<FunctionDefinition> =
        environment.definitions().functions.into_iter().filter(|entry| entry.origin.as_deref() == origin).collect();
    assert_eq!(
        listed,
        [
            function("!=", "!=(Label, Label): bool", None, &["Label", "Label"], "bool", origin),
            function("+", "+(Label, string): Label", None, &["Label", "string"], "Label", origin),
            function("==", "==(Label, Label): bool", None, &["Label", "Label"], "bool", origin),
            function("string", "string(Label): string", None, &["Label"], "string", origin),
            function("withSuffix", "Label.withSuffix(string): Label", Some("Label"), &["string"], "Label", origin),
        ]
    );

    // A named type with parameters, written with arguments and without.
    let mut environment = CelEnvironment::default();
    environment.register_type(NominalTypeDefinition { parameters: vec!["A".into()], ..named("Holder", "list<A>") }).expect("registers");
    environment.register_variable("v", "Holder<string>", None).expect("registers");
    environment.register_variable("w", "Holder", None).expect("registers");
    let holder = |args: Vec<CelType>| {
        CelType::Nominal(NominalType { name: "Holder".into(), base: Arc::new(list_of(parameter_of("A"))), args: args.into(), fields: None })
    };
    let variables: Vec<VariableDefinition> =
        environment.definitions().variables.into_iter().filter(|variable| !variable.constant).collect();
    let variable = |name: &str, ty: CelType, type_name: &str| VariableDefinition {
        name: name.into(),
        ty,
        type_name: type_name.into(),
        description: None,
        constant: false,
    };
    assert_eq!(variables, [variable("v", holder(vec![STRING]), "Holder<string>"), variable("w", holder(vec![parameter_of("A")]), "Holder<A>")]);

    // A field naming the type itself holds the type as its base was read: before it had fields.
    let mut environment = CelEnvironment::default();
    environment.register_type(NominalTypeDefinition { fields: fields(&[("next", "Self")]), ..named("Point", "map<string, int>") }).expect("registers");
    environment.register_variable("p", "Point", None).expect("registers");
    let read = |fields: Option<TypeFields>| {
        CelType::Nominal(NominalType { name: "Point".into(), base: Arc::new(map_of(STRING, INT)), args: Arc::new([]), fields })
    };
    let unresolved = CelType::Nominal(NominalType { name: "Point".into(), base: Arc::new(DYN), args: Arc::new([]), fields: None });
    let p = environment.definitions().variables.into_iter().find(|variable| variable.name == "p").expect("listed");
    assert_eq!(p.ty, read(Some([("next", unresolved)].into_iter().collect())));
}

#[test]
fn lists_operators_constants_described_variables_and_function_metadata() {
    let mut environment = CelEnvironment::default();
    environment
        .register_type(NominalTypeDefinition { description: Some("an amount in the smallest unit".into()), ..named("Money", "int") })
        .expect("registers");
    environment.register_operator("+", &["Money", "Money"], "Money", FunctionMetadata::default()).expect("registers");
    environment.register_constant("zero", "Money", Some("no money at all".into())).expect("registers");
    environment.register_variable("paid", "Money", Some("what was paid".into())).expect("registers");
    let listing = environment.definitions();
    let described = |name: &str, constant: bool, description: &str| VariableDefinition {
        name: name.into(),
        ty: money(),
        type_name: "Money".into(),
        description: Some(description.into()),
        constant,
    };
    assert_eq!(
        listing.variables.iter().filter(|variable| ["zero", "paid"].contains(&variable.name.as_str())).cloned().collect::<Vec<_>>(),
        [described("paid", false, "what was paid"), described("zero", true, "no money at all")]
    );
    assert_eq!(
        listing.functions.iter().filter(|entry| entry.name == "+" && entry.parameters[0] == "Money").cloned().collect::<Vec<_>>(),
        [function("+", "+(Money, Money): Money", None, &["Money", "Money"], "Money", None)]
    );
    assert!(environment.has_variable("zero"));

    let mut bare = CelEnvironment::new(CelEnvironmentOptions { standard_library: false, ..Default::default() });
    let metadata = FunctionMetadata {
        deterministic: false,
        host_backed: true,
        throws: Some(vec![]),
        description: Some("d".into()),
        origin: Some("host".into()),
        ..FunctionMetadata::default()
    };
    bare.register_function("f(int): int", metadata).expect("registers");
    bare.register_function("g(): int", FunctionMetadata::default()).expect("registers");
    let listing = bare.definitions();
    assert!(listing.variables.is_empty() && listing.types.is_empty() && listing.namespaces.is_empty());
    assert_eq!(
        listing.functions,
        [
            FunctionDefinition {
                deterministic: false,
                host_backed: true,
                throws: Some(vec![]),
                description: Some("d".into()),
                origin: Some("host".into()),
                ..function("f", "f(int): int", None, &["int"], "int", None)
            },
            function("g", "g(): int", None, &[], "int", None),
        ]
    );

    // Names are listed in UTF-16 code-unit order, and a name declared again takes its new type.
    let mut environment = CelEnvironment::default();
    environment.register_variable("\u{ffff}", "int", None).expect("registers");
    environment.register_variable("\u{1f600}", "int", None).expect("registers");
    environment.register_variable("a", list_of(INT), None).expect("registers");
    environment.register_variable("a", "string", Some("again".into())).expect("registers");
    let listed: Vec<(String, String, Option<String>)> = environment
        .definitions()
        .variables
        .into_iter()
        .filter(|variable| !variable.constant)
        .map(|variable| (variable.name, variable.type_name, variable.description))
        .collect();
    assert_eq!(
        listed,
        [
            ("a".into(), "string".into(), Some("again".into())),
            ("\u{1f600}".into(), "int".into(), None),
            ("\u{ffff}".into(), "int".into(), None)
        ]
    );
}

#[test]
fn parses_against_its_namespaces_and_options() {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    for name in ["b", "B", "a", "_z"] {
        environment.register_namespace(name, vec![], NamespaceOptions::default()).expect("registers");
    }
    assert_eq!(environment.namespaces(), ["B", "_z", "a", "b"]);
    let mut environment = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    environment.register_namespace("Alias", vec![], NamespaceOptions::default()).expect("registers");
    let expression = environment.parse("Alias.f([?a])");
    assert_eq!((&*expression.namespaces, expression.diagnostic.is_none()), (&["Alias".to_string()][..], true));
    assert!(matches!(&*expression.root, telorun_cel::CelNode::QualifiedCall(_)));
    // Off, the optional syntax is a misplaced token.
    let refused = CelEnvironment::default().parse("[?a]").diagnostic.expect("refused");
    assert_eq!((refused.code, refused.message.as_str(), refused.range.start, refused.range.end), (CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2));
    let shallow = CelEnvironment::new(CelEnvironmentOptions {
        limits: CelParseLimits { max_depth: 2, ..Default::default() },
        ..Default::default()
    });
    let refused = shallow.parse("((1))").diagnostic.expect("refused");
    assert_eq!(
        (refused.code, refused.message.as_str(), refused.range.start, refused.range.end),
        (CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 2", 2, 2)
    );
}

#[test]
fn answers_whether_a_type_converts_to_text() {
    let mut environment = CelEnvironment::default();
    environment.register_type(named("Money", "int")).expect("registers");
    let types = [INT, list_of(INT), DYN, money(), union_of([INT, NULL]), NULL, TIMESTAMP, parameter_of("A"), map_of(STRING, INT)];
    let converts: Vec<bool> = types.iter().map(|ty| environment.converts_to_string(ty)).collect();
    assert_eq!(converts, [true, false, true, false, false, false, true, true, false]);
    environment.register_function("string(Money): string", FunctionMetadata::default()).expect("registers");
    assert!(environment.converts_to_string(&money()));
}

#[test]
fn clones_diverge_and_removals_answer_what_went() {
    let bare = CelEnvironment::new(CelEnvironmentOptions { standard_library: false, ..Default::default() }).definitions();
    assert_eq!((bare.variables.len(), bare.functions.len()), (0, 0));

    let mut parent = CelEnvironment::default();
    parent.register_variable("port", "int", None).expect("registers");
    let mut child = parent.clone_with_options(CelEnvironmentOptions { enable_optional_types: true, ..parent.options().clone() });
    child.remove_functions_named("size");
    child.register_variable("host", "string", None).expect("registers");
    assert!(!parent.has_variable("host"));
    assert!(child.has_variable("port"));
    assert_eq!((parent.definitions().functions.len(), child.definitions().functions.len()), (207, 199));
    // The option is the clone's; what it would have registered is not.
    assert!(child.options().enable_optional_types);
    assert!(!child.definitions().variables.iter().any(|variable| variable.name == "optional_type"));
    assert_eq!(parent.clone().definitions(), parent.definitions());

    let mut environment = CelEnvironment::default();
    assert_eq!(environment.remove_function("size(string): bool"), Ok(true));
    assert_eq!(environment.remove_function("size(string): int"), Ok(false));
    assert_eq!(environment.remove_functions_named("size"), 7);
    assert_eq!(environment.remove_functions_named("size"), 0);
}
