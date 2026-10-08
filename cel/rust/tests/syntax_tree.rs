//! The tree as data: traversal, the hole test, and its two equalities.
//!
//! No Node test file is the twin of this one; Node's tests reach these through the
//! parser's cases.
//!
//! Every order, child list and `trees_equal` verdict is the Node build's answer,
//! executed: `@telorun/cel` 0.112.0 at `d265cc79`. `PartialEq` on a node has no Node counterpart —
//! it is this crate's identity of a tree as data — so its verdicts are this crate's
//! own.

mod support;

use std::sync::Arc;

use support::*;
use telorun_cel::{
    child_nodes, has_unparsed, parse_syntax, trees_equal, walk_tree, CelNode, CelSelectNode, ParseOptions,
};

const NODE_WALKED: &str = "f(a.b[c], [1, -x], {k: !v}) ? g.h(i, j) : (l + m).n";

#[test]
fn walks_a_tree_depth_first_in_pre_order() {
    /// `(kind, start, end)`, in the order Node's `walkTree` yields.
    const NODE_ORDER: [(&str, u32, u32); 22] = [
        ("conditional", 0, 51),
        ("call", 0, 27),
        ("index", 2, 8),
        ("select", 2, 5),
        ("ident", 2, 3),
        ("ident", 6, 7),
        ("list", 10, 17),
        ("literal", 11, 12),
        ("unary", 14, 16),
        ("ident", 15, 16),
        ("map", 19, 26),
        ("ident", 20, 21),
        ("unary", 23, 25),
        ("ident", 24, 25),
        ("receiverCall", 30, 39),
        ("ident", 30, 31),
        ("ident", 34, 35),
        ("ident", 37, 38),
        ("select", 43, 51),
        ("binary", 43, 48),
        ("ident", 43, 44),
        ("ident", 47, 48),
    ];
    let root = tree(NODE_WALKED);
    let walked: Vec<_> = walk_tree(&root).map(|node| (kind_name(node), node.range().start, node.range().end)).collect();
    assert_eq!(walked, NODE_ORDER);
}

#[test]
fn lists_every_child_in_source_order() {
    /// `(kind, the range of each child)`, node by node in walk order.
    const NODE_CHILDREN: [(&str, &[(u32, u32)]); 22] = [
        ("conditional", &[(0, 27), (30, 39), (43, 51)]),
        ("call", &[(2, 8), (10, 17), (19, 26)]),
        ("index", &[(2, 5), (6, 7)]),
        ("select", &[(2, 3)]),
        ("ident", &[]),
        ("ident", &[]),
        ("list", &[(11, 12), (14, 16)]),
        ("literal", &[]),
        ("unary", &[(15, 16)]),
        ("ident", &[]),
        ("map", &[(20, 21), (23, 25)]),
        ("ident", &[]),
        ("unary", &[(24, 25)]),
        ("ident", &[]),
        ("receiverCall", &[(30, 31), (34, 35), (37, 38)]),
        ("ident", &[]),
        ("ident", &[]),
        ("ident", &[]),
        ("select", &[(43, 48)]),
        ("binary", &[(43, 44), (47, 48)]),
        ("ident", &[]),
        ("ident", &[]),
    ];
    let root = tree(NODE_WALKED);
    for (node, (kind, children)) in walk_tree(&root).zip(NODE_CHILDREN) {
        let ranges: Vec<_> = child_nodes(node).iter().map(|child| (child.range().start, child.range().end)).collect();
        assert_eq!((kind_name(node), ranges.as_slice()), (kind, children));
    }
}

#[test]
fn lists_the_arguments_of_a_qualified_call_as_its_children() {
    // The parser produces no qualified call, so this one is built by hand.
    let arguments = vec![ident("x", false, 4, 5), literal_int(1, 7, 8)];
    let node = qualified_call("M", (0, 1), "f", (2, 3), arguments.clone(), 0, 9);
    let children = child_nodes(&node);
    assert_eq!(children.len(), 2);
    assert!(children.iter().zip(&arguments).all(|(child, argument)| std::ptr::eq(*child, &**argument)));
    assert_eq!(walk_tree(&node).count(), 3);
}

