//! Twin of `cel/nodejs/tests/checker.test.ts`, case for case.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. Past the Node file, where it asserts only a code or
//! a range bound: each cause's whole diagnostic, the guarded and refused presence reads
//! row by row, and the namespace-mismatch message.

mod check_support;

use check_support::{assert_rows, codes, environment, first_code, fixed, found, optional_types, schema, type_of, unlisted_dyn};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    parse_expression, CallForm, CelCheckCode, CelEngineError, CelEngineErrorCode, CelEnvironment, CelEnvironmentOptions,
    FunctionMetadata, NamespaceFunctionDeclaration, NamespaceOptions, NominalTypeDefinition, ParseExpressionOptions,
    ResolvedCall, SourceRange, CEL_CHECK_CODES, UNKNOWN_FUNCTION_CANDIDATES,
};

const REQUEST: &str =
    r#"{"type":"object","properties":{"body":{"type":["object","null"],"properties":{"id":{"type":"string"}}}}}"#;

/// An environment that declares everything legal at its site, as a strict host does.
fn strict() -> CelEnvironment {
    let mut environment = environment(optional_types());
    environment
        .register_type(NominalTypeDefinition {
            name: "Holder".into(),
            base: "list<A>".into(),
            parameters: vec!["A".into()],
            ..Default::default()
        })
        .unwrap();
    environment.register_variable("strings", "Holder<string>", None).unwrap();
    environment.register_variable("ints", "Holder<int>", None).unwrap();
    environment.register_function("firstText(Holder<string>): string", FunctionMetadata::default()).unwrap();
    environment.register_variable("request", schema(REQUEST), None).unwrap();
    environment.register_namespace("Billing", vec!["total(int, int): int".into()], NamespaceOptions::default()).unwrap();
    environment
}

/// One cause per code: every code this engine decides, decided by the checker.
fn causes() -> Vec<(CelCheckCode, check_support::Row)> {
    vec![
        (SyntaxError, ("1 +", "int", vec![found(SyntaxError, "the expression ends before it is complete", 3, 3)])),
        (TypeError, ("1 + 'a'", "dyn", vec![found(TypeError, "no \"+\" is declared over int, string", 0, 7)])),
        (UnknownIdentifier, ("nope", "dyn", vec![found(UnknownIdentifier, "\"nope\" is not declared here (declared: bool, bytes, double, google, int, ints, list, map, null_type, optional_type, request, string, strings, type, uint)", 0, 4)])),
        (UnknownField, ("request.nope", "dyn", vec![found(UnknownField, "\"nope\" is not declared here (declared: body)", 8, 12)])),
        (UnknownFunction, ("nosuch(1)", "dyn", vec![found(UnknownFunction, "no function named \"nosuch\" is registered \u{2014} the closest taking 1 argument: bool, double, size, bytes, dyn", 0, 9)])),
        (WrongCallForm, ("startsWith('abc', 'a')", "dyn", vec![fixed(WrongCallForm, "\"startsWith\" is called on a value: string.startsWith(string): bool", 0, 22, "\"abc\".startsWith(\"a\")")])),
        (TypeArgumentMismatch, ("firstText(ints)", "dyn", vec![found(TypeArgumentMismatch, "Holder<int> and Holder<string> are the same type with different type arguments, which never match", 0, 15)])),
        (NullableAccess, ("request.body.id", "string", vec![found(NullableAccess, "\"request.body\" may be null \u{2014} guard it (e.g. 'request.body != null && \u{2026}' or 'request.body == null ? \u{2026} : request.body.id') before reading .id", 13, 15)])),
        (InvalidArgument, ("has(1)", "bool", vec![found(InvalidArgument, "has() asks whether a member is there, so it takes a member read: write has(a.b)", 4, 5)])),
        (FunctionUnresolved, ("Billing.missing(1)", "dyn", vec![found(FunctionUnresolved, "\"Billing\" declares no function named \"missing\"", 0, 18)])),
        (FunctionArityMismatch, ("Billing.total(1)", "int", vec![found(FunctionArityMismatch, "Billing.total takes 2 arguments, and 1 is written", 0, 16)])),
        (FunctionArgumentMismatch, ("Billing.total(1, 'two')", "int", vec![found(FunctionArgumentMismatch, "Billing.total takes int here, and this argument is string", 17, 22)])),
    ]
}

