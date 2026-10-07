//! The Telo SDK for Rust without a controller backend — every `sdk` file except
//! the backends.
//!
//! A Rust packaging boundary, not a second package: this crate is the `sdk`
//! package split so a runtime (the Rust kernel) can hold CEL values, typed
//! frames, plain encodings, the value-type reader and the log record model
//! without linking a controller backend. `telorun-sdk` re-exports all of it at
//! the same paths; controller authors depend on `telorun-sdk` only.
//!
//! The CEL value domain itself is not declared here. It is `telorun-cel-value`'s
//! (`cel/rust/value`), which this crate depends on and re-exports by name: the
//! union `CelValue`, the types its variants hold, and their constructors, readers
//! and writers. What this crate adds over it is how a value crosses a boundary —
//! the four serde-facing types (`Timestamp`, `Duration`, `Bytes`, `Uint64`), the
//! plain encodings and the typed frame.
//!
//! File twins stay keyed by name within the `sdk` package:
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
// The CEL value domain, re-exported by name from `telorun-cel-value`.
pub use cel_value_identity::{
    cel_duration_from_nanos, cel_map_from_entries, cel_map_keys, cel_timestamp, cel_timestamp_from_millis,
    duration_nanos, duration_nanos_from_text, format_duration, format_timestamp, parse_duration,
    parse_timestamp, timestamp_nanos, CelDuration, CelError, CelEvaluationCode, CelHostValue, CelMap,
    CelMapKey, CelOptional, CelRecord, CelTimestamp, CelTypeValue, CelValue, ReservedTypeName, SourceRange,
};
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
