//! What a `Telo.Library` document refuses in its own blocks: `env:` and `arg:` on a
//! `variables` / `secrets` entry (only an Application's entries bind the host), and a
//! non-string `exports.resources` entry (the `!ref` tag parses to a sentinel the schema's CEL
//! exemption would silently pass). Mirrors `../../nodejs/src/validate-library-blocks.ts`.
//!
//! A library declaring no `metadata.name` is not judged, since the diagnostic Node writes for
//! it names no resource, which this crate's diagnostic cannot say — an under-report.

use serde_json::Value;

use crate::system_kinds::LIBRARY;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};
use crate::validate_requires::SourcedDocument;

pub fn library_block_diagnostics(documents: &[SourcedDocument]) -> Vec<AnalysisDiagnostic> {
    let mut out = Vec::new();
    for document in documents {
        let manifest = document.manifest;
        if kind_of(manifest) != Some(LIBRARY) {
            continue;
        }
        let Some(module_name) = name_of(manifest) else { continue };
        let at = |path: String| DiagnosticData {
            resource: Some(DiagnosticResource { kind: LIBRARY.to_string(), name: module_name.to_string() }),
            file_path: Some(document.source.to_string()),
            path: Some(path),
            ..Default::default()
        };
        for block in ["variables", "secrets"] {
            let Some(entries) = manifest.get(block).and_then(Value::as_object) else { continue };
            for (entry_name, entry) in entries {
                let Some(entry) = entry.as_object() else { continue };
                if entry.contains_key("env") {
                    out.push(AnalysisDiagnostic::error(
                        "LIBRARY_ENV_KEY_REJECTED",
                        format!(
                            "Telo.Library {block}/{entry_name}: 'env:' is only permitted on Telo.Application entries. Libraries must receive values from importers via the parent manifest's variables / secrets block."
                        ),
                        at(format!("{block}.{entry_name}.env")),
                    ));
                }
                if entry.contains_key("arg") {
                    out.push(AnalysisDiagnostic::error(
                        "LIBRARY_ARG_KEY_REJECTED",
                        format!(
                            "Telo.Library {block}/{entry_name}: 'arg:' is only permitted on Telo.Application entries — only the application being run reads the command line. Libraries must receive values from importers via the parent manifest's variables / secrets block."
                        ),
                        at(format!("{block}.{entry_name}.arg")),
                    ));
                }
            }
        }
        let Some(exported) = manifest.get("exports").and_then(|exports| exports.get("resources")).and_then(Value::as_array)
        else {
            continue;
        };
        for (index, exported) in exported.iter().enumerate() {
            if exported.is_string() {
                continue;
            }
            out.push(AnalysisDiagnostic::error(
                "INVALID_EXPORT",
                format!(
                    "Telo.Library exports.resources[{index}]: write the exported name as a plain string — 'Name' to export a local instance, or 'Alias.Name' to re-export an imported one. The '!ref' tag is not allowed in exports.resources."
                ),
                at(format!("exports.resources.{index}")),
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use telo_templating::make_tagged_sentinel;

    fn judge(manifest: &Value) -> Vec<(String, String, String)> {
        let documents = [SourcedDocument { manifest, module: None, source: "file:///lib/telo.yaml" }];
        library_block_diagnostics(&documents)
            .into_iter()
            .map(|d| (d.code.unwrap(), d.data.unwrap().path.unwrap(), d.message))
            .collect()
    }

    #[test]
    fn rejects_env_and_arg_on_a_library_entry() {
        let library = json!({ "kind": "Telo.Library", "metadata": { "name": "Lib" },
            "variables": { "port": { "type": "integer", "env": "PORT", "arg": "port" } },
            "secrets": { "key": { "type": "string", "env": "KEY" } } });
        let found = judge(&library);
        assert_eq!(
            found.iter().map(|(code, path, _)| (code.as_str(), path.as_str())).collect::<Vec<_>>(),
            [
                ("LIBRARY_ENV_KEY_REJECTED", "variables.port.env"),
                ("LIBRARY_ARG_KEY_REJECTED", "variables.port.arg"),
                ("LIBRARY_ENV_KEY_REJECTED", "secrets.key.env"),
            ]
        );
        assert!(found[0].2.starts_with("Telo.Library variables/port: 'env:' is only permitted on Telo.Application entries."));
    }

    #[test]
    fn rejects_a_non_string_exported_resource_and_judges_an_application_never() {
        let library = json!({ "kind": "Telo.Library", "metadata": { "name": "Lib" },
            "exports": { "resources": ["ok", make_tagged_sentinel("ref", "db")] } });
        assert_eq!(judge(&library).iter().map(|(code, path, _)| (code.as_str(), path.as_str())).collect::<Vec<_>>(), [("INVALID_EXPORT", "exports.resources.1")]);
        let application = json!({ "kind": "Telo.Application", "metadata": { "name": "App" },
            "variables": { "port": { "type": "integer", "env": "PORT" } } });
        assert_eq!(judge(&application), []);
    }
}
