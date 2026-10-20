//! The member-read seam, function by function: `cel_lookup`, `cel_read`, `cel_has`,
//! `lookup_absence`, `lookup_error` and `cel_iterable`, over every kind of container and
//! key, and a host's named type read through the fields it declares.
//!
//! Every expected verdict, value and error is what Node's `celLookup`, `celRead`,
//! `celHas`, `lookupAbsence` and `celIterable` answered, executed —
//! `@telorun/cel 0.120.1 at b4a2b6e9` — except the named readings below, each naming
//! Node's answer. The twin of `member-read.test.ts`, which evaluates expressions,
//! arrives with evaluation.

mod value_support;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use telorun_cel::{
    cel_has, cel_iterable, cel_lookup, cel_read, lookup_absence, lookup_error, CelHostValue, CelValue, HostFields,
    Lookup, PropertyMap,
};

use value_support::*;

fn found(value: CelValue) -> Lookup<'static> {
    Lookup::Found(Box::leak(Box::new(value)))
}

/// `(container, key, Node's lookup, Node's read, Node's has)`, about the range `[3, 9)`.
fn node_answers() -> Vec<(CelValue, CelValue, Lookup<'static>, CelValue, CelValue)> {
    vec![
        (l(vec![i(10), i(20), i(30)]), i(0), found(i(10)), i(10), b(true)),
        (l(vec![i(10), i(20), i(30)]), i(2), found(i(30)), i(30), b(true)),
        (l(vec![i(10), i(20), i(30)]), i(3), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 3"), b(false)),
        (l(vec![i(10), i(20), i(30)]), i(-1), Lookup::OutOfRange, err("index_out_of_range", "index out of range: -1"), b(false)),
        (l(vec![i(10), i(20), i(30)]), u(1), found(i(20)), i(20), b(true)),
        (l(vec![i(10), i(20), i(30)]), d(1.0), found(i(20)), i(20), b(true)),
        (l(vec![i(10), i(20), i(30)]), d(1.5), Lookup::UnsupportedKey, err("unsupported_key_type", "1.5 cannot name an entry of this value"), err("unsupported_key_type", "1.5 cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), d(-0.0), found(i(10)), i(10), b(true)),
        (l(vec![i(10), i(20), i(30)]), d(1e300), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 1e+300"), b(false)),
        (l(vec![i(10), i(20), i(30)]), d(f64::NAN), Lookup::UnsupportedKey, err("unsupported_key_type", "NaN cannot name an entry of this value"), err("unsupported_key_type", "NaN cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), d(f64::INFINITY), Lookup::UnsupportedKey, err("unsupported_key_type", "Infinity cannot name an entry of this value"), err("unsupported_key_type", "Infinity cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), s("a"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"a\" cannot name an entry of this value"), err("unsupported_key_type", "\"a\" cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), s("1"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"1\" cannot name an entry of this value"), err("unsupported_key_type", "\"1\" cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), s("k"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"k\" cannot name an entry of this value"), err("unsupported_key_type", "\"k\" cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), s("__proto__"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"__proto__\" cannot name an entry of this value"), err("unsupported_key_type", "\"__proto__\" cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), s("constructor"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"constructor\" cannot name an entry of this value"), err("unsupported_key_type", "\"constructor\" cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), s("length"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"length\" cannot name an entry of this value"), err("unsupported_key_type", "\"length\" cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), b(true), Lookup::UnsupportedKey, err("unsupported_key_type", "true cannot name an entry of this value"), err("unsupported_key_type", "true cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), b(false), Lookup::UnsupportedKey, err("unsupported_key_type", "false cannot name an entry of this value"), err("unsupported_key_type", "false cannot name an entry of this value")),
        (l(vec![i(10), i(20), i(30)]), null(), Lookup::UnsupportedKey, err("unsupported_key_type", "null cannot name an entry of this value"), err("unsupported_key_type", "null cannot name an entry of this value")),
        (l(vec![]), i(0), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 0"), b(false)),
        (l(vec![]), i(2), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 2"), b(false)),
        (l(vec![]), i(3), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 3"), b(false)),
        (l(vec![]), i(-1), Lookup::OutOfRange, err("index_out_of_range", "index out of range: -1"), b(false)),
        (l(vec![]), u(1), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 1"), b(false)),
        (l(vec![]), d(1.0), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 1"), b(false)),
        (l(vec![]), d(1.5), Lookup::UnsupportedKey, err("unsupported_key_type", "1.5 cannot name an entry of this value"), err("unsupported_key_type", "1.5 cannot name an entry of this value")),
        (l(vec![]), d(-0.0), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 0"), b(false)),
        (l(vec![]), d(1e300), Lookup::OutOfRange, err("index_out_of_range", "index out of range: 1e+300"), b(false)),
        (l(vec![]), d(f64::NAN), Lookup::UnsupportedKey, err("unsupported_key_type", "NaN cannot name an entry of this value"), err("unsupported_key_type", "NaN cannot name an entry of this value")),
        (l(vec![]), d(f64::INFINITY), Lookup::UnsupportedKey, err("unsupported_key_type", "Infinity cannot name an entry of this value"), err("unsupported_key_type", "Infinity cannot name an entry of this value")),
        (l(vec![]), s("a"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"a\" cannot name an entry of this value"), err("unsupported_key_type", "\"a\" cannot name an entry of this value")),
        (l(vec![]), s("1"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"1\" cannot name an entry of this value"), err("unsupported_key_type", "\"1\" cannot name an entry of this value")),
        (l(vec![]), s("k"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"k\" cannot name an entry of this value"), err("unsupported_key_type", "\"k\" cannot name an entry of this value")),
        (l(vec![]), s("__proto__"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"__proto__\" cannot name an entry of this value"), err("unsupported_key_type", "\"__proto__\" cannot name an entry of this value")),
        (l(vec![]), s("constructor"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"constructor\" cannot name an entry of this value"), err("unsupported_key_type", "\"constructor\" cannot name an entry of this value")),
        (l(vec![]), s("length"), Lookup::UnsupportedKey, err("unsupported_key_type", "\"length\" cannot name an entry of this value"), err("unsupported_key_type", "\"length\" cannot name an entry of this value")),
        (l(vec![]), b(true), Lookup::UnsupportedKey, err("unsupported_key_type", "true cannot name an entry of this value"), err("unsupported_key_type", "true cannot name an entry of this value")),
        (l(vec![]), b(false), Lookup::UnsupportedKey, err("unsupported_key_type", "false cannot name an entry of this value"), err("unsupported_key_type", "false cannot name an entry of this value")),
        (l(vec![]), null(), Lookup::UnsupportedKey, err("unsupported_key_type", "null cannot name an entry of this value"), err("unsupported_key_type", "null cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), i(0), Lookup::UnsupportedKey, err("unsupported_key_type", "0 cannot name an entry of this value"), err("unsupported_key_type", "0 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), i(2), Lookup::UnsupportedKey, err("unsupported_key_type", "2 cannot name an entry of this value"), err("unsupported_key_type", "2 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), i(3), Lookup::UnsupportedKey, err("unsupported_key_type", "3 cannot name an entry of this value"), err("unsupported_key_type", "3 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), i(-1), Lookup::UnsupportedKey, err("unsupported_key_type", "-1 cannot name an entry of this value"), err("unsupported_key_type", "-1 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), u(1), Lookup::UnsupportedKey, err("unsupported_key_type", "1 cannot name an entry of this value"), err("unsupported_key_type", "1 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), d(1.0), Lookup::UnsupportedKey, err("unsupported_key_type", "1 cannot name an entry of this value"), err("unsupported_key_type", "1 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), d(1.5), Lookup::UnsupportedKey, err("unsupported_key_type", "1.5 cannot name an entry of this value"), err("unsupported_key_type", "1.5 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), d(-0.0), Lookup::UnsupportedKey, err("unsupported_key_type", "0 cannot name an entry of this value"), err("unsupported_key_type", "0 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), d(1e300), Lookup::UnsupportedKey, err("unsupported_key_type", "1e+300 cannot name an entry of this value"), err("unsupported_key_type", "1e+300 cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), d(f64::NAN), Lookup::UnsupportedKey, err("unsupported_key_type", "NaN cannot name an entry of this value"), err("unsupported_key_type", "NaN cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), d(f64::INFINITY), Lookup::UnsupportedKey, err("unsupported_key_type", "Infinity cannot name an entry of this value"), err("unsupported_key_type", "Infinity cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), s("a"), found(i(1)), i(1), b(true)),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), s("1"), found(i(2)), i(2), b(true)),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), s("k"), Lookup::Missing, err("no_such_key", "no such key: \"k\""), b(false)),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), s("__proto__"), found(i(3)), i(3), b(true)),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), s("constructor"), Lookup::Missing, err("no_such_key", "no such key: \"constructor\""), b(false)),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), s("length"), Lookup::Missing, err("no_such_key", "no such key: \"length\""), b(false)),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), b(true), Lookup::UnsupportedKey, err("unsupported_key_type", "true cannot name an entry of this value"), err("unsupported_key_type", "true cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), b(false), Lookup::UnsupportedKey, err("unsupported_key_type", "false cannot name an entry of this value"), err("unsupported_key_type", "false cannot name an entry of this value")),
        (rec(vec![("1", i(2)), ("a", i(1)), ("__proto__", i(3))]), null(), Lookup::UnsupportedKey, err("unsupported_key_type", "null cannot name an entry of this value"), err("unsupported_key_type", "null cannot name an entry of this value")),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), i(0), Lookup::Missing, err("no_such_key", "no such key: 0"), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), i(2), found(s("uint")), s("uint"), b(true)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), i(3), Lookup::Missing, err("no_such_key", "no such key: 3"), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), i(-1), Lookup::Missing, err("no_such_key", "no such key: -1"), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), u(1), found(s("int")), s("int"), b(true)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), d(1.0), found(s("int")), s("int"), b(true)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), d(1.5), Lookup::UnsupportedKey, err("unsupported_key_type", "1.5 cannot name an entry of this value"), err("unsupported_key_type", "1.5 cannot name an entry of this value")),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), d(-0.0), Lookup::Missing, err("no_such_key", "no such key: 0"), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), d(1e300), Lookup::Missing, err("no_such_key", "no such key: 1e+300"), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), d(f64::NAN), Lookup::UnsupportedKey, err("unsupported_key_type", "NaN cannot name an entry of this value"), err("unsupported_key_type", "NaN cannot name an entry of this value")),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), d(f64::INFINITY), Lookup::UnsupportedKey, err("unsupported_key_type", "Infinity cannot name an entry of this value"), err("unsupported_key_type", "Infinity cannot name an entry of this value")),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), s("a"), Lookup::Missing, err("no_such_key", "no such key: \"a\""), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), s("1"), Lookup::Missing, err("no_such_key", "no such key: \"1\""), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), s("k"), found(s("text")), s("text"), b(true)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), s("__proto__"), Lookup::Missing, err("no_such_key", "no such key: \"__proto__\""), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), s("constructor"), Lookup::Missing, err("no_such_key", "no such key: \"constructor\""), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), s("length"), Lookup::Missing, err("no_such_key", "no such key: \"length\""), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), b(true), found(s("bool")), s("bool"), b(true)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), b(false), Lookup::Missing, err("no_such_key", "no such key: false"), b(false)),
        (m(vec![(i(1), s("int")), (s("k"), s("text")), (b(true), s("bool")), (u(2), s("uint"))]), null(), Lookup::UnsupportedKey, err("unsupported_key_type", "null cannot name an entry of this value"), err("unsupported_key_type", "null cannot name an entry of this value")),
        (s("abc"), i(0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), i(2), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), i(3), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), i(-1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), u(1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), d(1.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), d(1.5), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), d(-0.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), d(1e300), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), d(f64::NAN), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), d(f64::INFINITY), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), s("a"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), s("1"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), s("k"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), s("__proto__"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), s("constructor"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), s("length"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), b(true), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), b(false), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (s("abc"), null(), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), i(0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), i(2), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), i(3), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), i(-1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), u(1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), d(1.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), d(1.5), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), d(-0.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), d(1e300), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), d(f64::NAN), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), d(f64::INFINITY), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), s("a"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), s("1"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), s("k"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), s("__proto__"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), s("constructor"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), s("length"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), b(true), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), b(false), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (i(7), null(), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), i(0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), i(2), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), i(3), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), i(-1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), u(1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), d(1.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), d(1.5), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), d(-0.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), d(1e300), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), d(f64::NAN), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), d(f64::INFINITY), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), s("a"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), s("1"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), s("k"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), s("__proto__"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), s("constructor"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), s("length"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), b(true), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), b(false), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (null(), null(), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), i(0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), i(2), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), i(3), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), i(-1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), u(1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), d(1.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), d(1.5), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), d(-0.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), d(1e300), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), d(f64::NAN), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), d(f64::INFINITY), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), s("a"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), s("1"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), s("k"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), s("__proto__"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), s("constructor"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), s("length"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), b(true), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), b(false), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (some(i(1)), null(), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), i(0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), i(2), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), i(3), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), i(-1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), u(1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), d(1.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), d(1.5), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), d(-0.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), d(1e300), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), d(f64::NAN), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), d(f64::INFINITY), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), s("a"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), s("1"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), s("k"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), s("__proto__"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), s("constructor"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), s("length"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), b(true), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), b(false), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (by(&[1]), null(), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), i(0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), i(2), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), i(3), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), i(-1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), u(1), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), d(1.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), d(1.5), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), d(-0.0), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), d(1e300), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), d(f64::NAN), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), d(f64::INFINITY), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), s("a"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), s("1"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), s("k"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), s("__proto__"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), s("constructor"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), s("length"), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), b(true), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), b(false), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
        (ts(0, 0), null(), Lookup::UnsupportedContainer, err("unsupported_container", "this value holds no members"), b(false)),
    ]
}

