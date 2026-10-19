//! Twin of `cel/nodejs/tests/standard-library.test.ts`, case for case: what the library
//! declares, held to cel-spec.
//!
//! Every expected value is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`.

mod check_support;

use check_support::{environment, first_code, schema, type_of, unlisted_dyn};
use telorun_cel::CelCheckCode::{self, *};
use telorun_cel::{CelEnvironment, CelEnvironmentOptions};

fn language() -> CelEnvironment {
    environment(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        ..Default::default()
    })
}

fn typed(source: &str) -> String {
    type_of(&language(), source)
}

fn refusal(source: &str) -> CelCheckCode {
    first_code(&language().check(source)).unwrap_or_else(|| panic!("{source} is refused"))
}

#[test]
fn the_conversions_convert_between_every_pair_cel_spec_declares_the_identities_included() {
    assert_eq!(
        [
            typed("int(42u)"),
            typed("int(timestamp('2004-09-16T23:59:59Z'))"),
            typed("int(duration('100s'))"),
            typed("string(timestamp('2004-09-16T23:59:59Z'))"),
            typed("string(duration('100s'))"),
            typed("duration(duration('100s'))"),
            typed("timestamp(timestamp(1000000000))"),
        ],
        ["int", "int", "int", "string", "string", "google.protobuf.Duration", "google.protobuf.Timestamp"]
    );
}

#[test]
fn comparison_orders_every_scalar_type_bytes_included() {
    for source in [
        "1 < 2",
        "1u < 2u",
        "1.0 < 2.0",
        "false < true",
        "'a' < 'b'",
        "b'a' < b'b'",
        "timestamp(1) < timestamp(2)",
        "duration('1s') < duration('2s')",
    ] {
        assert_eq!(typed(source), "bool", "{source}");
    }
    assert_eq!(typed("b'a' >= b'b'"), "bool");
}

#[test]
fn comparison_orders_across_the_numeric_types_and_tests_equality_only_within_one() {
    assert_eq!(typed("1 < 2u"), "bool");
    assert_eq!(typed("1.0 >= 2"), "bool");
    // cel-spec's checker is strict about equality: its own suite writes dyn(1) == 2u.
    assert_eq!(refusal("1.0 == 1"), TypeError);
    assert_eq!(refusal("2u != 2"), TypeError);
    assert_eq!(typed("dyn(1.0) == 1"), "bool");
}

#[test]
fn comparison_compares_a_list_and_a_map_for_equality_and_does_not_order_them() {
    assert_eq!(typed("[1] == [1]"), "bool");
    assert_eq!(typed("{'a': 1} != {'a': 2}"), "bool");
    assert_eq!(refusal("[1] < [2]"), TypeError);
}

#[test]
fn list_concatenation_answers_the_one_element_type_both_sides_hold_and_refuses_two_that_share_none() {
    assert_eq!(typed("[1, 2] + []"), "list<int>");
    assert_eq!(typed("[] + [3, 4]"), "list<int>");
    assert_eq!(typed("[] + []"), "list");
    assert_eq!(typed("[1] + dyn([2])"), "list<int>");
    assert_eq!(refusal("[1] + ['a']"), TypeError);
}

#[test]
fn the_optional_library_enters_whole() {
    assert_eq!(
        [
            typed("optional.of(1)"),
            typed("optional.none()"),
            typed("optional.ofNonZeroValue(42)"),
            typed("optional.of(1).optMap(y, y + 1)"),
            typed("optional.of(1).optMap(y, string(y))"),
            typed("{'k': {'s': 'v'}}.?k.optFlatMap(k, k.?s)"),
            typed("optional.of(1) == optional.of(2)"),
            typed("optional.none() != optional.of(1)"),
            typed("type(optional.none()) == optional_type"),
        ],
        [
            "optional<int>",
            "optional<dyn>",
            "optional<int>",
            "optional<int>",
            "optional<string>",
            "optional<string>",
            "bool",
            "bool",
            "bool",
        ]
    );
}

#[test]
fn the_optional_library_takes_an_optional_from_opt_flat_map_and_nothing_else() {
    assert_eq!(refusal("optional.of(1).optFlatMap(y, y + 1)"), TypeError);
    assert_eq!(refusal("1.optMap(y, y)"), TypeError);
}

