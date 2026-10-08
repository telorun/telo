//! What an expression reads from its environment — `root-references.ts`.
//!
//! The answer is the first identifier of every access chain — `request` in
//! `request.query.limit`, `xs` in `xs[0].id` — with three exclusions, each of which
//! would otherwise invent a dependency the expression does not have:
//!
//! - a name a comprehension or `cel.bind` binds, which the expression supplies itself;
//! - the namespace of a qualified call, which names a module rather than a value;
//! - the receiver of a call on a reserved namespace (`cel.bind(…)`, `optional.of(…)`),
//!   for the same reason.
//!
//! A function name is not an identifier node, so no call name can be mistaken for a
//! read. Field names are not nodes either, which is why only the root of a chain is
//! answered.
//!
//! The result is sorted and deduplicated: it is a set of names. The order is the one
//! Node sorts in, by UTF-16 code unit.
//!
//! The query runs on a heap work list and costs no stack, whatever the depth of the
//! tree.

use std::collections::{HashMap, HashSet};

use crate::comprehension_bindings::{namespace_macro_binding, receiver_macro_binding};
use crate::namespace_resolution::RESERVED_NAMESPACES;
use crate::syntax_tree::{CelNode, CelReceiverCallNode};

#[derive(Default)]
struct BoundNames<'a> {
    depth: HashMap<&'a str, usize>,
}

impl<'a> BoundNames<'a> {
    fn bind(&mut self, name: &'a str) {
        *self.depth.entry(name).or_insert(0) += 1;
    }

    fn unbind(&mut self, name: &'a str) {
        match self.depth.get_mut(name) {
            Some(held) if *held > 1 => *held -= 1,
            _ => {
                self.depth.remove(name);
            }
        }
    }

    fn has(&self, name: &str) -> bool {
        self.depth.contains_key(name)
    }
}

/// What is left to do, the next thing last.
enum Step<'a> {
    Collect(&'a CelNode),
    Bind(&'a str),
    Unbind(&'a str),
}

/// Every name the expression reads from its environment, sorted.
pub fn root_references(root: &CelNode) -> Vec<String> {
    let mut found: HashSet<&str> = HashSet::new();
    let mut bound = BoundNames::default();
    let mut pending = vec![Step::Collect(root)];
    while let Some(step) = pending.pop() {
        let node = match step {
            Step::Collect(node) => node,
            Step::Bind(name) => {
                bound.bind(name);
                continue;
            }
            Step::Unbind(name) => {
                bound.unbind(name);
                continue;
            }
        };
        let from = pending.len();
        match node {
            CelNode::Ident(node) => {
                // An absolute name reads past every binding by construction, so a
                // binding of the same name says nothing about it.
                if node.absolute || !bound.has(&node.name) {
                    found.insert(&node.name);
                }
            }
            CelNode::Literal(_) | CelNode::Unparsed(_) => {}
            CelNode::ReceiverCall(node) => push_call(node, &mut pending),
            CelNode::List(node) => pending.extend(node.elements.iter().map(|element| Step::Collect(&element.value))),
            CelNode::Map(node) => {
                for entry in &node.entries {
                    pending.push(Step::Collect(&entry.key));
                    pending.push(Step::Collect(&entry.value));
                }
            }
            CelNode::Select(node) => pending.push(Step::Collect(&node.operand)),
            CelNode::Index(node) => {
                pending.push(Step::Collect(&node.operand));
                pending.push(Step::Collect(&node.index));
            }
            CelNode::Call(node) => pending.extend(node.args.iter().map(|argument| Step::Collect(argument))),
            CelNode::QualifiedCall(node) => pending.extend(node.args.iter().map(|argument| Step::Collect(argument))),
            CelNode::Unary(node) => pending.push(Step::Collect(&node.operand)),
            CelNode::Binary(node) => {
                pending.push(Step::Collect(&node.left));
                pending.push(Step::Collect(&node.right));
            }
            CelNode::Conditional(node) => {
                pending.push(Step::Collect(&node.condition));
                pending.push(Step::Collect(&node.when_true));
                pending.push(Step::Collect(&node.when_false));
            }
        }
        // Steps were pushed in the order they run, and the list hands out its last.
        pending[from..].reverse();
    }
    let mut names: Vec<String> = found.into_iter().map(str::to_string).collect();
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    names
}

/// The steps of a call on a receiver, in the order they run: what is outside the
/// binding's reach, then the bound name around the arguments it reaches.
fn push_call<'a>(node: &'a CelReceiverCallNode, pending: &mut Vec<Step<'a>>) {
    let namespace = match &*node.receiver {
        CelNode::Ident(receiver) if RESERVED_NAMESPACES.contains(&receiver.name.as_str()) => Some(&receiver.name),
        _ => None,
    };
    let binding = match namespace {
        Some(namespace) => namespace_macro_binding(namespace, &node.name, node.args.len()),
        None => receiver_macro_binding(&node.name, node.args.len()),
    };
    if namespace.is_none() {
        pending.push(Step::Collect(&node.receiver));
    }

    let bound = binding.and_then(|binding| match node.args.get(binding.variable_argument).map(|argument| &**argument) {
        Some(CelNode::Ident(variable)) => Some((binding, variable.name.as_str())),
        _ => None,
    });
    let Some((binding, variable)) = bound else {
        pending.extend(node.args.iter().map(|argument| Step::Collect(argument)));
        return;
    };

    for (at, argument) in node.args.iter().enumerate() {
        if at != binding.variable_argument && !binding.scoped_arguments.contains(&at) {
            pending.push(Step::Collect(argument));
        }
    }
    pending.push(Step::Bind(variable));
    for at in binding.scoped_arguments {
        if let Some(argument) = node.args.get(*at) {
            pending.push(Step::Collect(argument));
        }
    }
    pending.push(Step::Unbind(variable));
}
