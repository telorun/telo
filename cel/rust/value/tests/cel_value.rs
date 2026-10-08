//! What a value is — the value-level twin of `cel/nodejs/tests/cel-value.test.ts`.
//!
//! The two "foreign-built" cases of that file have no Rust subject: they prove a value
//! another copy of the engine built is recognised by its key alone, and here the
//! variant is the identity.
//!
//! The cases past the twin — every type name, the code list, a record's order, the
//! union's identity and its bounds — are pinned by no Node test of their own. Every
//! literal a Node answer could decide is the Node build's answer, executed.

use std::fmt::Debug;
use std::hash::Hash;
use std::sync::Arc;

use telorun_cel_value::{
    cel_duration_from_nanos, cel_error, cel_map_from_entries, cel_none, cel_some, cel_timestamp,
    cel_type_name_of, cel_type_value, CelDuration, CelError, CelEvaluationCode, CelHostValue,
    CelMap, CelRecord, CelTimestamp, CelValue, ReservedTypeName, SourceRange, CEL_EVALUATION_CODES,
    CEL_VALUE_KEYS,
};

fn text(value: &str) -> CelValue {
    CelValue::String(value.into())
}

fn host(name: &str) -> Result<CelHostValue, ReservedTypeName> {
    CelHostValue::named(name, Arc::new(5i64))
}

#[test]
fn reads_a_record_carrying_a_look_alike_brand_key_as_data() {
    let forged = CelRecord::from_iter([("telo.cel.value", text("uint")), ("value", text("7"))]);
    assert_eq!(forged.get("telo.cel.value"), Some(&text("uint")));
    assert_eq!(cel_type_name_of(&CelValue::Record(forged)), Some("map"));
}

#[test]
fn refuses_a_host_type_named_as_one_of_the_domains_own_keys() {
    const NODE_KEYS: [&str; 7] = [
        "uint",
        "google.protobuf.Timestamp",
        "google.protobuf.Duration",
        "type",
        "optional",
        "map",
        "error",
    ];
    assert_eq!(CEL_VALUE_KEYS, NODE_KEYS);
    for key in CEL_VALUE_KEYS {
        let refused = host(key).expect_err(key);
        assert_eq!(refused.name(), key);
        let raised: Box<dyn std::error::Error> = Box::new(refused);
        assert_eq!(
            raised.to_string(),
            format!("\"{key}\" is a type key the CEL value domain's own values carry, so no host type may be named it")
        );
    }
}

#[test]
fn answers_the_type_name_of_every_kind_of_value() {
    const NODE_NAMES: &[(&str, Option<&str>)] = &[
        ("null", Some("null_type")),
        ("bool", Some("bool")),
        ("string", Some("string")),
        ("double", Some("double")),
        ("int", Some("int")),
        ("bytes", Some("bytes")),
        ("list", Some("list")),
        ("record", Some("map")),
        ("look-alike record", Some("map")),
        ("map", Some("map")),
        ("uint", Some("uint")),
        ("timestamp", Some("google.protobuf.Timestamp")),
        ("duration", Some("google.protobuf.Duration")),
        ("type", Some("type")),
        ("none", Some("optional")),
        ("some", Some("optional")),
        ("error", None),
        ("host Money", Some("Money")),
    ];
    for (label, expected) in NODE_NAMES {
        let value = match *label {
            "null" => CelValue::Null,
            "bool" => CelValue::Bool(true),
            "string" => text("s"),
            "double" => CelValue::Double(1.5),
            "int" => CelValue::Int(1),
            "bytes" => CelValue::Bytes(vec![1]),
            "list" => CelValue::List(vec![CelValue::Int(1)]),
            "record" => CelValue::Record(CelRecord::from_iter([("a", CelValue::Int(1))])),
            "look-alike record" => {
                CelValue::Record(CelRecord::from_iter([("telo.cel.value", text("uint")), ("value", text("7"))]))
            }
            "map" => CelValue::Map(cel_map_from_entries([(CelValue::Int(1), text("a"))]).unwrap()),
            "uint" => CelValue::Uint(1),
            "timestamp" => CelValue::Timestamp(cel_timestamp(0, 0).unwrap()),
            "duration" => CelValue::Duration(cel_duration_from_nanos(0).unwrap()),
            "type" => CelValue::Type(cel_type_value("int")),
            "none" => CelValue::Optional(cel_none()),
            "some" => CelValue::Optional(cel_some(CelValue::Int(1))),
            "error" => cel_error(CelEvaluationCode::NoSuchKey, "missing", None).into(),
            "host Money" => CelValue::Host(host("Money").unwrap()),
            other => panic!("no value for the row {other}"),
        };
        assert_eq!(cel_type_name_of(&value), *expected, "{label}");
    }
    // A host object of no CEL type has no Node row: Node holds one as a class instance.
    assert_eq!(cel_type_name_of(&CelValue::Host(CelHostValue::unnamed(Arc::new(())))), None);
}

