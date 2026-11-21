//! The refusal of every loader stamp an author wrote, over the loaded graph. Mirrors
//! `metadataStampDiagnostics` in `../../nodejs/src/metadata-stamp-refusals.ts` for the
//! top-level documents of each module's files; a nested declaration's stamp and a scoped
//! `Telo.Import`'s have no twin, since this analyzer has no nested judge and this loader
//! walks no scoped import.

use std::collections::{HashSet, VecDeque};

use crate::loaded_types::{LoadedFile, LoadedGraph, LoadedModule};
use crate::metadata_stamps::{metadata_stamp_message, written_metadata_stamps, METADATA_RESERVED_FIELD};
use crate::reaching_import::{import_anchored_diagnostic, ReachingImport};
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource, WrittenAt};

/// Every stamp written in a module the entry runs: the entry's own where it is written, a
/// dependency's at the entry's import that first reaches it — the entry's `imports:` in
/// declaration order, each followed breadth-first through every library it reaches.
pub fn metadata_stamp_diagnostics(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let entry = graph.entry();
    let mut out: Vec<AnalysisDiagnostic> = entry.files().flat_map(written_stamps).collect();

    let mut reached: HashSet<&str> = HashSet::from([graph.root_source.as_str()]);
    for file in entry.files() {
        let Some(entry_imports) = graph.import_edges.get(&file.source) else { continue };
        for (alias, edge) in entry_imports {
            let via = ReachingImport {
                alias: alias.clone(),
                file_path: file.source.clone(),
                path: format!("imports.{alias}"),
            };
            let mut queue = VecDeque::from([edge]);
            while let Some(next) = queue.pop_front() {
                if !reached.insert(next.target_source.as_str()) {
                    continue;
                }
                let Some(module) = graph.modules.get(&next.target_source) else { continue };
                for stamp in module.files().flat_map(written_stamps) {
                    let written = stamp.data.as_ref().map(WrittenAt::of);
                    out.push(import_anchored_diagnostic(
                        METADATA_RESERVED_FIELD,
                        &next.target_module_name,
                        &via,
                        &stamp.message,
                        written,
                    ));
                }
                queue.extend(edges_of(graph, module));
            }
        }
    }
    out
}

/// Every stamp `file` writes on a top-level document, refused where it is written.
fn written_stamps(file: &LoadedFile) -> Vec<AnalysisDiagnostic> {
    let mut out = Vec::new();
    for (index, manifest) in file.manifests.iter().enumerate() {
        let Some(manifest) = manifest else { continue };
        for field in written_metadata_stamps(manifest) {
            let path = format!("metadata.{field}");
            let range = file.positions.get(index).and_then(|position| position.position_index.get(&path)).copied();
            let mut diagnostic = AnalysisDiagnostic::error(
                METADATA_RESERVED_FIELD,
                metadata_stamp_message(manifest, field),
                DiagnosticData {
                    resource: Some(DiagnosticResource {
                        kind: kind_of(manifest).unwrap_or("undefined").to_string(),
                        name: name_of(manifest).unwrap_or_default().to_string(),
                    }),
                    file_path: Some(file.source.clone()),
                    path: Some(path),
                    ..Default::default()
                },
            );
            diagnostic.range = range;
            out.push(diagnostic);
        }
    }
    out
}

