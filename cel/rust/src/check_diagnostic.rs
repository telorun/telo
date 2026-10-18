//! The engine's errors — `check-diagnostic.ts`, its engine-error half.
//!
//! An engine error says the caller used the engine wrongly, so nothing is checked: it is
//! not a verdict about an expression.
//!
//! Node items with no twin in this file yet, arriving with the checker:
//! `CEL_CHECK_CODES`, `CelCheckCode`, `CelCheckDiagnostic`, `CelDiagnosticFix`.
//!
//! Node items with no twin: `DiagnosticList` — the checker's list of what it found is
//! private, as on Node's entry.

use std::fmt;

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
