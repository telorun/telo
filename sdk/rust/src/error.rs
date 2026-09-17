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

/// Run a fallible body, turning a panic into `ERR_CONTROLLER_PANIC` rather than
/// letting it unwind into the host's frame — an unwind across `extern "C"` or a
/// napi callback takes the whole process down with the controller.
pub(crate) fn guard<T>(body: impl FnOnce() -> Result<T, ControllerError>) -> Result<T, ControllerError> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(payload) => Err(ControllerError::new("ERR_CONTROLLER_PANIC", panic_message(&payload))),
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "controller panicked".to_string()
}

impl From<serde_json::Error> for ControllerError {
    fn from(err: serde_json::Error) -> Self {
        Self::new("ERR_JSON", err.to_string())
    }
}
