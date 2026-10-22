//! What the evaluator does at each kind of site — `backend-runtime.ts`.
//!
//! `runtime_library.rs` holds what every operator and standard function **does**. This
//! holds everything around a call: reading a name or a dotted chain, reading a member in
//! every form, `has()`'s presence question, taking a bool operand, an aggregate's
//! optional entry, and the per-call-site overload dispatch with its bounded cache.
//!
//! **What a program compiled against is a snapshot** ([`EnvironmentSnapshot`]): the
//! registry, the standard constants' values and each registered type's arity and field
//! names, shared with the environment until it registers anything, which copies first.
//! So a registration never reaches a program already compiled, and a call site answers
//! from one registry however long the program is held.
//!
//! **A call site** resolves its overload on the values' own types. Its first resolution
//! is published once and then read with no lock, by comparing the argument type names
//! against it; every other combination goes through a bounded per-site cache of
//! [`CALL_SITE_CACHE_CAPACITY`] entries, under a lock held only to look up and to insert —
//! never across a resolution or an implementation's call, so an implementation may
//! evaluate again. Resolution is a pure function of the snapshot and the types, so a site
//! answers the same cold as warm. Node's site holds its LAST resolution where this one
//! holds its first; nothing observes the difference.
//!
//! Node items with no twin in this file:
//! - `readHostValue`, `noCelTypeRefusal`'s `undefined` wording, the thenable check at
//!   dispatch and a host implementation's answer — no Rust value can be awaited or be
//!   `undefined`.
//! - `NamespaceImplementation` — it is [`CelImplementation`](crate::CelImplementation);
//!   `NamespaceDispatch` is `EvaluateOptions::namespace_function`'s type.
//! - `EvaluationFrame`, `CelStep`, `CompileTarget`, `MemberReads`, `memberReadsOf`,
//!   `callSiteOf` — the emitter-facing shape of a step; the evaluator's frame, its
//!   snapshot and its sites are crate-private here.
//! - `CallSite`'s array entry point `call` and its `call0` … `call4` — one entry point
//!   takes the arguments as a slice of the operand stack.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock};

use telorun_cel_value::{
    cel_error, cel_none, cel_some, cel_type_name_of, json_quote, CelEvaluationCode, CelValue, PropertyMap, SourceRange,
};

use crate::activation::CelActivation;
use crate::bounded_cache::BoundedCache;
use crate::cel_type::{list_of, map_of, optional_of, CelType, NominalType, BOOL, BYTES, DOUBLE, DURATION, DYN, INT, NULL, STRING, TIMESTAMP, TYPE, UINT};
use crate::function_registry::{FunctionRegistry, Resolution, ResolutionFailure};
use crate::member_read::{cel_has, cel_lookup, cel_read, lookup_absence, lookup_error, HostFields, Lookup};
use crate::runtime_library::{implementation_of, CelCallContext, CelImplementation, CALL_SITE_DIRECT_ARITY};
use crate::signature::{CallForm, CelSignature};

/// A tree no evaluation can be compiled from. Its message is Node's.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelCompileError {
    pub message: String,
}

impl fmt::Display for CelCompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelCompileError {}

pub(crate) fn compile_error(message: impl Into<String>) -> CelCompileError {
    CelCompileError { message: message.into() }
}

/// How many distinct argument-type combinations one call site remembers beside its first.
pub const CALL_SITE_CACHE_CAPACITY: usize = 16;

/// What a registered named type is at evaluation: how many type arguments it takes, for
/// dispatch on one of its values, and the fields the member-read seam answers of them.
#[derive(Clone, Debug)]
pub(crate) struct NominalRuntime {
    pub(crate) arity: usize,
    pub(crate) fields: Option<HashSet<String>>,
}

/// What a program compiled against, shared and never changed.
pub(crate) struct EnvironmentSnapshot {
    pub(crate) registry: Arc<FunctionRegistry>,
    /// The library's own names — the type values and `google`.
    pub(crate) constants: Arc<PropertyMap<CelValue>>,
    pub(crate) types: Arc<HashMap<String, NominalRuntime>>,
}

