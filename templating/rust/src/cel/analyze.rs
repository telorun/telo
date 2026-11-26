//! What an expression reads — `analyze.ts`.
//!
//! - Member-access chains (`request.query.name`), with a comprehension's or `cel.bind`'s
//!   bound name dropped, a resolved module call's receiver skipped, and an optional read
//!   ending the chain; the read chains, which follow a comprehension variable instead.
//! - Each module call's argument chains, and member reads off a module call's result.
//! - Nullable access: a member read on a value whose schema admits null, unguarded by a
//!   `!= null` / `== null` test flowing through `?:`, `&&` and `||`.
//!
//! The walks recurse over the tree, whose height the reader bounds (250 by default).
//!
//! Node items with no twin: `validateChainAgainstSchema` — a chain judged against a context
//! schema — and `schemaConjuncts`, which reads a node as its `allOf` conjunction. Their
//! consumers are the Node analyzer's (a catch entry's `error.data` reads, its plain-literal
//! decoding); every other member read is the engine's verdict, and nothing in Rust asks for
//! either.

use std::collections::HashSet;

use telorun_cel::{
    child_nodes, namespace_macro_binding, receiver_macro_binding, CelBinaryOperator, CelNode,
    SourceRange, RESERVED_NAMESPACES,
};

use crate::cel::module_call::{module_call_of, ModuleCall};

/// The chain segment for index access (`obj[expr]`), a member no static name resolves.
pub const INDEX_SEGMENT: &str = "[*]";

/// The chain segment for "each element of the collection reached so far".
pub const EACH_SEGMENT: &str = "[]";

/// The chain segment for "whether the member exists": the last segment of a chain a
/// presence test (`has(a.b)`) reads.
pub const PRESENCE_SEGMENT: &str = "?";

/// The chain segment for "each element of the range, read whole", after [`EACH_SEGMENT`]: a bare
/// use of the iteration variable, or the range of an `in` test. Over a list it reads every
/// element; over a map only the keys, which the variable and the tested value stand for there.
pub const ELEMENT_SEGMENT: &str = "[]!";

/// Every member-access chain of the tree, in walk order. A chain rooted at a call or a
/// non-identifier is not one; a name a comprehension or `cel.bind` binds is not a root
/// inside what it scopes; a resolved module call's receiver is not a root.
pub fn extract_access_chains(node: &CelNode) -> Vec<Vec<String>> {
    let mut chains = Vec::new();
    visit_node(node, &mut chains, &HashSet::new(), &mut |_, _, _| {});
    chains
}

/// Each resolved module call's arguments as plain member chains, keyed by the call's range:
/// `None` for an argument that is not one, or that is rooted at a name the expression binds.
pub fn module_call_argument_chains(node: &CelNode) -> Vec<(SourceRange, Vec<Option<Vec<String>>>)> {
    let mut out = Vec::new();
    visit_node(node, &mut Vec::new(), &HashSet::new(), &mut |call, call_node, bound| {
        out.push((call_node.range(), call.args.iter().map(|arg| extract_chain(arg, bound)).collect()));
    });
    out
}

type ModuleCallVisitor<'v> = dyn FnMut(&ModuleCall<'_>, &CelNode, &HashSet<String>) + 'v;

/// `cel.bind(name, init, body)`: a receiver call on the identifier `cel`, the reserved
/// namespace no host can claim. The receiver contributes no chain.
struct Bind<'a> {
    name: &'a str,
    init: &'a CelNode,
    body: &'a CelNode,
}

fn bind_call(node: &CelNode) -> Option<Bind<'_>> {
    let CelNode::ReceiverCall(call) = node else { return None };
    let CelNode::Ident(receiver) = &*call.receiver else { return None };
    if receiver.name != "cel" {
        return None;
    }
    let binding = namespace_macro_binding("cel", &call.name, call.args.len())?;
    let CelNode::Ident(name) = &**call.args.get(binding.variable_argument)? else { return None };
    let scoped = binding.scoped_arguments;
    let body = call.args.get(*scoped.last()?)?;
    let init = call
        .args
        .iter()
        .enumerate()
        .find(|(at, _)| *at != binding.variable_argument && !scoped.contains(at))
        .map(|(_, arg)| arg)?;
    Some(Bind { name: &name.name, init, body })
}

/// A comprehension macro's receiver, its iteration variable and the arguments it scopes,
/// from the engine's binding table.
struct Comprehension<'a> {
    receiver: &'a CelNode,
    bound: &'a str,
    scoped: Vec<&'a CelNode>,
}

