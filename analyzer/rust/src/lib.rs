//! Telo manifest loading and reference resolution for the Rust kernel.
//!
//! Mirrors the part of `analyzer/nodejs` the kernel depends on at runtime:
//! reading a manifest file, parsing its documents, and rewriting `!ref`
//! sentinels. The static-analysis passes that make up the rest of the Node
//! package have no Rust counterpart yet — this crate is where they belong when
//! they arrive, which is why loading lives here rather than in the kernel.
//!
//! The artifact model — selectors, the layer index, the OCI ref grammar and
//! inline integrity — lives here for the same reason it lives in the Node
//! analyzer: every reader of a published module must agree on it.

pub mod artifact_layer_index;
pub mod artifact_selector;
pub mod builtins;
pub mod loaded_types;
pub mod manifest_loader;
pub mod native_entries;
pub mod parse_loaded_file;
pub mod release;
pub mod resolve_ref_sentinels;
pub mod source_entries;
pub mod sources;
pub mod system_kinds;
pub mod types;

pub use loaded_types::{LoadedFile, ParseError};
pub use manifest_loader::{resolve_source, ManifestLoader};
pub use parse_loaded_file::parse_loaded_file;
pub use release::WORKSPACE_FILENAME;
pub use resolve_ref_sentinels::{
    as_resolved_ref, find_invalid_reference_forms, find_unresolved_sentinels,
    resolve_ref_sentinels, InvalidReferenceForm, RefTargets, ResolvedRef, UnresolvedRef,
};
pub use types::{
    kind_of, name_of, LoadError, ManifestSource, ReadManifest, ResourceManifest,
    DEFAULT_MANIFEST_FILENAME,
};