impl HostFields for EnvironmentSnapshot {
    fn declared(&self, type_name: &str) -> Option<&HashSet<String>> {
        self.types.get(type_name)?.fields.as_ref()
    }
}

// --- names -------------------------------------------------------------------

/// What a name reads: the activation's own entry, then the library's constants.
fn held_name(activation: &dyn CelActivation, snapshot: &EnvironmentSnapshot, name: &str) -> Option<CelValue> {
    activation.read(name).or_else(|| snapshot.constants.get(name).cloned())
}

fn no_such_variable(name: &str, range: SourceRange) -> CelValue {
    cel_error(CelEvaluationCode::NoSuchVariable, format!("no such variable: {name}"), Some(range)).into()
}

/// A bare name.
pub(crate) fn read_name(
    activation: &dyn CelActivation,
    snapshot: &EnvironmentSnapshot,
    name: &str,
    range: SourceRange,
) -> CelValue {
    held_name(activation, snapshot, name).unwrap_or_else(|| no_such_variable(name, range))
}

/// The members read off a chain's name, in order; the first error ends the chain.
fn read_rest(held: CelValue, rest: &[CelValue], range: SourceRange, snapshot: &EnvironmentSnapshot) -> CelValue {
    let mut held = held;
    for field in rest {
        if let CelValue::Error(_) = held {
            return held;
        }
        held = read_through(&held, field, false, range, snapshot);
    }
    held
}

/// A chain split at compile time over the names the host declared: one name, then its
/// members. A declared name the activation does not hold is `no_such_variable` for that
/// name, never a shorter prefix.
pub(crate) struct DeclaredNameChain {
    pub(crate) name: Box<str>,
    pub(crate) rest: Box<[CelValue]>,
}

pub(crate) fn read_name_chain(
    activation: &dyn CelActivation,
    snapshot: &EnvironmentSnapshot,
    chain: &DeclaredNameChain,
    range: SourceRange,
) -> CelValue {
    match held_name(activation, snapshot, &chain.name) {
        Some(held) => read_rest(held, &chain.rest, range, snapshot),
        None => no_such_variable(&chain.name, range),
    }
}

/// A chain **no** prefix of which the host declared, searched in the activation longest
/// prefix first. Each candidate is a prefix of one text, so the chain costs memory
/// linear in its length.
pub(crate) struct SearchedNameChain {
    /// The segments joined by dots, as written.
    pub(crate) written: Box<str>,
    /// Where each prefix of `written` ends: the first segment, the first two, …
    pub(crate) ends: Box<[usize]>,
    /// Every segment, as the key a member read is handed.
    pub(crate) segments: Box<[CelValue]>,
}

pub(crate) fn search_name_chain(
    activation: &dyn CelActivation,
    snapshot: &EnvironmentSnapshot,
    chain: &SearchedNameChain,
    range: SourceRange,
) -> CelValue {
    for length in (1..=chain.ends.len()).rev() {
        if let Some(held) = held_name(activation, snapshot, &chain.written[..chain.ends[length - 1]]) {
            return read_rest(held, &chain.segments[length..], range, snapshot);
        }
    }
    no_such_variable(&chain.written, range)
}

// --- member reads ------------------------------------------------------------

/// A member read in every form. Reading **through an optional** answers an optional
/// whichever form the read is written in: an absent one propagates as absent, and a key
/// the held value does not have is absent too. Which refusals are absence and which are a
/// mistake is `lookup_absence`'s, turning on the form the read is written in.
pub(crate) fn read_through(
    container: &CelValue,
    key: &CelValue,
    optional_form: bool,
    range: SourceRange,
    snapshot: &EnvironmentSnapshot,
) -> CelValue {
    if let CelValue::Optional(optional) = container {
        return match optional.held() {
            None => CelValue::Optional(cel_none()),
            Some(held) => optional_read(held, key, optional_form, range, snapshot),
        };
    }
    if optional_form {
        return optional_read(container, key, true, range, snapshot);
    }
    cel_read(container, key, Some(range), Some(snapshot))
}

