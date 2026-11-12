//! Reads manifests through the registered sources and walks an entry's import graph.
//! Mirrors `../../nodejs/src/manifest-loader.ts`.
//!
//! The graph walk is Node's `loadGraph` over `imports:` alone: no `include:` partials, no
//! scoped `Telo.Import`, no version reconciliation and no child applications, each of which
//! the Rust kernel refuses or does not read. A host reads and resolves through an
//! [`ImportTargetPort`], so the kernel's own transports and its source refusals are the
//! walk's.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::Value;
use telo_templating::expansion_tag_of;

use crate::builtin_vocabulary::{builtin_vocabulary_import_message, BUILTIN_VOCABULARY_KIND};
use crate::loaded_types::{
    GraphLoadError, ImportEdge, ImportFailureReason, LoadedFile, LoadedGraph, LoadedModule, ParseErrorOrigin,
};
use crate::parse_loaded_file::parse_loaded_file;
use crate::reserved_kind_prefix::{
    is_reserved_kind_prefix, reserved_import_alias_message, reserved_library_name_message,
};
use crate::system_kinds::{is_module_document, APPLICATION, LIBRARY};
use crate::types::{kind_of, AnalysisDiagnostic, DiagnosticData, LoadError, ManifestSource};

pub struct ManifestLoader {
    sources: Vec<Box<dyn ManifestSource>>,
}

impl ManifestLoader {
    pub fn new(sources: Vec<Box<dyn ManifestSource>>) -> Self {
        Self { sources }
    }

    /// Read `path_or_url` through the first source supporting it and parse it. A file that
    /// does not parse still loads: its errors are on the result, reported by
    /// [`collect_parse_diagnostics`].
    pub fn load(&self, path_or_url: &str) -> Result<LoadedFile, LoadError> {
        let source = self
            .sources
            .iter()
            .find(|source| source.supports(path_or_url))
            .ok_or_else(|| LoadError::UnsupportedSource(path_or_url.to_string()))?;
        let read = source.read(path_or_url)?;
        Ok(parse_loaded_file(&read.source, path_or_url, &read.text))
    }
}

/// How a host resolves and reads an import target.
pub trait ImportTargetPort {
    type Error;
    /// The location the import `source`, written under `alias` in `from`, names.
    fn resolve(&self, from: &LoadedFile, alias: &str, source: &str) -> Result<String, Self::Error>;
    fn load(&self, url: &str) -> Result<LoadedFile, Self::Error>;
}

impl ImportTargetPort for ManifestLoader {
    type Error = LoadError;

    fn resolve(&self, from: &LoadedFile, _alias: &str, source: &str) -> Result<String, LoadError> {
        Ok(resolve_source(&from.source, source))
    }

    fn load(&self, url: &str) -> Result<LoadedFile, LoadError> {
        ManifestLoader::load(self, url)
    }
}

/// Every file's parse errors as diagnostics, each carrying the file it is in. A construct
/// only this reader cannot hold is no diagnostic: the Rust kernel refuses it at load.
pub fn collect_parse_diagnostics<'a>(files: impl IntoIterator<Item = &'a LoadedFile>) -> Vec<AnalysisDiagnostic> {
    let mut diagnostics = Vec::new();
    for file in files {
        for error in &file.parse_errors {
            let code = match &error.origin {
                ParseErrorOrigin::Yaml(_) => "MANIFEST_PARSE_FAILED",
                ParseErrorOrigin::Loader { code, .. } => code,
                ParseErrorOrigin::Unsupported(_) => continue,
            };
            let mut diagnostic = AnalysisDiagnostic::error(
                code,
                error.message(),
                DiagnosticData { file_path: Some(file.source.clone()), ..Default::default() },
            );
            diagnostic.range = error.range;
            diagnostics.push(diagnostic);
        }
    }
    diagnostics
}

