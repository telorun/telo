//! A loaded graph judged whole, as `telo check` reports it: the entry's own analysis and every
//! library's verdict, assembled as every checking host presents them. Mirrors
//! `../../nodejs/src/graph-analysis.ts`. The kernel's load reads the entry assembly alone: the
//! verdict is check-only.
//!
//! What this build cannot read is held back here as in the entry assembly: a finding of a
//! library in a file one of the entry's host refusals holds back is dropped with the rest.

use crate::analyzer::analyze;
use crate::dependency_verdicts::{
    analyze_dependencies, without_covered_artifact_warnings, without_covered_dependency_findings, DependencyAnalysis,
    DependencyAnalysisOptions,
};
use crate::diagnostic_identity::union_diagnostics;
use crate::entry_diagnostics::{assemble_entry_diagnostics, without_held_files, HostRefusal};
use crate::loaded_types::LoadedGraph;
use crate::types::{AnalysisDiagnostic, DiagnosticSeverity};

pub struct GraphAnalysis<'g> {
    pub dependencies: DependencyAnalysis,
    /// What to report: the graph's load findings and the entry's live analysis, minus each
    /// finding a library's verdict reports as the same defect, then every library's verdict,
    /// each identity once.
    pub diagnostics: Vec<AnalysisDiagnostic>,
    /// The entry's analysis cascade held back on compromised files.
    pub suppressed: Vec<AnalysisDiagnostic>,
    /// The errors of `diagnostics`.
    pub errors: Vec<AnalysisDiagnostic>,
    /// What this build cannot read of the graph.
    pub host_refusals: Vec<HostRefusal<'g>>,
}

/// Analyze `graph` as `telo check` does: the entry, then every library it loads by that
/// library's own verdict.
pub fn analyze_loaded_graph<'g>(graph: &'g LoadedGraph, options: &DependencyAnalysisOptions) -> GraphAnalysis<'g> {
    let analysis = analyze(graph, options.analysis);
    let dependencies = analyze_dependencies(graph, options);
    let assembled = assemble_entry_diagnostics(graph, analysis);
    let entry = without_covered_dependency_findings(&assembled.diagnostics, &dependencies);
    let libraries = without_held_files(
        graph,
        &assembled.host_refusals,
        without_covered_artifact_warnings(&dependencies, &entry),
    );
    let diagnostics = union_diagnostics(&[&entry, &libraries]);
    let errors = diagnostics.iter().filter(|d| d.severity == Some(DiagnosticSeverity::Error)).cloned().collect();
    GraphAnalysis {
        dependencies,
        diagnostics,
        suppressed: assembled.suppressed,
        errors,
        host_refusals: assembled.host_refusals,
    }
}
