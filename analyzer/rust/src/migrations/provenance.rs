//! Path provenance — part of the driver's contract. Mirrors
//! `../../../nodejs/src/migrations/provenance.ts`.
//!
//! Analysis runs over the MIGRATED tree while positions come from the raw file, so every
//! diagnostic's `data.path` is mapped back through the rewrites' `legacy_path` before its
//! position is resolved. The general index is by FILE, every rewrite in it; `(kind, name)`
//! only narrows, since resource names are module-scoped. Where narrowing is impossible
//! nothing is remapped rather than guessed.

use std::collections::{HashMap, HashSet};

use crate::loaded_types::LoadedGraph;
use crate::types::{kind_of, name_of, AnalysisDiagnostic};

use super::types::MigrationRewrite;

/// One rewrite, with everything a diagnostic could be routed by.
struct RewriteRecord<'g> {
    source: &'g str,
    rewrite: &'g MigrationRewrite,
}

struct RewriteIndex<'g> {
    by_file: HashMap<&'g str, Vec<RewriteRecord<'g>>>,
    by_identity: HashMap<(String, String), Vec<RewriteRecord<'g>>>,
    size: usize,
}

fn build_index(graph: &LoadedGraph) -> RewriteIndex<'_> {
    let mut index = RewriteIndex { by_file: HashMap::new(), by_identity: HashMap::new(), size: 0 };
    for module in graph.modules.values() {
        let file = &module.owner;
        for rewrite in &file.migrations.rewrites {
            let manifest = file.manifests.get(rewrite.document_index).and_then(Option::as_ref);
            let record = || RewriteRecord { source: &file.source, rewrite };
            index.by_file.entry(&file.source).or_default().push(record());
            if let Some((kind, name)) = manifest.and_then(|m| Some((kind_of(m)?, name_of(m)?))) {
                index.by_identity.entry((kind.to_string(), name.to_string())).or_default().push(record());
            }
            index.size += 1;
        }
    }
    index
}

/// The records a diagnostic may be remapped against, narrowed by whichever routing facts
/// it carries; `None` when it cannot be narrowed to one file.
fn candidates_for<'i, 'g>(
    index: &'i RewriteIndex<'g>,
    file_path: Option<&str>,
    identity: Option<(&str, &str)>,
) -> Option<Vec<&'i RewriteRecord<'g>>> {
    if let Some((kind, name)) = identity {
        let records = index.by_identity.get(&(kind.to_string(), name.to_string()))?;
        if let Some(file) = file_path {
            return Some(records.iter().filter(|record| record.source == file).collect());
        }
        let files: HashSet<&str> = records.iter().map(|record| record.source).collect();
        return (files.len() <= 1).then(|| records.iter().collect());
    }
    Some(index.by_file.get(file_path?)?.iter().collect())
}

/// `path` with the longest matching migrated prefix swapped back to the legacy spelling,
/// or `None` when no rewrite touched it or two records disagree on its legacy spelling.
fn remap_path(path: &str, records: &[&RewriteRecord]) -> Option<String> {
    let mut best: Option<&MigrationRewrite> = None;
    let mut ambiguous = false;
    for record in records {
        let rewrite = record.rewrite;
        let migrated = rewrite.migrated_path.as_str();
        if migrated == rewrite.legacy_path {
            continue;
        }
        let covers = path == migrated
            || path.strip_prefix(migrated).is_some_and(|rest| rest.starts_with('.') || rest.starts_with('['));
        if !covers {
            continue;
        }
        match best {
            Some(current) if migrated.len() < current.migrated_path.len() => {}
            Some(current) if migrated.len() == current.migrated_path.len() => {
                if rewrite.legacy_path != current.legacy_path {
                    ambiguous = true;
                }
            }
            _ => {
                best = Some(rewrite);
                ambiguous = false;
            }
        }
    }
    let best = best.filter(|_| !ambiguous)?;
    Some(format!("{}{}", best.legacy_path, &path[best.migrated_path.len()..]))
}

/// Every diagnostic's `data.path` rewritten from the migrated spelling back to what the
/// author wrote; the input unchanged when nothing in the graph was migrated.
pub fn remap_migrated_paths(graph: &LoadedGraph, diagnostics: Vec<AnalysisDiagnostic>) -> Vec<AnalysisDiagnostic> {
    let index = build_index(graph);
    if index.size == 0 {
        return diagnostics;
    }
    diagnostics
        .into_iter()
        .map(|mut d| {
            let Some(data) = d.data.as_mut() else { return d };
            let Some(path) = data.path.as_deref() else { return d };
            let identity = data
                .resource
                .as_ref()
                .map(|resource| (resource.kind.as_str(), resource.name.as_str()));
            let Some(records) = candidates_for(&index, data.file_path.as_deref(), identity) else { return d };
            if records.is_empty() {
                return d;
            }
            if let Some(remapped) = remap_path(path, &records) {
                data.path = Some(remapped);
            }
            d
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::types::{DiagnosticData, LoadError, ManifestSource, ReadManifest};
    use crate::{load_graph, ManifestLoader};

    use super::*;

    struct OneFile(&'static str);

    impl ManifestSource for OneFile {
        fn supports(&self, _: &str) -> bool {
            true
        }

        fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
            Ok(ReadManifest { text: self.0.to_string(), source: path.to_string() })
        }
    }

    #[test]
    fn maps_a_diagnostic_on_a_renamed_node_back_onto_the_authors_path() {
        let text = "kind: Telo.Application\nmetadata: { name: App }\n---\nkind: Telo.Definition\nmetadata: { name: Body }\ncapability: Telo.Type\nschema:\n  properties:\n    body: { x-telo-stream: true }\n";
        let graph = load_graph(&ManifestLoader::new(vec![Box::new(OneFile(text))]), "/ws/telo.yaml").expect("loads");
        let at = |path: &str, resource: bool| {
            AnalysisDiagnostic::error(
                "X",
                "m",
                DiagnosticData {
                    resource: resource.then(|| crate::types::DiagnosticResource {
                        kind: "Telo.Definition".into(),
                        name: "Body".into(),
                    }),
                    file_path: Some("/ws/telo.yaml".into()),
                    path: Some(path.into()),
                    ..Default::default()
                },
            )
        };
        let remapped = remap_migrated_paths(
            &graph,
            vec![
                at("schema.properties.body.x-telo-type", true),
                at("schema.properties.body.x-telo-type", false),
                at("schema.properties.body", true),
            ],
        );
        let paths: Vec<&str> = remapped.iter().filter_map(|d| d.data.as_ref()?.path.as_deref()).collect();
        assert_eq!(
            paths,
            ["schema.properties.body.x-telo-stream", "schema.properties.body.x-telo-stream", "schema.properties.body"]
        );
    }
}
