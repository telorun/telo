//! Mirrors `../../nodejs/src/transports/`. Only the OCI client and the egress
//! guard have Rust counterparts; the OCI manifest-source half is
//! `manifest_sources/oci_source.rs`.

pub mod egress_guard;
pub mod oci;
