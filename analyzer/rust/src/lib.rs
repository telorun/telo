//! Telo manifest loading and reference resolution for the Rust kernel.
//!
//! Mirrors the part of `analyzer/nodejs` the kernel depends on at runtime:
//! reading a manifest file, parsing its documents (through `telo-templating`'s YAML
//! composer, with each document's position index beside the tree), applying the manifest
//! migrations of `analyzer/migrations/` to them, walking an entry's module graph — inline
//! imports desugared, `include:` partials read, versions reconciled, each import's failure
//! and each file's module-declaration and partial refusal coded as Node codes them —
//! rewriting `!ref` sentinels, and reading what a schema node says of the value at it (the
//! host-path slot readers and the walk pairing each text leaf with its node). Its static
//! analysis is Node's `AnalysisDiagnostic` for the deprecations the migrations report and
//! the refusals the Rust kernel makes — a YAML parse failure, the loader's expansion and
//! file refusals, an import's failure, a version conflict, a reserved kind prefix, a module's
//! declared runtime requirements against the surface this build implements (`telo_version`,
//! read from the built-in vocabulary archive it embeds) with the gate's cover, the capability
//! roster, the reference forms, a plain string left holding `${{`, and the module documents' own
//! blocks (a library's `env:` / `arg:` keys and exported names, the `native:` and `sources:` blocks
//! and the module files they and the manifest claim, the placement of file embeds), and whether
//! each module file claim of the entry and its path imports names something, asked of the
//! module's own source (`module_file_existence`) — located by Node's fallback chain. `telo check` and the kernel read them through one entry assembly
//! (`entry_diagnostics`, which also names the constructs this build cannot read and holds back
//! the files they name); `telo check` adds the dependency verdict (`graph_analysis`: each
//! imported library judged by its own entry assembly, reported by its origin, memoized by a
//! digest of its closure), and the kernel refuses a load by the twin of Node's load refusal rule
//! (`load_refusal`), group for group, raising each static code under the rule's one mapping
//! (`load_refusal_code`). A library's `migrations:` block is read and its `match` twinned, but the
//! consumer stage applying it is not: where one may apply, the hosts refuse the import
//! reaching the library instead (`library_migrations`). Node's other passes have no
//! counterpart yet, and this crate is where they belong when they arrive.
//!
//! The artifact model — selectors, the layer index, the OCI ref grammar and
//! inline integrity — lives here for the same reason it lives in the Node
//! analyzer: every reader of a published module must agree on it.

pub mod ajv_core;
pub mod ajv_equal;
pub mod ajv_formats;
pub mod ajv_keywords;
pub mod ajv_runtime;
pub mod ajv_uri_resolver;
pub mod analyzer;
pub mod artifact_layer_index;
pub mod artifact_selector;
pub mod builtin_vocabulary;
pub mod builtin_vocabulary_slices;
pub mod builtins;
pub mod capability_roster;
pub mod cpe_format;
pub mod css_selector_format;
pub mod dependency_configurations;
pub mod dependency_verdicts;
pub mod diagnostic_identity;
pub mod diagnostic_location;
pub mod entry_diagnostics;
pub mod finding_order;
pub mod finishing_pipeline;
pub mod flatten_for_analyzer;
pub mod graph_analysis;
pub mod graph_diagnostics;
pub mod host_path_slot;
pub mod import_input_values;
pub mod import_resolution_diagnostics;
pub mod inline_imports;
pub mod language_tag_format;
pub mod levenshtein;
pub mod library_migrations;
pub mod load_refusal;
pub mod load_refusal_code;
pub mod loaded_types;
pub mod loader_expansion_refusals;
pub mod manifest_loader;
pub mod manifest_navigation;
pub mod manifest_schemas;
pub mod members_value_slot;
pub mod message_pattern_format;
pub mod metadata_stamp_refusals;
pub mod metadata_stamps;
pub mod migrations;
pub mod module_alias_scope;
pub mod module_browser;
pub mod module_declaration_refusals;
pub mod module_file_claims;
pub mod module_file_existence;
pub mod module_library;
pub mod module_named_files;
pub mod module_origin;
pub mod module_relative_path;
pub mod module_version_order;
pub mod native_entries;
pub mod nearest_name;
pub mod need_type;
pub mod package_url_format;
pub mod parse_loaded_file;
pub mod path_template_format;
pub mod path_template_reading;
pub mod placement;
pub mod plain_literal_decoding;
pub mod position_metadata;
pub mod purl;
pub mod quoted_place;
pub mod re2_pattern_format;
pub mod reaching_import;
pub mod reconcile_module_versions;
pub mod reference_field_map;
pub mod release;
pub mod requires_block;
pub mod requires_gate;
pub mod reserved_kind_prefix;
pub mod residual_schema;
pub mod resolve_ref_sentinels;
pub mod resolved_reference;
pub mod restrictions;
pub mod runtime_range;
pub mod schema_at_pointer;
pub mod schema_compat;
pub mod schema_error_report;
pub mod schema_findings_judge;
pub mod schema_in_place_cycle;
pub mod schema_in_place_cycle_findings;
pub mod schema_node_validator;
pub mod schema_opaque_value;
pub mod schema_pattern;
pub mod schema_region;
pub mod schema_tag_text;
pub mod schema_validation;
pub mod source_entries;
pub mod stand_in_findings;
pub mod sources;
pub mod system_kinds;
pub mod telo_format;
pub mod telo_version;
pub mod types;
pub mod union_outcome;
pub mod union_tags;
pub mod untagged_interpolation;
pub mod validate_identifier_names;
pub mod validate_include_placement;
pub mod validate_input_defaults;
pub mod validate_library_blocks;
pub mod validate_native_entries;
pub mod validate_reference_forms;
pub mod validate_requires;
pub mod validate_source_entries;
pub mod validated_schemas;
pub mod value_depth;
pub mod value_type_defaults;
pub mod value_type_keyword;
pub mod vcs_revision_format;
pub mod vcs_url_format;
pub mod version_range;
pub mod yaml_ast;