#[test]
fn decides_every_verdict_with_a_range() {
    for (code, row) in causes() {
        let source = row.0;
        let result = strict().check(source);
        assert_eq!(first_code(&result), Some(code), "{source}");
        let range = result.diagnostics[0].range;
        assert!(range.start <= range.end && range.end as usize <= source.len(), "{source}");
        assert_rows(&strict(), vec![row]);
    }
}

#[test]
fn decides_every_code_of_its_declared_vocabulary() {
    let decided: Vec<CelCheckCode> = causes().into_iter().map(|(code, _)| code).collect();
    assert_eq!(CEL_CHECK_CODES.iter().filter(|code| !decided.contains(code)).count(), 0);
    assert_eq!(
        CEL_CHECK_CODES.map(CelCheckCode::as_str),
        [
            "CEL_SYNTAX_ERROR",
            "CEL_TYPE_ERROR",
            "CEL_UNKNOWN_IDENTIFIER",
            "CEL_UNKNOWN_FIELD",
            "CEL_UNKNOWN_FUNCTION",
            "CEL_WRONG_CALL_FORM",
            "CEL_TYPE_ARGUMENT_MISMATCH",
            "CEL_NULLABLE_ACCESS",
            "CEL_INVALID_ARGUMENT",
            "FUNCTION_UNRESOLVED",
            "FUNCTION_ARITY_MISMATCH",
            "FUNCTION_ARGUMENT_MISMATCH",
        ]
    );
}

/// A site whose element type admits null, which is where a comprehension meets one.
fn list_of_nullable() -> CelEnvironment {
    let mut environment = CelEnvironment::default();
    environment
        .register_variable(
            "rows",
            schema(r#"{"type":"array","items":{"type":["object","null"],"properties":{"code":{"type":"string"}}}}"#),
            None,
        )
        .unwrap();
    environment
}

#[test]
fn a_nullable_dereference_is_reported_for_a_declared_chain_and_cleared_by_each_of_the_three_guards() {
    assert_eq!(first_code(&strict().check("request.body.id")), Some(NullableAccess));
    for guarded in [
        "request.body != null && request.body.id == 'x'",
        "request.body == null || request.body.id == 'x'",
        "request.body == null ? 'x' : request.body.id",
    ] {
        assert_eq!(strict().check(guarded).diagnostics, [], "{guarded}");
    }
}

#[test]
fn a_nullable_dereference_is_not_reported_for_a_chain_rooted_at_a_name_the_expression_bound() {
    assert_eq!(list_of_nullable().check("rows.all(e, e.code == 'x')").diagnostics, []);
    assert_eq!(list_of_nullable().check("rows.map(e, e.code)").diagnostics, []);
    assert_eq!(list_of_nullable().check("cel.bind(e, rows[0], e.code == 'x')").diagnostics, []);
    // The skip is about the root, not about sitting inside a comprehension.
    let mut both = list_of_nullable();
    both.register_variable("request", schema(REQUEST), None).unwrap();
    assert_eq!(first_code(&both.check("rows.all(e, request.body.id == 'x')")), Some(NullableAccess));
}

#[test]
fn a_fix_offers_the_one_name_a_misspelled_call_could_have_meant_as_a_whole_source() {
    let result = strict().check("'abc'.startswith('a') && true");
    assert_eq!(result.diagnostics[0].fix.as_ref().map(|fix| fix.replacement.as_str()), Some("\"abc\".startsWith(\"a\") && true"));
}

#[test]
fn a_fix_offers_the_calls_other_form_parenthesizing_the_receiver_when_it_must() {
    let mut on_a_value = CelEnvironment::default();
    on_a_value.register_function("int.scaled(int): int", FunctionMetadata::default()).unwrap();
    assert_rows(
        &on_a_value,
        vec![(
            "scaled(1 + 2, 3)",
            "dyn",
            vec![fixed(WrongCallForm, "\"scaled\" is called on a value: int.scaled(int): int", 0, 16, "(1 + 2).scaled(3)")],
        )],
    );
    let mut global = CelEnvironment::default();
    global.register_function("scaled(int, int): int", FunctionMetadata::default()).unwrap();
    assert_rows(
        &global,
        vec![(
            "(1 + 2).scaled(3)",
            "dyn",
            vec![fixed(WrongCallForm, "\"scaled\" is called without a receiver: scaled(int, int): int", 1, 17, "scaled(1 + 2, 3)")],
        )],
    );
}

#[test]
fn a_fix_is_offered_nowhere_there_is_no_single_repair() {
    assert_eq!(strict().check("nosuch(1)").diagnostics[0].fix, None);
}

/// Eight one-argument names, the three nearest registered out of name order.
fn spellings() -> CelEnvironment {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions { standard_library: false, ..Default::default() });
    for name in ["mite", "kites", "kit", "zeta", "beta", "alpha", "delta", "gamma"] {
        environment.register_function(format!("{name}(int): int"), FunctionMetadata::default()).unwrap();
    }
    // Nearer than every one of those, and reachable by neither form nor arity of `kite(1)`.
    environment.register_function("kitten(int, int): int", FunctionMetadata::default()).unwrap();
    environment.register_function("int.kiter(int): int", FunctionMetadata::default()).unwrap();
    environment
}

