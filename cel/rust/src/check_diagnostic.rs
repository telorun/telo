//! What the checker says, and the engine's errors — `check-diagnostic.ts`.
//!
//! Every verdict carries its own code and the range of the text it is about, so nothing
//! downstream reads a message. A fix is a whole-source replacement, never a sub-range
//! splice: an expression is usually one scalar of a host's document, and a sub-range
//! means something else the moment that scalar is re-indented.
//!
//! An engine error says the caller used the engine wrongly, so nothing is checked: it is
//! not a verdict about an expression.
//!
//! Node items with no twin: `DiagnosticList` — the checker's list of what it found is
//! private, as on Node's entry.
//!
//! Declared here and not in the Node file:
//! - `CelCheckCode::as_str` — Node holds the code as the string itself.

use std::fmt;

use crate::syntax_tree::SourceRange;

/// Every verdict this engine decides, in Node's order.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelCheckCode {
    /// The source could not be read at all (the front end's verdict, carried through).
    SyntaxError,
    /// A type is not the one the expression needs here.
    TypeError,
    /// A name nothing declares.
    UnknownIdentifier,
    /// A member a declared type does not hold.
    UnknownField,
    /// A function nothing registers.
    UnknownFunction,
    /// A registered function called in the other form — `x.f()` for `f(x)`, or back.
    WrongCallForm,
    /// A named type whose type argument differs from the one wanted.
    TypeArgumentMismatch,
    /// A dereference of something that may be null, with no guard proving it is not.
    NullableAccess,
    /// An argument a construct refuses on sight: a macro's shape, or a literal a
    /// registration's guard refuses.
    InvalidArgument,
    /// A namespaced call naming a function the namespace does not declare.
    FunctionUnresolved,
    /// A namespaced call with the wrong number of arguments.
    FunctionArityMismatch,
    /// A namespaced call whose argument is not the declared type.
    FunctionArgumentMismatch,
}

impl CelCheckCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CelCheckCode::SyntaxError => "CEL_SYNTAX_ERROR",
            CelCheckCode::TypeError => "CEL_TYPE_ERROR",
            CelCheckCode::UnknownIdentifier => "CEL_UNKNOWN_IDENTIFIER",
            CelCheckCode::UnknownField => "CEL_UNKNOWN_FIELD",
            CelCheckCode::UnknownFunction => "CEL_UNKNOWN_FUNCTION",
            CelCheckCode::WrongCallForm => "CEL_WRONG_CALL_FORM",
            CelCheckCode::TypeArgumentMismatch => "CEL_TYPE_ARGUMENT_MISMATCH",
            CelCheckCode::NullableAccess => "CEL_NULLABLE_ACCESS",
            CelCheckCode::InvalidArgument => "CEL_INVALID_ARGUMENT",
            CelCheckCode::FunctionUnresolved => "FUNCTION_UNRESOLVED",
            CelCheckCode::FunctionArityMismatch => "FUNCTION_ARITY_MISMATCH",
            CelCheckCode::FunctionArgumentMismatch => "FUNCTION_ARGUMENT_MISMATCH",
        }
    }
}

impl fmt::Display for CelCheckCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Every code, in the one order a host reading the vocabulary reads it.
pub const CEL_CHECK_CODES: [CelCheckCode; 12] = [
    CelCheckCode::SyntaxError,
    CelCheckCode::TypeError,
    CelCheckCode::UnknownIdentifier,
    CelCheckCode::UnknownField,
    CelCheckCode::UnknownFunction,
    CelCheckCode::WrongCallForm,
    CelCheckCode::TypeArgumentMismatch,
    CelCheckCode::NullableAccess,
    CelCheckCode::InvalidArgument,
    CelCheckCode::FunctionUnresolved,
    CelCheckCode::FunctionArityMismatch,
    CelCheckCode::FunctionArgumentMismatch,
];

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelDiagnosticFix {
    /// The whole expression, corrected.
    pub replacement: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelCheckDiagnostic {
    pub code: CelCheckCode,
    pub message: String,
    pub range: SourceRange,
    pub fix: Option<CelDiagnosticFix>,
}

/// Every way the engine refuses its caller, one vocabulary across engines.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelEngineErrorCode {
    /// A tree resolved under a different namespace set than the environment's.
    NamespacesMismatch,
    /// A tree the front end already reported a syntax diagnostic for, handed on to run.
    UnreadableExpression,
    /// A loaded module whose integrity header is not the one asked for. No Rust path
    /// raises it: there is no emitter here.
    EmittedModuleRejected,
    /// A registration declaring more values than an implementation receives.
    SignatureTooWide,
}

impl CelEngineErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CelEngineErrorCode::NamespacesMismatch => "namespaces_mismatch",
            CelEngineErrorCode::UnreadableExpression => "unreadable_expression",
            CelEngineErrorCode::EmittedModuleRejected => "emitted_module_rejected",
            CelEngineErrorCode::SignatureTooWide => "signature_too_wide",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelEngineError {
    pub code: CelEngineErrorCode,
    pub message: String,
}

impl fmt::Display for CelEngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelEngineError {}
