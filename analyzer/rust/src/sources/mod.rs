//! Mirrors `../../../nodejs/src/sources/`. Only the OCI ref grammar and inline
//! integrity have Rust counterparts: the HTTP source, the hub manifest cache and
//! the versioned-ref helpers serve transports and tooling this kernel lacks.

pub mod integrity;
pub mod oci_ref;
