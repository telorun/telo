//! Mirrors `../../../nodejs/src/sources/`. Only the OCI ref grammar, inline integrity, the
//! module-reference reading and the source-failure set have Rust counterparts: the HTTP source, the hub manifest cache
//! and the versioned-ref helpers serve transports and tooling this kernel lacks.

pub mod integrity;
pub mod module_reference;
pub mod oci_ref;
pub mod source_failure;
