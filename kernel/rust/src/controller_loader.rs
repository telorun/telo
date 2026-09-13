//! Top-level controller-loader dispatcher: applies the resolved selection
//! policy, then picks a per-scheme sub-loader by PURL type.
//! Mirrors `../../nodejs/src/controller-loader.ts`.
//!
//!   ControllerLoader::resolve(candidates, base_uri, policy)
//!     └─ order_candidates(candidates, policy)
//!          ├─ pkg:cargo → CargoControllerLoader
//!          └─ pkg:telo  → DylibControllerLoader (with the module's artifact)
//!
//! `pkg:npm` candidates, and `pkg:telo` formats other than `dylib`, are reported
//! as unhostable rather than attempted: this kernel cannot run JavaScript, and
//! saying so by name is what turns "nothing loaded" into an actionable message.
//!
//! What the load recorded about each module's files — its artifact, or why it
//! has none, and its `sources:` block — is held here, keyed by the canonical
//! source a definition resolves against (where Node's kernel hands its loader
//! `getModuleArtifact(source)` and the owner manifest), because a definition
//! reaches controllers only through this loader.

use std::rc::Rc;

use crate::bundle::module_artifact::ModuleArtifacts;
use crate::controller_loaders::cargo_loader::{CargoControllerLoader, EnvMissing, ResolveError};
use crate::controller_loaders::dylib_loader::DylibControllerLoader;
use crate::controller_loaders::native_abi::LoadedController;
use crate::error::KernelError;
use crate::runtime_registry::{order_candidates, purl_type, ControllerPolicy};

pub struct ControllerLoader {
    cargo: CargoControllerLoader,
    dylib: DylibControllerLoader,
    artifacts: Rc<ModuleArtifacts>,
}

impl ControllerLoader {
    pub fn new(artifacts: Rc<ModuleArtifacts>) -> Self {
        Self {
            cargo: CargoControllerLoader,
            dylib: DylibControllerLoader,
            artifacts,
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
        match purl_type(purl) {
            "pkg:cargo" => self.cargo.resolve(purl, base_uri, &self.artifacts.files(base_uri)),
            "pkg:telo" => self.dylib.resolve(
                purl,
                base_uri,
                &self.artifacts.files(base_uri),
                self.artifacts.sources(base_uri).as_deref(),
            ),
            _ => Err(ResolveError::EnvMissing(EnvMissing {
                reason: format!(
                    "{purl} targets a runtime this kernel does not host (the Rust kernel runs pkg:cargo and pkg:telo/local/dylib controllers)"
                ),
            })),
        }
    }
}
