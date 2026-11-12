//! Telo manifest loading and reference resolution for the Rust kernel.
//!
//! Mirrors the part of `analyzer/nodejs` the kernel depends on at runtime:
//! reading a manifest file, parsing its documents (through `telo-templating`'s YAML
//! composer, with each document's position index beside the tree), walking an entry's
//! import graph, rewriting `!ref` sentinels, and reading what a schema node says of the
//! value at it (the host-path slot readers and the walk pairing each text leaf with its
//! node). Its static analysis is Node's `AnalysisDiagnostic` for the refusals the Rust
//! kernel makes — a YAML parse failure, the loader's expansion refusals, a reserved kind
//! prefix, the capability roster and the reference forms — located by Node's fallback
//! chain; the kernel raises them from here. Node's other passes have no counterpart yet,
//! and this crate is where they belong when they arrive.
//!
//! The artifact model — selectors, the layer index, the OCI ref grammar and
//! inline integrity — lives here for the same reason it lives in the Node
//! analyzer: every reader of a published module must agree on it.

pub mod analyzer;
pub mod artifact_layer_index;
pub mod artifact_selector;
pub mod builtin_vocabulary;
pub mod builtin_vocabulary_slices;
pub mod builtins;
pub mod capability_roster;
pub mod diagnostic_location;
pub mod graph_diagnostics;
pub mod host_path_slot;
pub mod import_resolution_diagnostics;
pub mod levenshtein;
pub mod loaded_types;
pub mod loader_expansion_refusals;
pub mod manifest_loader;
pub mod manifest_navigation;
pub mod module_alias_scope;
pub mod native_entries;
pub mod nearest_name;
pub mod parse_loaded_file;
pub mod plain_literal_decoding;
pub mod position_metadata;
pub mod quoted_place;
pub mod reaching_import;
pub mod release;
pub mod reserved_kind_prefix;
pub mod resolve_ref_sentinels;
pub mod resolved_reference;
pub mod schema_compat;
pub mod source_entries;
pub mod sources;
pub mod system_kinds;
pub mod types;
pub mod validate_identifier_names;
pub mod validate_reference_forms;
pub mod value_type_keyword;
pub mod yaml_ast;

pub use analyzer::{analyze, AnalysisOptions};
pub use diagnostic_location::{find_positions, locate_diagnostic, resolve_range, LocatedDiagnostic};
pub use graph_diagnostics::{assemble_graph_diagnostics, compromised_files, AssembledDiagnostics};
pub use import_resolution_diagnostics::{import_failure_code, import_failure_diagnostics};
pub use loaded_types::{
    GraphLoadError, ImportEdge, ImportFailureReason, LoadedFile, LoadedGraph, LoadedModule, ParseError,
    ParseErrorOrigin,
};
pub use manifest_loader::{load_graph, resolve_source, ImportTargetPort, ManifestLoader};
pub use parse_loaded_file::{parse_error_message, parse_loaded_file};
pub use position_metadata::DocumentPosition;
pub use release::WORKSPACE_FILENAME;
pub use resolve_ref_sentinels::{
    as_resolved_ref, find_unresolved_sentinels, resolve_ref_sentinels, RefTargets, ResolvedRef,
    UnresolvedRef,
};
pub use resolved_reference::{
    carries_reference_marker, declares_name_field, is_resolved_reference,
    RESOLVED_REFERENCE_MARKER,
};
pub use validate_reference_forms::{
    authored_object_form, find_invalid_reference_forms, mark_legacy_references,
    reference_form_message, target_reference_forms, AcceptsValue, InvalidReferenceForm, ReferenceForm,
};
pub use types::{
    kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticFix, DiagnosticFixTag, DiagnosticResource,
    DiagnosticSeverity, DiagnosticTag, LoadError, ManifestSource, Position, PositionIndex, Range, ReadManifest,
    ResourceManifest, ANALYZER_SOURCE, DEFAULT_MANIFEST_FILENAME,
};
