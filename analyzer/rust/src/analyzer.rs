//! The static analysis of a loaded graph, mirroring the passes of
//! `../../nodejs/src/analyzer.ts` this analyzer has: the declared runtime requirements of the
//! entry's module documents and of every library its imports reach (`validate_requires`), the
//! capability roster over every kind document of the graph (a dependency's reported at the
//! entry's import reaching it), the entry module's reference forms, its own name, and a plain
//! string left holding `${{` — the entry's own, and an imported library's at the entry's import
//! reaching it. Each is a refusal the Rust kernel makes; Node's other passes have no twin yet,
//! so an analysis here reports a subset of Node's and never a diagnostic Node does not make.
//!
//! Every finding is placed and finished as Node's are (`placement`, `finishing_pipeline`): a
//! gate finding covers the other findings of the files of the module it gates
//! (`requires_gate`). The result is in Node's order, the finding order (`finding_order`),
//! whatever order the passes run in.
//!
//! Hosts present the result through `graph_diagnostics::assemble_graph_diagnostics`.

use std::collections::HashSet;

use crate::capability_roster::capability_problem;
use crate::finding_order::FindingOrder;
use crate::finishing_pipeline::finish_findings;
use crate::loaded_types::LoadedGraph;
use crate::placement::{Placement, PlacementWorld};
use crate::requires_gate::{files_of_unreadable_modules, requires_gate_input, unreadable_module_refusals};
use crate::system_kinds::is_module_document;
use crate::reaching_import::{import_anchored_diagnostic, import_reach, module_name_of};
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource, WrittenAt};
use crate::untagged_interpolation::validate_untagged_interpolation;
use crate::validate_identifier_names::validate_identifier_names;
use crate::validate_reference_forms::{validate_reference_forms, AcceptsValue};
use crate::validate_requires::{validate_requires, SourcedDocument, ValidateRequiresOptions};

/// What an analysis needs from its host.
pub struct AnalysisOptions<'a> {
    /// Whether a union's value branch accepts a value — the host's JSON Schema validator.
    pub accepts_value: &'a AcceptsValue<'a>,
}

/// The kind documents a capability names a lifecycle role on.
const KIND_DOCUMENTS: &[&str] = &["Telo.Definition", "Telo.Abstract"];

/// Every diagnostic the analysis makes of `graph`, before any host's presentation.
pub fn analyze(graph: &LoadedGraph, options: &AnalysisOptions) -> Vec<AnalysisDiagnostic> {
    let documents = analysed_documents(graph);
    let root_modules = root_modules(&documents);
    // Declared runtime requirements first: a module this runtime cannot read also yields the
    // vocabulary findings its newer syntax causes here, each true and each blaming its author
    // for a version skew, so the gate covers them.
    let mut diagnostics = validate_requires(
        &requires_gate_input(&documents, graph),
        &ValidateRequiresOptions { entry_modules: Some(&root_modules), ..Default::default() },
    );
    let unreadable_files = files_of_unreadable_modules(&documents, &diagnostics);
    diagnostics.extend(capability_diagnostics(graph));
    diagnostics.extend(validate_reference_forms(graph, options.accepts_value));
    diagnostics.extend(validate_identifier_names(graph));
    diagnostics.extend(validate_untagged_interpolation(graph));
    let refusals = unreadable_module_refusals(unreadable_files);
    let placement = Placement::new(PlacementWorld { refusals: Some(&refusals) });
    FindingOrder::new(graph).sort(finish_findings(placement.place(diagnostics)))
}

/// The documents the analysis judges as the entry's: every document of the entry module's
/// files, each with the module it is declared in — none for a module document.
fn analysed_documents(graph: &LoadedGraph) -> Vec<SourcedDocument<'_>> {
    let entry = graph.entry();
    let module = entry.owner.module_document().and_then(name_of);
    entry
        .files()
        .flat_map(|file| {
            file.documents().map(move |manifest| SourcedDocument {
                manifest,
                module: if kind_of(manifest).is_some_and(is_module_document) { None } else { module },
                source: &file.source,
            })
        })
        .collect()
}

/// The names of the entry's own modules: its module documents'.
fn root_modules(documents: &[SourcedDocument]) -> HashSet<String> {
    documents
        .iter()
        .filter(|document| kind_of(document.manifest).is_some_and(is_module_document))
        .filter_map(|document| name_of(document.manifest).map(str::to_string))
        .collect()
}

/// The closed roster: a `capability:` names a lifecycle role, or the kernel refuses the
/// definition. A dependency's definition is reported too, at the entry's `imports:` entry
/// reaching it, since the manifest importing it cannot start; one no import reaches is not.
fn capability_diagnostics(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let reach = import_reach(graph);
    let mut diagnostics = Vec::new();
    for (source, module) in &graph.modules {
        let own = *source == graph.root_source;
        let module_name = module_name_of(graph, source);
        let via = if own { None } else { module_name.and_then(|name| reach.of(name)) };
        if !own && via.is_none() {
            continue;
        }
        for document in module.owner.documents() {
            let Some(kind) = kind_of(document).filter(|kind| KIND_DOCUMENTS.contains(kind)) else { continue };
            let Some(problem) = capability_problem(document.get("capability"), document.get("extends").is_some())
            else {
                continue;
            };
            let name = name_of(document).unwrap_or_default();
            let message = format!("{kind} '{name}': {}", problem.message);
            let written = DiagnosticData {
                resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                file_path: Some(module.owner.source.clone()),
                path: Some("capability".to_string()),
                ..Default::default()
            };
            diagnostics.push(match (via, module_name) {
                (Some(via), Some(module_name)) => {
                    import_anchored_diagnostic(problem.code, module_name, via, &message, Some(WrittenAt::of(&written)))
                }
                _ => AnalysisDiagnostic::error(problem.code, message, written),
            });
        }
    }
    diagnostics
}
