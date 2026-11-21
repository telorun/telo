//! Where a loaded module came from, which decides how its own findings are reported to an
//! application loading it. Mirrors `../../nodejs/src/module-origin.ts`:
//!
//! - `Editable` — reached from the entry through filesystem-path imports alone, so its files
//!   are the author's to fix: reported at its own lines;
//! - `Artifact` — reached through an `oci://` or `http(s)://` import anywhere on its authored
//!   import chain, or shipped inside an artifact: reported at the entry's import reaching it.
//!
//! Origin follows the import as WRITTEN (`ImportEdge::target_ref`), never the location that
//! served it, so an artifact served as a cached file copy stays one. The walk follows the
//! graph's `imports:` edges; this loader walks no scoped `Telo.Import`, so a module only a
//! scope member reaches is not in the graph.

use std::collections::VecDeque;

use indexmap::{IndexMap, IndexSet};

use crate::loaded_types::{ImportEdge, LoadedGraph};
use crate::manifest_loader::is_local_path_source;
use crate::sources::oci_ref::is_oci_ref;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleOrigin {
    Editable,
    Artifact,
}

/// The origin of every module the entry reaches, keyed by the module's owner source — the
/// entry included, as `Editable`. The edges are the reconciled ones, so a version
/// reconciliation replaced is absent.
pub fn module_origins(graph: &LoadedGraph) -> IndexMap<String, ModuleOrigin> {
    let mut origins = IndexMap::from([(graph.root_source.clone(), ModuleOrigin::Editable)]);
    let mut editable = VecDeque::from([graph.root_source.clone()]);
    while let Some(source) = editable.pop_front() {
        for edge in edges_from(graph, &source) {
            let Some(target) = graph.modules.get(&edge.target_source) else { continue };
            if origins.contains_key(&edge.target_source) {
                continue;
            }
            // A path import inside an artifact names a module shipped in it.
            if !is_local_path_source(&edge.target_ref) || is_oci_ref(&target.owner.requested_url) {
                continue;
            }
            origins.insert(edge.target_source.clone(), ModuleOrigin::Editable);
            editable.push_back(edge.target_source.clone());
        }
    }
    for source in reached_module_sources(graph, &graph.root_source) {
        origins.entry(source).or_insert(ModuleOrigin::Artifact);
    }
    origins
}

/// The owner source of every module reached from `from` through import edges, `from`
/// included, in the order reached.
pub fn reached_module_sources(graph: &LoadedGraph, from: &str) -> IndexSet<String> {
    let mut reached = IndexSet::from([from.to_string()]);
    let mut queue = VecDeque::from([from.to_string()]);
    while let Some(source) = queue.pop_front() {
        for edge in edges_from(graph, &source) {
            if reached.contains(&edge.target_source) || !graph.modules.contains_key(&edge.target_source) {
                continue;
            }
            reached.insert(edge.target_source.clone());
            queue.push_back(edge.target_source.clone());
        }
    }
    reached
}

/// The import edges the module at `source` declares, in declaration order: its owner's — a
/// partial declares no import.
fn edges_from<'g>(graph: &'g LoadedGraph, source: &str) -> impl Iterator<Item = &'g ImportEdge> {
    graph.import_edges.get(source).into_iter().flat_map(|edges| edges.values())
}
