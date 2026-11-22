//! The rules that relate a module's `native:` entries, its file claims, its `assets:` patterns
//! and its `sources:` block — which files a source may stage, which declarations collide on
//! one path, and which staged entries nothing names. Mirrors
//! `../../nodejs/src/module-named-files.ts`.
//!
//! One home, because the check (`validate_native_entries`, `validate_source_entries`) and a
//! publish apply the same rules to the same manifest. Callers read the three blocks with their
//! own readers and hand the results in. No filesystem.
//!
//! `staged_module_files` is what a module-file existence pass reads: the paths a module's
//! `sources:` stages, which count as present without a copy on disk.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use telorun_glob::{last_match_index, select_by_patterns, SelectOptions};

use crate::artifact_selector::{describe_selector, PlatformAxis};
use crate::module_file_claims::{LocatedClaim, ModuleFileClaim};
use crate::native_entries::NativeEntry;
use crate::source_entries::{ModuleSource, SourceEntry};

/// The declaration behind a claim, for messages:
/// `the controller candidate pkg:… on Telo.Definition/Reader`.
pub fn describe_claim(located: &LocatedClaim) -> String {
    let label = match &located.claim {
        ModuleFileClaim::Controller { .. } => "the controller candidate",
        ModuleFileClaim::Library { .. } => "the exports.code entry",
        ModuleFileClaim::Browser { .. } => "the exports.browser entry",
        ModuleFileClaim::Assets { .. } => "the embed",
    };
    match &located.where_ {
        Some(where_) => format!("{label} {} on {where_}", located.claim.origin()),
        None => format!("{label} {}", located.claim.origin()),
    }
}

/// A `native:` entry whose path another declaration also names.
pub struct NativeClaimConflict<'a> {
    pub entry: &'a NativeEntry,
    pub claim: &'a LocatedClaim,
}

/// Every `native:` entry whose path the module also names as code or as an embed. Each
/// declaration decides a different layer, and a file extracts from exactly one.
pub fn native_claim_conflicts<'a>(
    native: &'a [NativeEntry],
    claims: &'a [LocatedClaim],
) -> Vec<NativeClaimConflict<'a>> {
    let mut out = Vec::new();
    for entry in native {
        for claim in claims {
            if claim.claim.path() == entry.path {
                out.push(NativeClaimConflict { entry, claim });
            }
        }
    }
    out
}

/// A file a `sources:` entry may stage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageableFile {
    pub path: String,
    /// The declaration naming it, for messages.
    pub label: String,
    /// The layer it ships in, for messages.
    pub layer: String,
    /// Produced by a controller build (`local_path=`) rather than staged or committed.
    pub built: bool,
}

/// The module doc's `assets:` patterns. The check and a publish both read the field here, so
/// they cannot disagree about which files it selects.
pub fn read_asset_patterns(owner: &Value) -> Vec<String> {
    owner
        .get("assets")
        .and_then(Value::as_array)
        .map(|assets| assets.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The module's `assets:` patterns and its `sources:` entries they may select.
pub struct StagedAssets<'a> {
    pub patterns: &'a [String],
    pub sources: &'a [ModuleSource],
}

/// The files the module names that a `sources:` entry may stage: every `native:` entry's path,
/// every bundled controller candidate's `path=` that carries a platform qualifier, and every
/// entry an `assets:` pattern selects. A platform-neutral candidate is one bundle for every
/// host, which nothing stages.
pub fn stageable_files(
    native: &[NativeEntry],
    claims: &[LocatedClaim],
    assets: Option<&StagedAssets>,
) -> HashMap<String, StageableFile> {
    let mut out: HashMap<String, StageableFile> = HashMap::new();
    for entry in native {
        if out.contains_key(&entry.path) {
            continue;
        }
        out.insert(
            entry.path.clone(),
            StageableFile {
                path: entry.path.clone(),
                label: format!("{} for {}", entry.origin, describe_selector(&entry.selector)),
                layer: format!("native {}", describe_selector(&entry.selector)),
                built: false,
            },
        );
    }
    for located in claims {
        let ModuleFileClaim::Controller { path, selector, local_path, origin, .. } = &located.claim else { continue };
        if !PlatformAxis::ALL.iter().any(|axis| selector.axes.get(*axis).is_some()) {
            continue;
        }
        if let Some(existing) = out.get_mut(path) {
            if local_path.is_some() && !existing.built {
                existing.built = true;
            }
            continue;
        }
        out.insert(
            path.clone(),
            StageableFile {
                path: path.clone(),
                label: format!("controller candidate {origin}"),
                layer: format!("controller {}", describe_selector(selector)),
                built: local_path.is_some(),
            },
        );
    }
    let patterns: &[String] = assets.map_or(&[], |assets| assets.patterns);
    let no_default_ignore = SelectOptions { apply_default_ignore: Some(false), exclude: Vec::new() };
    for source in assets.map_or(&[][..], |assets| assets.sources) {
        for entry in &source.entries {
            if out.contains_key(entry.path()) {
                continue;
            }
            if select_by_patterns(&[entry.path().to_string()], patterns, &no_default_ignore).is_empty() {
                continue;
            }
            let matched = last_match_index(entry.path(), patterns).map(|index| patterns[index].as_str());
            out.insert(
                entry.path().to_string(),
                StageableFile {
                    path: entry.path().to_string(),
                    label: format!("assets: pattern '{}'", matched.unwrap_or("undefined")),
                    layer: "assets".into(),
                    built: false,
                },
            );
        }
    }
    out
}

/// The module files a `sources:` entry stages — one an `assets:` pattern selects, or a notice —
/// classified as the kernel's module-file resolution classifies them: a `native:` path is the
/// native layer's, whatever pattern also selects it. These are what a `!module-path` may name
/// without a copy on disk.
pub fn staged_module_files(native: &[NativeEntry], assets: &StagedAssets) -> Vec<String> {
    let stageable = stageable_files(native, &[], Some(assets));
    assets
        .sources
        .iter()
        .flat_map(|source| {
            let stageable = &stageable;
            source
                .entries
                .iter()
                .filter(move |entry| {
                    stageable.get(entry.path()).is_some_and(|file| file.layer == "assets")
                        || source.notices.iter().any(|notice| notice == entry.path())
                })
                .map(|entry| entry.path().to_string())
        })
        .collect()
}

/// The paths at `location` or beneath it — a `!module-path` names a file or a directory.
pub fn paths_at_or_beneath(paths: &[String], location: &str) -> Vec<String> {
    let beneath = format!("{location}/");
    paths.iter().filter(|path| *path == location || path.starts_with(&beneath)).cloned().collect()
}

/// A `sources:` entry, with the source declaring it.
pub struct LocatedSourceEntry<'a> {
    pub source: &'a ModuleSource,
    pub entry: &'a SourceEntry,
}

