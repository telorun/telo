use serde_json::Value;
use thiserror::Error;

use crate::failure_trace::{FailureFrame, FailureTrace};
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
    /// The failure's trace, which a controller rethrowing a failure carries
    /// unchanged (`kernel/specs/controller-protocol.md` §3.2).
    pub trace: FailureTrace,
    /// The host's own stack text; set only for a failure that is not a structured
    /// refusal (a panic).
    pub host_stack: Option<String>,
}

impl ControllerError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
            display_message: None,
            trace: FailureTrace::default(),
            host_stack: None,
        }
    }

    /// This error carrying the trace of a failure it rethrows.
    pub fn with_frames(mut self, frames: Vec<FailureFrame>, dropped_frames_count: u64) -> Self {
        self.trace = FailureTrace::restored(frames, dropped_frames_count);
        self
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
        if !self.trace.frames.is_empty() {
            payload["frames"] = serde_json::to_value(&self.trace.frames).expect("frames serialize");
        }
        if self.trace.dropped_frames_count > 0 {
            payload["droppedFramesCount"] = self.trace.dropped_frames_count.into();
        }
        if let Some(host_stack) = &self.host_stack {
            payload["hostStack"] = host_stack.clone().into();
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
        Err(payload) => {
            let mut error = ControllerError::new("ERR_CONTROLLER_PANIC", panic_message(&payload));
            // A panic is a bug in controller code, where the host stack is the finding.
            error.host_stack = Some(format!(
                "panicked: {}\n{}",
                error.message,
                std::backtrace::Backtrace::force_capture()
            ));
            Err(error)
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_carries_a_host_stack_and_a_refusal_carries_none() {
        let panicked: Result<(), _> = guard(|| panic!("boom"));
        let panicked = panicked.unwrap_err();
        assert_eq!(panicked.code, "ERR_CONTROLLER_PANIC");
        assert!(panicked.payload()["hostStack"].as_str().unwrap().contains("boom"));

        let refused = ControllerError::new("NOT_FOUND", "missing");
        assert!(refused.payload().get("hostStack").is_none());
    }

    #[test]
    fn a_rethrown_failure_carries_its_frames_unchanged() {
        let frames = vec![FailureFrame::new("Lib.K", "inner", Some("file:///m/telo.yaml".into()))];
        let payload = ControllerError::new("X", "m").with_frames(frames, 3).payload();
        assert_eq!(payload["frames"][0]["name"], "inner");
        assert_eq!(payload["droppedFramesCount"], 3);
    }
}
