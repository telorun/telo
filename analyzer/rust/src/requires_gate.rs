//! The requires gate as a refusal, mirroring `../../nodejs/src/requires-gate.ts`: the module
//! documents the gate judges, the files of a module this runtime declared itself unable to read,
//! and the cover a gate finding carries over them — every other analysis finding anchored in
//! such a file holds only where the gate does not. Loader findings are never covered: the cover
//! is placed over the analysis alone.
//!
//! Attribution is by FILE: the gated document's own file is always covered, and the files of
//! its module's other documents only when the module's name identifies exactly one module
//! document of the analysed set — a name is module-scoped, and a stray extra finding is a far
//! cheaper failure than a hidden one.
//!
//! Where it differs, by what this build reads: the analysed set is the entry module's own
//! documents, since the Rust analysis forwards no library declaration into the entry's; and a
//! library's module document is read off the graph, which always knows whether the entry's
//! import edges reach it, so Node's fallback for a producer that did not read the edges has no
//! twin. A library sharing the entry's module name would have Node cover its forwarded
//! documents' files too, where this analysis reports no finding the cover could drop.
//!
//! An undecided module ([`UndecidedModule`]) has no Node twin. Node supplies its own version to
//! every `host.node` bound, so a module whose `telo` bound is met is either refused by the gate
//! alone or reported in full, and which depends on the Node that runs it; the Rust hosts supply no
//! host version, so this crate can say neither. Such a module gets no gate finding, and its files
//! are covered as a failed gate's are, by the same attribution and the same cover
//! ([`hold_undecided`]): what Node reports of it is never contradicted, only left unsaid. The
//! errors the cover held are handed back, so the kernel refuses a load they would refuse.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::finishing_pipeline::file_cover_key;
use crate::loaded_types::LoadedGraph;
use crate::module_origin::reached_module_sources;
use crate::placement::{CarriedCover, PlacedDiagnostic};
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticSeverity};
use crate::validate_requires::{is_runtime_gate, SourcedDocument, UndecidedModule};

/// Files belonging to a module this runtime declared itself unable to read.
pub fn files_of_unreadable_modules(manifests: &[SourcedDocument], requires_diagnostics: &[AnalysisDiagnostic]) -> HashSet<String> {
    let gated = requires_diagnostics.iter().filter(|d| is_runtime_gate(d)).map(|d| {
        let data = d.data.as_ref();
        (data.and_then(|data| data.file_path.as_deref()), data.and_then(|data| data.resource.as_ref()).map(|r| r.name.as_str()))
    });
    files_of_modules(manifests, gated)
}

/// The files of the modules `gated` names, each by the file its module document was declared in
/// and its name, attributed as [`files_of_unreadable_modules`] attributes a gate finding's.
fn files_of_modules<'n>(
    manifests: &[SourcedDocument],
    gated: impl Iterator<Item = (Option<&'n str>, Option<&'n str>)>,
) -> HashSet<String> {
    let mut files = HashSet::new();
    let mut gated_names = HashSet::new();
    for (file, name) in gated {
        // The gated document itself, addressed by the file it was declared in.
        if let Some(file) = file.filter(|file| !file.is_empty()) {
            files.insert(file.to_string());
        }
        if let Some(name) = name {
            gated_names.insert(name);
        }
    }
    if files.is_empty() && gated_names.is_empty() {
        return files;
    }

    // How many module documents answer to each gated name — the ambiguity test.
    let mut docs_per_name: HashMap<&str, usize> = HashMap::new();
    for m in manifests {
        if !kind_of(m.manifest).is_some_and(is_module_document) {
            continue;
        }
        if let Some(name) = name_of(m.manifest).filter(|name| gated_names.contains(name)) {
            *docs_per_name.entry(name).or_default() += 1;
        }
    }

    for m in manifests {
        let Some(owner) = m.module.filter(|owner| gated_names.contains(owner)) else { continue };
        // Ambiguous — do not guess.
        if docs_per_name.get(owner) != Some(&1) {
            continue;
        }
        if !m.source.is_empty() {
            files.insert(m.source.to_string());
        }
    }
    files
}

