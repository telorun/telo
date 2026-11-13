//! The seam between the planner and an ecosystem.
//!
//! The planner never branches on an ecosystem's name: everything it knows
//! about one is an answer from that ecosystem's adapter, registered in-process
//! by the host program. This is the adapter's pure half — it reads file text a
//! host hands it and answers from that alone. Payload file sets, edges and
//! read-back are the evidence half a host adds.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::marker_schema::KeySchemas;
use crate::ReleaseError;

/// A version location: a file and, for JSON, YAML or TOML, an RFC 6901 pointer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionLocationSpec {
    pub file: String,
    pub pointer: Option<String>,
}

/// What an adapter is shown of one anchor.
pub struct AnchorProbe<'a> {
    /// The unit's key.
    pub unit: &'a str,
    /// The anchor, unit-relative (`.` the unit itself).
    pub anchor: &'a str,
    /// The anchor's workspace-relative directory (`""` the workspace root).
    pub dir: &'a str,
    pub read: &'a dyn Fn(&str) -> Option<String>,
}

impl AnchorProbe<'_> {
    /// A file beneath the anchor, by anchor-relative path.
    pub fn read_file(&self, relative: &str) -> Option<String> {
        (self.read)(relative)
    }
}

/// An anchor the adapter recognised as one package of its ecosystem.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecognizedPackage {
    pub name: Option<String>,
    /// Whether the package contributes a layer (a private npm package does not).
    pub contributes_layer: bool,
    /// Further anchor-relative files carrying the unit's version.
    pub version_files: Vec<String>,
}

/// A file a handler rewrote beside the one it serves.
pub struct Companion {
    pub file: String,
    pub text: String,
}

/// Reads and writes the version in one kind of file, chosen by its name.
pub trait VersionFileHandler: Send + Sync {
    fn file_name(&self) -> &'static str;
    fn read(&self, text: &str, at: &str) -> Result<Option<String>, ReleaseError>;
    /// The file rewritten to carry `version`, or `None` when it carries none.
    fn write(&self, text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError>;
    /// Files outside this one that move with it, each rewritten.
    fn companions(&self, file: &str, version: &str, read: &dyn Fn(&str) -> Option<String>) -> Result<Vec<Companion>, ReleaseError> {
        let _ = (file, version, read);
        Ok(Vec::new())
    }
}

pub trait EcosystemAdapter: Send + Sync {
    /// The name a `release.units` entry lists under `ecosystem`.
    fn ecosystem(&self) -> &'static str;
    /// What an anchor of this ecosystem is, for an author reading a refusal.
    fn anchor_description(&self) -> &'static str;
    /// The keys this ecosystem reads in an anchor's settings and in its block
    /// defaults.
    fn keys(&self) -> KeySchemas {
        Vec::new()
    }
    /// Where an anchor keeps its version, anchor-relative.
    fn version_file(&self) -> Option<VersionLocationSpec> {
        None
    }
    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage>;
    fn version_file_handlers(&self) -> Vec<Arc<dyn VersionFileHandler>> {
        Vec::new()
    }
}

/// The ecosystem names the planner keeps for its own layers.
pub const RESERVED_ECOSYSTEMS: &[&str] = &["payload"];

/// The adapters one host registered, with their version-file handlers.
#[derive(Clone)]
pub struct AdapterRegistry {
    by_ecosystem: IndexMap<String, Arc<dyn EcosystemAdapter>>,
    handlers: IndexMap<String, Arc<dyn VersionFileHandler>>,
}

impl AdapterRegistry {
    pub fn new(adapters: &[Arc<dyn EcosystemAdapter>]) -> Result<AdapterRegistry, ReleaseError> {
        let mut by_ecosystem: IndexMap<String, Arc<dyn EcosystemAdapter>> = IndexMap::new();
        let mut handlers: IndexMap<String, Arc<dyn VersionFileHandler>> = IndexMap::new();
        for adapter in adapters {
            let name = adapter.ecosystem();
            if RESERVED_ECOSYSTEMS.contains(&name) {
                return Err(ReleaseError::new(format!("'{name}' is reserved and names no ecosystem.")));
            }
            if by_ecosystem.contains_key(name) {
                return Err(ReleaseError::new(format!("Two adapters are registered for the '{name}' ecosystem.")));
            }
            by_ecosystem.insert(name.to_string(), adapter.clone());
            for handler in adapter.version_file_handlers() {
                if let Some(existing) = handlers.get(handler.file_name()) {
                    if !Arc::ptr_eq(existing, &handler) {
                        return Err(ReleaseError::new(format!(
                            "Two version-file handlers are registered for '{}'.",
                            handler.file_name()
                        )));
                    }
                }
                handlers.insert(handler.file_name().to_string(), handler);
            }
        }
        Ok(AdapterRegistry { by_ecosystem, handlers })
    }

    pub fn get(&self, ecosystem: &str) -> Option<&Arc<dyn EcosystemAdapter>> {
        self.by_ecosystem.get(ecosystem)
    }

    pub fn has(&self, ecosystem: &str) -> bool {
        self.by_ecosystem.contains_key(ecosystem)
    }

    pub fn all(&self) -> impl Iterator<Item = &Arc<dyn EcosystemAdapter>> {
        self.by_ecosystem.values()
    }

    pub fn handler_for(&self, file_name: &str) -> Option<&Arc<dyn VersionFileHandler>> {
        self.handlers.get(file_name)
    }
}