#[test]
fn finds_a_hole_anywhere_in_a_tree() {
    /// `(source, whether Node's hasUnparsed finds a hole)`.
    const NODE_HOLES: [(&str, bool); 8] = [
        ("1 + ", true),
        ("a.", false),
        ("f(1, ", true),
        ("[1, {2: }]", true),
        ("a ? b", true),
        ("1 + 2", false),
        ("a.b(c)[d]", false),
        ("", true),
    ];
    for (source, holds) in NODE_HOLES {
        assert_eq!(has_unparsed(&read(source).root), holds, "{source:?}");
    }
}

const NAN: u64 = 0x7ff8000000000000;
const OTHER_NAN: u64 = 0xfff8000000000001;
const ZERO: u64 = 0;
const NEGATIVE_ZERO: u64 = 0x8000000000000000;

fn member(field: &str, quoted: bool, optional: bool) -> Arc<CelNode> {
    select(ident("a", false, 0, 1), field, (2, 3), optional, quoted, 0, 3)
}

fn module_call(namespace: &str, name: &str, arguments: Vec<Arc<CelNode>>, shift: u32) -> Arc<CelNode> {
    qualified_call(namespace, (shift, shift + 1), name, (shift + 2, shift + 3), arguments, shift, shift + 6)
}

/// The pairs Node's `treesEqual` was asked about, in the order it was asked.
fn hand_built_pairs() -> Vec<(&'static str, Arc<CelNode>, Arc<CelNode>)> {
    let x = || ident("x", false, 0, 1);
    vec![
        ("the same literal at two ranges", literal_int(1, 0, 1), literal_int(1, 4, 5)),
        ("an int and a uint", literal_int(1, 0, 1), literal_uint(1, 0, 1)),
        ("an int and a double", literal_int(1, 0, 1), literal_double(1f64.to_bits(), 0, 1)),
        ("NaN and NaN", literal_double(NAN, 0, 1), literal_double(NAN, 0, 1)),
        ("NaN and a NaN of another payload", literal_double(NAN, 0, 1), literal_double(OTHER_NAN, 0, 1)),
        ("a zero and a negative zero", literal_double(ZERO, 0, 1), literal_double(NEGATIVE_ZERO, 0, 1)),
        ("two negative zeros", literal_double(NEGATIVE_ZERO, 0, 1), literal_double(NEGATIVE_ZERO, 0, 1)),
        ("two strings", literal_string("a", 0, 1), literal_string("b", 0, 1)),
        ("a string and the bytes of it", literal_string("a", 0, 1), literal_bytes(&[97], 0, 1)),
        ("the same bytes", literal_bytes(&[1, 2], 0, 1), literal_bytes(&[1, 2], 0, 1)),
        ("bytes of two lengths", literal_bytes(&[1, 2], 0, 1), literal_bytes(&[1], 0, 1)),
        ("true and false", literal_bool(true, 0, 1), literal_bool(false, 0, 1)),
        ("null and null", literal_null(0, 1), literal_null(0, 1)),
        ("null and false", literal_null(0, 1), literal_bool(false, 0, 1)),
        ("a name and its absolute form", ident("y", false, 0, 1), ident("y", true, 0, 1)),
        ("two names", ident("y", false, 0, 1), ident("z", false, 0, 1)),
        ("a member and the same member quoted", member("b", false, false), member("b", true, false)),
        ("a member and the same member read optionally", member("b", false, false), member("b", false, true)),
        ("two members", member("b", false, false), member("c", false, false)),
        ("two holes at two ranges", unparsed(0, 0), unparsed(3, 9)),
        ("a hole and a name", unparsed(0, 0), ident("a", false, 0, 0)),
        ("the same qualified call at two ranges", module_call("M", "f", vec![x()], 0), module_call("M", "f", vec![x()], 5)),
        ("a qualified call under two namespaces", module_call("M", "f", vec![], 0), module_call("N", "f", vec![], 0)),
        ("a qualified call of two names", module_call("M", "f", vec![], 0), module_call("M", "g", vec![], 0)),
        (
            "a qualified call with one more argument",
            module_call("M", "f", vec![x()], 0),
            module_call("M", "f", vec![x(), ident("y", false, 0, 1)], 0),
        ),
    ]
}

