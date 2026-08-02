//! Result shape of loading one manifest file, mirroring
//! `../../nodejs/src/loaded-types.ts`.
//!
//! The Node `LoadedFile` also carries the YAML AST and per-document source
//! positions, which exist to anchor diagnostics in an editor. The Rust kernel
//! reports errors by manifest and document index only, so those are absent
//! until a Rust analyzer needs them.

use crate::types::ResourceManifest;

pub struct ParseError {
    pub document_index: usize,
    pub message: String,
}

pub struct LoadedFile {
    /// Canonical location the text was read from — relative imports inside it
    /// resolve against this, never against the process working directory.
    pub source: String,
    /// The location as the importer wrote it.
    pub requested_url: String,
    pub text: String,
    /// One entry per YAML document; `None` for an empty document.
    pub manifests: Vec<Option<ResourceManifest>>,
    pub parse_errors: Vec<ParseError>,
}

impl LoadedFile {
    /// Non-empty documents, in file order.
    pub fn documents(&self) -> impl Iterator<Item = &ResourceManifest> {
        self.manifests.iter().flatten()
    }
}