fn comprehension(node: &CelNode) -> Option<Comprehension<'_>> {
    let CelNode::ReceiverCall(call) = node else { return None };
    if matches!(&*call.receiver, CelNode::Ident(receiver) if receiver.name == "cel") {
        return None;
    }
    let binding = receiver_macro_binding(&call.name, call.args.len())?;
    let CelNode::Ident(name) = &**call.args.get(binding.variable_argument)? else { return None };
    Some(Comprehension {
        receiver: &call.receiver,
        bound: &name.name,
        scoped: binding.scoped_arguments.iter().filter_map(|at| call.args.get(*at).map(|arg| &**arg)).collect(),
    })
}

fn with_bound(bound: &HashSet<String>, name: &str) -> HashSet<String> {
    let mut inner = bound.clone();
    inner.insert(name.into());
    inner
}

fn visit_node(
    node: &CelNode,
    chains: &mut Vec<Vec<String>>,
    bound: &HashSet<String>,
    on_module_call: &mut ModuleCallVisitor<'_>,
) {
    if let Some(chain) = extract_chain(node, bound) {
        chains.push(chain);
        return;
    }
    if let Some(call) = module_call_of(node) {
        on_module_call(&call, node, bound);
        for arg in call.args {
            visit_node(arg, chains, bound, on_module_call);
        }
        return;
    }
    // The bound name is in scope for the body only; `init` is read in the enclosing scope.
    if let Some(bind) = bind_call(node) {
        visit_node(bind.init, chains, bound, on_module_call);
        visit_node(bind.body, chains, &with_bound(bound, bind.name), on_module_call);
        return;
    }
    // A call on a reserved namespace (`optional.of(x)`) names a function, never a value: its
    // receiver is no read.
    if let CelNode::ReceiverCall(call) = node {
        if matches!(&*call.receiver, CelNode::Ident(receiver) if RESERVED_NAMESPACES.iter().any(|name| receiver.name == *name)) {
            for arg in &call.args {
                visit_node(arg, chains, bound, on_module_call);
            }
            return;
        }
    }
    if let Some(macro_call) = comprehension(node) {
        // The receiver is evaluated outside the binding; only the scoped arguments see it.
        visit_node(macro_call.receiver, chains, bound, on_module_call);
        let inner = with_bound(bound, macro_call.bound);
        for arg in macro_call.scoped {
            visit_node(arg, chains, &inner, on_module_call);
        }
        return;
    }
    for child in child_nodes(node) {
        visit_node(child, chains, bound, on_module_call);
    }
}

/// The chain a node is, or `None`. An absolute name (`.y`) is never a bound one; an
/// optional read (`a.?b`, `a[?0]`) ends the chain, the author having said the member may be
/// absent.
fn extract_chain(node: &CelNode, bound: &HashSet<String>) -> Option<Vec<String>> {
    match node {
        CelNode::Ident(ident) => {
            if !ident.absolute && bound.contains(&ident.name) {
                return None;
            }
            Some(vec![ident.name.clone()])
        }
        CelNode::Select(select) if !select.optional => {
            let mut chain = extract_chain(&select.operand, bound)?;
            chain.push(select.field.clone());
            Some(chain)
        }
        CelNode::Index(index) if !index.optional => {
            let mut chain = extract_chain(&index.operand, bound)?;
            chain.push(INDEX_SEGMENT.into());
            Some(chain)
        }
        _ => None,
    }
}

/// The dotted form of a static member chain rooted at a free identifier, or `None` where
/// the node is no such chain (a call's result, an index, …).
pub fn plain_dotted_chain(node: &CelNode) -> Option<String> {
    let chain = extract_chain(node, &HashSet::new())?;
    if chain.iter().any(|segment| segment == INDEX_SEGMENT) {
        return None;
    }
    Some(chain.join("."))
}

/// The chain a member read is, its segments joined as a chain is written in a finding
/// (`items.[*].amount`), or `None` where it is not one. A module call's result is written
/// as the call (`Billing.total(…)`).
pub fn member_read_path(node: &CelNode) -> Option<String> {
    if let Some(call) = module_call_of(node) {
        return Some(format!("{}(…)", call.qualified));
    }
    match node {
        CelNode::Ident(ident) => Some(ident.name.clone()),
        CelNode::Select(select) if !select.optional => Some(format!("{}.{}", member_read_path(&select.operand)?, select.field)),
        CelNode::Index(index) if !index.optional => Some(format!("{}.{INDEX_SEGMENT}", member_read_path(&index.operand)?)),
        _ => None,
    }
}

/// What an expression reads of the values its roots name, as member chains —
/// [`extract_access_chains`] with a comprehension's iteration variable followed instead of
/// dropped: a member read through it is a read on each element of the range
/// (`xs.[].path`), a range only iterated ends in [`EACH_SEGMENT`], a bare use of it reads the
/// range whole, and a presence test reads only whether the member exists
/// ([`PRESENCE_SEGMENT`]). A variable whose range is not a plain chain contributes nothing.
pub fn extract_read_chains(node: &CelNode) -> Vec<Vec<String>> {
    let mut chains = Vec::new();
    visit_reads(node, &mut chains, &Vec::new(), false);
    chains
}