#[test]
fn holds_two_hand_built_trees_to_be_one_expression_exactly_where_node_does() {
    /// `(the pair, whether Node's treesEqual holds them equal)`.
    const NODE_VERDICTS: [(&str, bool); 25] = [
        ("the same literal at two ranges", true),
        ("an int and a uint", false),
        ("an int and a double", false),
        ("NaN and NaN", true),
        ("NaN and a NaN of another payload", true),
        ("a zero and a negative zero", false),
        ("two negative zeros", true),
        ("two strings", false),
        ("a string and the bytes of it", false),
        ("the same bytes", true),
        ("bytes of two lengths", false),
        ("true and false", false),
        ("null and null", true),
        ("null and false", false),
        ("a name and its absolute form", false),
        ("two names", false),
        ("a member and the same member quoted", true),
        ("a member and the same member read optionally", false),
        ("two members", false),
        ("two holes at two ranges", true),
        ("a hole and a name", false),
        ("the same qualified call at two ranges", true),
        ("a qualified call under two namespaces", false),
        ("a qualified call of two names", false),
        ("a qualified call with one more argument", false),
    ];
    for ((label, left, right), (node_label, equal)) in hand_built_pairs().into_iter().zip(NODE_VERDICTS) {
        assert_eq!(label, node_label);
        assert_eq!(trees_equal(&left, &right), equal, "{label}");
        assert_eq!(trees_equal(&right, &left), equal, "{label}, the other way");
    }
}

#[test]
fn holds_two_read_trees_to_be_one_expression_exactly_where_node_does() {
    /// `(left, right, whether Node's treesEqual holds their trees equal)`, both read
    /// with the optional syntax on.
    const NODE_VERDICTS: [(&str, &str, bool); 14] = [
        ("a+b", " a  +  b ", true),
        ("a.b", "a.`b`", true),
        ("(a)", "a", true),
        ("[1, 2]", "[1,2,]", true),
        ("a ? b : c", "a ? b : d", false),
        ("f(x)", "g(x)", false),
        ("f(x)", "f(x, y)", false),
        ("a.f(x)", "b.f(x)", false),
        ("{1: 2}", "{1: 3}", false),
        ("a[0]", "a[?0]", false),
        ("-a", "!a", false),
        ("-1", "-(1)", false),
        ("1 + ", "1 + )", true),
        ("a.", "a.b", false),
    ];
    let options = ParseOptions { optional_syntax: true, ..ParseOptions::default() };
    for (left, right, equal) in NODE_VERDICTS {
        let (left_root, right_root) = (parse_syntax(left, &options).root, parse_syntax(right, &options).root);
        assert_eq!(trees_equal(&left_root, &right_root), equal, "{left:?} against {right:?}");
    }
}

