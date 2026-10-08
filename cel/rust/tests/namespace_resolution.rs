//! The namespace pass and the resolved expression — the twin of
//! `cel/nodejs/tests/namespace-resolution.test.ts`, case for case.
//!
//! Every row and every literal is the Node build's answer, executed: `@telorun/cel`
//! 0.112.0 at `d265cc79`. Where a Node case asserts a kind or a list of names, the row
//! here holds the whole of what Node answered — the recorded set, the tree with every
//! range, and the diagnostic.
//!
//! Past the twin, each beyond what the Node file asserts: the message of every
//! refusal; the normalization and set-equality tables; a call resolved in every
//! position a node kind offers one; a second pass over a resolved tree; and which
//! subtrees of a rewritten tree are the ones it was given.
//!
//! This crate's own, where Node has no such answer: sharing is asserted as pointer
//! identity (`Arc::ptr_eq`) where Node asserts `toBe`, a refused set is an `Err`
//! where Node throws, and a clone of an expression shares its text and its tree.

mod support;

use std::sync::Arc;

use support::*;
use telorun_cel::{
    namespace_sets_equal, normalize_namespaces, parse_expression, parse_syntax, resolve_namespaces, resolved_under,
    trees_equal, walk_tree, CelNamespaceError, CelNode, CelSyntaxCode, ParseExpressionOptions, ParseOptions,
    RESERVED_NAMESPACES,
};

fn has_qualified_call(root: &CelNode) -> bool {
    walk_tree(root).any(|node| matches!(node, CelNode::QualifiedCall(_)))
}

#[test]
fn cannot_be_done_by_the_parser_a_namespaced_call_and_a_method_call_are_one_syntax() {
    const NODE_KINDS: [(&str, &str); 2] = [
        ("Billing.total(x)", "receiverCall"),
        ("invoice.total(x)", "receiverCall"),
    ];
    for (source, kind) in NODE_KINDS {
        assert_eq!(kind_name(&tree(source)), kind, "{source}");
    }
    // The same shape but for the receiver's name, which is all the parser has.
    const NODE_PAIRS: [(&str, &str, bool); 2] = [
        ("Billing.total(x)", "invoice.total(x)", false),
        ("Billing.total(x)", "Billing.total(x)", true),
    ];
    for (left, right, equal) in NODE_PAIRS {
        assert_eq!(trees_equal(&tree(left), &tree(right)), equal, "{left} against {right}");
    }
}

#[test]
fn produces_the_one_qcall_node_from_the_set_alone() {
    assert_resolves_as_node(vec![
        resolved("Billing.total(x)", &["Billing"], false, &["Billing"], qualified_call("Billing", (0, 7), "total", (8, 13), vec![ident("x", false, 14, 15)], 0, 16), None),
        resolved("Billing.total(x)", &[], false, &[], receiver_call(ident("Billing", false, 0, 7), "total", (8, 13), vec![ident("x", false, 14, 15)], 0, 16), None),
    ]);
}

