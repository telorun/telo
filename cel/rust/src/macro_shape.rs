//! Whether each macro call is shaped like one at all, judged before any type is read —
//! `macro-shape.ts`.
//!
//! A macro's own arguments are not values: `xs.map(i, …)` declares the name `i`, and
//! `has(a.b)` asks about the member `b`. Neither is something a type can be wrong about, so
//! this is a structural pass over the whole tree and it runs first: the typing of a macro's
//! body depends on a name the call may have failed to declare.
//!
//! The walk is post-order, so the innermost mistake is reported first, and it runs on a
//! heap list.
//!
//! Everything here is private to the crate, as on Node's entry.

use crate::check_diagnostic::CelCheckCode;
use crate::comprehension_bindings::{namespace_macro_binding, receiver_macro_binding};
use crate::syntax_tree::{each_shared_child, CelNode, SourceRange};

pub(crate) struct MacroShapeFinding {
    pub(crate) code: CelCheckCode,
    pub(crate) message: String,
    pub(crate) range: SourceRange,
}

/// Every macro call whose own arguments are not the shape it takes, innermost first.
pub(crate) fn macro_shape_findings(root: &CelNode) -> Vec<MacroShapeFinding> {
    let mut findings = Vec::new();
    // A node is judged once every child below it has been.
    let mut pending: Vec<(&CelNode, bool)> = vec![(root, false)];
    while let Some((node, children_judged)) = pending.pop() {
        if children_judged {
            findings.extend(shape_of(node));
            continue;
        }
        pending.push((node, true));
        let from = pending.len();
        each_shared_child(node, |child| pending.push((child, false)));
        pending[from..].reverse();
    }
    findings
}

fn shape_of(node: &CelNode) -> Option<MacroShapeFinding> {
    match node {
        CelNode::Call(call) if call.name == "has" && call.args.len() == 1 => {
            let argument = &call.args[0];
            if matches!(&**argument, CelNode::Select(select) if !select.field.is_empty()) {
                return None;
            }
            Some(MacroShapeFinding {
                code: CelCheckCode::InvalidArgument,
                message: "has() asks whether a member is there, so it takes a member read: write has(a.b)".into(),
                range: argument.range(),
            })
        }
        CelNode::ReceiverCall(call) => {
            let namespace = match &*call.receiver {
                CelNode::Ident(ident) => ident.name.as_str(),
                _ => "",
            };
            let binding = receiver_macro_binding(&call.name, call.args.len())
                .or_else(|| namespace_macro_binding(namespace, &call.name, call.args.len()))?;
            let variable = &call.args[binding.variable_argument];
            if matches!(&**variable, CelNode::Ident(_)) {
                return None;
            }
            Some(MacroShapeFinding {
                code: CelCheckCode::InvalidArgument,
                message: format!("{} binds a name here, and this is not a name", call.name),
                range: variable.range(),
            })
        }
        _ => None,
    }
}