#[test]
fn the_optional_library_has_none_of_it_where_the_option_is_off() {
    let off = environment(unlisted_dyn());
    for source in ["optional.of(1)", "optional.ofNonZeroValue(1)", "optional.of(1).optMap(y, y)"] {
        assert_eq!(first_code(&off.check(source)), Some(UnknownFunction), "{source}");
    }
    // The type name goes with them, so a site that declares everything legal refuses it.
    assert_eq!(first_code(&CelEnvironment::default().check("optional_type")), Some(UnknownIdentifier));
    let on = environment(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    assert_eq!(on.check("optional_type").type_name, "type");
}

#[test]
fn the_optional_syntax_holds_an_optional_in_an_entry_and_contributes_what_it_holds() {
    assert_eq!(typed("[?optional.of(1)]"), "list<int>");
    assert_eq!(typed("[?optional.of(1), 2]"), "list<int>");
    assert_eq!(typed("{?'k': optional.of('v')}"), "map<string, string>");
    assert_eq!(typed("{?'k': optional.of('v'), 'j': 'w'}"), "map<string, string>");
    assert_eq!(typed("[?{}.?c, ?optional.of(42)]"), "list<int>");
    assert_eq!(typed("has({?'foo': optional.none()}.foo)"), "bool");
}

#[test]
fn the_optional_syntax_refuses_an_entry_written_with_a_question_mark_that_holds_something_else() {
    assert_eq!(refusal("[?1]"), TypeError);
    assert_eq!(refusal("{?'k': 'v'}"), TypeError);
}

#[test]
fn a_member_read_against_a_schema_reaches_a_key_no_identifier_can_spell() {
    let mut environment = CelEnvironment::default();
    environment
        .register_variable(
            "request",
            schema(
                r#"{"type":"object","properties":{"headers":{"type":"object","properties":{"content-type":{"type":"string"},"content-length":{"type":"integer"}}}}}"#,
            ),
            None,
        )
        .unwrap();
    assert_eq!(environment.check("request.headers.`content-type`").type_name, "string");
    assert_eq!(environment.check("request.headers.`content-length`").type_name, "int");
    let typo = &environment.check("request.headers.`content-typo`").diagnostics[0];
    assert_eq!((typo.code, typo.range.start, typo.range.end), (UnknownField, 16, 30));
    assert_eq!(typed("{'a-b': 1}.`a-b`"), "int");
}

#[test]
fn has_asks_about_a_member_of_anything_whose_last_step_is_a_select() {
    assert_eq!(typed("has({'a': 1}.a)"), "bool");
    assert_eq!(typed("has({}.a)"), "bool");
    assert_eq!(typed("has(a.b.c)"), "bool");
    assert_eq!(typed("has(optional.of({'c': 1}).c)"), "bool");
    assert_eq!(typed("has({'x': {'y': 1}}.?x.y)"), "bool");
    // What it still refuses is an argument that is not a member read at all.
    assert_eq!(refusal("has(1)"), InvalidArgument);
    assert_eq!(refusal("has(a)"), InvalidArgument);
    assert_eq!(refusal("has(a[0])"), InvalidArgument);
}

#[test]
fn an_unconstrained_type_variable_behaves_as_dyn_wherever_it_is_used() {
    assert_eq!(typed("([].map(x, x))[0].foo"), "dyn");
    assert_eq!(typed("[].map(x, x.map(y, y))"), "list<list<dyn>>");
    assert_eq!(typed("[].map(i, i.map(j, j > 1))"), "list<list<bool>>");
    assert_eq!(typed("optional.none().?anything.hasValue()"), "bool");
    assert_eq!(typed("optional.none()[?0].hasValue()"), "bool");
    assert_eq!(typed("{}.?absent.deeper.hasValue()"), "bool");
    // And the type reported for one is `dyn` too; a parameter survives only where it is
    // declared.
    assert_eq!(typed("[]"), "list");
    assert_eq!(typed("{}"), "map");
    assert!(CelEnvironment::default().definitions().functions.iter().any(|held| held.signature.contains("list<A>")));
}
