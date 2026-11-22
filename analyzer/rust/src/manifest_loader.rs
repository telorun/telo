//! Reads manifests through the registered sources and walks an entry's module graph.
//! Mirrors `../../nodejs/src/manifest-loader.ts`.
//!
//! The walk is Node's `loadGraph` over every module's `imports:` (desugared to `Telo.Import`
//! documents) and authored module-level `Telo.Import` documents, each module read with the
//! partials its `include:` list names, then version reconciliation. A `Telo.Import` declared
//! as a scope member and a child application are not walked: the Rust hosts read neither. A
//! host reads and resolves through an [`ImportTargetPort`], so the kernel's own transports are
//! the walk's: a source failure is that import's failure and the walk goes on, and a construct
//! this build cannot read ([`LoadError::Unsupported`]) is a host refusal on the file naming it.
//! The Node loader's caches and its editor entry points (`loadGraphForFile`, `forget`) serve
//! hosts this build does not have.

use std::collections::{HashSet, VecDeque};

use indexmap::IndexMap;
use serde_json::Value;

use crate::builtin_vocabulary::{builtin_vocabulary_import_message, BUILTIN_VOCABULARY_KIND, BUILTIN_VOCABULARY_NOT_A_MODULE};
use crate::inline_imports::{desugar_loaded_file, IMPORT};
use crate::loaded_types::{
    GraphLoadError, ImportEdge, ImportFailureReason, LoadedFile, LoadedGraph, LoadedModule, ParseError, ParseErrorOrigin,
};
use crate::metadata_stamp_refusals::metadata_stamp_diagnostics;
use crate::module_file_existence::collect_local_module_file_diagnostics;
use crate::module_declaration_refusals::{
    duplicate_module_target_message, module_declaration_errors, module_document_kinds, partial_failure_reason,
    partial_glob_unsupported_error, partial_kind_errors, partial_not_found_error,
};
use crate::parse_loaded_file::parse_loaded_file;
use crate::reconcile_module_versions::reconcile_module_versions;
use crate::reserved_kind_prefix::{is_reserved_kind_prefix, reserved_import_alias_message, reserved_library_name_message};
use crate::sources::module_reference::is_malformed_schemed_reference;
use crate::sources::source_failure::location_of;
use crate::system_kinds::{is_module_document, APPLICATION, LIBRARY};
use crate::types::{join_relative, kind_of, AnalysisDiagnostic, DiagnosticData, LoadError, ManifestSource, Range};

pub struct ManifestLoader {
    sources: Vec<Box<dyn ManifestSource>>,
}

/// One `include:` entry: its pattern and its index in the list.
#[derive(Clone)]
struct IncludeEntry {
    pattern: String,
    index: usize,
}

/// The files an `include:` list names — each with the entry naming it by path, none for a
/// file a glob reached — and the globs the source cannot expand.
struct ResolvedIncludes {
    files: Vec<(String, Option<IncludeEntry>)>,
    unexpanded: Vec<IncludeEntry>,
}

impl ManifestLoader {
    /// Sources are tried in order; the first whose `supports` matches reads.
    pub fn new(sources: Vec<Box<dyn ManifestSource>>) -> Self {
        Self { sources }
    }

    fn pick(&self, url: &str) -> Result<&dyn ManifestSource, LoadError> {
        self.sources
            .iter()
            .find(|source| source.supports(url))
            .map(Box::as_ref)
            .ok_or_else(|| LoadError::UnsupportedSource(url.to_string()))
    }

    /// Read `path_or_url` through the first source supporting it, parse it and desugar its
    /// inline imports. A file that does not parse still loads: its errors are on the result.
    pub fn load(&self, path_or_url: &str) -> Result<LoadedFile, LoadError> {
        let read = self.pick(path_or_url)?.read(path_or_url)?;
        Ok(desugar_loaded_file(parse_loaded_file(&read.source, path_or_url, &read.text)))
    }

