//! Which of a library's own findings an application can reach. Mirrors
//! `../../nodejs/src/dependency-configurations.ts` for what this analyzer records.
//!
//! Node keeps a dependency's finding only when one configuration it holds in
//! (`data.configurations`, in the library's own dimensions) agrees with what some import of
//! the library fixes. No pass of this analyzer judges per configuration, so no finding it
//! makes carries `configurations`, and a finding with none holds in every configuration and
//! is reached by every import: the comparison against what an import fixes arrives with the
//! first pass here that records one.

use crate::loaded_types::LoadedGraph;
use crate::types::ResourceManifest;

/// The library's module document among its owner file's documents.
pub fn library_document_of<'g>(graph: &'g LoadedGraph, library_source: &str) -> Option<&'g ResourceManifest> {
    graph.modules.get(library_source)?.owner.module_document()
}
