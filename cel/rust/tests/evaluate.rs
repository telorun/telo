//! Evaluation: the rules that hold wherever an expression is run — the twin of
//! `cel/nodejs/tests/evaluate.test.ts`, less its four cases about a value that must be
//! awaited, which no Rust value can be (one test below says what stands in their place),
//! and less the millisecond clock, a function of the value domain twinned in
//! `cel/rust/value/tests/evaluate.rs`.
//!
//! Every expected answer is what Node's `CelEnvironment.evaluate` answered, executed —
//! `@telorun/cel 0.120.1 at b4a2b6e9` — written by `evaluation_support::answer`, except
//! the interim reading named where it is asserted.

mod evaluation_support;
mod value_support;

use evaluation_support::{answer, bindings, evaluate, language, loose, source_answer};
use telorun_cel::{
    CelEnvironment, CelEnvironmentOptions, CelEvaluateError, CelEvaluationCode, CelValue, EvaluateOptions,
    BINDING_FORMS,
};
use value_support::{du, i, l, rec, s, some};

/// Each source evaluated in the language environment, against no names, to Node's answer.
fn rows(rows: &[(&str, &str)]) {
    let environment = language();
    for (source, expected) in rows {
        assert_eq!(source_answer(&environment, source, &()), *expected, "{source}");
    }
}

#[test]
fn makes_an_int64_overflow_an_error_rather_than_a_wrap() {
    rows(&[
        ("9223372036854775807 - 1", "value int 9223372036854775806"),
        ("9223372036854775807 + 1", "error numeric_overflow [0, 23] integer overflow: 9223372036854775808"),
        ("-9223372036854775808 - 1", "error numeric_overflow [0, 24] integer overflow: -9223372036854775809"),
        ("0u - 1u", "error numeric_overflow [0, 7] unsigned integer overflow: -1"),
        ("int(1e99)", "error numeric_overflow [0, 9] integer overflow: 1e+99"),
    ]);
}

#[test]
fn names_division_and_modulus_by_zero_apart_and_leaves_a_double_to_ieee() {
    rows(&[
        ("1 / 0", "error division_by_zero [0, 5] division by zero"),
        ("1 % 0", "error modulo_by_zero [0, 5] modulus by zero"),
        ("1u / 0u", "error division_by_zero [0, 7] division by zero"),
        ("1.0 / 0.0", "value double +Inf"),
    ]);
}

#[test]
fn carries_an_error_through_a_short_circuit_from_either_side() {
    rows(&[
        ("false && {'a': 1}.b == 1", "value bool false"),
        ("{'a': 1}.b == 1 && false", "value bool false"),
        ("true || {'a': 1}.b == 1", "value bool true"),
        ("{'a': 1}.b == 1 || true", "value bool true"),
        ("true && {'a': 1}.b == 1", "error no_such_key [8, 18] no such key: \"b\""),
    ]);
}

#[test]
fn converts_a_duration_to_an_int_which_no_conformance_row_pins() {
    // Truncated toward zero, as every conversion to an integer is.
    rows(&[
        ("int(duration('90s'))", "value int 90"),
        ("int(duration('1h30m'))", "value int 5400"),
        ("int(duration('-1.75s'))", "value int -1"),
        ("int(duration('0.5s'))", "value int 0"),
    ]);
}

#[test]
fn compares_across_the_numeric_types_by_converting_lossily_as_cel_spec_does() {
    // The int becomes a double and the two doubles are equal; outside the integer type's
    // range the sign decides; NaN orders with nothing.
    rows(&[
        ("dyn(9223372036854775807) < 9223372036854775808.0", "value bool false"),
        ("dyn(9223372036854775807) == 9223372036854775808.0", "value bool true"),
        ("dyn(1) < 1e308", "value bool true"),
        ("dyn(1) > -1e308", "value bool true"),
        ("dyn(1u) > -1.0", "value bool true"),
        ("dyn(1) < 0.0/0.0", "value bool false"),
        ("dyn(1) > 0.0/0.0", "value bool false"),
        ("dyn(1) == 1.0", "value bool true"),
        ("dyn(1) == 1u", "value bool true"),
        ("dyn(2) < 3u", "value bool true"),
    ]);
}

#[test]
fn refuses_a_double_at_or_beyond_either_int64_extreme_which_is_the_same_rule() {
    rows(&[
        ("int(9223372036854775807.0)", "error numeric_overflow [0, 26] integer overflow: 9223372036854776000"),
        ("int(-9223372036854775808.0)", "error numeric_overflow [0, 27] integer overflow: -9223372036854776000"),
        ("int(9223372036854775808.0)", "error numeric_overflow [0, 26] integer overflow: 9223372036854776000"),
        ("int(-9223372036854775809.0)", "error numeric_overflow [0, 27] integer overflow: -9223372036854776000"),
        ("int(9223372036854774784.0)", "value int 9223372036854774784"),
        ("int(-9223372036854774784.0)", "value int -9223372036854774784"),
    ]);
}

