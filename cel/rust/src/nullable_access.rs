//! Which dereferences a guard has proven safe — `nullable-access.ts`.
//!
//! A value whose declared type admits null is only safely dereferenced where something has
//! proven it is not null, and what counts as proof is exactly three constructs: a
//! conditional, `&&` and `||`. A consumer changing engines must neither newly accept nor
//! newly reject an expression, so the set is neither wider nor narrower, and a guard
//! written as a function call is not proof. Over a condition `c`:
//!
//! - `chain != null` proves `chain` where `c` holds; `chain == null` proves it where `c`
//!   fails. `null` may stand on either side.
//! - `!c` swaps the two.
//! - `a && b` proves, where it holds, what `a` and `b` prove; where it fails, nothing.
//! - `a || b` is the mirror: where it fails, both arms' negative proofs hold.
//!
//! A chain is a plain path of named members over a name (`error.code`): nothing proves
//! anything about `xs[i].code`. Every function here walks the tree on a heap list.
//!
//! Everything here is private to the crate, as on Node's entry.

use crate::syntax_tree::{CelBinaryOperator, CelLiteral, CelNode, CelUnaryOperator};

/// The plain chain of named members a node spells, innermost name first, with its root.
fn chain_parts(node: &CelNode) -> Option<(&str, Vec<&str>)> {
    let mut fields = Vec::new();
    let mut at = node;
    loop {
        match at {
            CelNode::Ident(ident) => {
                fields.reverse();
                return Some((&ident.name, fields));
            }
            CelNode::Select(select) if !select.optional && !select.field.is_empty() => {
                fields.push(select.field.as_str());
                at = &select.operand;
            }
            _ => return None,
        }
    }
}

/// The dotted path a node spells, if it is a plain chain of named members.
pub(crate) fn chain_text(node: &CelNode) -> Option<String> {
    let (root, fields) = chain_parts(node)?;
    let mut text = root.to_string();
    for field in fields {
        text.push('.');
        text.push_str(field);
    }
    Some(text)
}

/// The name a chain is rooted at, or nothing when it is not a chain of plain members over
/// a name. It says whether the chain's subject is a name the expression bound.
pub(crate) fn chain_root(node: &CelNode) -> Option<&str> {
    let mut at = node;
    loop {
        match at {
            CelNode::Ident(ident) => return Some(&ident.name),
            CelNode::Select(select) if !select.optional && !select.field.is_empty() => at = &select.operand,
            _ => return None,
        }
    }
}

/// The chains proven non-null where the condition holds.
pub(crate) fn proven_where_true(condition: &CelNode) -> Vec<String> {
    proven(condition, true)
}

/// The chains proven non-null where the condition fails.
pub(crate) fn proven_where_false(condition: &CelNode) -> Vec<String> {
    proven(condition, false)
}

/// The proofs of a condition where it holds (`holds`) or fails, in Node's order.
fn proven(condition: &CelNode, holds: bool) -> Vec<String> {
    let mut proofs = Vec::new();
    let mut pending = vec![(condition, holds)];
    while let Some((node, holds)) = pending.pop() {
        match node {
            CelNode::Binary(binary) => match (binary.operator, holds) {
                (CelBinaryOperator::NotEqual, true) | (CelBinaryOperator::Equal, false) => {
                    proofs.extend(null_test(&binary.left, &binary.right));
                }
                (CelBinaryOperator::And, true) | (CelBinaryOperator::Or, false) => {
                    pending.push((&binary.right, holds));
                    pending.push((&binary.left, holds));
                }
                _ => {}
            },
            CelNode::Unary(unary) if unary.operator == CelUnaryOperator::Not => pending.push((&unary.operand, !holds)),
            _ => {}
        }
    }
    proofs
}

/// The chain a comparison against `null` is about, either way round.
fn null_test(left: &CelNode, right: &CelNode) -> Option<String> {
    if is_null_literal(right) {
        return chain_text(left);
    }
    if is_null_literal(left) {
        return chain_text(right);
    }
    None
}

fn is_null_literal(node: &CelNode) -> bool {
    matches!(node, CelNode::Literal(literal) if literal.literal == CelLiteral::Null)
}
