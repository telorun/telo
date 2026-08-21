//! `telo-workspace.yaml` — the release anchor.
//!
//! Mirrors `analyzer/nodejs/src/release/workspace-config.ts`, of which only the
//! filename constant has a Rust counterpart so far. Parsing the file's
//! `modules:` list is release scope and the Rust side has no release commands;
//! what it needs is the marker's LOCATION, which is what anchors the `.telo`
//! cache. Naming the file is the analyzer's either way, so that both halves of
//! the toolchain look for the same name and a workspace cannot be visible to one
//! runtime and not the other.

/// The workspace marker's filename. Its containing directory is the anchor every
/// workspace-relative path is measured from.
pub const WORKSPACE_FILENAME: &str = "telo-workspace.yaml";