fn edges_of<'g>(graph: &'g LoadedGraph, module: &LoadedModule) -> Vec<&'g crate::loaded_types::ImportEdge> {
    module.files().filter_map(|file| graph.import_edges.get(&file.source)).flat_map(|aliases| aliases.values()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest_loader::load_graph;
    use crate::types::{LoadError, ManifestSource, ReadManifest};
    use crate::ManifestLoader;
    use std::collections::HashMap;

    const STAMP: &str = "Telo.Definition/Greeter: 'metadata.module' is written by the loader — the module the document belongs to — and cannot be written in a manifest. Remove it.";
    const STAMPED_LIBRARY: &str = "kind: Telo.Library\nmetadata: { name: StampLib }\n---\nkind: Telo.Definition\nmetadata: { name: Greeter, module: Elsewhere }\ncapability: Telo.Invocable\n";

    struct Files(HashMap<&'static str, &'static str>);

    impl ManifestSource for Files {
        fn supports(&self, path: &str) -> bool {
            path.starts_with('/')
        }

        fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
            let file = if path.ends_with(".yaml") { path.to_string() } else { format!("{path}/telo.yaml") };
            let text = self.0.get(file.as_str()).ok_or_else(|| LoadError::Io { path: file.clone(), message: "missing".into() })?;
            Ok(ReadManifest { text: text.to_string(), source: file })
        }
    }

    fn stamps(files: &[(&'static str, &'static str)]) -> Vec<AnalysisDiagnostic> {
        let loader = ManifestLoader::new(vec![Box::new(Files(files.iter().copied().collect()))]);
        let graph = load_graph(&loader, "/app/telo.yaml").expect("graph loads");
        assert_eq!(graph.metadata_diagnostics, metadata_stamp_diagnostics(&graph));
        graph.metadata_diagnostics
    }

    fn at_import(diagnostic: &AnalysisDiagnostic) -> (String, Option<String>, Option<String>) {
        let data = diagnostic.data.as_ref().expect("data");
        (diagnostic.message.clone(), data.file_path.clone(), data.path.clone())
    }

    #[test]
    fn refuses_an_entry_stamp_where_it_is_written() {
        let found = stamps(&[(
            "/app/telo.yaml",
            "kind: Telo.Application\nmetadata: { name: App }\n---\nkind: Telo.Definition\nmetadata: { name: Greeter, module: Elsewhere }\ncapability: Telo.Invocable\n",
        )]);
        assert_eq!(found.len(), 1);
        let data = found[0].data.as_ref().expect("data");
        assert_eq!(found[0].message, STAMP);
        assert_eq!(data.resource, Some(DiagnosticResource { kind: "Telo.Definition".into(), name: "Greeter".into() }));
        assert_eq!(data.file_path.as_deref(), Some("/app/telo.yaml"));
        assert_eq!(data.path.as_deref(), Some("metadata.module"));
        let range = found[0].range.expect("range");
        assert_eq!((range.start.line, range.start.character), (4, 35));
    }

    #[test]
    fn refuses_a_dependency_stamp_at_its_import() {
        let found = stamps(&[
            ("/app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ../lib }\n"),
            ("/lib/telo.yaml", STAMPED_LIBRARY),
        ]);
        assert_eq!(
            found.iter().map(at_import).collect::<Vec<_>>(),
            [(
                format!("Imported library 'StampLib', reached through import 'Lib': {STAMP}"),
                Some("/app/telo.yaml".to_string()),
                Some("imports.Lib".to_string())
            )]
        );
    }

    #[test]
    fn refuses_a_transitive_stamp_at_the_root_import() {
        let found = stamps(&[
            ("/app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Mid: ../mid }\n"),
            ("/mid/telo.yaml", "kind: Telo.Library\nmetadata: { name: MidLib }\nimports: { Inner: ../lib }\n"),
            ("/lib/telo.yaml", STAMPED_LIBRARY),
        ]);
        assert_eq!(
            found.iter().map(at_import).collect::<Vec<_>>(),
            [(
                format!("Imported library 'StampLib', reached through import 'Mid': {STAMP}"),
                Some("/app/telo.yaml".to_string()),
                Some("imports.Mid".to_string())
            )]
        );
    }

    #[test]
    fn refuses_a_library_two_imports_reach_once_at_the_first() {
        let found = stamps(&[
            (
                "/app/telo.yaml",
                "kind: Telo.Application\nmetadata: { name: App }\nimports: { Zed: ../mid, Alpha: ../lib }\n",
            ),
            ("/mid/telo.yaml", "kind: Telo.Library\nmetadata: { name: MidLib }\nimports: { Inner: ../lib }\n"),
            ("/lib/telo.yaml", STAMPED_LIBRARY),
        ]);
        assert_eq!(
            found.iter().map(at_import).collect::<Vec<_>>(),
            [(
                format!("Imported library 'StampLib', reached through import 'Zed': {STAMP}"),
                Some("/app/telo.yaml".to_string()),
                Some("imports.Zed".to_string())
            )]
        );
    }
}