/// The module documents the gate judges besides the analysed set's own: the module document of
/// every imported library the entry's import edges reach, read off the graph.
pub fn reached_library_documents(graph: &LoadedGraph) -> Vec<SourcedDocument<'_>> {
    let reached = reached_module_sources(graph, &graph.root_source);
    graph
        .modules
        .iter()
        .filter(|(source, module)| {
            **source != graph.root_source
                && reached.contains(source.as_str())
                && module.owner.module_document().and_then(name_of).is_some()
        })
        .flat_map(|(_, module)| module.files())
        .flat_map(|file| {
            file.documents()
                .filter(|manifest| kind_of(manifest).is_some_and(is_module_document))
                .map(|manifest| SourcedDocument { manifest, module: None, source: &file.source })
        })
        .collect()
}

/// The module documents the gate judges: the analysed set's own plus
/// [`reached_library_documents`].
pub fn requires_gate_input<'g>(manifests: &[SourcedDocument<'g>], graph: &'g LoadedGraph) -> Vec<SourcedDocument<'g>> {
    let mut input = manifests.to_vec();
    input.extend(reached_library_documents(graph));
    input
}

/// The refusal a gate finding is: every finding anchored in a file whose module this runtime
/// cannot read holds only where the gate does not — except the gate finding itself. A finding
/// with no file is never covered.
pub fn unreadable_module_refusals(
    unreadable_files: HashSet<String>,
) -> impl Fn(&AnalysisDiagnostic, Option<&str>) -> Option<Vec<Rc<CarriedCover>>> {
    let cover = (!unreadable_files.is_empty()).then(|| Rc::new(cover_of_files(unreadable_files)));
    move |d, _| match &cover {
        Some(cover) if is_runtime_gate(d) => Some(vec![Rc::clone(cover)]),
        _ => None,
    }
}

/// The same refusal read per gate finding: each carries the files of the module it gates.
pub fn gate_refusals<'m>(
    manifests: &'m [SourcedDocument<'m>],
) -> impl Fn(&AnalysisDiagnostic, Option<&str>) -> Option<Vec<Rc<CarriedCover>>> + 'm {
    move |d, _| {
        if !is_runtime_gate(d) {
            return None;
        }
        let files = files_of_unreadable_modules(manifests, std::slice::from_ref(d));
        (!files.is_empty()).then(|| vec![Rc::new(cover_of_files(files))])
    }
}

/// An undecided module and the errors the cover over its files held.
#[derive(Debug, Clone)]
pub struct UndecidedHold {
    pub module: UndecidedModule,
    pub hidden_errors: Vec<AnalysisDiagnostic>,
}

/// `placed` without every finding the cover over an undecided module's files covers, and, per
/// undecided module, the errors it held.
pub fn hold_undecided(
    placed: Vec<PlacedDiagnostic>,
    manifests: &[SourcedDocument],
    undecided: Vec<UndecidedModule>,
) -> (Vec<PlacedDiagnostic>, Vec<UndecidedHold>) {
    let covers: Vec<(UndecidedModule, CarriedCover)> = undecided
        .into_iter()
        .map(|module| {
            let files = files_of_modules(manifests, std::iter::once((Some(module.file.as_str()), Some(module.name.as_str()))));
            (module, cover_of_files(files))
        })
        .collect();
    let mut holds: Vec<UndecidedHold> =
        covers.iter().map(|(module, _)| UndecidedHold { module: module.clone(), hidden_errors: Vec::new() }).collect();
    let mut kept = Vec::new();
    for finding in placed {
        let mut covered = false;
        for (hold, (_, cover)) in holds.iter_mut().zip(&covers) {
            if (cover.covers)(&finding.diagnostic, &finding.provenance) {
                covered = true;
                if finding.diagnostic.severity == Some(DiagnosticSeverity::Error) {
                    hold.hidden_errors.push(finding.diagnostic.clone());
                }
            }
        }
        if !covered {
            kept.push(finding);
        }
    }
    (kept, holds)
}

