//! Where each document of a multi-document file starts and where each of its fields sits,
//! mirroring `../../nodejs/src/position-metadata.ts`: the one table both halves anchor a
//! diagnostic with, kept beside the manifest tree and never inside it. Lines are 0-based
//! and characters UTF-16 code units, as in Node.

use telorun_cel_value::es_number;

use crate::types::{Position, PositionIndex, Range};
use crate::yaml_ast::{AstDocument, AstNodeKind, AstScalarValue};

/// Per-document position metadata: the line the document starts on, and its fields' ranges.
#[derive(Debug, Clone)]
pub struct DocumentPosition {
    pub source_line: usize,
    pub position_index: PositionIndex,
}

/// One entry per document of `docs`.
pub fn build_document_positions(text: &str, docs: &[AstDocument]) -> Vec<DocumentPosition> {
    let doc_offsets = document_line_offsets(text);
    let line_offsets = build_line_offsets(text);
    docs.iter()
        .enumerate()
        .map(|(i, doc)| DocumentPosition {
            source_line: doc_offsets.get(i).copied().unwrap_or(0),
            position_index: build_position_index(doc, &line_offsets),
        })
        .collect()
}

/// The 0-based line each document starts on: line 0 for the first, then the line after
/// each `---` separator. A `---` on line 0 opens the first document rather than separating
/// an empty one from it.
pub fn document_line_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    for (i, line) in text.split('\n').enumerate() {
        let trimmed = line.trim_end_matches(is_js_whitespace);
        if trimmed == "---" || trimmed.starts_with("--- ") {
            if i == 0 {
                continue;
            }
            offsets.push(i + 1);
        }
    }
    offsets
}

/// What ECMAScript's `trimEnd` removes.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// The UTF-16 offset each line starts at.
pub fn build_line_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    let mut offset = 0;
    for c in text.chars() {
        offset += c.len_utf16();
        if c == '\n' {
            offsets.push(offset);
        }
    }
    offsets
}

pub fn offset_to_position(offset: usize, line_offsets: &[usize]) -> Position {
    let line = line_offsets.partition_point(|start| *start <= offset).saturating_sub(1);
    Position { line, character: offset - line_offsets[line] }
}

/// Every field value's range, keyed by dotted path (`kind`, `config.routes[0].path`), and
/// every map key's under `@key:<path>`, in document order.
pub fn build_position_index(doc: &AstDocument, line_offsets: &[usize]) -> PositionIndex {
    let mut index = PositionIndex::new();
    let range_of = |id: usize| -> Range {
        let [start, end] = doc.nodes[id].range;
        Range { start: offset_to_position(start, line_offsets), end: offset_to_position(end, line_offsets) }
    };
    let Some(root) = doc.root else { return index };
    // Depth first, each entry filed before the entries beneath it, as Node's walk files them.
    enum Step {
        Walk(usize, String),
        Entry { key: usize, value: Option<usize>, path: String },
        Item(usize, String),
    }
    let mut stack = vec![Step::Walk(root, String::new())];
    while let Some(step) = stack.pop() {
        match step {
            Step::Walk(id, path) => match &doc.nodes[id].kind {
                AstNodeKind::Map { entries } => {
                    for pair in entries.iter().rev() {
                        let AstNodeKind::Scalar { value } = &doc.nodes[pair.key].kind else { continue };
                        let key = js_string(value);
                        let path = if path.is_empty() { key } else { format!("{path}.{key}") };
                        stack.push(Step::Entry { key: pair.key, value: pair.value, path });
                    }
                }
                AstNodeKind::Seq { items } => {
                    for (i, item) in items.iter().enumerate().rev() {
                        stack.push(Step::Item(*item, format!("{path}[{i}]")));
                    }
                }
                AstNodeKind::Scalar { .. } => {}
            },
            Step::Entry { key, value, path } => {
                index.insert(format!("@key:{path}"), range_of(key));
                if let Some(value) = value {
                    index.insert(path.clone(), range_of(value));
                    stack.push(Step::Walk(value, path));
                }
            }
            Step::Item(item, path) => {
                index.insert(path.clone(), range_of(item));
                stack.push(Step::Walk(item, path));
            }
        }
    }
    index
}

/// A scalar key as ECMAScript's `String(value)` writes it.
fn js_string(value: &AstScalarValue) -> String {
    match value {
        AstScalarValue::Null => "null".to_string(),
        AstScalarValue::Bool(b) => b.to_string(),
        AstScalarValue::Number(n) => es_number(*n),
        AstScalarValue::String(s) => s.clone(),
        AstScalarValue::Tagged { .. } => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yaml_ast::parse_to_ast;

    #[test]
    fn a_deep_document_is_indexed_without_recursing_on_its_depth() {
        let depth = 2_000;
        let mut text = String::new();
        for level in 0..depth {
            text.push_str(&" ".repeat(level));
            text.push_str("k:\n");
        }
        let docs = parse_to_ast(&text);
        let positions = build_document_positions(&text, &docs);
        let deepest = vec!["k"; depth].join(".");
        assert_eq!(
            positions[0].position_index.get(&format!("@key:{deepest}")),
            Some(&Range {
                start: Position { line: depth - 1, character: depth - 1 },
                end: Position { line: depth - 1, character: depth },
            })
        );
    }
}