/// The identity an import target contributes to its importer — its library's
/// `metadata.name` — or why it contributes none, judged per import.
pub fn import_target_identity(
    target: &LoadedFile,
    import_source: &str,
) -> Result<String, (ImportFailureReason, String)> {
    let unusable = |message: String| Err((ImportFailureReason::UnusableTarget, message));
    let first = target.manifests.first().and_then(Option::as_ref);
    if first.and_then(kind_of) == Some(BUILTIN_VOCABULARY_KIND) {
        let version = first
            .and_then(|root| root.get("metadata"))
            .and_then(|metadata| metadata.get("version"))
            .and_then(Value::as_str);
        return unusable(builtin_vocabulary_import_message(import_source, version));
    }
    let library = target.documents().find(|m| kind_of(m) == Some(LIBRARY));
    let application = target.documents().find(|m| kind_of(m) == Some(APPLICATION));
    let Some(library) = library else {
        if application.is_some() {
            return unusable(format!(
                "Telo.Import target '{import_source}' is a Telo.Application. Only Telo.Library modules may be imported. Applications are run directly, not imported. Point this import at a library, or drop it and run that application on its own."
            ));
        }
        let kinds: Vec<&str> = target.documents().filter_map(kind_of).collect();
        let detail = if kinds.is_empty() {
            "Fetched manifest contained no recognizable Telo documents — check that the source serves a Telo.Library manifest and not an upstream error page.".to_string()
        } else {
            format!("Fetched {} document(s) with kinds [{}].", target.manifests.len(), kinds.join(", "))
        };
        return unusable(format!(
            "Telo.Import target '{import_source}' did not resolve to a Telo.Library. Fetched from: {}. {detail}",
            target.source
        ));
    };
    let name = library.get("metadata").and_then(|metadata| metadata.get("name")).and_then(Value::as_str);
    let Some(name) = name.filter(|name| !name.is_empty()) else {
        return unusable(format!(
            "Telo.Import target '{import_source}' resolved to a Telo.Library that declares no 'metadata.name'. Fetched from: {}. A library's name is the kind prefix its importers reference, so it cannot be imported until the target declares one.",
            target.source
        ));
    };
    if is_reserved_kind_prefix(name) {
        return Err((ImportFailureReason::ReservedPrefix, reserved_library_name_message(import_source, name)));
    }
    Ok(name.to_string())
}

/// Load the module at `entry_url` and every library its imports reach. An import whose
/// alias is reserved, or whose target is not an importable library, is recorded against
/// itself and contributes no edge; the rest of the graph still loads. A failure to resolve
/// or read a target is the port's error and ends the walk.
pub fn load_graph<P: ImportTargetPort>(port: &P, entry_url: &str) -> Result<LoadedGraph, P::Error> {
    let entry = port.load(entry_url)?;
    let root_source = entry.source.clone();
    let mut graph = LoadedGraph {
        root_source: root_source.clone(),
        modules: IndexMap::new(),
        requested: HashMap::from([(entry_url.to_string(), root_source.clone())]),
        import_edges: HashMap::new(),
        parse_diagnostics: Vec::new(),
        errors: Vec::new(),
    };
    let builtin_vocabulary = entry.manifests.first().and_then(Option::as_ref).and_then(kind_of)
        == Some(BUILTIN_VOCABULARY_KIND);
    graph.modules.insert(root_source.clone(), LoadedModule { owner: entry });
    // The built-in vocabulary is read, never run or checked as a module: nothing it holds is walked.
    if !builtin_vocabulary {
        walk_imports(port, &mut graph)?;
    }
    graph.parse_diagnostics = collect_parse_diagnostics(graph.modules.values().map(|module| &module.owner));
    Ok(graph)
}