#[test]
fn lists_the_evaluation_codes_as_every_engine_writes_them() {
    const NODE_CODES: [&str; 16] = [
        "no_such_key",
        "no_such_variable",
        "index_out_of_range",
        "no_matching_overload",
        "unsupported_container",
        "unsupported_key_type",
        "duplicate_map_key",
        "numeric_overflow",
        "division_by_zero",
        "modulo_by_zero",
        "invalid_conversion",
        "invalid_argument",
        "invalid_regular_expression",
        "optional_value_missing",
        "unbound_function",
        "async_value_unsupported",
    ];
    assert_eq!(CEL_EVALUATION_CODES.map(|code| code.as_str()), NODE_CODES);
    assert_eq!(CelEvaluationCode::InvalidConversion.to_string(), "invalid_conversion");
}

#[test]
fn carries_an_error_as_a_value_and_as_a_rust_error() {
    let plain = cel_error(CelEvaluationCode::NoSuchKey, "missing", None);
    assert_eq!(plain.range, None);
    let ranged = plain.clone().with_range(SourceRange { start: 3, end: 9 });
    assert_eq!(ranged, cel_error(CelEvaluationCode::NoSuchKey, "missing", Some(SourceRange { start: 3, end: 9 })));
    assert_ne!(ranged, plain);
    let raised: Box<dyn std::error::Error> = Box::new(ranged.clone());
    assert_eq!(raised.to_string(), "missing");
    assert_eq!(CelValue::from(ranged.clone()), CelValue::Error(ranged));
}

#[test]
fn holds_an_optional_as_nothing_or_one_value() {
    assert!(!cel_none().is_present());
    assert_eq!(cel_none().held(), None);
    assert_eq!(cel_some(CelValue::Int(1)).held(), Some(&CelValue::Int(1)));
    assert_eq!(cel_some(CelValue::Null).into_held(), Some(CelValue::Null));
    assert_ne!(cel_some(CelValue::Null), cel_none());
}

