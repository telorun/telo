//! The checker — `checker.ts`, its first item: what a host declares a namespaced
//! function as.
//!
//! Node items with no twin in this file yet, arriving with the checker: `CheckResult`,
//! `checkExpression` and the walk itself, its crate-private context (`CheckerContext`)
//! and its options (`CheckerOptions`).

use crate::cel_type::CelType;

/// A namespaced function the host has declared, as the environment holds it.
///
/// The parameter list is withheld structurally: `parameters` and `signature` are both
/// absent where the host declared only the name and the result, and the call's arity
/// and arguments are then judged by nobody here.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NamespaceFunction {
    pub name: String,
    pub returns: CelType,
    /// Absent where the host withholds it.
    pub parameters: Option<Vec<CelType>>,
    /// How the declaration is written, for a listing; absent with the parameters.
    pub signature: Option<String>,
    /// Types the declaration named that nothing is registered under, in the order
    /// written; each reads `dyn`.
    pub unregistered_types: Vec<String>,
    pub deterministic: bool,
    pub host_backed: bool,
    pub throws: Option<Vec<String>>,
}
