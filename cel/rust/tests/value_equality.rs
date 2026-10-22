//! Equality and ordering — `cel_equal` and `cel_compare`, the one comparison that
//! `==`, `!=`, `<`, `<=`, `>`, `>=`, `in` over a list and a list index read.
//!
//! Every expected answer is what Node's `celEqual` and `celCompare` answered, executed
//! — `@telorun/cel 0.120.1 at b4a2b6e9`. Node exports both and no Node test calls them
//! directly; evaluation reaches them through the operators.

mod value_support;

use std::cmp::Ordering::{self, Equal, Greater, Less};

use telorun_cel::{cel_compare, cel_equal, CelValue};

use value_support::*;

/// `(left, right, Node's celEqual, Node's celCompare)`.
fn node_answers() -> Vec<(CelValue, CelValue, bool, Option<Ordering>)> {
    vec![
        (i(1), i(1), true, Some(Equal)),
        (i(1), i(2), false, Some(Less)),
        (i(1), u(1), true, Some(Equal)),
        (u(1), i(1), true, Some(Equal)),
        (i(1), d(1.0), true, Some(Equal)),
        (d(1.0), i(1), true, Some(Equal)),
        (u(1), d(1.0), true, Some(Equal)),
        (i(-1), u(1), false, Some(Less)),
        (i(-1), d(-1.0), true, Some(Equal)),
        (i(9223372036854775807), d(9223372036854776000.0), true, Some(Equal)),
        (i(9223372036854775807), d(9223372036854776000.0), true, Some(Equal)),
        (i(i64::MIN), d(-9223372036854776000.0), true, Some(Equal)),
        (i(i64::MIN), d(-9223372036854778000.0), false, Some(Greater)),
        (u(18446744073709551615), d(18446744073709552000.0), true, Some(Equal)),
        (u(18446744073709551615), d(18446744073709552000.0), true, Some(Equal)),
        (u(0), d(-0.5), false, Some(Greater)),
        (u(0), d(-0.0), true, Some(Equal)),
        (i(9007199254740993), d(9007199254740992.0), true, Some(Equal)),
        (d(0.0), d(-0.0), true, Some(Equal)),
        (d(f64::NAN), d(f64::NAN), false, None),
        (d(f64::NAN), i(1), false, None),
        (i(1), d(f64::NAN), false, None),
        (d(f64::INFINITY), d(f64::INFINITY), true, Some(Equal)),
        (d(f64::NEG_INFINITY), i(i64::MIN), false, Some(Less)),
        (d(f64::INFINITY), u(18446744073709551615), false, Some(Greater)),
        (d(1.5), i(1), false, Some(Greater)),
        (d(2.0), d(1.5), false, Some(Greater)),
        (s("a"), s("a"), true, Some(Equal)),
        (s("a"), s("b"), false, Some(Less)),
        (s("b"), s("a"), false, Some(Greater)),
        (s(""), s("a"), false, Some(Less)),
        (s("￿"), s("😀"), false, Some(Greater)),
        (s("😀"), s("￿"), false, Some(Less)),
        (s("a"), i(1), false, None),
        (b(true), b(true), true, Some(Equal)),
        (b(true), b(false), false, Some(Greater)),
        (b(false), b(true), false, Some(Less)),
        (b(true), i(1), false, None),
        (null(), null(), true, None),
        (null(), b(false), false, None),
        (null(), i(0), false, None),
        (null(), s(""), false, None),
        (null(), l(vec![]), false, None),
        (b(false), null(), false, None),
        (by(&[1, 2]), by(&[1, 2]), true, Some(Equal)),
        (by(&[1]), by(&[1, 0]), false, Some(Less)),
        (by(&[2]), by(&[1, 0]), false, Some(Greater)),
        (by(&[]), s(""), false, None),
        (ts(0, 0), ts(0, 0), true, Some(Equal)),
        (ts(0, 0), ts(0, 1), false, Some(Less)),
        (ts(0, 0), du(0, 0), false, None),
        (du(0, 1), du(0, 1), true, Some(Equal)),
        (du(0, -1), du(0, 1), false, Some(Less)),
        (du(0, 0), i(0), false, None),
        (ty("int"), ty("int"), true, None),
        (ty("int"), ty("uint"), false, None),
        (ty("int"), s("int"), false, None),
        (l(vec![i(1), i(2)]), l(vec![i(1), i(2)]), true, None),
        (l(vec![i(1), i(2)]), l(vec![d(1.0), u(2)]), true, None),
        (l(vec![i(1)]), l(vec![i(1), i(2)]), false, None),
        (l(vec![i(1), i(2)]), l(vec![i(2), i(1)]), false, None),
        (l(vec![d(f64::NAN)]), l(vec![d(f64::NAN)]), false, None),
        (l(vec![l(vec![i(1)])]), l(vec![l(vec![d(1.0)])]), true, None),
        (l(vec![]), l(vec![]), true, None),
        (l(vec![i(1)]), l(vec![i(1)]), true, None),
        (m(vec![(i(1), s("a"))]), m(vec![(i(1), s("a"))]), true, None),
        (m(vec![(i(1), s("a"))]), m(vec![(u(1), s("a"))]), true, None),
        (m(vec![(i(1), s("a")), (i(2), s("b"))]), m(vec![(i(2), s("b")), (i(1), s("a"))]), true, None),
        (m(vec![(i(1), s("a"))]), m(vec![(i(1), s("b"))]), false, None),
        (m(vec![(i(1), s("a"))]), m(vec![(s("1"), s("a"))]), false, None),
        (m(vec![]), m(vec![]), true, None),
        (m(vec![(s("a"), i(1))]), rec(vec![("a", d(1.0))]), true, None),
        (rec(vec![("a", i(1)), ("b", i(2))]), rec(vec![("b", i(2)), ("a", i(1))]), true, None),
        (rec(vec![("a", i(1))]), rec(vec![("a", i(1)), ("b", i(2))]), false, None),
        (rec(vec![]), m(vec![]), true, None),
        (rec(vec![("a", l(vec![i(1)]))]), rec(vec![("a", l(vec![d(1.0)]))]), true, None),
        (m(vec![(i(1), i(1))]), l(vec![i(1)]), false, None),
        (some(i(1)), some(d(1.0)), true, None),
        (some(i(1)), none(), false, None),
        (none(), none(), true, None),
        (some(null()), none(), false, None),
        (some(d(f64::NAN)), some(d(f64::NAN)), false, None),
        (some(some(i(1))), some(some(u(1))), true, None),
    ]
}

#[test]
fn compares_and_orders_every_pair_as_node_does() {
    for (left, right, equal, order) in node_answers() {
        assert_eq!(cel_equal(&left, &right), equal, "{left:?} == {right:?}");
        assert_eq!(cel_compare(&left, &right), order, "{left:?} <=> {right:?}");
    }
}

/// The engine's own property: lists, maps and optionals of any depth are compared on a
/// heap list, so a comparison a hundred thousand levels deep runs on a 256 KiB stack.
#[test]
fn compares_values_of_any_depth_on_a_small_stack() {
    let deep = |leaf: CelValue| (0..100_000).fold(leaf, |held, at| match at % 3 {
        0 => l(vec![held]),
        1 => m(vec![(i(1), held)]),
        _ => some(held),
    });
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            let (left, right, other) = (deep(i(1)), deep(d(1.0)), deep(i(2)));
            assert!(cel_equal(&left, &right));
            assert!(!cel_equal(&left, &other));
            assert_eq!(cel_compare(&left, &right), None);
        })
        .unwrap()
        .join()
        .unwrap();
}