fn walk_imports<P: ImportTargetPort>(port: &P, graph: &mut LoadedGraph) -> Result<(), P::Error> {
    let mut queue = VecDeque::from([graph.root_source.clone()]);
    let mut visited = HashSet::from([graph.root_source.clone()]);
    while let Some(source) = queue.pop_front() {
        let imports = module_imports(&graph.modules[&source].owner);
        let mut aliases: IndexMap<String, ImportEdge> = IndexMap::new();
        for (alias, import_source, source_line) in imports {
            let failure = |url: String, reason: ImportFailureReason, message: String| GraphLoadError {
                url,
                source: import_source.clone(),
                from_source: source.clone(),
                alias: alias.clone(),
                source_line,
                reason,
                message,
            };
            // Refused before the target is fetched: the alias alone decides it.
            if is_reserved_kind_prefix(&alias) {
                let message = reserved_import_alias_message(&alias);
                graph.errors.push(failure(import_source.clone(), ImportFailureReason::ReservedPrefix, message));
                continue;
            }
            let url = port.resolve(&graph.modules[&source].owner, &alias, &import_source)?;
            let target_source = match graph.requested.get(&url) {
                Some(known) => known.clone(),
                None => {
                    let target = port.load(&url)?;
                    let canonical = target.source.clone();
                    graph.requested.insert(url, canonical.clone());
                    graph.modules.entry(canonical.clone()).or_insert(LoadedModule { owner: target });
                    canonical
                }
            };
            match import_target_identity(&graph.modules[&target_source].owner, &import_source) {
                Err((reason, message)) => graph.errors.push(failure(target_source, reason, message)),
                Ok(name) => {
                    aliases.insert(
                        alias.clone(),
                        ImportEdge {
                            target_source: target_source.clone(),
                            target_ref: import_source.clone(),
                            target_module_name: name,
                        },
                    );
                    if visited.insert(target_source.clone()) {
                        queue.push_back(target_source);
                    }
                }
            }
        }
        if !aliases.is_empty() {
            graph.import_edges.insert(source, aliases);
        }
    }
    Ok(())
}

/// A module document's `imports:` entries, each as its alias, its source as authored and
/// the line of its entry — an entry that names no source is no import. The Node loader reads
/// a block behind an expansion tag as an import of its marker, which it then fails to
/// resolve; that failure has no twin here.
fn module_imports(file: &LoadedFile) -> Vec<(String, String, Option<usize>)> {
    let mut out = Vec::new();
    for (index, manifest) in file.manifests.iter().enumerate() {
        let Some(manifest) = manifest else { continue };
        if !kind_of(manifest).is_some_and(is_module_document) {
            continue;
        }
        // A block behind an expansion tag is the loader's refusal (`BRANCH_POSITION_INVALID`),
        // and its marker no import.
        let Some(entries) = manifest
            .get("imports")
            .filter(|imports| expansion_tag_of(imports).is_none())
            .and_then(Value::as_object)
        else {
            continue;
        };
        let position = file.positions.get(index);
        for (alias, entry) in entries {
            let source = match entry {
                Value::String(source) => source.as_str(),
                Value::Object(map) => match map.get("source").and_then(Value::as_str) {
                    Some(source) => source,
                    None => continue,
                },
                _ => continue,
            };
            if source.is_empty() {
                continue;
            }
            let source_line = position.map(|position| {
                position
                    .position_index
                    .get(&format!("@key:imports.{alias}"))
                    .or_else(|| position.position_index.get(&format!("imports.{alias}")))
                    .map_or(position.source_line, |range| range.start.line)
            });
            out.push((alias.clone(), source.to_string(), source_line));
        }
    }
    out
}

/// Resolve an import's `source` against the manifest that declared it.
///
/// A relative spec is joined to the *importing file's* directory, never to the
/// process working directory — a library two imports deep would otherwise
/// resolve against wherever the CLI happened to be invoked.
pub fn resolve_source(base_source: &str, spec: &str) -> String {
    if !spec.starts_with('.') {
        return spec.to_string();
    }
    let base_dir = Path::new(base_source)
        .parent()
        .unwrap_or_else(|| Path::new("."));
    normalize(&base_dir.join(spec))
}

/// Collapse `.` and `..` lexically. Done without touching the filesystem so an
/// unreadable path still produces a message naming what was actually looked for.
fn normalize(path: &Path) -> String {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}
