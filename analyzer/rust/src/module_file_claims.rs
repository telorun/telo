//! One module-relative file a manifest names, and the artifact layer it belongs to. Mirrors
//! `../../nodejs/src/module-file-claims.ts`: a controller candidate is read by this module, a
//! library or browser entry by its own reader, and a tagged value by the engine that owns its
//! tag (`TemplatingEngine::file_claims`). Every path is module-root-relative, never relative to
//! the file the claim was written in. Whether a claimed file EXISTS is a separate question.
//!
//! Left out: `collectModuleFileClaims`, the text entry — it parses one `telo.yaml`'s text, and
//! only `telo publish` calls it, which this build does not carry. The PURL a controller
//! candidate is written in is read by `crate::purl`, the one parser, where Node asks
//! `packageurl-js`.

use std::collections::HashSet;

use serde_json::Value;
use telo_templating::{default_registry, walk_cel_expressions, TemplatingEngineRegistry};

use crate::artifact_selector::{
    selector_from_qualifiers, selector_key, ArtifactSelector, ArtifactSelectorError,
};
use crate::module_browser::read_browser_entries;
use crate::module_library::read_library_candidates;
use crate::module_relative_path::normalize_relative;
use crate::purl::Purl;
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of};
use crate::validate_requires::SourcedDocument;

/// `pkg:telo/local/<format>?path=…` — the bundled-controller delivery mode. Anything else
/// (`pkg:npm`, `pkg:cargo`) fetches from its own ecosystem and contributes no layer.
const BUNDLED_TYPE: &str = "telo";
const BUNDLED_NAMESPACE: &str = "local";

/// Qualifier naming extra files that belong in a controller's layer.
const SIBLINGS_QUALIFIER: &str = "siblings";

/// A module-relative file a manifest names. One variant per layer role: a controller layer is
/// one per selector and carries sibling patterns, and an assets layer is neither.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleFileClaim {
    Library {
        /// Module-root-relative POSIX path.
        path: String,
        /// The PURL, or `!<tag>` and the path of the value that carried the claim.
        origin: String,
        selector: ArtifactSelector,
        /// The bare specifier a consumer's bundle imports this entry point by.
        specifier: String,
        local_path: Option<String>,
    },
    Controller {
        path: String,
        origin: String,
        selector: ArtifactSelector,
        /// Extra payload patterns that belong in the same layer as this claim.
        siblings: Vec<String>,
        /// The source `path` was built from (`local_path=`), when the candidate names one.
        local_path: Option<String>,
    },
    Browser {
        path: String,
        origin: String,
        /// `format: esm` plus the entry's `abi`.
        selector: ArtifactSelector,
        /// The import-map key the entry is served under.
        specifier: String,
        local_path: Option<String>,
        /// Bare specifiers the host supplies.
        external: Vec<String>,
        /// The export names the built entry must have.
        exports: Vec<String>,
    },
    Assets {
        path: String,
        origin: String,
        /// The path may name a directory, claiming every file beneath it.
        directory: bool,
    },
}

impl ModuleFileClaim {
    pub fn path(&self) -> &str {
        match self {
            Self::Library { path, .. }
            | Self::Controller { path, .. }
            | Self::Browser { path, .. }
            | Self::Assets { path, .. } => path,
        }
    }

    pub fn origin(&self) -> &str {
        match self {
            Self::Library { origin, .. }
            | Self::Controller { origin, .. }
            | Self::Browser { origin, .. }
            | Self::Assets { origin, .. } => origin,
        }
    }

    /// The role's name, as Node's `claim.role`.
    pub fn role(&self) -> &'static str {
        match self {
            Self::Library { .. } => "library",
            Self::Controller { .. } => "controller",
            Self::Browser { .. } => "browser",
            Self::Assets { .. } => "assets",
        }
    }

    pub fn selector(&self) -> Option<&ArtifactSelector> {
        match self {
            Self::Library { selector, .. } | Self::Controller { selector, .. } | Self::Browser { selector, .. } => {
                Some(selector)
            }
            Self::Assets { .. } => None,
        }
    }
}

