//! The strict half of `native_entries`: what `telo check` reports about a module doc's
//! `native:` block. Mirrors `../../nodejs/src/validate-native-entries.ts`.
//!
//! Every rule is decidable from the manifest and would otherwise surface only on a consumer's
//! host, as a native file that never matches or a layer that overwrites another's file. Shape
//! errors (a missing key, an unknown one) are left to the owner doc's JSON Schema.
//! Entry-module-scoped: a dependency's block is not the consumer's to fix.
//!
//! A module document declaring no `metadata.name` is not judged, since the diagnostic Node
//! writes for it names no resource, which this crate's diagnostic cannot say — an under-report.

use std::collections::{HashMap, HashSet};

use crate::artifact_selector::{describe_selector, selector_contradictions, selector_key};
use crate::module_file_claims::{claim_registry, module_document_claims};
use crate::module_named_files::{describe_claim, native_claim_conflicts};
use crate::native_entries::{read_native_entries, NativeEntry, NativeProblemKind};
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};
use crate::validate_requires::SourcedDocument;

/// Whether the entry owns `document`'s module: a dependency's block is not the consumer's.
pub(crate) fn owned_by_entry(document: &SourcedDocument, name: &str, entry_modules: Option<&HashSet<String>>) -> bool {
    entry_modules.is_none_or(|modules| modules.contains(document.module.unwrap_or(name)))
}

