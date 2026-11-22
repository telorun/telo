//! File-claim diagnostics for the entry and every module it reaches through a filesystem-path
//! import or an `http(s)://` import, transitively. Mirrors `../../nodejs/src/module-file-existence.ts`.
//!
//! A registry import is skipped: its files were verified when it was published, and its assets
//! layer is fetched lazily, so asking the disk would be wrong. A path import is never published
//! on its own — this is the only point at which anything checks its files before a resource
//! embedding one is created. A module read over HTTP has no publish step either, so its files are
//! asked of its origin (no Rust host reads one yet; the rule is kept whole).
//!
//! What a claim names needs a filesystem, which the analyzer never touches, so the question is
//! put to the module's own [`ManifestSource`] (`entry_at`); a source that cannot answer reports
//! nothing rather than guessing. Node asks first whether the source has `entryAt` at all; here a
//! source's answerability is learnt from its first answer, so every claim asks it — a path a
//! module's `sources:` stages is still present whatever the disk says.

use std::collections::{HashSet, VecDeque};

use serde_json::{Map, Value};
use telo_templating::tagged_sentinel_parts;
use telorun_sdk_core::value_type::host_media_head_length;

use crate::loaded_types::{LoadedFile, LoadedGraph, LoadedModule};
use crate::manifest_loader::is_local_path_source;
use crate::module_file_claims::claim_registry;
use crate::module_named_files::{paths_at_or_beneath, read_asset_patterns, staged_module_files, StagedAssets};
use crate::native_entries::read_native_entries;
use crate::nearest_name::nearest_name;
use crate::need_type::need_parameters;
use crate::source_entries::read_module_sources;
use crate::sources::http_source::http_manifest_url;
use crate::sources::oci_ref::is_oci_ref;
use crate::system_kinds::is_module_document;
use crate::types::{
    kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticFix, DiagnosticResource, DiagnosticSeverity,
    HostEntryKind, LoadError, ManifestSource, ANALYZER_SOURCE,
};
use crate::validate_include_placement::is_never_instantiated;

/// The key the loader stamps on a tagged value whose one file claim names something: what it
/// found there, `file` or `directory` — what analysis holds the value to where its slot says
/// what the path must name. Absent when the source cannot answer.
pub const FOUND_ENTRY: &str = "foundEntry";

/// The key the loader stamps beside [`FOUND_ENTRY`] on a tagged value whose one file claim names
/// a file, when its source can read it: the file's leading bytes as lower-case hex, as many as
/// decide every media type.
pub const FOUND_HEAD: &str = "foundHead";

/// What the loader found at a tagged value's one file claim, when it stamped it.
pub fn found_entry_of(value: &Value) -> Option<HostEntryKind> {
    tagged_sentinel_parts(value)?;
    value.get(FOUND_ENTRY).and_then(Value::as_str).and_then(HostEntryKind::from_token)
}

/// The leading bytes the loader read at a tagged value's one file claim, when it stamped them.
/// A pair that is not hex reads as 0, as `parseInt` leaves it.
pub fn found_head_of(value: &Value) -> Option<Vec<u8>> {
    tagged_sentinel_parts(value)?;
    let hex = value.get(FOUND_HEAD)?.as_str()?;
    Some(
        (0..hex.len() / 2)
            .map(|i| hex.get(i * 2..i * 2 + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()).unwrap_or(0))
            .collect(),
    )
}

/// The module-file diagnostics of every module `graph` reaches from its entry through path and
/// http(s) imports, each claim's stamps written on its tagged value. `source_for` is the source
/// reading a location — the first one supporting it. A listing that fails is the load's error.
pub fn collect_local_module_file_diagnostics<'s>(
    graph: &mut LoadedGraph,
    source_for: &dyn Fn(&str) -> Option<&'s dyn ManifestSource>,
) -> Result<Vec<AnalysisDiagnostic>, LoadError> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([graph.root_source.clone()]);
    let mut queue: VecDeque<String> = VecDeque::from([graph.root_source.clone()]);
    while let Some(next) = queue.pop_front() {
        let Some(module) = graph.modules.get_mut(&next) else { continue };
        let remote = http_manifest_url(&module.owner.requested_url);
        let base = remote.unwrap_or_else(|| module.owner.source.clone());
        out.extend(collect_module_file_diagnostics(module, source_for(&base), &base)?);
        let module = &graph.modules[&next];
        for file in module.files() {
            for edge in graph.import_edges.get(&file.source).into_iter().flat_map(|edges| edges.values()) {
                if seen.contains(&edge.target_source) {
                    continue;
                }
                let Some(target) = graph.modules.get(&edge.target_source) else { continue };
                // A path import inside an artifact names a module shipped in it, whose files are
                // its layers — published, verified, and fetched lazily.
                let local = is_local_path_source(&edge.target_ref) && !is_oci_ref(&target.owner.requested_url);
                if !local && http_manifest_url(&target.owner.requested_url).is_none() {
                    continue;
                }
                seen.insert(edge.target_source.clone());
                queue.push_back(edge.target_source.clone());
            }
        }
    }
    Ok(out)
}

