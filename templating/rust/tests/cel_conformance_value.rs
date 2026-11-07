//! Twin of `templating/nodejs/tests/cel-conformance-value.test.ts`: the codec writes and
//! reads back every form, and refuses what is not a value or not canonical.
//!
//! Node cases with no twin: an int outside int64 and an undefined map value, which no Rust
//! value can be; and the unpaired-surrogate finder, since a Rust string holds no unpaired
//! surrogate — the runner pins that a file holding one does not read.

mod support;

use std::sync::Arc;

use serde_json::{json, Value};
use support::cel_conformance_value::{decode, encode};
use telorun_cel_value::{
    cel_duration_from_nanos, cel_error, cel_map_from_entries, cel_none, cel_some, cel_timestamp, cel_type_value,
    CelEvaluationCode, CelHostValue, CelValue,
};

fn s(text: &str) -> CelValue {
    CelValue::String(text.into())
}

fn written() -> Vec<(&'static str, CelValue, Value)> {
    vec![
        ("int64 beyond 2^53", CelValue::Int(i64::MIN), json!({ "$telo": "int", "value": "-9223372036854775808" })),
        ("uint", CelValue::Uint(u64::MAX), json!({ "$telo": "uint", "value": "18446744073709551615" })),
        ("NaN", CelValue::Double(f64::NAN), json!({ "$telo": "double", "value": "NaN" })),
        ("Infinity", CelValue::Double(f64::INFINITY), json!({ "$telo": "double", "value": "Infinity" })),
        ("-Infinity", CelValue::Double(f64::NEG_INFINITY), json!({ "$telo": "double", "value": "-Infinity" })),
        ("-0", CelValue::Double(-0.0), json!({ "$telo": "double", "value": "-0" })),
        ("bytes", CelValue::Bytes(vec![0, 255].into()), json!({ "$telo": "bytes", "value": "AP8" })),
        (
            "timestamp",
            CelValue::Timestamp(cel_timestamp(1_234_567_890, 0).unwrap()),
            json!({ "$telo": "google.protobuf.Timestamp", "value": "2009-02-13T23:31:30Z" }),
        ),
        (
            "duration",
            CelValue::Duration(cel_duration_from_nanos(90_000_000_005).unwrap()),
            json!({ "$telo": "google.protobuf.Duration", "value": "90.000000005s" }),
        ),
        (
            "map with non-string keys",
            CelValue::Map(
                cel_map_from_entries([(CelValue::Int(2), s("b")), (CelValue::Bool(true), s("t")), (CelValue::Uint(1), s("a"))])
                    .unwrap(),
            ),
            json!({
                "$telo": "map",
                "value": [[true, "t"], [{ "$telo": "int", "value": "2" }, "b"], [{ "$telo": "uint", "value": "1" }, "a"]]
            }),
        ),
        (
            "map holding the $cel key",
            CelValue::Record([("$cel", s("type")), ("value", s("int"))].into_iter().collect()),
            json!({ "$telo": "map", "value": [["$cel", "type"], ["value", "int"]] }),
        ),
        (
            "nested type and optional forms",
            CelValue::Record(
                [
                    (
                        "b",
                        CelValue::Optional(cel_some(CelValue::List(
                            vec![CelValue::Type(cel_type_value("int")), CelValue::Optional(cel_none())].into(),
                        ))),
                    ),
                    (
                        "a",
                        CelValue::Optional(cel_some(CelValue::Optional(cel_some(CelValue::Type(cel_type_value(
                            "google.protobuf.Duration",
                        )))))),
                    ),
                ]
                .into_iter()
                .collect(),
            ),
            json!({
                "a": { "$cel": "optional", "value": { "$cel": "optional", "value": { "$cel": "type", "value": "google.protobuf.Duration" } } },
                "b": { "$cel": "optional", "value": [{ "$cel": "type", "value": "int" }, { "$cel": "optional" }] }
            }),
        ),
        ("the null type", CelValue::Type(cel_type_value("null_type")), json!({ "$cel": "type", "value": "null" })),
        (
            "an instant finer than a millisecond",
            CelValue::Timestamp(cel_timestamp(0, 1).unwrap()),
            json!({ "$telo": "google.protobuf.Timestamp", "value": "1970-01-01T00:00:00.000000001Z" }),
        ),
    ]
}

#[test]
fn writes_and_reads_back_every_form() {
    for (name, value, encoded) in written() {
        let answered = encode(&value).unwrap_or_else(|refusal| panic!("{name}: {refusal}"));
        assert_eq!(answered.to_string(), encoded.to_string(), "{name}");
        let again = encode(&decode(&encoded).unwrap_or_else(|refusal| panic!("{name}: {refusal}"))).unwrap();
        assert_eq!(again.to_string(), encoded.to_string(), "{name}");
    }
}

#[test]
fn refuses_to_write_what_is_not_a_conformance_value() {
    for (name, value) in [
        ("a host object of no type", CelValue::Host(CelHostValue::unnamed(Arc::new(())))),
        ("an error value", CelValue::Error(cel_error(CelEvaluationCode::InvalidArgument, "x", None))),
    ] {
        let refused = encode(&value).unwrap_err();
        assert!(refused.starts_with("Cannot write a conformance value"), "{name}: {refused}");
    }
}

#[test]
fn refuses_to_read_a_node_that_is_not_canonical() {
    for (name, node) in [
        ("a tagged map whose keys are plain", json!({ "$telo": "map", "value": [["a", 1]] })),
        ("a plain map out of key order", json!({ "b": 1, "a": 2 })),
    ] {
        let refused = decode(&node).unwrap_err();
        assert!(refused.starts_with("Cannot read a conformance value"), "{name}: {refused}");
    }
}