#[test]
fn reads_every_container_by_every_key_as_node_does() {
    for (container, key, lookup, read, has) in node_answers() {
        assert_eq!(cel_lookup(&container, &key, None), lookup, "{container:?}[{key:?}]");
        assert_eq!(cel_read(&container, &key, Some(RANGE), None), read, "{container:?}[{key:?}]");
        assert_eq!(cel_has(&container, &key, Some(RANGE), None), has, "has {container:?}[{key:?}]");
    }
}

#[test]
fn answers_absence_by_the_verdict_and_the_form_of_the_read() {
    // Node: `lookupAbsence(found, presence)` for each of the four verdicts.
    for (verdict, presence, plain) in [
        (Lookup::Missing, true, true),
        (Lookup::OutOfRange, true, true),
        (Lookup::UnsupportedContainer, true, false),
        (Lookup::UnsupportedKey, false, false),
    ] {
        assert_eq!(lookup_absence(verdict, true), presence, "{verdict:?}");
        assert_eq!(lookup_absence(verdict, false), plain, "{verdict:?}");
    }
    assert!(!lookup_absence(Lookup::Found(&CelValue::Null), true));
    assert_eq!(
        CelValue::from(lookup_error(Lookup::Missing, &s("k"), None)),
        bare_err("no_such_key", "no such key: \"k\"")
    );
}

