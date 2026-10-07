//! What identifies an entry of a map — the value-level twin of
//! `cel/nodejs/tests/map-key-identity.test.ts`.
//!
//! Node asks through expressions (`{1: 'int'}[1u]`); here the same questions are asked
//! of `cel_map_from_entries` and of a lookup by `map_key_identity`, which is what such
//! an index evaluates to. Its comprehension and `parseJson` cases, and the comparison
//! of a record against a map, are the engine's and are twinned there.
//!
//! Every expected value, code and message is the Node build's answer, executed.

use telorun_cel_value::{
    cel_error, cel_map_from_entries, cel_map_keys, cel_none, cel_timestamp, cel_type_value,
    map_key_identity, CelEvaluationCode, CelMap, CelMapKey, CelRecord, CelValue,
};

use CelValue::{Bool, Double, Int, Uint};

fn text(value: &str) -> CelValue {
    CelValue::String(value.into())
}

fn map(entries: impl IntoIterator<Item = (CelValue, CelValue)>) -> CelMap {
    cel_map_from_entries(entries).unwrap()
}

/// What `map[key]` reads: the entry the key's identity names, if the key has one.
fn read<'a>(map: &'a CelMap, key: &CelValue) -> Option<&'a CelValue> {
    map_key_identity(key).and_then(|identity| map.get(&identity))
}

fn refusal(entries: impl IntoIterator<Item = (CelValue, CelValue)>) -> (&'static str, String) {
    let error = cel_map_from_entries(entries).unwrap_err();
    assert_eq!(error.range, None);
    (error.code.as_str(), error.message)
}

/// `{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}`
fn mixed() -> CelMap {
    map([(text("1"), text("text")), (Int(1), text("int")), (Uint(2), text("uint")), (Bool(true), text("bool"))])
}

#[test]
fn holds_cels_four_key_types_in_one_container_each_a_key_of_its_own() {
    let mixed = mixed();
    assert_eq!(mixed.len(), 4);
    assert_eq!(cel_map_keys(&mixed), [text("1"), Int(1), Uint(2), Bool(true)]);
    for (key, expected) in [
        (text("1"), "text"),
        (Int(1), "int"),
        (Uint(2), "uint"),
        (Bool(true), "bool"),
        // The numeric types are ONE key, reached by any of the three spellings.
        (Uint(1), "int"),
        (Double(1.0), "int"),
        (Int(2), "uint"),
        (Double(2.0), "uint"),
    ] {
        assert_eq!(read(&mixed, &key), Some(&text(expected)), "{key:?}");
    }
    for absent in [text("2"), text("true"), Bool(false), Int(3)] {
        assert_eq!(read(&mixed, &absent), None, "{absent:?}");
    }
    // A string key is never the numeric one, whichever way round it is asked.
    assert_eq!(read(&map([(text("1"), text("text"))]), &Int(1)), None);
    assert_eq!(read(&map([(Int(1), text("int"))]), &text("1")), None);
    assert_eq!(read(&map([(Bool(true), Int(1))]), &text("true")), None);
    assert_eq!(read(&map([(text("true"), Int(1))]), &Bool(true)), None);
}

#[test]
fn identifies_a_key_by_its_own_typed_value() {
    assert_eq!(map_key_identity(&text("1")), Some(CelMapKey::String("1".into())));
    assert_eq!(map_key_identity(&Bool(false)), Some(CelMapKey::Bool(false)));
    assert_eq!(map_key_identity(&Int(i64::MIN)), Some(CelMapKey::Integer(-9223372036854775808)));
    assert_eq!(map_key_identity(&Uint(u64::MAX)), Some(CelMapKey::Integer(18446744073709551615)));
    assert_eq!(map_key_identity(&Double(-0.0)), Some(CelMapKey::Integer(0)));
    assert_eq!(map_key_identity(&Double(18446744073709551616.0)), Some(CelMapKey::Integer(18446744073709551616)));
    for nothing in [
        Double(1.5),
        Double(3.1),
        Double(f64::NAN),
        Double(f64::INFINITY),
        CelValue::Null,
        CelValue::List(vec![Int(1)]),
        CelValue::Bytes(vec![1]),
        CelValue::Record(CelRecord::from_iter([("a", Int(1))])),
        CelValue::Map(CelMap::default()),
        CelValue::Timestamp(cel_timestamp(0, 0).unwrap()),
        CelValue::Type(cel_type_value("int")),
        CelValue::Optional(cel_none()),
    ] {
        assert_eq!(map_key_identity(&nothing), None, "{nothing:?}");
    }
    // Node answers the exact integer of a whole double of any size, which no entry
    // holds. Past 128 bits the identity here is the widest integer, which no entry
    // holds either — so both engines answer a missing key, never an unusable one.
    for beyond in [1e300, -1e300] {
        let identity = map_key_identity(&Double(beyond)).expect("a whole double has an identity");
        assert!(!map([(Int(i64::MAX), Int(1)), (Int(i64::MIN), Int(1)), (Uint(u64::MAX), Int(1))]).contains_key(&identity));
    }
}

