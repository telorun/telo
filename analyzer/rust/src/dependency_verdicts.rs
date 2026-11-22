//! The dependency stage: every library an application loads is judged by its OWN entry
//! analysis — the verdict `telo check <library>` gives — and that verdict is folded into the
//! application's result, anchored by the library's origin (`module_origin`): an editable
//! library's findings at its own lines, every severity; an artifact's errors alone, as
//! warnings at the entry's import reaching it. Mirrors `../../nodejs/src/dependency-verdicts.ts`.
//!
//! A verdict depends on the library's closure alone, so it is memoized by a digest of that
//! closure and the running surface (`TELO_RUNNING_SURFACE`), in process
//! ([`DependencyVerdictMemo`]) and through a host-supplied store ([`DependencyVerdictStore`]), in
//! Node's format and keyed by Node's key function over what this build reads — no host
//! versions, stamps or children. It touches no filesystem.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::analyzer::{analyze, AnalysisOptions};
use crate::dependency_configurations::library_document_of;
use crate::diagnostic_identity::{defect_identity, written_place_of};
use crate::entry_diagnostics::assemble_entry_diagnostics;
use crate::loaded_types::LoadedGraph;
use crate::metadata_stamp_refusals::metadata_stamp_diagnostics;
use crate::module_origin::{module_origins, reached_module_sources, ModuleOrigin};
use crate::reaching_import::{import_anchored_diagnostic, import_reach, ReachingImport};
use crate::sources::integrity::sha256_base64url;
use crate::telo_version::TELO_RUNNING_SURFACE;
use crate::types::{name_of, AnalysisDiagnostic, DiagnosticSeverity};

/// Bumped whenever what a verdict holds changes; Node's, so a store holds one format.
pub const VERDICT_FORMAT: u32 = 3;

/// One library's own verdict: what its entry analysis reports, before origin is applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DependencyVerdict {
    /// The verdict format it was judged in; a kept verdict of another is judged again.
    pub format: u32,
    pub module: String,
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

/// Where a host keeps verdicts between processes, by [`dependency_verdict_key`]. A key covers
/// the closure's files, its import resolution and the running surface; a host analysing with
/// a different value validator keeps a store of its own.
pub trait DependencyVerdictStore {
    fn get(&self, key: &str) -> Option<DependencyVerdict>;
    fn set(&self, key: &str, verdict: &DependencyVerdict);
}

/// In-process verdicts, by key, the least recently used dropped beyond `capacity`.
pub struct DependencyVerdictMemo {
    capacity: usize,
    entries: Mutex<IndexMap<String, Arc<DependencyVerdict>>>,
}

impl Default for DependencyVerdictMemo {
    fn default() -> Self {
        Self::new(256)
    }
}

impl DependencyVerdictMemo {
    pub fn new(capacity: usize) -> Self {
        Self { capacity, entries: Mutex::new(IndexMap::new()) }
    }

