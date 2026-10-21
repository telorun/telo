//! What this crate has and the Node core does not: the embedded licence text and the
//! JSON reader standing in for `JSON.parse`.

use telorun_message_format::{parse_json, JsonValue, CLDR_LICENSE};

#[test]
fn the_cldr_licence_ships_with_the_data() {
    let file = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../cldr/LICENSE")).unwrap();
    assert_eq!(CLDR_LICENSE, file);
    assert!(CLDR_LICENSE.starts_with("UNICODE LICENSE V3"));
}

#[test]
fn an_object_keeps_ecmascript_key_order() {
    let value = parse_json(r#"{"b": 1, "2": 2, "a": 3, "1": 4, "b": 5, "01": 6}"#).unwrap();
    let keys: Vec<&str> = value.as_object().unwrap().iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["1", "2", "b", "a", "01"]);
    assert_eq!(value.get("b"), Some(&JsonValue::Number(5.0)));
}

#[test]
fn a_surrogate_pair_escape_reads_as_one_character() {
    assert_eq!(parse_json(r#""😀\u0000""#).unwrap(), JsonValue::String("😀\0".into()));
    assert!(parse_json(r#""\ud83d""#).is_err());
}
