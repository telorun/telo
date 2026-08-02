//! Top-level controller-loader dispatcher: applies the resolved selection
//! policy, then picks a per-scheme sub-loader by PURL type.
//! Mirrors `../../nodejs/src/controller-loader.ts`.
//!
//!   ControllerLoader::resolve(candidates, base_uri, policy)
//!     └─ order_candidates(candidates, policy)
//!          └─ pkg:cargo → CargoControllerLoader
//!
//! `pkg:npm` and `pkg:telo` candidates are reported as unhostable rather than
//! attempted: this kernel cannot run JavaScript, and saying so by name is what
//! turns "nothing loaded" into an actionable message.

use std::rc::Rc;

use crate::controller_loaders::cargo_loader::{CargoControllerLoader, ResolveError};
use crate::controller_loaders::native_abi::LoadedController;
use crate::error::KernelError;
use crate::runtime_registry::{order_candidates, purl_type, ControllerPolicy};

pub struct ControllerLoader {
    cargo: CargoControllerLoader,
}

impl Default for ControllerLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl ControllerLoader {
    pub fn new() -> Self {
        Self {
            cargo: CargoControllerLoader,
        }
    }

    /// Walk the ordered candidates, advancing past env-missing ones and
    /// surfacing a build failure immediately.
    pub fn resolve(
        &self,
        candidates: &[String],
        base_uri: &str,
        policy: &ControllerPolicy,
    ) -> Result<Rc<LoadedController>, KernelError> {
        if candidates.is_empty() {
            return Err(KernelError::controller_not_found(
                "Missing controller PURL candidates",
            ));
        }
        let ordered = order_candidates(candidates, policy);
        if ordered.is_empty() {
            return Err(KernelError::controller_not_found(format!(
                "No controllers match runtime selection [{}]; declared: {}",
                policy.load.join(", "),
                candidates.join(", ")
            )));
        }

        let mut skipped: Vec<String> = Vec::new();
        for purl in &ordered {
            match self.dispatch_one(purl, base_uri) {
                Ok(loaded) => return Ok(loaded),
                Err(ResolveError::EnvMissing(missing)) => {
                    skipped.push(format!("{purl}: {}", missing.reason));
                }
                Err(ResolveError::Fatal(err)) => return Err(err),
            }
        }
        Err(KernelError::controller_not_found(format!(
            "No controller resolved. Tried {} candidate(s):\n{}",
            ordered.len(),
            skipped.join("\n")
        )))
    }

    fn dispatch_one(&self, purl: &str, base_uri: &str) -> Result<Rc<LoadedController>, ResolveError> {
        // Compared as a whole type, not a prefix: `starts_with("pkg:cargo")`
        // also matches `pkg:cargofoo/…`.
        if purl_type(purl) == "pkg:cargo" {
            return self.cargo.resolve(purl, base_uri);
        }
        Err(ResolveError::EnvMissing(
            crate::controller_loaders::cargo_loader::EnvMissing {
                reason: format!(
                    "{purl} targets a runtime this kernel does not host (the Rust kernel runs pkg:cargo controllers)"
                ),
            },
        ))
    }
}