/// Bundled-controller claims from one document's `controllers:` list.
fn controller_claims(json: &Value) -> Result<Vec<ModuleFileClaim>, ArtifactSelectorError> {
    let mut claims = Vec::new();
    for candidate in json.get("controllers").and_then(Value::as_array).into_iter().flatten() {
        let Some(candidate) = candidate.as_str() else { continue };
        // Not a parseable PURL: claim collection is not the place to reject it.
        let Some(parsed) = Purl::parse(candidate) else { continue };
        if parsed.purl_type != BUNDLED_TYPE || parsed.namespace.as_deref() != Some(BUNDLED_NAMESPACE) {
            continue;
        }
        let Some(entry) = parsed.qualifiers.get("path").filter(|entry| !entry.is_empty()) else { continue };
        let local_path = parsed.qualifiers.get("local_path").filter(|path| !path.is_empty());
        claims.push(ModuleFileClaim::Controller {
            path: normalize_relative(entry),
            selector: selector_from_qualifiers(&parsed.name, &parsed.qualifiers, &format!("controller \"{candidate}\""))?,
            siblings: parsed
                .qualifiers
                .get(SIBLINGS_QUALIFIER)
                .map(String::as_str)
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_string)
                .collect(),
            local_path: local_path.map(|path| normalize_relative(path)),
            origin: candidate.to_string(),
        });
    }
    Ok(claims)
}

/// The library entry points one document's `exports.code:` block names.
fn library_claims(json: &Value) -> Vec<ModuleFileClaim> {
    read_library_candidates(json)
        .candidates
        .into_iter()
        .map(|candidate| ModuleFileClaim::Library {
            path: candidate.path,
            selector: candidate.selector,
            specifier: candidate.specifier,
            local_path: candidate.local_path.filter(|path| !path.is_empty()),
            origin: candidate.origin,
        })
        .collect()
}

/// The browser entries one document's `exports.browser:` block names.
fn browser_claims(json: &Value) -> Vec<ModuleFileClaim> {
    read_browser_entries(json)
        .entries
        .into_iter()
        .map(|entry| ModuleFileClaim::Browser {
            path: entry.path,
            selector: entry.selector,
            specifier: entry.specifier,
            local_path: entry.local_path.filter(|path| !path.is_empty()),
            external: entry.external,
            exports: entry.exports,
            origin: entry.origin,
        })
        .collect()
}

/// Claims contributed by tagged values, asked of the engine that owns each tag. The layer role
/// is assigned here, not by the engine: a file a tag embeds is read only when the resource
/// holding it is created, so `assets` — the lazily-fetched layer — is what it is.
fn tagged_claims(json: &Value, registry: &TemplatingEngineRegistry) -> Vec<ModuleFileClaim> {
    let mut claims = Vec::new();
    walk_cel_expressions(json, "", &mut |source, path, engine_name| {
        let Some(engine) = registry.get(engine_name) else { return };
        for claim in engine.file_claims(source) {
            claims.push(ModuleFileClaim::Assets {
                path: claim.path,
                origin: format!("!{engine_name} at '{path}'"),
                directory: claim.directory,
            });
        }
    });
    claims
}

/// Identity of a claim for de-duplication: the same file claimed twice by two resources is one
/// file in one layer. Role and selector are part of it because a file two controller
/// candidates both claim is genuinely copied into each of their layers.
fn claim_key(claim: &ModuleFileClaim) -> String {
    let selector = claim.selector().map(selector_key).unwrap_or_default();
    format!("{}\0{selector}\0{}", claim.role(), claim.path())
}

/// A claim, with the document that made it when the caller knows which.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocatedClaim {
    pub claim: ModuleFileClaim,
    /// `<kind>/<name>` of the declaring document.
    pub where_: Option<String>,
}

/// The claims one module's own documents make, out of an analysis set that also holds its
/// dependencies' documents. A document whose candidate selector cannot be read contributes
/// none — `validateModuleArtifact` reports it.
pub fn module_document_claims(
    documents: &[SourcedDocument],
    module_name: Option<&str>,
    registry: &TemplatingEngineRegistry,
) -> Vec<LocatedClaim> {
    let mut out = Vec::new();
    for document in documents {
        let manifest = document.manifest;
        let kind = kind_of(manifest).unwrap_or("undefined");
        let doc_module = match document.module {
            Some(module) => Some(module),
            None if is_module_document(kind) => name_of(manifest),
            None => None,
        };
        if doc_module != module_name {
            continue;
        }
        let Ok(claims) = collect_document_file_claims(&[manifest], registry) else { continue };
        let where_ = format!("{kind}/{}", name_of(manifest).unwrap_or("(unnamed)"));
        out.extend(claims.into_iter().map(|claim| LocatedClaim { claim, where_: Some(where_.clone()) }));
    }
    out
}