#[test]
#[should_panic(expected = "a lookup that found a value is no refusal")]
fn refuses_to_word_an_error_for_a_lookup_that_found_a_value() {
    lookup_error(Lookup::Found(&CelValue::Null), &s("k"), None);
}

/// A list ranges in its own order, a map in insertion order, and a record in
/// ECMAScript's own-property order — what Node's `celIterable` answers.
#[test]
fn ranges_a_record_and_a_map_in_their_own_orders() {
    let ranged = |container: CelValue| cel_iterable(&container, Some(RANGE)).map(|items| l(items.into_owned()));
    assert_eq!(ranged(l(vec![i(1), s("a")])), Ok(l(vec![i(1), s("a")])));
    assert_eq!(
        ranged(rec(vec![("b", i(1)), ("10", i(2)), ("a", i(3)), ("9", i(4))])),
        Ok(l(vec![s("9"), s("10"), s("b"), s("a")]))
    );
    assert_eq!(
        ranged(m(vec![(s("b"), i(1)), (i(2), i(2)), (b(true), i(3)), (u(1), i(4))])),
        Ok(l(vec![s("b"), i(2), b(true), u(1)]))
    );
    for other in [s("abc"), null()] {
        assert_eq!(
            ranged(other).map_err(CelValue::Error),
            Err(err("unsupported_container", "a comprehension reads a list or a map"))
        );
    }
    // A list is handed over as it is, never copied.
    let list = l(vec![i(1), i(2)]);
    let CelValue::List(held) = &list else { unreachable!() };
    assert!(std::ptr::eq(cel_iterable(&list, None).unwrap().as_ptr(), held.as_ptr()));
}

