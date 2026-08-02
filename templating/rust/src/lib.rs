//! Telo templating for the Rust kernel.
//!
//! Mirrors the half of `templating/nodejs` the kernel depends on to read a
//! manifest: the tagged-sentinel shape and the YAML tag configuration. The CEL
//! engine that fills out the Node package has no Rust counterpart yet, and this
//! crate is where it will land.

pub mod sentinel;
pub mod yaml_tags;

pub use sentinel::{is_tagged_sentinel, make_tagged_sentinel, ref_sentinel_source, REF_ENGINE};
pub use yaml_tags::{yaml_to_json, TagError};
