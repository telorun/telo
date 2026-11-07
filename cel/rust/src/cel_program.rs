//! A compiled expression, and what happens at the top of an evaluation — `cel-program.ts`.
//!
//! An error is a **value** throughout evaluation, so that `false && <missing key>` is
//! `false`. At the top there is nothing left to short-circuit: [`CelProgram::evaluate`]
//! answers a surviving error as its `Err`, and an `Ok` never holds one;
//! [`CelProgram::evaluate_to_value`] hands it back as the value it is, for a caller that
//! carries errors itself. A namespaced function's host failure is not a value: it ends the
//! evaluation and is the `Err` of both.
//!
//! A program is immutable and `Send + Sync`: one program is evaluated on any number of
//! threads at once, each evaluation with its own operand stack, slots and frames. It holds
//! a snapshot of what it compiled against, so it answers the same however the environment
//! that compiled it changes afterwards.
//!
//! Node items with no twin in this file:
//! - `CelEvaluationError` as a class — the failure is the value crate's [`CelError`], and
//!   [`CelEvaluationError`] here is that or a host failure, which Node throws as the
//!   host's own error.
//! - `programOfStep` — a program is reached only through the environment.
//! - The thenable backstop and `async_value_unsupported` — no Rust value can be awaited.
//! - `compileExpression` — the environment compiles, checking a tree is ready first.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{CelError, CelValue};

use crate::activation::CelActivation;
use crate::backend_runtime::EnvironmentSnapshot;
use crate::closure_backend::{run, CompiledTree};
use crate::runtime_library::{HostFailure, NamespaceImplementation};

/// How one evaluation is run.
#[derive(Clone, Copy, Default)]
pub struct EvaluateOptions<'a> {
    /// What a namespaced call (`Alias.fn(x)`) is dispatched through: the function bound
    /// under a namespace and a name, or nothing. A host binds it per evaluation, because
    /// which functions a scope reaches is the host's own question; a call nothing binds is
    /// `unbound_function`, decided before any of its arguments is evaluated. The function
    /// is handed the arguments as written, however many.
    pub namespace_function: Option<&'a dyn Fn(&str, &str) -> Option<NamespaceImplementation>>,
}

impl fmt::Debug for EvaluateOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvaluateOptions")
            .field("namespace_function", &self.namespace_function.is_some().then_some("dispatch"))
            .finish()
    }
}

/// Why an evaluation answered no value: an error survived to its top, or a namespaced
/// function failed with the host's own failure.
#[derive(PartialEq, Eq, Debug)]
pub enum CelEvaluationError {
    Error(CelError),
    Host(HostFailure),
}

impl fmt::Display for CelEvaluationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CelEvaluationError::Error(error) => error.fmt(f),
            CelEvaluationError::Host(_) => f.write_str("a namespaced function failed with the host's own failure"),
        }
    }
}

impl std::error::Error for CelEvaluationError {}

/// An expression compiled against an environment.
pub struct CelProgram {
    source: Arc<str>,
    tree: CompiledTree,
    snapshot: Arc<EnvironmentSnapshot>,
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<CelProgram>();
};

impl CelProgram {
    pub(crate) fn new(source: Arc<str>, tree: CompiledTree, snapshot: Arc<EnvironmentSnapshot>) -> Self {
        Self { source, tree, snapshot }
    }

    /// The source the program was compiled from.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The value, or the error that survived to the top of the evaluation, or the host
    /// failure that ended it.
    pub fn evaluate(
        &self,
        activation: &dyn CelActivation,
        options: &EvaluateOptions<'_>,
    ) -> Result<CelValue, CelEvaluationError> {
        match self.evaluate_to_value(activation, options) {
            Ok(CelValue::Error(error)) => Err(CelEvaluationError::Error(error)),
            Ok(value) => Ok(value),
            Err(failure) => Err(CelEvaluationError::Host(failure)),
        }
    }

    /// The value or the error value, for a caller that carries errors itself, or the host
    /// failure that ended the evaluation.
    pub fn evaluate_to_value(
        &self,
        activation: &dyn CelActivation,
        options: &EvaluateOptions<'_>,
    ) -> Result<CelValue, HostFailure> {
        run(&self.tree, &self.snapshot, activation, options.namespace_function)
    }
}

impl fmt::Debug for CelProgram {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CelProgram").field("source", &self.source).finish_non_exhaustive()
    }
}
