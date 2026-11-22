//! Mirrors `../../../nodejs/src/sources/`. Only the OCI ref grammar, inline integrity, the
//! module-reference reading, the source-failure set and the HTTP source's manifest-URL rule have
//! Rust counterparts: the HTTP source itself, the hub manifest cache and the versioned-ref
//! helpers serve transports and tooling this kernel lacks.

pub mod http_source;
pub mod integrity;
pub mod module_reference;
pub mod oci_ref;
pub mod source_failure;
