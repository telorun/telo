//! Nothing recurses with its input: a tree of any depth is read, walked, compared,
//! written, cloned and released on a stack of 256 KiB, in a debug build.
//!
//! No Node test file is the twin of this one. What is Node's answer, executed
//! (`@telorun/cel` 0.112.0 at `d265cc79`): the
//! longest chain and the deepest nesting of each construct that reads, the diagnostic
//! one past it, the root's range, and the node count of each deepest nesting.
//!
//! What is this crate's own, because Node cannot answer it — its walkers throw
//! `RangeError` on these trees, and its parser recurses where this one does not: that
//! each tree is walked, compared and released at all; the node counts of the chains
//! and of the hand-built trees; and every read under raised limits.

mod support;

use std::fmt::{self, Write};
use std::sync::Arc;

use support::*;
use telorun_cel::{has_unparsed, parse_syntax, trees_equal, walk_tree, CelNode, CelSyntaxCode, CelSyntaxDiagnostic};

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

fn right_nested_addition() -> Arc<CelNode> {
    (0..MILLION).fold(literal_int(1, 0, 1), |right, _| binary("+", literal_int(1, 0, 1), right, 0, 1))
}

fn nested_negation() -> Arc<CelNode> {
    (0..MILLION).fold(ident("a", false, 0, 1), |operand, _| unary("!", operand, 0, 1))
}

fn nested_conditional() -> Arc<CelNode> {
    (0..MILLION).fold(literal_int(1, 0, 1), |when_false, _| {
        conditional(ident("a", false, 0, 1), literal_int(1, 0, 1), when_false, 0, 1)
    })
}

#[test]
fn handles_a_hand_built_tree_a_million_deep() {
    on_a_small_stack(|| {
        exercise("binary", right_nested_addition(), right_nested_addition(), 2 * MILLION + 1);
        exercise("unary", nested_negation(), nested_negation(), MILLION + 1);
        exercise("conditional", nested_conditional(), nested_conditional(), 3 * MILLION + 1);
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
