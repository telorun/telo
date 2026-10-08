//! Whether two trees are the same expression — `tree-equality.ts`.
//!
//! Ranges are not compared: one expression written with different spacing or
//! parentheses holds different offsets. Whether a member was written between backticks
//! is not compared either. Any hole equals any hole.
//!
//! A double compares by identity, so `-0.0` is not `0.0` and a NaN equals itself.
//!
//! The comparison runs on a heap work list and costs no stack, whatever the depth of
//! the trees.

use std::sync::Arc;

use crate::syntax_tree::CelNode;

type NodePairs<'a> = Vec<(&'a CelNode, &'a CelNode)>;

fn pair_lists<'a>(left: &'a [Arc<CelNode>], right: &'a [Arc<CelNode>], pending: &mut NodePairs<'a>) -> bool {
    left.len() == right.len() && {
        pending.extend(left.iter().zip(right).map(|(left, right)| (&**left, &**right)));
        true
    }
}

/// Whether two nodes are the same step of an expression, their children left on
/// `pending`.
fn same_step<'a>(left: &'a CelNode, right: &'a CelNode, pending: &mut NodePairs<'a>) -> bool {
    use CelNode::*;
    match (left, right) {
        (Literal(a), Literal(b)) => a.literal == b.literal,
        // Absolute changes what the name resolves against, so it is part of the expression.
        (Ident(a), Ident(b)) => a.name == b.name && a.absolute == b.absolute,
        (Unparsed(_), Unparsed(_)) => true,
        (List(a), List(b)) => {
            a.elements.len() == b.elements.len()
                && a.elements.iter().zip(&b.elements).all(|(a, b)| {
                    pending.push((&a.value, &b.value));
                    a.optional == b.optional
                })
        }
        (Map(a), Map(b)) => {
            a.entries.len() == b.entries.len()
                && a.entries.iter().zip(&b.entries).all(|(a, b)| {
                    pending.push((&a.key, &b.key));
                    pending.push((&a.value, &b.value));
                    a.optional == b.optional
                })
        }
        (Select(a), Select(b)) => {
            pending.push((&a.operand, &b.operand));
            a.field == b.field && a.optional == b.optional
        }
        (Index(a), Index(b)) => {
            pending.push((&a.operand, &b.operand));
            pending.push((&a.index, &b.index));
            a.optional == b.optional
        }
        (Call(a), Call(b)) => a.name == b.name && pair_lists(&a.args, &b.args, pending),
        (ReceiverCall(a), ReceiverCall(b)) => {
            pending.push((&a.receiver, &b.receiver));
            a.name == b.name && pair_lists(&a.args, &b.args, pending)
        }
        (QualifiedCall(a), QualifiedCall(b)) => {
            a.namespace == b.namespace && a.name == b.name && pair_lists(&a.args, &b.args, pending)
        }
        (Unary(a), Unary(b)) => {
            pending.push((&a.operand, &b.operand));
            a.operator == b.operator
        }
        (Binary(a), Binary(b)) => {
            pending.push((&a.left, &b.left));
            pending.push((&a.right, &b.right));
            a.operator == b.operator
        }
        (Conditional(a), Conditional(b)) => {
            pending.push((&a.condition, &b.condition));
            pending.push((&a.when_true, &b.when_true));
            pending.push((&a.when_false, &b.when_false));
            true
        }
        _ => false,
    }
}

/// Whether the two trees are the same expression, their ranges aside.
pub fn trees_equal(left: &CelNode, right: &CelNode) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((left, right)) = pending.pop() {
        if !std::ptr::eq(left, right) && !same_step(left, right, &mut pending) {
            return false;
        }
    }
    true
}