#[test]
fn answers_the_compatibility_members_as_their_own_declarations_say() {
    // Indices are UTF-16 code units, while `size` is CEL's own and counts characters.
    rows(&[
        ("'TacoCÆt'.lowerAscii()", "value string \"tacocæt\""),
        ("'tacoCαt'.upperAscii()", "value string \"TACOCΑT\""),
        ("'a😀b'.indexOf('b')", "value int 3"),
        ("'a😀b'.substring(1, 3)", "value string \"😀\""),
        ("size('a😀b')", "value int 3"),
    ]);
}

#[test]
fn matches_on_re2_and_refuses_a_pattern_re2_does_not_read() {
    rows(&[
        ("'abc'.matches('b')", "value bool true"),
        ("'abc'.matches('^a.c$')", "value bool true"),
        ("'aa'.matches('(a)\\\\1')", "error invalid_regular_expression [0, 22] \"(a)\\\\1\" is not an RE2 pattern: error parsing regexp: invalid escape sequence: `\\1`"),
        ("'abc'.matches('(')", "error invalid_regular_expression [0, 18] \"(\" is not an RE2 pattern: error parsing regexp: missing closing ): `(`"),
    ]);
}

#[test]
fn reads_a_field_of_an_instant_in_a_zone_named_or_written_as_an_offset() {
    rows(&[
        ("timestamp('2009-02-13T23:31:30Z').getHours()", "value int 23"),
        ("timestamp('2009-02-13T23:31:30Z').getHours('02:00')", "value int 1"),
        ("timestamp('2009-02-13T23:31:30Z').getHours('-08:00')", "value int 15"),
        ("timestamp('2009-02-13T23:31:30Z').getFullYear('Australia/Sydney')", "value int 2009"),
        ("timestamp('2009-02-13T23:31:30Z').getDayOfMonth('Australia/Sydney')", "value int 13"),
        ("timestamp('2009-02-13T23:31:30Z').getHours('Mars/Olympus')", "error invalid_argument [0, 58] \"Mars/Olympus\" is not a time zone"),
    ]);
}

#[test]
fn evaluates_every_comprehension_macro_and_cel_bind() {
    // A decided answer wins over an error, as it does in `&&`.
    rows(&[
        ("[1, 2, 3].all(i, i > 0)", "value bool true"),
        ("[1, 2, 3].exists(i, i == 2)", "value bool true"),
        ("[1, 2, 3].exists_one(i, i == 2)", "value bool true"),
        ("[1, 2, 3].filter(i, i > 1)", "value list(int 2, int 3)"),
        ("[1, 2, 3].map(i, i * 2)", "value list(int 2, int 4, int 6)"),
        ("[1, 2, 3].map(i, i > 1, i * 2)", "value list(int 4, int 6)"),
        ("{'a': 1, 'b': 2}.map(k, k)", "value list(string \"a\", string \"b\")"),
        ("cel.bind(x, 2, x * x)", "value int 4"),
        ("[1, 'two'].exists(i, i == 1)", "value bool true"),
    ]);
}

#[test]
fn keeps_a_uint_an_int_and_a_double_apart_while_computing_across_them() {
    rows(&[
        ("1u + 1u", "value uint 2"),
        ("type(1u) == uint", "value bool true"),
        ("dyn(1) == 1u", "value bool true"),
        ("dyn(1.0) == 1", "value bool true"),
        ("dyn(1) + 1u", "error no_matching_overload [0, 11] no overload of \"+\" takes (int, uint)"),
    ]);
}

#[test]
fn throws_at_the_top_of_an_evaluation_carrying_the_code_and_the_range() {
    let failed = language().evaluate("1 + 9223372036854775807", &(), &EvaluateOptions::default());
    let Err(CelEvaluateError::Evaluation(error)) = failed else { panic!("it answered: {failed:?}") };
    assert_eq!(error.code, CelEvaluationCode::NumericOverflow);
    assert_eq!((error.range.unwrap().start, error.range.unwrap().end), (0, 23));
}

