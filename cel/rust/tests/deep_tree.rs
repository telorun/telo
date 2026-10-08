//! Nothing recurses with its input: a tree of any depth is read, walked, compared,
//! formatted, written back as source, re-read, resolved, queried, cloned and released
//! on a stack of 256 KiB, in a debug build.
//!
//! No Node test file is the twin of this one. What is Node's answer, executed
//! (`@telorun/cel` 0.112.0 at `d265cc79`): the
//! longest chain and the deepest nesting of each construct that reads, the diagnostic
//! one past it, the root's range, the node count of each deepest nesting, and — on a
//! chain and a hand-built nesting three links long, where Node still answers — the
//! text written, whether the pass answers the root it was given, and what the two
//! queries answer.
//!
//! What is this crate's own, because Node cannot answer it — its walkers throw
//! `RangeError` on these trees, and its parser recurses where this one does not: that
//! each tree is walked, compared and released at all; the node counts of the chains
//! and of the hand-built trees; every read under raised limits; and every answer of
//! the writer, the pass and the queries on a tree of full length, which is the answer
//! of the three-link row carried to that length.

mod support;

use std::fmt::{self, Write};
use std::sync::Arc;

use support::*;
use telorun_cel::{
    has_unparsed, parse_syntax, qualified_calls, resolve_namespaces, root_references, serialize_tree, trees_equal,
    walk_tree, CelNode, CelSyntaxCode, CelSyntaxDiagnostic,
};

/// The one stack size any test of this crate names.
const STACK_BYTES: usize = 256 * 1024;

fn on_a_small_stack(work: impl FnOnce() + Send + 'static) {
    let thread = std::thread::Builder::new().stack_size(STACK_BYTES).spawn(work).expect("the thread starts");
    thread.join().expect("the work ran to its end");
}

/// Counts what is written and keeps none of it.
struct Counted(usize);

impl Write for Counted {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.0 += text.len();
        Ok(())
    }
}

/// Walks, tests for holes, compares both ways against a second build of the same tree,
/// writes, clones and releases.
fn exercise(label: &str, tree: Arc<CelNode>, twin: Arc<CelNode>, nodes: usize) {
    assert!(!Arc::ptr_eq(&tree, &twin), "{label}");
    assert_eq!(walk_tree(&tree).count(), nodes, "{label}");
    assert!(!has_unparsed(&tree), "{label}");
    assert!(trees_equal(&tree, &twin), "{label}");
    assert!(tree == twin, "{label}");
    let mut written = Counted(0);
    write!(written, "{tree:?}").expect("a counter refuses nothing");
    assert!(written.0 > nodes, "{label}");
    let copy = (*tree).clone();
    assert!(copy == *twin, "{label}");
    drop(copy);
    drop(tree);
    drop(twin);
}

// --- chains at the node limit ------------------------------------------------------

/// `(what is chained, one link, the nodes of a chain of `links`)`.
fn chain(label: &str, links: usize) -> (String, usize) {
    match label {
        "addition" => (format!("1{}", "+1".repeat(links)), 2 * links + 1),
        "member" => (format!("a{}", ".b".repeat(links)), links + 1),
        "index" => (format!("a{}", "[0]".repeat(links)), 2 * links + 1),
        "receiver call" => (format!("a{}", ".f()".repeat(links)), links + 1),
        other => panic!("{other} is not a chain"),
    }
}

/// What the writer, the pass and the queries answer for a chain.
struct ChainAnswers {
    written: String,
    /// Whether the pass under a set naming nothing in the chain answers the root it was given.
    same_under_another_name: bool,
    /// Whether the pass under a set naming the chain's own root does.
    same_under_its_root: bool,
    /// The qualified calls of the tree resolved under the chain's own root.
    calls: usize,
    roots: Vec<String>,
    roots_resolved: Vec<String>,
}

fn chain_answers(tree: &Arc<CelNode>) -> ChainAnswers {
    let written = serialize_tree(tree).expect("a tree that read whole is written");
    let reread = read(&written);
    assert_eq!(reread.diagnostic, None);
    assert!(trees_equal(tree, &reread.root));
    let resolved = resolve_namespaces(tree, &["a"]);
    ChainAnswers {
        written,
        same_under_another_name: Arc::ptr_eq(&resolve_namespaces(tree, &["Billing"]), tree),
        same_under_its_root: Arc::ptr_eq(&resolved, tree),
        calls: qualified_calls(&resolved).len(),
        roots: root_references(tree),
        roots_resolved: root_references(&resolved),
    }
}