    /// An owner file and every partial its `include:` list names, globs expanded by the
    /// owner's source. What the loader refuses about the files is a coded parse error on the
    /// file writing it: the owner's module-declaration rule, a glob its source cannot expand
    /// or a partial it cannot read (on the owner), a module-only kind in a partial.
    pub fn load_module(&self, url: &str) -> Result<LoadedModule, LoadError> {
        let mut owner = self.load(url)?;
        let mut owner_errors = module_declaration_errors(&owner);
        let module_index =
            owner.manifests.iter().position(|m| m.as_ref().and_then(kind_of).is_some_and(is_module_document));
        // An entry that is not a string — an expansion tag, which the parse refused — names no file.
        let entries: Vec<IncludeEntry> = module_index
            .and_then(|index| owner.manifests[index].as_ref())
            .and_then(|module| module.get("include"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .enumerate()
                    .filter_map(|(index, item)| Some(IncludeEntry { pattern: item.as_str()?.to_string(), index }))
                    .collect()
            })
            .unwrap_or_default();
        let Some(module_index) = module_index.filter(|_| !entries.is_empty()) else {
            owner.parse_errors.extend(owner_errors);
            return Ok(LoadedModule { owner, partials: Vec::new() });
        };

        let positions = owner.positions.get(module_index).map(|p| p.position_index.clone()).unwrap_or_default();
        let range_of = |index: Option<usize>| -> Option<Range> {
            match index {
                None => positions.get("include").copied(),
                Some(index) => positions.get(&format!("include[{index}]")).copied(),
            }
        };
        let host_refusal = |message: String| ParseError {
            document_index: module_index,
            origin: ParseErrorOrigin::HostRefusal(message),
            range: range_of(None),
        };
        let picked = self.pick(&owner.source)?;
        let includes = match self.resolve_includes(&owner.source, &entries, picked) {
            Ok(includes) => includes,
            Err(LoadError::Unsupported(message)) => {
                owner_errors.push(host_refusal(message));
                owner.parse_errors.extend(owner_errors);
                return Ok(LoadedModule { owner, partials: Vec::new() });
            }
            Err(err) => return Err(err),
        };
        for glob in &includes.unexpanded {
            owner_errors.push(partial_glob_unsupported_error(&glob.pattern, module_index, range_of(Some(glob.index))));
        }
        let mut partials = Vec::new();
        for (included_url, entry) in includes.files {
            match self.load(&included_url) {
                Ok(mut partial) => {
                    let errors = partial_kind_errors(&partial);
                    partial.parse_errors.extend(errors);
                    partials.push(partial);
                }
                Err(LoadError::Source(failure)) => owner_errors.push(partial_not_found_error(
                    entry.as_ref().map_or(included_url.as_str(), |entry| entry.pattern.as_str()),
                    &partial_failure_reason(&failure),
                    module_index,
                    range_of(entry.as_ref().map(|entry| entry.index)),
                )),
                Err(LoadError::Unsupported(message)) => owner_errors.push(host_refusal(message)),
                Err(err) => return Err(err),
            }
        }
        owner.parse_errors.extend(owner_errors);
        Ok(LoadedModule { owner, partials })
    }

    /// Resolve an import's `source` against the file declaring it: a relative or absolute
    /// path through the source serving that file, any other ref unchanged.
    pub fn resolve_import_url(&self, from_source: &str, import_source: &str) -> Result<String, LoadError> {
        if !is_local_path_source(import_source) {
            return Ok(import_source.to_string());
        }
        self.pick(from_source)?.resolve_relative(from_source, import_source)
    }