#[test]
fn holds_a_duration_to_the_int64_range_of_its_total_nanoseconds_at_every_point_one_is_built() {
    // The conversion, duration arithmetic both ways, and the span between two instants.
    rows(&[
        ("duration('320000000000s')", "error invalid_conversion [0, 25] duration out of range"),
        ("duration('9223372036s') + duration('1s')", "error invalid_conversion [0, 40] duration out of range"),
        ("duration('-9223372036s') - duration('1s')", "error invalid_conversion [0, 41] duration out of range"),
        (
            "timestamp('9999-12-31T23:59:59Z') - timestamp('0001-01-01T00:00:00Z')",
            "error invalid_conversion [0, 69] duration out of range",
        ),
    ]);
    // And the duration operand of timestamp arithmetic, which a host can hand over from the
    // wider range the typed frame carries.
    let wide = bindings(vec![("span", du(200000000000, 0))]);
    let environment = language();
    for (source, expected) in [
        ("timestamp('2009-02-13T23:31:30Z') + span", "error invalid_conversion [0, 40] duration out of range"),
        ("span + timestamp('2009-02-13T23:31:30Z')", "error invalid_conversion [0, 40] duration out of range"),
        ("timestamp('2009-02-13T23:31:30Z') - span", "error invalid_conversion [0, 40] duration out of range"),
    ] {
        assert_eq!(source_answer(&environment, source, &wide), expected, "{source}");
    }
}

#[test]
fn searches_the_activation_for_an_undeclared_dotted_chain_longest_prefix_first() {
    // Nothing is declared, so the activation decides at evaluation.
    let environment = language();
    for (activation, expected) in [
        (bindings(vec![("a.b.c", s("the variable"))]), "the variable"),
        (bindings(vec![("a.b", rec(vec![("c", s("the entry"))]))]), "the entry"),
        (bindings(vec![("a", rec(vec![("b", rec(vec![("c", s("the nested entry"))]))]))]), "the nested entry"),
        (bindings(vec![("a.b.c", s("the variable")), ("a.b", rec(vec![("c", s("the entry"))]))]), "the variable"),
    ] {
        assert_eq!(evaluate(&environment, "a.b.c", &activation), s(expected));
    }
}

#[test]
fn splits_a_declared_dotted_chain_where_the_declaration_says_and_reads_that_one_name() {
    let declaring = |name: &str, ty: &str| {
        let mut environment = loose();
        environment.register_variable(name, ty, None).unwrap();
        environment
    };
    // The longest declared prefix wins, and the checker typed the same split.
    assert_eq!(
        evaluate(&declaring("a.b.c", "string"), "a.b.c", &bindings(vec![("a.b.c", s("the variable"))])),
        s("the variable")
    );
    assert_eq!(
        evaluate(&declaring("a.b", "map<string, string>"), "a.b.c", &bindings(vec![("a.b", rec(vec![("c", s("the entry"))]))])),
        s("the entry")
    );
    // A declared name the activation does not hold fails for THAT name — never by falling
    // back to a shorter prefix.
    assert_eq!(
        source_answer(&declaring("a.b.c", "string"), "a.b.c", &bindings(vec![("a.b", rec(vec![("c", s("the entry"))]))])),
        "error no_such_variable [0, 5] no such variable: a.b.c"
    );
}

#[test]
fn re_resolves_a_dotted_chain_when_a_name_is_declared_after_it_was_first_compiled() {
    let activation = bindings(vec![("a.b", rec(vec![("c", i(99))])), ("a", rec(vec![("b", rec(vec![("c", i(1))]))]))]);
    let mut environment = loose();
    assert_eq!(evaluate(&environment, "a.b.c", &activation), i(99));
    environment.register_variable("a", "map<string, dyn>", None).unwrap();
    assert_eq!(evaluate(&environment, "a.b.c", &activation), i(1));
}

#[test]
fn reads_an_absolute_name_against_the_activation_past_a_name_a_comprehension_bound() {
    let environment = language();
    let activation = bindings(vec![("y", s("outer"))]);
    assert_eq!(evaluate(&environment, "['compre'].exists(y, .y == 'outer')", &activation), CelValue::Bool(true));
    assert_eq!(evaluate(&environment, "['compre'].exists(y, y == 'compre')", &activation), CelValue::Bool(true));
    assert_eq!(evaluate(&environment, "['compre'].exists(y, .y == 'compre')", &activation), CelValue::Bool(false));
}

#[test]
fn compiles_to_one_program_per_source_text_and_forgets_the_oldest_past_its_capacity() {
    let held = CelEnvironment::new(CelEnvironmentOptions {
        compiled_cache_capacity: 2.try_into().unwrap(),
        ..Default::default()
    });
    let first = held.compile("1 + 1").unwrap();
    assert!(std::sync::Arc::ptr_eq(&held.compile("1 + 1").unwrap(), &first));
    held.compile("2 + 2").unwrap();
    held.compile("3 + 3").unwrap();
    assert!(!std::sync::Arc::ptr_eq(&held.compile("1 + 1").unwrap(), &first));
}

