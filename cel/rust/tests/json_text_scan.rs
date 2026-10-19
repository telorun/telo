//! The JSON reader: where a text stops being JSON, in UTF-16 code units, and the value
//! a JSON text reads to — key order, a key written twice, numbers, escapes.
//!
//! No Node test file is the twin of this one: Node's tests reach the scan through the
//! catalog's `parseJson`. Every refusal offset is the Node build's `scanJsonPrefix`,
//! executed (`@telorun/cel 0.118.0 at 63c81d00`), and each row's acceptance is also what
//! `JSON.parse` answered. Every value read is written back as `JSON.stringify` writes
//! the value `JSON.parse` answered, from the same run. What is this crate's own: the
//! refusal of an escape naming an unpaired surrogate, which `JSON.parse` accepts.

use telorun_cel::{read_json_text, scan_json_prefix, JsonRefusal, JsonTextError, JsonValue};
use telorun_cel_value::{es_number, json_quote};

/// A value written as `JSON.stringify` writes one, keys in the value's own order.
fn written(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".into(),
        JsonValue::Bool(flag) => flag.to_string(),
        JsonValue::Number(number) => es_number(*number),
        JsonValue::String(text) => json_quote(text),
        JsonValue::Array(items) => format!("[{}]", items.iter().map(|item| written(item)).collect::<Vec<_>>().join(",")),
        JsonValue::Object(entries) => format!(
            "{{{}}}",
            entries.iter().map(|(key, value)| format!("{}:{}", json_quote(key), written(value))).collect::<Vec<_>>().join(",")
        ),
    }
}

#[test]
fn refuses_each_text_where_node_does() {
    // `(text, scanJsonPrefix's offset and endOfInput, or nothing for JSON)`.
    const NODE_SCANNED: [(&str, Option<(usize, bool)>); 47] = [
        ("", Some((0, true))),
        (" ", Some((1, true))),
        ("1", None),
        ("-", Some((1, true))),
        ("-0", None),
        ("01", Some((1, false))),
        ("1.", Some((2, true))),
        ("1.5e", Some((4, true))),
        ("1e+", Some((3, true))),
        ("1E-2", None),
        ("[1,]", Some((3, false))),
        ("[1 2]", Some((3, false))),
        ("{\"a\":1,}", Some((7, false))),
        ("{\"a\" 1}", Some((5, false))),
        ("{a:1}", Some((1, false))),
        ("\"abc", Some((4, true))),
        ("\"a\\x\"", Some((3, false))),
        ("\"\\u12G4\"", Some((5, false))),
        ("\"\\u12", Some((5, true))),
        ("\u{feff}1", Some((0, false))),
        ("\"a\u{1}\"", Some((2, false))),
        ("tru", Some((3, true))),
        ("trux", Some((3, false))),
        ("nul", Some((3, true))),
        ("[[[", Some((3, true))),
        ("]", Some((0, false))),
        ("{}", None),
        ("[]", None),
        ("{\"a\":[1,{\"b\":null}]}", None),
        ("1 2", Some((2, false))),
        ("\u{1f600}", Some((0, false))),
        ("\"\u{1f600}\"x", Some((4, false))),
        ("\"\\uD83D\"", None),
        (" \t\n\r[ ] ", None),
        ("[\u{a0}]", Some((1, false))),
        ("{\"a\":1}}", Some((7, false))),
        ("[1,2]]", Some((5, false))),
        ("-a", Some((1, false))),
        ("0.e1", Some((2, false))),
        ("{\"a\":}", Some((5, false))),
        ("{,}", Some((1, false))),
        ("\"\\", Some((2, true))),
        ("\"\\u", Some((3, true))),
        ("falsey", Some((5, false))),
        ("nulll", Some((4, false))),
        ("[true,false,null]", None),
        ("\"\\/\\b\\f\\n\\r\\t\\\"\\\\\"", None),
    ];
    for (text, expected) in NODE_SCANNED {
        let refusal = expected.map(|(offset, end_of_input)| JsonRefusal { offset, end_of_input });
        assert_eq!(scan_json_prefix(text), refusal, "{text:?}");
        match refusal {
            Some(refusal) => assert_eq!(read_json_text(text).err(), Some(JsonTextError::NotJson(refusal)), "{text:?}"),
            // A text the scan accepts reads, but for the one refusal of this crate's own.
            None => assert!(
                matches!(read_json_text(text), Ok(_) | Err(JsonTextError::UnpairedSurrogate { .. })),
                "{text:?}"
            ),
        }
    }
}

#[test]
fn reads_each_text_to_the_value_json_parse_answers() {
    // `(text, JSON.stringify(JSON.parse(text)))`.
    const NODE_READ: [(&str, &str); 6] = [
        ("{\"b\":1,\"10\":2,\"a\":3,\"2\":4,\"b\":5}", "{\"2\":4,\"10\":2,\"b\":5,\"a\":3}"),
        ("{\"__proto__\":1,\"constructor\":{}}", "{\"__proto__\":1,\"constructor\":{}}"),
        ("[1e20,-0,1.0,0.1,1e-7,123456789012345678901234567890,5e-324]", "[100000000000000000000,0,1,0.1,1e-7,1.2345678901234568e+29,5e-324]"),
        ("\"\\uD83D\\uDE00\\u00e9\\n\"", "\"\u{1f600}\u{e9}\\n\""),
        ("  {\"a\" : [ ] , \"c\":{ }}  ", "{\"a\":[],\"c\":{}}"),
        ("\"\u{1f600}\"", "\"\u{1f600}\""),
    ];
    for (text, expected) in NODE_READ {
        let value = read_json_text(text).unwrap_or_else(|error| panic!("{text:?}: {error}"));
        assert_eq!(written(&value), expected, "{text:?}");
    }
    // Every object and array is its own node; a number is a double.
    let value = read_json_text("[[1],[1]]").expect("reads");
    let JsonValue::Array(items) = &*value else { panic!("an array") };
    assert!(!std::sync::Arc::ptr_eq(&items[0], &items[1]) && items[0] == items[1]);
    assert_eq!(*read_json_text("1.0").expect("reads"), JsonValue::Number(1.0));
}

/// `JSON.parse` reads an escape naming a surrogate with no partner into a string no
/// Rust string can hold, so the reader refuses it, at the escape's backslash.
#[test]
fn json_text_differences_an_unpaired_surrogate_escape_is_refused() {
    const REFUSED: [(&str, usize); 5] = [
        ("\"\\uD83D\"", 1),
        ("\"ab\\uDE00\"", 3),
        ("\"\\uD83Dx\"", 1),
        ("\"\u{1f600}\\uD83D\\u0041\"", 3),
        ("[\"\\uD83D\\uDE00\", \"\\uDBFF\\uDFFF\", \"\\uDBFF\"]", 34),
    ];
    for (text, offset) in REFUSED {
        assert_eq!(scan_json_prefix(text), None, "{text:?}");
        assert_eq!(read_json_text(text).err(), Some(JsonTextError::UnpairedSurrogate { offset }), "{text:?}");
    }
}
