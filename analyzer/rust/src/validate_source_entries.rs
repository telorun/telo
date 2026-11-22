//! The strict half of `source_entries`: what `telo check` reports about a module doc's
//! `sources:` block. Mirrors `../../nodejs/src/validate-source-entries.ts`.
//!
//! Every rule the block alone decides is a reader problem, reported here under its own code.
//! This adds the rules that need the rest of the module or that only publish enforces: an entry
//! must stage a file the manifest names, a link ships in its target's layer, and every file
//! entry and every build carries its pin. Shape errors, and the identity formats the owner
//! doc's JSON Schema checks, are left to it. Entry-module-scoped: a dependency's block is not
//! the consumer's to fix.
//!
//! A module document declaring no `metadata.name` is not judged, since the diagnostic Node
//! writes for it names no resource, which this crate's diagnostic cannot say — an under-report.

use std::collections::HashSet;

use serde_json::Value;

use crate::module_file_claims::{claim_registry, module_document_claims};
use crate::module_named_files::{
    cross_layer_source_links, read_asset_patterns, stageable_files, unclaimed_source_entries, StagedAssets,
};
use crate::native_entries::{normalize_native_path, read_native_entries, PathVerdict};
use crate::source_entries::{read_module_sources, SourceEntry};
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource};
use crate::validate_native_entries::owned_by_entry;
use crate::validate_requires::SourcedDocument;