/// Node names a key with JavaScript's `String()`: a list `[1, 2]` as `1,2`, bytes as
/// their numbers, a map or a timestamp as `[object Object]` — and a record makes
/// `String()` throw a `TypeError` out of the read. Here such a key is named in CEL's
/// terms; a string, a number, a bool and null are named as on Node.
#[test]
fn names_a_key_that_is_no_scalar_in_cel_terms() {
    let unusable = |key: CelValue| cel_read(&rec(vec![("a", i(1))]), &key, Some(RANGE), None);
    let named = |what: &str| err("unsupported_key_type", &format!("{what} cannot name an entry of this value"));
    assert_eq!(unusable(l(vec![i(1), i(2)])), named("a list"));
    assert_eq!(unusable(rec(vec![])), named("a map"));
    assert_eq!(unusable(m(vec![(i(1), i(1))])), named("a map"));
    assert_eq!(unusable(by(&[1, 2])), named("a value of type bytes"));
    assert_eq!(unusable(ts(0, 0)), named("a value of type google.protobuf.Timestamp"));
    assert_eq!(unusable(ty("int")), named("a value of type type"));
    assert_eq!(unusable(some(i(1))), named("a value of type optional"));
    assert_eq!(unusable(CelValue::Host(CelHostValue::unnamed(Arc::new(())))), named("a value outside the CEL value domain"));
    // The scalars, as Node names them.
    assert_eq!(unusable(d(1.5)), named("1.5"));
    assert_eq!(unusable(d(f64::INFINITY)), named("Infinity"));
    assert_eq!(unusable(null()), named("null"));
    assert_eq!(unusable(b(true)), named("true"));
}

