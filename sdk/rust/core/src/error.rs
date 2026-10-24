use serde_json::Value;
use thiserror::Error;

use crate::text_record::TextRecord;

/// Error type for controller operations. The `code` is surfaced to the kernel
/// as a structured error code (e.g. `ERR_VALIDATION_FAILED`); `message` is the
/// developer's description, for logs and traces. `data` is the structured
/// payload a catch reads, and `display_message` the text a person is shown for
/// the failure, as its record, whose values are `data` — a controller rethrowing
/// an error it caught carries the display message it received unchanged.
#[derive(Debug, Error)]
#[error("[{code}] {message}")]
pub struct ControllerError {
    pub code: String,
    pub message: String,
    pub data: Option<Value>,
    pub display_message: Option<TextRecord>,
}

impl ControllerError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
            display_message: None,
        }
    }

    /// This error carrying `data`.
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    /// This error carrying the text a person is shown for it.
    pub fn with_display_message(mut self, display_message: TextRecord) -> Self {
        self.display_message = Some(display_message);
        self
    }

    /// The JSON payload both carriers write: `code` and `message`, and `data`
    /// and `displayMessage` when present — the controller protocol's error member.
    pub fn payload(&self) -> Value {
        let mut payload = serde_json::json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            payload["data"] = data.clone();
        }
        if let Some(display_message) = &self.display_message {
            payload["displayMessage"] =
                serde_json::to_value(display_message).expect("a text record serializes");
        }
        payload
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
#[doc(hidden)]
pub fn guard<T>(body: impl FnOnce() -> Result<T, ControllerError>) -> Result<T, ControllerError> {
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
