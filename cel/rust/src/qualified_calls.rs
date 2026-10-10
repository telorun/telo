//! Every call an expression makes on a namespace — `qualified-calls.ts`.
//!
//! Only a resolved tree holds one, so the answer is always relative to the namespace
//! set the tree was resolved under. A consumer uses it to say which functions of which
//! other modules an expression reaches, which cannot be re-derived from the expression
//! alone: the name set is not in the text.
//!
//! The order is source order: a call before any call written inside it.

use crate::syntax_tree::{walk_tree, CelNode, SourceRange};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct QualifiedCall {
    pub namespace: String,
    pub name: String,
    /// `<namespace>.<name>`, the spelling the call was written with.
    pub qualified_name: String,
    pub arity: usize,
    pub range: SourceRange,
    pub name_range: SourceRange,
}

pub fn qualified_calls(root: &CelNode) -> Vec<QualifiedCall> {
    walk_tree(root)
        .filter_map(|node| match node {
            CelNode::QualifiedCall(node) => Some(QualifiedCall {
                namespace: node.namespace.clone(),
                name: node.name.clone(),
                qualified_name: format!("{}.{}", node.namespace, node.name),
                arity: node.args.len(),
                range: node.range,
                name_range: node.name_range,
            }),
            _ => None,
        })
        .collect()
}