fn money() -> CelValue {
    let entries: PropertyMap<CelValue> =
        [("amount", i(5)), ("currency", s("EUR")), ("secret", i(1))].into_iter().collect();
    CelValue::Host(CelHostValue::with_entries("Money", Arc::new(()), entries).unwrap())
}

fn money_fields() -> HashMap<String, HashSet<String>> {
    HashMap::from([("Money".to_string(), HashSet::from(["amount".to_string(), "currency".to_string(), "missing".to_string()]))])
}

#[test]
fn reads_a_host_value_only_through_the_fields_its_type_declares() {
    // Node: a value of `Money` holding `amount`, `currency` and `secret`, its type
    // declaring `amount`, `currency` and `missing`.
    let fields = money_fields();
    let fields: Option<&dyn HostFields> = Some(&fields);
    let value = money();
    for (key, lookup, read, has) in [
        (s("amount"), Lookup::Found(&i(5)), i(5), b(true)),
        (s("currency"), Lookup::Found(&s("EUR")), s("EUR"), b(true)),
        (s("missing"), Lookup::Missing, err("no_such_key", "no such key: \"missing\""), b(false)),
        (s("secret"), Lookup::Missing, err("no_such_key", "no such key: \"secret\""), b(false)),
        (s("__proto__"), Lookup::Missing, err("no_such_key", "no such key: \"__proto__\""), b(false)),
        (
            i(1),
            Lookup::UnsupportedKey,
            err("unsupported_key_type", "1 cannot name an entry of this value"),
            err("unsupported_key_type", "1 cannot name an entry of this value"),
        ),
    ] {
        assert_eq!(cel_lookup(&value, &key, fields), lookup, "{key:?}");
        assert_eq!(cel_read(&value, &key, Some(RANGE), fields), read, "{key:?}");
        assert_eq!(cel_has(&value, &key, Some(RANGE), fields), has, "{key:?}");
    }
    // With no field table, or a type that declares none, a host value holds no members.
    assert_eq!(cel_lookup(&value, &s("amount"), None), Lookup::UnsupportedContainer);
    let other = CelValue::Host(CelHostValue::with_entries("Other", Arc::new(()), [("amount", i(1))].into_iter().collect()).unwrap());
    assert_eq!(cel_lookup(&other, &s("amount"), fields), Lookup::UnsupportedContainer);
    assert_eq!(cel_has(&other, &s("amount"), Some(RANGE), fields), b(false));
}