pub use analyzer::{analysis, analyze, Analysis};
pub use requires_gate::UndecidedHold;
pub use validate_requires::UndecidedModule;
pub use dependency_verdicts::{
    analyze_dependencies, dependency_verdict_key, library_graph, DependencyAnalysis, DependencyAnalysisOptions,
    DependencyVerdict, DependencyVerdictMemo, DependencyVerdictRecord, DependencyVerdictStore, VERDICT_FORMAT,
};
pub use diagnostic_identity::{defect_identity, diagnostic_identity, union_diagnostics, written_place_of};
pub use diagnostic_location::{find_positions, locate_diagnostic, resolve_range, LocatedDiagnostic};
pub use entry_diagnostics::{assemble_entry_diagnostics, host_refusals, EntryDiagnostics, HostRefusal};
pub use finding_order::FindingOrder;
pub use graph_analysis::{analyze_loaded_graph, GraphAnalysis};
pub use graph_diagnostics::{assemble_graph_diagnostics, compromised_files, AssembledDiagnostics};
pub use import_resolution_diagnostics::{import_failure_code, import_failure_diagnostics};
pub use load_refusal::{load_refusal, LoadRefusal, LoadRefusalHost, UNSUPPORTED_MANIFEST_FEATURE};
pub use load_refusal_code::runtime_code_of;
pub use library_migrations::{unapplied_library_migrations, UnappliedLibraryMigration};
pub use loaded_types::{
    GraphLoadError, ImportEdge, ImportFailureReason, LoadedFile, LoadedGraph, LoadedModule, ParseError,
    ParseErrorOrigin,
};
pub use module_origin::{module_origins, reached_module_sources, ModuleOrigin};
pub use manifest_loader::{
    import_target_identity, is_local_path_source, load_graph, resolve_source, ImportTargetPort, ManifestLoader,
};
pub use migrations::{core_migrations, migrate_manifests, remap_migrated_paths, FileMigrations, MigrationRewrite};
pub use parse_loaded_file::{parse_error_kind, parse_error_message, parse_loaded_file, YamlErrorKind};
pub use position_metadata::DocumentPosition;
pub use release::WORKSPACE_FILENAME;
pub use telo_version::{TELO_RUNNING_SURFACE, TELO_SURFACE_VERSION};
pub use resolve_ref_sentinels::{
    as_resolved_ref, find_unresolved_sentinels, resolve_ref_sentinels, RefTargets, ResolvedRef,
    UnresolvedRef,
};
pub use resolved_reference::{
    carries_reference_marker, declares_name_field, is_resolved_reference,
    RESOLVED_REFERENCE_MARKER,
};
pub use reference_field_map::{value_branch_accepts, value_branches_accept, ValueBranchOutcome};
pub use validate_reference_forms::{
    authored_object_form, find_invalid_reference_forms, mark_legacy_references, nesting_exceeded_slot_message,
    reference_form_message, target_reference_forms, InvalidReferenceForm, ReferenceForm, ReferenceFormFindings,
    UnfinishedSlot,
};
pub use types::{
    kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticFix, DiagnosticFixTag, DiagnosticMigration, DiagnosticResource,
    DiagnosticSeverity, DiagnosticTag, HostEntryKind, join_relative, LoadError, ManifestSource, Position, PositionIndex, Range, ReadManifest,
    ResourceManifest, ANALYZER_SOURCE, DEFAULT_MANIFEST_FILENAME,
};