/// The same claims, from one module's already-parsed documents.
pub fn collect_document_file_claims(
    docs: &[&Value],
    registry: &TemplatingEngineRegistry,
) -> Result<Vec<ModuleFileClaim>, ArtifactSelectorError> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut claims = Vec::new();
    for json in docs {
        let mut found = library_claims(json);
        found.extend(browser_claims(json));
        found.extend(controller_claims(json)?);
        found.extend(tagged_claims(json, registry));
        for claim in found {
            if seen.insert(claim_key(&claim)) {
                claims.push(claim);
            }
        }
    }
    Ok(claims)
}

/// The registry the analysis reads claims through: every host shares it.
pub fn claim_registry() -> &'static TemplatingEngineRegistry {
    default_registry()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use telo_templating::{INCLUDE_BYTES_ENGINE, MODULE_PATH_ENGINE};

    fn tagged(engine: &str, source: &str) -> Value {
        // The sentinel the loader leaves for a tagged scalar.
        telo_templating::make_tagged_sentinel(engine, source)
    }

    #[test]
    fn collects_every_syntax_that_names_a_file_and_dedupes_within_a_document() {
        let doc = json!({
            "kind": "Telo.Definition",
            "controllers": [
                "pkg:telo/local/js?path=./nodejs/a.mjs&local_path=./nodejs/src/index.ts&siblings=*.wasm, x.txt#A",
                "pkg:telo/local/js?path=./nodejs/a.mjs#B",
                "pkg:npm/@telorun/sdk@1#x",
                "not a purl",
            ],
            "exports": {
                "code": [{ "specifier": "@a/b", "format": "js", "path": "./lib.mjs" }],
                "browser": [{ "specifier": "@a/ui", "path": "./ui.js" }],
            },
            "bytes": tagged(INCLUDE_BYTES_ENGINE, "data/x.bin"),
            "dir": tagged(MODULE_PATH_ENGINE, "static"),
        });
        let claims = collect_document_file_claims(&[&doc], claim_registry()).unwrap();
        let roles: Vec<_> = claims.iter().map(|c| (c.role(), c.path(), c.origin())).collect();
        assert_eq!(
            roles,
            [
                ("library", "lib.mjs", "exports.code[0] ('@a/b')"),
                ("browser", "ui.js", "exports.browser[0] ('@a/ui')"),
                (
                    "controller",
                    "nodejs/a.mjs",
                    "pkg:telo/local/js?path=./nodejs/a.mjs&local_path=./nodejs/src/index.ts&siblings=*.wasm, x.txt#A"
                ),
                ("assets", "data/x.bin", "!include-bytes at 'bytes'"),
                ("assets", "static", "!module-path at 'dir'"),
            ]
        );
        match &claims[2] {
            ModuleFileClaim::Controller { siblings, local_path, .. } => {
                assert_eq!(siblings, &["*.wasm", "x.txt"]);
                assert_eq!(local_path.as_deref(), Some("nodejs/src/index.ts"));
            }
            other => panic!("not a controller claim: {other:?}"),
        }
        assert!(matches!(&claims[4], ModuleFileClaim::Assets { directory: true, .. }));
    }

    #[test]
    fn a_document_whose_selector_cannot_be_read_contributes_none() {
        let bad = json!({ "kind": "Telo.Definition", "metadata": { "name": "A" }, "controllers": ["pkg:telo/local/js?path=a.mjs&abi=1"] });
        let good = json!({ "kind": "Telo.Definition", "metadata": { "name": "B" }, "controllers": ["pkg:telo/local/js?path=b.mjs"] });
        let documents = [
            SourcedDocument { manifest: &bad, module: Some("Demo"), source: "f" },
            SourcedDocument { manifest: &good, module: Some("Demo"), source: "f" },
        ];
        let claims = module_document_claims(&documents, Some("Demo"), claim_registry());
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].where_.as_deref(), Some("Telo.Definition/B"));
        assert!(module_document_claims(&documents, Some("Other"), claim_registry()).is_empty());
    }
}