/// [`extract_read_chains`] told apart by what a range holds: a bare use of an iteration variable
/// and the range of an `in` test read `<range>.[].[]!` ([`ELEMENT_SEGMENT`]) — each element whole
/// over a list, and over a map nothing but its keys — where [`extract_read_chains`] reads the
/// range whole.
pub fn extract_value_read_chains(node: &CelNode) -> Vec<Vec<String>> {
    let mut chains = Vec::new();
    visit_reads(node, &mut chains, &Vec::new(), true);
    chains
}

/// A bound name's range as a chain, or `None` where it has none; the innermost binding of a
/// name is the last.
type BoundRanges = Vec<(String, Option<Vec<String>>)>;

fn bound_range<'b>(bound: &'b BoundRanges, name: &str) -> Option<&'b Option<Vec<String>>> {
    bound.iter().rev().find(|(held, _)| held == name).map(|(_, range)| range)
}

fn with_range(bound: &BoundRanges, name: &str, range: Option<Vec<String>>) -> BoundRanges {
    let mut inner = bound.clone();
    inner.push((name.into(), range));
    inner
}

fn read_chain_of(node: &CelNode, bound: &BoundRanges) -> Option<Vec<String>> {
    match node {
        CelNode::Ident(ident) => {
            if !ident.absolute {
                if let Some(range) = bound_range(bound, &ident.name) {
                    let mut chain = range.clone()?;
                    chain.push(EACH_SEGMENT.into());
                    return Some(chain);
                }
            }
            Some(vec![ident.name.clone()])
        }
        CelNode::Select(select) if !select.optional => {
            let mut chain = read_chain_of(&select.operand, bound)?;
            chain.push(select.field.clone());
            Some(chain)
        }
        CelNode::Index(index) if !index.optional => {
            let mut chain = read_chain_of(&index.operand, bound)?;
            chain.push(INDEX_SEGMENT.into());
            Some(chain)
        }
        _ => None,
    }
}

fn visit_reads(node: &CelNode, chains: &mut Vec<Vec<String>>, bound: &BoundRanges, value_reads: bool) {
    if let Some(mut chain) = read_chain_of(node, bound) {
        // The variable itself, with no member read off it: the whole element.
        if chain.last().is_some_and(|segment| segment == EACH_SEGMENT) {
            if value_reads {
                chain.push(ELEMENT_SEGMENT.into());
            } else {
                chain.pop();
            }
        }
        chains.push(chain);
        return;
    }
    if value_reads {
        // `k in m` tests a key of a map and an element of a list.
        if let CelNode::Binary(binary) = node {
            if binary.operator == CelBinaryOperator::In {
                if let Some(mut range) = read_chain_of(&binary.right, bound) {
                    if range.last().is_none_or(|segment| segment != EACH_SEGMENT) {
                        range.push(EACH_SEGMENT.into());
                        range.push(ELEMENT_SEGMENT.into());
                        chains.push(range);
                        visit_reads(&binary.left, chains, bound, value_reads);
                        return;
                    }
                }
            }
        }
    }
    if let Some(presence) = presence_operand(node) {
        if let Some(mut owner) = read_chain_of(presence, bound) {
            owner.push(PRESENCE_SEGMENT.into());
            chains.push(owner);
            return;
        }
    }
    if let Some(call) = module_call_of(node) {
        for arg in call.args {
            visit_reads(arg, chains, bound, value_reads);
        }
        return;
    }
    if let Some(bind) = bind_call(node) {
        visit_reads(bind.init, chains, bound, value_reads);
        visit_reads(bind.body, chains, &with_range(bound, bind.name, None), value_reads);
        return;
    }
    if let Some(macro_call) = comprehension(node) {
        let range = read_chain_of(macro_call.receiver, bound);
        match &range {
            Some(range) => {
                let mut each = range.clone();
                each.push(EACH_SEGMENT.into());
                chains.push(each);
            }
            None => visit_reads(macro_call.receiver, chains, bound, value_reads),
        }
        let inner = with_range(bound, macro_call.bound, range);
        for arg in macro_call.scoped {
            visit_reads(arg, chains, &inner, value_reads);
        }
        return;
    }
    for child in child_nodes(node) {
        visit_reads(child, chains, bound, value_reads);
    }
}

/// What a presence test `has(<operand>.<member>)` asks the keys of.
fn presence_operand(node: &CelNode) -> Option<&CelNode> {
    let CelNode::Call(call) = node else { return None };
    if call.name != "has" || call.args.len() != 1 {
        return None;
    }
    match &*call.args[0] {
        CelNode::Select(select) if !select.optional => Some(&select.operand),
        _ => None,
    }
}
