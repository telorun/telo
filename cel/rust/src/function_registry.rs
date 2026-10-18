//! Which functions an environment has, and which one a call resolves to —
//! `function-registry.ts`.
//!
//! Nothing here is privileged: the standard library registers through exactly this
//! surface. Registration is last-wins by dispatch key, a replacement keeping its place;
//! removal is by the same key. Resolution answers why it failed — an unknown name, the
//! other call form, or no overload taking the arguments — with the candidates it
//! considered.
//!
//! Matching an argument against a parameter runs on a heap work list, binding type
//! parameters left to right as Node's recursion does and stopping at the first part
//! that does not fit.
//!
//! Node items with no twin in this file: none.

use std::collections::HashMap;
use std::sync::Arc;

use telorun_cel_value::compare_code_units;

use crate::cel_type::{assignable, format_type, is_dyn, types_equal, CelType, ListType, MapType, NominalType, OptionalType, DYN};
use crate::check_diagnostic::{CelEngineError, CelEngineErrorCode};
use crate::reserved_words::{is_identifier_spelling, is_reserved_word};
use crate::runtime_library::CALL_SITE_DIRECT_ARITY;
use crate::signature::{format_signature, signature_key, CallForm, CelSignature, FunctionMetadata};

#[derive(Clone, Debug)]
pub struct RegisteredFunction {
    pub signature: CelSignature,
    pub metadata: FunctionMetadata,
}

/// Why a call resolved to nothing.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ResolutionFailureReason {
    /// No function of that name is registered, in any form.
    Unknown,
    /// The name is registered, but only in the other call form.
    WrongForm,
    /// The name and form are registered; no overload takes these arguments.
    NoOverload,
}

impl ResolutionFailureReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ResolutionFailureReason::Unknown => "unknown",
            ResolutionFailureReason::WrongForm => "wrong-form",
            ResolutionFailureReason::NoOverload => "no-overload",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResolutionFailure {
    pub reason: ResolutionFailureReason,
    pub candidates: Vec<Arc<RegisteredFunction>>,
}

#[derive(Clone, Debug)]
pub struct Resolution {
    pub resolved: Arc<RegisteredFunction>,
    /// The return type with every type parameter substituted by what this call bound.
    pub returns: CelType,
}

/// How many names a refused call may name as candidates — declared, because a message
/// naming them is pinned byte for byte.
pub const UNKNOWN_FUNCTION_CANDIDATES: usize = 5;

/// What a receiver call written on nothing is matched as.
static DYN_TYPE: CelType = DYN;

/// A registration and its dispatch key.
#[derive(Clone)]
struct Entry {
    key: String,
    function: Arc<RegisteredFunction>,
}

#[derive(Clone, Default)]
pub struct FunctionRegistry {
    by_name: HashMap<String, Vec<Entry>>,
}

