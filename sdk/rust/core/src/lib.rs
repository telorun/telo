//! The value domain of the Telo SDK for Rust — every `sdk` file except the
//! controller backends.
//!
//! A Rust packaging boundary, not a second package: this crate is the `sdk`
//! package split so a runtime (the Rust kernel) can hold CEL values, typed
//! frames, plain encodings, the value-type reader and the log record model
//! without linking a controller backend. `telorun-sdk` re-exports all of it at
//! the same paths; controller authors depend on `telorun-sdk` only. File twins
//! stay keyed by name within the `sdk` package:
//!
//! * `cel_value_identity.rs` — `sdk/nodejs/src/cel-value-identity.ts`
//! * `controller_protocol.rs` — `sdk/nodejs/tests/controller-protocol.test.ts`
//! * `function_controller.rs` — `sdk/nodejs/src/function-controller.ts`
//! * `logging.rs` — `sdk/nodejs/src/{logger,log-record,log-severity,log-sink}.ts`
//! * `plain_encoding.rs` — `sdk/nodejs/src/plain-encoding.ts`
//! * `typed_frame.rs` (+ `typed_frame/`) — `sdk/nodejs/src/typed-frame.ts`
//! * `value_type.rs` — `sdk/nodejs/src/value-type.ts`
//!
//! `error.rs`, `invoke_context.rs` and `traits.rs` are the Rust controller
//! contract, which the Node SDK states through its own context and error types
//! rather than file for file.

pub use serde_json::Value;

mod cel_value_identity;
mod controller_protocol;
mod error;
pub mod function_controller;
mod invoke_context;
pub mod logging;
pub mod plain_encoding;
mod traits;
pub mod typed_frame;
pub mod value_type;

pub use cel_value_identity::{Bytes, Duration, Timestamp, Uint64};
pub use function_controller::{Function, FunctionContext};

pub use error::ControllerError;
pub use logging::{
    format_span_counter, format_span_id, format_trace_id, salt_span_id, severity, severity_floor,
    severity_text, ErrorValue, LogOptions, LogRecord, LogSink, Logger, ResourceRef, SeverityNumber,
    ThresholdCache,
};
pub use invoke_context::{CancellationToken, InvokeContext};
pub use traits::{Controller, ControllerContext, DataValidator, ResourceContext, Result};

// The backends' panic boundary; public only so `telorun-sdk` can reach it.
#[doc(hidden)]
pub use error::guard;
