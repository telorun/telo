//! The Rust Telo kernel.
//!
//! File layout mirrors `kernel/nodejs/src/` one-for-one (kebab-case becomes
//! snake_case, which Rust requires), so a change on either side has an obvious
//! counterpart on the other. Where a file has no Node twin the reason is stated
//! in its own header.
//!
//! Scope is deliberately narrow — see `plans/rust-kernel-hello-world.md`. It
//! runs `Telo.Invocable` resources reached through local-path imports, with
//! controllers delivered as `pkg:cargo` crates. No expression engine, no
//! `variables`/`secrets`/`ports`, no OCI transport, no streams.

pub mod controller_loader;
pub mod controller_loaders;
pub mod controller_registry;
pub mod controllers;
pub mod error;
pub mod evaluation_context;
pub mod invocation_contract_binding;
pub mod invoke_dispatch;
pub mod kernel;
pub mod manifest_sources;
pub mod module_context;
pub mod resource_context;
pub mod runtime_registry;
pub mod schema_validator;

pub use error::KernelError;
pub use kernel::Kernel;
