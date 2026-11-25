//! How a kernel refuses a load, decided from the loaded graph and what its analysis found.
//! Mirrors `loadRefusal` in `../../nodejs/src/load-refusal.ts`, group for group, so a manifest
//! is refused with the same code, message and carried findings whichever kernel loads it; a
//! static code is raised under [`runtime_code_of`]'s answer at every group.
//!
//! Where it differs, by what this build reads: a construct it cannot read is refused first, as
//! `ERR_UNSUPPORTED_MANIFEST_FEATURE` ([`host_refusals`]); and the groups whose findings this
//! analyzer does not make yet — a failed library migration (this build refuses the import
//! reaching one instead), a nested declaration's stamp and the need table (this kernel refuses
//! `needs:`) — have nothing to refuse here, so their steps are absent. At the aggregate's
//! position a module the requires gate left undecided whose cover held an error is refused as
//! `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the bound: Node refuses that load whether the bound
//! holds or not, under findings this kernel cannot know.
//! Node's registration step has no counterpart: this analyzer has no registry.

use crate::analyzer::Analysis;
use crate::entry_diagnostics::host_refusals;
use crate::finding_order::FindingOrder;
use crate::import_resolution_diagnostics::{import_failure_code, import_failure_diagnostics};
use crate::load_refusal_code::runtime_code_of;
use crate::loaded_types::LoadedGraph;
use crate::metadata_stamps::METADATA_RESERVED_FIELD;
use crate::schema_validation::SCHEMA_NESTING_EXCEEDED;
use crate::requires_gate::UndecidedHold;
use crate::system_kinds::LIBRARY;
use crate::types::{kind_of, AnalysisDiagnostic, DiagnosticSeverity};

/// The code a construct this build cannot read is refused under.
pub const UNSUPPORTED_MANIFEST_FEATURE: &str = "ERR_UNSUPPORTED_MANIFEST_FEATURE";
const MANIFEST_VALIDATION_FAILED: &str = "ERR_MANIFEST_VALIDATION_FAILED";

