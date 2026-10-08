//! Turning `Alias.fn(x)` into a qualified call — `namespace-resolution.ts`.
//!
//! `Alias.fn(x)` and `obj.method(x)` are the same syntax, a call written on a receiver,
//! so no parser can tell them apart: only a set of names that denote namespaces rather
//! than values can. That set comes from the host, which is why this is a separate
//! tree-to-tree pass and not a parser rule.
//!
//! The pass is total: it visits every node and rewrites every receiver call whose
//! receiver is a bare identifier in the set, wherever it sits. It is the only producer
//! of a qualified call.
//!
//! `cel` and `optional` are kept out of a set by `normalize_namespaces`, because the
//! standard macros are written on them and a namespace would capture those calls. That
//! guarantee is the normalization's and not the pass's: the pass takes the names it is
//! given, and `parse_expression` is the path that always validates them.
//!
//! What the pass does not change it shares: a subtree nothing moved in is the same
//! `Arc`, and a tree nothing moved in is the root it was given.
//!
//! It runs on a heap work list and costs no stack, whatever the depth of the tree.
//!
//! Declared differently from the Node file:
//! - `CelNamespaceError` is the `Err` of `normalize_namespaces`, where Node throws it.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::json_quote;

use crate::reserved_words::{is_identifier_spelling, is_reserved_word};
use crate::syntax_tree::{
    CelBinaryNode, CelCallNode, CelConditionalNode, CelIdentNode, CelIndexNode, CelListElement, CelListNode,
    CelMapEntry, CelMapNode, CelNode, CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, CelUnaryNode,
};

/// Names that can never be registered as a namespace.
pub const RESERVED_NAMESPACES: [&str; 2] = ["cel", "optional"];

/// A namespace set a host cannot have: the name is not a name, or is reserved.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelNamespaceError {
    pub message: String,
}

impl fmt::Display for CelNamespaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelNamespaceError {}

fn refused(name: &str, why: &str) -> CelNamespaceError {
    CelNamespaceError { message: format!("{} {why}", json_quote(name)) }
}

/// Validates a namespace set and puts it in a canonical order, so that two sets with
/// the same names compare equal however the host listed them.
pub fn normalize_namespaces<I>(names: I) -> Result<Vec<String>, CelNamespaceError>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let mut normalized: Vec<String> = Vec::new();
    for name in names {
        let name = name.as_ref();
        if !is_identifier_spelling(name) {
            return Err(refused(name, "is not spelled as a name, so it names no namespace"));
        }
        if is_reserved_word(name) {
            return Err(refused(name, "is a reserved word, so it names no namespace"));
        }
        if RESERVED_NAMESPACES.contains(&name) {
            return Err(refused(
                name,
                "is reserved: the standard macros are written on it, and a namespace would capture them",
            ));
        }
        if !normalized.iter().any(|held| held == name) {
            normalized.push(name.to_string());
        }
    }
    // A name is ASCII by its spelling, so byte order is the order Node sorts in.
    normalized.sort();
    Ok(normalized)
}

/// Whether two sets hold the same names. It compares position by position, so it is a
/// set comparison only when both sides are normalized.
pub fn namespace_sets_equal<L: AsRef<str>, R: AsRef<str>>(left: &[L], right: &[R]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(left, right)| left.as_ref() == right.as_ref())
}

/// Rewrites every call on a name of the set into a qualified call. Total; shares what
/// it does not change.
///
/// The answer depends on membership alone: the order of the names and a name given
/// twice change nothing. The names are not validated, so a set that did not come from
/// `normalize_namespaces` may hold `cel` or `optional` and capture the standard macros.
/// `parse_expression` is the path that always validates.
pub fn resolve_namespaces<S: AsRef<str>>(root: &Arc<CelNode>, namespaces: &[S]) -> Arc<CelNode> {
    // Nothing can match an empty set, so the pass answers without walking.
    if namespaces.is_empty() {
        return Arc::clone(root);
    }
    let namespaces: Vec<&str> = namespaces.iter().map(AsRef::as_ref).collect();
    resolve(root, &namespaces)
}

