//! The one order an analysis reports in, mirroring `../../nodejs/src/finding-order.ts`: by
//! where each finding is written, then by what it says — a function of the finding alone,
//! never of the pass that found it.
//!
//! The key, in order:
//!  1. the file — ranked by first appearance in the graph, the entry's first; findings
//!     naming no file first;
//!  2. the offset in the file, found as a host finds a range: the finding's own range, else
//!     its path, else the nearest written ancestor's key, else the document's start;
//!  3. the path text;
//!  4. the code;
//!  5. the message before its configuration clause;
//!  6. the resource kind, then its name.
//!
//! Text compares by code point, and findings tied on every term keep their order.
//!
//! Node ranks the files of its flattened document set first, where a library's file appears
//! only when it forwards a document; this analysis reports nothing in a library's file — a
//! dependency's finding is reported at the entry's import — so the two ranks agree on every
//! finding it makes.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::diagnostic_location::{find_positions, resolve_range};
use crate::loaded_types::LoadedGraph;
use crate::types::AnalysisDiagnostic;

const CLAUSE_SUFFIXES: [&str; 2] = [
    " (in a branch no configuration takes)",
    " (in a branch no value the definition can be given takes)",
];

/// `message` without the configuration clause a merge or a label appended.
fn without_configuration_clause(message: &str) -> &str {
    for suffix in CLAUSE_SUFFIXES {
        if let Some(stripped) = message.strip_suffix(suffix) {
            return stripped;
        }
    }
    match message.rfind(" (when ") {
        Some(at) if message.ends_with(')') => &message[..at],
        _ => message,
    }
}

struct Key {
    /// `-1` for a finding naming no file; a file the graph does not hold ranks after every
    /// one it does.
    file: i64,
    file_text: String,
    line: usize,
    character: usize,
    path: String,
    code: String,
    message: String,
    kind: String,
    name: String,
    range: String,
}

pub struct FindingOrder<'g> {
    graph: &'g LoadedGraph,
    ranks: HashMap<&'g str, i64>,
}

impl<'g> FindingOrder<'g> {
    pub fn new(graph: &'g LoadedGraph) -> Self {
        let mut ranks = HashMap::new();
        for file in graph.files() {
            let next = ranks.len() as i64;
            ranks.entry(file.source.as_str()).or_insert(next);
        }
        Self { graph, ranks }
    }

    /// `findings` sorted by the key; findings tied on every term keep their order.
    pub fn sort(&self, findings: Vec<AnalysisDiagnostic>) -> Vec<AnalysisDiagnostic> {
        let mut keyed: Vec<(Key, AnalysisDiagnostic)> = findings.into_iter().map(|d| (self.key_of(&d), d)).collect();
        // `sort_by` is stable.
        keyed.sort_by(|(a, _), (b, _)| compare_keys(a, b));
        keyed.into_iter().map(|(_, d)| d).collect()
    }

    fn key_of(&self, d: &AnalysisDiagnostic) -> Key {
        let data = d.data.as_ref();
        let located = find_positions(self.graph, data);
        let file = data.and_then(|data| data.file_path.clone()).or_else(|| located.as_ref().map(|p| p.file.clone()));
        let (line, character) = match &located {
            Some(positions) => {
                let range = resolve_range(d, positions.position_index, positions.source_line);
                (range.start.line, range.start.character)
            }
            None => (0, 0),
        };
        let resource = data.and_then(|data| data.resource.as_ref());
        Key {
            file: match &file {
                None => -1,
                Some(file) => self.ranks.get(file.as_str()).copied().unwrap_or(self.ranks.len() as i64),
            },
            file_text: file.unwrap_or_default(),
            line,
            character,
            path: data.and_then(|data| data.path.clone()).unwrap_or_default(),
            code: d.code.clone().unwrap_or_default(),
            message: without_configuration_clause(&d.message).to_string(),
            kind: resource.map(|r| r.kind.clone()).unwrap_or_default(),
            name: resource.map(|r| r.name.clone()).unwrap_or_default(),
            range: d.range.map(|range| serde_json::to_string(&range).expect("a range serializes")).unwrap_or_default(),
        }
    }
}

/// UTF-8 bytes order as code points do.
fn compare_keys(a: &Key, b: &Key) -> Ordering {
    a.file
        .cmp(&b.file)
        .then_with(|| a.file_text.cmp(&b.file_text))
        .then_with(|| a.line.cmp(&b.line))
        .then_with(|| a.character.cmp(&b.character))
        .then_with(|| a.path.cmp(&b.path))
        .then_with(|| a.code.cmp(&b.code))
        .then_with(|| a.message.cmp(&b.message))
        .then_with(|| a.kind.cmp(&b.kind))
        .then_with(|| a.name.cmp(&b.name))
        .then_with(|| a.range.cmp(&b.range))
}

#[cfg(test)]
mod tests {
    use super::without_configuration_clause;

    #[test]
    fn strips_the_configuration_clause() {
        assert_eq!(without_configuration_clause("m (in a branch no configuration takes)"), "m");
        assert_eq!(without_configuration_clause("m (in a branch no value the definition can be given takes)"), "m");
        assert_eq!(without_configuration_clause("m (when mode is 'a')"), "m");
        assert_eq!(without_configuration_clause("m (when mode is 'a') and more"), "m (when mode is 'a') and more");
        assert_eq!(without_configuration_clause("m"), "m");
    }
}
