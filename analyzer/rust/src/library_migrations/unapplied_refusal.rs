//! Where this build refuses a library migration it does not apply. No Node twin: the Node
//! analyzer applies library migrations (`../../../nodejs/src/library-migrations/stage.ts`),
//! and this file is what the Rust build does instead until it twins that stage.
//!
//! Ignoring a migration changes what a manifest means, so the `imports:` entry first
//! reaching a library whose module document declares `migrations:` is refused wherever a
//! map in a file whose closure reaches the library could be a candidate of one of its
//! rules. The test is position-free and reads the library's module document alone, never
//! its partials. A rule counts for a map when its `match` holds — for a type the library
//! lists in `exports.kinds`, only on a map whose `kind:` names the type by its last segment
//! — or when the map's `kind:` names a type some rule of the library writes `kind:` at the
//! root of. A rule with `before: Self.<Type>` counts only when some map of the closure
//! names `<Type>` that way. Over-refusing is safe; accepting where Node migrates is not.
//!
//! The maps scanned: every map of a resource document; the template-body `resources:`
//! entries and the `targets:` items of a kind document; the `resources:` and `needs:`
//! entries of a module document, which a retyping rewrites.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;
use telo_templating::{expansion_tag_of, is_tagged_sentinel, EXPANSION_MARKER};

use super::declaration::{read_library_migrations, root_kind_written, LibraryMigration};
use super::r#match::migration_match_holds;
use crate::loaded_types::{LoadedFile, LoadedGraph};
use crate::reaching_import::{import_reach, module_name_of};
use crate::system_kinds::{is_module_document, DEFINITION};
use crate::types::{kind_of, Position};

/// The kinds of the documents that declare a kind.
const KIND_DOCUMENTS: &[&str] = &[DEFINITION, "Telo.Abstract", "Telo.NeedType"];

/// One refused library: the import reaching it, the migration and the node it may apply at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnappliedLibraryMigration {
    /// The file holding the `imports:` entry: the entry module's.
    pub import_file: String,
    /// `imports.<alias>`.
    pub import_path: String,
    /// The library's `metadata.name`.
    pub library: String,
    /// The library's location as it was requested.
    pub library_source: String,
    /// The migration's code.
    pub migration: String,
    /// The file holding the node.
    pub node_file: String,
    /// Where the node starts, 0-based.
    pub node_position: Position,
}

impl UnappliedLibraryMigration {
    /// The refusal's sentence, each location written through `display`.
    pub fn message(&self, display: impl Fn(&str) -> String) -> String {
        format!(
            "'{}', {}: {} ({}) declares the manifest migration {}, which may apply at {}:{}:{}, and this build does not apply library migrations",
            display(&self.import_file),
            self.import_path,
            self.library,
            display(&self.library_source),
            self.migration,
            display(&self.node_file),
            self.node_position.line + 1,
            self.node_position.character + 1,
        )
    }
}

/// A map one of a library's rules might rewrite.
struct ScannedMap<'g> {
    file: &'g LoadedFile,
    document: usize,
    path: String,
    value: &'g Value,
    /// The last segment of its `kind:`.
    kind_name: Option<&'g str>,
}

/// One refusal per library declaring migrations that some map of a file reaching it could
/// be a candidate of, in the order the graph reached the libraries.
pub fn unapplied_library_migrations(graph: &LoadedGraph) -> Vec<UnappliedLibraryMigration> {
    let libraries: Vec<(&str, Vec<LibraryMigration>)> = graph
        .modules
        .iter()
        .filter_map(|(source, module)| {
            let mut migrations = read_library_migrations(module.owner.module_document()?);
            migrations.sort_by(|a, b| a.code.cmp(&b.code));
            (!migrations.is_empty()).then_some((source.as_str(), migrations))
        })
        .collect();
    if libraries.is_empty() {
        return Vec::new();
    }
    let reach = import_reach(graph);
    let mut scanned: HashMap<&str, Vec<ScannedMap>> = HashMap::new();
    let mut out = Vec::new();
    for (library_source, migrations) in &libraries {
        let Some(name) = module_name_of(graph, library_source) else { continue };
        let Some(via) = reach.of(name) else { continue };
        let library_doc = graph.modules[*library_source].owner.module_document();
        let exported_kinds: HashSet<&str> = library_doc
            .and_then(|doc| doc.get("exports"))
            .and_then(|exports| exports.get("kinds"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|kind| !kind.contains('.'))
            .collect();
        let retyped: HashSet<&str> = migrations
            .iter()
            .flat_map(|migration| &migration.rules)
            .filter(|rule| root_kind_written(rule).is_some())
            .map(|rule| rule.rewrite.as_str())
            .collect();

        let reaching: Vec<&str> = graph
            .modules
            .keys()
            .map(String::as_str)
            .filter(|source| source != library_source && reached_from(graph, source).contains(library_source))
            .collect();
        for source in &reaching {
            scanned.entry(source).or_insert_with(|| scan_file(&graph.modules[*source].owner));
        }
        let maps: Vec<&ScannedMap> = reaching.iter().flat_map(|source| &scanned[source]).collect();
        let named: HashSet<&str> = maps.iter().filter_map(|map| map.kind_name).collect();

        let found = maps.iter().find_map(|map| {
            migrations.iter().find_map(|migration| {
                let counts = migration.rules.iter().any(|rule| {
                    if rule.resolve.iter().any(|b| b.before.as_deref().is_some_and(|t| !named.contains(t))) {
                        return false;
                    }
                    let names_type = map.kind_name == Some(rule.rewrite.as_str());
                    let matched = migration_match_holds(&rule.r#match, map.value)
                        && (names_type || !exported_kinds.contains(rule.rewrite.as_str()));
                    matched || (names_type && retyped.contains(rule.rewrite.as_str()))
                });
                counts.then_some((*map, migration))
            })
        });
        let Some((map, migration)) = found else { continue };
        let library_file = &graph.modules[*library_source].owner;
        out.push(UnappliedLibraryMigration {
            import_file: via.file_path.clone(),
            import_path: via.path.clone(),
            library: name.to_string(),
            library_source: library_file.requested_url.clone(),
            migration: migration.code.clone(),
            node_file: map.file.source.clone(),
            node_position: node_position(map.file, map.document, &map.path),
        });
    }
    out
}

/// Every module the module at `source` reaches through its imports, transitively.
fn reached_from<'g>(graph: &'g LoadedGraph, source: &str) -> HashSet<&'g str> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = graph
        .import_edges
        .get(source)
        .into_iter()
        .flat_map(|edges| edges.values().map(|edge| edge.target_source.as_str()))
        .collect();
    while let Some(next) = queue.pop_front() {
        if !seen.insert(next) {
            continue;
        }
        if let Some(edges) = graph.import_edges.get(next) {
            queue.extend(edges.values().map(|edge| edge.target_source.as_str()));
        }
    }
    seen
}

