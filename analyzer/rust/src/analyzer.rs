//! The static analysis of a loaded graph, mirroring the passes of
//! `../../nodejs/src/analyzer.ts` this analyzer has: the capability roster over every
//! kind document of the graph (a dependency's reported at the entry's import reaching
//! it), the entry module's reference forms, and its own name. Each is a refusal the Rust
//! kernel makes; Node's other passes have no twin yet, so an analysis here reports a
//! subset of Node's, in Node's order, and never a diagnostic Node does not make.
//!
//! Hosts present the result through `graph_diagnostics::assemble_graph_diagnostics`.

use crate::capability_roster::capability_problem;
use crate::loaded_types::LoadedGraph;
use crate::reaching_import::{import_anchored_diagnostic, import_reach, module_name_of};
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};
use crate::validate_identifier_names::validate_identifier_names;
use crate::validate_reference_forms::{validate_reference_forms, AcceptsValue};

/// What an analysis needs from its host.
pub struct AnalysisOptions<'a> {
    /// Whether a union's value branch accepts a value — the host's JSON Schema validator.
    pub accepts_value: &'a AcceptsValue<'a>,
}

/// The kind documents a capability names a lifecycle role on.
const KIND_DOCUMENTS: &[&str] = &["Telo.Definition", "Telo.Abstract"];

/// Every diagnostic the analysis makes of `graph`, before any host's presentation.
pub fn analyze(graph: &LoadedGraph, options: &AnalysisOptions) -> Vec<AnalysisDiagnostic> {
    let mut diagnostics = capability_diagnostics(graph);
    diagnostics.extend(validate_reference_forms(graph, options.accepts_value));
    diagnostics.extend(validate_identifier_names(graph));
    diagnostics
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
            diagnostics.push(match (via, module_name) {
                (Some(via), Some(module_name)) => import_anchored_diagnostic(problem.code, module_name, via, &message),
                _ => AnalysisDiagnostic::error(
                    problem.code,
                    message,
                    DiagnosticData {
                        resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                        file_path: Some(module.owner.source.clone()),
                        path: Some("capability".to_string()),
                        ..Default::default()
                    },
                ),
            });
        }
    }
    diagnostics
}