pub fn validate_native_entries(
    documents: &[SourcedDocument],
    entry_modules: Option<&HashSet<String>>,
) -> Vec<AnalysisDiagnostic> {
    let mut out = Vec::new();
    for document in documents {
        let Some(kind) = kind_of(document.manifest).filter(|kind| is_module_document(kind)) else { continue };
        let Some(name) = name_of(document.manifest) else { continue };
        if !owned_by_entry(document, name, entry_modules) {
            continue;
        }
        let label = format!("{kind}/{name}");
        let mut report = |code: &str, path: String, message: String| {
            out.push(AnalysisDiagnostic::error(
                code,
                format!("{label}: {message}"),
                DiagnosticData {
                    resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
                    file_path: Some(document.source.to_string()),
                    path: Some(path),
                    ..Default::default()
                },
            ))
        };

        let read = read_native_entries(document.manifest);
        for problem in &read.problems {
            let code = match problem.kind {
                NativeProblemKind::Shape => continue,
                NativeProblemKind::Escape => "NATIVE_PATH_ESCAPES_MODULE",
                NativeProblemKind::Invalid => "NATIVE_ENTRY_INVALID",
            };
            report(code, problem.path.clone(), problem.message.clone());
        }
        if read.entries.is_empty() {
            continue;
        }

        let module_name = document.module.or(Some(name));
        let claims = module_document_claims(documents, module_name, claim_registry());
        for conflict in native_claim_conflicts(&read.entries, &claims) {
            report(
                "NATIVE_PATH_CLAIMED",
                format!("native[{}].path", conflict.entry.index),
                format!(
                    "{}: path '{}' is also named by {}. A native file ships only in its platform's native layer and a file extracts from exactly one layer, so publish refuses it — give the native entry its own file, or drop the other declaration.",
                    conflict.entry.origin,
                    conflict.entry.path,
                    describe_claim(conflict.claim)
                ),
            );
        }

        let mut by_selector: HashMap<String, &NativeEntry> = HashMap::new();
        let mut by_path: Vec<(&str, &NativeEntry)> = Vec::new();
        for entry in &read.entries {
            let at = format!("native[{}]", entry.index);
            if entry.selector.format == "node" && entry.selector.axes.get(crate::artifact_selector::PlatformAxis::Abi).is_none()
            {
                report(
                    "NATIVE_NODE_ABI_MISSING",
                    at.clone(),
                    format!(
                        "{}: a 'node' addon is built against one Node ABI and must state it — add abi: node-<NODE_MODULE_VERSION>, e.g. 'node-137'. Without it the file matches every Node release and fails to load on all but one.",
                        entry.origin
                    ),
                );
            }
            for contradiction in selector_contradictions(&entry.selector) {
                report(
                    &format!("NATIVE_{}", contradiction.rule),
                    format!("{at}.{}", contradiction.axis.name()),
                    format!("{}: {}", entry.origin, contradiction.detail),
                );
            }

            let key = format!("{}\0{}", entry.name, selector_key(&entry.selector));
            match by_selector.get(&key) {
                Some(twin) => report(
                    "NATIVE_ENTRY_DUPLICATE",
                    at.clone(),
                    format!(
                        "{}: {} already declares '{}' for {}. A name has one entry per platform tuple, or a lookup by name could resolve to either file.",
                        entry.origin,
                        twin.origin,
                        entry.name,
                        describe_selector(&entry.selector)
                    ),
                ),
                None => {
                    by_selector.insert(key, entry);
                }
            }

            let sharer = by_path.iter().find(|(path, _)| *path == entry.path).map(|(_, sharer)| *sharer);
            match sharer {
                Some(sharer) if selector_key(&sharer.selector) != selector_key(&entry.selector) => report(
                    "NATIVE_PATH_SHARED",
                    format!("{at}.path"),
                    format!(
                        "{}: path '{}' is also declared by {} for {}. Every layer of a module extracts into one directory, so each platform tuple needs its own path — e.g. 'native/<os>-<arch>/…'.",
                        entry.origin,
                        entry.path,
                        sharer.origin,
                        describe_selector(&sharer.selector)
                    ),
                ),
                Some(_) => {}
                None => by_path.push((&entry.path, entry)),
            }

            let through = by_path.iter().map(|(_, other)| *other).find(|other| {
                other.index != entry.index
                    && (entry.path.starts_with(&format!("{}/", other.path))
                        || other.path.starts_with(&format!("{}/", entry.path)))
            });
            if let Some(through) = through {
                let relation = if entry.path.starts_with(&format!("{}/", through.path)) {
                    format!("runs through '{}' as a directory", through.path)
                } else {
                    format!("is a directory that '{}' runs through", through.path)
                };
                report(
                    "NATIVE_PATH_NESTED",
                    format!("{at}.path"),
                    format!(
                        "{}: path '{}' {relation}, and {} declares '{}'. Every layer of a module extracts into one directory, so a path cannot be both a file and a directory — give each entry its own path.",
                        entry.origin, entry.path, through.origin, through.path
                    ),
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use telo_templating::{make_tagged_sentinel, INCLUDE_BYTES_ENGINE};

    fn linux_node() -> Value {
        json!({ "name": "addon", "format": "node", "os": "linux", "arch": "amd64", "libc": "gnu", "abi": "node-137",
            "path": "./native/linux-amd64-gnu-node-137/addon.node" })
    }

    fn darwin_napi() -> Value {
        json!({ "name": "addon", "format": "napi", "os": "darwin", "arch": "arm64", "path": "./native/darwin-arm64/addon.node" })
    }

    fn owner(native: Value, name: &str) -> Value {
        json!({ "kind": "Telo.Library", "metadata": { "name": name }, "native": native })
    }

    fn judge(documents: &[&Value], entry: Option<&[&str]>) -> Vec<(String, Option<String>)> {
        let sourced: Vec<_> = documents
            .iter()
            .map(|manifest| SourcedDocument {
                manifest,
                module: if kind_of(manifest).is_some_and(is_module_document) { None } else { Some("Demo") },
                source: "file:///demo/telo.yaml",
            })
            .collect();
        let modules: Option<HashSet<String>> = entry.map(|names| names.iter().map(|n| n.to_string()).collect());
        validate_native_entries(&sourced, modules.as_ref())
            .into_iter()
            .map(|d| (d.code.unwrap(), d.data.and_then(|data| data.path)))
            .collect()
    }

    fn one(native: Value) -> Vec<(String, Option<String>)> {
        judge(&[&owner(native, "Demo")], None)
    }

    fn expect(code: &str, path: &str) -> Vec<(String, Option<String>)> {
        vec![(code.to_string(), Some(path.to_string()))]
    }

    #[test]
    fn reports_each_rule_at_the_offending_entry() {
        let mut abi_missing = linux_node();
        abi_missing.as_object_mut().unwrap().remove("abi");
        assert_eq!(one(json!([abi_missing])), expect("NATIVE_NODE_ABI_MISSING", "native[0]"));
        let mut napi_abi = darwin_napi();
        napi_abi["abi"] = json!("node-137");
        assert_eq!(one(json!([napi_abi])), expect("NATIVE_NAPI_ABI_FORBIDDEN", "native[0].abi"));
        let mut libc = darwin_napi();
        libc["libc"] = json!("gnu");
        assert_eq!(one(json!([libc])), expect("NATIVE_LIBC_OFF_LINUX", "native[0].libc"));
        let mut other_path = linux_node();
        other_path["path"] = json!("./native/other.node");
        assert_eq!(one(json!([linux_node(), other_path])), expect("NATIVE_ENTRY_DUPLICATE", "native[1]"));
        let mut musl = linux_node();
        musl["libc"] = json!("musl");
        assert_eq!(one(json!([linux_node(), musl])), expect("NATIVE_PATH_SHARED", "native[1].path"));
        let mut escape = linux_node();
        escape["path"] = json!("../elsewhere/addon.node");
        assert_eq!(one(json!([escape])), expect("NATIVE_PATH_ESCAPES_MODULE", "native[0].path"));
        let mut nested = linux_node();
        nested["path"] = json!("native/darwin-arm64/addon.node/inner.node");
        assert_eq!(one(json!([darwin_napi(), nested])), expect("NATIVE_PATH_NESTED", "native[1].path"));
        assert_eq!(one(json!([linux_node(), darwin_napi()])), []);
    }

    #[test]
    fn reports_a_value_outside_the_token_grammar_as_invalid() {
        let mut bad_abi = linux_node();
        bad_abi["abi"] = json!("137");
        let mut bad_name = darwin_napi();
        bad_name["name"] = json!("Addon!");
        let codes = one(json!([bad_abi, bad_name]));
        assert_eq!(codes.iter().map(|(code, _)| code.as_str()).collect::<Vec<_>>(), ["NATIVE_ENTRY_INVALID"; 2]);
    }

    #[test]
    fn reports_a_native_path_a_controller_candidate_or_an_embed_also_names() {
        let definition = json!({ "kind": "Telo.Definition", "metadata": { "name": "Thing" },
            "controllers": ["pkg:telo/local/napi?path=./native/darwin-arm64/addon.node&os=darwin&arch=arm64"] });
        assert_eq!(
            judge(&[&owner(json!([darwin_napi()]), "Demo"), &definition], None),
            expect("NATIVE_PATH_CLAIMED", "native[0].path")
        );
        let blob = json!({ "kind": "Demo.Blob", "metadata": { "name": "blob" },
            "bytes": make_tagged_sentinel(INCLUDE_BYTES_ENGINE, "native/darwin-arm64/addon.node") });
        assert_eq!(
            judge(&[&owner(json!([darwin_napi()]), "Demo"), &blob], None),
            expect("NATIVE_PATH_CLAIMED", "native[0].path")
        );
    }

    #[test]
    fn says_nothing_about_a_dependencys_block() {
        let mut napi_abi = darwin_napi();
        napi_abi["abi"] = json!("node-137");
        assert_eq!(judge(&[&owner(json!([napi_abi]), "Dep")], Some(&["App"])), []);
    }
}