/// One step from a value to a member of it.
#[derive(Clone, Debug)]
enum Segment {
    Key(String),
    Index(usize),
}

/// One file claim of a tagged value, where it is written.
struct Found {
    index: usize,
    at: String,
    segments: Vec<Segment>,
    engine: String,
    written: String,
    claims: usize,
    relative: String,
    code: &'static str,
    directory: bool,
}

/// What a claim's directory says about it.
struct Hint {
    text: String,
    replacement: Option<String>,
}

/// One diagnostic for every tagged value in `module` whose file claim names nothing — the
/// static half of the kernel's refusal at resource creation; each engine declares its claims and
/// the code reporting a missing one, so no tag is recognised here by name. Well-formedness is the
/// engine's own diagnostic; a malformed path claims nothing. A value with exactly one claim that
/// names something is stamped with what it names ([`FOUND_ENTRY`]) and, for a file its source can
/// read, its leading bytes ([`FOUND_HEAD`]).
///
/// A path a module file the module's own `sources:` block stages is present at — a file when it
/// is one, a directory when it sits above one: the kernel stages it on first use, so a fresh
/// checkout has no copy yet.
pub fn collect_module_file_diagnostics(
    module: &mut LoadedModule,
    source: Option<&dyn ManifestSource>,
    base: &str,
) -> Result<Vec<AnalysisDiagnostic>, LoadError> {
    let Some(source) = source else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    let mut staged: Option<Vec<String>> = None;
    for file_index in 0..=module.partials.len() {
        let found = collect_claims(file_at(module, file_index));
        let mut stamps: Vec<(usize, Vec<Segment>, HostEntryKind, Option<Vec<u8>>)> = Vec::new();
        for claim in found {
            let staged = staged.get_or_insert_with(|| staged_files_of(module.owner.module_document()));
            let file = file_at(module, file_index);
            let manifest = file.manifests[claim.index].as_ref().expect("a claim's document");
            let kind = kind_of(manifest).unwrap_or("undefined");
            let name = name_of(manifest).filter(|name| !name.is_empty());
            let subject = match name {
                Some(name) => format!("{kind}/{name}"),
                None => kind.to_string(),
            };
            let resource = DiagnosticResource { kind: kind.to_string(), name: name.unwrap_or_default().to_string() };
            let range = file.positions.get(claim.index).and_then(|p| p.position_index.get(&claim.at)).copied();
            let absolute = source.locate(base, &claim.relative);
            let remote = absolute.as_deref().is_some_and(|a| a.starts_with("http://") || a.starts_with("https://"));
            let Some(answered) = source.entry_at(base, &claim.relative) else { return Ok(Vec::new()) };
            let looked_up = match staged_entry(staged, &claim.relative) {
                Some(entry) => Ok(Some(entry)),
                None => answered,
            };
            let read = looked_up.and_then(|entry| {
                let head = match entry {
                    Some(HostEntryKind::File) if claim.claims == 1 && host_media_head_length() > 0 => {
                        source.read_head(base, &claim.relative, host_media_head_length()).transpose()?.flatten()
                    }
                    _ => None,
                };
                Ok((entry, head))
            });
            let (entry, head) = match read {
                Ok(read) => read,
                Err(error) => {
                    let at_place = absolute.as_ref().map(|a| format!(" ({a})")).unwrap_or_default();
                    let mut diagnostic = AnalysisDiagnostic::error(
                        "MODULE_FILE_UNREADABLE",
                        format!(
                            "{subject}: `!{} {}` names '{}', and checking it failed{at_place}: {error}",
                            claim.engine, claim.written, claim.relative
                        ),
                        DiagnosticData {
                            resource: Some(resource),
                            file_path: Some(file.source.clone()),
                            path: Some(claim.at.clone()),
                            ..Default::default()
                        },
                    );
                    diagnostic.range = range;
                    out.push(diagnostic);
                    continue;
                }
            };
            if let Some(entry) = entry {
                if claim.claims == 1 {
                    stamps.push((claim.index, claim.segments, entry, head));
                }
                continue;
            }
            let hint = near_miss(source, base, &claim.relative, &claim.written)?;
            // A URL cannot be listed, so a claim that may name a directory cannot be told from a
            // missing file there: it is advice, and the runtime still refuses it.
            let unverifiable = remote && claim.directory;
            let mut message = format!(
                "{subject}: `!{} {}` names '{}', and there is nothing there{}.",
                claim.engine,
                claim.written,
                claim.relative,
                absolute.as_ref().map(|a| format!(" ({a})")).unwrap_or_default()
            );
            if let Some(hint) = &hint {
                message.push(' ');
                message.push_str(&hint.text);
            }
            message.push_str(" The path is relative to the module root — the directory holding telo.yaml. ");
            if remote {
                message.push_str("A module read over a URL ships the files it names one by one — a directory cannot be listed");
                if unverifiable {
                    message.push_str(", so this cannot be told from a missing file and will not be fetched");
                }
                message.push_str("; claim the files inside it individually. ");
            }
            message.push_str(
                "Create it or correct the path; if it exists in your checkout, whatever copied the module here left it out (an ignore file, a COPY step).",
            );
            out.push(AnalysisDiagnostic {
                range,
                severity: Some(if unverifiable { DiagnosticSeverity::Warning } else { DiagnosticSeverity::Error }),
                code: Some(claim.code.to_string()),
                source: Some(ANALYZER_SOURCE.to_string()),
                message,
                tags: None,
                data: Some(DiagnosticData {
                    resource: Some(resource),
                    file_path: Some(file.source.clone()),
                    path: Some(claim.at),
                    fix: hint.and_then(|hint| hint.replacement).map(|replacement| DiagnosticFix { replacement, tag: None }),
                    ..Default::default()
                }),
            });
        }
        let file = file_at_mut(module, file_index);
        for (index, segments, entry, head) in stamps {
            let Some(Value::Object(sentinel)) = file.manifests[index].as_mut().and_then(|doc| member_mut(doc, &segments))
            else {
                continue;
            };
            sentinel.insert(FOUND_ENTRY.to_string(), Value::String(entry.as_str().to_string()));
            if let Some(head) = head {
                sentinel.insert(FOUND_HEAD.to_string(), Value::String(head.iter().map(|b| format!("{b:02x}")).collect()));
            }
        }
    }
    Ok(out)
}

