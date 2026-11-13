//! The host half: evidence (git reads, the ledger store, carried changes,
//! layer file sets, edges, read-back), the evidence halves of the shipped
//! `npm`, `cargo`, `docker` and `helm` ecosystems, and the release command
//! tree a host mounts. The directory keeps its twin's name, `node/`, the Node
//! package's entry for the same half; this file twins its `index.ts`.

use std::sync::Arc;

pub mod adapters;
pub mod adopt_changesets;
pub mod carried_changes;
pub mod commands;
pub mod declared_payload;
pub mod evidence;
pub mod files_digest;
pub mod git;
pub mod host;
pub mod ledger_store;
pub mod metafile;
pub mod operations;
pub mod registry_fetch;
pub mod render;
pub mod tar;
pub mod workspace;

use evidence::EvidenceAdapter;

/// The evidence halves of the ecosystems this crate ships.
pub fn shipped_evidence() -> Vec<Arc<dyn EvidenceAdapter>> {
    vec![
        Arc::new(adapters::npm_evidence::NpmEvidence),
        Arc::new(adapters::cargo_evidence::CargoEvidence),
        Arc::new(adapters::docker_evidence::DockerEvidence),
        Arc::new(adapters::helm_evidence::HelmEvidence),
    ]
}
