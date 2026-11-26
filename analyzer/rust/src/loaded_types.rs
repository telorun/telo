//! Result shape of loading one manifest file, mirroring
//! `../../nodejs/src/loaded-types.ts`.
//!
//! The Node `LoadedFile` also carries the `yaml` package's documents, which only the
//! editor's round trip reads; the Rust half writes no YAML back, so it carries the
//! read-only model and the positions alone. The graph carries no module-file, scoped-import
//! or child-application half: this loader reads none of them.

use std::collections::HashMap;

use indexmap::IndexMap;
use telo_templating::UnsupportedConstruct;

use crate::migrations::FileMigrations;
use crate::parse_loaded_file::{parse_error_message, YamlErrorKind};
use crate::position_metadata::DocumentPosition;
use crate::sources::source_failure::SourceFailureKind;
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
    /// `path` is the refused value's path in its document, for a refusal at an import's
    /// own field.
    Loader { code: &'static str, message: String, path: Option<String> },
    /// A construct this reader cannot hold, which the Node loader reads: never a
    /// diagnostic, a refusal of the Rust kernel's load.
    Unsupported(UnsupportedConstruct),
    /// An import or a partial this file names that this build cannot read (a transport or
    /// a nested artifact the Rust sources lack), in the host's words: as `Unsupported`.
    HostRefusal(String),
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
            ParseErrorOrigin::HostRefusal(message) => message.clone(),
        }
    }

    /// Whether the error is a refusal of the Rust hosts rather than a diagnostic.
    pub fn is_host_refusal(&self) -> bool {
        matches!(self.origin, ParseErrorOrigin::Unsupported(_) | ParseErrorOrigin::HostRefusal(_))
    }
}

#[derive(Clone)]
pub struct LoadedFile {
    /// Canonical location the text was read from — relative imports inside it
    /// resolve against this, never against the process working directory.
    pub source: String,
    /// The location as the importer wrote it.
    pub requested_url: String,
    pub text: String,
    /// One entry per YAML document; `None` for an empty document. A module document's inline
    /// `imports:` follow as synthetic `Telo.Import` documents (`inline_imports`), which no
    /// `ast_documents` entry backs.
    pub manifests: Vec<Option<ResourceManifest>>,
    /// Per-document read-only node model, aligned to the written prefix of `manifests`.
    pub ast_documents: Vec<AstDocument>,
    /// Per-document start line and position index, aligned to `manifests`.
    pub positions: Vec<DocumentPosition>,
    pub parse_errors: Vec<ParseError>,
    /// What the migration phase rewrote in this file, and the diagnostics for it.
    /// `manifests` are the post-migration tree; the positions are the raw file's.
    pub migrations: FileMigrations,
}

impl LoadedFile {
    /// Non-empty documents, in file order.
    pub fn documents(&self) -> impl Iterator<Item = &ResourceManifest> {
        self.manifests.iter().flatten()
    }

    /// The non-empty documents the file's text holds, without the synthetic imports the
    /// desugaring appends.
    pub fn written_documents(&self) -> impl Iterator<Item = &ResourceManifest> {
        self.manifests.iter().take(self.ast_documents.len()).flatten()
    }

    /// The file's `Telo.Application` / `Telo.Library` document: its first one.
    pub fn module_document(&self) -> Option<&ResourceManifest> {
        self.documents().find(|document| kind_of(document).is_some_and(is_module_document))
    }
}

/// An owner file and every partial its `include:` list names.
#[derive(Clone)]
pub struct LoadedModule {
    pub owner: LoadedFile,
    pub partials: Vec<LoadedFile>,
}

impl LoadedModule {
    /// The owner, then each partial.
    pub fn files(&self) -> impl Iterator<Item = &LoadedFile> {
        std::iter::once(&self.owner).chain(self.partials.iter())
    }
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
    /// The target was never obtained: an unrecognizable or unreadable source.
    Unresolved,
    /// Aliased `Telo` / `Self`, or reaching a library of either name.
    ReservedPrefix,
    /// Obtained, but not an importable library.
    UnusableTarget,
}

/// One import that contributes no edge, recorded against the import and never fatal to the
/// rest of the walk.
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
    /// The kind of source failure that left the target unobtained, when its source named one;
    /// `message` is then that failure's sentence.
    pub source_failure: Option<SourceFailureKind>,
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
    /// Per importing file, in the order reached, each alias to the module it resolved to —
    /// version reconciliation applied.
    pub import_edges: IndexMap<String, IndexMap<String, ImportEdge>>,
    /// Each losing version's canonical source, to the winner's.
    pub overrides: IndexMap<String, String>,
    /// Every file's parse errors as diagnostics.
    pub parse_diagnostics: Vec<AnalysisDiagnostic>,
    /// What version reconciliation reports: a hoist between differing sources, a conflict
    /// between majors.
    pub version_diagnostics: Vec<AnalysisDiagnostic>,
    /// The deprecations the migration phase reports: the entry module's own file only,
    /// since a published dependency is not the consumer's to fix.
    pub migration_diagnostics: Vec<AnalysisDiagnostic>,
    /// Every module file claim of the entry and of each module it reaches through a path or
    /// http(s) import that names nothing, or that its source could not answer for
    /// (`module_file_existence`).
    pub module_file_diagnostics: Vec<AnalysisDiagnostic>,
    /// Every loader stamp an author wrote on a document of a module the entry runs
    /// (`METADATA_RESERVED_FIELD`): the entry's own where written, a dependency's at the
    /// entry's import first reaching it.
    pub metadata_diagnostics: Vec<AnalysisDiagnostic>,
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

    /// Every file of every module: each owner, then its partials.
    pub fn files(&self) -> impl Iterator<Item = &LoadedFile> {
        self.modules.values().flat_map(LoadedModule::files)
    }
}
