//! `SCHEMA_IN_PLACE_CYCLE` at the declarations this analyzer judges: each `variables:` /
//! `secrets:` entry of a module document, and each schema a `Telo.Definition` /
//! `Telo.Abstract` validates values against, recursing in place through its own references.
//! Mirrors `moduleInputCycleDiagnostics` and the kind-document half of
//! `../../nodejs/src/schema-in-place-cycle-findings.ts` over one configuration and local
//! references alone; a cycle through a named shape has no reader here. The entry's own are
//! reported where written, an imported library's at the entry's `imports:` entry first
//! reaching it, since the kernel refuses the import all the same.

use crate::loaded_types::LoadedGraph;
use crate::reaching_import::{import_anchored_diagnostic, import_reach, module_name_of};
use crate::schema_in_place_cycle::{in_place_cycle_message, SCHEMA_IN_PLACE_CYCLE};
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource, WrittenAt};
use crate::validated_schemas::{definition_schema_documents, local_in_place_cycles, module_input_schema_documents};

/// The kind documents whose schemas are judged.
const KIND_DOCUMENTS: &[&str] = &["Telo.Definition", "Telo.Abstract"];

pub fn schema_in_place_cycle_diagnostics(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let reach = import_reach(graph);
    let mut out = Vec::new();
    for (source, module) in &graph.modules {
        let own = *source == graph.root_source;
        let module_name = module_name_of(graph, source);
        let via = if own { None } else { module_name.and_then(|name| reach.of(name)) };
        if !own && via.is_none() {
            continue;
        }
        for file in module.files() {
            for document in file.documents() {
                let Some(kind) = kind_of(document) else { continue };
                let documents = if KIND_DOCUMENTS.contains(&kind) {
                    definition_schema_documents(document)
                } else {
                    module_input_schema_documents(document)
                };
                let name = name_of(document).unwrap_or_default();
                for cycle in local_in_place_cycles(&documents) {
                    let message =
                        format!("{kind} {}", in_place_cycle_message(&format!("'{name}'"), &cycle.cycle, &|document| document.to_string()));
                    let written = DiagnosticData {
                        resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                        file_path: Some(file.source.clone()),
                        path: Some(cycle.path.clone()),
                        ..Default::default()
                    };
                    out.push(match (via, module_name) {
                        (Some(via), Some(module_name)) => import_anchored_diagnostic(
                            SCHEMA_IN_PLACE_CYCLE,
                            module_name,
                            via,
                            &message,
                            Some(WrittenAt::of(&written)),
                        ),
                        _ => AnalysisDiagnostic::error(SCHEMA_IN_PLACE_CYCLE, message, written),
                    });
                }
            }
        }
    }
    out
}
