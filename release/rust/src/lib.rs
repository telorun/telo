//! `telorun-release` — the release model: units and their anchors, the
//! `release:` block of `telo-workspace.yaml`, fragments, the ledger, the edge
//! graph, groups, version planning, candidates and changelogs, plus the pure
//! halves of the `npm`, `cargo`, `docker` and `helm` ecosystems. `node` holds
//! the host half — evidence, the evidence halves of those ecosystems and the
//! command tree.
//!
//! The twin of `@telorun/release` (`release/nodejs`): every file twins the
//! Node file of its name, kebab-case becoming snake_case, and this file twins
//! `index.ts`.

use std::fmt;
use std::sync::Arc;

pub mod adapter;
pub mod adapters;
pub mod bump_level;
pub mod changelog;
pub mod fragment;
pub mod ledger;
pub mod locale_order;
pub mod marker_reader;
pub mod marker_schema;
pub mod node;
pub mod release_plan;
pub mod release_settings;
pub mod units;
pub mod version_files;
pub mod yaml;

use adapter::EcosystemAdapter;

/// A refusal: one message naming what to fix. The Node twin throws an `Error`
/// subclass per module; only the message crosses to a reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseError {
    pub message: String,
}

impl ReleaseError {
    pub fn new(message: impl Into<String>) -> ReleaseError {
        ReleaseError { message: message.into() }
    }
}

impl fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ReleaseError {}

/// The adapters this crate ships, for a host to register.
pub fn shipped_adapters() -> Vec<Arc<dyn EcosystemAdapter>> {
    vec![
        adapters::npm::NPM_ADAPTER.clone(),
        adapters::cargo::CARGO_ADAPTER.clone(),
        adapters::docker::DOCKER_ADAPTER.clone(),
        adapters::helm::HELM_ADAPTER.clone(),
    ]
}
