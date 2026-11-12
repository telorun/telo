//! Structured kernel error.
//!
//! Node's kernel raises `RuntimeError` from `@telorun/sdk`; this kernel cannot
//! depend on `telorun-sdk` (see `telorun-abi`'s crate docs), so the same
//! code-plus-message shape lives here. Codes match the Node kernel's wherever
//! the failure is the same one, so a message is searchable across both.

use telo_analyzer::AnalysisDiagnostic;
use telorun_sdk_core::FailureTrace;

/// Written as `[<code>] <message>`, then each diagnostic it carries on a line of its own
/// as `[<CODE>] <message>` — a refusal's headline alone ("Manifest validation failed")
/// names no cause.
#[derive(Debug, thiserror::Error)]
pub struct KernelError {
    pub code: String,
    pub message: String,
    /// A controller's structured payload, when it carries one.
    pub data: Option<serde_json::Value>,
    /// The text a person is shown for the failure, as its record.
    pub display_message: Option<serde_json::Value>,
    /// The path the failure took through the manifest (`kernel/specs/invocation-contract.md` §5.5).
    pub trace: FailureTrace,
    /// The host's stack; only for a failure that is not a structured refusal (a panic).
    pub host_stack: Option<String>,
    /// The static analysis findings a load refusal carries, each as `telo check` reports
    /// it. Node's kernel converts each to a `RuntimeDiagnostic`; this one carries them whole.
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

impl std::fmt::Display for KernelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        for diagnostic in &self.diagnostics {
            match &diagnostic.code {
                Some(code) => write!(f, "\n  [{code}] {}", diagnostic.message)?,
                None => write!(f, "\n  {}", diagnostic.message)?,
            }
        }
        Ok(())
    }
}

impl KernelError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
            display_message: None,
            trace: FailureTrace::default(),
            host_stack: None,
            diagnostics: Vec::new(),
        }
    }

    /// The error carrying `diagnostics`, the findings it refuses a load for.
    pub fn with_diagnostics(mut self, diagnostics: Vec<AnalysisDiagnostic>) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    pub fn runtime_invalid(message: impl Into<String>) -> Self {
        Self::new("ERR_RUNTIME_INVALID", message)
    }

    pub fn manifest_validation_failed(message: impl Into<String>) -> Self {
        Self::new("ERR_MANIFEST_VALIDATION_FAILED", message)
    }

    pub fn resource_not_found(message: impl Into<String>) -> Self {
        Self::new("ERR_RESOURCE_NOT_FOUND", message)
    }

    pub fn controller_not_found(message: impl Into<String>) -> Self {
        Self::new("ERR_CONTROLLER_NOT_FOUND", message)
    }

    pub fn controller_invalid(message: impl Into<String>) -> Self {
        Self::new("ERR_CONTROLLER_INVALID", message)
    }

    pub fn controller_build_failed(message: impl Into<String>) -> Self {
        Self::new("ERR_CONTROLLER_BUILD_FAILED", message)
    }

    pub fn undefined_kind(message: impl Into<String>) -> Self {
        Self::new("ERR_UNDEFINED_KIND", message)
    }

    pub fn input_invalid(message: impl Into<String>) -> Self {
        Self::new("ERR_INPUT_INVALID", message)
    }

    pub fn output_invalid(message: impl Into<String>) -> Self {
        Self::new("ERR_OUTPUT_INVALID", message)
    }
}

impl From<telo_analyzer::LoadError> for KernelError {
    fn from(err: telo_analyzer::LoadError) -> Self {
        Self::new("ERR_MANIFEST_LOAD_FAILED", err.to_string())
    }
}