    /// The verdict kept under `key`, else the one `compute` gives, kept.
    pub fn obtain(&self, key: &str, compute: impl FnOnce() -> DependencyVerdict) -> Arc<DependencyVerdict> {
        {
            let mut entries = self.lock();
            if let Some(known) = entries.shift_remove(key) {
                entries.insert(key.to_string(), known.clone());
                return known;
            }
        }
        // Computed unlocked: a verdict takes as long as an analysis does.
        let fresh = Arc::new(compute());
        let mut entries = self.lock();
        entries.insert(key.to_string(), fresh.clone());
        while entries.len() > self.capacity {
            entries.shift_remove_index(0);
        }
        fresh
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, IndexMap<String, Arc<DependencyVerdict>>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct DependencyAnalysisOptions<'a> {
    /// What each library's analysis needs from the host.
    pub analysis: &'a AnalysisOptions<'a>,
    /// Verdicts kept between processes; none when absent.
    pub store: Option<&'a dyn DependencyVerdictStore>,
    /// Verdicts kept in process; one for this call when absent.
    pub memo: Option<&'a DependencyVerdictMemo>,
}

/// One library the application loads, with its verdict.
#[derive(Debug, Clone)]
pub struct DependencyVerdictRecord {
    /// The library's owner source.
    pub source: String,
    pub module: String,
    pub origin: ModuleOrigin,
    pub key: String,
    pub verdict: Arc<DependencyVerdict>,
    /// The entry's import first reaching the library.
    pub reached_through: Option<ReachingImport>,
    /// The verdict's findings as the application reports them.
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

#[derive(Debug, Clone, Default)]
pub struct DependencyAnalysis {
    /// Every library's findings as the application reports them, in load order.
    pub diagnostics: Vec<AnalysisDiagnostic>,
    pub verdicts: Vec<DependencyVerdictRecord>,
}

/// Whether a rule ran is decided by the instances of the whole application, which the
/// consumer's own analysis judges; the library alone holds none.
const RULE_EXERCISE_CODES: &[&str] = &["RESOURCE_RULE_UNEXERCISED", "REFERRER_RULE_UNEXERCISED"];

/// Judge every library `graph` loads — one per module the entry reaches through its reconciled
/// import edges, the entry itself excluded — and report each verdict by the library's origin.
pub fn analyze_dependencies(graph: &LoadedGraph, options: &DependencyAnalysisOptions) -> DependencyAnalysis {
    let origins = module_origins(graph);
    let reached = reached_module_sources(graph, &graph.root_source);
    let libraries: Vec<&String> = reached
        .iter()
        .filter(|source| **source != graph.root_source && library_document_of(graph, source).is_some())
        .collect();
    if libraries.is_empty() {
        return DependencyAnalysis::default();
    }

    let reach = import_reach(graph);
    let own_memo;
    let memo = match options.memo {
        Some(memo) => memo,
        None => {
            own_memo = DependencyVerdictMemo::default();
            &own_memo
        }
    };

    let mut verdicts = Vec::new();
    for source in libraries {
        let key = dependency_verdict_key(graph, source);
        let verdict = memo.obtain(&key, || {
            if let Some(kept) = options.store.and_then(|store| store.get(&key)) {
                if kept.format == VERDICT_FORMAT {
                    return kept;
                }
            }
            let fresh = judge_library(&library_graph(graph, source), options.analysis);
            if let Some(store) = options.store {
                store.set(&key, &fresh);
            }
            fresh
        });
        let origin = origins[source.as_str()];
        let reached_through = reach.of(&verdict.module).cloned();
        let mut diagnostics = Vec::new();
        for d in &verdict.diagnostics {
            if d.code.as_deref().is_some_and(|code| RULE_EXERCISE_CODES.contains(&code)) {
                continue;
            }
            if origin == ModuleOrigin::Editable {
                diagnostics.push(d.clone());
                continue;
            }
            if d.severity != Some(DiagnosticSeverity::Error) {
                continue;
            }
            // A library no import of the entry reaches is reported where written, rather than lost.
            let Some(via) = &reached_through else {
                diagnostics.push(d.clone());
                continue;
            };
            // The consumer cannot edit a published library: its defects warn.
            let mut warning = import_anchored_diagnostic(
                d.code.as_deref().unwrap_or("undefined"),
                &verdict.module,
                via,
                &d.message,
                Some(written_place_of(d)),
            );
            warning.severity = Some(DiagnosticSeverity::Warning);
            diagnostics.push(warning);
        }
        verdicts.push(DependencyVerdictRecord {
            source: source.clone(),
            module: verdict.module.clone(),
            origin,
            key,
            verdict,
            reached_through,
            diagnostics,
        });
    }
    // A library's finding about a library it imports, which that library's own verdict reports
    // as the same defect, is that library's to report.
    let settled: Vec<DependencyVerdictRecord> = verdicts
        .iter()
        .enumerate()
        .map(|(index, record)| {
            let coverers: Vec<AnalysisDiagnostic> = verdicts
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != index)
                .flat_map(|(_, other)| other.diagnostics.iter().cloned())
                .collect();
            DependencyVerdictRecord { diagnostics: without_covered(&record.diagnostics, &coverers), ..record.clone() }
        })
        .collect();
    DependencyAnalysis { diagnostics: settled.iter().flat_map(|v| v.diagnostics.iter().cloned()).collect(), verdicts: settled }
}

/// `findings` minus each re-report — a finding carrying `data.writtenAt`, made at an import
/// reaching the module writing its defect — that `coverers` report as the same defect: by the
/// defect's own finding at least as severely, or by another re-report more severely. A module's
/// own finding is never covered, and two re-reports of one severity both stand.
fn without_covered(findings: &[AnalysisDiagnostic], coverers: &[AnalysisDiagnostic]) -> Vec<AnalysisDiagnostic> {
    let mut own: IndexMap<String, u8> = IndexMap::new();
    let mut reported: IndexMap<String, u8> = IndexMap::new();
    for d in coverers {
        let into = if is_re_report(d) { &mut reported } else { &mut own };
        let rank = severity_rank(d);
        let known = into.entry(defect_identity(d)).or_insert(rank);
        *known = (*known).min(rank);
    }
    findings
        .iter()
        .filter(|d| {
            if !is_re_report(d) {
                return true;
            }
            let identity = defect_identity(d);
            let by_own = own.get(&identity).is_some_and(|rank| *rank <= severity_rank(d));
            let by_report = reported.get(&identity).is_some_and(|rank| *rank < severity_rank(d));
            !(by_own || by_report)
        })
        .cloned()
        .collect()
}

fn is_re_report(d: &AnalysisDiagnostic) -> bool {
    d.data.as_ref().is_some_and(|data| data.written_at.is_some())
}

/// Lower is more severe, as LSP numbers it; a diagnostic of no severity is an error.
fn severity_rank(d: &AnalysisDiagnostic) -> u8 {
    d.severity.unwrap_or(DiagnosticSeverity::Error) as u8
}

/// The entry's assembled findings minus each one a library's verdict, as folded, reports as
/// the same defect at least as severely, so each defect is reported once, at the library's
/// lines. An artifact's warning never covers an entry error: that one is a refusal of the
/// entry's own.
pub fn without_covered_dependency_findings(
    entry_diagnostics: &[AnalysisDiagnostic],
    dependencies: &DependencyAnalysis,
) -> Vec<AnalysisDiagnostic> {
    without_covered(entry_diagnostics, &dependencies.diagnostics)
}

/// Every library's findings as reported, minus each of an artifact's warnings at an import
/// that the entry reports as the same defect.
pub fn without_covered_artifact_warnings(
    dependencies: &DependencyAnalysis,
    entry_diagnostics: &[AnalysisDiagnostic],
) -> Vec<AnalysisDiagnostic> {
    dependencies
        .verdicts
        .iter()
        .flat_map(|v| {
            if v.origin == ModuleOrigin::Artifact && v.reached_through.is_some() {
                without_covered(&v.diagnostics, entry_diagnostics)
            } else {
                v.diagnostics.clone()
            }
        })
        .collect()
}

/// The verdict key of the library at `library_source`: a digest of every file its closure
/// holds (by source and text) and how each of its imports resolved, under the verdict format
/// and the running surface. Node's text, so one closure has one key: this build reads no host
/// version, stamps nothing on a file claim and runs no child application, so those three
/// members are empty.
pub fn dependency_verdict_key(graph: &LoadedGraph, library_source: &str) -> String {
    let mut closure: Vec<String> = reached_module_sources(graph, library_source).into_iter().collect();
    // JavaScript's default sort: by UTF-16 code unit.
    closure.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut files = Vec::new();
    let mut edges = Vec::new();
    for source in &closure {
        for file in graph.modules[source.as_str()].files() {
            files.push(json!([file.source, file.text]));
            for (alias, edge) in graph.import_edges.get(&file.source).into_iter().flatten() {
                edges.push(json!([file.source, alias, edge.target_source]));
            }
        }
    }
    let text = json!([VERDICT_FORMAT, *TELO_RUNNING_SURFACE, [], files, edges, [], []]).to_string();
    sha256_base64url(text.as_bytes())
}

/// `graph` re-rooted at the library at `library_source`, holding only the library's closure —
/// what `telo check <library>` loads, with the import edges as the application's load
/// reconciled them.
pub fn library_graph(graph: &LoadedGraph, library_source: &str) -> LoadedGraph {
    let closure = reached_module_sources(graph, library_source);
    let modules: IndexMap<_, _> = graph
        .modules
        .iter()
        .filter(|(source, _)| closure.contains(source.as_str()))
        .map(|(source, module)| (source.clone(), module.clone()))
        .collect();
    let files: std::collections::HashSet<String> =
        modules.values().flat_map(|module| module.files().map(|file| file.source.clone())).collect();
    let in_closure = |d: &AnalysisDiagnostic| {
        d.data.as_ref().and_then(|data| data.file_path.as_ref()).is_some_and(|file| files.contains(file))
    };
    // A migration reports only for the entry's own files: here the library's.
    let migration_diagnostics =
        modules[library_source].files().flat_map(|file| file.migrations.diagnostics.iter().cloned()).collect();
    let mut library = LoadedGraph {
        root_source: library_source.to_string(),
        requested: graph
            .requested
            .iter()
            .filter(|(_, source)| modules.contains_key(source.as_str()))
            .map(|(url, source)| (url.clone(), source.clone()))
            .collect(),
        import_edges: graph
            .import_edges
            .iter()
            .filter(|(file, _)| files.contains(file.as_str()))
            .map(|(file, edges)| (file.clone(), edges.clone()))
            .collect(),
        overrides: graph.overrides.clone(),
        migration_diagnostics,
        version_diagnostics: graph.version_diagnostics.iter().filter(|d| in_closure(d)).cloned().collect(),
        module_file_diagnostics: graph.module_file_diagnostics.iter().filter(|d| in_closure(d)).cloned().collect(),
        parse_diagnostics: graph.parse_diagnostics.iter().filter(|d| in_closure(d)).cloned().collect(),
        metadata_diagnostics: Vec::new(),
        errors: graph.errors.iter().filter(|e| files.contains(&e.from_source)).cloned().collect(),
        modules,
    };
    library.metadata_diagnostics = metadata_stamp_diagnostics(&library);
    library
}

/// The library's own verdict over its re-rooted graph: its load findings and its analysis, as
/// `telo check <library>` reports them.
fn judge_library(graph: &LoadedGraph, options: &AnalysisOptions) -> DependencyVerdict {
    let module = library_document_of(graph, &graph.root_source).and_then(name_of).unwrap_or_default().to_string();
    let analysis = analyze(graph, options);
    DependencyVerdict { format: VERDICT_FORMAT, module, diagnostics: assemble_entry_diagnostics(graph, analysis).diagnostics }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    use super::*;
    use crate::types::{DiagnosticData, LoadError, ManifestSource, ReadManifest};
    use crate::{load_graph, ManifestLoader};

    /// Files by location; a directory is read as its `telo.yaml`, an `oci://` ref as the file
    /// it is mapped to.
    struct Files(HashMap<String, String>);

    impl ManifestSource for Files {
        fn supports(&self, _: &str) -> bool {
            true
        }

        fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
            let file = if path.ends_with(".yaml") || path.starts_with("oci://") { path.to_string() } else { format!("{path}/telo.yaml") };
            let text = self.0.get(&file).ok_or_else(|| LoadError::Io { path: file.clone(), message: "missing".into() })?;
            Ok(ReadManifest { text: text.clone(), source: file })
        }
    }