fn cover_of_files(files: HashSet<String>) -> CarriedCover {
    let mut keys: Vec<String> = files.iter().map(|file| file_cover_key(Some(file))).collect();
    keys.sort();
    CarriedCover {
        keys: Some(keys),
        covers: Rc::new(move |d, provenance| {
            !is_runtime_gate(d) && provenance.file.as_deref().is_some_and(|file| files.contains(file))
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::finishing_pipeline::finish_findings;
    use crate::placement::{Placement, PlacementWorld};
    use crate::types::{DiagnosticData, DiagnosticResource};

    fn gate(name: &str, file: &str) -> AnalysisDiagnostic {
        AnalysisDiagnostic::error(
            "MODULE_REQUIRES_NEWER_RUNTIME",
            "gated",
            DiagnosticData {
                resource: Some(DiagnosticResource { kind: "Telo.Library".into(), name: name.into() }),
                file_path: Some(file.into()),
                path: Some("requires.telo".into()),
                ..Default::default()
            },
        )
    }

    fn at(code: &str, file: &str) -> AnalysisDiagnostic {
        AnalysisDiagnostic::error(code, code, DiagnosticData { file_path: Some(file.into()), ..Default::default() })
    }

    #[test]
    fn covers_the_gated_file_and_its_module_s_partials_when_the_name_is_unambiguous() {
        let (module, definition) = (json!({ "kind": "Telo.Application", "metadata": { "name": "App" } }), json!({ "kind": "Telo.Definition" }));
        let manifests = [
            SourcedDocument { manifest: &module, module: None, source: "/app/telo.yaml" },
            SourcedDocument { manifest: &definition, module: Some("App"), source: "/app/partial.yaml" },
        ];
        let files = files_of_unreadable_modules(&manifests, &[gate("App", "/app/telo.yaml"), at("OTHER", "/x.yaml")]);
        assert_eq!(files, HashSet::from(["/app/telo.yaml".to_string(), "/app/partial.yaml".to_string()]));

        // Two module documents of one name: the partials keep their findings.
        let twin = json!({ "kind": "Telo.Library", "metadata": { "name": "App" } });
        let ambiguous = [manifests[0], manifests[1], SourcedDocument { manifest: &twin, module: None, source: "/lib/telo.yaml" }];
        let files = files_of_unreadable_modules(&ambiguous, &[gate("App", "/app/telo.yaml")]);
        assert_eq!(files, HashSet::from(["/app/telo.yaml".to_string()]));
    }

    #[test]
    fn drops_every_other_finding_in_an_unreadable_file_and_nothing_elsewhere() {
        let refusals = unreadable_module_refusals(HashSet::from(["/lib/telo.yaml".to_string()]));
        let world = PlacementWorld { refusals: Some(&refusals) };
        let placed = Placement::new(world).place(vec![
            gate("Lib", "/lib/telo.yaml"),
            at("CAPABILITY_UNKNOWN", "/lib/telo.yaml"),
            at("REQUIRES_INVALID", "/lib/telo.yaml"),
            at("CAPABILITY_UNKNOWN", "/app/telo.yaml"),
            AnalysisDiagnostic::error("NO_FILE", "m", DiagnosticData::default()),
        ]);
        let codes: Vec<String> = finish_findings(placed).into_iter().map(|d| d.code.unwrap()).collect();
        assert_eq!(codes, ["MODULE_REQUIRES_NEWER_RUNTIME", "CAPABILITY_UNKNOWN", "NO_FILE"]);
    }

    /// One file, read as the entry `/app/telo.yaml`.
    struct Entry(String);

    impl crate::types::ManifestSource for Entry {
        fn supports(&self, _: &str) -> bool {
            true
        }

        fn read(&self, path: &str) -> Result<crate::types::ReadManifest, crate::types::LoadError> {
            Ok(crate::types::ReadManifest { text: self.0.clone(), source: path.to_string() })
        }
    }

    struct Preflight<'g>(&'g LoadedGraph);

    impl crate::load_refusal::LoadRefusalHost for Preflight<'_> {
        type Error = ();

        fn build_module_artifacts(&mut self) -> Result<(), ()> {
            Ok(())
        }

        fn analyze(&mut self) -> crate::analyzer::Analysis {
            crate::analyzer::analysis(self.0)
        }
    }

    fn app(requires: &str, rest: &str) -> LoadedGraph {
        let text = format!("kind: Telo.Application\nmetadata: {{ name: App }}\nrequires: {requires}\n{rest}");
        crate::load_graph(&crate::ManifestLoader::new(vec![Box::new(Entry(text))]), "/app/telo.yaml").expect("graph loads")
    }

    fn checked(graph: &LoadedGraph) -> (Vec<String>, Vec<UndecidedHold>) {
        let mut preflight = Preflight(graph);
        let analysis = crate::load_refusal::LoadRefusalHost::analyze(&mut preflight);
        (analysis.diagnostics.into_iter().map(|d| d.code.unwrap_or_default()).collect(), analysis.undecided)
    }

    fn run(graph: &LoadedGraph) -> Option<crate::load_refusal::LoadRefusal> {
        crate::load_refusal::load_refusal(graph, "/app/telo.yaml", &mut Preflight(graph)).expect("the rule decides")
    }

    const INVOKABLE: &str = "---\nkind: Telo.Definition\nmetadata: { name: Broken }\ncapability: Telo.Invokable\n";

    #[test]
    fn reports_nothing_of_a_module_whose_unjudged_node_bound_leaves_it_undecided() {
        let (codes, undecided) = checked(&app("{ host: { node: \">=99.0.0\", bun: \">=1.0.0\" } }", ""));
        assert!(codes.is_empty(), "{codes:?}");
        assert_eq!(undecided.len(), 1);
        assert_eq!((undecided[0].module.path.as_str(), undecided[0].module.bound.as_str()), ("requires.host.node", ">=99.0.0"));
    }

    #[test]
    fn refuses_to_run_an_undecided_module_whose_cover_held_an_error() {
        let graph = app("{ host: { node: \">=99.0.0\" } }", INVOKABLE);
        let (codes, undecided) = checked(&graph);
        assert!(codes.is_empty(), "{codes:?}");
        let held: Vec<_> = undecided[0].hidden_errors.iter().map(|d| d.code.as_deref().unwrap_or_default()).collect();
        assert_eq!(held, ["CAPABILITY_UNKNOWN"]);
        let refusal = run(&graph).expect("refused");
        assert_eq!(refusal.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE");
        assert_eq!(
            refusal.message,
            "Telo.Application/App: requires.host.node '>=99.0.0' cannot be judged by this kernel, which knows no Node.js version, and the module holds errors that apply only where the bound is met. Check it with a Node.js build of telo, which judges the bound and reports them."
        );
        assert!(refusal.diagnostics.is_empty());
    }

    #[test]
    fn runs_an_undecided_module_holding_no_error() {
        let graph = app("{ host: { node: \">=18.0.0\" } }", "");
        assert!(checked(&graph).0.is_empty());
        assert!(run(&graph).is_none());
    }

    #[test]
    fn gates_a_telo_floor_beside_a_node_bound() {
        let (codes, undecided) = checked(&app("{ telo: \">=999.0.0\", host: { node: \">=18.0.0\" } }", INVOKABLE));
        assert_eq!(codes, ["MODULE_REQUIRES_NEWER_RUNTIME"]);
        assert!(undecided.is_empty());
    }

    #[test]
    fn refuses_a_malformed_node_bound_without_leaving_the_module_undecided() {
        let (codes, undecided) = checked(&app("{ host: { node: \"^20.0.0\" } }", ""));
        assert_eq!(codes, ["REQUIRES_INVALID"]);
        assert!(undecided.is_empty());
    }

    #[test]
    fn reads_the_files_each_gate_finding_gates_on_its_own() {
        let module = json!({ "kind": "Telo.Application", "metadata": { "name": "App" } });
        let manifests = [SourcedDocument { manifest: &module, module: None, source: "/app/telo.yaml" }];
        let refusals = gate_refusals(&manifests);
        let covers = refusals(&gate("App", "/app/telo.yaml"), Some("/app/telo.yaml")).expect("a gate finding refuses");
        assert_eq!(covers[0].keys.as_deref(), Some(&[file_cover_key(Some("/app/telo.yaml"))][..]));
        assert!(refusals(&at("OTHER", "/app/telo.yaml"), None).is_none());
    }
}