#[test]
fn an_unknown_call_names_the_five_nearest_of_its_own_form_and_arity_and_no_command_to_run() {
    let result = spellings().check("kite(1)");
    let diagnostic = &result.diagnostics[0];
    assert_eq!(diagnostic.code, UnknownFunction);
    assert_eq!(
        diagnostic.message,
        "no function named \"kite\" is registered \u{2014} the closest taking 1 argument: kit, kites, mite, beta, zeta"
    );
    assert!(!["telo", "command", "`"].iter().any(|word| diagnostic.message.contains(word)));
}

#[test]
fn an_unknown_call_answers_the_same_environment_with_the_same_text_twice() {
    let environment = spellings();
    assert_eq!(environment.check("kite(1)").diagnostics, environment.check("kite(1)").diagnostics);
}

#[test]
fn an_unknown_call_is_a_bound_and_an_order_the_fixture_can_see_broken() {
    let environment = spellings();
    let message = environment.check("kite(1)").diagnostics[0].message.clone();
    let offered: Vec<&str> = message.rsplit(": ").next().unwrap().split(", ").collect();
    assert_eq!(offered.len(), UNKNOWN_FUNCTION_CANDIDATES);
    let eligible: Vec<String> = environment
        .definitions()
        .functions
        .into_iter()
        .filter(|held| held.parameters.len() == 1 && held.receiver_type.is_none())
        .map(|held| held.name)
        .collect();
    assert_eq!(eligible.len(), 8);
    let mut by_name = eligible.clone();
    by_name.sort();
    assert_ne!(offered, by_name[..UNKNOWN_FUNCTION_CANDIDATES].to_vec());
    assert_ne!(offered[..3], ["mite", "kites", "kit"]);
}

#[test]
fn an_unknown_call_names_nothing_where_no_registration_accepts_its_form_and_arity() {
    let environment = CelEnvironment::new(CelEnvironmentOptions { standard_library: false, ..Default::default() });
    assert_eq!(environment.check("kite(1)").diagnostics[0].message, "no function named \"kite\" is registered");
}

