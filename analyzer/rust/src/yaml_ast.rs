//! The read-only YAML node model, mirroring `../../nodejs/src/yaml-ast.ts`: each document's
//! maps, sequences and scalars with the ranges the composer gave them (`[start, valueEnd]`
//! in UTF-16 code units), and the tag each was written behind. An alias is not a node of
//! the model, as in Node, so a sequence item or a map value written as one is absent.
//!
//! Node items with no twin: `celSegments`, which nothing in the Rust half reads yet. The
//! model is an arena per document, so nothing walking it recurses on the input's depth.

use telo_templating::{
    compose_yaml, ScalarValue, YamlDocument, YamlNodeKind, YamlTag,
};

/// What a scalar resolves to; a scalar behind an engine's tag is the tagged sentinel the
/// loaders build, named here by its engine and source.
#[derive(Debug, Clone, PartialEq)]
pub enum AstScalarValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Tagged { engine: String, source: String },
}

#[derive(Debug, Clone)]
pub struct AstPair {
    pub key: usize,
    pub value: Option<usize>,
}

#[derive(Debug, Clone)]
pub enum AstNodeKind {
    Map { entries: Vec<AstPair> },
    Seq { items: Vec<usize> },
    Scalar { value: AstScalarValue },
}

#[derive(Debug, Clone)]
pub struct AstNode {
    pub kind: AstNodeKind,
    pub range: [usize; 2],
    /// The tag as `yaml` names it (`!cel`, `!if`, `tag:yaml.org,2002:str`).
    pub tag: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AstDocument {
    pub nodes: Vec<AstNode>,
    pub root: Option<usize>,
    /// The whole document's span, used to select the document an offset falls in.
    pub range: [usize; 2],
}

/// Read `text` into the model, one document per YAML document read.
pub fn parse_to_ast(text: &str) -> Vec<AstDocument> {
    compose_yaml(text).documents.iter().map(document_to_ast).collect()
}

/// Adapt one composed document.
pub fn document_to_ast(doc: &YamlDocument) -> AstDocument {
    let mut nodes: Vec<AstNode> = Vec::new();
    let mut ids: Vec<Option<usize>> = vec![None; doc.nodes.len()];
    // A collection enters the arena before its children, so one pass in reverse arena order
    // adapts every child before the node holding it.
    for (id, node) in doc.nodes.iter().enumerate().rev() {
        let kind = match &node.kind {
            YamlNodeKind::Alias { .. } => continue,
            YamlNodeKind::Scalar(scalar) => AstNodeKind::Scalar {
                value: match scalar.value {
                    ScalarValue::Null => AstScalarValue::Null,
                    ScalarValue::Bool(b) => AstScalarValue::Bool(b),
                    ScalarValue::Number(n) => AstScalarValue::Number(n),
                    ScalarValue::String => AstScalarValue::String(scalar.text.clone()),
                    ScalarValue::Engine => AstScalarValue::Tagged {
                        engine: match &node.tag {
                            Some(YamlTag::Local(name)) => name.clone(),
                            _ => String::new(),
                        },
                        source: scalar.text.clone(),
                    },
                },
            },
            YamlNodeKind::Sequence { items, .. } => AstNodeKind::Seq {
                items: items.iter().filter_map(|item| ids[*item]).collect(),
            },
            YamlNodeKind::Mapping { entries, .. } => AstNodeKind::Map {
                entries: entries
                    .iter()
                    .filter_map(|entry| {
                        let key = ids[entry.key]?;
                        Some(AstPair { key, value: entry.value.and_then(|value| ids[value]) })
                    })
                    .collect(),
            },
        };
        ids[id] = Some(nodes.len());
        nodes.push(AstNode { kind, range: node.range, tag: node.tag.as_ref().map(YamlTag::yaml_name) });
    }
    AstDocument { root: doc.root.and_then(|root| ids[root]), nodes, range: doc.range }
}
