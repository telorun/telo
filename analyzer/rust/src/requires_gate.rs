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

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::finishing_pipeline::file_cover_key;
use crate::loaded_types::LoadedGraph;
use crate::module_origin::reached_module_sources;
use crate::placement::CarriedCover;
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of, AnalysisDiagnostic};
use crate::validate_requires::{is_runtime_gate, SourcedDocument};

/// Files belonging to a module this runtime declared itself unable to read.
pub fn files_of_unreadable_modules(manifests: &[SourcedDocument], requires_diagnostics: &[AnalysisDiagnostic]) -> HashSet<String> {
    let mut files = HashSet::new();
    let mut gated_names = HashSet::new();
    for d in requires_diagnostics.iter().filter(|d| is_runtime_gate(d)) {
        let data = d.data.as_ref();
        // The gated document itself, addressed by the file it was declared in.
        if let Some(file) = data.and_then(|data| data.file_path.as_deref()).filter(|file| !file.is_empty()) {
            files.insert(file.to_string());
        }
        if let Some(resource) = data.and_then(|data| data.resource.as_ref()) {
            gated_names.insert(resource.name.as_str());
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