    /// What an `include:` list names. A path entry the expansion did not reach keeps its own
    /// read; a `!` entry beside a glob is an exclusion, never a path.
    fn resolve_includes(
        &self,
        owner_source: &str,
        entries: &[IncludeEntry],
        source: &dyn ManifestSource,
    ) -> Result<ResolvedIncludes, LoadError> {
        let is_glob = |pattern: &str| pattern.contains(['*', '?', '{', '}', '[', ']']);
        let mut by_url: IndexMap<String, IncludeEntry> = IndexMap::new();
        for entry in entries.iter().filter(|entry| !is_glob(&entry.pattern)) {
            let url = source.resolve_relative(owner_source, &entry.pattern)?;
            by_url.entry(url).or_insert_with(|| entry.clone());
        }
        let globs: Vec<IncludeEntry> = entries.iter().filter(|entry| is_glob(&entry.pattern)).cloned().collect();
        let by_path = |by_url: IndexMap<String, IncludeEntry>| by_url.into_iter().map(|(url, entry)| (url, Some(entry))).collect();
        if globs.is_empty() {
            return Ok(ResolvedIncludes { files: by_path(by_url), unexpanded: Vec::new() });
        }
        let patterns: Vec<String> = entries.iter().map(|entry| entry.pattern.clone()).collect();
        match source.expand_glob(owner_source, &patterns) {
            None => Ok(ResolvedIncludes { files: by_path(by_url), unexpanded: globs }),
            Some(urls) => {
                let urls = urls?;
                let expanded: HashSet<&String> = urls.iter().collect();
                let unreached: Vec<(String, Option<IncludeEntry>)> = by_url
                    .iter()
                    .filter(|(url, entry)| !expanded.contains(url) && !entry.pattern.starts_with('!'))
                    .map(|(url, entry)| (url.clone(), Some(entry.clone())))
                    .collect();
                let mut files: Vec<(String, Option<IncludeEntry>)> = urls
                    .iter()
                    .map(|url| (url.clone(), by_url.get(url).cloned()))
                    .collect();
                files.extend(unreached);
                Ok(ResolvedIncludes { files, unexpanded: Vec::new() })
            }
        }
    }
}

/// True when `source` names an on-disk sibling manifest — a relative or absolute path —
/// rather than a transport-owned remote ref (`local-path-ref.ts`).
pub fn is_local_path_source(source: &str) -> bool {
    source.starts_with('.') || source.starts_with('/')
}

/// How a host resolves and reads an import target. An error is that import's failure, except
/// [`LoadError::Unsupported`], which is a host refusal on the file declaring the import.
pub trait ImportTargetPort {
    /// The location the import `source`, written under `alias` in `from`, names.
    fn resolve(&self, from: &LoadedFile, alias: &str, source: &str) -> Result<String, LoadError>;
    fn load(&self, url: &str) -> Result<LoadedModule, LoadError>;

    /// The source reading `url` — the first that supports it — which the module-file walk asks
    /// what a claim names; `None` for a host with none, which asks nothing.
    fn source_for(&self, url: &str) -> Option<&dyn ManifestSource> {
        let _ = url;
        None
    }
}

impl ImportTargetPort for ManifestLoader {
    fn resolve(&self, from: &LoadedFile, _alias: &str, source: &str) -> Result<String, LoadError> {
        self.resolve_import_url(&from.source, source)
    }

    fn load(&self, url: &str) -> Result<LoadedModule, LoadError> {
        self.load_module(url)
    }

    fn source_for(&self, url: &str) -> Option<&dyn ManifestSource> {
        self.pick(url).ok()
    }
}

