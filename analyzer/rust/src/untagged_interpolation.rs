//! A plain string holding `${{` — `UNTAGGED_INTERPOLATION`, the static twin of the load's
//! `ERR_UNTAGGED_INTERPOLATION`. Mirrors `../../nodejs/src/untagged-interpolation.ts`.
//!
//! The loader's migration rewrites every readable hole, so this reports what it leaves: a
//! `${{` no hole can be read out of. The entry module's half judges each document of its
//! files — the desugared `Telo.Import` documents included — at its own path. A declaration
//! nested inside another (`{ kind, … }`) and a subtree behind an expansion tag are not judged
//! there, since Node reports a site there under the resource and path its normalization and
//! expansion give it, which this tree does not hold. The dependency half reads each imported
//! library's documents as written, every site listed in one diagnostic at each of the entry's
//! `Telo.Import`s reaching it — at the library's own file when none does.

use serde_json::Value;
use telo_templating::{expansion_tag_of, interpolation_shape, is_tagged_sentinel, InterpolationShape};

use crate::inline_imports::IMPORT;
use crate::loaded_types::{LoadedFile, LoadedGraph};
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};

/// What both halves say about a plain string still holding `${{` at `path`.
pub fn untagged_interpolation_message(path: &str) -> String {
    let subject = if path.is_empty() { "A value is".to_string() } else { format!("'{path}' is") };
    format!(
        "{subject} a plain string holding '${{{{', which is never evaluated. Untagged interpolation is a legacy spelling the 'untagged-interpolation' migration rewrites (a lone hole to !cel, text with holes to !interpolate); run 'telo migrate' to apply it, or tag the value !literal if the text is meant literally."
    )
}

/// Every plain string holding `${{`: the entry module's own, and each imported library's.
pub fn validate_untagged_interpolation(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let mut out = untagged_interpolation_in_entry(graph);
    out.extend(untagged_interpolation_in_libraries(graph));
    out
}

/// What the entry's own documents hold: each judged alone.
fn untagged_interpolation_in_entry(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let mut out = Vec::new();
    for file in graph.entry().files() {
        for manifest in file.documents() {
            let Some(kind) = kind_of(manifest) else { continue };
            let name = name_of(manifest).unwrap_or_default();
            let mut sites = Vec::new();
            walk_members(manifest, &mut String::new(), &mut sites, &walk);
            for path in sites {
                out.push(AnalysisDiagnostic::error(
                    "UNTAGGED_INTERPOLATION",
                    format!("{kind}/{name}: {}", untagged_interpolation_message(&path)),
                    DiagnosticData {
                        resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                        file_path: Some(file.source.clone()),
                        path: Some(path),
                        ..Default::default()
                    },
                ));
            }
        }
    }
    out
}

/// What each imported library holds, reported at the entry's imports of it.
fn untagged_interpolation_in_libraries(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let root_module = graph.entry().owner.module_document().and_then(name_of);
    let mut out = Vec::new();
    for (source, library) in &graph.modules {
        if *source == graph.root_source {
            continue;
        }
        let Some(module) = library.owner.module_document().and_then(name_of).filter(|name| !name.is_empty()) else {
            continue;
        };
        if Some(module) == root_module {
            continue;
        }
        let mut sites = Vec::new();
        for manifest in library.files().flat_map(LoadedFile::documents) {
            let kind = kind_of(manifest).unwrap_or("undefined");
            let name = name_of(manifest).unwrap_or_default();
            let mut paths = Vec::new();
            walk_members(manifest, &mut String::new(), &mut paths, &walk_written);
            sites.extend(paths.into_iter().map(|path| format!("{kind}/{name} '{path}'")));
        }
        if sites.is_empty() {
            continue;
        }
        let message = format!(
            "the imported library '{module}' holds a plain string with '${{{{' that no hole can be read out of ({}), so it fails to load with ERR_UNTAGGED_INTERPOLATION. It is the library's to fix; import a version that writes it as !interpolate or !literal.",
            sites.join(", ")
        );
        let imports = imports_of(graph, module);
        if imports.is_empty() {
            out.push(AnalysisDiagnostic::error(
                "UNTAGGED_INTERPOLATION",
                format!("Telo.Library/{module}: {message}"),
                DiagnosticData { file_path: Some(library.owner.source.clone()), path: Some(String::new()), ..Default::default() },
            ));
            continue;
        }
        for (file, alias) in imports {
            out.push(AnalysisDiagnostic::error(
                "UNTAGGED_INTERPOLATION",
                format!("{IMPORT}/{alias}: {message}"),
                DiagnosticData {
                    resource: Some(DiagnosticResource { kind: IMPORT.to_string(), name: alias.to_string() }),
                    file_path: Some(file.to_string()),
                    path: Some("source".to_string()),
                    ..Default::default()
                },
            ));
        }
    }
    out
}

