//! The root-reference query — the twin of `cel/nodejs/tests/root-references.test.ts`,
//! case for case — and the table of binding forms it reads.
//!
//! Every row is the Node build's answer, executed: `@telorun/cel` 0.112.0,
//! this branch's build.
//!
//! Past the twin, each beyond what the Node file asserts: the forms that bind nothing
//! (an arity the table does not list, a bound argument that is not a name), nested and
//! shadowing bindings, absolute names, the reserved namespaces in every position, a
//! macro name the namespace set resolved, the order of names outside ASCII, and the
//! binding table itself — which no Node test file reads on its own.

mod support;

use support::*;
use telorun_cel::{
    namespace_macro_binding, parse_expression, receiver_macro_binding, root_references, ComprehensionBinding,
    BINDING_FORMS,
};

/// `(source, the set it is read under, the names Node answers)`.
type NodeRoots = (&'static str, &'static [&'static str], &'static [&'static str]);

fn assert_roots_as_node(rows: &[NodeRoots]) {
    assert!(!rows.is_empty(), "the table holds no row");
    for (source, namespaces, roots) in rows {
        let expression = parse_expression(source, &expression_options(namespaces, false)).expect(source);
        assert_eq!(expression.diagnostic, None, "{source}");
        assert_eq!(root_references(&expression.root), *roots, "{source} under {namespaces:?}");
    }
}

#[test]
fn answers_the_first_name_of_every_access_chain_once_and_sorted() {
    assert_roots_as_node(&[
        ("request.query.limit + request.body.size + xs[0].id", &[], &["request", "xs"]),
        ("size(a) + b.c('d')", &[], &["a", "b"]),
        ("{'k': v}[w] ? y : -z", &[], &["v", "w", "y", "z"]),
        ("1 + 2", &[], &[]),
    ]);
}

#[test]
fn excludes_a_name_a_comprehension_or_a_binding_introduces() {
    assert_roots_as_node(&[
        ("xs.map(i, i + offset)", &[], &["offset", "xs"]),
        ("xs.filter(i, i > 0).all(j, j < limit)", &[], &["limit", "xs"]),
        ("xs.map(i, i > 0, i * 2)", &[], &["xs"]),
        ("cel.bind(error, {'code': 1}, error.code)", &[], &[]),
        ("cel.bind(x, outer, x)", &[], &["outer"]),
    ]);
}

#[test]
fn reads_a_name_again_where_the_binding_does_not_reach_it() {
    assert_roots_as_node(&[
        ("xs.map(i, i) + i", &[], &["i", "xs"]),
    ]);
}

#[test]
fn excludes_a_namespace_resolved_or_reserved() {
    assert_roots_as_node(&[
        ("Billing.total(x)", &["Billing"], &["x"]),
        ("Billing.total(x)", &[], &["Billing", "x"]),
        ("Billing.rate", &["Billing"], &["Billing"]),
        ("optional.of(a).hasValue()", &[], &["a"]),
    ]);
}

// --- past the twin -------------------------------------------------------------------

#[test]
fn binds_exactly_where_a_listed_form_binds_a_name() {
    assert_roots_as_node(&[
        ("xs.all(k, v, p)", &[], &["k", "p", "v", "xs"]),
        ("xs.map(1, i)", &[], &["i", "xs"]),
        ("xs.map(a.b, i)", &[], &["a", "i", "xs"]),
        ("xs.exists(i, i)", &[], &["xs"]),
        ("xs.exists_one(i, i)", &[], &["xs"]),
        ("xs.optMap(i, i)", &[], &["xs"]),
        ("xs.optFlatMap(i, i + j)", &[], &["j", "xs"]),
        ("xs.map(i)", &[], &["i", "xs"]),
        ("xs.map(i, i, i, i)", &[], &["i", "xs"]),
        ("xs.map(x, .x)", &[], &["x", "xs"]),
        ("xs.map(.x, x)", &[], &["xs"]),
        ("x.map(x, x.map(x, x) + x) + x.y", &[], &["x"]),
        ("xs.map(i, ys.map(j, i + j + k)) + j", &[], &["j", "k", "xs", "ys"]),
        ("xs.map(i, ys.map(i, i)) ", &[], &["xs", "ys"]),
        ("xs.map(i, i.map(i, i) + i)", &[], &["xs"]),
        ("cel.bind(x, x, x)", &[], &["x"]),
        ("cel.bind(x, y, z)", &[], &["y", "z"]),
        ("cel.bind(1, y, z)", &[], &["y", "z"]),
        ("cel.bind(x, y)", &[], &["x", "y"]),
        ("cel.other(x, y, x)", &[], &["x", "y"]),
        ("optional.none()", &[], &[]),
        ("optional.of(optional)", &[], &["optional"]),
        ("optional.map(i, i)", &[], &["i"]),
        ("cel", &[], &["cel"]),
        ("cel.x", &[], &["cel"]),
        (".cel.bind(x, 1, x)", &[], &[]),
        ("a.cel.bind(x, 1, x)", &[], &["a", "x"]),
        ("map(i, i)", &[], &["i"]),
        ("b + a + B + _a + a1 + A", &[], &["A", "B", "_a", "a", "a1", "b"]),
        ("f(x) + g", &[], &["g", "x"]),
    ]);
    // A macro's name on a namespace of the set is a call like any other: it binds nothing.
    assert_roots_as_node(&[
        ("Shop.map(i, i)", &["Shop"], &["i"]),
        ("Shop.map(i, i)", &[], &["Shop"]),
    ]);
}

#[test]
fn sorts_names_as_node_does() {
    // No source spells a name outside ASCII, so the tree is built by hand.
    let node_sorted = [
        (binary("+", binary("+", ident("\u{e000}", false, 0, 0), ident("\u{1f600}", false, 0, 0), 0, 0), binary("+", ident("\u{e9}", false, 0, 0), ident("z", false, 0, 0), 0, 0), 0, 0), &["z", "\u{e9}", "\u{1f600}", "\u{e000}"]),
    ];
    for (tree, roots) in node_sorted {
        let expected: &[&str] = roots;
        assert_eq!(root_references(&tree), expected);
    }
}

fn binding(found: Option<ComprehensionBinding>) -> Option<(usize, &'static [usize])> {
    found.map(|binding| (binding.variable_argument, binding.scoped_arguments))
}

#[test]
fn lists_the_binding_forms_node_lists() {
    const NODE_BINDING_FORMS: [&str; 9] = ["all/2", "exists/2", "exists_one/2", "filter/2", "map/2", "map/3", "optMap/2", "optFlatMap/2", "cel.bind/3"];
    assert_eq!(BINDING_FORMS, NODE_BINDING_FORMS);
    /// `(the called name, the number of arguments, the bound argument and the arguments it reaches)`.
    const NODE_RECEIVER: [(&str, usize, Option<(usize, &[usize])>); 18] = [
        ("all", 2, Some((0, &[1]))),
        ("exists", 2, Some((0, &[1]))),
        ("exists_one", 2, Some((0, &[1]))),
        ("filter", 2, Some((0, &[1]))),
        ("map", 2, Some((0, &[1]))),
        ("map", 3, Some((0, &[1, 2]))),
        ("optMap", 2, Some((0, &[1]))),
        ("optFlatMap", 2, Some((0, &[1]))),
        ("all", 3, None),
        ("map", 1, None),
        ("map", 4, None),
        ("map", 20, None),
        ("bind", 3, None),
        ("cel.bind", 3, None),
        ("", 2, None),
        ("al", 2, None),
        ("all/2", 2, None),
        ("ALL", 2, None),
    ];
    for (name, arity, expected) in NODE_RECEIVER {
        assert_eq!(binding(receiver_macro_binding(name, arity)), expected, "{name}/{arity}");
    }
    const NODE_NAMESPACE: [(&str, &str, usize, Option<(usize, &[usize])>); 9] = [
        ("cel", "bind", 3, Some((0, &[2]))),
        ("cel", "bind", 2, None),
        ("cel", "bind", 4, None),
        ("optional", "bind", 3, None),
        ("cel", "map", 2, None),
        ("", "cel.bind", 3, None),
        ("cel.bind", "", 3, None),
        ("c", "el.bind", 3, None),
        ("Cel", "bind", 3, None),
    ];
    for (namespace, name, arity, expected) in NODE_NAMESPACE {
        assert_eq!(binding(namespace_macro_binding(namespace, name, arity)), expected, "{namespace}.{name}/{arity}");
    }
}
