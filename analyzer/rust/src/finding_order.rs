//! The one order an analysis reports in, mirroring `../../nodejs/src/finding-order.ts`: by
//! where each finding is written, then by what it says — a function of the finding alone,
//! never of the pass that found it.
//!
//! The key, in order:
//!  1. the file — ranked by first appearance in the analysis's document set, then in the
//!     graph; findings naming no file first;
//!  2. the offset in the file, found as a host finds a range: the finding's own range, else
//!     its path, else the nearest written ancestor's key, else the document's start;
//!  3. the path text;
//!  4. the code;
//!  5. the message before its configuration clause;
//!  6. the resource kind, then its name.
//!
//! Text compares by code point, and findings tied on every term keep their order.
//!
//! The document set is Node's flattened one: the entry module's documents, then — each library
//! as the entry's import edges first reach it — the documents a library forwards into its
//! consumer's analysis: its kind documents, its imports and its exported resources. Node also
//! forwards the internal resources an exported function calls and the shapes a contract names;
//! this analysis reports in a library's file only the `requires:` findings of the library's
//! module document, so those differ only for two libraries' such findings when the later one
//! forwards nothing else.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::diagnostic_location::{find_positions, resolve_range};
use crate::loaded_types::{LoadedFile, LoadedGraph};
use crate::module_origin::reached_module_sources;
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, ResourceManifest};

/// The documents a library forwards into its consumer's analysis that this build reads: kind
/// documents, imports, and the resources its `exports.resources` names.
const FORWARDED_KINDS: [&str; 4] = ["Telo.Definition", "Telo.Abstract", "Telo.NeedType", "Telo.Import"];

/// The resource names a library document exports, an entry's name after its alias.
fn exported_names(library: Option<&ResourceManifest>) -> Vec<&str> {
    let entries = library.and_then(|doc| doc.get("exports")).and_then(|exports| exports.get("resources"));
    entries
        .and_then(|entries| entries.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str())
        .map(|entry| match entry.find('.') {
            Some(dot) if dot > 0 => &entry[dot + 1..],
            _ => entry,
        })
        .collect()
}

/// Whether `file` holds a document its library forwards.
fn forwards_a_document(file: &LoadedFile, exported: &[&str]) -> bool {
    file.documents().any(|document| {
        let kind = kind_of(document);
        kind.is_some_and(|kind| FORWARDED_KINDS.contains(&kind))
            || (!kind.is_some_and(is_module_document) && name_of(document).is_some_and(|name| exported.contains(&name)))
    })
}

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
        let mut rank = |file: &'g LoadedFile| {
            let next = ranks.len() as i64;
            ranks.entry(file.source.as_str()).or_insert(next);
        };
        for file in graph.entry().files().filter(|file| file.documents().next().is_some()) {
            rank(file);
        }
        for source in reached_module_sources(graph, &graph.root_source).iter().skip(1) {
            let module = &graph.modules[source.as_str()];
            let exported = exported_names(module.owner.module_document());
            for file in module.files().filter(|file| forwards_a_document(file, &exported)) {
                rank(file);
            }
        }
        for file in graph.files() {
            rank(file);
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
    use std::collections::HashMap;

    use super::{without_configuration_clause, FindingOrder};
    use crate::types::{AnalysisDiagnostic, DiagnosticData, LoadError, ManifestSource, ReadManifest};
    use crate::{load_graph, ManifestLoader};

    struct Files(HashMap<&'static str, &'static str>);

    impl ManifestSource for Files {
        fn supports(&self, _: &str) -> bool {
            true
        }

        fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
            let file = if path.ends_with(".yaml") { path.to_string() } else { format!("{path}/telo.yaml") };
            let text = self.0.get(file.as_str()).ok_or_else(|| LoadError::Io { path: file.clone(), message: "missing".into() })?;
            Ok(ReadManifest { text: text.to_string(), source: file })
        }
    }

    /// A library forwarding no document ranks after one that does, whatever the import order.
    #[test]
    fn ranks_a_library_file_by_the_documents_it_forwards() {
        let files = Files(HashMap::from([
            ("/app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { A: ./a, B: ./b }\n"),
            ("/app/a/telo.yaml", "kind: Telo.Library\nmetadata: { name: ALib }\n"),
            (
                "/app/b/telo.yaml",
                "kind: Telo.Library\nmetadata: { name: BLib }\n---\nkind: Telo.Definition\nmetadata: { name: Greeter }\ncapability: Telo.Invocable\n",
            ),
        ]));
        let graph = load_graph(&ManifestLoader::new(vec![Box::new(files)]), "/app/telo.yaml").expect("graph loads");
        let at = |file: &str| {
            AnalysisDiagnostic::error("X", file, DiagnosticData { file_path: Some(file.to_string()), ..Default::default() })
        };
        let sorted = FindingOrder::new(&graph).sort(vec![at("/app/a/telo.yaml"), at("/app/b/telo.yaml"), at("/app/telo.yaml")]);
        let order: Vec<&str> = sorted.iter().map(|d| d.message.as_str()).collect();
        assert_eq!(order, ["/app/telo.yaml", "/app/b/telo.yaml", "/app/a/telo.yaml"]);
    }

    #[test]
    fn strips_the_configuration_clause() {
        assert_eq!(without_configuration_clause("m (in a branch no configuration takes)"), "m");
        assert_eq!(without_configuration_clause("m (in a branch no value the definition can be given takes)"), "m");
        assert_eq!(without_configuration_clause("m (when mode is 'a')"), "m");
        assert_eq!(without_configuration_clause("m (when mode is 'a') and more"), "m (when mode is 'a') and more");
        assert_eq!(without_configuration_clause("m"), "m");
    }
}