    const BAD_CAPABILITY: &str =
        "kind: Telo.Library\nmetadata: { name: Lib }\n---\nkind: Telo.Definition\nmetadata: { name: Gadget }\ncapability: Telo.Servise\n";
    const OBJECT_REFERENCE: &str = "kind: Telo.Library\nmetadata: { name: Lib }\n---\nkind: Telo.Definition\nmetadata: { name: Greeter }\ncapability: Telo.Invocable\n---\nkind: Telo.Definition\nmetadata: { name: Router }\ncapability: Telo.Invocable\nschema:\n  type: object\n  properties: { handler: { x-telo-ref: { kind: Telo.Invocable, use: call } } }\n---\nkind: Self.Greeter\nmetadata: { name: greeter }\n---\nkind: Self.Router\nmetadata: { name: router }\nhandler: { kind: Self.Greeter, name: greeter }\n";
    const PUBLISHED: &str = "oci://registry.test/lib@1.0.0";

    fn app(source: &str) -> String {
        format!("kind: Telo.Application\nmetadata: {{ name: App }}\nimports: {{ Lib: '{source}' }}\n")
    }

    fn graph(files: &[(&str, &str)]) -> LoadedGraph {
        let files = Files(files.iter().map(|(path, text)| (path.to_string(), text.to_string())).collect());
        load_graph(&ManifestLoader::new(vec![Box::new(files)]), "/app/telo.yaml").expect("graph loads")
    }

