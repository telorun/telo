//! Type text: every message template the reader answers, the resolver seam and the
//! order it is asked in, as literal tables.
//!
//! No Node test file is the twin of this one: Node's tests reach the reader through an
//! environment. Every row is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. The silent reading of a `list` or `map` with
//! the wrong number of arguments is in `interim_readings.rs`; a prototype name is in
//! `type_expression_differences` below.

use std::cell::RefCell;

use telorun_cel::{
    format_type, parse_type_expression, CelType, CelTypeExpressionError, CelTypeRegistrationError, CelTypeTextError,
    CelUnknownTypeNameError, NominalType, DYN,
};

/// What the reader answers for a text: the type printed, or the error's class and text.
fn answer(text: &str, resolver: Option<&telorun_cel::NominalResolver<'_>>) -> (&'static str, String) {
    match parse_type_expression(text, resolver) {
        Ok(ty) => ("ok", format_type(&ty, false)),
        Err(CelTypeTextError::Expression(CelTypeExpressionError { message })) => ("CelTypeExpressionError", message),
        Err(CelTypeTextError::UnknownName(error)) => ("CelUnknownTypeNameError", error.to_string()),
        Err(CelTypeTextError::Registration(CelTypeRegistrationError { message })) => ("CelTypeRegistrationError", message),
    }
}

#[test]
fn reads_or_refuses_each_text_as_node_does() {
    // `(text, the class Node throws or "ok", its message or the type printed)`.
    const NODE_READ: [(&str, &str, &str); 33] = [
        ("", "CelTypeExpressionError", "\"\" names no type at offset 0"),
        ("<int>", "CelTypeExpressionError", "\"<int>\" names no type at offset 0"),
        ("list<>", "CelTypeExpressionError", "\"list<>\" names no type at offset 5"),
        ("list<int,>", "CelTypeExpressionError", "\"list<int,>\" names no type at offset 9"),
        ("  ", "CelTypeExpressionError", "\"  \" names no type at offset 2"),
        ("é", "CelTypeExpressionError", "\"é\" names no type at offset 0"),
        ("list<é>", "CelTypeExpressionError", "\"list<é>\" names no type at offset 5"),
        // The reader skips only the space character.
        ("list<\tint>", "CelTypeExpressionError", "\"list<\\tint>\" names no type at offset 5"),
        ("int int", "CelTypeExpressionError", "\"int int\" is not one type expression"),
        ("int>", "CelTypeExpressionError", "\"int>\" is not one type expression"),
        ("list<int>>", "CelTypeExpressionError", "\"list<int>>\" is not one type expression"),
        ("int\n", "CelTypeExpressionError", "\"int\\n\" is not one type expression"),
        ("list<int", "CelTypeExpressionError", "\"list<int\" has no closing '>' for its type arguments"),
        ("map<string int>", "CelTypeExpressionError", "\"map<string int>\" has no closing '>' for its type arguments"),
        ("list<int;", "CelTypeExpressionError", "\"list<int;\" has no closing '>' for its type arguments"),
        ("list<list<int>", "CelTypeExpressionError", "\"list<list<int>\" has no closing '>' for its type arguments"),
        ("int<string>", "CelTypeExpressionError", "int takes no type arguments"),
        ("dyn<int>", "CelTypeExpressionError", "dyn takes no type arguments"),
        ("A<int>", "CelTypeExpressionError", "A takes no type arguments"),
        ("google.protobuf.Timestamp<int>", "CelTypeExpressionError", "google.protobuf.Timestamp takes no type arguments"),
        ("null_type<int>", "CelTypeExpressionError", "null_type takes no type arguments"),
        ("optional", "CelTypeExpressionError", "optional takes exactly one type argument"),
        ("optional<int, int>", "CelTypeExpressionError", "optional takes exactly one type argument"),
        ("Money", "CelUnknownTypeNameError", "no type is registered under the name \"Money\""),
        ("list<Foo>", "CelUnknownTypeNameError", "no type is registered under the name \"Foo\""),
        // A name is resolved before the reader looks for the end of the text.
        ("Foo bar", "CelUnknownTypeNameError", "no type is registered under the name \"Foo\""),
        ("google.protobuf", "CelUnknownTypeNameError", "no type is registered under the name \"google.protobuf\""),
        ("a.b.c", "CelUnknownTypeNameError", "no type is registered under the name \"a.b.c\""),
        (" list < int > ", "ok", "list<int>"),
        ("map<string, list<optional<A>>>", "ok", "map<string, list<optional<A>>>"),
        ("null_type", "ok", "null"),
        ("timestamp", "ok", "google.protobuf.Timestamp"),
        ("google.protobuf.Duration", "ok", "google.protobuf.Duration"),
    ];
    for (text, class, message) in NODE_READ {
        assert_eq!(answer(text, None), (class, message.to_string()), "{text:?}");
    }
    // The unknown name is carried as data, beside its text.
    let Err(CelTypeTextError::UnknownName(CelUnknownTypeNameError { type_name })) = parse_type_expression("list<Foo>", None)
    else {
        panic!("an unknown name")
    };
    assert_eq!(type_name, "Foo");
}

#[test]
fn asks_the_resolver_after_each_names_arguments_and_stops_at_its_refusal() {
    // `(text, what the resolver was asked, in order, and the answer)`.
    const NODE_ASKED: [(&str, &[&str], &str); 3] = [
        ("Pair<Foo, Bar<Baz>>", &["Foo()", "Baz()", "Bar(Baz)", "Pair(Foo, Bar<Baz>)"], "Pair<Foo, Bar<Baz>>"),
        ("Pair<Unknown, Bar>", &["Unknown()"], "no type is registered under the name \"Unknown\""),
        ("list<Wide<int>>", &["Wide(int)"], "Wide takes 0 type arguments"),
    ];
    for (text, expected, answered) in NODE_ASKED {
        let asked = RefCell::new(Vec::<String>::new());
        let resolver = |name: &str, args: &[CelType]| {
            let printed: Vec<String> = args.iter().map(|ty| format_type(ty, false)).collect();
            asked.borrow_mut().push(format!("{name}({})", printed.join(", ")));
            match name {
                "Unknown" => Ok(None),
                "Wide" => Err(CelTypeRegistrationError { message: "Wide takes 0 type arguments".into() }),
                _ => Ok(Some(CelType::Nominal(NominalType {
                    name: name.into(),
                    base: DYN.into(),
                    args: args.to_vec().into(),
                    fields: None,
                }))),
            }
        };
        assert_eq!(answer(text, Some(&resolver)).1, answered, "{text}");
        assert_eq!(asked.into_inner(), expected, "{text}");
    }
}

/// A name the language does not define reaches the resolver and, unresolved, is refused
/// like any other. On Node such a name is first looked up on plain objects, so one that
/// is a property of `Object.prototype` reads as that property — `registerVariable("v",
/// "constructor")` declares `v` with no type, and the checker reads it as `dyn`.
#[test]
fn type_expression_differences_a_prototype_name_is_an_unknown_name() {
    for name in ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"] {
        assert_eq!(
            answer(name, None),
            ("CelUnknownTypeNameError", format!("no type is registered under the name \"{name}\"")),
            "{name}"
        );
    }
}