/// A read that answers an optional. `presence` is whether the read was written in a
/// presence-shaped form, which decides whether a value holding no members is absence or a
/// mistake.
fn optional_read(
    container: &CelValue,
    key: &CelValue,
    presence: bool,
    range: SourceRange,
    snapshot: &EnvironmentSnapshot,
) -> CelValue {
    match cel_lookup(container, key, Some(snapshot)) {
        Lookup::Found(held) => CelValue::Optional(cel_some(held.clone())),
        refused if lookup_absence(refused, presence) => CelValue::Optional(cel_none()),
        refused => lookup_error(refused, key, Some(range)).into(),
    }
}

/// `has(a.b)` — presence, which a missing key and a value holding no members answer
/// `false` for. An absent optional has no members, and a present one is asked about what
/// it holds.
pub(crate) fn has_member(container: &CelValue, field: &CelValue, range: SourceRange, snapshot: &EnvironmentSnapshot) -> CelValue {
    if let CelValue::Optional(optional) = container {
        return match optional.held() {
            None => CelValue::Bool(false),
            Some(held) => cel_has(held, field, Some(range), Some(snapshot)),
        };
    }
    cel_has(container, field, Some(range), Some(snapshot))
}

// --- operands ----------------------------------------------------------------

/// A bool operand as it is, an error as it is, and anything else the mistake of its own.
pub(crate) fn bool_operand(value: CelValue, range: SourceRange) -> CelValue {
    match value {
        CelValue::Bool(_) | CelValue::Error(_) => value,
        _ => cel_error(CelEvaluationCode::NoMatchingOverload, "this value is not a bool", Some(range)).into(),
    }
}

/// What an optional entry of an aggregate contributes, or the error it is not one.
pub(crate) fn optional_entry(value: CelValue, range: SourceRange) -> CelValue {
    match value {
        CelValue::Optional(_) => value,
        _ => cel_error(
            CelEvaluationCode::NoMatchingOverload,
            "an entry written with '?' holds an optional",
            Some(range),
        )
        .into(),
    }
}

// --- one call site -----------------------------------------------------------

/// What a site resolved to: the behaviour, or nothing to call.
type Dispatch = Option<CelImplementation>;

fn dispatch_of(name: &str, resolution: Result<Resolution, ResolutionFailure>) -> Dispatch {
    match resolution {
        Ok(resolution) => match &resolution.resolved.metadata.implementation {
            Some(host) => Some(Arc::clone(host)),
            None => implementation_of(&resolution.resolved.signature),
        },
        // **Equality is universal at runtime**, over every pair of types: the checker
        // refuses `1 == 1u` deliberately, but `dyn(1) == 1u` reaches evaluation. A host's
        // own registration still wins, because it resolved first.
        Err(_) if name == "==" || name == "!=" => {
            implementation_of(&CelSignature { name: name.into(), receiver: None, parameters: Vec::new(), returns: DYN })
        }
        Err(_) => None,
    }
}

/// A site's first resolution, published once.
struct FirstResolution {
    names: Box<[Box<str>]>,
    dispatch: Dispatch,
}

const SITE_LOCK: &str = "a call site's cache lock is held only to read or write an entry";

/// One call site, and the overloads it has resolved.
pub(crate) struct CallSite {
    name: Box<str>,
    form: CallForm,
    context: CelCallContext,
    first: OnceLock<FirstResolution>,
    resolved: Mutex<BoundedCache<String, Dispatch>>,
}

impl CallSite {
    pub(crate) fn new(name: &str, form: CallForm, range: SourceRange) -> Self {
        let capacity = NonZeroUsize::new(CALL_SITE_CACHE_CAPACITY).expect("a call site remembers at least one resolution");
        Self {
            name: name.into(),
            form,
            context: CelCallContext { range: Some(range) },
            first: OnceLock::new(),
            resolved: Mutex::new(BoundedCache::new(capacity)),
        }
    }

    fn refusal(&self, message: String) -> CelValue {
        cel_error(CelEvaluationCode::NoMatchingOverload, message, self.context.range).into()
    }

    fn no_overload(&self, names: &[&str]) -> CelValue {
        self.refusal(format!("no overload of {} takes ({})", json_quote(&self.name), names.join(", ")))
    }

