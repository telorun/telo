//! What `telo check` reports of a graph's entry, before any library's verdict. Mirrors
//! `../../nodejs/src/entry-diagnostics.ts`: the load findings and the entry's live analysis,
//! assembled by [`assemble_graph_diagnostics`].
//!
//! The Rust hosts add one thing Node has no counterpart for: the constructs this build cannot
//! read ([`host_refusals`]) — a file the YAML reader holds back, an import or a partial through
//! a transport or an artifact path it lacks, a library migration it does not apply where one
//! may apply. Each is no diagnostic but a refusal, and the files it names are held back, their
//! diagnostics dropped as a file that failed to parse has its analysis held back. `telo check`
//! and the kernel's load read them from here, so both hold back the same files.

use std::collections::HashSet;

use crate::diagnostic_location::find_positions;
use crate::graph_diagnostics::assemble_graph_diagnostics;
use crate::library_migrations::{unapplied_library_migrations, UnappliedLibraryMigration};
use crate::loaded_types::{LoadedFile, LoadedGraph, ParseError};
use crate::types::AnalysisDiagnostic;

/// A construct of the graph this build cannot read.
pub enum HostRefusal<'g> {
    /// A file's construct, at its document and position.
    Construct { file: &'g LoadedFile, error: &'g ParseError },
    /// A library migration that may apply and that this build does not apply.
    LibraryMigration(UnappliedLibraryMigration),
}

impl HostRefusal<'_> {
    /// The refusal's sentence, each file it names written through `display`.
    pub fn message(&self, display: impl Fn(&str) -> String) -> String {
        match self {
            HostRefusal::Construct { file, error } => {
                let place = match error.range {
                    Some(range) => format!(
                        "document {}, line {}, column {}",
                        error.document_index + 1,
                        range.start.line + 1,
                        range.start.character + 1
                    ),
                    None => format!("document {}", error.document_index + 1),
                };
                format!("'{}', {place}: {}", display(&file.source), error.message())
            }
            HostRefusal::LibraryMigration(refusal) => refusal.message(display),
        }
    }

    /// The files the refusal holds back.
    fn held_files(&self) -> Vec<String> {
        match self {
            HostRefusal::Construct { file, .. } => vec![file.source.clone()],
            HostRefusal::LibraryMigration(refusal) => vec![refusal.import_file.clone(), refusal.node_file.clone()],
        }
    }
}

/// Every construct of `graph` this build cannot read: each file's, in file order, then each
/// unapplied library migration.
pub fn host_refusals(graph: &LoadedGraph) -> Vec<HostRefusal<'_>> {
    let mut refusals: Vec<HostRefusal<'_>> = graph
        .files()
        .flat_map(|file| {
            file.parse_errors
                .iter()
                .filter(|error| error.is_host_refusal())
                .map(move |error| HostRefusal::Construct { file, error })
        })
        .collect();
    refusals.extend(unapplied_library_migrations(graph).into_iter().map(HostRefusal::LibraryMigration));
    refusals
}

/// What to surface, the analysis cascade held back, and what this build refuses to read.
pub struct EntryDiagnostics<'g> {
    pub diagnostics: Vec<AnalysisDiagnostic>,
    pub suppressed: Vec<AnalysisDiagnostic>,
    pub host_refusals: Vec<HostRefusal<'g>>,
}

/// The entry's assembled findings, every diagnostic owned by a file a host refusal holds back
/// dropped.
pub fn assemble_entry_diagnostics(graph: &LoadedGraph, analysis: Vec<AnalysisDiagnostic>) -> EntryDiagnostics<'_> {
    let host_refusals = host_refusals(graph);
    let assembled = assemble_graph_diagnostics(graph, analysis);
    let diagnostics = without_held_files(graph, &host_refusals, assembled.diagnostics);
    EntryDiagnostics { diagnostics, suppressed: assembled.suppressed, host_refusals }
}

/// `diagnostics` minus every one owned by a file one of `refusals` holds back.
pub fn without_held_files(
    graph: &LoadedGraph,
    refusals: &[HostRefusal<'_>],
    mut diagnostics: Vec<AnalysisDiagnostic>,
) -> Vec<AnalysisDiagnostic> {
    let held: HashSet<String> = refusals.iter().flat_map(HostRefusal::held_files).collect();
    if !held.is_empty() {
        diagnostics.retain(|d| !held.contains(&owning_file(graph, d)));
    }
    diagnostics
}

/// The file a diagnostic is shown in, by the rule the assembly files it by.
fn owning_file(graph: &LoadedGraph, d: &AnalysisDiagnostic) -> String {
    find_positions(graph, d.data.as_ref())
        .map(|positions| positions.file)
        .or_else(|| d.data.as_ref().and_then(|data| data.file_path.clone()))
        .unwrap_or_else(|| graph.root_source.clone())
}
