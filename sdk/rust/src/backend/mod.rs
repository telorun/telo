//! Backend implementations of the controller contract.
//!
//! Backends are gated by Cargo features; the `#[controller]` macro emits
//! the appropriate bridge code based on which feature is active in the
//! downstream crate's build invocation.

// One artifact hosts one backend. Both bridges in one build would export a napi
// registration *and* a C vtable from the same library, and the napi half leaves
// the Node symbols it needs undefined — so the Rust kernel's `dlopen` of it
// fails at load with nothing pointing at the cause. Rejecting the combination at
// compile time puts the error where the mistake is.
#[cfg(all(feature = "napi", feature = "native"))]
compile_error!(
    "telorun-sdk: the `napi` and `native` backends are mutually exclusive — a controller artifact \
     hosts exactly one. Build with `--features telorun-sdk/napi` (Node.js kernel) or \
     `--features telorun-sdk/native` (Rust kernel), not both."
);

#[cfg(feature = "napi")]
pub mod napi;

#[cfg(feature = "native")]
pub mod native;