fn file_at(module: &LoadedModule, index: usize) -> &LoadedFile {
    if index == 0 {
        &module.owner
    } else {
        &module.partials[index - 1]
    }
}

fn file_at_mut(module: &mut LoadedModule, index: usize) -> &mut LoadedFile {
    if index == 0 {
        &mut module.owner
    } else {
        &mut module.partials[index - 1]
    }
}

fn member_mut<'v>(value: &'v mut Value, segments: &[Segment]) -> Option<&'v mut Value> {
    segments.iter().try_fold(value, |value, segment| match segment {
        Segment::Key(key) => value.as_object_mut()?.get_mut(key),
        Segment::Index(index) => value.as_array_mut()?.get_mut(*index),
    })
}

/// Every file claim of every tagged value in `file`: a module document's needs' `parameters:` —
/// resolved at load — and every document that is instantiated. Nothing else in a document never
/// instantiated is resolved, so the engine's `*_OUTSIDE_RESOURCE` is the finding there.
fn collect_claims(file: &LoadedFile) -> Vec<Found> {
    let registry = claim_registry();
    let mut found = Vec::new();
    for (index, manifest) in file.manifests.iter().enumerate() {
        let Some(manifest) = manifest else { continue };
        let mut collect = |engine: &str, written: &str, at: &str, segments: &[Segment]| {
            let claims = registry.get(engine).map(|engine| engine.file_claims(written)).unwrap_or_default();
            let count = claims.len();
            for claim in claims {
                found.push(Found {
                    index,
                    at: at.to_string(),
                    segments: segments.to_vec(),
                    engine: engine.to_string(),
                    written: written.to_string(),
                    claims: count,
                    relative: claim.path,
                    code: claim.not_found_code,
                    directory: claim.directory,
                });
            }
        };
        let kind = kind_of(manifest);
        if kind.is_some_and(is_module_document) {
            for (name, parameters) in need_parameters(manifest) {
                let segments = vec![
                    Segment::Key("needs".to_string()),
                    Segment::Key(name.to_string()),
                    Segment::Key("parameters".to_string()),
                ];
                walk_sentinels(parameters, &format!("needs.{name}.parameters"), segments, &mut collect);
            }
            continue;
        }
        if kind.is_some_and(is_never_instantiated) {
            continue;
        }
        walk_sentinels(manifest, "", Vec::new(), &mut collect);
    }
    found
}