/// The staged entries nothing in the module names: not a stageable file, and not one of the
/// entry's own source's notices. `also_named` holds paths the caller knows are named though
/// they did not read — a `native:` entry with an unrelated problem — so one defect is not
/// reported twice.
pub fn unclaimed_source_entries<'a>(
    sources: &'a [ModuleSource],
    stageable: &HashMap<String, StageableFile>,
    also_named: &HashSet<String>,
) -> Vec<LocatedSourceEntry<'a>> {
    let mut out = Vec::new();
    for source in sources {
        for entry in &source.entries {
            if stageable.contains_key(entry.path()) || source.notices.iter().any(|notice| notice == entry.path()) {
                continue;
            }
            if also_named.contains(entry.path()) {
                continue;
            }
            out.push(LocatedSourceEntry { source, entry });
        }
    }
    out
}

/// A link whose target ships in a different layer than the link.
pub struct CrossLayerLink<'a> {
    pub source: &'a ModuleSource,
    pub entry: &'a SourceEntry,
    /// The link's resolved target path.
    pub resolved: &'a str,
    pub layer: String,
    pub target_layer: String,
}

/// The link entries whose target ships in another layer. A runtime extracts only the layers it
/// needs, so such a link dangles wherever the other layer is not materialized. A notice ships
/// in `common`.
pub fn cross_layer_source_links<'a>(
    sources: &'a [ModuleSource],
    stageable: &HashMap<String, StageableFile>,
) -> Vec<CrossLayerLink<'a>> {
    let layer_of = |source: &ModuleSource, path: &str| -> Option<String> {
        stageable
            .get(path)
            .map(|file| file.layer.clone())
            .or_else(|| source.notices.iter().any(|notice| notice == path).then(|| "common".to_string()))
    };
    let mut out = Vec::new();
    for source in sources {
        for entry in &source.entries {
            let SourceEntry::Link { path, resolved, .. } = entry else { continue };
            let (Some(layer), Some(target_layer)) = (layer_of(source, path), layer_of(source, resolved)) else {
                continue;
            };
            if layer != target_layer {
                out.push(CrossLayerLink { source, entry, resolved, layer, target_layer });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_selector::{ArtifactSelector, AxisValues};
    use serde_json::json;

    fn native(path: &str) -> NativeEntry {
        let mut axes = AxisValues::default();
        axes.set(PlatformAxis::Os, Some("linux".into()));
        NativeEntry {
            name: "addon".into(),
            selector: ArtifactSelector { format: "napi".into(), axes },
            path: path.into(),
            index: 0,
            origin: "native[0] ('addon')".into(),
        }
    }

    fn source(entries: Value, notices: Value) -> ModuleSource {
        let owner = json!({ "sources": { "s": {
            "version": "1", "purl": "pkg:generic/s", "url": "https://e.test/x.tgz", "archive": "tar.gz",
            "notices": notices, "entries": entries,
        } } });
        let read = crate::source_entries::read_module_sources(&owner);
        assert_eq!(read.problems, []);
        read.sources.into_iter().next().unwrap()
    }

    #[test]
    fn stages_native_paths_and_asset_selections_and_names_the_unclaimed() {
        let file = |name: &str| json!({ "upstream": "u", "member": name });
        let source = source(
            json!({ "native/a.node": file("a"), "data/b.bin": file("b"), "data/c.bin": file("c"), "link.node": { "target": "native/a.node" } }),
            json!(["NOTICE"]),
        );
        let sources = [source];
        let patterns = ["data/b.bin".to_string()];
        let stageable = stageable_files(
            &[native("native/a.node")],
            &[],
            Some(&StagedAssets { patterns: &patterns, sources: &sources }),
        );
        assert_eq!(stageable["native/a.node"].layer, "native napi (linux)");
        assert_eq!(stageable["data/b.bin"].label, "assets: pattern 'data/b.bin'");
        let unclaimed: Vec<_> =
            unclaimed_source_entries(&sources, &stageable, &HashSet::new()).iter().map(|u| u.entry.path().to_string()).collect();
        assert_eq!(unclaimed, ["data/c.bin", "link.node"]);
        let links = cross_layer_source_links(&sources, &stageable);
        assert!(links.is_empty(), "link.node is unstageable, so no layer to compare");
        let staged = staged_module_files(
            &[native("native/a.node")],
            &StagedAssets { patterns: &patterns, sources: &sources },
        );
        assert_eq!(staged, ["data/b.bin"]);
        assert_eq!(paths_at_or_beneath(&["data/b.bin".into(), "database".into()], "data"), ["data/b.bin"]);
    }
}