/// The maps of `file` a rule might rewrite, depth first in written order.
fn scan_file(file: &LoadedFile) -> Vec<ScannedMap<'_>> {
    let mut out = Vec::new();
    for (document, manifest) in file.manifests.iter().enumerate() {
        let Some(manifest) = manifest else { continue };
        let kind = kind_of(manifest);
        let containers: &[&str] = match kind {
            Some(kind) if is_module_document(kind) => &["resources", "needs"],
            Some("Telo.Import") => &[],
            Some(kind) if KIND_DOCUMENTS.contains(&kind) => &["resources", "targets"],
            _ => {
                collect_maps(file, document, manifest, String::new(), &mut out);
                continue;
            }
        };
        for container in containers {
            match manifest.get(*container) {
                Some(Value::Object(entries)) if expansion_tag_of(&manifest[*container]).is_none() => {
                    for (key, entry) in entries {
                        collect_maps(file, document, entry, format!("{container}.{key}"), &mut out);
                    }
                }
                Some(Value::Array(items)) => {
                    for (index, item) in items.iter().enumerate() {
                        collect_maps(file, document, item, format!("{container}[{index}]"), &mut out);
                    }
                }
                Some(other) => collect_maps(file, document, other, container.to_string(), &mut out),
                None => {}
            }
        }
    }
    out
}

/// Every map at or under `value`: an expansion mapping's branches are walked and the
/// mapping itself is no map, and a tagged value is not entered.
fn collect_maps<'g>(file: &'g LoadedFile, document: usize, value: &'g Value, path: String, out: &mut Vec<ScannedMap<'g>>) {
    let mut stack = vec![(value, path)];
    while let Some((value, path)) = stack.pop() {
        if is_tagged_sentinel(value) {
            continue;
        }
        let child = |key: &str| if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
        match value {
            Value::Object(map) => {
                let expansion = expansion_tag_of(value).is_some();
                for (key, item) in map.iter().rev() {
                    if !(expansion && key == EXPANSION_MARKER) {
                        stack.push((item, child(key)));
                    }
                }
                if !expansion {
                    let kind_name = map.get("kind").and_then(Value::as_str).map(|kind| kind.rsplit('.').next().unwrap_or(kind));
                    out.push(ScannedMap { file, document, path, value, kind_name });
                }
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate().rev() {
                    stack.push((item, format!("{path}[{index}]")));
                }
            }
            _ => {}
        }
    }
}

/// Where the node at `path` of a document starts: its own range, else the nearest
/// enclosing one the position index holds, else the document's first entry.
fn node_position(file: &LoadedFile, document: usize, path: &str) -> Position {
    let Some(positions) = file.positions.get(document) else { return Position { line: 0, character: 0 } };
    let mut at = path;
    while !at.is_empty() {
        if let Some(range) = positions.position_index.get(at) {
            return range.start;
        }
        at = parent_path(at);
    }
    positions
        .position_index
        .values()
        .next()
        .map(|range| range.start)
        .unwrap_or(Position { line: positions.source_line, character: 0 })
}

fn parent_path(path: &str) -> &str {
    if path.ends_with(']') {
        if let Some(open) = path.rfind('[') {
            return &path[..open];
        }
    }
    path.rfind('.').map_or("", |dot| &path[..dot])
}
