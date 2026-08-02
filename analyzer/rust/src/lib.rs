//! Telo manifest loading and reference resolution for the Rust kernel.
//!
//! Mirrors the part of `analyzer/nodejs` the kernel depends on at runtime:
//! reading a manifest file, parsing its documents, and rewriting `!ref`
//! sentinels. The static-analysis passes that make up the rest of the Node
//! package have no Rust counterpart yet — this crate is where they belong when
//! they arrive, which is why loading lives here rather than in the kernel.

pub mod builtins;
pub mod loaded_types;
pub mod manifest_loader;
pub mod parse_loaded_file;
pub mod resolve_ref_sentinels;
pub mod system_kinds;
pub mod types;

pub use loaded_types::{LoadedFile, ParseError};
pub use manifest_loader::{resolve_source, ManifestLoader};
pub use parse_loaded_file::parse_loaded_file;
pub use resolve_ref_sentinels::{
    as_resolved_ref, find_invalid_reference_forms, find_unresolved_sentinels,
    resolve_ref_sentinels, InvalidReferenceForm, RefTargets, ResolvedRef, UnresolvedRef,
};
pub use types::{
    kind_of, name_of, LoadError, ManifestSource, ReadManifest, ResourceManifest,
    DEFAULT_MANIFEST_FILENAME,
};
