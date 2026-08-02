//! Shared manifest types, mirroring `../../nodejs/src/types.ts`.
//!
//! A manifest is a plain [`serde_json::Value`]; the accessors below name the
//! handful of well-known fields rather than introducing a struct, because a
//! resource's shape is defined by its kind's schema and not by the kernel.
//!
//! In Node these types come from `@telorun/sdk`. They live here instead because
//! the Rust kernel must not depend on `telorun-sdk`: that crate selects a
//! controller backend by feature, and Cargo would unify the napi backend into
//! the kernel binary.

use serde_json::Value;

pub const DEFAULT_MANIFEST_FILENAME: &str = "telo.yaml";

/// A single YAML document from a manifest file.
pub type ResourceManifest = Value;

/// What a [`ManifestSource`] hands back: the text and the canonical location it
/// was read from, which later relative sources resolve against.
pub struct ReadManifest {
    pub text: String,
    pub source: String,
}

/// A transport a manifest can be read through. The Rust kernel registers only
/// the local-file source; OCI and HTTP transports have no Rust implementation
/// yet, so an `oci://` import fails at resolution with a precise message rather
/// than being silently skipped.
pub trait ManifestSource {
    fn supports(&self, path_or_url: &str) -> bool;
    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError>;
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("no manifest source supports `{0}`. This kernel reads local paths only")]
    UnsupportedSource(String),
    #[error("failed to read `{path}`: {message}")]
    Io { path: String, message: String },
    // The field is `path`, not `source`: thiserror reads a field named `source`
    // as the underlying error to chain to.
    #[error("failed to parse `{path}`: {message}")]
    Parse { path: String, message: String },
}

/// `kind` of a resource document.
pub fn kind_of(manifest: &ResourceManifest) -> Option<&str> {
    manifest.get("kind").and_then(Value::as_str)
}

/// `metadata.name` of a resource document.
pub fn name_of(manifest: &ResourceManifest) -> Option<&str> {
    manifest
        .get("metadata")
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
}
