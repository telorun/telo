//! The names a module may not take, mirroring the module-name rule of
//! `../../nodejs/src/validate-identifier-names.ts`: an entry module named `Telo` or `Self`
//! would replace the built-in kinds or its own (`KIND_PREFIX_RESERVED`). The pass's other
//! rules — a name's grammar and case — have no twin yet, so this pass reports less than
//! Node's, never something Node's does not.

use crate::loaded_types::LoadedGraph;
use crate::reserved_kind_prefix::{is_reserved_kind_prefix, reserved_module_name_message};
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};

/// The entry module's own name, judged; a dependency's is refused where it is imported.
pub fn validate_identifier_names(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let file = &graph.entry().owner;
    let mut diagnostics = Vec::new();
    for document in file.documents() {
        let Some(kind) = kind_of(document).filter(|kind| is_module_document(kind)) else { continue };
        let Some(name) = name_of(document).filter(|name| is_reserved_kind_prefix(name)) else { continue };
        diagnostics.push(AnalysisDiagnostic::error(
            "KIND_PREFIX_RESERVED",
            format!("{kind}/{name}: {}", reserved_module_name_message(name)),
            DiagnosticData {
                resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                file_path: Some(file.source.clone()),
                path: Some("metadata.name".to_string()),
                ..Default::default()
            },
        ));
    }
    diagnostics
}
