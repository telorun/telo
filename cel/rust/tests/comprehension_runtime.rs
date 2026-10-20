//! What each comprehension macro does as a function of its elements and its body —
//! `cel_all`, `cel_exists`, `cel_exists_one`, `cel_filter` and `cel_map_comprehension`,
//! the public face of the fold the evaluator drives.
//!
//! No Node test file is the twin of this one: Node's tests reach these functions through
//! evaluation. Each expected answer is what Node's `celAll`, `celExists`, `celExistsOne`,
//! `celFilter` and `celMapComprehension` answered over the same elements and bodies,
//! executed — `@telorun/cel 0.120.1 at b4a2b6e9` — except a test that answers no bool,
//! whose interim wording is named where it is asserted.

mod value_support;

use telorun_cel::{cel_all, cel_exists, cel_exists_one, cel_filter, cel_map_comprehension, CelValue};
use value_support::{b, err, i, l, s, RANGE};

/// The elements `0`, `1`, `2`, and a body answering the table's entry for each.
fn over(answers: Vec<CelValue>) -> (Vec<CelValue>, impl FnMut(&CelValue) -> CelValue) {
    let elements = vec![i(0), i(1), i(2)];
    let body = move |element: &CelValue| match element {
        CelValue::Int(at) => answers[*at as usize].clone(),
        _ => unreachable!("the elements are ints"),
    };
    (elements, body)
}

fn key(name: &str) -> CelValue {
    err("no_such_key", name)
}

#[test]
fn lets_a_decided_element_win_over_an_error_in_all_and_exists() {
    let (elements, mut body) = over(vec![key("a"), b(false), b(true)]);
    assert_eq!(cel_all(&elements, &mut body, Some(RANGE)), b(false));
    let (elements, mut body) = over(vec![key("a"), key("b"), b(true)]);
    assert_eq!(cel_all(&elements, &mut body, Some(RANGE)), key("a"));
    let (elements, mut body) = over(vec![b(true), b(true), b(true)]);
    assert_eq!(cel_all(&elements, &mut body, Some(RANGE)), b(true));
    let (elements, mut body) = over(vec![key("a"), b(true), b(false)]);
    assert_eq!(cel_exists(&elements, &mut body, Some(RANGE)), b(true));
    let (elements, mut body) = over(vec![b(false), key("b"), key("c")]);
    assert_eq!(cel_exists(&elements, &mut body, Some(RANGE)), key("b"));
    let (elements, mut body) = over(vec![b(false), b(false), b(false)]);
    assert_eq!(cel_exists(&elements, &mut body, Some(RANGE)), b(false));
}

#[test]
fn answers_the_first_error_in_exists_one_filter_and_map() {
    let (elements, mut body) = over(vec![b(true), key("b"), b(true)]);
    assert_eq!(cel_exists_one(&elements, &mut body, Some(RANGE)), key("b"));
    let (elements, mut body) = over(vec![b(true), b(false), b(true)]);
    assert_eq!(cel_exists_one(&elements, &mut body, Some(RANGE)), b(false));
    let (elements, mut body) = over(vec![b(false), b(true), b(false)]);
    assert_eq!(cel_exists_one(&elements, &mut body, Some(RANGE)), b(true));
    let (elements, mut body) = over(vec![b(true), b(false), b(true)]);
    assert_eq!(cel_filter(&elements, &mut body, Some(RANGE)), l(vec![i(0), i(2)]));
    let (elements, mut body) = over(vec![b(true), key("b"), s("x")]);
    assert_eq!(cel_filter(&elements, &mut body, Some(RANGE)), key("b"));
    let (elements, mut body) = over(vec![i(10), i(11), i(12)]);
    assert_eq!(cel_map_comprehension(&elements, &mut body, None, Some(RANGE)), l(vec![i(10), i(11), i(12)]));
    let (elements, mut body) = over(vec![i(10), key("b"), key("c")]);
    assert_eq!(cel_map_comprehension(&elements, &mut body, None, Some(RANGE)), key("b"));
}

#[test]
fn transforms_only_what_a_maps_filter_keeps() {
    let (elements, mut transform) = over(vec![i(10), key("b"), i(12)]);
    let (_, mut filter) = over(vec![b(true), b(false), b(true)]);
    assert_eq!(
        cel_map_comprehension(&elements, &mut transform, Some(&mut filter), Some(RANGE)),
        l(vec![i(10), i(12)])
    );
}

/// An interim wording: Node names what the test answered by JavaScript's `typeof` —
/// `… and it answered bigint`, `… object` — and this crate in CEL's terms.
#[test]
fn names_a_test_that_answered_no_bool_in_cel_terms() {
    let refusal = |what: &str| {
        err("no_matching_overload", &format!("a comprehension's test must answer a bool, and it answered {what}"))
    };
    let (elements, mut body) = over(vec![i(1), b(true), b(true)]);
    assert_eq!(cel_all(&elements, &mut body, Some(RANGE)), refusal("a value of type int"));
    let (elements, mut transform) = over(vec![i(10), i(11), i(12)]);
    let (_, mut filter) = over(vec![b(true), CelValue::Null, b(true)]);
    assert_eq!(cel_map_comprehension(&elements, &mut transform, Some(&mut filter), Some(RANGE)), refusal("null"));
}