impl FunctionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a function, replacing any registration answering the same call. A
    /// signature taking more values than an implementation receives is refused.
    pub fn register(&mut self, signature: CelSignature, metadata: FunctionMetadata) -> Result<(), CelEngineError> {
        let arity = signature.parameters.len() + usize::from(signature.receiver.is_some());
        if arity > CALL_SITE_DIRECT_ARITY {
            return Err(CelEngineError {
                code: CelEngineErrorCode::SignatureTooWide,
                message: format!(
                    "{} takes {arity} values and an implementation receives at most {CALL_SITE_DIRECT_ARITY}",
                    format_signature(&signature)
                ),
            });
        }
        let key = signature_key(&signature);
        let entries = self.by_name.entry(signature.name.clone()).or_default();
        let entry = Entry { key, function: Arc::new(RegisteredFunction { signature, metadata }) };
        match entries.iter_mut().find(|held| held.key == entry.key) {
            Some(held) => *held = entry,
            None => entries.push(entry),
        }
        Ok(())
    }

    /// Removes the one registration answering that call. Answers whether it was there.
    pub fn remove(&mut self, signature: &CelSignature) -> bool {
        let Some(entries) = self.by_name.get_mut(&signature.name) else { return false };
        let key = signature_key(signature);
        let Some(at) = entries.iter().position(|entry| entry.key == key) else { return false };
        entries.remove(at);
        if entries.is_empty() {
            self.by_name.remove(&signature.name);
        }
        true
    }

    /// Removes every registration of a name. Answers how many went.
    pub fn remove_name(&mut self, name: &str) -> usize {
        self.by_name.remove(name).map_or(0, |entries| entries.len())
    }

    pub fn has(&self, name: &str) -> bool {
        self.by_name.contains_key(name)
    }

    /// Every registration, in name order (UTF-16 code units) then registration order.
    pub fn list(&self) -> Vec<Arc<RegisteredFunction>> {
        let mut names: Vec<&String> = self.by_name.keys().collect();
        names.sort_by(|left, right| compare_code_units(left, right));
        names.into_iter().flat_map(|name| self.by_name[name].iter().map(|entry| Arc::clone(&entry.function))).collect()
    }

    pub fn named(&self, name: &str) -> Vec<Arc<RegisteredFunction>> {
        self.by_name
            .get(name)
            .map(|entries| entries.iter().map(|entry| Arc::clone(&entry.function)).collect())
            .unwrap_or_default()
    }

    /// The names that would accept a call of that form and arity, nearest first: edit
    /// distance over UTF-16 code units, then name, at most
    /// [`UNKNOWN_FUNCTION_CANDIDATES`]. A name that is not a name is never offered.
    pub fn candidate_names(&self, wanted: &str, form: CallForm, arity: usize) -> Vec<String> {
        let wanted_units: Vec<u16> = wanted.encode_utf16().collect();
        let mut matching: Vec<(usize, &String)> = self
            .by_name
            .iter()
            .filter(|(name, _)| name.as_str() != wanted)
            .filter(|(name, _)| is_identifier_spelling(name) && !is_reserved_word(name))
            .filter(|(_, entries)| {
                entries.iter().any(|entry| {
                    entry.function.signature.form() == form && entry.function.signature.parameters.len() == arity
                })
            })
            .map(|(name, _)| (edit_distance(&wanted_units, &name.encode_utf16().collect::<Vec<_>>()), name))
            .collect();
        matching.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| compare_code_units(left.1, right.1)));
        matching.into_iter().take(UNKNOWN_FUNCTION_CANDIDATES).map(|(_, name)| name.clone()).collect()
    }

    /// The function a call resolves to. `receiver` is the type the call is written on,
    /// absent for a global call.
    pub fn resolve(
        &self,
        name: &str,
        form: CallForm,
        args: &[CelType],
        receiver: Option<&CelType>,
    ) -> Result<Resolution, ResolutionFailure> {
        let all: Vec<&Arc<RegisteredFunction>> =
            self.by_name.get(name).map(|entries| entries.iter().map(|entry| &entry.function).collect()).unwrap_or_default();
        if all.is_empty() {
            return Err(ResolutionFailure { reason: ResolutionFailureReason::Unknown, candidates: Vec::new() });
        }
        let in_form: Vec<&Arc<RegisteredFunction>> =
            all.iter().copied().filter(|entry| entry.signature.form() == form).collect();
        if in_form.is_empty() {
            return Err(ResolutionFailure {
                reason: ResolutionFailureReason::WrongForm,
                candidates: all.into_iter().cloned().collect(),
            });
        }
        let arity: Vec<&Arc<RegisteredFunction>> =
            in_form.iter().copied().filter(|entry| entry.signature.parameters.len() == args.len()).collect();
        let viable = if arity.is_empty() { &in_form } else { &arity };
        // Exact first, then a candidate `dyn` makes viable.
        if let Some(exact) = viable.iter().find_map(|candidate| matched(candidate, args, receiver, false)) {
            return Ok(exact);
        }
        if let Some(loose) = match_loosely(viable, args, receiver) {
            return Ok(loose);
        }
        Err(ResolutionFailure {
            reason: ResolutionFailureReason::NoOverload,
            candidates: in_form.into_iter().cloned().collect(),
        })
    }
}

/// The loose pass: a `dyn` argument makes a candidate viable, and where several are
/// viable and disagree on their return type the call answers `dyn`, carrying the first.
fn match_loosely(candidates: &[&Arc<RegisteredFunction>], args: &[CelType], receiver: Option<&CelType>) -> Option<Resolution> {
    let viable: Vec<Resolution> =
        candidates.iter().filter_map(|candidate| matched(candidate, args, receiver, true)).collect();
    let first = viable.first()?;
    if viable.iter().all(|held| types_equal(&held.returns, &first.returns)) {
        Some(first.clone())
    } else {
        Some(Resolution { resolved: Arc::clone(&first.resolved), returns: DYN })
    }
}

fn matched(
    candidate: &Arc<RegisteredFunction>,
    args: &[CelType],
    receiver: Option<&CelType>,
    allow_dyn: bool,
) -> Option<Resolution> {
    let signature = &candidate.signature;
    if signature.parameters.len() != args.len() {
        return None;
    }
    // The receiver first, then each argument: one conjunction, asked in order.
    let mut pairs: Vec<(&CelType, &CelType)> = Vec::new();
    if let Some(wanted) = &signature.receiver {
        pairs.push((receiver.unwrap_or(&DYN_TYPE), wanted));
    }
    pairs.extend(args.iter().zip(signature.parameters.iter()));
    let mut bindings: HashMap<String, CelType> = HashMap::new();
    if !fits(&pairs, &mut bindings, allow_dyn) {
        return None;
    }
    Some(Resolution { resolved: Arc::clone(candidate), returns: substitute(&signature.returns, &bindings) })
}

