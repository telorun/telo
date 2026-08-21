//! Mirrors `analyzer/nodejs/src/release/`. Only the workspace marker's filename
//! has a Rust counterpart so far — the release planner, ledger and version
//! stamping are Node-only, since `telo release` is a Node command.

pub mod workspace_config;

pub use workspace_config::WORKSPACE_FILENAME;
