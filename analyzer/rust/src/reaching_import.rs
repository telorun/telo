//! Where a dependency's refusal is reported: at the entry's `imports:` entry through which
//! the dependency is first reached. Mirrors `../../nodejs/src/reaching-import.ts` over the
//! graph's import edges; a `Telo.Import` declared as a scope member has no twin, since this
//! loader walks none.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::loaded_types::LoadedGraph;
use crate::types::{name_of, AnalysisDiagnostic, DiagnosticData};

/// An `imports:` entry of the entry module, as a diagnostic anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReachingImport {
    pub alias: String,
    pub file_path: String,
    /// `imports.<alias>`.
    pub path: String,
}

/// Which of the entry's imports first reaches each dependency, by module name.
pub struct ImportReach {
    first: HashMap<String, ReachingImport>,
}

impl ImportReach {
    /// The entry's import through which `module` is first reached — the entry's imports in
    /// declaration order, each followed through every library it reaches, however deep.
    /// `None` for the entry's own module and for a module no import reaches.
    pub fn of(&self, module: &str) -> Option<&ReachingImport> {
        self.first.get(module)
    }
}

/// The module name of the file at `source`: its module document's `metadata.name`.
pub fn module_name_of<'g>(graph: &'g LoadedGraph, source: &str) -> Option<&'g str> {
    graph.modules.get(source)?.owner.module_document().and_then(name_of)
}

pub fn import_reach(graph: &LoadedGraph) -> ImportReach {
    let root = module_name_of(graph, &graph.root_source);
    let mut by_owner: HashMap<&str, Vec<&str>> = HashMap::new();
    for (file, aliases) in &graph.import_edges {
        let Some(owner) = module_name_of(graph, file) else { continue };
        for edge in aliases.values() {
            by_owner.entry(owner).or_default().push(&edge.target_module_name);
        }
    }
    let mut first: HashMap<String, ReachingImport> = HashMap::new();
    let Some(entry_imports) = graph.import_edges.get(&graph.root_source) else {
        return ImportReach { first };
    };
    for (alias, edge) in entry_imports {
        let anchor = ReachingImport {
            alias: alias.clone(),
            file_path: graph.root_source.clone(),
            path: format!("imports.{alias}"),
        };
        let mut seen: HashSet<&str> = HashSet::new();
        let mut queue: VecDeque<&str> = VecDeque::from([edge.target_module_name.as_str()]);
        while let Some(module) = queue.pop_front() {
            if Some(module) == root || !seen.insert(module) {
                continue;
            }
            first.entry(module.to_string()).or_insert_with(|| anchor.clone());
            queue.extend(by_owner.get(module).into_iter().flatten().copied());
        }
    }
    ImportReach { first }
}

/// A dependency's refusal, reported at the entry's import reaching it.
pub fn import_anchored_diagnostic(code: &str, module: &str, via: &ReachingImport, message: &str) -> AnalysisDiagnostic {
    AnalysisDiagnostic::error(
        code,
        format!("Imported library '{module}', reached through import '{}': {message}", via.alias),
        DiagnosticData { file_path: Some(via.file_path.clone()), path: Some(via.path.clone()), ..Default::default() },
    )
}
