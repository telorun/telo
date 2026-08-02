//! Structured kernel error.
//!
//! Node's kernel raises `RuntimeError` from `@telorun/sdk`; this kernel cannot
//! depend on `telorun-sdk` (see `telorun-abi`'s crate docs), so the same
//! code-plus-message shape lives here. Codes match the Node kernel's wherever
//! the failure is the same one, so a message is searchable across both.

#[derive(Debug, thiserror::Error)]
#[error("[{code}] {message}")]
pub struct KernelError {
    pub code: String,
    pub message: String,
}

impl KernelError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
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
