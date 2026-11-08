//! Module calls: what a resolved one says, the table a scope's module functions are
//! dispatched through, and the walks the analyzer asks of an expression's own names —
//! `module-call.ts`.
//!
//! A module call is a node kind of the engine's own (`QualifiedCall`), produced as the
//! expression is read against a name set, so reading one is reading a node kind.
//!
//! **The dispatch table is a typed argument, never an activation key.** Node binds a
//! scope's table on the activation under `@telo:module-functions`, a key outside CEL's
//! identifier grammar; here it is handed to [`CompiledValue::call`](crate::cel::compile::CompiledValue::call)
//! beside the activation, so no source can name it and there is no key to reserve.
//!
//! Node items with no twin: `MODULE_CALL_DISPATCH_KEY` (above); `ModuleCallTypeResolver`,
//! the type of `AnalyzeEnv.moduleCallType`, which no engine reads; and
//! `unboundModuleCallMessage`, which nothing calls — an unbound call answers the engine's
//! own `unbound function '<qualified>'` sentence.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use telorun_cel::{
    is_identifier_spelling, is_reserved_word, namespace_macro_binding, qualified_calls,
    receiver_macro_binding, walk_tree, CelNode, RESERVED_NAMESPACES,
};
use telorun_cel_value::CelValue;

/// One module function: handed its arguments in the form a host holds them, it answers a
/// value or the host's own failure, which ends the evaluation that called it.
pub type ModuleFunction<E> = Arc<dyn Fn(&[CelValue]) -> Result<CelValue, E> + Send + Sync>;

/// A scope's module functions, keyed by qualified name (`Billing.total`), the form the
/// kernel and the analyzer hold them in. The engine asks by namespace and name, which the
/// table answers without building the qualified string.
pub struct ModuleCallDispatch<E> {
    functions: Vec<ModuleFunction<E>>,
    by_qualified: HashMap<String, usize>,
    by_namespace: HashMap<String, HashMap<String, usize>>,
}

impl<E> ModuleCallDispatch<E> {
    /// A table of these functions; a qualified name given twice keeps the last.
    pub fn new(entries: impl IntoIterator<Item = (String, ModuleFunction<E>)>) -> Self {
        let mut table = Self { functions: Vec::new(), by_qualified: HashMap::new(), by_namespace: HashMap::new() };
        for (qualified, function) in entries {
            let at = table.functions.len();
            table.functions.push(function);
            if let Some((namespace, name)) = qualified.split_once('.') {
                table.by_namespace.entry(namespace.into()).or_default().insert(name.into(), at);
            }
            table.by_qualified.insert(qualified, at);
        }
        table
    }

    /// The function bound under a qualified name.
    pub fn get(&self, qualified: &str) -> Option<&ModuleFunction<E>> {
        self.by_qualified.get(qualified).map(|at| &self.functions[*at])
    }

    /// The function a call `namespace.name(…)` reaches.
    pub fn function(&self, namespace: &str, name: &str) -> Option<&ModuleFunction<E>> {
        self.by_namespace.get(namespace)?.get(name).map(|at| &self.functions[*at])
    }
}

impl<E> FromIterator<(String, ModuleFunction<E>)> for ModuleCallDispatch<E> {
    fn from_iter<I: IntoIterator<Item = (String, ModuleFunction<E>)>>(entries: I) -> Self {
        Self::new(entries)
    }
}

/// What a resolved module call says about itself.
pub struct ModuleCall<'a> {
    pub qualified: String,
    pub args: &'a [Arc<CelNode>],
}

/// The module call this node is, or nothing.
pub fn module_call_of(node: &CelNode) -> Option<ModuleCall<'_>> {
    match node {
        CelNode::QualifiedCall(call) => {
            Some(ModuleCall { qualified: format!("{}.{}", call.namespace, call.name), args: &call.args })
        }
        _ => None,
    }
}

/// Which of a module's own names CEL can read as a namespace. A name that is not spelled
/// as an identifier, is a reserved word, or is a reserved namespace resolves no call — its
/// naming diagnostic is what reports it — and handing it to the engine would refuse the
/// whole set.
pub fn cel_namespace_names<'a>(module_names: impl IntoIterator<Item = &'a String>) -> HashSet<String> {
    module_names
        .into_iter()
        .filter(|name| is_identifier_spelling(name) && !is_reserved_word(name))
        .filter(|name| !RESERVED_NAMESPACES.contains(&name.as_str()))
        .cloned()
        .collect()
}

/// Every resolved module call in the tree with its node, outermost first.
pub fn module_call_nodes(root: &CelNode) -> Vec<(&CelNode, ModuleCall<'_>)> {
    walk_tree(root).filter_map(|node| module_call_of(node).map(|call| (node, call))).collect()
}

/// Every qualified call's name, as written.
pub fn module_call_names(root: &CelNode) -> Vec<String> {
    qualified_calls(root).into_iter().map(|call| call.qualified_name).collect()
}

/// Bare identifiers that are the receiver of an unresolved call (`dbb.query(1)`), so the
/// caller reporting the root can ask whether such a name could denote a module at all.
pub fn unresolved_call_receivers(root: &CelNode, module_names: Option<&HashSet<String>>) -> HashSet<String> {
    walk_tree(root)
        .filter_map(|node| match node {
            CelNode::ReceiverCall(call) => match &*call.receiver {
                CelNode::Ident(receiver) if !module_names.is_some_and(|names| names.contains(&receiver.name)) => {
                    Some(receiver.name.clone())
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// Names bound inside the expression — a comprehension variable, a `cel.bind` name — that
/// collide with one of the module's names, each once, in the order the walk meets them.
/// Such a binding could never be read: `Billing.f(x)` beneath it resolves to the module.
pub fn module_name_bindings(root: &CelNode, module_names: Option<&HashSet<String>>) -> Vec<String> {
    let Some(names) = module_names.filter(|names| !names.is_empty()) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for node in walk_tree(root) {
        if let Some(bound) = bound_name_of(node) {
            if names.contains(bound) && !out.iter().any(|held| held == bound) {
                out.push(bound.into());
            }
        }
    }
    out
}

/// The name a binding form introduces, asked of the engine's binding table by name and
/// arity. `cel` is a reserved namespace, so `cel.bind(c, …)` is a receiver call on the
/// identifier `cel`, never a qualified call.
fn bound_name_of(node: &CelNode) -> Option<&str> {
    let CelNode::ReceiverCall(call) = node else { return None };
    let binding = match &*call.receiver {
        CelNode::Ident(receiver) if receiver.name == "cel" => {
            namespace_macro_binding("cel", &call.name, call.args.len())
        }
        _ => receiver_macro_binding(&call.name, call.args.len()),
    }?;
    match call.args.get(binding.variable_argument).map(|arg| &**arg) {
        Some(CelNode::Ident(held)) => Some(&held.name),
        _ => None,
    }
}