/// The entry's own `Telo.Import` documents whose edge reaches `module`, by file and alias.
fn imports_of<'g>(graph: &'g LoadedGraph, module: &str) -> Vec<(&'g str, &'g str)> {
    let mut out = Vec::new();
    for file in graph.entry().files() {
        let Some(edges) = graph.import_edges.get(&file.source) else { continue };
        for manifest in file.documents().filter(|m| kind_of(m) == Some(IMPORT)) {
            let Some(alias) = name_of(manifest) else { continue };
            if edges.get(alias).is_some_and(|edge| edge.target_module_name == module) {
                out.push((file.source.as_str(), alias));
            }
        }
    }
    out
}

/// The members of a mapping or a sequence, each judged by `visit` at its own path.
fn walk_members(value: &Value, path: &mut String, sites: &mut Vec<String>, visit: &dyn Fn(&Value, &mut String, &mut Vec<String>)) {
    let length = path.len();
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push_str(&format!("[{index}]"));
                visit(item, path, sites);
                path.truncate(length);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(key);
                visit(item, path, sites);
                path.truncate(length);
            }
        }
        _ => {}
    }
}

/// A site holding `${{`, stopping at a tagged value, a nested declaration and an expansion tag.
fn walk(value: &Value, path: &mut String, sites: &mut Vec<String>) {
    if let Value::String(text) = value {
        if interpolation_shape(text) != InterpolationShape::None {
            sites.push(path.clone());
        }
        return;
    }
    let nested_declaration = value.get("kind").is_some_and(Value::is_string);
    if is_tagged_sentinel(value) || expansion_tag_of(value).is_some() || nested_declaration {
        return;
    }
    walk_members(value, path, sites, &walk);
}

/// A site holding `${{` anywhere in a document as written, stopping only at a tagged value.
fn walk_written(value: &Value, path: &mut String, sites: &mut Vec<String>) {
    if let Value::String(text) = value {
        if interpolation_shape(text) != InterpolationShape::None {
            sites.push(path.clone());
        }
        return;
    }
    if is_tagged_sentinel(value) {
        return;
    }
    walk_members(value, path, sites, &walk_written);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LoadError, ManifestSource, ReadManifest};
    use crate::{load_graph, ManifestLoader};

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
    fn judges_no_site_inside_a_nested_declaration_or_a_tagged_scalar() {
        let text = "kind: Telo.Application\nmetadata: { name: App }\n---\nkind: Telo.Sequence\nmetadata: { name: main }\nsteps:\n  - name: a\n    invoke: { kind: Telo.Value, value: \"${{ 1\" }\n  - name: b\n    note: !literal \"${{ 2\"\n  - name: c\n    note: \"${{ 3\"\n";
        let graph = load_graph(&ManifestLoader::new(vec![Box::new(OneFile(text))]), "/ws/telo.yaml").expect("loads");
        let paths: Vec<String> = validate_untagged_interpolation(&graph)
            .into_iter()
            .filter_map(|d| d.data?.path)
            .collect();
        assert_eq!(paths, ["steps[2].note"]);
    }
}
