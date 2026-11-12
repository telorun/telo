//! Result shape of loading one manifest file, mirroring
//! `../../nodejs/src/loaded-types.ts`.
//!
//! The Node `LoadedFile` also carries the `yaml` package's documents, which only the
//! editor's round trip reads; the Rust half writes no YAML back, so it carries the
//! read-only model and the positions alone. The graph carries no version
//! reconciliation, migration, module-file or child-application half: this loader
//! reads none of them.

use std::collections::HashMap;

use indexmap::IndexMap;
use telo_templating::{UnsupportedConstruct, YamlErrorKind};

use crate::parse_loaded_file::parse_error_message;
use crate::position_metadata::DocumentPosition;
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, AnalysisDiagnostic, Range, ResourceManifest};
use crate::yaml_ast::AstDocument;

/// Where a parse error comes from, which decides what it is reported as.
#[derive(Debug, Clone, PartialEq)]
pub enum ParseErrorOrigin {
    /// A YAML error, `MANIFEST_PARSE_FAILED` in the kind's sentence.
    Yaml(YamlErrorKind),
    /// A refusal both loaders name under `code` — an expansion construct the loader
    /// cannot read.
    Loader { code: &'static str, message: String },
    /// A construct this reader cannot hold, which the Node loader reads: never a
    /// diagnostic, a refusal of the Rust kernel's load.
    Unsupported(UnsupportedConstruct),
}

/// Node's `ParseError` carries `code?` and `message`; here both follow from the origin.
#[derive(Debug, Clone)]
pub struct ParseError {
    pub document_index: usize,
    pub origin: ParseErrorOrigin,
    /// Where the failure is, when the parser or the index places it.
    pub range: Option<Range>,
}

impl ParseError {
    /// What the error says.
    pub fn message(&self) -> String {
        match &self.origin {
            ParseErrorOrigin::Yaml(kind) => parse_error_message(*kind).to_string(),
            ParseErrorOrigin::Loader { message, .. } => message.clone(),
            ParseErrorOrigin::Unsupported(construct) => construct.message(),
        }
    }
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

    /// The file's `Telo.Application` / `Telo.Library` document: its first, when it is one.
    pub fn module_document(&self) -> Option<&ResourceManifest> {
        self.manifests
            .first()
            .and_then(Option::as_ref)
            .filter(|document| kind_of(document).is_some_and(is_module_document))
    }
}

/// An owner file. Node's `LoadedModule` also carries the partials its `include:` list
/// names; this loader reads no `include:` (the Rust kernel refuses it), so a module is its
/// owner alone.
pub struct LoadedModule {
    pub owner: LoadedFile,
}

/// A resolved `imports:` entry: the module it points at and the identity it contributes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEdge {
    /// Canonical source of the target — a key into [`LoadedGraph::modules`].
    pub target_source: String,
    /// The import's `source` exactly as authored.
    pub target_ref: String,
    /// The target library's `metadata.name`.
    pub target_module_name: String,
}

/// Why an import contributes no edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFailureReason {
    /// Aliased `Telo` / `Self`, or reaching a library of either name.
    ReservedPrefix,
    /// Obtained, but not an importable library.
    UnusableTarget,
}

/// One import that contributes no edge, recorded against the import and never fatal to the
/// rest of the walk. Node's other failures — an import that cannot be resolved or read —
/// end this walk as the port's own error instead, since their words are the transport's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphLoadError {
    /// The target as far as it was resolved: the authored source, or the target's canonical one.
    pub url: String,
    /// The import's `source` exactly as authored.
    pub source: String,
    /// The file declaring the import.
    pub from_source: String,
    pub alias: String,
    /// The line of the `imports:` entry.
    pub source_line: Option<usize>,
    pub reason: ImportFailureReason,
    pub message: String,
}

/// An entry module and every library its imports reach, transitively.
pub struct LoadedGraph {
    /// Canonical source of the entry — a key into `modules`.
    pub root_source: String,
    /// Every module reached, by canonical source, in the order they were reached.
    pub modules: IndexMap<String, LoadedModule>,
    /// Each location a module was requested by, to its canonical source.
    pub requested: HashMap<String, String>,
    /// Per importing file, each alias to the module it resolved to.
    pub import_edges: HashMap<String, IndexMap<String, ImportEdge>>,
    /// Every file's parse errors as diagnostics.
    pub parse_diagnostics: Vec<AnalysisDiagnostic>,
    pub errors: Vec<GraphLoadError>,
}

impl LoadedGraph {
    pub fn entry(&self) -> &LoadedModule {
        &self.modules[&self.root_source]
    }

    /// The module `url` was requested as, or its canonical source names.
    pub fn module(&self, url: &str) -> Option<&LoadedModule> {
        let source = self.requested.get(url).map(String::as_str).unwrap_or(url);
        self.modules.get(source)
    }
}
