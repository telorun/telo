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
//! - A schema's empty `enum`, `anyOf`, `oneOf`, `allOf` or `type` list says nothing, and
//!   a union one of whose branches says nothing is `dyn` — silently, both.
//! - An array segment of a JSON Pointer is read by ECMAScript's `Number()`: whitespace
//!   around it, a radix prefix, an exponent, a point and `-0` all name an element, and
//!   the empty segment names the first.
//! - A dereference of something that may be null is judged only where its subject is a
//!   plain chain of named members over a name: `rows[0].code` over a nullable element is
//!   not reported, while `m.k.code` over the same type is.
//!
//! No Node test file is the twin of this one. Every row is the Node build's answer,
//! executed: the carriage return on `@telorun/cel` 0.112.0, this branch's build; the
//! type, schema and nullable rows on `@telorun/cel 0.118.0 at 63c81d00`.

mod check_support;
mod schema_support;
mod support;

use schema_support::{assert_rows, row, Row};
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

#[test]
fn interim_a_schema_list_that_is_empty_or_a_union_with_an_open_branch_says_nothing() {
    const NODE_ROWS: &[Row] = &[
        row("an empty enum", "{\"enum\":[]}", &[], &[], "dyn", "dyn", &[], 1),
        row("an empty anyOf", "{\"anyOf\":[]}", &[], &[], "dyn", "dyn", &[], 1),
        row("an empty oneOf", "{\"oneOf\":[]}", &[], &[], "dyn", "dyn", &[], 1),
        row("an empty allOf", "{\"allOf\":[]}", &[], &[], "dyn", "dyn", &[], 1),
        row("an empty type list", "{\"type\":[]}", &[], &[], "dyn", "dyn", &[], 1),
        row("a union holding an unconstrained branch", "{\"anyOf\":[{\"type\":\"string\"},{}]}", &[], &[], "dyn", "dyn", &[], 3),
    ];
    assert_rows(NODE_ROWS);
}

#[test]
fn interim_a_pointer_reads_an_array_segment_as_ecmascript_reads_a_number() {
    // `#/$defs/list/<segment>` over a list of a string schema and an integer schema.
    const NODE_ROWS: &[Row] = &[
        row("segment \"0\"", "{\"$ref\":\"#/$defs/list/0\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "string", "string", &[], 2),
        row("segment \"1\"", "{\"$ref\":\"#/$defs/list/1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"01\"", "{\"$ref\":\"#/$defs/list/01\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \" 1\"", "{\"$ref\":\"#/$defs/list/ 1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"1 \"", "{\"$ref\":\"#/$defs/list/1 \",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"\\t1\\n\"", "{\"$ref\":\"#/$defs/list/\\t1\\n\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"0x1\"", "{\"$ref\":\"#/$defs/list/0x1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"0X1\"", "{\"$ref\":\"#/$defs/list/0X1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"0b1\"", "{\"$ref\":\"#/$defs/list/0b1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"0o1\"", "{\"$ref\":\"#/$defs/list/0o1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"1e0\"", "{\"$ref\":\"#/$defs/list/1e0\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"1.0\"", "{\"$ref\":\"#/$defs/list/1.0\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \".1e1\"", "{\"$ref\":\"#/$defs/list/.1e1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"+1\"", "{\"$ref\":\"#/$defs/list/+1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"-0\"", "{\"$ref\":\"#/$defs/list/-0\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "string", "string", &[], 2),
        row("segment \"\"", "{\"$ref\":\"#/$defs/list/\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "string", "string", &[], 2),
        row("segment \" \"", "{\"$ref\":\"#/$defs/list/ \",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "string", "string", &[], 2),
        row("segment \"2\"", "{\"$ref\":\"#/$defs/list/2\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"-1\"", "{\"$ref\":\"#/$defs/list/-1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"1.5\"", "{\"$ref\":\"#/$defs/list/1.5\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"length\"", "{\"$ref\":\"#/$defs/list/length\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"Infinity\"", "{\"$ref\":\"#/$defs/list/Infinity\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"1_0\"", "{\"$ref\":\"#/$defs/list/1_0\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"0x\"", "{\"$ref\":\"#/$defs/list/0x\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"1e\"", "{\"$ref\":\"#/$defs/list/1e\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"NaN\"", "{\"$ref\":\"#/$defs/list/NaN\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("segment \"\u{a0}1\"", "{\"$ref\":\"#/$defs/list/\u{a0}1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
        row("segment \"\u{feff}1\"", "{\"$ref\":\"#/$defs/list/\u{feff}1\",\"$defs\":{\"list\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}", &[], &[], "int", "int", &[], 2),
    ];
    assert_rows(NODE_ROWS);
}

#[test]
fn interim_a_nullable_subject_that_is_not_a_plain_chain_is_not_judged() {
    // The same nullable object, reached through an index and through a member: only the
    // member chain is a subject of the verdict.
    const NODE: &str = r#"{"type":["object","null"],"properties":{"code":{"type":"string"}}}"#;
    let mut environment = CelEnvironment::default();
    environment.register_variable("rows", check_support::schema(&format!(r#"{{"type":"array","items":{NODE}}}"#)), None).unwrap();
    environment
        .register_variable("m", check_support::schema(&format!(r#"{{"type":"object","additionalProperties":{NODE}}}"#)), None)
        .unwrap();
    check_support::assert_rows(
        &environment,
        vec![
            ("rows[0].code", "string", vec![]),
            ("m['k'].code", "string", vec![]),
            ("rows[0]['code']", "string", vec![]),
            (
                "m.k.code",
                "string",
                vec![check_support::found(
                    telorun_cel::CelCheckCode::NullableAccess,
                    "\"m.k\" may be null \u{2014} guard it (e.g. 'm.k != null && \u{2026}' or 'm.k == null ? \u{2026} : m.k.code') before reading .code",
                    4,
                    8,
                )],
            ),
        ],
    );
}