/// A refusal: its code, its message, and the findings it carries, each under the code the
/// refusal raises it as.
#[derive(Debug, Clone)]
pub struct LoadRefusal {
    pub code: String,
    pub message: String,
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

/// What the rule asks of the kernel between its groups.
pub trait LoadRefusalHost {
    type Error;
    /// Between the parse group and the version conflicts: the module artifacts.
    fn build_module_artifacts(&mut self) -> Result<(), Self::Error>;
    /// After the root-module group: the analysis of the graph.
    fn analyze(&mut self) -> Analysis;
}

/// The refusal of a load of `graph` from `entry_url`, or `None` when it loads, by the first
/// group that refuses, in Node's order: (1) the import failures; (2) the parse and coded loader
/// findings; the module artifacts are built; (3) the version conflicts; (4) the module-file
/// findings; (5) an entry that is a library; the analysis runs; (6) the metadata stamps, then (7) the validations that
/// could not finish, each beside every other error the analysis found; (9) a module the requires gate left undecided holding errors, then the analysis's
/// errors. A construct this build cannot read is refused before all.
pub fn load_refusal<H: LoadRefusalHost>(
    graph: &LoadedGraph,
    entry_url: &str,
    host: &mut H,
) -> Result<Option<LoadRefusal>, H::Error> {
    if let Some(refusal) = host_refusals(graph).first() {
        return Ok(Some(LoadRefusal {
            code: UNSUPPORTED_MANIFEST_FEATURE.to_string(),
            message: refusal.message(str::to_string),
            diagnostics: Vec::new(),
        }));
    }
    // An import failure of this build carries no Telo runtime error of its own, as one may in
    // Node, so the first failure is always raised as its diagnostic code's twin.
    if let Some(first) = graph.errors.first() {
        return Ok(Some(LoadRefusal {
            code: runtime_code_of(import_failure_code(first)),
            message: first.message.clone(),
            diagnostics: import_failure_diagnostics(&graph.errors),
        }));
    }
    // A YAML parse failure yields a mangled tree: fatal before any controller sees it.
    if !graph.parse_diagnostics.is_empty() {
        return Ok(Some(file_findings_refusal(graph.parse_diagnostics.clone())));
    }
    host.build_module_artifacts()?;
    // A same-major hoist is advisory; an incompatible major would silently run the wrong one.
    let conflicts: Vec<AnalysisDiagnostic> = graph
        .version_diagnostics
        .iter()
        .filter(|d| d.code.as_deref() == Some("MODULE_VERSION_CONFLICT"))
        .cloned()
        .collect();
    if !conflicts.is_empty() {
        return Ok(Some(LoadRefusal {
            code: MANIFEST_VALIDATION_FAILED.to_string(),
            message: conflicts.iter().map(|d| d.message.as_str()).collect::<Vec<_>>().join("\n"),
            diagnostics: conflicts,
        }));
    }
    if !graph.module_file_diagnostics.is_empty() {
        return Ok(Some(file_findings_refusal(graph.module_file_diagnostics.clone())));
    }
    if graph.entry().owner.module_document().and_then(kind_of) == Some(LIBRARY) {
        return Ok(Some(LoadRefusal {
            code: MANIFEST_VALIDATION_FAILED.to_string(),
            message: format!(
                "Root manifest '{entry_url}' is a Telo.Library. Only Telo.Application manifests can be run directly — libraries are imported via Telo.Import."
            ),
            diagnostics: Vec::new(),
        }));
    }
    let analysis = host.analyze();
    let errors: Vec<AnalysisDiagnostic> =
        analysis.diagnostics.into_iter().filter(|d| d.severity == Some(DiagnosticSeverity::Error)).collect();
    let is_stamp = |d: &AnalysisDiagnostic| d.code.as_deref() == Some(METADATA_RESERVED_FIELD);
    let mut stamps = graph.metadata_diagnostics.clone();
    stamps.extend(errors.iter().filter(|d| is_stamp(d)).cloned());
    if !stamps.is_empty() {
        let others = errors.into_iter().filter(|d| !is_stamp(d)).collect();
        return Ok(Some(own_code_refusal(graph, METADATA_RESERVED_FIELD, stamps, others)));
    }
    // A validation that could not finish holds no verdict on its value.
    let is_unfinished = |d: &AnalysisDiagnostic| d.code.as_deref() == Some(SCHEMA_NESTING_EXCEEDED);
    let unfinished: Vec<AnalysisDiagnostic> = errors.iter().filter(|d| is_unfinished(d)).cloned().collect();
    if !unfinished.is_empty() {
        let others = errors.into_iter().filter(|d| !is_unfinished(d)).collect();
        return Ok(Some(own_code_refusal(graph, SCHEMA_NESTING_EXCEEDED, unfinished, others)));
    }
    let undecided: Vec<String> =
        analysis.undecided.iter().filter(|hold| !hold.hidden_errors.is_empty()).map(undecided_message).collect();
    if !undecided.is_empty() {
        return Ok(Some(LoadRefusal {
            code: UNSUPPORTED_MANIFEST_FEATURE.to_string(),
            message: undecided.join("\n"),
            diagnostics: Vec::new(),
        }));
    }
    if !errors.is_empty() {
        return Ok(Some(LoadRefusal {
            code: MANIFEST_VALIDATION_FAILED.to_string(),
            message: "Manifest validation failed".to_string(),
            diagnostics: errors,
        }));
    }
    Ok(None)
}

/// `found`, raised under the runtime twin of `code` with each finding naming its file, beside
/// `others`.
fn own_code_refusal(
    graph: &LoadedGraph,
    code: &str,
    found: Vec<AnalysisDiagnostic>,
    others: Vec<AnalysisDiagnostic>,
) -> LoadRefusal {
    let found = FindingOrder::new(graph).sort(found);
    let message = found.iter().map(located).collect::<Vec<_>>().join("\n");
    let mut diagnostics: Vec<AnalysisDiagnostic> = found
        .into_iter()
        .map(|mut d| {
            d.code = d.code.map(|code| runtime_code_of(&code));
            d
        })
        .collect();
    diagnostics.extend(others);
    LoadRefusal { code: runtime_code_of(code), message, diagnostics }
}

/// Why a module the gate left undecided is refused: the bound this kernel cannot judge, never
/// the errors it held.
fn undecided_message(hold: &UndecidedHold) -> String {
    let module = &hold.module;
    format!(
        "{}/{}: {} '{}' cannot be judged by this kernel, which knows no Node.js version, and the module holds errors that apply only where the bound is met. Check it with a Node.js build of telo, which judges the bound and reports them.",
        module.kind, module.name, module.path, module.bound
    )
}

/// Findings that each name their file, refused as one validation failure.
fn file_findings_refusal(diagnostics: Vec<AnalysisDiagnostic>) -> LoadRefusal {
    LoadRefusal {
        code: MANIFEST_VALIDATION_FAILED.to_string(),
        message: diagnostics.iter().map(located).collect::<Vec<_>>().join("\n"),
        diagnostics,
    }
}

/// `<file>: <message>`, or the message alone for a diagnostic naming no file. A module nested
/// in an artifact, which Node names by its parent, is a host refusal here.
fn located(d: &AnalysisDiagnostic) -> String {
    match d.data.as_ref().and_then(|data| data.file_path.as_deref()) {
        Some(file) => format!("{file}: {}", d.message),
        None => d.message.clone(),
    }
}
