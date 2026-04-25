//! Backend implementations of the controller contract.
//!
//! Backends are gated by Cargo features; the `#[controller]` macro emits
//! the appropriate bridge code based on which feature is active in the
//! downstream crate's build invocation.

#[cfg(feature = "napi")]
pub mod napi;

#[cfg(feature = "native")]
pub mod native;