#[test]
fn ranges_a_record_in_ecmascript_own_property_order() {
    // Each row: the keys in the order they were set (each to its position), then what
    // `Object.keys` answers with the value each key holds.
    const NODE_ORDER: &[(&[&str], &[(&str, i64)])] = &[
        (&[], &[]),
        (&["b", "a"], &[("b", 0), ("a", 1)]),
        (&["b", "1", "a", "0"], &[("0", 3), ("1", 1), ("b", 0), ("a", 2)]),
        (&["10", "9", "x"], &[("9", 1), ("10", 0), ("x", 2)]),
        (&["01", "1"], &[("1", 1), ("01", 0)]),
        (&["4294967294", "4294967295", "4294967296", "0"], &[("0", 3), ("4294967294", 0), ("4294967295", 1), ("4294967296", 2)]),
        (&["-0", "0"], &[("0", 1), ("-0", 0)]),
        (&["1.0", "1"], &[("1", 1), ("1.0", 0)]),
        (&["__proto__", "a"], &[("__proto__", 0), ("a", 1)]),
        (&["a", "b", "a"], &[("a", 2), ("b", 1)]),
        (&["2", "1", "2"], &[("1", 1), ("2", 2)]),
        (&["", "+1", " 1", "1e3", "3"], &[("3", 4), ("", 0), ("+1", 1), (" 1", 2), ("1e3", 3)]),
        (&["z", "5", "y", "4294967294", "07", "7"], &[("5", 1), ("7", 5), ("4294967294", 3), ("z", 0), ("y", 2), ("07", 4)]),
        (&["constructor", "toString", "0"], &[("0", 2), ("constructor", 0), ("toString", 1)]),
    ];
    for (inserted, expected) in NODE_ORDER {
        let mut record = CelRecord::new();
        for (at, key) in inserted.iter().enumerate() {
            record.insert(*key, CelValue::Int(at as i64));
        }
        let ranged: Vec<(&str, i64)> = record
            .iter()
            .map(|(key, value)| match value {
                CelValue::Int(held) => (key, *held),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(ranged, *expected, "{inserted:?}");
        assert_eq!(record.len(), expected.len(), "{inserted:?}");
        assert_eq!(record.keys().collect::<Vec<_>>(), expected.iter().map(|(key, _)| *key).collect::<Vec<_>>());
        let owned: Vec<String> = record.clone().into_iter().map(|(key, _)| key).collect();
        assert_eq!(owned, record.keys().collect::<Vec<_>>(), "{inserted:?}");
        for (key, held) in *expected {
            assert_eq!(record.get(key), Some(&CelValue::Int(*held)), "{inserted:?} {key}");
        }
    }
    let mut record = CelRecord::new();
    assert_eq!(record.insert("7", CelValue::Null), None);
    assert_eq!(record.insert("7", CelValue::Int(1)), Some(CelValue::Null));
    assert!(record.contains_key("7") && !record.contains_key("07") && !record.is_empty());
}

fn map(entries: impl IntoIterator<Item = (CelValue, CelValue)>) -> CelMap {
    cel_map_from_entries(entries).unwrap()
}

/// The decided rule, not a Node answer: Node has no identity comparison of its own —
/// its `==` is CEL's, which is the engine's.
#[test]
fn compares_two_values_by_identity_in_the_domain_never_by_cel_equality() {
    use CelValue::*;
    assert_eq!(Double(f64::NAN), Double(f64::NAN));
    assert_ne!(Double(0.0), Double(-0.0));
    assert_ne!(Int(1), Uint(1));
    assert_ne!(Int(1), Double(1.0));
    assert_ne!(Null, Bool(false));
    assert_eq!(List(vec![Int(1), text("a")]), List(vec![Int(1), text("a")]));
    assert_ne!(Bytes(vec![97]), text("a"));

    // A map is its pairs, in any order; a key is the value it is.
    let forward = map([(Int(1), text("a")), (text("k"), Bool(true))]);
    let backward = map([(text("k"), Bool(true)), (Int(1), text("a"))]);
    assert_eq!(Map(forward.clone()), Map(backward));
    assert_ne!(Map(forward.clone()), Map(map([(Uint(1), text("a")), (text("k"), Bool(true))])));
    assert_ne!(Map(forward.clone()), Map(map([(Int(1), text("a"))])));
    assert_ne!(Map(forward), Map(map([(Int(1), text("b")), (text("k"), Bool(true))])));

    // A map whose keys are all strings and a record of the same pairs are one value.
    let record = CelRecord::from_iter([("b", Int(2)), ("a", Int(1))]);
    let keyed = map([(text("a"), Int(1)), (text("b"), Int(2))]);
    assert_eq!(Record(record.clone()), Record(CelRecord::from_iter([("a", Int(1)), ("b", Int(2))])));
    assert_eq!(Map(keyed.clone()), Record(record.clone()));
    assert_eq!(Record(record.clone()), Map(keyed));
    assert_ne!(Record(record.clone()), Map(map([(text("a"), Int(1)), (text("b"), Int(3))])));
    assert_ne!(Record(CelRecord::from_iter([("1", Int(1))])), Map(map([(Int(1), Int(1))])));
    assert_ne!(Record(record), Record(CelRecord::from_iter([("a", Int(1))])));

    assert_eq!(Type(cel_type_value("int")), Type(cel_type_value("int")));
    assert_ne!(Type(cel_type_value("int")), Type(cel_type_value("uint")));
    assert_eq!(Optional(cel_some(Double(f64::NAN))), Optional(cel_some(Double(f64::NAN))));

    // Two host values are one value only when they are the same object.
    let payload: Arc<dyn std::any::Any + Send + Sync> = Arc::new(5i64);
    let money = CelHostValue::named("Money", payload.clone()).unwrap();
    assert_eq!(Host(money.clone()), Host(CelHostValue::named("Money", payload.clone()).unwrap()));
    assert_ne!(Host(money.clone()), Host(host("Money").unwrap()));
    assert_ne!(Host(money.clone()), Host(CelHostValue::unnamed(payload)));
    assert_eq!(money.payload().downcast_ref::<i64>(), Some(&5));
}

// Chosen for a type that is `Eq` by neither impl below, and by both for one that is.
trait LacksEq<Witness> {
    fn proven() {}
}
impl<T: ?Sized> LacksEq<()> for T {}
impl<T: ?Sized + Eq> LacksEq<u8> for T {}

trait LacksHash<Witness> {
    fn proven() {}
}
impl<T: ?Sized> LacksHash<()> for T {}
impl<T: ?Sized + Hash> LacksHash<u8> for T {}

#[test]
fn gives_the_union_and_its_scalars_the_bounds_their_holders_rely_on() {
    fn scalar<T: Clone + Copy + PartialEq + Eq + PartialOrd + Ord + Hash + Debug>() {}
    fn shared<T: Send + Sync>() {}
    fn union<T: Clone + Debug + PartialEq>() {}
    scalar::<CelTimestamp>();
    scalar::<CelDuration>();
    shared::<CelHostValue>();
    shared::<CelValue>();
    shared::<CelError>();
    union::<CelValue>();
    // Each line compiles only while exactly one impl applies: the union is not `Eq`
    // (a double is in it) and not `Hash`.
    <CelValue as LacksEq<_>>::proven();
    <CelValue as LacksHash<_>>::proven();
}
