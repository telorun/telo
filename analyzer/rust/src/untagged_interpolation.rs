//! A plain string holding `${{` — `UNTAGGED_INTERPOLATION`, the static twin of the load's
//! `ERR_UNTAGGED_INTERPOLATION`. Mirrors `../../nodejs/src/untagged-interpolation.ts`.
//!
//! The loader's migration rewrites every readable hole, so this reports what it leaves: a
//! `${{` no hole can be read out of. The entry module's half is here, each site at its own
//! path. A declaration nested inside another (`{ kind, … }`) and a subtree behind an
//! expansion tag are not judged, since Node reports a site there under the resource and
//! path its normalization and expansion give it, which this tree does not hold. Node's
//! dependency half — one diagnostic at each `Telo.Import` reaching a library that holds
//! such a string — is owed by the twin of Node's import desugar, which gives the analysis
//! its `Telo.Import` documents.

use serde_json::Value;
use telo_templating::{expansion_tag_of, interpolation_shape, is_tagged_sentinel, InterpolationShape};

use crate::loaded_types::LoadedGraph;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};

/// What both halves say about a plain string still holding `${{` at `path`.
pub fn untagged_interpolation_message(path: &str) -> String {
    let subject = if path.is_empty() { "A value is".to_string() } else { format!("'{path}' is") };
    format!(
        "{subject} a plain string holding '${{{{', which is never evaluated. Untagged interpolation is a legacy spelling the 'untagged-interpolation' migration rewrites (a lone hole to !cel, text with holes to !interpolate); run 'telo migrate' to apply it, or tag the value !literal if the text is meant literally."
    )
}

/// Every plain string holding `${{` in the entry module's own documents.
pub fn validate_untagged_interpolation(graph: &LoadedGraph) -> Vec<AnalysisDiagnostic> {
    let file = &graph.entry().owner;
    let mut out = Vec::new();
    for manifest in file.documents() {
        let Some(kind) = kind_of(manifest) else { continue };
        let name = name_of(manifest).unwrap_or_default();
        let mut sites = Vec::new();
        walk_members(manifest, &mut String::new(), &mut sites);
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
    out
}

/// The members of a mapping or a sequence, each walked at its own path.
fn walk_members(value: &Value, path: &mut String, sites: &mut Vec<String>) {
    let length = path.len();
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push_str(&format!("[{index}]"));
                walk(item, path, sites);
                path.truncate(length);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(key);
                walk(item, path, sites);
                path.truncate(length);
            }
        }
        _ => {}
    }
}

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
    walk_members(value, path, sites);
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
