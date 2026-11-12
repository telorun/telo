//! A graph's import failures as coded diagnostics, mirroring
//! `../../nodejs/src/import-resolution-diagnostics.ts`.
//!
//! The graph records only failures this loader words as the Node loader does — a reserved
//! prefix and an unusable target — so `INVALID_IMPORT_SOURCE` and `IMPORT_UNRESOLVED` have
//! no producer here. An unusable target's sentence names where it was fetched from, which
//! this loader spells differently from the Node transports, so it is reported only through
//! the kernel's refusal and never as a diagnostic: a diagnostic here is one Node makes.

use crate::loaded_types::{GraphLoadError, ImportFailureReason, LoadedGraph};
use crate::types::{AnalysisDiagnostic, DiagnosticData};

/// The code an import failure is reported under.
pub fn import_failure_code(error: &GraphLoadError) -> &'static str {
    match error.reason {
        ImportFailureReason::ReservedPrefix => "KIND_PREFIX_RESERVED",
        ImportFailureReason::UnusableTarget => "INVALID_IMPORT_TARGET",
    }
}

/// The sentence an import failure is reported with: the target was obtained, so it says
/// "cannot use", never "cannot resolve".
pub fn import_failure_message(error: &GraphLoadError) -> String {
    format!("Cannot use import '{}' → '{}': {}", error.alias, error.source, error.message)
}

/// Every import failure of `graph` that has a diagnostic, located at its `imports:` entry.
pub fn import_resolution_diagnostics(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    import_failure_diagnostics(&graph.errors)
}

/// The same conversion over a list of failures.
pub fn import_failure_diagnostics(errors: &[GraphLoadError]) -> Vec<AnalysisDiagnostic> {
    errors
        .iter()
        .filter(|error| error.reason == ImportFailureReason::ReservedPrefix)
        .map(|error| {
            AnalysisDiagnostic::error(
                import_failure_code(error),
                import_failure_message(error),
                DiagnosticData {
                    file_path: Some(error.from_source.clone()),
                    path: Some(format!("imports.{}", error.alias)),
                    source_line: error.source_line,
                    ..Default::default()
                },
            )
        })
        .collect()
}
