//! Telo SDK for Rust controllers.
//!
//! Author a controller by implementing the [`Controller`] trait on your type,
//! then add `#[controller]` to the impl block to generate FFI bindings:
//!
//! ```ignore
//! use telorun_sdk::{controller, Controller, InvokeContext, ResourceContext, Result, Value};
//!
//! pub struct MyController {
//!     // ...
//! }
//!
//! #[controller]
//! impl Controller for MyController {
//!     fn create(manifest: Value, ctx: &dyn ResourceContext) -> Result<Self> {
//!         Ok(MyController {})
//!     }
//!
//!     fn invoke(&self, input: Value, ctx: &InvokeContext) -> Result<Value> {
//!         Ok(input)
//!     }
//! }
//! ```
//!
//! The same controller crate compiles against either backend without source
//! changes. The backend is chosen by whichever kernel builds the crate — the
//! Node.js kernel passes `--features telorun-sdk/napi`, the Rust kernel passes
//! `--features telorun-sdk/native`. The controller's own `Cargo.toml` carries no
//! `[features]` block, and this crate declares no default backend: selecting one
//! from the outside is only possible as a dependency feature, since
//! `--no-default-features` on the build would apply to the controller crate
//! rather than to this dependency.

pub use serde_json::Value;
pub use telorun_sdk_macros::controller;

pub mod backend;

mod error;
mod invoke_context;
pub mod logging;
mod traits;

pub use error::ControllerError;
pub use logging::{
    format_span_counter, format_span_id, format_trace_id, salt_span_id, severity, severity_floor,
    severity_text, ErrorValue, LogOptions, LogRecord, LogSink, Logger, ResourceRef, SeverityNumber,
    ThresholdCache,
};
pub use invoke_context::{CancellationToken, InvokeContext};
pub use traits::{Controller, ControllerContext, DataValidator, ResourceContext, Result};

// Re-exports used by `#[controller]`-generated code. Stable paths so
// downstream controllers don't need a direct napi-rs or ABI dep.
#[doc(hidden)]
pub use telorun_abi as __abi;

#[cfg(feature = "napi")]
#[doc(hidden)]
pub use napi as __napi;

#[cfg(feature = "napi")]
#[doc(hidden)]
pub use napi_derive as __napi_derive;

#[cfg(feature = "napi")]
#[doc(hidden)]
pub use serde_json as __serde_json;

/// Wraps the napi bridge code emitted by `#[controller]`. The macro is
/// defined here (not in the consuming crate) so the SDK's own feature
/// selection drives whether the bridge compiles — the controller crate
/// has no `[features]` block at all. With the `napi` feature on, this
/// expands to its body; with `native` (or any non-napi backend), it
/// expands to nothing, and the bridge — including all `::telorun_sdk::__napi`
/// references — never enters the compilation unit.
#[cfg(feature = "napi")]
#[macro_export]
#[doc(hidden)]
macro_rules! __bridge {
    ($($t:tt)*) => { $($t)* };
}

#[cfg(not(feature = "napi"))]
#[macro_export]
#[doc(hidden)]
macro_rules! __bridge {
    ($($t:tt)*) => {};
}

/// Wraps the C-ABI bridge emitted by `#[controller]` for the native backend,
/// on the same principle as [`__bridge`]: the SDK's feature selection — not the
/// controller crate's — decides whether the bridge compiles. With `native` off,
/// no `::telorun_sdk::backend::native` reference enters the build graph.
#[cfg(feature = "native")]
#[macro_export]
#[doc(hidden)]
macro_rules! __native_bridge {
    ($($t:tt)*) => { $($t)* };
}

#[cfg(not(feature = "native"))]
#[macro_export]
#[doc(hidden)]
macro_rules! __native_bridge {
    ($($t:tt)*) => {};
}