/// Every tagged value beneath `value`, depth first in written order, with its dotted path and
/// the steps reaching it. A compiled expression is opaque.
fn walk_sentinels(
    value: &Value,
    path: &str,
    segments: Vec<Segment>,
    callback: &mut dyn FnMut(&str, &str, &str, &[Segment]),
) {
    let mut work: Vec<(&Value, String, Vec<Segment>)> = vec![(value, path.to_string(), segments)];
    while let Some((value, path, segments)) = work.pop() {
        if let Some((engine, source)) = tagged_sentinel_parts(value) {
            callback(engine, source, &path, &segments);
            continue;
        }
        match value {
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate().rev() {
                    let mut steps = segments.clone();
                    steps.push(Segment::Index(i));
                    work.push((item, format!("{path}[{i}]"), steps));
                }
            }
            Value::Object(members) if !is_compiled(members) => {
                for (key, member) in members.iter().rev() {
                    let mut steps = segments.clone();
                    steps.push(Segment::Key(key.clone()));
                    let at = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    work.push((member, at, steps));
                }
            }
            _ => {}
        }
    }
}

/// Whether the object carries a truthy `__compiled`, as JavaScript reads it.
fn is_compiled(members: &Map<String, Value>) -> bool {
    match members.get("__compiled") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|held| held != 0.0 && !held.is_nan()),
        Some(_) => true,
    }
}

/// What `relative` names among the files a module's `sources:` stages: one of them is a file, a
/// path above one a directory.
fn staged_entry(staged: &[String], relative: &str) -> Option<HostEntryKind> {
    let beneath = paths_at_or_beneath(staged, relative);
    if beneath.is_empty() {
        return None;
    }
    let own = relative.strip_prefix("./").unwrap_or(relative);
    Some(if beneath.iter().any(|path| path == own) { HostEntryKind::File } else { HostEntryKind::Directory })
}

/// What the directory the claim points into says about it: that the directory itself is
/// missing, or the one entry a typo most plausibly meant — offered as a fix replacing the path,
/// kept in the author's `./` spelling. Nothing when the source cannot list, or no entry is close
/// enough to name.
fn near_miss(
    source: &dyn ManifestSource,
    base: &str,
    relative: &str,
    written: &str,
) -> Result<Option<Hint>, LoadError> {
    let slash = relative.rfind('/');
    let directory = slash.map_or("", |slash| &relative[..slash]);
    let Some(listing) = source.list_directory(base, if directory.is_empty() { "." } else { directory }) else {
        return Ok(None);
    };
    let Some(entries) = listing? else {
        return Ok(Some(Hint { text: format!("The directory '{directory}/' does not exist."), replacement: None }));
    };
    let file_name = slash.map_or(relative, |slash| &relative[slash + 1..]);
    let Some(meant) = nearest_name(file_name, entries.iter().map(String::as_str)) else { return Ok(None) };
    let path = if directory.is_empty() { meant.to_string() } else { format!("{directory}/{meant}") };
    let replacement = if written.trim().starts_with("./") { format!("./{path}") } else { path };
    Ok(Some(Hint { text: format!("Did you mean '{replacement}'?"), replacement: Some(replacement) }))
}