#[test]
fn refuses_a_key_of_a_type_no_map_is_keyed_by_even_a_whole_double() {
    for key in [
        Double(1.5),
        Double(1.0),
        CelValue::List(vec![Int(1)]),
        CelValue::Map(map([(text("a"), Int(1))])),
        CelValue::Record(CelRecord::from_iter([("a", Int(1))])),
        CelValue::Null,
        CelValue::Bytes(vec![1]),
        CelValue::Timestamp(cel_timestamp(0, 0).unwrap()),
        CelValue::Type(cel_type_value("int")),
    ] {
        assert_eq!(
            refusal([(key.clone(), text("x"))]),
            ("unsupported_key_type", "a map is keyed by an int, a uint, a bool or a string".into()),
            "{key:?}"
        );
    }
}

#[test]
fn refuses_two_keys_cel_equality_makes_one_naming_the_key_written_twice() {
    let twice = |first: CelValue, second: CelValue| refusal([(first, text("a")), (second, text("b"))]);
    for (first, second, named) in [
        (Int(1), Uint(1), "the key 1u is written twice"),
        (Uint(1), Int(1), "the key 1 is written twice"),
        (text("k"), text("k"), "the key \"k\" is written twice"),
        (Bool(true), Bool(true), "the key true is written twice"),
        (Int(1), Int(1), "the key 1 is written twice"),
        (Bool(false), Bool(false), "the key false is written twice"),
        (Int(-5), Int(-5), "the key -5 is written twice"),
        (text("a\"b\n"), text("a\"b\n"), "the key \"a\\\"b\\n\" is written twice"),
        (Uint(u64::MAX), Uint(u64::MAX), "the key 18446744073709551615u is written twice"),
    ] {
        assert_eq!(twice(first, second), ("duplicate_map_key", named.into()), "{named}");
    }
}

#[test]
fn answers_an_error_valued_entry_as_the_error_the_key_first_the_first_entry_first() {
    let key = || CelValue::from(cel_error(CelEvaluationCode::NoSuchKey, "the key", None));
    let value = |message: &str| CelValue::from(cel_error(CelEvaluationCode::DivisionByZero, message, None));
    assert_eq!(refusal([(key(), value("the value"))]), ("no_such_key", "the key".into()));
    assert_eq!(refusal([(text("a"), value("the value"))]), ("division_by_zero", "the value".into()));
    assert_eq!(
        refusal([(text("a"), value("first value")), (key(), Int(1))]),
        ("division_by_zero", "first value".into())
    );
    assert_eq!(
        refusal([(text("a"), Int(1)), (text("b"), value("the value")), (text("a"), Int(2))]),
        ("division_by_zero", "the value".into())
    );
    assert_eq!(
        refusal([(text("a"), Int(1)), (text("a"), Int(2)), (text("b"), value("the value"))]),
        ("duplicate_map_key", "the key \"a\" is written twice".into())
    );
    // An entry's own error outranks what is wrong with its key.
    assert_eq!(refusal([(Double(1.5), value("the value"))]), ("division_by_zero", "the value".into()));
    assert!(cel_map_from_entries([]).unwrap().is_empty());
}

#[test]
fn keeps_a_key_that_names_a_prototype_member_as_data() {
    for key in ["__proto__", "constructor", "prototype", "toString", "valueOf"] {
        let holding = map([(text(key), Int(7))]);
        assert_eq!(read(&holding, &text(key)), Some(&Int(7)), "{key}");
        assert_eq!(holding.len(), 1, "{key}");
        assert_eq!(read(&map([(text("a"), Int(1))]), &text(key)), None, "{key}");
    }
}

#[test]
fn lists_the_keys_as_the_values_they_are_in_insertion_order() {
    assert_eq!(cel_map_keys(&map([(Int(1), text("a")), (Uint(2), text("b"))])), [Int(1), Uint(2)]);
    let keys = [text("b"), text("a"), Int(10), Int(9), Bool(true)];
    let built = map(keys.clone().map(|key| (key, Int(0))));
    assert_eq!(cel_map_keys(&built), keys);
    assert_eq!(built.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>(), keys);
    assert_eq!(built.into_iter().map(|(key, _)| key).collect::<Vec<_>>(), keys);
    // The key is held as it was written, so an int key reads back as an int.
    assert_eq!(mixed_entry(&Uint(1)), Some((Int(1), text("int"))));
}

fn mixed_entry(key: &CelValue) -> Option<(CelValue, CelValue)> {
    let mixed = mixed();
    let identity = map_key_identity(key)?;
    mixed.entry(&identity).map(|(key, value)| (key.clone(), value.clone()))
}