    /// The call, over arguments already evaluated and free of errors — the receiver of a
    /// call written on a value first.
    pub(crate) fn call(&self, args: &[CelValue], snapshot: &EnvironmentSnapshot) -> CelValue {
        if args.len() > CALL_SITE_DIRECT_ARITY {
            return self.wide(args);
        }
        let mut held = [""; CALL_SITE_DIRECT_ARITY];
        for (at, value) in args.iter().enumerate() {
            match cel_type_name_of(value) {
                Some(name) => held[at] = name,
                None => return self.no_cel_type(),
            }
        }
        let names = &held[..args.len()];
        if let Some(first) = self.first.get() {
            if first.names.len() == names.len() && first.names.iter().zip(names).all(|(held, name)| **held == **name) {
                return self.answer(first.dispatch.as_ref(), names, args);
            }
        }
        let key = names.join(",");
        let cached = self.resolved.lock().expect(SITE_LOCK).get(&key).cloned();
        let dispatch = match cached {
            Some(dispatch) => dispatch,
            None => {
                let dispatch = self.resolve(args, snapshot);
                let first = FirstResolution { names: names.iter().map(|name| (*name).into()).collect(), dispatch: dispatch.clone() };
                if self.first.set(first).is_err() {
                    self.resolved.lock().expect(SITE_LOCK).set(key, dispatch.clone());
                }
                dispatch
            }
        };
        self.answer(dispatch.as_ref(), names, args)
    }

    fn no_cel_type(&self) -> CelValue {
        self.refusal(format!("{} was handed a value of no CEL type", self.name))
    }

    /// A call written wider than any signature may be: nothing that wide is registered,
    /// so it is the ordinary refusal naming what it was handed.
    fn wide(&self, args: &[CelValue]) -> CelValue {
        let mut names = Vec::with_capacity(args.len());
        for value in args {
            match cel_type_name_of(value) {
                Some(name) => names.push(name),
                None => return self.no_cel_type(),
            }
        }
        self.no_overload(&names)
    }

    fn resolve(&self, args: &[CelValue], snapshot: &EnvironmentSnapshot) -> Dispatch {
        let types: Vec<CelType> = args.iter().map(|value| runtime_type(value, snapshot)).collect();
        let resolution = match self.form {
            CallForm::Receiver => snapshot.registry.resolve(&self.name, self.form, &types[1..], Some(&types[0])),
            CallForm::Global => snapshot.registry.resolve(&self.name, self.form, &types, None),
        };
        dispatch_of(&self.name, resolution)
    }

    fn answer(&self, dispatch: Option<&CelImplementation>, names: &[&str], args: &[CelValue]) -> CelValue {
        match dispatch {
            Some(implementation) => implementation(&self.context, args),
            None => self.no_overload(names),
        }
    }
}

/// The type of a value, for dispatch. A container's element type is `dyn`: reading it
/// exactly would walk the data on every call, and the registry's loose pass resolves a
/// parameterized overload against `dyn` anyway.
fn runtime_type(value: &CelValue, snapshot: &EnvironmentSnapshot) -> CelType {
    match value {
        CelValue::Int(_) => INT,
        CelValue::Uint(_) => UINT,
        CelValue::Double(_) => DOUBLE,
        CelValue::Bool(_) => BOOL,
        CelValue::String(_) => STRING,
        CelValue::Bytes(_) => BYTES,
        CelValue::Null => NULL,
        CelValue::Type(_) => TYPE,
        CelValue::Timestamp(_) => TIMESTAMP,
        CelValue::Duration(_) => DURATION,
        CelValue::List(_) => list_of(DYN),
        CelValue::Map(_) | CelValue::Record(_) => map_of(DYN, DYN),
        CelValue::Optional(_) => optional_of(DYN),
        CelValue::Error(_) => unreachable!("an error is carried past a call, never dispatched"),
        CelValue::Host(_) => {
            let name = cel_type_name_of(value).expect("a dispatched host value has a type name");
            let arity = snapshot.types.get(name).map_or(0, |held| held.arity);
            CelType::Nominal(NominalType {
                name: name.into(),
                base: Arc::new(DYN),
                args: vec![DYN; arity].into(),
                fields: None,
            })
        }
    }
}