fn listed(name: &str, arity: usize, range: (u32, u32), signature: &str, returns: &str, deterministic: bool) -> ResolvedCall {
    ResolvedCall {
        name: name.into(),
        form: CallForm::Global,
        namespace: None,
        arity,
        range: SourceRange { start: range.0, end: range.1 },
        signature: Some(signature.into()),
        returns: Some(returns.into()),
        deterministic: Some(deterministic),
        host_backed: Some(false),
        throws: None,
        argument_types: None,
    }
}

#[test]
fn the_listing_names_the_signature_each_call_resolved_to_with_the_metadata_the_host_declared() {
    let mut environment = CelEnvironment::default();
    environment
        .register_function(
            "sha256(string): string",
            FunctionMetadata {
                deterministic: true,
                host_backed: true,
                throws: Some(vec!["ERR_DIGEST_FAILED".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    environment.register_function("now(): int", FunctionMetadata { deterministic: false, ..Default::default() }).unwrap();
    environment
        .register_namespace(
            "Billing",
            vec![NamespaceFunctionDeclaration {
                deterministic: false,
                host_backed: true,
                throws: Some(vec!["ERR_BILLING".into()]),
                ..NamespaceFunctionDeclaration::signature("total(int): int")
            }],
            NamespaceOptions::default(),
        )
        .unwrap();
    assert_eq!(
        environment.check("sha256('a') + string(now()) + string(Billing.total(1))").calls,
        [
            ResolvedCall {
                host_backed: Some(true),
                throws: Some(vec!["ERR_DIGEST_FAILED".into()]),
                ..listed("sha256", 1, (0, 11), "sha256(string): string", "string", true)
            },
            listed("now", 0, (21, 26), "now(): int", "int", false),
            listed("string", 1, (14, 27), "string(int): string", "string", true),
            ResolvedCall {
                name: "Billing.total".into(),
                form: CallForm::Receiver,
                namespace: Some("Billing".into()),
                arity: 1,
                range: SourceRange { start: 37, end: 53 },
                signature: Some("total(int): int".into()),
                returns: Some("int".into()),
                deterministic: Some(false),
                host_backed: Some(true),
                throws: Some(vec!["ERR_BILLING".into()]),
                // Each argument's own type, which only a namespaced call carries.
                argument_types: Some(vec!["int".into()]),
            },
            listed("string", 1, (30, 54), "string(int): string", "string", true),
        ]
    );
}

#[test]
fn the_listing_lists_no_entry_for_a_macro_which_reaches_no_function() {
    let environment = environment(unlisted_dyn());
    assert_eq!(
        environment.check("[1, 2].map(i, size(string(i)))").calls,
        [
            listed("string", 1, (19, 28), "string(int): string", "string", true),
            listed("size", 1, (14, 29), "size(string): int", "int", true),
        ]
    );
    assert_eq!(environment.check("has(a.b) && cel.bind(x, 1, x > 0)").calls, []);
}

#[test]
fn a_qualified_call_types_from_the_namespaces_declared_signature() {
    assert_eq!(strict().check("Billing.total(1, 2) + 1").type_name, "int");
}

#[test]
fn a_qualified_call_refuses_a_tree_resolved_under_another_namespace_set_rather_than_checking_it() {
    let environment = strict();
    let elsewhere = parse_expression(
        "Billing.total(1, 2)",
        &ParseExpressionOptions { namespaces: vec!["Shop".into()], ..Default::default() },
    )
    .unwrap();
    assert_eq!(
        environment.check_parsed(&elsewhere),
        Err(CelEngineError {
            code: CelEngineErrorCode::NamespacesMismatch,
            message: "the expression was resolved under [Shop] and this environment has [Billing]".into(),
        })
    );
    // The same source, read by the environment itself, checks.
    assert!(environment.check("Billing.total(1, 2)").valid);
    assert!(environment.check_parsed(&environment.parse("Billing.total(1, 2)")).unwrap().valid);
}

#[test]
fn optional_types_check_every_form_the_option_enables() {
    let environment = environment(CelEnvironmentOptions {
        enable_optional_types: true,
        unlisted_variables_are_dyn: true,
        ..Default::default()
    });
    for (source, type_name) in [
        ("optional.of(1)", "optional<int>"),
        // A parameter nothing resolved is reported as `dyn`, as every use of one is.
        ("optional.none()", "optional<dyn>"),
        ("optional.of(1).hasValue()", "bool"),
        ("optional.of(1).value()", "int"),
        ("optional.of(1).orValue(2)", "int"),
        ("optional.none().or(optional.of(1)).value()", "int"),
        ("{'a': 1}.?a", "optional<int>"),
        ("[1][?0]", "optional<int>"),
        ("{'a': {'b': 2}}.?a.b.orValue(0)", "int"),
    ] {
        assert_eq!(type_of(&environment, source), type_name, "{source}");
    }
}

#[test]
fn optional_types_have_none_of_it_where_the_option_is_off() {
    let off = environment(unlisted_dyn());
    assert_eq!(first_code(&off.check("optional.of(1)")), Some(UnknownFunction));
    assert_eq!(first_code(&off.check("optional.of(1).hasValue()")), Some(UnknownFunction));
}

/// A field declared as two shapes, directly and through a `$ref`.
fn two_shapes() -> CelEnvironment {
    const COLUMN: &str = r#"{"anyOf":[{"type":"string"},{"type":"object","properties":{"name":{"type":"string"}}}]}"#;
    let mut environment = environment(optional_types());
    environment
        .register_variable("direct", schema(&format!(r#"{{"type":"object","properties":{{"type":{COLUMN}}}}}"#)), None)
        .unwrap();
    environment
        .register_variable(
            "referenced",
            schema(&format!(
                r##"{{"type":"object","properties":{{"type":{{"$ref":"#/$defs/Column"}}}},"$defs":{{"Column":{COLUMN}}}}}"##
            )),
            None,
        )
        .unwrap();
    environment
}

#[test]
fn a_presence_read_discriminates_a_two_shape_field_while_the_ordinary_read_stays_refused() {
    assert_rows(
        &two_shapes(),
        vec![
            ("direct.type.?name", "optional<string>", vec![]),
            ("direct.type[?'name']", "optional<string>", vec![]),
            ("has(direct.type.name)", "bool", vec![]),
            ("direct.type.name", "dyn", vec![found(TypeError, "string holds no members", 12, 16)]),
            ("referenced.type.?name", "optional<string>", vec![]),
            ("referenced.type[?'name']", "optional<string>", vec![]),
            ("has(referenced.type.name)", "bool", vec![]),
            ("referenced.type.name", "dyn", vec![found(TypeError, "string holds no members", 16, 20)]),
        ],
    );
}

#[test]
fn a_presence_read_refuses_an_operand_whose_declared_type_holds_no_members_in_every_form_alike() {
    let mut text = environment(optional_types());
    text.register_variable("text", "string", None).unwrap();
    assert_rows(
        &text,
        vec![
            ("text.b", "dyn", vec![found(TypeError, "string holds no members", 5, 6)]),
            ("text.?b", "optional<dyn>", vec![found(TypeError, "string holds no members", 6, 7)]),
            ("has(text.b)", "bool", vec![found(TypeError, "string holds no members", 9, 10)]),
            ("text['b']", "dyn", vec![found(TypeError, "string holds no elements", 0, 9)]),
            ("text[?'b']", "optional<dyn>", vec![found(TypeError, "string holds no elements", 0, 10)]),
        ],
    );
    // And a union no branch of which holds the member is refused in the presence form too.
    let mut neither = environment(optional_types());
    neither.register_variable("either", schema(r#"{"anyOf":[{"type":"string"},{"type":"integer"}]}"#), None).unwrap();
    assert_eq!(codes(&neither.check("either.?b")), [TypeError, TypeError]);
    assert_rows(
        &neither,
        vec![(
            "either.?b",
            "optional<dyn>",
            vec![found(TypeError, "string holds no members", 8, 9), found(TypeError, "int holds no members", 8, 9)],
        )],
    );
}
