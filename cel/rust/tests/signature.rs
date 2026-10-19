//! Signature text: the pattern's corners, ECMAScript whitespace, line terminators, the
//! order the parts are read in, and the printed signature and its dispatch key.
//!
//! No Node test file is the twin of this one: Node's tests reach the reader through an
//! environment. Every row is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`.

use telorun_cel::{
    format_signature, format_type, parse_signature, signature_key, CallForm, CelTypeExpressionError,
    CelTypeTextError,
};

/// A signature read: its name, receiver, parameters and result printed, its key, and
/// the signature printed whole.
type Read = (&'static str, Option<&'static str>, &'static [&'static str], &'static str, &'static str, &'static str);

#[test]
fn reads_or_refuses_each_signature_as_node_does() {
    // `(text, what parseSignature answers, or the class and message it throws)`.
    const NODE_READ: [(&str, Result<Read, (&str, &str)>); 35] = [
        ("size(string): int", Ok(("size", None, &["string"], "int", "size(string)", "size(string): int"))),
        ("string.startsWith(string): bool", Ok(("startsWith", Some("string"), &["string"], "bool", "string.startsWith(string)", "string.startsWith(string): bool"))),
        ("list<A>.size(): int", Ok(("size", Some("list<A>"), &[], "int", "list<A>.size()", "list<A>.size(): int"))),
        ("google.protobuf.Timestamp.getDate(): int", Ok(("getDate", Some("google.protobuf.Timestamp"), &[], "int", "google.protobuf.Timestamp.getDate()", "google.protobuf.Timestamp.getDate(): int"))),
        ("map<K, V>.size(): int", Ok(("size", Some("map<K, V>"), &[], "int", "map<K, V>.size()", "map<K, V>.size(): int"))),
        ("\u{feff}size(string): int", Ok(("size", None, &["string"], "int", "size(string)", "size(string): int"))),
        (" f (): int", Err(("CelTypeExpressionError", "\" f (): int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("f():int", Ok(("f", None, &[], "int", "f()", "f(): int"))),
        ("f()  :\u{a0}int", Ok(("f", None, &[], "int", "f()", "f(): int"))),
        ("f(): in\u{2028}t", Err(("CelTypeExpressionError", "\"f(): in\u{2028}t\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("a\nb.f(): int", Err(("CelTypeExpressionError", "\"a\\nb.f(): int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("f(a.b): int", Err(("CelUnknownTypeNameError", "no type is registered under the name \"a.b\""))),
        ("f(map<K, V>, int): bool", Ok(("f", None, &["map<K, V>", "int"], "bool", "f(map<K, V>, int)", "f(map<K, V>, int): bool"))),
        ("f( ): int", Ok(("f", None, &[], "int", "f()", "f(): int"))),
        ("f(\n): int", Ok(("f", None, &[], "int", "f()", "f(): int"))),
        ("f(int\n): int", Err(("CelTypeExpressionError", "\"int\\n\" is not one type expression"))),
        ("f(int,): int", Err(("CelTypeExpressionError", "\"\" names no type at offset 0"))),
        ("x.y.f(): int", Err(("CelUnknownTypeNameError", "no type is registered under the name \"x.y\""))),
        ("f(): google.protobuf.Timestamp", Ok(("f", None, &[], "google.protobuf.Timestamp", "f()", "f(): google.protobuf.Timestamp"))),
        ("f(int", Err(("CelTypeExpressionError", "\"f(int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("f() int", Err(("CelTypeExpressionError", "\"f() int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        (".f(): int", Err(("CelTypeExpressionError", "\".f(): int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("f(int, int, int, int, int): int", Ok(("f", None, &["int", "int", "int", "int", "int"], "int", "f(int, int, int, int, int)", "f(int, int, int, int, int): int"))),
        ("f(): ", Err(("CelTypeExpressionError", "\"f(): \" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("Foo.f(Bar): Baz", Err(("CelUnknownTypeNameError", "no type is registered under the name \"Bar\""))),
        ("Foo.f(int): Baz", Err(("CelUnknownTypeNameError", "no type is registered under the name \"Foo\""))),
        ("list<int>.f(int).g(): int", Err(("CelTypeExpressionError", "\"list<int>.f(int)\" is not one type expression"))),
        ("f(int)): int", Err(("CelTypeExpressionError", "\"f(int)): int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("_x9(): int", Ok(("_x9", None, &[], "int", "_x9()", "_x9(): int"))),
        ("9x(): int", Err(("CelTypeExpressionError", "\"9x(): int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
        ("f(): list<int>.x", Err(("CelTypeExpressionError", "\"list<int>.x\" is not one type expression"))),
        ("a.f(int): int: int", Err(("CelUnknownTypeNameError", "no type is registered under the name \"a\""))),
        ("f(): \u{85}int", Err(("CelTypeExpressionError", "\"\u{85}int\" names no type at offset 0"))),
        ("f(): \u{180e}int", Err(("CelTypeExpressionError", "\"\u{180e}int\" names no type at offset 0"))),
        ("a.\u{2028}b.f(): int", Err(("CelTypeExpressionError", "\"a.\u{2028}b.f(): int\" is not a signature \u{2014} write 'name(a, b): r' or 'Receiver.name(a): r'"))),
    ];
    for (text, expected) in NODE_READ {
        match (parse_signature(text, None), expected) {
            (Ok(signature), Ok((name, receiver, parameters, returns, key, written))) => {
                assert_eq!(signature.name, name, "{text:?}");
                assert_eq!(signature.form(), if receiver.is_some() { CallForm::Receiver } else { CallForm::Global });
                assert_eq!(signature.receiver.as_ref().map(|ty| format_type(ty, false)).as_deref(), receiver, "{text:?}");
                let printed: Vec<String> = signature.parameters.iter().map(|ty| format_type(ty, false)).collect();
                assert_eq!(printed, parameters, "{text:?}");
                assert_eq!(format_type(&signature.returns, false), returns, "{text:?}");
                assert_eq!(signature_key(&signature), key, "{text:?}");
                assert_eq!(format_signature(&signature), written, "{text:?}");
            }
            (Err(error), Err((class, message))) => {
                let held = match &error {
                    CelTypeTextError::Expression(CelTypeExpressionError { .. }) => "CelTypeExpressionError",
                    CelTypeTextError::UnknownName(_) => "CelUnknownTypeNameError",
                    CelTypeTextError::Registration(_) => "CelTypeRegistrationError",
                };
                assert_eq!((held, error.to_string().as_str()), (class, message), "{text:?}");
            }
            (answer, expected) => panic!("{text:?}: {answer:?}, where Node answers {expected:?}"),
        }
    }
}