/// Every file's parse errors as diagnostics, each carrying the file it is in. A construct
/// only this build cannot read is no diagnostic: the Rust hosts refuse it.
pub fn collect_parse_diagnostics<'a>(files: impl IntoIterator<Item = &'a LoadedFile>) -> Vec<AnalysisDiagnostic> {
    let mut diagnostics = Vec::new();
    for file in files {
        for error in &file.parse_errors {
            let code = match &error.origin {
                ParseErrorOrigin::Yaml(_) => "MANIFEST_PARSE_FAILED",
                ParseErrorOrigin::Loader { code, .. } => code,
                ParseErrorOrigin::Unsupported(_) | ParseErrorOrigin::HostRefusal(_) => continue,
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

/// The refusal of an entry whose first document is the built-in vocabulary archive: one
/// `UNDEFINED_KIND` at its `kind:` value, since `Telo.Builtins` is registered nowhere.
fn builtin_vocabulary_entry_refusal(file: &LoadedFile) -> AnalysisDiagnostic {
    let mut diagnostic = AnalysisDiagnostic::error(
        "UNDEFINED_KIND",
        BUILTIN_VOCABULARY_NOT_A_MODULE.to_string(),
        DiagnosticData { file_path: Some(file.source.clone()), ..Default::default() },
    );
    diagnostic.range = file.positions.first().and_then(|position| position.position_index.get("kind")).copied();
    diagnostic
}

fn is_builtin_vocabulary_root(file: &LoadedFile) -> bool {
    file.manifests.first().and_then(Option::as_ref).and_then(kind_of) == Some(BUILTIN_VOCABULARY_KIND)
}

/// The identity an import target contributes to its importer — its library's
/// `metadata.name` — or why it contributes none, judged per import.
pub fn import_target_identity(
    target: &LoadedModule,
    import_source: &str,
) -> Result<String, (ImportFailureReason, String)> {
    let unusable = |message: String| Err((ImportFailureReason::UnusableTarget, message));
    let owner = &target.owner;
    let first = owner.manifests.first().and_then(Option::as_ref);
    if is_builtin_vocabulary_root(owner) {
        let version = first
            .and_then(|root| root.get("metadata"))
            .and_then(|metadata| metadata.get("version"))
            .and_then(Value::as_str);
        return unusable(builtin_vocabulary_import_message(import_source, version));
    }
    // A file holding several module documents is refused at the file itself; no import may
    // take one of them for it.
    let module_kinds = module_document_kinds(owner);
    if module_kinds.len() > 1 {
        return unusable(duplicate_module_target_message(&module_kinds));
    }
    let library = owner.documents().find(|m| kind_of(m) == Some(LIBRARY));
    let application = owner.documents().find(|m| kind_of(m) == Some(APPLICATION));
    let Some(library) = library else {
        if application.is_some() {
            return unusable(format!(
                "Telo.Import target '{import_source}' is a Telo.Application. Only Telo.Library modules may be imported. Applications are run directly, not imported. Point this import at a library, or drop it and run that application on its own."
            ));
        }
        let kinds: Vec<&str> = owner.documents().filter_map(kind_of).collect();
        let detail = if kinds.is_empty() {
            "Fetched manifest contained no recognizable Telo documents — check that the source serves a Telo.Library manifest and not an upstream error page.".to_string()
        } else {
            format!("Fetched {} document(s) with kinds [{}].", owner.manifests.len(), kinds.join(", "))
        };
        return unusable(format!(
            "Telo.Import target '{import_source}' did not resolve to a Telo.Library. Fetched from: {}. {detail}",
            location_of(&owner.source)
        ));
    };
    let name = library.get("metadata").and_then(|metadata| metadata.get("name")).and_then(Value::as_str);
    let Some(name) = name.filter(|name| !name.is_empty()) else {
        return unusable(format!(
            "Telo.Import target '{import_source}' resolved to a Telo.Library that declares no 'metadata.name'. Fetched from: {}. A library's name is the kind prefix its importers reference, so it cannot be imported until the target declares one.",
            location_of(&owner.source)
        ));
    };
    if is_reserved_kind_prefix(name) {
        return Err((ImportFailureReason::ReservedPrefix, reserved_library_name_message(import_source, name)));
    }
    Ok(name.to_string())
}

/// One import declaration, as the per-import load step reads it.
struct ImportRequest {
    /// The file declaring the import.
    from_source: String,
    /// The `Telo.Import` document's index in that file.
    document_index: usize,
    source: String,
    alias: String,
    /// Line of the declaring `Telo.Import` document.
    source_line: usize,
}

/// What one import came to.
enum ImportTargetLoad {
    Loaded { canonical: String, name: String },
    Failed(GraphLoadError),
    /// A construct this build cannot read, refused on the importing file.
    Refused(String),
}

/// Load the module at `entry_url` and every library its imports reach. A failure to read
/// the entry is the error; every import that cannot be obtained or identified is recorded
/// against itself and contributes no edge, and the rest of the graph still loads.
pub fn load_graph<P: ImportTargetPort>(port: &P, entry_url: &str) -> Result<LoadedGraph, LoadError> {
    let entry = port.load(entry_url)?;
    let root_source = entry.owner.source.clone();
    let builtin_vocabulary = is_builtin_vocabulary_root(&entry.owner);
    let mut graph = LoadedGraph {
        root_source: root_source.clone(),
        modules: IndexMap::new(),
        requested: [(entry_url.to_string(), root_source.clone()), (root_source.clone(), root_source.clone())].into(),
        import_edges: IndexMap::new(),
        overrides: IndexMap::new(),
        parse_diagnostics: Vec::new(),
        version_diagnostics: Vec::new(),
        migration_diagnostics: Vec::new(),
        module_file_diagnostics: Vec::new(),
        metadata_diagnostics: Vec::new(),
        errors: Vec::new(),
    };
    graph.modules.insert(root_source.clone(), entry);
    // The built-in vocabulary is read, never run or checked as a module: nothing it holds is walked.
    if builtin_vocabulary {
        graph.parse_diagnostics = collect_parse_diagnostics(graph.files());
        graph.parse_diagnostics.push(builtin_vocabulary_entry_refusal(&graph.modules[&root_source].owner));
        return Ok(graph);
    }
    walk_imports(port, &mut graph);
    let reconciliation = reconcile_module_versions(&graph.modules, &mut graph.import_edges);
    graph.overrides = reconciliation.overrides;
    graph.version_diagnostics = reconciliation.diagnostics;
    graph.parse_diagnostics = collect_parse_diagnostics(graph.files());
    // Rewrite always, report locally: every file was migrated, and only the entry's own report.
    graph.migration_diagnostics =
        graph.modules[&root_source].files().flat_map(|file| file.migrations.diagnostics.iter().cloned()).collect();
    graph.module_file_diagnostics = collect_local_module_file_diagnostics(&mut graph, &|url| port.source_for(url))?;
    graph.metadata_diagnostics = metadata_stamp_diagnostics(&graph);
    Ok(graph)
}

fn walk_imports<P: ImportTargetPort>(port: &P, graph: &mut LoadedGraph) {
    let mut queue = VecDeque::from([graph.root_source.clone()]);
    let mut visited = HashSet::from([graph.root_source.clone()]);
    let mut refusals: Vec<(String, ParseError)> = Vec::new();
    while let Some(module_source) = queue.pop_front() {
        let files: Vec<String> = graph.modules[&module_source].files().map(|file| file.source.clone()).collect();
        for file_source in files {
            let mut aliases = graph.import_edges.get(&file_source).cloned().unwrap_or_default();
            for request in import_requests(file_of(graph, &file_source)) {
                match load_import_target(port, graph, &request) {
                    ImportTargetLoad::Failed(failure) => graph.errors.push(failure),
                    ImportTargetLoad::Refused(message) => {
                        let range = file_of(graph, &file_source)
                            .positions
                            .get(request.document_index)
                            .and_then(|position| position.position_index.get("source"))
                            .copied();
                        refusals.push((
                            file_source.clone(),
                            ParseError {
                                document_index: request.document_index,
                                origin: ParseErrorOrigin::HostRefusal(message),
                                range,
                            },
                        ));
                    }
                    ImportTargetLoad::Loaded { canonical, name } => {
                        aliases.insert(
                            request.alias.clone(),
                            ImportEdge { target_source: canonical.clone(), target_ref: request.source.clone(), target_module_name: name },
                        );
                        if visited.insert(canonical.clone()) {
                            queue.push_back(canonical);
                        }
                    }
                }
            }
            if !aliases.is_empty() {
                graph.import_edges.insert(file_source, aliases);
            }
        }
    }
    for (file_source, refusal) in refusals {
        if let Some(file) = graph.modules.values_mut().flat_map(|module| std::iter::once(&mut module.owner).chain(module.partials.iter_mut())).find(|file| file.source == file_source) {
            file.parse_errors.push(refusal);
        }
    }
}

/// The file of `graph` at `source`: an owner or a partial.
fn file_of<'g>(graph: &'g LoadedGraph, source: &str) -> &'g LoadedFile {
    graph.files().find(|file| file.source == source).expect("a file of the graph")
}

/// Every `Telo.Import` document of `file` — desugared or authored — that names a source
/// and an alias. A source that is no string is no import this loader reads.
fn import_requests(file: &LoadedFile) -> Vec<ImportRequest> {
    let mut out = Vec::new();
    for (index, manifest) in file.manifests.iter().enumerate() {
        let Some(manifest) = manifest.as_ref().filter(|m| kind_of(m) == Some(IMPORT)) else { continue };
        let Some(source) = manifest.get("source").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        let Some(alias) = manifest
            .get("metadata")
            .and_then(|metadata| metadata.get("name"))
            .and_then(Value::as_str)
            .filter(|alias| !alias.is_empty())
        else {
            continue;
        };
        out.push(ImportRequest {
            from_source: file.source.clone(),
            document_index: index,
            source: source.to_string(),
            alias: alias.to_string(),
            source_line: file.positions.get(index).map_or(0, |position| position.source_line),
        });
    }
    out
}

/// The per-import load step: the reserved-alias check, resolution, the load and the
/// target's identity, each failure returned as the graph load error it is.
fn load_import_target<P: ImportTargetPort>(port: &P, graph: &mut LoadedGraph, request: &ImportRequest) -> ImportTargetLoad {
    let failure = |url: &str, reason: ImportFailureReason, message: String, source_failure| {
        ImportTargetLoad::Failed(GraphLoadError {
            url: url.to_string(),
            source: request.source.clone(),
            from_source: request.from_source.clone(),
            alias: request.alias.clone(),
            source_line: Some(request.source_line),
            reason,
            source_failure,
            message,
        })
    };
    let unobtained = |url: &str, err: LoadError| match err {
        LoadError::Unsupported(message) => ImportTargetLoad::Refused(message),
        LoadError::Source(source) => failure(url, ImportFailureReason::Unresolved, source.sentence(), Some(source.kind)),
        other => failure(url, ImportFailureReason::Unresolved, other.to_string(), None),
    };
    // Refused before the target is fetched: the alias alone decides it.
    if is_reserved_kind_prefix(&request.alias) {
        return failure(
            &request.source,
            ImportFailureReason::ReservedPrefix,
            reserved_import_alias_message(&request.alias),
            None,
        );
    }
    // Refused before any source is asked, a host refusal included: a reference its
    // scheme's grammar refuses names no module.
    if is_malformed_schemed_reference(&request.source) {
        let message = LoadError::UnsupportedSource(request.source.clone()).to_string();
        return failure(&request.source, ImportFailureReason::Unresolved, message, None);
    }
    let url = match port.resolve(file_of(graph, &request.from_source), &request.alias, &request.source) {
        Ok(url) => url,
        Err(err) => return unobtained(&request.source, err),
    };
    let canonical = match graph.requested.get(&url) {
        Some(known) => known.clone(),
        None => match port.load(&url) {
            Err(err) => return unobtained(&url, err),
            Ok(target) => {
                let canonical = target.owner.source.clone();
                graph.requested.insert(url, canonical.clone());
                graph.requested.insert(canonical.clone(), canonical.clone());
                graph.modules.entry(canonical.clone()).or_insert(target);
                canonical
            }
        },
    };
    match import_target_identity(&graph.modules[&canonical], &request.source) {
        Err((reason, message)) => failure(&canonical, reason, message, None),
        Ok(name) => ImportTargetLoad::Loaded { canonical, name },
    }
}

/// Resolve an import's `source` against the manifest that declared it: a relative or
/// absolute path is joined to the importing file's directory — never to the process working
/// directory — and normalized, as the local file source resolves it.
pub fn resolve_source(base_source: &str, spec: &str) -> String {
    if !is_local_path_source(spec) {
        return spec.to_string();
    }
    join_relative(base_source, spec)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::types::ReadManifest;

    /// Files in memory, read by path; a source that cannot list files.
    struct Files(HashMap<&'static str, &'static str>);

    impl ManifestSource for Files {
        fn supports(&self, path: &str) -> bool {
            path.starts_with('/')
        }

        fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
            let file = if path.ends_with(".yaml") { path.to_string() } else { format!("{path}/telo.yaml") };
            let text = self.0.get(file.as_str()).ok_or_else(|| LoadError::Failed(format!("no file {file}")))?;
            Ok(ReadManifest { text: text.to_string(), source: file })
        }
    }

    fn graph(files: &[(&'static str, &'static str)]) -> LoadedGraph {
        load_graph(&ManifestLoader::new(vec![Box::new(Files(files.iter().copied().collect()))]), "/app/telo.yaml")
            .expect("the entry loads")
    }

    #[test]
    fn refuses_a_glob_its_source_cannot_expand_at_the_include_entry() {
        let graph = graph(&[(
            "/app/telo.yaml",
            "kind: Telo.Application\nmetadata: { name: App }\ninclude: [./named.yaml, \"./parts/*.yaml\"]\n",
        ), ("/app/named.yaml", "kind: Self.Thing\nmetadata: { name: named }\n")]);
        let [refusal] = graph.parse_diagnostics.as_slice() else { panic!("{:?}", graph.parse_diagnostics) };
        assert_eq!(refusal.code.as_deref(), Some("PARTIAL_GLOB_UNSUPPORTED"));
        assert_eq!(
            refusal.message,
            "'./parts/*.yaml' is a glob, and the source this module is read from cannot list files to expand it; name each partial by its path instead."
        );
        let range = refusal.range.expect("at the entry");
        assert_eq!((range.start.line, range.start.character), (2, 24));
        assert_eq!(graph.entry().partials.iter().map(|p| p.source.as_str()).collect::<Vec<_>>(), ["/app/named.yaml"]);
    }

    /// A port refusing what this build cannot read holds the importing file back and walks on.
    struct RefusingPort(ManifestLoader);

    impl ImportTargetPort for RefusingPort {
        fn resolve(&self, from: &LoadedFile, alias: &str, source: &str) -> Result<String, LoadError> {
            if source.starts_with("https://") {
                return Err(LoadError::Unsupported(format!("import '{alias}' needs a transport this build lacks")));
            }
            self.0.resolve(from, alias, source)
        }

        fn load(&self, url: &str) -> Result<LoadedModule, LoadError> {
            self.0.load_module(url)
        }
    }

    #[test]
    fn holds_back_an_import_it_cannot_read_and_walks_the_rest() {
        let files: HashMap<&str, &str> = [
            ("/app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Web: \"https://x.test/lib\", Lib: ../lib, Gone: ../gone }\n"),
            ("/lib/telo.yaml", "kind: Telo.Library\nmetadata: { name: Lib }\n"),
        ]
        .into();
        let port = RefusingPort(ManifestLoader::new(vec![Box::new(Files(files))]));
        let graph = load_graph(&port, "/app/telo.yaml").expect("the entry loads");
        let refusals: Vec<String> =
            graph.entry().owner.parse_errors.iter().filter(|e| e.is_host_refusal()).map(ParseError::message).collect();
        assert_eq!(refusals, ["import 'Web' needs a transport this build lacks"]);
        assert!(graph.parse_diagnostics.is_empty(), "{:?}", graph.parse_diagnostics);
        assert_eq!(graph.import_edges["/app/telo.yaml"].keys().collect::<Vec<_>>(), ["Lib"]);
        let [gone] = graph.errors.as_slice() else { panic!("{:?}", graph.errors) };
        assert_eq!((gone.alias.as_str(), gone.message.as_str()), ("Gone", "no file /gone/telo.yaml"));
    }

    #[test]
    fn refuses_a_source_its_scheme_grammar_refuses_before_the_port_is_asked() {
        let files: HashMap<&str, &str> = [(
            "/app/telo.yaml",
            "kind: Telo.Application\nmetadata: { name: App }\nimports: { Http: \"http://[bad/x\", Oci: oci://host, Web: \"https://[bad/x\" }\n",
        )]
        .into();
        let port = RefusingPort(ManifestLoader::new(vec![Box::new(Files(files))]));
        let graph = load_graph(&port, "/app/telo.yaml").expect("the entry loads");
        assert!(graph.entry().owner.parse_errors.is_empty(), "{:?}", graph.entry().owner.parse_errors);
        let failures: Vec<(&str, &str, &str)> = graph
            .errors
            .iter()
            .map(|e| (e.alias.as_str(), crate::import_resolution_diagnostics::import_failure_code(e), e.message.as_str()))
            .collect();
        assert_eq!(
            failures,
            [
                ("Http", "INVALID_IMPORT_SOURCE", "No source found for: http://[bad/x"),
                ("Oci", "INVALID_IMPORT_SOURCE", "No source found for: oci://host"),
                ("Web", "INVALID_IMPORT_SOURCE", "No source found for: https://[bad/x"),
            ]
        );
    }
}
