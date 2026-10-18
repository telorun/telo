//! The Node readings recorded as interim rather than intended, reproduced until Node
//! changes: a second engine that read a source differently would make two kernels
//! disagree about one manifest.
//!
//! - A carriage return is content in a single-line string, a bytes literal and a quoted
//!   member name; only a line feed ends one. cel-spec's single-line literal excludes it.
//! - A `list` or a `map` written with the wrong number of type arguments reads, silently,
//!   as `list<dyn>` or `map<dyn, dyn>`.
//! - Signature text is trimmed, and its separators read, by ECMAScript's whitespace — a
//!   byte order mark and U+00A0 included — while type text skips only the space.
//! - A named type registered again keeps every signature its earlier registration made,
//!   and one refused part way keeps the type and the signatures before the refusal.
//!
//! No Node test file is the twin of this one. Every row is the Node build's answer,
//! executed: the carriage return on `@telorun/cel` 0.112.0, this branch's build; the
//! type rows on `@telorun/cel 0.118.0 at 63c81d00`.

mod support;

use support::*;
use telorun_cel::{
    format_type, parse_signature, parse_type_expression, serialize_tree, signature_key, trees_equal, CelEnvironment,
    CelRegistrationError, CelSyntaxCode, CelUnknownTypeNameError, FunctionDefinition, NominalTypeDefinition,
    TypeDefinitionListing,
};

#[test]
fn interim_a_single_line_literal_holds_a_raw_carriage_return() {
    // The quoted name alone is refused for where it stands, not for what it holds.
    assert_reads_as_node(vec![
        reading("'a\rb'", defaults(), literal_string("a\rb", 0, 5), None),
        reading("b'a\rb'", defaults(), literal_bytes(&[97, 13, 98], 0, 6), None),
        reading("`a\rb`", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a\\rb`\" cannot stand here, expected \"a member read, as in a.`b`\"", 0, 5))),
        reading("a.`b\rc`", defaults(), select(ident("a", false, 0, 1), "b\rc", (2, 7), false, true, 0, 7), None),
    ]);
}

#[test]
fn interim_writes_back_what_holds_a_carriage_return() {
    /// `(source, the text Node writes for its tree)`. Node re-reads each to an equal tree.
    const NODE_WRITTEN: [(&str, &str); 3] = [
        ("'a\rb'", "\"a\\rb\""),
        ("b'a\rb'", "b\"a\\x0db\""),
        ("a.`b\rc`", "a.`b\rc`"),
    ];
    for (source, written) in NODE_WRITTEN {
        let first = tree(source);
        assert_eq!(serialize_tree(&first).as_deref(), Ok(written), "{source}");
        assert!(trees_equal(&first, &tree(written)), "{source}");
    }
}

#[test]
fn interim_a_list_or_map_with_the_wrong_number_of_arguments_reads_as_dyn() {
    // `(text, formatType(parseTypeExpression(text)))`.
    const NODE_READ: [(&str, &str); 6] = [
        ("list", "list<dyn>"),
        ("list<int, int>", "list<dyn>"),
        ("map", "map<dyn, dyn>"),
        ("map<int>", "map<dyn, dyn>"),
        ("map<int, int, int>", "map<dyn, dyn>"),
        ("list<map<int>>", "list<map<dyn, dyn>>"),
    ];
    for (text, read) in NODE_READ {
        assert_eq!(format_type(&parse_type_expression(text, None).expect("reads"), false), read, "{text}");
    }
}

#[test]
fn interim_signature_text_is_read_by_ecmascript_whitespace() {
    // `(text, signatureKey(parseSignature(text)))`.
    const NODE_READ: [(&str, &str); 4] = [
        ("\u{feff}size(string): int", "size(string)"),
        ("\u{a0}\u{3000}f(): int\u{2028}\u{feff}", "f()"),
        ("f()  :\u{a0}int", "f()"),
        ("f()\u{2028}:\u{2029}int", "f()"),
    ];
    for (text, key) in NODE_READ {
        assert_eq!(signature_key(&parse_signature(text, None).expect("reads")), key, "{text:?}");
    }
    // Type text inside it skips only the space.
    assert_eq!(
        parse_signature("f(int\u{a0}): int", None).map_err(|error| error.to_string()),
        Err("\"int\u{a0}\" is not one type expression".into())
    );
}

#[test]
fn interim_a_named_type_registered_again_keeps_its_earlier_signatures() {
    let named = |name: &str, base: &str| NominalTypeDefinition { name: name.into(), base: base.into(), ..Default::default() };
    let mut environment = CelEnvironment::default();
    environment.register_type(named("A1", "int")).expect("registers");
    environment
        .register_type(NominalTypeDefinition { conversions: vec!["string(Self): string".into()], ..named("Money", "int") })
        .expect("registers");
    environment
        .register_type(NominalTypeDefinition {
            members: vec!["Self.cents(): int".into()],
            description: Some("again".into()),
            ..named("Money", "string")
        })
        .expect("registers");
    let listing = environment.definitions();
    let listed = |name: &str, base: &str, description: Option<&str>| TypeDefinitionListing {
        name: name.into(),
        base: base.into(),
        parameters: vec![],
        fields: None,
        description: description.map(Into::into),
    };
    assert_eq!(listing.types, [listed("A1", "int", None), listed("Money", "string", Some("again"))]);
    let signatures: Vec<String> = listing
        .functions
        .iter()
        .filter(|entry| entry.origin.as_deref() == Some("type:Money"))
        .map(|entry: &FunctionDefinition| entry.signature.clone())
        .collect();
    assert_eq!(signatures, ["Money.cents(): int", "string(Money): string"]);

    // Refused part way: the type and the signature before the refusal stay.
    let mut environment = CelEnvironment::default();
    assert_eq!(
        environment.register_type(NominalTypeDefinition {
            conversions: vec!["string(Self): string".into(), "f(Nope): int".into()],
            members: vec!["Self.g(): int".into()],
            ..named("Bad", "int")
        }),
        Err(CelRegistrationError::UnknownName(CelUnknownTypeNameError { type_name: "Nope".into() }))
    );
    let listing = environment.definitions();
    assert_eq!(listing.types, [listed("Bad", "int", None)]);
    let signatures: Vec<&str> = listing
        .functions
        .iter()
        .filter(|entry| entry.origin.as_deref() == Some("type:Bad"))
        .map(|entry| entry.signature.as_str())
        .collect();
    assert_eq!(signatures, ["string(Bad): string"]);
}