pub fn validate_source_entries(
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

        let read = read_module_sources(document.manifest);
        for problem in &read.problems {
            if problem.code == "SHAPE" || problem.owner_schema {
                continue;
            }
            report(problem.code, problem.path.clone(), problem.message.clone());
        }
        let sources = &read.sources;
        if sources.is_empty() {
            continue;
        }

        for source in sources {
            if source.build.as_ref().is_some_and(|build| build.inputs.is_none()) {
                report(
                    "SOURCE_BUILD_UNPINNED",
                    format!("sources.{}.build", source.name),
                    format!(
                        "source '{}' names the crate its files are built from but records no build inputs, so a later edit to that crate cannot be caught — run `telo release stage --pin` after building its files. `telo release check` and publish refuse it.",
                        source.name
                    ),
                );
            }
            for entry in &source.entries {
                let SourceEntry::File { key, pin: None, .. } = entry else { continue };
                report(
                    "SOURCE_ENTRY_UNPINNED",
                    format!("sources.{}.entries.{key}", source.name),
                    format!(
                        "source '{}' entry '{key}' carries no pin (sha256 and executable), so nothing can verify the file it stages: a kernel refuses to read it and publish refuses to ship it — run `telo release stage --pin`.",
                        source.name
                    ),
                );
            }
        }

        let module_name = document.module.or(Some(name));
        let claims = module_document_claims(documents, module_name, claim_registry());
        let native = read_native_entries(document.manifest).entries;
        let patterns = read_asset_patterns(document.manifest);
        let stageable = stageable_files(&native, &claims, Some(&StagedAssets { patterns: &patterns, sources }));
        for link in cross_layer_source_links(sources, &stageable) {
            let SourceEntry::Link { key, .. } = link.entry else { continue };
            report(
                "SOURCE_LINK_TARGET_UNRESOLVED",
                format!("sources.{}.entries.{key}.target", link.source.name),
                format!(
                    "source '{}' entry '{key}': the link ships in the {} layer, but its target '{}' ships in the {} layer. A runtime extracts only the layers it needs, so the link would dangle — point it at a file of its own layer.",
                    link.source.name, link.layer, link.resolved, link.target_layer
                ),
            );
        }
        // A `native:` entry with an unrelated problem still names its path; reported once, as
        // that problem, rather than again as an unclaimed source entry.
        let mut unread_native: HashSet<String> = HashSet::new();
        for entry in document.manifest.get("native").and_then(Value::as_array).into_iter().flatten() {
            let Some(path) = entry.get("path").and_then(Value::as_str) else { continue };
            if let PathVerdict::Path(path) = normalize_native_path(path.trim()) {
                unread_native.insert(path);
            }
        }
        for unclaimed in unclaimed_source_entries(sources, &stageable, &unread_native) {
            let (key, path) = (unclaimed.entry.key(), unclaimed.entry.path());
            report(
                "SOURCE_ENTRY_UNCLAIMED",
                format!("sources.{}.entries.{key}", unclaimed.source.name),
                format!(
                    "source '{}' entry '{key}': nothing in the module names '{path}' — no native: entry's path, no platform-qualified controller candidate's path=, no assets: pattern, and none of the source's notices. Name the file where it is used, or remove the entry.",
                    unclaimed.source.name
                ),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST: &str = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn pinned(upstream: &str) -> Value {
        json!({ "upstream": upstream, "member": "m", "sha256": SHA, "executable": false })
    }

    fn owner(entries: Value, extra: Value) -> Value {
        let mut owner = json!({
            "kind": "Telo.Library", "metadata": { "name": "Demo" },
            "native": [{ "name": "addon", "format": "napi", "os": "linux", "arch": "amd64", "path": "./native/a.node" }],
            "sources": { "addon": { "version": "1", "purl": "pkg:generic/addon", "url": "https://e.test/x.tgz",
                "archive": "tar.gz", "notices": ["./LICENSE"], "entries": entries } },
        });
        owner.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        owner
    }

    fn judge(owner: &Value, entry_modules: Option<&[&str]>) -> Vec<(String, Option<String>)> {
        let documents = [SourcedDocument { manifest: owner, module: None, source: "file:///demo/telo.yaml" }];
        let modules: Option<HashSet<String>> = entry_modules.map(|names| names.iter().map(|n| n.to_string()).collect());
        validate_source_entries(&documents, modules.as_ref())
            .into_iter()
            .map(|d| (d.code.unwrap(), d.data.and_then(|data| data.path)))
            .collect()
    }

    fn at(code: &str, path: &str) -> (String, Option<String>) {
        (code.to_string(), Some(path.to_string()))
    }

    #[test]
    fn a_staged_file_the_module_names_reports_nothing() {
        assert_eq!(judge(&owner(json!({ "native/a.node": pinned("u") }), json!({})), None), []);
    }

    #[test]
    fn reports_the_rules_only_the_module_decides() {
        let mut unpinned = pinned("u");
        unpinned.as_object_mut().unwrap().retain(|key, _| key == "upstream" || key == "member");
        assert_eq!(
            judge(&owner(json!({ "native/a.node": unpinned }), json!({})), None),
            [at("SOURCE_ENTRY_UNPINNED", "sources.addon.entries.native/a.node")]
        );
        assert_eq!(
            judge(&owner(json!({ "native/a.node": pinned("u"), "native/other.node": pinned("v") }), json!({})), None),
            [at("SOURCE_ENTRY_UNCLAIMED", "sources.addon.entries.native/other.node")]
        );
        let built = json!({ "sources": { "addon": { "version": "1", "url": "https://e.test/x.tgz", "archive": "tar.gz",
            "notices": ["./LICENSE"], "entries": { "native/a.node": pinned("u") }, "build": { "cargo": "rust" } } } });
        assert_eq!(judge(&owner(json!({}), built), None), [at("SOURCE_BUILD_UNPINNED", "sources.addon.build")]);
        let built_pinned = json!({ "sources": { "addon": { "version": "1", "url": "https://e.test/x.tgz", "archive": "tar.gz",
            "notices": ["./LICENSE"], "entries": { "native/a.node": pinned("u") }, "build": { "cargo": "rust", "inputs": DIGEST } } } });
        assert_eq!(judge(&owner(json!({}), built_pinned), None), []);
    }

    #[test]
    fn reports_a_link_whose_target_ships_in_another_layer() {
        let native = json!({ "native": [
            { "name": "a", "format": "napi", "os": "linux", "arch": "amd64", "path": "./native/a.node" },
            { "name": "b", "format": "napi", "os": "darwin", "arch": "arm64", "path": "./native/b.node" },
        ] });
        let entries = json!({ "native/a.node": pinned("u"), "native/b.node": { "target": "a.node" }, });
        assert_eq!(
            judge(&owner(entries, native), None),
            [at("SOURCE_LINK_TARGET_UNRESOLVED", "sources.addon.entries.native/b.node.target")]
        );
    }

    #[test]
    fn reports_reader_problems_and_leaves_shape_and_the_schemas_formats_alone() {
        let nested = json!({ "native/a.node": pinned("u"), "native/a.node/b": pinned("v") });
        assert_eq!(
            judge(&owner(nested, json!({})), None),
            [at("SOURCE_ENTRY_NESTED", "sources.addon.entries.native/a.node/b")]
        );
        let insecure = json!({ "sources": { "addon": { "version": "1", "purl": "pkg:generic/addon", "url": "http://e.test/x.tgz",
            "archive": "tar.gz", "notices": ["./LICENSE"], "entries": { "native/a.node": pinned("u") } } } });
        assert_eq!(judge(&owner(json!({}), insecure), None), [at("SOURCE_URL_INSECURE", "sources.addon.url")]);
        let shapeless = json!({ "sources": { "addon": { "version": "1" } } });
        assert_eq!(judge(&owner(json!({}), shapeless), None), []);
        let bad_purl = json!({ "sources": { "addon": { "version": "1", "purl": "pkg:npm/addon@1", "url": "https://e.test/x.tgz",
            "archive": "tar.gz", "notices": ["./LICENSE"], "entries": { "native/a.node": pinned("u") } } } });
        assert_eq!(judge(&owner(json!({}), bad_purl), None), []);
    }

    #[test]
    fn says_nothing_about_a_dependencys_block() {
        assert_eq!(judge(&owner(json!({ "native/other.node": pinned("u") }), json!({})), Some(&["App"])), []);
    }
}
