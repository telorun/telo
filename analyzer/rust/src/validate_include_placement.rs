//! An `!include-text` / `!include-bytes` / `!module-path` in a doc that is never instantiated is
//! never read. Mirrors `../../nodejs/src/validate-include-placement.ts`.
//!
//! The tags resolve when the resource owning them is created, so a doc with no `create()` — a
//! `Telo.Application`, a `Telo.Library`, a `Telo.Import` — has no moment at which the file would
//! be read, and nothing else would report it. Deliberately narrow: it reports only where the
//! argument is complete. A need's `parameters:` are the exception: the kernel resolves a
//! `!module-path` there at load, and the need table judges every tag written there — as are the
//! copies an import's `metadata.requiredNeeds` stamp carries.
//!
//! A document with no `metadata.name` is reported with an empty name, as Node's diagnostic
//! carries `name: ""` in its `data.resource`.

use telo_templating::{is_include_engine, walk_cel_expressions, MODULE_PATH_ENGINE};

use crate::flatten_for_analyzer::stamped_need_parameters_paths;
use crate::inline_imports::IMPORT;
use crate::need_type::{is_at_or_beneath_path, need_parameters_paths};
use crate::system_kinds::{APPLICATION, LIBRARY};
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};
use crate::validate_requires::SourcedDocument;

/// Docs that are never instantiated as resources: module declarations and dependency edges.
/// `Telo.Definition` is deliberately absent: a definition's template body DOES become resources.
const NEVER_INSTANTIATED: [&str; 3] = [APPLICATION, LIBRARY, IMPORT];

/// Whether a doc of this kind is never created, so no tag in it is resolved.
pub fn is_never_instantiated(kind: &str) -> bool {
    NEVER_INSTANTIATED.contains(&kind)
}

pub fn validate_include_placement(documents: &[SourcedDocument]) -> Vec<AnalysisDiagnostic> {
    let mut out = Vec::new();
    for document in documents {
        let manifest = document.manifest;
        let Some(kind) = kind_of(manifest).filter(|kind| is_never_instantiated(kind)) else { continue };
        let name = name_of(manifest).unwrap_or_default();
        let mut parameters = need_parameters_paths(manifest);
        parameters.extend(stamped_need_parameters_paths(manifest));
        walk_cel_expressions(manifest, "", &mut |source, path, engine_name| {
            let embed = is_include_engine(engine_name);
            if !embed && engine_name != MODULE_PATH_ENGINE {
                return;
            }
            if is_at_or_beneath_path(path, &parameters) {
                return;
            }
            let subject = if name.is_empty() { kind.to_string() } else { format!("{kind}/{name}") };
            let remedy = if embed {
                "a file embed is resolved when the resource holding it is created. Move it onto the resource that needs the file, or read the file at runtime with a file-reading kind."
            } else {
                "a module path is resolved when the resource holding it is created. Move it onto the resource that needs the location."
            };
            out.push(AnalysisDiagnostic::error(
                if embed { "INCLUDE_OUTSIDE_RESOURCE" } else { "MODULE_PATH_OUTSIDE_RESOURCE" },
                format!(
                    "{subject}: `!{engine_name} {source}` at '{path}' is never read — a {kind} doc is not instantiated, and {remedy}"
                ),
                DiagnosticData {
                    resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                    file_path: Some(document.source.to_string()),
                    path: Some(path.to_string()),
                    ..Default::default()
                },
            ));
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use telo_templating::{make_tagged_sentinel, INCLUDE_TEXT_ENGINE};

    fn judge(manifest: &Value) -> Vec<(String, String)> {
        let documents = [SourcedDocument { manifest, module: None, source: "file:///demo/telo.yaml" }];
        validate_include_placement(&documents)
            .into_iter()
            .map(|d| (d.code.unwrap(), d.data.unwrap().path.unwrap()))
            .collect()
    }

    #[test]
    fn reports_an_embed_or_a_module_path_on_a_doc_nothing_instantiates() {
        let application = json!({ "kind": "Telo.Application", "metadata": { "name": "App" }, "variables": {
            "text": { "type": "string", "default": make_tagged_sentinel(INCLUDE_TEXT_ENGINE, "a.txt") },
            "dir": { "type": "string", "default": make_tagged_sentinel(MODULE_PATH_ENGINE, "static") },
            "cel": { "type": "string", "default": make_tagged_sentinel("cel", "1") },
        } });
        assert_eq!(
            judge(&application),
            [
                ("INCLUDE_OUTSIDE_RESOURCE".to_string(), "variables.text.default".to_string()),
                ("MODULE_PATH_OUTSIDE_RESOURCE".to_string(), "variables.dir.default".to_string()),
            ]
        );
        let resource = json!({ "kind": "Demo.Thing", "metadata": { "name": "t" }, "file": make_tagged_sentinel(INCLUDE_TEXT_ENGINE, "a.txt") });
        assert_eq!(judge(&resource), []);
    }

    #[test]
    fn leaves_a_need_parameters_module_path_to_the_need_table() {
        let library = json!({ "kind": "Telo.Library", "metadata": { "name": "Lib" }, "needs": {
            "icon": { "kind": "Telo.DesktopHost", "parameters": { "icon": make_tagged_sentinel(MODULE_PATH_ENGINE, "icon.png") } },
        }, "description": make_tagged_sentinel(MODULE_PATH_ENGINE, "x") });
        assert_eq!(judge(&library), [("MODULE_PATH_OUTSIDE_RESOURCE".to_string(), "description".to_string())]);
    }
}
