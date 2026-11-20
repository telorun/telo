//! A graph's import failures as coded diagnostics, mirroring
//! `../../nodejs/src/import-resolution-diagnostics.ts`: `INVALID_IMPORT_SOURCE` (not a module
//! reference), `IMPORT_UNRESOLVED` (well-formed, not obtained — `data.sourceFailure` naming
//! the source failure's kind when one left it unobtained), `INVALID_IMPORT_TARGET` (obtained,
//! not importable) and `KIND_PREFIX_RESERVED`, each at its `imports:` entry. A `Telo.Import`
//! declared as a scope member has no twin: this loader walks none.

use crate::loaded_types::{GraphLoadError, ImportFailureReason, LoadedGraph};
use crate::manifest_loader::is_local_path_source;
use crate::sources::oci_ref::is_oci_ref;
use crate::types::{AnalysisDiagnostic, DiagnosticData};

/// A shape some transport claims — an OCI ref, an HTTP(S) URL, or a path.
fn is_recognized_source_shape(source: &str) -> bool {
    is_oci_ref(source) || source.starts_with("http://") || source.starts_with("https://") || is_local_path_source(source)
}

/// The code an import failure is reported under.
pub fn import_failure_code(error: &GraphLoadError) -> &'static str {
    match error.reason {
        ImportFailureReason::ReservedPrefix => "KIND_PREFIX_RESERVED",
        ImportFailureReason::UnusableTarget => "INVALID_IMPORT_TARGET",
        ImportFailureReason::Unresolved if is_recognized_source_shape(&error.source) => "IMPORT_UNRESOLVED",
        ImportFailureReason::Unresolved => "INVALID_IMPORT_SOURCE",
    }
}

/// The removed bare `<namespace>/<name>@<version>` ref, recognised only to explain itself.
fn is_removed_bare_ref(source: &str) -> bool {
    !source.contains("://") && !source.starts_with('/') && !source.starts_with('.') && source.contains('@') && source.contains('/')
}

/// The sentence an import failure is reported with: "cannot use" for a target that was
/// obtained, "cannot resolve" for one that was not.
pub fn import_failure_message(error: &GraphLoadError) -> String {
    let via = format!("import '{}' → '{}'", error.alias, error.source);
    match import_failure_code(error) {
        "INVALID_IMPORT_SOURCE" => {
            let removed = if is_removed_bare_ref(&error.source) {
                " The bare '<namespace>/<name>@<version>' form was removed — rewrite it to the module's 'oci://' ref (`telo search <name>` reports it)."
            } else {
                ""
            };
            format!(
                "Cannot resolve {via}: not a recognized module reference. Expected 'oci://host/repo@tag', 'https://…', or a relative path.{removed}"
            )
        }
        "INVALID_IMPORT_TARGET" | "KIND_PREFIX_RESERVED" => format!("Cannot use {via}: {}", error.message),
        _ => format!("Cannot resolve {via}: {}", error.message),
    }
}

/// Every import failure of `graph`, located at its `imports:` entry.
pub fn import_resolution_diagnostics(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    import_failure_diagnostics(&graph.errors)
}

/// The same conversion over a list of failures.
pub fn import_failure_diagnostics(errors: &[GraphLoadError]) -> Vec<AnalysisDiagnostic> {
    errors
        .iter()
        .map(|error| {
            AnalysisDiagnostic::error(
                import_failure_code(error),
                import_failure_message(error),
                DiagnosticData {
                    file_path: Some(error.from_source.clone()),
                    path: Some(format!("imports.{}", error.alias)),
                    source_line: error.source_line,
                    source_failure: error.source_failure.map(|kind| kind.as_str().to_string()),
                    ..Default::default()
                },
            )
        })
        .collect()
}
