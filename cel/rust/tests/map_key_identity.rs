//! What identifies an entry of a map, and that the ways a map is built agree about it —
//! the twin of `cel/nodejs/tests/map-key-identity.test.ts`, less its `parseJson` case,
//! which is the function catalog's.
//!
//! One container holds int, uint, bool and string keys; `1`, `1u` and `1.0` are one key and
//! a string `"1"` another; a key is never a property name, so a prototype member's name
//! round-trips as data; a double that is not whole names no entry, and no map is built
//! with one. Every expected answer is what Node's `CelEnvironment.evaluate` answered,
//! executed — `@telorun/cel 0.120.1 at b4a2b6e9`.

mod evaluation_support;
mod value_support;

use evaluation_support::{bindings, source_answer};
use telorun_cel::{CelEnvironment, CelEnvironmentOptions};
use value_support::{i, rec};

fn base() -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions { unlisted_variables_are_dyn: true, ..Default::default() })
}

fn rows(rows: &[(&str, &str)]) {
    let environment = base();
    for (source, expected) in rows {
        assert_eq!(source_answer(&environment, source, &()), *expected, "{source}");
    }
}

#[test]
fn holds_cels_four_key_types_in_one_container_each_a_key_of_its_own() {
    // The numeric types are ONE key, reached by any of the three spellings, and a string
    // key is never the numeric one, whichever way round it is asked.
    rows(&[
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}", "value map(string \"1\": string \"text\", int 1: string \"int\", uint 2: string \"uint\", bool true: string \"bool\")"),
        ("size({'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'})", "value int 4"),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}['1']", "value string \"text\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[1]", "value string \"int\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[2u]", "value string \"uint\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[true]", "value string \"bool\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[1u]", "value string \"int\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[1.0]", "value string \"int\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[2]", "value string \"uint\""),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}[2.0]", "value string \"uint\""),
        ("{'1': 'text'}[1]", "error no_such_key [0, 16] no such key: 1"),
        ("{1: 'int'}['1']", "error no_such_key [0, 15] no such key: \"1\""),
        ("{true: 1}['true']", "error no_such_key [0, 17] no such key: \"true\""),
        ("{'true': 1}[true]", "error no_such_key [0, 17] no such key: true"),
    ]);
}

#[test]
fn refuses_a_key_of_a_type_no_map_is_keyed_by_and_a_double_that_is_not_whole() {
    // A whole double still LOOKS one up, while a double that is not whole is a mistake in
    // the read rather than an absent entry.
    rows(&[
        ("{1.5: 'x'}", "error unsupported_key_type [0, 10] a map is keyed by an int, a uint, a bool or a string"),
        ("{[1]: 'x'}", "error unsupported_key_type [0, 10] a map is keyed by an int, a uint, a bool or a string"),
        ("{{'a': 1}: 'x'}", "error unsupported_key_type [0, 15] a map is keyed by an int, a uint, a bool or a string"),
        ("{1: 'x'}[?1.0]", "value optional(string \"x\")"),
        ("{1: 'x'}[?3.1]", "error unsupported_key_type [0, 14] 3.1 cannot name an entry of this value"),
        ("{1: 'x'}[?2]", "value optional()"),
    ]);
}

#[test]
fn refuses_two_keys_cel_equality_makes_one_naming_the_key_written_twice() {
    rows(&[
        ("{1: 'a', 1u: 'b'}", "error duplicate_map_key [0, 17] the key 1u is written twice"),
        ("{1u: 'a', 1: 'b'}", "error duplicate_map_key [0, 17] the key 1 is written twice"),
        ("{'k': 1, 'k': 2}", "error duplicate_map_key [0, 16] the key \"k\" is written twice"),
        ("{true: 1, true: 2}", "error duplicate_map_key [0, 18] the key true is written twice"),
    ]);
}

#[test]
fn keeps_a_key_that_names_a_prototype_member_as_data_in_every_form_of_read() {
    rows(&[
        ("{'__proto__': 7}['__proto__']", "value int 7"),
        ("{'__proto__': 7}.`__proto__`", "value int 7"),
        ("size({'__proto__': 7})", "value int 1"),
        ("'__proto__' in {'__proto__': 7}", "value bool true"),
        ("{'a': 1}['__proto__']", "error no_such_key [0, 21] no such key: \"__proto__\""),
        ("'__proto__' in {'a': 1}", "value bool false"),
        ("{'constructor': 7}['constructor']", "value int 7"),
        ("{'constructor': 7}.`constructor`", "value int 7"),
        ("size({'constructor': 7})", "value int 1"),
        ("'constructor' in {'constructor': 7}", "value bool true"),
        ("{'a': 1}['constructor']", "error no_such_key [0, 23] no such key: \"constructor\""),
        ("'constructor' in {'a': 1}", "value bool false"),
        ("{'prototype': 7}['prototype']", "value int 7"),
        ("{'prototype': 7}.`prototype`", "value int 7"),
        ("size({'prototype': 7})", "value int 1"),
        ("'prototype' in {'prototype': 7}", "value bool true"),
        ("{'a': 1}['prototype']", "error no_such_key [0, 21] no such key: \"prototype\""),
        ("'prototype' in {'a': 1}", "value bool false"),
        ("{'toString': 7}['toString']", "value int 7"),
        ("{'toString': 7}.`toString`", "value int 7"),
        ("size({'toString': 7})", "value int 1"),
        ("'toString' in {'toString': 7}", "value bool true"),
        ("{'a': 1}['toString']", "error no_such_key [0, 20] no such key: \"toString\""),
        ("'toString' in {'a': 1}", "value bool false"),
        ("{'valueOf': 7}['valueOf']", "value int 7"),
        ("{'valueOf': 7}.`valueOf`", "value int 7"),
        ("size({'valueOf': 7})", "value int 1"),
        ("'valueOf' in {'valueOf': 7}", "value bool true"),
        ("{'a': 1}['valueOf']", "error no_such_key [0, 19] no such key: \"valueOf\""),
        ("'valueOf' in {'a': 1}", "value bool false"),
    ]);
}

#[test]
fn answers_the_same_questions_for_a_map_a_comprehension_ranged_over_or_built() {
    // A comprehension ranges over the keys, which come back as the values they are.
    rows(&[
        ("size({'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}.map(k, k))", "value int 4"),
        ("{1: 'a', 2u: 'b'}.map(k, k).size()", "value int 2"),
        ("{1: 'a', 2u: 'b'}.map(k, {1: 'a', 2u: 'b'}[k])", "value list(string \"a\", string \"b\")"),
        ("{1: [1, 2].map(e, e * 2)}[1u]", "value list(int 2, int 4)"),
        ("{'1': 'text', 1: 'int'}.map(k, k).size()", "value int 2"),
        ("{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}.map(k, k)", "value list(string \"1\", int 1, uint 2, bool true)"),
    ]);
}

#[test]
fn compares_a_map_against_a_record_by_key_identity_across_the_two_representations() {
    let mut environment = base();
    environment.register_variable("record", "dyn", None).unwrap();
    let record = bindings(vec![("record", rec(vec![("a", i(1)), ("1", i(2))]))]);
    for (source, expected) in [
        ("record == {'a': 1, '1': 2}", "value bool true"),
        ("record == {'a': 1, 1: 2}", "value bool false"),
        ("record", "value record(1: int 2, a: int 1)"),
    ] {
        assert_eq!(source_answer(&environment, source, &record), expected, "{source}");
    }
}