enum Step<'a> {
    /// Resolve this node: its children first, then itself.
    Enter(&'a Arc<CelNode>),
    /// Every child of this node is resolved and waits on `done`, in source order.
    Leave(&'a Arc<CelNode>),
}

fn resolve(root: &Arc<CelNode>, namespaces: &[&str]) -> Arc<CelNode> {
    let mut pending = vec![Step::Enter(root)];
    let mut done: Vec<Arc<CelNode>> = Vec::new();
    while let Some(step) = pending.pop() {
        match step {
            Step::Enter(node) => {
                let from = pending.len();
                pending.push(Step::Leave(node));
                each_child(node, |child| pending.push(Step::Enter(child)));
                // Children resolve in source order, so the last one pushed runs first.
                pending[from + 1..].reverse();
            }
            Step::Leave(node) => {
                let mut count = 0;
                each_child(node, |_| count += 1);
                let children = done.split_off(done.len() - count);
                let mut resolved = children.iter();
                let mut moved = false;
                each_child(node, |child| moved |= !resolved.next().is_some_and(|now| Arc::ptr_eq(now, child)));
                done.push(rebuilt(node, children, moved, namespaces));
            }
        }
    }
    done.pop().expect("the root is resolved")
}

/// Every child, in source order, as the tree holds it.
fn each_child<'a>(node: &'a CelNode, mut visit: impl FnMut(&'a Arc<CelNode>)) {
    match node {
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_) => {}
        CelNode::List(node) => node.elements.iter().for_each(|element| visit(&element.value)),
        CelNode::Map(node) => node.entries.iter().for_each(|entry| {
            visit(&entry.key);
            visit(&entry.value);
        }),
        CelNode::Select(node) => visit(&node.operand),
        CelNode::Index(node) => {
            visit(&node.operand);
            visit(&node.index);
        }
        CelNode::Call(node) => node.args.iter().for_each(visit),
        CelNode::ReceiverCall(node) => {
            visit(&node.receiver);
            node.args.iter().for_each(visit);
        }
        CelNode::QualifiedCall(node) => node.args.iter().for_each(visit),
        CelNode::Unary(node) => visit(&node.operand),
        CelNode::Binary(node) => {
            visit(&node.left);
            visit(&node.right);
        }
        CelNode::Conditional(node) => {
            visit(&node.condition);
            visit(&node.when_true);
            visit(&node.when_false);
        }
    }
}

/// The namespace a receiver call is written on, when its receiver names one.
fn namespace_of<'a>(receiver: &'a CelNode, namespaces: &[&str]) -> Option<&'a CelIdentNode> {
    match receiver {
        // An absolute name denotes a value the environment declares, never a namespace:
        // a namespaced call has one spelling, and `.Alias.fn(x)` is not it.
        CelNode::Ident(name) if !name.absolute && namespaces.contains(&name.name.as_str()) => Some(name),
        _ => None,
    }
}

fn next(children: &mut std::vec::IntoIter<Arc<CelNode>>) -> Arc<CelNode> {
    children.next().expect("one resolved child for each child")
}

/// The node over its resolved children: the node itself when none moved and it is not
/// a call on a namespace.
fn rebuilt(original: &Arc<CelNode>, children: Vec<Arc<CelNode>>, moved: bool, namespaces: &[&str]) -> Arc<CelNode> {
    let on_namespace = matches!(&**original, CelNode::ReceiverCall(_)) && namespace_of(&children[0], namespaces).is_some();
    if !moved && !on_namespace {
        return Arc::clone(original);
    }
    let mut children = children.into_iter();
    let children = &mut children;
    Arc::new(match &**original {
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_) => return Arc::clone(original),
        CelNode::List(node) => CelNode::List(CelListNode {
            elements: node.elements.iter().map(|element| CelListElement { value: next(children), optional: element.optional }).collect(),
            range: node.range,
        }),
        CelNode::Map(node) => CelNode::Map(CelMapNode {
            entries: node
                .entries
                .iter()
                .map(|entry| {
                    let key = next(children);
                    CelMapEntry { key, value: next(children), optional: entry.optional }
                })
                .collect(),
            range: node.range,
        }),
        CelNode::Select(node) => CelNode::Select(CelSelectNode {
            operand: next(children),
            field: node.field.clone(),
            field_range: node.field_range,
            optional: node.optional,
            quoted: node.quoted,
            range: node.range,
        }),
        CelNode::Index(node) => {
            let operand = next(children);
            CelNode::Index(CelIndexNode { operand, index: next(children), optional: node.optional, range: node.range })
        }
        CelNode::Call(node) => CelNode::Call(CelCallNode {
            name: node.name.clone(),
            name_range: node.name_range,
            args: children.collect(),
            range: node.range,
        }),
        CelNode::QualifiedCall(node) => CelNode::QualifiedCall(CelQualifiedCallNode {
            namespace: node.namespace.clone(),
            namespace_range: node.namespace_range,
            name: node.name.clone(),
            name_range: node.name_range,
            args: children.collect(),
            range: node.range,
        }),
        CelNode::ReceiverCall(node) => {
            let receiver = next(children);
            let args = children.collect();
            match namespace_of(&receiver, namespaces) {
                Some(namespace) => CelNode::QualifiedCall(CelQualifiedCallNode {
                    namespace: namespace.name.clone(),
                    namespace_range: namespace.range,
                    name: node.name.clone(),
                    name_range: node.name_range,
                    args,
                    range: node.range,
                }),
                None => CelNode::ReceiverCall(CelReceiverCallNode {
                    receiver,
                    name: node.name.clone(),
                    name_range: node.name_range,
                    args,
                    range: node.range,
                }),
            }
        }
        CelNode::Unary(node) => CelNode::Unary(CelUnaryNode { operator: node.operator, operand: next(children), range: node.range }),
        CelNode::Binary(node) => {
            let left = next(children);
            CelNode::Binary(CelBinaryNode { operator: node.operator, left, right: next(children), range: node.range })
        }
        CelNode::Conditional(node) => {
            let condition = next(children);
            let when_true = next(children);
            CelNode::Conditional(CelConditionalNode { condition, when_true, when_false: next(children), range: node.range })
        }
    })
}
