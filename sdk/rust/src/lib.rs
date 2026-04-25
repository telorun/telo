//! Telo SDK for Rust controllers.
//!
//! Author a controller by implementing the [`Controller`] trait on your type,
//! then add `#[controller]` to the impl block to generate FFI bindings:
//!
//! ```ignore
//! use telorun_sdk::{controller, Controller, ResourceContext, Result, Value};
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
//!     fn invoke(&self, input: Value) -> Result<Value> {
//!         Ok(input)
//!     }
//! }
//! ```
//!
//! The same crate compiles against the napi backend (`--features napi`) for
//! today's Node.js kernel and against the native backend (`--features native`)
//! for the future pure-Rust kernel — without source changes.

pub use serde_json::Value;
pub use telorun_sdk_macros::controller;

pub mod backend;

mod error;
mod traits;

pub use error::ControllerError;
pub use traits::{Controller, ControllerContext, DataValidator, ResourceContext, Result};

// Re-exports used by `#[controller]`-generated code. Stable paths so
// downstream controllers don't need a direct napi-rs dep.
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