#[test]
fn compares_a_tree_as_data_by_every_field_ranges_and_quoting_included() {
    // This crate's own equality. What `trees_equal` ignores, it tells apart.
    assert_ne!(literal_int(1, 0, 1), literal_int(1, 4, 5));
    assert_ne!(member("b", false, false), member("b", true, false));
    assert_ne!(unparsed(0, 0), unparsed(3, 9));
    assert_ne!(module_call("M", "f", vec![], 0), module_call("M", "f", vec![], 5));
    assert_ne!(tree("a+b"), tree(" a  +  b "));
    assert_ne!(tree("a.b"), tree("a.`b`"));
    // A field range alone, and a name range alone.
    assert_ne!(member("b", false, false), select(ident("a", false, 0, 1), "b", (1, 3), false, false, 0, 3));
    assert_ne!(call("f", (0, 1), vec![], 0, 3), call("f", (0, 2), vec![], 0, 3));
    assert_ne!(receiver_call(ident("a", false, 0, 1), "f", (2, 3), vec![], 0, 5), receiver_call(ident("a", false, 0, 1), "f", (2, 4), vec![], 0, 5));
    // A double is itself: NaN is NaN whatever its payload, a negative zero is not a zero.
    assert_eq!(literal_double(NAN, 0, 1), literal_double(NAN, 0, 1));
    assert_eq!(literal_double(NAN, 0, 1), literal_double(OTHER_NAN, 0, 1));
    assert_ne!(literal_double(ZERO, 0, 1), literal_double(NEGATIVE_ZERO, 0, 1));
    assert_eq!(literal_double(NEGATIVE_ZERO, 0, 1), literal_double(NEGATIVE_ZERO, 0, 1));
    assert_ne!(literal_int(1, 0, 1), literal_uint(1, 0, 1));
    // The same source read twice is the same data, in two allocations.
    let (first, second) = (tree(NODE_WALKED), tree(NODE_WALKED));
    assert!(!Arc::ptr_eq(&first, &second));
    assert_eq!(first, second);
    assert!(trees_equal(&first, &second));
    // Where trees differ decides, at any depth and in any kind.
    for (left, right) in [("f(a, [1, {2: x}])", "f(a, [1, {2: y}])"), ("a[0]", "a[1]"), ("a ? b : c", "a ? b : d")] {
        assert_ne!(tree(left), tree(right), "{left} against {right}");
    }
    // A kind's own struct and an entry compare as the union does.
    let CelNode::Select(select_node) = &*member("b", false, false) else { panic!("a member is a select") };
    let quoted = CelSelectNode { quoted: true, ..select_node.clone() };
    assert_ne!(*select_node, quoted);
    assert_eq!(*select_node, select_node.clone());
    assert_eq!(element(literal_int(1, 0, 1), false), element(literal_int(1, 0, 1), false));
    assert_ne!(element(literal_int(1, 0, 1), false), element(literal_int(1, 0, 1), true));
    assert_eq!(entry(literal_int(1, 0, 1), literal_int(2, 3, 4), false), entry(literal_int(1, 0, 1), literal_int(2, 3, 4), false));
    assert_ne!(entry(literal_int(1, 0, 1), literal_int(2, 3, 4), false), entry(literal_int(1, 0, 1), literal_int(3, 3, 4), false));
}

#[test]
fn shares_its_children_when_cloned() {
    let root = tree("a + b");
    let copy = (*root).clone();
    let (CelNode::Binary(original), CelNode::Binary(copied)) = (&*root, &copy) else { panic!("a + b is a binary node") };
    assert!(Arc::ptr_eq(&original.left, &copied.left));
    assert!(Arc::ptr_eq(&original.right, &copied.right));
    assert_eq!(*root, copy);
}

#[test]
fn writes_a_tree_for_a_reader_with_every_field() {
    // This crate's own text: Node prints a tree through its host.
    assert_eq!(
        format!("{:?}", tree("a.?b[0]")),
        "CelIndexNode { operand: CelSelectNode { operand: CelIdentNode { name: \"a\", absolute: false, range: 0..1 }, \
         field: \"b\", field_range: 3..4, optional: true, quoted: false, range: 0..4 }, \
         index: CelLiteralNode { literal: Int(0), range: 5..6 }, optional: false, range: 0..7 }"
    );
    assert_eq!(
        format!("{:?}", tree("f([1], {k: -v})")),
        "CelCallNode { name: \"f\", name_range: 0..1, args: [\
         CelListNode { elements: [CelListElement { value: CelLiteralNode { literal: Int(1), range: 3..4 }, optional: false }], range: 2..5 }, \
         CelMapNode { entries: [CelMapEntry { key: CelIdentNode { name: \"k\", absolute: false, range: 8..9 }, \
         value: CelUnaryNode { operator: \"-\", operand: CelIdentNode { name: \"v\", absolute: false, range: 12..13 }, range: 11..13 }, \
         optional: false }], range: 7..14 }], range: 0..15 }"
    );
}
