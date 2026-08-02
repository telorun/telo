//! Registered kinds and their controllers.
//! Mirrors `../../nodejs/src/controller-registry.ts`.
//!
//! A kind's controller is resolved on the kind's **first instantiation**, not at
//! registration. That is what lets this kernel load an unmodified standard-library
//! manifest whose other kinds ship only a JavaScript controller: those
//! definitions register fine and fail — precisely, naming the kind — only if a
//! resource of one is declared.

use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::Value;

use crate::controller_loader::ControllerLoader;
use crate::controller_loaders::native_abi::LoadedController;
use crate::error::KernelError;
use crate::runtime_registry::ControllerPolicy;
use crate::schema_validator::SchemaValidator;

/// A registered kind: everything `Telo.Definition` declared about it, plus the
/// controller slot filled on first use.
pub struct Definition {
    /// Owning module's `metadata.name`.
    pub module: String,
    /// Kind suffix, e.g. `WriteLine`.
    pub name: String,
    /// Canonical `<module>.<Name>` — how the kind is keyed and printed.
    pub kind: String,
    pub capability: Option<String>,
    /// The whole `Telo.Definition` document; the invocation contract and the
    /// author-facing schema are read from it.
    pub manifest: Value,
    pub controllers: Vec<String>,
    /// Where the declaring manifest lives — a controller's `local_path` resolves
    /// against this, never against the importing manifest.
    pub source: String,
    /// Selection policy of the import this kind's module was reached through.
    pub policy: ControllerPolicy,
    controller: RefCell<Option<Rc<LoadedController>>>,
    /// Author-facing schema, compiled once. Every resource of a kind validates
    /// against the same schema, so recompiling per resource pays a JSON Schema
    /// build for something that cannot have changed.
    author_schema: OnceCell<Option<Rc<SchemaValidator>>>,
}

impl Definition {
    pub fn new(
        module: String,
        name: String,
        capability: Option<String>,
        manifest: Value,
        controllers: Vec<String>,
        source: String,
        policy: ControllerPolicy,
    ) -> Self {
        let kind = format!("{module}.{name}");
        Self {
            module,
            name,
            kind,
            capability,
            manifest,
            controllers,
            source,
            policy,
            controller: RefCell::new(None),
            author_schema: OnceCell::new(),
        }
    }

    /// The compiled author-facing schema, or `None` when the kind declares none.
    ///
    /// `kind` and `metadata` are injected before compiling: a definition's schema
    /// is `additionalProperties: false` over the fields the *author* may write,
    /// and those two are the kernel's. A kind that declares no fields at all
    /// still gets them, or the closed schema would reject every document of it.
    pub fn author_schema(&self) -> Result<Option<Rc<SchemaValidator>>, KernelError> {
        if let Some(cached) = self.author_schema.get() {
            return Ok(cached.clone());
        }
        let compiled = match self.manifest.get("schema") {
            None => None,
            Some(schema) => {
                let mut schema = schema.clone();
                if let Some(object) = schema.as_object_mut() {
                    let properties = object
                        .entry("properties")
                        .or_insert_with(|| serde_json::json!({}));
                    if let Some(properties) = properties.as_object_mut() {
                        properties
                            .entry("kind")
                            .or_insert_with(|| serde_json::json!({ "type": "string" }));
                        properties
                            .entry("metadata")
                            .or_insert_with(|| serde_json::json!({ "type": "object" }));
                    }
                }
                Some(Rc::new(SchemaValidator::compile(&schema)?))
            }
        };
        // Ignoring the set race is safe: `OnceCell` is single-threaded here, so
        // a second set can only mean a re-entrant call, and both values are equal.
        let _ = self.author_schema.set(compiled.clone());
        Ok(compiled)
    }

    /// The loaded controller, resolving (and building) it on first use.
    pub fn policy_fingerprint(&self) -> String {
        policy_fingerprint(&self.policy)
    }

    pub fn controller(&self, loader: &ControllerLoader) -> Result<Rc<LoadedController>, KernelError> {
        if let Some(loaded) = self.controller.borrow().as_ref() {
            return Ok(Rc::clone(loaded));
        }
        if self.controllers.is_empty() {
            return Err(KernelError::controller_not_found(format!(
                "kind '{}' declares no controllers",
                self.kind
            )));
        }
        let loaded = loader
            .resolve(&self.controllers, &self.source, &self.policy)
            .map_err(|err| {
                KernelError::new(
                    err.code.clone(),
                    format!("kind '{}': {}", self.kind, err.message),
                )
            })?;
        *self.controller.borrow_mut() = Some(Rc::clone(&loaded));
        Ok(loaded)
    }
}

/// Cross-module uniqueness guard over canonical kinds, shared by every module
/// context in one run.
///
/// Resolution itself goes through `ModuleContext`, which is where a kind's
/// alias has meaning; what this adds is the one check no single module can make
/// — that two modules have not claimed the same `<module>.<Kind>`.
///
/// Keyed by `(kind, policy fingerprint)`, not by kind alone — the same shape the
/// Node registry uses. Two imports of one library may select different
/// controllers for the same kinds, and a kind-only key would read the second
/// registration as a duplicate declaration, reporting a manifest error for
/// something the manifest never did.
#[derive(Default)]
pub struct ControllerRegistry {
    definitions: RefCell<HashMap<(String, String), Rc<Definition>>>,
}

impl ControllerRegistry {
    pub fn register(&self, definition: Rc<Definition>) -> Result<(), KernelError> {
        let key = (definition.kind.clone(), definition.policy_fingerprint());
        let mut definitions = self.definitions.borrow_mut();
        if let Some(existing) = definitions.get(&key) {
            // Same kind, same policy, different declaring file: two modules
            // claiming one canonical kind. Naming both sources is the only way
            // to act on it, since the kind string alone appears in both.
            return Err(KernelError::manifest_validation_failed(format!(
                "kind '{}' is declared by two modules: '{}' and '{}'",
                definition.kind, existing.source, definition.source
            )));
        }
        definitions.insert(key, definition);
        Ok(())
    }
}

/// Stable short identity for a resolved policy, mirroring the Node registry's
/// `policyFingerprint`. The default policy and an explicit `runtime: auto`
/// normalise to the same shape and must share one entry.
pub fn policy_fingerprint(policy: &ControllerPolicy) -> String {
    if *policy == ControllerPolicy::default() {
        return "default".to_string();
    }
    policy.load.join(",")
}