/// Whether every argument fits its parameter, binding type parameters as it goes. A type
/// parameter is bound by the first argument that mentions it; a binding holding only an
/// unresolved parameter is refined by a later concrete argument.
fn fits(pairs: &[(&CelType, &CelType)], bindings: &mut HashMap<String, CelType>, allow_dyn: bool) -> bool {
    let mut pending: Vec<(&CelType, &CelType)> = pairs.iter().rev().copied().collect();
    while let Some((argument, parameter)) = pending.pop() {
        let held = match (argument, parameter) {
            (_, CelType::Parameter(parameter)) => {
                let name = parameter.name.to_string();
                match bindings.get(&name) {
                    None => {
                        bindings.insert(name, argument.clone());
                        true
                    }
                    Some(CelType::Parameter(_)) if !matches!(argument, CelType::Parameter(_)) => {
                        bindings.insert(name, argument.clone());
                        true
                    }
                    Some(CelType::Parameter(_)) => true,
                    Some(_) if matches!(argument, CelType::Parameter(_)) => true,
                    Some(bound) => assignable(argument, bound) || (allow_dyn && (is_dyn(argument) || is_dyn(bound))),
                }
            }
            (CelType::List(ListType { element: argument }), CelType::List(ListType { element: parameter })) => {
                pending.push((argument, parameter));
                true
            }
            (CelType::Map(MapType { key, value }), CelType::Map(wanted)) => {
                pending.push((value, &wanted.value));
                pending.push((key, &wanted.key));
                true
            }
            (CelType::Optional(OptionalType { value: argument }), CelType::Optional(OptionalType { value: parameter })) => {
                pending.push((argument, parameter));
                true
            }
            (CelType::Nominal(NominalType { name, args, .. }), CelType::Nominal(wanted))
                if *name == wanted.name && args.len() == wanted.args.len() =>
            {
                pending.extend(args.iter().zip(wanted.args.iter()).rev());
                true
            }
            _ if is_dyn(argument) => allow_dyn || is_dyn(parameter),
            _ => assignable(argument, parameter),
        };
        if !held {
            return false;
        }
    }
    true
}

/// The type with every bound parameter replaced; an unbound one stays as it is. A union
/// and a record are left as they are, as on Node.
pub fn substitute(ty: &CelType, bindings: &HashMap<String, CelType>) -> CelType {
    enum Task<'a> {
        Visit(&'a CelType),
        Rebuild(&'a CelType),
    }
    let mut results: Vec<(CelType, bool)> = Vec::new();
    let mut tasks = vec![Task::Visit(ty)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(ty) => {
                let children: Vec<&CelType> = match ty {
                    CelType::Parameter(parameter) => {
                        results.push(match bindings.get(&*parameter.name) {
                            Some(bound) => (bound.clone(), true),
                            None => (ty.clone(), false),
                        });
                        continue;
                    }
                    CelType::List(list) => vec![&list.element],
                    CelType::Map(map) => vec![&map.key, &map.value],
                    CelType::Optional(optional) => vec![&optional.value],
                    CelType::Nominal(nominal) => nominal.args.iter().collect(),
                    _ => {
                        results.push((ty.clone(), false));
                        continue;
                    }
                };
                tasks.push(Task::Rebuild(ty));
                tasks.extend(children.into_iter().rev().map(Task::Visit));
            }
            Task::Rebuild(ty) => {
                let count = match ty {
                    CelType::Map(_) => 2,
                    CelType::Nominal(nominal) => nominal.args.len(),
                    _ => 1,
                };
                let children = results.split_off(results.len() - count);
                if !children.iter().any(|(_, moved)| *moved) {
                    results.push((ty.clone(), false));
                    continue;
                }
                let mut children = children.into_iter().map(|(child, _)| child);
                let mut next = || children.next().expect("each child was substituted");
                let rebuilt = match ty {
                    CelType::List(_) => CelType::List(ListType { element: Arc::new(next()) }),
                    CelType::Map(_) => {
                        let key = Arc::new(next());
                        CelType::Map(MapType { key, value: Arc::new(next()) })
                    }
                    CelType::Optional(_) => CelType::Optional(OptionalType { value: Arc::new(next()) }),
                    CelType::Nominal(nominal) => CelType::Nominal(NominalType {
                        args: (0..nominal.args.len()).map(|_| next()).collect::<Vec<_>>().into(),
                        ..nominal.clone()
                    }),
                    _ => unreachable!("only a type with children is rebuilt"),
                };
                results.push((rebuilt, true));
            }
        }
    }
    results.pop().expect("the root is substituted last").0
}

/// Levenshtein distance in UTF-16 code units.
fn edit_distance(from: &[u16], to: &[u16]) -> usize {
    let mut previous: Vec<usize> = (0..=to.len()).collect();
    for left in 1..=from.len() {
        let mut row = vec![0; to.len() + 1];
        row[0] = left;
        for right in 1..=to.len() {
            let substitution = previous[right - 1] + usize::from(from[left - 1] != to[right - 1]);
            row[right] = substitution.min(previous[right] + 1).min(row[right - 1] + 1);
        }
        previous = row;
    }
    previous[to.len()]
}

/// How a resolution failure names what it looked at.
pub fn describe_candidates(candidates: &[Arc<RegisteredFunction>]) -> String {
    candidates.iter().map(|candidate| format_signature(&candidate.signature)).collect::<Vec<_>>().join(", ")
}

pub fn describe_arguments(args: &[CelType]) -> String {
    args.iter().map(|ty| format_type(ty, false)).collect::<Vec<_>>().join(", ")
}