#[test]
fn is_total_it_resolves_a_call_wherever_it_is_written() {
    const NODE_CALLS: [(&str, &[&str], &[&str]); 1] = [
        ("[Billing.a()].all(i, i == Billing.b(Billing.c()))", &["Billing"], &["a", "b", "c"]),
    ];
    for (source, namespaces, names) in NODE_CALLS {
        let resolved = parse_expression(source, &expression_options(namespaces, false)).expect(source);
        let found: Vec<&str> = walk_tree(&resolved.root)
            .filter_map(|node| match node {
                CelNode::QualifiedCall(call) => Some(call.name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(found, names, "{source}");
    }
}

#[test]
fn resolves_nothing_but_a_call_on_a_bare_name_of_the_set() {
    const NODE_UNCHANGED: [(&str, bool); 8] = [
        ("a.Billing.total(1)", false),
        ("Billing", false),
        ("Billing.rate", false),
        ("Other.total(1)", false),
        ("total(1)", false),
        (".Billing.total(1)", false),
        ("Billing.rate.total(1)", false),
        ("Billing().total(1)", false),
    ];
    for (source, any) in NODE_UNCHANGED {
        let resolved = parse_expression(source, &expression_options(&["Billing"], false)).expect(source);
        assert_eq!(has_qualified_call(&resolved.root), any, "{source}");
    }
}

fn refusal(set: &[&str]) -> Option<String> {
    normalize_namespaces(set).err().map(|refused: CelNamespaceError| refused.message)
}

#[test]
fn refuses_a_reserved_namespace_at_registration() {
    const NODE_RESERVED_NAMESPACES: [&str; 2] = ["cel", "optional"];
    assert_eq!(RESERVED_NAMESPACES, NODE_RESERVED_NAMESPACES);
    const NODE_REFUSALS: [(&[&str], &str); 4] = [
        (&["cel"], "\"cel\" is reserved: the standard macros are written on it, and a namespace would capture them"),
        (&["optional"], "\"optional\" is reserved: the standard macros are written on it, and a namespace would capture them"),
        (&["if"], "\"if\" is a reserved word, so it names no namespace"),
        (&["a.b"], "\"a.b\" is not spelled as a name, so it names no namespace"),
    ];
    for (set, message) in NODE_REFUSALS {
        assert_eq!(refusal(set).as_deref(), Some(message), "{set:?}");
        // The same refusal wherever a set is taken.
        let read = parse_expression("1", &expression_options(set, false));
        assert_eq!(read.err().map(|refused| refused.message).as_deref(), Some(message), "{set:?}");
        let asked = resolved_under(&parse_expression("1", &ParseExpressionOptions::default()).expect("1"), set);
        assert_eq!(asked.err().map(|refused| refused.message).as_deref(), Some(message), "{set:?}");
    }
    assert_resolves_as_node(vec![
        resolved("cel.bind(x, 1, x)", &["Billing"], false, &["Billing"], receiver_call(ident("cel", false, 0, 3), "bind", (4, 8), vec![ident("x", false, 9, 10), literal_int(1, 12, 13), ident("x", false, 15, 16)], 0, 17), None),
    ]);
}

#[test]
fn records_the_set_the_tree_was_resolved_under() {
    const NODE_RECORDED: [(&str, &[&str], &[&str]); 1] = [
        ("Billing.total(1)", &["Shop", "Billing", "Shop"], &["Billing", "Shop"]),
    ];
    for (source, namespaces, recorded) in NODE_RECORDED {
        let expression = parse_expression(source, &expression_options(namespaces, false)).expect(source);
        assert_eq!(&*expression.namespaces, recorded, "{source}");
    }
    /// `(source, the set it is read under, the set asked about, Node's answer)`.
    const NODE_UNDER: [(&str, &[&str], &[&str], bool); 5] = [
        ("Billing.total(1)", &["Shop", "Billing", "Shop"], &["Shop", "Billing"], true),
        ("Billing.total(1)", &["Shop", "Billing", "Shop"], &["Billing"], false),
        ("1", &[], &[], true),
        ("1", &[], &["Billing"], false),
        ("1", &["Billing"], &["Billing", "Billing"], true),
    ];
    for (source, namespaces, asked, under) in NODE_UNDER {
        let expression = parse_expression(source, &expression_options(namespaces, false)).expect(source);
        assert_eq!(resolved_under(&expression, asked), Ok(under), "{source} under {namespaces:?}, asked {asked:?}");
    }
}

#[test]
fn shares_every_node_it_does_not_rewrite() {
    /// `(source, the set, whether Node answers the very root it was given)`.
    const NODE_IDENTITY: [(&str, &[&str], bool); 6] = [
        ("a + b", &["Billing"], true),
        ("Billing.total(1)", &["Billing"], false),
        ("Billing.total(1)", &[], true),
        ("Other.f(Billing, Billing.rate)[.Billing.g()]", &["Billing"], true),
        ("[1, {2: a.b(c)}, -d ? e : f]", &["Billing"], true),
        ("[1, {2: a.b(Billing.c())}, -d ? e : f]", &["Billing"], false),
    ];
    for (source, namespaces, same) in NODE_IDENTITY {
        let parsed = parse_syntax(source, &optional_syntax()).root;
        assert_eq!(Arc::ptr_eq(&resolve_namespaces(&parsed, namespaces), &parsed), same, "{source} under {namespaces:?}");
    }
    /// `(a call, the set, for each argument whether Node's resolved tree holds the one it was given)`.
    const NODE_SHARED: [(&str, &[&str], &[bool]); 1] = [
        ("f(a + b, Billing.g(1), [c], x.y(Billing.h()))", &["Billing"], &[true, false, true, false]),
    ];
    for (source, namespaces, shared) in NODE_SHARED {
        let parsed = tree(source);
        let resolved = resolve_namespaces(&parsed, namespaces);
        let (CelNode::Call(before), CelNode::Call(after)) = (&*parsed, &*resolved) else { panic!("{source} is not a call") };
        let held: Vec<bool> = before.args.iter().zip(&after.args).map(|(before, after)| Arc::ptr_eq(before, after)).collect();
        assert_eq!(held, shared, "{source}");
    }
}

// --- past the twin -------------------------------------------------------------------

#[test]
fn words_each_refusal_of_a_namespace_set_as_node_does() {
    const NODE_REFUSALS: [(&[&str], &str); 11] = [
        (&[""], "\"\" is not spelled as a name, so it names no namespace"),
        (&["1a"], "\"1a\" is not spelled as a name, so it names no namespace"),
        (&["a b"], "\"a b\" is not spelled as a name, so it names no namespace"),
        (&["true"], "\"true\" is a reserved word, so it names no namespace"),
        (&["in"], "\"in\" is a reserved word, so it names no namespace"),
        (&["\u{e9}"], "\"\u{e9}\" is not spelled as a name, so it names no namespace"),
        (&["a\"b"], "\"a\\\"b\" is not spelled as a name, so it names no namespace"),
        (&["a\nb"], "\"a\\nb\" is not spelled as a name, so it names no namespace"),
        (&["Billing", "a-b"], "\"a-b\" is not spelled as a name, so it names no namespace"),
        (&["Billing", "cel"], "\"cel\" is reserved: the standard macros are written on it, and a namespace would capture them"),
        (&["while", "cel"], "\"while\" is a reserved word, so it names no namespace"),
    ];
    for (set, message) in NODE_REFUSALS {
        assert_eq!(refusal(set).as_deref(), Some(message), "{set:?}");
    }
    let refused = normalize_namespaces(["cel"]).expect_err("cel is reserved");
    let as_error: &dyn std::error::Error = &refused;
    assert_eq!(as_error.to_string(), refused.message);
}

#[test]
fn puts_a_namespace_set_in_one_order_with_each_name_once() {
    const NODE_NORMALIZED: [(&[&str], &[&str]); 5] = [
        (&["Shop", "Billing", "Shop"], &["Billing", "Shop"]),
        (&[], &[]),
        (&["b", "a", "_", "B", "a1", "A", "Z_9", "a"], &["A", "B", "Z_9", "_", "a", "a1", "b"]),
        (&["Self", "self"], &["Self", "self"]),
        (&["has", "size", "bind"], &["bind", "has", "size"]),
    ];
    for (set, normalized) in NODE_NORMALIZED {
        assert_eq!(normalize_namespaces(set), Ok(to_strings(normalized)), "{set:?}");
    }
    const NODE_EQUAL: [(&[&str], &[&str], bool); 7] = [
        (&[], &[], true),
        (&["A"], &["A"], true),
        (&["A"], &["B"], false),
        (&["A", "B"], &["A", "B"], true),
        (&["A", "B"], &["B", "A"], false),
        (&["A"], &["A", "B"], false),
        (&["A", "B"], &["A"], false),
    ];
    for (left, right, equal) in NODE_EQUAL {
        assert_eq!(namespace_sets_equal(left, right), equal, "{left:?} against {right:?}");
    }
}

fn to_strings(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

#[test]
fn resolves_a_call_in_every_position_a_node_holds_one() {
    assert_resolves_as_node(vec![
        resolved("[Billing.a(), 1]", &["Shop", "Billing"], false, &["Billing", "Shop"], list(vec![element(qualified_call("Billing", (1, 8), "a", (9, 10), vec![], 1, 12), false), element(literal_int(1, 14, 15), false)], 0, 16), None),
        resolved("{Billing.k(): Billing.v(), 1: 2}", &["Shop", "Billing"], false, &["Billing", "Shop"], map(vec![entry(qualified_call("Billing", (1, 8), "k", (9, 10), vec![], 1, 12), qualified_call("Billing", (14, 21), "v", (22, 23), vec![], 14, 25), false), entry(literal_int(1, 27, 28), literal_int(2, 30, 31), false)], 0, 32), None),
        resolved("Billing.a().b", &["Shop", "Billing"], false, &["Billing", "Shop"], select(qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), "b", (12, 13), false, false, 0, 13), None),
        resolved("Billing.a().?b", &["Shop", "Billing"], false, &["Billing", "Shop"], select(qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), "b", (13, 14), true, false, 0, 14), None),
        resolved("x[Billing.i()]", &["Shop", "Billing"], false, &["Billing", "Shop"], index(ident("x", false, 0, 1), qualified_call("Billing", (2, 9), "i", (10, 11), vec![], 2, 13), false, 0, 14), None),
        resolved("Billing.a()[?0]", &["Shop", "Billing"], false, &["Billing", "Shop"], index(qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), literal_int(0, 13, 14), true, 0, 15), None),
        resolved("f(1, Billing.a())", &["Shop", "Billing"], false, &["Billing", "Shop"], call("f", (0, 1), vec![literal_int(1, 2, 3), qualified_call("Billing", (5, 12), "a", (13, 14), vec![], 5, 16)], 0, 17), None),
        resolved("Billing.f(Billing.g(), x)", &["Shop", "Billing"], false, &["Billing", "Shop"], qualified_call("Billing", (0, 7), "f", (8, 9), vec![qualified_call("Billing", (10, 17), "g", (18, 19), vec![], 10, 21), ident("x", false, 23, 24)], 0, 25), None),
        resolved("x.m(Billing.a())", &["Shop", "Billing"], false, &["Billing", "Shop"], receiver_call(ident("x", false, 0, 1), "m", (2, 3), vec![qualified_call("Billing", (4, 11), "a", (12, 13), vec![], 4, 15)], 0, 16), None),
        resolved("Billing.a().m()", &["Shop", "Billing"], false, &["Billing", "Shop"], receiver_call(qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), "m", (12, 13), vec![], 0, 15), None),
        resolved("Billing.a().Billing.b()", &["Shop", "Billing"], false, &["Billing", "Shop"], receiver_call(select(qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), "Billing", (12, 19), false, false, 0, 19), "b", (20, 21), vec![], 0, 23), None),
        resolved("-Billing.a()", &["Shop", "Billing"], false, &["Billing", "Shop"], unary("-", qualified_call("Billing", (1, 8), "a", (9, 10), vec![], 1, 12), 0, 12), None),
        resolved("!Billing.a()", &["Shop", "Billing"], false, &["Billing", "Shop"], unary("!", qualified_call("Billing", (1, 8), "a", (9, 10), vec![], 1, 12), 0, 12), None),
        resolved("1 + Billing.a()", &["Shop", "Billing"], false, &["Billing", "Shop"], binary("+", literal_int(1, 0, 1), qualified_call("Billing", (4, 11), "a", (12, 13), vec![], 4, 15), 0, 15), None),
        resolved("Billing.a() in Shop.b()", &["Shop", "Billing"], false, &["Billing", "Shop"], binary("in", qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), qualified_call("Shop", (15, 19), "b", (20, 21), vec![], 15, 23), 0, 23), None),
        resolved("Billing.a() ? Billing.b() : Shop.c()", &["Shop", "Billing"], false, &["Billing", "Shop"], conditional(qualified_call("Billing", (0, 7), "a", (8, 9), vec![], 0, 11), qualified_call("Billing", (14, 21), "b", (22, 23), vec![], 14, 25), qualified_call("Shop", (28, 32), "c", (33, 34), vec![], 28, 36), 0, 36), None),
        resolved("Billing.map(x, x)", &["Shop", "Billing"], false, &["Billing", "Shop"], qualified_call("Billing", (0, 7), "map", (8, 11), vec![ident("x", false, 12, 13), ident("x", false, 15, 16)], 0, 17), None),
        resolved("Billing.in()", &["Shop", "Billing"], false, &["Billing", "Shop"], qualified_call("Billing", (0, 7), "in", (8, 10), vec![], 0, 12), None),
        resolved("Shop.total(1) + Billing.total(", &["Shop", "Billing"], false, &["Billing", "Shop"], binary("+", qualified_call("Shop", (0, 4), "total", (5, 10), vec![literal_int(1, 11, 12)], 0, 13), qualified_call("Billing", (16, 23), "total", (24, 29), vec![unparsed(30, 30)], 16, 30), 0, 30), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 30, 30))),
        resolved("Billing.total(1) +", &["Shop", "Billing"], false, &["Billing", "Shop"], binary("+", qualified_call("Billing", (0, 7), "total", (8, 13), vec![literal_int(1, 14, 15)], 0, 16), unparsed(18, 18), 0, 18), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 18, 18))),
    ]);
    // The reader's own options reach it unchanged: the optional syntax on, and off.
    assert_resolves_as_node(vec![
        resolved("[?Billing.a()]", &["Billing"], true, &["Billing"], list(vec![element(qualified_call("Billing", (2, 9), "a", (10, 11), vec![], 2, 13), true)], 0, 14), None),
        resolved("{?Billing.k(): Billing.v()}", &["Billing"], true, &["Billing"], map(vec![entry(qualified_call("Billing", (2, 9), "k", (10, 11), vec![], 2, 13), qualified_call("Billing", (15, 22), "v", (23, 24), vec![], 15, 26), true)], 0, 27), None),
        resolved("[?Billing.a()]", &["Billing"], false, &["Billing"], list(vec![element(unparsed(1, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
    ]);
}

#[test]
fn resolves_inside_a_call_an_earlier_pass_already_resolved() {
    let node_second_pass = [
        ("Billing.f(Shop.g(), x) + Shop.h(Billing.i())", &["Billing"], &["Shop"], binary("+", qualified_call("Billing", (0, 7), "f", (8, 9), vec![qualified_call("Shop", (10, 14), "g", (15, 16), vec![], 10, 18), ident("x", false, 20, 21)], 0, 22), qualified_call("Shop", (25, 29), "h", (30, 31), vec![qualified_call("Billing", (32, 39), "i", (40, 41), vec![], 32, 43)], 25, 44), 0, 44)),
    ];
    for (source, first, second, expected) in node_second_pass {
        let once = parse_expression(source, &expression_options(first, false)).expect(source);
        assert_eq!(resolve_namespaces(&once.root, second), expected, "{source}");
    }
}

#[test]
fn hands_the_readers_options_on_and_shares_what_an_expression_holds() {
    // A limit set on the expression's options is the reader's limit.
    let limited = ParseOptions { limits: limits(3, 250, 1000, 1000, 32).limits, ..ParseOptions::default() };
    let options = ParseExpressionOptions { parse: limited, namespaces: vec!["Billing".to_string()] };
    let expression = parse_expression("1 + 2 + 3", &options).expect("the set is one a host can have");
    let parsed = parse_syntax("1 + 2 + 3", &limited);
    assert!(parsed.diagnostic.is_some());
    assert_eq!(expression.diagnostic, parsed.diagnostic);
    assert_eq!(expression.root, parsed.root);

    let copy = expression.clone();
    assert!(Arc::ptr_eq(&copy.source, &expression.source));
    assert!(Arc::ptr_eq(&copy.root, &expression.root));
    assert!(Arc::ptr_eq(&copy.namespaces, &expression.namespaces));
    assert_eq!(copy, expression);
}