    fn options<'a>(
        analysis: &'a AnalysisOptions<'a>,
        store: Option<&'a dyn DependencyVerdictStore>,
        memo: Option<&'a DependencyVerdictMemo>,
    ) -> DependencyAnalysisOptions<'a> {
        DependencyAnalysisOptions { analysis, store, memo }
    }

    const ANALYSIS: AnalysisOptions<'static> = AnalysisOptions { accepts_value: &|_, _, _| false };

    /// Each finding's code, severity, file and path.
    fn places(diagnostics: &[AnalysisDiagnostic]) -> Vec<(String, Option<DiagnosticSeverity>, String, String)> {
        diagnostics
            .iter()
            .map(|d| {
                let data = d.data.clone().unwrap_or_default();
                (d.code.clone().unwrap_or_default(), d.severity, data.file_path.unwrap_or_default(), data.path.unwrap_or_default())
            })
            .collect()
    }

    #[test]
    fn reports_an_editable_library_finding_at_its_own_line_and_covers_the_entry_re_report() {
        let graph = graph(&[("/app/telo.yaml", &app("./lib")), ("/app/lib/telo.yaml", BAD_CAPABILITY)]);
        assert_eq!(module_origins(&graph)["/app/lib/telo.yaml"], ModuleOrigin::Editable);
        let analysis = crate::graph_analysis::analyze_loaded_graph(&graph, &options(&ANALYSIS, None, None));
        let error = Some(DiagnosticSeverity::Error);
        assert_eq!(
            places(&analysis.diagnostics),
            [("CAPABILITY_UNKNOWN".to_string(), error, "/app/lib/telo.yaml".to_string(), "capability".to_string())]
        );
    }

    #[test]
    fn keeps_the_entry_refusal_at_an_artifact_import_and_drops_the_artifact_warning_it_covers() {
        let graph = graph(&[("/app/telo.yaml", &app(PUBLISHED)), (PUBLISHED, BAD_CAPABILITY)]);
        assert_eq!(module_origins(&graph)[PUBLISHED], ModuleOrigin::Artifact);
        let analysis = crate::graph_analysis::analyze_loaded_graph(&graph, &options(&ANALYSIS, None, None));
        let error = Some(DiagnosticSeverity::Error);
        assert_eq!(
            places(&analysis.diagnostics),
            [("CAPABILITY_UNKNOWN".to_string(), error, "/app/telo.yaml".to_string(), "imports.Lib".to_string())]
        );
    }

    #[test]
    fn reports_an_artifact_library_error_as_a_warning_at_the_import_reaching_it() {
        let graph = graph(&[("/app/telo.yaml", &app(PUBLISHED)), (PUBLISHED, OBJECT_REFERENCE)]);
        let analysis = crate::graph_analysis::analyze_loaded_graph(&graph, &options(&ANALYSIS, None, None));
        let warning = Some(DiagnosticSeverity::Warning);
        assert_eq!(
            places(&analysis.diagnostics),
            [("INVALID_REFERENCE_FORM".to_string(), warning, "/app/telo.yaml".to_string(), "imports.Lib".to_string())]
        );
        assert!(analysis.diagnostics[0].message.starts_with("Imported library 'Lib', reached through import 'Lib': "));
        let written = analysis.diagnostics[0].data.as_ref().and_then(|data| data.written_at.clone()).expect("writtenAt");
        assert_eq!((written.file_path.as_deref(), written.path.as_deref()), (Some(PUBLISHED), Some("handler")));
        assert!(analysis.errors.is_empty());
    }

    /// A store counting what it is asked and told.
    #[derive(Default)]
    struct Kept {
        verdicts: RefCell<HashMap<String, DependencyVerdict>>,
        sets: Cell<usize>,
    }

    impl DependencyVerdictStore for Kept {
        fn get(&self, key: &str) -> Option<DependencyVerdict> {
            self.verdicts.borrow().get(key).cloned()
        }

        fn set(&self, key: &str, verdict: &DependencyVerdict) {
            self.sets.set(self.sets.get() + 1);
            self.verdicts.borrow_mut().insert(key.to_string(), verdict.clone());
        }
    }

    #[test]
    fn judges_a_closure_once_through_the_memo_and_the_store_and_again_when_a_file_changes() {
        let files = [("/app/telo.yaml", app("./lib")), ("/app/lib/telo.yaml", BAD_CAPABILITY.to_string())];
        let files: Vec<(&str, &str)> = files.iter().map(|(path, text)| (*path, text.as_str())).collect();
        let store = Kept::default();
        let memo = DependencyVerdictMemo::default();
        let first = analyze_dependencies(&graph(&files), &options(&ANALYSIS, Some(&store), Some(&memo)));
        let again = analyze_dependencies(&graph(&files), &options(&ANALYSIS, Some(&store), Some(&memo)));
        let restored = analyze_dependencies(&graph(&files), &options(&ANALYSIS, Some(&store), None));
        assert_eq!(store.sets.get(), 1);
        assert_eq!(again.diagnostics, first.diagnostics);
        assert_eq!(restored.diagnostics, first.diagnostics);

        let fixed = BAD_CAPABILITY.replace("Telo.Servise", "Telo.Service");
        let edited = graph(&[files[0], ("/app/lib/telo.yaml", fixed.as_str())]);
        assert_ne!(
            dependency_verdict_key(&edited, "/app/lib/telo.yaml"),
            dependency_verdict_key(&graph(&files), "/app/lib/telo.yaml")
        );
        assert!(analyze_dependencies(&edited, &options(&ANALYSIS, Some(&store), Some(&memo))).diagnostics.is_empty());
        assert_eq!(store.sets.get(), 2);
    }

    #[test]
    fn serves_a_kept_verdict_of_its_format_and_judges_again_one_of_another() {
        let files = [("/app/telo.yaml", app("./lib")), ("/app/lib/telo.yaml", BAD_CAPABILITY.to_string())];
        let files: Vec<(&str, &str)> = files.iter().map(|(path, text)| (*path, text.as_str())).collect();
        let graph = graph(&files);
        let key = dependency_verdict_key(&graph, "/app/lib/telo.yaml");
        let kept = AnalysisDiagnostic::error(
            "KEPT",
            "kept",
            DiagnosticData { file_path: Some("/app/lib/telo.yaml".into()), ..Default::default() },
        );
        let store = Kept::default();
        store.verdicts.borrow_mut().insert(
            key.clone(),
            DependencyVerdict { format: VERDICT_FORMAT, module: "Lib".into(), diagnostics: vec![kept.clone()] },
        );
        assert_eq!(analyze_dependencies(&graph, &options(&ANALYSIS, Some(&store), None)).diagnostics, [kept]);
        assert_eq!(store.sets.get(), 0);

        store.verdicts.borrow_mut().insert(key, DependencyVerdict { format: 2, module: "Lib".into(), diagnostics: Vec::new() });
        let judged = analyze_dependencies(&graph, &options(&ANALYSIS, Some(&store), None));
        assert_eq!(places(&judged.diagnostics)[0].0, "CAPABILITY_UNKNOWN");
        assert_eq!(store.sets.get(), 1);
    }

    #[test]
    fn keys_a_closure_by_the_digest_of_its_files_and_import_edges() {
        let lib = "kind: Telo.Library\nmetadata: { name: Lib }\n";
        let graph = graph(&[("/app/telo.yaml", &app("./lib")), ("/app/lib/telo.yaml", lib)]);
        let surface = TELO_RUNNING_SURFACE.as_str();
        let text = serde_json::to_string(&json!([3, surface, [], [["/app/lib/telo.yaml", lib]], [], [], []])).unwrap();
        assert_eq!(dependency_verdict_key(&graph, "/app/lib/telo.yaml"), sha256_base64url(text.as_bytes()));
        let app_text = app("./lib");
        let text = serde_json::to_string(&json!([
            3,
            surface,
            [],
            [["/app/lib/telo.yaml", lib], ["/app/telo.yaml", app_text]],
            [["/app/telo.yaml", "Lib", "/app/lib/telo.yaml"]],
            [],
            []
        ]))
        .unwrap();
        assert_eq!(dependency_verdict_key(&graph, "/app/telo.yaml"), sha256_base64url(text.as_bytes()));
    }

    /// Tripwire: Node keeps a dependency's finding carrying `data.configurations` only where an
    /// import reaches one of them (`dependency-configurations.ts`). This stage has no such filter,
    /// which holds only while no diagnostic can carry configurations — so this literal names
    /// every field, and a field added for them breaks it: port the filter in the same change.
    #[test]
    fn no_diagnostic_carries_configurations_while_no_import_filters_them() {
        let DiagnosticData {
            resource: _,
            file_path: _,
            path: _,
            fix: _,
            source_line: _,
            source_failure: _,
            quoted_place: _,
            runtime_code: _,
            migration: _,
            written_at: _,
        } = DiagnosticData::default();
    }

    #[test]
    fn keeps_the_least_recently_used_verdicts_up_to_its_capacity() {
        let memo = DependencyVerdictMemo::new(2);
        let computed = Cell::new(0);
        let verdict = || {
            computed.set(computed.get() + 1);
            DependencyVerdict { format: VERDICT_FORMAT, module: "Lib".into(), diagnostics: Vec::new() }
        };
        memo.obtain("a", verdict);
        memo.obtain("b", verdict);
        memo.obtain("a", verdict);
        memo.obtain("c", verdict);
        memo.obtain("a", verdict);
        assert_eq!(computed.get(), 3);
        memo.obtain("b", verdict);
        assert_eq!(computed.get(), 4);
    }
}
