use thiserror::Error;

/// Error type for controller operations. The `code` is surfaced to the kernel
/// as a structured error code (e.g. `ERR_VALIDATION_FAILED`); `message` is the
/// human-readable description.
#[derive(Debug, Error)]
#[error("[{code}] {message}")]
pub struct ControllerError {
    pub code: String,
    pub message: String,
}

impl ControllerError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn with_message(message: impl Into<String>) -> Self {
        Self::new("ERR_CONTROLLER", message)
    }
}

impl From<&str> for ControllerError {
    fn from(message: &str) -> Self {
        Self::with_message(message)
    }
}

impl From<String> for ControllerError {
    fn from(message: String) -> Self {
        Self::with_message(message)
    }
}

impl From<serde_json::Error> for ControllerError {
    fn from(err: serde_json::Error) -> Self {
        Self::new("ERR_JSON", err.to_string())
    }
}