/// The text Node writes for a chain: the source, with a space around each operator.
fn chain_written(label: &str, links: usize) -> String {
    match label {
        "addition" => format!("1{}", " + 1".repeat(links)),
        _ => chain(label, links).0,
    }
}

#[test]
fn writes_resolves_and_queries_a_chain_as_long_as_the_node_limit_allows() {
    on_a_small_stack(|| {
        /// `(chain, links, the text written, whether the pass answers the root it was
        /// given under a name the chain does not hold and under its own root, the
        /// qualified calls under its own root, the names read before and after that pass)`.
        const NODE_SHORT: [(&str, usize, &str, bool, bool, usize, &[&str], &[&str]); 4] = [
            ("addition", 3, "1 + 1 + 1 + 1", true, true, 0, &[], &[]),
            ("member", 3, "a.b.b.b", true, true, 0, &["a"], &["a"]),
            ("index", 3, "a[0][0][0]", true, true, 0, &["a"], &["a"]),
            ("receiver call", 3, "a.f().f().f()", true, false, 1, &["a"], &[]),
        ];
        // `(chain, the most links Node reads)`, as the test below holds them.
        let longest = [("addition", 49999), ("member", 99999), ("index", 49999), ("receiver call", 99999)];
        for ((label, links, written, same, same_under_root, calls, roots, roots_resolved), (long_label, most)) in
            NODE_SHORT.into_iter().zip(longest)
        {
            assert_eq!(label, long_label);
            for length in [links, most] {
                let answers = chain_answers(&read(&chain(label, length).0).root);
                if length == links {
                    assert_eq!(answers.written, written, "{label}");
                }
                assert!(answers.written == chain_written(label, length), "{label} of {length}");
                assert_eq!(answers.same_under_another_name, same, "{label} of {length}");
                assert_eq!(answers.same_under_its_root, same_under_root, "{label} of {length}");
                assert_eq!(answers.calls, calls, "{label} of {length}");
                assert_eq!(answers.roots, roots, "{label} of {length}");
                assert_eq!(answers.roots_resolved, roots_resolved, "{label} of {length}");
            }
        }
    });
}

