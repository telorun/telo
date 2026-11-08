//! The engine registry — `registry.ts`, read-only.
//!
//! Node's registry is mutable, built by registering engines one by one and refusing a
//! duplicate. The set of built-in engines is closed, so here it is a static table (`builtins.rs`)
//! and the registry only reads it: `register`, and the duplicate refusal with it, have no twin.

use crate::engine::TemplatingEngine;

/// A table of engines, looked up by tag name.
pub struct TemplatingEngineRegistry {
    engines: &'static [&'static dyn TemplatingEngine],
}

impl TemplatingEngineRegistry {
    pub(crate) const fn new(engines: &'static [&'static dyn TemplatingEngine]) -> Self {
        Self { engines }
    }

    pub fn get(&self, name: &str) -> Option<&'static dyn TemplatingEngine> {
        self.engines.iter().copied().find(|engine| engine.name() == name)
    }

    pub fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// All engines, in table order.
    pub fn list(&self) -> &'static [&'static dyn TemplatingEngine] {
        self.engines
    }
}
