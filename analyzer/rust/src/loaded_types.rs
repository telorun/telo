//! Result shape of loading one manifest file, mirroring
//! `../../nodejs/src/loaded-types.ts`.
//!
//! The Node `LoadedFile` also carries the `yaml` package's documents, which only the
//! editor's round trip reads; the Rust half writes no YAML back, so it carries the
//! read-only model and the positions alone.

use crate::position_metadata::DocumentPosition;
use crate::types::{Range, ResourceManifest};
use crate::yaml_ast::AstDocument;

#[derive(Debug, Clone)]
pub struct ParseError {
    pub document_index: usize,
    /// The diagnostic code of a refusal the loaders name (an expansion
    /// construct the loader cannot read); `None` for an unreadable document,
    /// reported as `MANIFEST_PARSE_FAILED`.
    pub code: Option<String>,
    pub message: String,
    /// Where the failure is, when the parser or the index places it.
    pub range: Option<Range>,
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
    /// Per-document read-only node model, aligned to `manifests`.
    pub ast_documents: Vec<AstDocument>,
    /// Per-document start line and position index, aligned to `manifests`.
    pub positions: Vec<DocumentPosition>,
    pub parse_errors: Vec<ParseError>,
}

impl LoadedFile {
    /// Non-empty documents, in file order.
    pub fn documents(&self) -> impl Iterator<Item = &ResourceManifest> {
        self.manifests.iter().flatten()
    }
}
