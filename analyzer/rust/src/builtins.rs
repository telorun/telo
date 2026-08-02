//! Kernel-provided capability contracts, mirroring `../../nodejs/src/builtins.ts`.
//!
//! The Node file registers each capability as a full `Telo.Abstract` document
//! because the analyzer type-checks against it. Here they are names only: this
//! kernel reads a definition's `capability` to decide the lifecycle role and
//! nothing else.

pub const SERVICE: &str = "Telo.Service";
pub const RUNNABLE: &str = "Telo.Runnable";
pub const INVOCABLE: &str = "Telo.Invocable";
pub const PROVIDER: &str = "Telo.Provider";
pub const MOUNT: &str = "Telo.Mount";
pub const SINK: &str = "Telo.Sink";
pub const TYPE: &str = "Telo.Type";

pub const CAPABILITIES: &[&str] = &[SERVICE, RUNNABLE, INVOCABLE, PROVIDER, MOUNT, SINK, TYPE];

pub fn is_capability(name: &str) -> bool {
    CAPABILITIES.contains(&name)
}

/// Capabilities the Rust kernel can host today. A definition declaring any
/// other known capability loads fine and fails with a precise message if a
/// resource of that kind is declared — the lifecycle it asks for does not exist
/// here yet, and pretending otherwise would run it as something it is not.
pub const SUPPORTED_CAPABILITIES: &[&str] = &[INVOCABLE];

pub fn is_supported_capability(name: &str) -> bool {
    SUPPORTED_CAPABILITIES.contains(&name)
}