// --- Node readings this crate meets at evaluation --------------------------------

/// Node refuses a value that must be awaited at seven doors — an activation read, an
/// implementation's answer, a member read, an element entering a comprehension, a
/// `cel.bind` value, an optional's held value, list membership — and at the top. No Rust
/// value can be awaited, so no door here refuses anything: each form answers the value
/// Node answers when the host hands it plain values.
#[test]
fn has_no_door_for_a_value_that_must_be_awaited() {
    let probes = [
        ("all/2", "xs.all(e, true)", "value bool true"),
        ("exists/2", "xs.exists(e, false)", "value bool false"),
        ("exists_one/2", "xs.exists_one(e, true)", "value bool false"),
        ("filter/2", "xs.filter(e, true)", "value list(int 1, int 2)"),
        ("map/2", "xs.map(e, e)", "value list(int 1, int 2)"),
        ("map/3", "xs.map(e, true, e)", "value list(int 1, int 2)"),
        ("optMap/2", "opt.optMap(v, v)", "value optional(int 1)"),
        ("optFlatMap/2", "opt.optFlatMap(v, optional.of(v))", "value optional(int 1)"),
        ("cel.bind/3", "cel.bind(v, held.a, 1)", "value int 1"),
    ];
    let mut forms: Vec<&str> = probes.iter().map(|(form, _, _)| *form).collect();
    forms.sort();
    let mut declared = BINDING_FORMS.to_vec();
    declared.sort();
    assert_eq!(forms, declared);
    let plain = bindings(vec![("xs", l(vec![i(1), i(2)])), ("held", rec(vec![("a", i(1))])), ("opt", some(i(1)))]);
    let environment = language();
    for (form, source, expected) in probes {
        assert_eq!(source_answer(&environment, source, &plain), expected, "{form}");
    }
    for (source, expected) in [
        ("1 in xs", "value bool true"),
        ("[held.a]", "value list(int 1)"),
        ("{'k': held.a}", "value map(string \"k\": int 1)"),
    ] {
        assert_eq!(source_answer(&environment, source, &plain), expected, "{source}");
    }
}

/// Node's reading, reproduced and reported: `optional.none` compiles whatever it is handed
/// and reads none of it, while `optional.of` refuses the wrong arity at compile.
#[test]
fn optional_none_ignores_its_arguments() {
    rows(&[("optional.none(1 / 0)", "value optional()"), ("optional.none(nothing.at.all, 1)", "value optional()")]);
}

/// An interim wording: Node names what a comprehension's test answered by JavaScript's
/// `typeof` — `bigint`, `string`, `object` — and this crate in CEL's terms.
#[test]
fn names_a_comprehension_test_that_answered_no_bool_in_cel_terms() {
    // Node: "… and it answered bigint", "string", "object", "object", "object", "bigint".
    rows(&[
        ("[1].all(x, 1)", "error no_matching_overload [0, 13] a comprehension's test must answer a bool, and it answered a value of type int"),
        ("[1].exists(x, 'a')", "error no_matching_overload [0, 18] a comprehension's test must answer a bool, and it answered a value of type string"),
        ("[1].exists_one(x, null)", "error no_matching_overload [0, 23] a comprehension's test must answer a bool, and it answered null"),
        ("[1].filter(x, [x])", "error no_matching_overload [0, 18] a comprehension's test must answer a bool, and it answered a list"),
        ("[1].map(x, {}, x)", "error no_matching_overload [0, 17] a comprehension's test must answer a bool, and it answered a map"),
        ("[1, 2].all(x, x)", "error no_matching_overload [0, 16] a comprehension's test must answer a bool, and it answered a value of type int"),
    ]);
}

/// A difference: Node looks the namespace a macro is written on up as a key of a plain
/// object, so `constructor.foo()` throws a `TypeError` out of `compile`
/// (`on.includes is not a function`). Here it is an ordinary call on a receiver named
/// `constructor`, which the activation does not hold.
#[test]
fn compiles_a_call_on_a_receiver_named_constructor_as_an_ordinary_call() {
    rows(&[("constructor.foo()", "error no_such_variable [0, 11] no such variable: constructor")]);
    let answered = loose().evaluate("constructor.foo()", &bindings(vec![("constructor", s("x"))]), &EvaluateOptions::default());
    assert_eq!(answer(answered), "error no_matching_overload [0, 17] no overload of \"foo\" takes (string)");
}