/// None while the `sources:` block does not read, since the kernel then resolves nothing either.
fn staged_files_of(owner: Option<&Value>) -> Vec<String> {
    let Some(owner) = owner else { return Vec::new() };
    let sources = read_module_sources(owner);
    if !sources.problems.is_empty() {
        return Vec::new();
    }
    staged_module_files(
        &read_native_entries(owner).entries,
        &StagedAssets { patterns: &read_asset_patterns(owner), sources: &sources.sources },
    )
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    use serde_json::json;

    use super::*;
    use crate::types::{DiagnosticSeverity, ReadManifest};
    use crate::{load_graph, ManifestLoader};

    /// Manifests by path, plus the paths that exist, so the existence question is answered
    /// without a filesystem; `listing` holds the directories a source can list.
    struct Disk {
        files: HashMap<String, String>,
        present: Vec<String>,
        answers: bool,
        listing: Option<HashMap<String, Vec<String>>>,
        heads: HashMap<String, Vec<u8>>,
        failing: HashSet<String>,
        asked: RefCell<Vec<String>>,
    }

    impl Disk {
        fn new(files: &[(&str, &str)], present: &[&str]) -> Self {
            Disk {
                files: files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect(),
                present: present.iter().map(|p| p.to_string()).collect(),
                answers: true,
                listing: None,
                heads: HashMap::new(),
                failing: HashSet::new(),
                asked: RefCell::new(Vec::new()),
            }
        }

        fn at(base: &str, relative: &str) -> String {
            format!("{}{relative}", &base[..base.rfind('/').unwrap() + 1])
        }
    }

    impl ManifestSource for Disk {
        fn supports(&self, _: &str) -> bool {
            true
        }

        fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
            let text = self.files.get(path).ok_or_else(|| LoadError::Failed(format!("File not found: {path}")))?;
            Ok(ReadManifest { text: text.clone(), source: path.to_string() })
        }

        fn resolve_relative(&self, base: &str, relative: &str) -> Result<String, LoadError> {
            Ok(Disk::at(base, relative.strip_prefix("./").unwrap_or(relative)))
        }

        fn entry_at(&self, base: &str, relative: &str) -> Option<Result<Option<HostEntryKind>, LoadError>> {
            if !self.answers {
                return None;
            }
            let path = Disk::at(base, relative);
            self.asked.borrow_mut().push(path.clone());
            if self.failing.contains(&path) {
                return Some(Err(LoadError::Failed(format!("EACCES: permission denied, stat '{path}'"))));
            }
            Some(Ok(if self.present.contains(&path) {
                Some(HostEntryKind::File)
            } else if self.present.iter().any(|p| p.starts_with(&format!("{path}/"))) {
                Some(HostEntryKind::Directory)
            } else {
                None
            }))
        }

        fn read_head(&self, base: &str, relative: &str, length: usize) -> Option<Result<Option<Vec<u8>>, LoadError>> {
            let path = Disk::at(base, relative);
            Some(Ok(self.heads.get(&path).map(|head| head.iter().copied().take(length).collect())))
        }

        fn locate(&self, base: &str, relative: &str) -> Option<String> {
            Some(Disk::at(base, relative))
        }

        fn list_directory(&self, base: &str, relative: &str) -> Option<Result<Option<Vec<String>>, LoadError>> {
            let listing = self.listing.as_ref()?;
            Some(Ok(listing.get(&Disk::at(base, relative)).cloned()))
        }
    }

    const APP: &str = "kind: Telo.Application\nmetadata: { name: App, version: 1.0.0 }\ninclude: [./part.yaml]\n---\nkind: Acme.Static\nmetadata: { name: site }\nroot: !module-path ./public\n";
    const PART: &str = "kind: Acme.Static\nmetadata: { name: assets }\nroot: !module-path ./assets\n";

    fn graph_of(disk: Disk, entry: &str) -> crate::LoadedGraph {
        load_graph(&ManifestLoader::new(vec![Box::new(disk)]), entry).expect("graph loads")
    }

    fn places(graph: &crate::LoadedGraph) -> Vec<(String, String, String)> {
        graph
            .module_file_diagnostics
            .iter()
            .map(|d| {
                let data = d.data.as_ref().unwrap();
                (d.code.clone().unwrap(), data.path.clone().unwrap(), data.file_path.clone().unwrap())
            })
            .collect()
    }

    #[test]
    fn reports_a_module_path_naming_nothing_resolved_against_the_owner_even_from_a_partial() {
        let graph = graph_of(
            Disk::new(&[("/app/telo.yaml", APP), ("/app/part.yaml", PART)], &["/app/public/index.html"]),
            "/app/telo.yaml",
        );
        assert_eq!(
            places(&graph),
            [("MODULE_PATH_NOT_FOUND".to_string(), "root".to_string(), "/app/part.yaml".to_string())]
        );
    }

    #[test]
    fn reports_nothing_when_the_source_cannot_say_what_exists() {
        let mut disk = Disk::new(&[("/app/telo.yaml", APP), ("/app/part.yaml", PART)], &[]);
        disk.answers = false;
        assert!(graph_of(disk, "/app/telo.yaml").module_file_diagnostics.is_empty());
    }

    #[test]
    fn stamps_what_one_claim_found_and_the_head_of_a_file() {
        let app = "kind: Telo.Application\nmetadata: { name: App }\nneeds:\n  shell: { kind: Telo.DesktopHost, parameters: { icon: !module-path ./icon.png } }\n---\nkind: Acme.Static\nmetadata: { name: site }\nroot: !module-path ./public\nlogo: !module-path ./icon.png\n";
        let mut disk = Disk::new(&[("/app/telo.yaml", app)], &["/app/public/index.html", "/app/icon.png"]);
        disk.heads.insert("/app/icon.png".to_string(), vec![0x89, b'P', b'N', b'G']);
        let graph = graph_of(disk, "/app/telo.yaml");
        assert!(graph.module_file_diagnostics.is_empty());
        let docs = &graph.entry().owner.manifests;
        let icon = &docs[0].as_ref().unwrap()["needs"]["shell"]["parameters"]["icon"];
        assert_eq!(icon[FOUND_ENTRY], json!("file"));
        assert_eq!(icon[FOUND_HEAD], json!("89504e47"));
        assert_eq!(found_entry_of(icon), Some(HostEntryKind::File));
        assert_eq!(found_head_of(icon), Some(vec![0x89, b'P', b'N', b'G']));
        let site = docs[1].as_ref().unwrap();
        assert_eq!(found_entry_of(&site["root"]), Some(HostEntryKind::Directory));
        assert_eq!(site["root"].get(FOUND_HEAD), None);
    }

    fn staging(paths: &[&str], sources_extra: &str) -> String {
        let pin = format!("sha256: {}, executable: false", "a".repeat(64));
        let mut text = format!(
            "kind: Telo.Library\nmetadata: {{ name: Lib, version: 1.0.0 }}\nassets: [./models/]\nnative:\n  - {{ name: engine, format: napi, os: linux, arch: amd64, path: ./native/engine.node }}\nsources:\n  models:\n    version: 1.0.0\n    purl: pkg:npm/%40acme/models\n    url: https://example.com/{{upstream}}-{{version}}.tgz\n    archive: tar.gz\n    notices: [./notices/models.LICENSE]\n    entries:\n      ./models/eng.bin: {{ upstream: eng, member: package/eng.bin, {pin} }}\n      ./notices/models.LICENSE: {{ upstream: eng, member: package/LICENSE, {pin} }}\n      ./native/engine.node: {{ upstream: engine, member: build/engine.node, {pin} }}\n{sources_extra}"
        );
        for (i, path) in paths.iter().enumerate() {
            text.push_str(&format!("---\nkind: Acme.Static\nmetadata: {{ name: site{i} }}\nroot: !module-path {path}\n"));
        }
        text
    }

    fn not_found(paths: &[&str], sources_extra: &str) -> Vec<String> {
        let text = staging(paths, sources_extra);
        graph_of(Disk::new(&[("/lib/telo.yaml", &text)], &[]), "/lib/telo.yaml")
            .module_file_diagnostics
            .iter()
            .map(|d| d.data.as_ref().unwrap().resource.as_ref().unwrap().name.clone())
            .collect()
    }

    #[test]
    fn counts_what_a_sources_block_stages_as_present() {
        assert!(not_found(&["./models/eng.bin"], "").is_empty());
        assert!(not_found(&["./notices/models.LICENSE"], "").is_empty());
        assert!(not_found(&["./models"], "").is_empty());
        assert_eq!(not_found(&["./models/deu.bin", "./mod", "./native/engine.node"], ""), ["site0", "site1", "site2"]);
        assert_eq!(not_found(&["./models/eng.bin"], "  Broken: { version: 1.0.0 }\n"), ["site0"]);
    }

    fn importing(source: &str) -> String {
        format!("kind: Telo.Application\nmetadata: {{ name: App, version: 1.0.0 }}\nimports: {{ Chat: {source} }}\n")
    }

    fn with_prompt(path: &str) -> String {
        format!("kind: Telo.Library\nmetadata: {{ name: Chat, version: 1.0.0 }}\n---\nkind: Acme.Agent\nmetadata: {{ name: author }}\nsystem: !include-text {path}\n")
    }

    #[test]
    fn reports_an_embed_in_a_path_imported_library_against_its_own_root_and_skips_a_registry_one() {
        let (app, chat) = (importing("./chat/telo.yaml"), with_prompt("./primer.md"));
        let graph = graph_of(Disk::new(&[("/app/telo.yaml", &app), ("/app/chat/telo.yaml", &chat)], &[]), "/app/telo.yaml");
        assert_eq!(
            places(&graph),
            [("INCLUDE_FILE_NOT_FOUND".to_string(), "system".to_string(), "/app/chat/telo.yaml".to_string())]
        );
        let present = graph_of(
            Disk::new(&[("/app/telo.yaml", &app), ("/app/chat/telo.yaml", &chat)], &["/app/chat/primer.md"]),
            "/app/telo.yaml",
        );
        assert!(present.module_file_diagnostics.is_empty());
        let registry = importing("oci://registry.example/chat@1.0.0");
        let graph = graph_of(
            Disk::new(&[("/app/telo.yaml", &registry), ("oci://registry.example/chat@1.0.0", &chat)], &[]),
            "/app/telo.yaml",
        );
        assert!(graph.errors.is_empty());
        assert!(graph.module_file_diagnostics.is_empty());
    }

    #[test]
    fn locates_a_claim_its_source_could_not_answer_for() {
        let embed = "kind: Telo.Application\nmetadata: { name: App }\n---\nkind: Acme.Agent\nmetadata: { name: author }\nsystem: !include-text ./primer.md\n";
        let mut disk = Disk::new(&[("/app/telo.yaml", embed)], &[]);
        disk.failing.insert("/app/primer.md".to_string());
        let graph = graph_of(disk, "/app/telo.yaml");
        let [d] = graph.module_file_diagnostics.as_slice() else { panic!("one finding") };
        assert_eq!(d.code.as_deref(), Some("MODULE_FILE_UNREADABLE"));
        assert_eq!(
            d.message,
            "Acme.Agent/author: `!include-text ./primer.md` names 'primer.md', and checking it failed (/app/primer.md): EACCES: permission denied, stat '/app/primer.md'"
        );
    }

    fn report(listing: Option<HashMap<String, Vec<String>>>) -> (String, Option<String>, Option<DiagnosticSeverity>) {
        let embed = "kind: Telo.Application\nmetadata: { name: App, version: 1.0.0 }\n---\nkind: Acme.Agent\nmetadata: { name: author }\nsystem: !include-text ./prompts/primer.md\n";
        let mut disk = Disk::new(&[("/app/telo.yaml", embed)], &[]);
        disk.listing = listing;
        let graph = graph_of(disk, "/app/telo.yaml");
        let d = &graph.module_file_diagnostics[0];
        (d.message.clone(), d.data.as_ref().unwrap().fix.as_ref().map(|fix| fix.replacement.clone()), d.severity)
    }

    fn dirs(entries: &[&str]) -> Option<HashMap<String, Vec<String>>> {
        Some(HashMap::from([("/app/prompts".to_string(), entries.iter().map(|e| e.to_string()).collect())]))
    }

    #[test]
    fn says_what_a_missing_file_s_directory_holds() {
        let (message, fix, severity) = report(dirs(&[]));
        assert_eq!(
            message,
            "Acme.Agent/author: `!include-text ./prompts/primer.md` names 'prompts/primer.md', and there is nothing there (/app/prompts/primer.md). The path is relative to the module root — the directory holding telo.yaml. Create it or correct the path; if it exists in your checkout, whatever copied the module here left it out (an ignore file, a COPY step)."
        );
        assert_eq!((fix, severity), (None, Some(DiagnosticSeverity::Error)));
        let (message, fix, _) = report(dirs(&["primr.md", "system.md"]));
        assert!(message.contains("(/app/prompts/primer.md). Did you mean './prompts/primr.md'? The path"), "{message}");
        assert_eq!(fix.as_deref(), Some("./prompts/primr.md"));
        let (message, fix, _) = report(dirs(&["primr.md", "priner.md"]));
        assert!(!message.contains("Did you mean"));
        assert_eq!(fix, None);
        let (message, fix, _) = report(Some(HashMap::new()));
        assert!(message.contains("The directory 'prompts/' does not exist."), "{message}");
        assert_eq!(fix, None);
        let (message, fix, _) = report(None);
        assert!(!message.contains("does not exist") && !message.contains("Did you mean"), "{message}");
        assert_eq!(fix, None);
    }
}