#[test]
fn reads_and_handles_a_chain_as_long_as_the_node_limit_allows() {
    on_a_small_stack(|| {
        // `(chain, the most links Node reads, the root's range, Node's refusal of one more)`.
        let node_boundaries: [(&str, usize, (u32, u32), Option<CelSyntaxDiagnostic>); 4] = [
            ("addition", 49999, (0, 99999), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 100000", 0, 100001))),
            ("member", 99999, (0, 199999), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 100000", 0, 200001))),
            ("index", 49999, (0, 149998), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 100000", 0, 150001))),
            ("receiver call", 99999, (0, 399997), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 100000", 0, 400001))),
        ];
        for (label, links, (start, end), refusal) in node_boundaries {
            let (source, nodes) = chain(label, links);
            let parsed = read(&source);
            assert_eq!(parsed.diagnostic, None, "{label}");
            assert_eq!(parsed.root.range(), range(start, end), "{label}");
            assert_eq!(read(&chain(label, links + 1).0).diagnostic, refusal, "{label}");
            exercise(label, parsed.root, read(&source).root, nodes);
        }
    });
}

// --- hand-built trees a million deep --------------------------------------------------

const MILLION: usize = 1_000_000;

fn right_nested_addition(depth: usize) -> Arc<CelNode> {
    (0..depth).fold(literal_int(1, 0, 1), |right, _| binary("+", literal_int(1, 0, 1), right, 0, 1))
}

fn nested_negation(depth: usize) -> Arc<CelNode> {
    (0..depth).fold(ident("a", false, 0, 1), |operand, _| unary("!", operand, 0, 1))
}

fn nested_conditional(depth: usize) -> Arc<CelNode> {
    (0..depth).fold(literal_int(1, 0, 1), |when_false, _| {
        conditional(ident("a", false, 0, 1), literal_int(1, 0, 1), when_false, 0, 1)
    })
}

#[test]
fn handles_a_hand_built_tree_a_million_deep() {
    on_a_small_stack(|| {
        exercise("binary", right_nested_addition(MILLION), right_nested_addition(MILLION), 2 * MILLION + 1);
        exercise("unary", nested_negation(MILLION), nested_negation(MILLION), MILLION + 1);
        exercise("conditional", nested_conditional(MILLION), nested_conditional(MILLION), 3 * MILLION + 1);
    });
}

/// The text Node writes for a hand-built nesting: its three-deep answer, at any depth.
fn nesting_written(label: &str, depth: usize) -> String {
    match label {
        "binary" => format!("{}1 + 1{}", "1 + (".repeat(depth - 1), ")".repeat(depth - 1)),
        "unary" => format!("{}a", "!".repeat(depth)),
        "conditional" => format!("{}1", "a ? 1 : ".repeat(depth)),
        other => panic!("{other} is not a hand-built nesting"),
    }
}

#[test]
fn writes_a_hand_built_tree_a_million_deep() {
    on_a_small_stack(|| {
        /// `(nesting, depth, the text Node writes)`.
        const NODE_SHORT: [(&str, usize, &str); 3] = [
            ("binary", 3, "1 + (1 + (1 + 1))"),
            ("unary", 3, "!!!a"),
            ("conditional", 3, "a ? 1 : a ? 1 : a ? 1 : 1"),
        ];
        let builders: [fn(usize) -> Arc<CelNode>; 3] = [right_nested_addition, nested_negation, nested_conditional];
        for ((label, depth, written), build) in NODE_SHORT.into_iter().zip(builders) {
            assert_eq!(serialize_tree(&build(depth)).as_deref(), Ok(written), "{label}");
            assert_eq!(nesting_written(label, depth), written, "{label}");
            let deep = serialize_tree(&build(MILLION)).expect(label);
            assert!(deep == nesting_written(label, MILLION), "{label}");
        }
    });
}

// --- every nesting construct ---------------------------------------------------------

/// `(the source of a construct nested `depth` deep, its nodes)`.
fn nested(label: &str, depth: usize) -> (String, usize) {
    let around = |open: &str, inner: &str, close: &str| format!("{}{inner}{}", open.repeat(depth), close.repeat(depth));
    match label {
        "parentheses" => (around("(", "1", ")"), 1),
        "list" => (around("[", "1", "]"), depth + 1),
        "map" => (around("{1:", "1", "}"), 2 * depth + 1),
        "index" => (around("a[", "0", "]"), 2 * depth + 1),
        "call argument" => (around("f(", "1", ")"), depth + 1),
        "ternary" => (around("a?", "1", ":1"), 3 * depth + 1),
        "not" => (around("!", "a", ""), depth + 1),
        "negation" => (around("-", "a", ""), depth + 1),
        other => panic!("{other} is not a nesting construct"),
    }
}

const CONSTRUCTS: [&str; 8] = ["parentheses", "list", "map", "index", "call argument", "ternary", "not", "negation"];

#[test]
fn reads_each_construct_at_its_deepest_nesting_and_refuses_one_deeper() {
    on_a_small_stack(|| {
        // `(construct, the deepest nesting Node reads, its nodes, Node's refusal of one deeper)`.
        let node_boundaries: [(&str, usize, usize, Option<CelSyntaxDiagnostic>); 8] = [
            ("parentheses", 249, 1, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 250, 250))),
            ("list", 249, 250, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 250, 250))),
            ("map", 249, 499, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 748, 748))),
            ("index", 249, 499, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 500, 500))),
            ("call argument", 249, 250, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 500, 500))),
            ("ternary", 249, 748, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 500, 500))),
            ("not", 249, 250, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 249, 249))),
            ("negation", 249, 250, Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 249, 249))),
        ];
        assert_eq!(node_boundaries.each_ref().map(|(label, ..)| *label), CONSTRUCTS);
        for (label, depth, node_count, refusal) in node_boundaries {
            let (source, nodes) = nested(label, depth);
            assert_eq!(nodes, node_count, "{label}");
            let parsed = read(&source);
            assert_eq!(parsed.diagnostic, None, "{label}");
            assert_eq!(walk_tree(&parsed.root).count(), node_count, "{label}");
            assert!(refusal.is_some(), "{label}");
            assert_eq!(read(&nested(label, depth + 1).0).diagnostic, refusal, "{label}");
        }
    });
}

#[test]
fn reads_each_construct_a_hundred_thousand_deep_when_the_limits_allow() {
    on_a_small_stack(|| {
        const DEPTH: usize = 100_000;
        let raised = limits(1_000_000, 1_000_000, 1000, 1000, 32);
        for label in CONSTRUCTS {
            let (source, nodes) = nested(label, DEPTH);
            let parsed = parse_syntax(&source, &raised);
            assert_eq!(parsed.diagnostic, None, "{label}");
            assert_eq!(walk_tree(&parsed.root).count(), nodes, "{label}");
            drop(parsed);
        }
    });
}
