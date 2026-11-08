//! Every function call in a CEL expression, reported for the caller that judges it —
//! `diagnose.ts`.
//!
//! The engine's checker decides every verdict about a call — an unknown name, a name
//! called in the other form, a type no overload takes, a refusal over a literal argument —
//! so nothing here classifies. What is left is Telo's half: the call list, which the
//! analyzer needs to judge whether a module call reaches a function at all.
//!
//! Node items with no twin: `explainUnresolved`, which nothing calls; and `CelCallAudit`
//! as a narrowing of `CallAudit` — [`CallAudit`] here holds coded diagnostics itself.
//!
//! `map_value_type` is Node's as Node answers: it reads a `map(K, V)` type while the engine
//! prints `map<K, V>`, so a map-literal argument's entry that is not itself a literal never
//! gets a type. A test pins that reading as interim.

use std::sync::Arc;

use telorun_cel::{CelEnvironment, CelExpression, CelNode, CheckResult, SourceRange};
use telorun_cel_value::es_trim;

use crate::cel::analyze::module_call_argument_chains;
use crate::cel::literal_argument::{literal_type_of, literal_value_of, map_literal_entries};
use crate::cel::module_call::module_call_nodes;
use crate::cel::verdict_codes::CelDiagnostic;
use crate::engine::{CallArgument, CallArgumentEntry, CallSite, ModuleCallFlagValues};

/// What one audit establishes. The two diagnostic lists stay because the analyzer reads
/// them; the checker decides every verdict about a call, so they are always empty here.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct CallAudit {
    pub diagnostics: Vec<CelDiagnostic>,
    /// Every call, in source order.
    pub calls: Vec<CallSite>,
    /// Names a type-check failure mentions that resolved to nothing.
    pub unresolved: Vec<String>,
    /// Refusals over a literal argument.
    pub argument_issues: Vec<CelDiagnostic>,
}

/// The flags a module function carries as the host derives them, or `None` where the name
/// reaches no function — absent is "no signal", never "deterministic".
pub type ModuleCallFlags<'a> = &'a dyn Fn(&str) -> Option<ModuleCallFlagValues>;

/// Every call the expression makes, with what the checker resolved about it. A module call
/// carries no catalog flag: its determinism and host-backedness are the host's, carried
/// only as `module_call_flags` reports them.
pub fn audit_calls(
    source: &str,
    root: &Arc<CelNode>,
    environment: &CelEnvironment,
    module_call_flags: Option<ModuleCallFlags<'_>>,
    checked: Option<&CheckResult>,
) -> CallAudit {
    let owned;
    let result = match checked {
        Some(result) => result,
        None => {
            let expression = CelExpression {
                source: source.into(),
                root: Arc::clone(root),
                namespaces: environment.namespaces().into(),
                diagnostic: None,
            };
            owned = environment.check_parsed(&expression).expect("the tree is resolved under the environment's own names");
            &owned
        }
    };
    let chains = module_call_argument_chains(root);
    let argument_nodes: Vec<(SourceRange, &[Arc<CelNode>])> =
        module_call_nodes(root).into_iter().map(|(node, call)| (node.range(), call.args)).collect();

    // One entry per call: the checker lists a qualified call itself, with its namespace set.
    let mut calls: Vec<CallSite> = Vec::new();
    for call in &result.calls {
        let qualified = call.namespace.is_some();
        let flags = if qualified { module_call_flags.and_then(|flags| flags(&call.name)) } else { None };
        let call_chains = if qualified { chains.iter().find(|(range, _)| *range == call.range).map(|(_, held)| held) } else { None };
        let nodes = if qualified {
            argument_nodes.iter().find(|(range, _)| *range == call.range).map(|(_, held)| *held)
        } else {
            None
        };
        let arguments = match (&call.argument_types, qualified) {
            (Some(types), true) => Some(
                types
                    .iter()
                    .enumerate()
                    .map(|(at, type_name)| {
                        let node = nodes.and_then(|nodes| nodes.get(at)).map(|node| &**node);
                        CallArgument {
                            type_name: (type_name != "dyn").then(|| type_name.clone()),
                            chain: call_chains.and_then(|held| held.get(at).cloned().flatten()),
                            literal: node.and_then(literal_value_of),
                            entries: node.and_then(map_literal_entries).map(|entries| {
                                entries
                                    .into_iter()
                                    .map(|entry| CallArgumentEntry {
                                        key: entry.key.into(),
                                        type_name: literal_type_of(entry.value)
                                            .map(str::to_owned)
                                            .or_else(|| map_value_type(type_name)),
                                    })
                                    .collect()
                            }),
                        }
                    })
                    .collect(),
            ),
            _ => None,
        };
        let (deterministic, host_backed) = if qualified {
            flags.map_or((None, None), |flags| (Some(flags.deterministic), Some(flags.host_backed)))
        } else {
            (call.deterministic, call.host_backed)
        };
        calls.push(CallSite {
            name: call.name.clone(),
            form: call.form,
            module_call: qualified,
            arity: call.arity,
            arguments,
            start: call.range.start as usize,
            end: call.range.end as usize,
            deterministic,
            host_backed,
        });
    }
    calls.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)));
    CallAudit { diagnostics: Vec::new(), calls, unresolved: Vec::new(), argument_issues: Vec::new() }
}

/// The value type a `map(K, V)` type names, unless it is `dyn`.
pub fn map_value_type(type_name: &str) -> Option<String> {
    let inner = type_name.strip_prefix("map(")?.strip_suffix(')')?;
    let mut depth = 0i32;
    for (at, character) in inner.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                let value = es_trim(&inner[at + 1..]);
                return (value != "dyn").then(|| value.to_owned());
            }
            _ => {}
        }
    }
    None
}
