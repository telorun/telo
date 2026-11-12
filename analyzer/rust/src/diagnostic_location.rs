//! Where a diagnostic is shown, mirroring `../../nodejs/src/diagnostic-location.ts`: its
//! owning file found by the resource it names, else by the file it carries, and its range
//! by the fallback chain — its own range, the position of its path or of the nearest
//! parent's key, the line its document starts on, then the file's start.

use telo_templating::expansion_tag_of;

use crate::loaded_types::LoadedGraph;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, Position, PositionIndex, Range};

/// What a diagnostic's owning file exposes for locating it.
pub struct DiagnosticPositions<'g> {
    pub file: String,
    pub position_index: Option<&'g PositionIndex>,
    pub source_line: Option<usize>,
}

/// Which file owns a diagnostic, and what positions that file's parse exposes: the document
/// declaring `data.resource` — in the file `data.filePath` names when it names one, else in
/// any file of the graph — and otherwise the file `data.filePath` names.
pub fn find_positions<'g>(graph: &'g LoadedGraph, data: Option<&DiagnosticData>) -> Option<DiagnosticPositions<'g>> {
    let data = data?;
    if let Some(resource) = data.resource.as_ref().filter(|r| !r.kind.is_empty() && !r.name.is_empty()) {
        let found = data
            .file_path
            .as_deref()
            .and_then(|file| find_by_resource(graph, &resource.kind, &resource.name, Some(file)))
            .or_else(|| find_by_resource(graph, &resource.kind, &resource.name, None));
        if found.is_some() {
            return found;
        }
    }
    let file = data.file_path.as_deref()?;
    let module = graph.modules.values().find(|module| module.owner.source == file)?;
    let position = module.owner.positions.first();
    Some(DiagnosticPositions {
        file: module.owner.source.clone(),
        position_index: position.map(|p| &p.position_index),
        source_line: position.map(|p| p.source_line),
    })
}

fn find_by_resource<'g>(
    graph: &'g LoadedGraph,
    kind: &str,
    name: &str,
    in_file: Option<&str>,
) -> Option<DiagnosticPositions<'g>> {
    for module in graph.modules.values() {
        let file = &module.owner;
        if in_file.is_some_and(|wanted| wanted != file.source) {
            continue;
        }
        for (index, manifest) in file.manifests.iter().enumerate() {
            let Some(manifest) = manifest else { continue };
            // A whole document behind an expansion tag is reported under its tag (`!if`).
            let written = match kind_of(manifest) {
                Some(kind) => kind.to_string(),
                None => match expansion_tag_of(manifest) {
                    Some(tag) => format!("!{tag}"),
                    None => continue,
                },
            };
            if written != kind || name_of(manifest) != Some(name) {
                continue;
            }
            let position = file.positions.get(index);
            return Some(DiagnosticPositions {
                file: file.source.clone(),
                position_index: position.map(|p| &p.position_index),
                source_line: position.map(|p| p.source_line),
            });
        }
    }
    None
}

const ZERO_RANGE: Range = Range { start: Position { line: 0, character: 0 }, end: Position { line: 0, character: 0 } };

/// JavaScript's `Number.MAX_SAFE_INTEGER`: the end of a whole-line span.
const LINE_END: usize = 9_007_199_254_740_991;

/// The range a diagnostic is shown at: its own range; the position of its `data.path`; for
/// a path not in the file, the nearest parent's key (else its value); the whole line its
/// document starts on; the file's start.
pub fn resolve_range(d: &AnalysisDiagnostic, position_index: Option<&PositionIndex>, source_line: Option<usize>) -> Range {
    if let Some(range) = d.range {
        return range;
    }
    let path = d.data.as_ref().and_then(|data| data.path.as_deref());
    if let (Some(path), Some(index)) = (path, position_index) {
        if let Some(direct) = index.get(path) {
            return *direct;
        }
        for parent in parent_paths(path).into_iter().skip(1) {
            if let Some(key) = index.get(&format!("@key:{parent}")) {
                return *key;
            }
            if let Some(value) = index.get(&parent) {
                return *value;
            }
        }
    }
    match source_line {
        Some(line) => Range { start: Position { line, character: 0 }, end: Position { line, character: LINE_END } },
        None => ZERO_RANGE,
    }
}

/// Where a diagnostic is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocatedDiagnostic {
    /// Its owning file, absent when only its own range placed it.
    pub file: Option<String>,
    pub range: Range,
}

/// Where a diagnostic is, as every host reports it; `None` when nothing locates it.
pub fn locate_diagnostic(graph: &LoadedGraph, d: &AnalysisDiagnostic) -> Option<LocatedDiagnostic> {
    let located = find_positions(graph, d.data.as_ref());
    if located.is_none() && d.range.is_none() {
        return None;
    }
    let range = resolve_range(
        d,
        located.as_ref().and_then(|p| p.position_index),
        located.as_ref().and_then(|p| p.source_line),
    );
    Some(LocatedDiagnostic { file: located.map(|p| p.file), range })
}

/// `path`, then each shorter parent: `routes[0].handler` → `routes[0].handler`,
/// `routes[0]`, `routes`.
fn parent_paths(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = path.to_string();
    while !current.is_empty() {
        out.push(current.clone());
        let cut = current.rfind('.').max(current.rfind('[')).unwrap_or(0);
        if cut == 0 {
            break;
        }
        current.truncate(cut);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DiagnosticData;

    #[test]
    fn walks_a_path_up_to_its_parents() {
        assert_eq!(parent_paths("routes[0].handler"), ["routes[0].handler", "routes[0]", "routes"]);
        assert_eq!(parent_paths("kind"), ["kind"]);
    }

    fn at(line: usize, character: usize) -> Range {
        Range { start: Position { line, character }, end: Position { line, character: character + 1 } }
    }

    #[test]
    fn falls_back_from_the_path_to_a_parent_key_to_the_document_line() {
        let mut index = PositionIndex::new();
        index.insert("@key:secrets".into(), at(3, 0));
        index.insert("secrets".into(), at(4, 2));
        let d = |path: &str| {
            AnalysisDiagnostic::error("X", "m", DiagnosticData { path: Some(path.into()), ..Default::default() })
        };
        assert_eq!(resolve_range(&d("secrets"), Some(&index), Some(1)), at(4, 2));
        assert_eq!(resolve_range(&d("secrets.key.type"), Some(&index), Some(1)), at(3, 0));
        assert_eq!(
            resolve_range(&d("other"), Some(&index), Some(1)),
            Range { start: Position { line: 1, character: 0 }, end: Position { line: 1, character: LINE_END } }
        );
        assert_eq!(resolve_range(&d("other"), None, None), ZERO_RANGE);
    }
}
