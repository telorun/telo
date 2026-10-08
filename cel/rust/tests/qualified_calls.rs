//! The qualified-call query — the twin of `cel/nodejs/tests/qualified-calls.test.ts`,
//! case for case.
//!
//! Every row is the Node build's answer, executed: `@telorun/cel` 0.112.0 at
//! `d265cc79`. Where a Node case asserts only the qualified names, the row here holds
//! every field of every call Node answered.
//!
//! Past the twin: calls in every position of a larger expression, and ranges in a
//! source with characters outside ASCII and one left incomplete.

mod support;

use support::*;
use telorun_cel::{parse_expression, qualified_calls, QualifiedCall};

/// `(source, the set it is read under, every call Node answers, in its order)`.
type NodeCalls = (&'static str, &'static [&'static str], Vec<QualifiedCall>);

fn assert_calls_as_node(rows: Vec<NodeCalls>) {
    assert!(!rows.is_empty(), "the table holds no row");
    for (source, namespaces, calls) in rows {
        let expression = parse_expression(source, &expression_options(namespaces, false)).expect(source);
        assert_eq!(qualified_calls(&expression.root), calls, "{source}");
    }
}

#[test]
fn answers_every_namespaced_call_in_source_order_with_its_range() {
    assert_calls_as_node(vec![
        ("Self.a(Shop.b()) + c.d()", &["Self", "Shop"], vec![qualified("Self", "a", "Self.a", 1, (0, 16), (5, 6)), qualified("Shop", "b", "Shop.b", 0, (7, 15), (12, 13))]),
    ]);
}

#[test]
fn answers_a_call_whose_name_is_a_macros_which_the_set_makes_a_namespaced_call() {
    assert_calls_as_node(vec![
        ("Shop.map(x, x)", &["Shop"], vec![qualified("Shop", "map", "Shop.map", 2, (0, 14), (5, 8))]),
    ]);
}

#[test]
fn answers_nothing_for_a_tree_resolved_under_no_namespace() {
    let rows: Vec<NodeCalls> = vec![
        ("Shop.map(x, x)", &[], vec![]),
    ];
    assert!(rows.iter().all(|(_, _, calls)| calls.is_empty()));
    assert_calls_as_node(rows);
}

// --- past the twin -------------------------------------------------------------------

#[test]
fn answers_a_call_before_any_call_written_inside_it_wherever_they_stand() {
    assert_calls_as_node(vec![
        ("[Shop.a(1, 2, 3)].map(i, {Shop.b(): Shop.c(Shop.d()).e}) ? Shop.f()[Shop.g()] : -Shop.h()", &["Shop"], vec![qualified("Shop", "a", "Shop.a", 3, (1, 16), (6, 7)), qualified("Shop", "b", "Shop.b", 0, (26, 34), (31, 32)), qualified("Shop", "c", "Shop.c", 1, (36, 52), (41, 42)), qualified("Shop", "d", "Shop.d", 0, (43, 51), (48, 49)), qualified("Shop", "f", "Shop.f", 0, (59, 67), (64, 65)), qualified("Shop", "g", "Shop.g", 0, (68, 76), (73, 74)), qualified("Shop", "h", "Shop.h", 0, (81, 89), (86, 87))]),
        ("\u{1f600} + Shop.a()", &["Shop"], vec![]),
        ("'\u{e9}\u{1f600}'.f(Shop.a('\u{1f600}'), Shop.b(", &["Shop"], vec![qualified("Shop", "a", "Shop.a", 1, (8, 20), (13, 14)), qualified("Shop", "b", "Shop.b", 1, (22, 29), (27, 28))]),
    ]);
}
