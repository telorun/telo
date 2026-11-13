//! The complete diagnostic set of a loaded graph, as every host presents it. Mirrors
//! `../../nodejs/src/graph-diagnostics.ts`: parse, migration and import-resolution
//! diagnostics first, then the analysis diagnostics of every file whose analysis is not a
//! cascade of a parse or import failure, each path remapped onto what the author wrote.
//! This loader reads no version reconciliation or module file claim, so those groups have
//! no twin.

use std::collections::HashSet;

use crate::diagnostic_location::find_positions;
use crate::import_resolution_diagnostics::import_resolution_diagnostics;
use crate::loaded_types::LoadedGraph;
use crate::migrations::remap_migrated_paths;
use crate::types::AnalysisDiagnostic;

/// Files whose analysis diagnostics are a cascade: a file that failed to parse, and a file
/// one of whose imports failed.
pub fn compromised_files(graph: &LoadedGraph) -> HashSet<String> {
    let mut files: HashSet<String> = graph
        .parse_diagnostics
        .iter()
        .filter_map(|d| d.data.as_ref().and_then(|data| data.file_path.clone()))
        .collect();
    files.extend(graph.errors.iter().map(|error| error.from_source.clone()));
    files
}

/// What to surface, and the analysis cascade held back from compromised files.
pub struct AssembledDiagnostics {
    pub diagnostics: Vec<AnalysisDiagnostic>,
    pub suppressed: Vec<AnalysisDiagnostic>,
}

pub fn assemble_graph_diagnostics(graph: &LoadedGraph, analysis: Vec<AnalysisDiagnostic>) -> AssembledDiagnostics {
    let compromised = compromised_files(graph);
    let mut live = Vec::new();
    let mut suppressed = Vec::new();
    // Analysis ran over the migrated tree, positions come from the raw file.
    for d in remap_migrated_paths(graph, analysis) {
        let file = find_positions(graph, d.data.as_ref())
            .map(|positions| positions.file)
            .or_else(|| d.data.as_ref().and_then(|data| data.file_path.clone()))
            .unwrap_or_else(|| graph.root_source.clone());
        if compromised.contains(&file) {
            suppressed.push(d);
        } else {
            live.push(d);
        }
    }
    let mut diagnostics = graph.parse_diagnostics.clone();
    diagnostics.extend(graph.migration_diagnostics.iter().cloned());
    diagnostics.extend(import_resolution_diagnostics(graph));
    diagnostics.extend(live);
    AssembledDiagnostics { diagnostics, suppressed }
}
