//! The read-only YAML node model, mirroring `../../nodejs/src/yaml-ast.ts`: each document's
//! maps, sequences and scalars with the ranges the composer gave them (`[start, valueEnd]`
//! in UTF-16 code units), and the tag each was written behind. An alias is not a node of
//! the model, as in Node, so a sequence item or a map value written as one is absent.
//!
//! Node items with no twin: `celSegments`, which nothing in the Rust half reads yet. The
//! model is an arena per document, so nothing walking it recurses on the input's depth.

use telo_templating::{
    compose_yaml, ScalarValue, YamlDocument, YamlNodeKind, YamlScalarStyle, YamlStream, YamlTag,
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

/// Read `text` into the model, one document per document a manifest reader indexes.
pub fn parse_to_ast(text: &str) -> Vec<AstDocument> {
    manifest_documents(text).documents.iter().map(document_to_ast).collect()
}

/// The documents of `text` a manifest reader indexes (`parseManifestDocuments`): every one
/// `yaml` reads except a span holding nothing — no `---` marker, no node and no error, as a
/// leading `...` makes one — with each error's document index counted without them.
pub fn manifest_documents(text: &str) -> YamlStream {
    let stream = compose_yaml(text);
    let mut errored = vec![false; stream.documents.len()];
    for error in &stream.errors {
        errored[error.document_index] = true;
    }
    let mut kept_before = Vec::with_capacity(stream.documents.len());
    let mut documents = Vec::with_capacity(stream.documents.len());
    for (index, document) in stream.documents.into_iter().enumerate() {
        kept_before.push(documents.len());
        if errored[index] || !is_empty_span(&document) {
            documents.push(document);
        }
    }
    let errors = stream
        .errors
        .into_iter()
        .map(|mut error| {
            error.document_index = kept_before[error.document_index];
            error
        })
        .collect();
    YamlStream { documents, errors }
}

/// No `---` marker and nothing but the empty node `yaml` composes where nothing is written.
fn is_empty_span(document: &YamlDocument) -> bool {
    if document.explicit_start {
        return false;
    }
    let Some(root) = document.root else { return true };
    let node = &document.nodes[root];
    matches!(&node.kind, YamlNodeKind::Scalar(scalar)
        if scalar.style == YamlScalarStyle::Plain && scalar.text.is_empty() && scalar.value == ScalarValue::Null)
        && node.tag.is_none()
        && !node.anchored
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
                    ScalarValue::Opaque => AstScalarValue::String(opaque_text(node.tag.as_ref(), &scalar.text)),
                    ScalarValue::Engine => AstScalarValue::Tagged {
                        engine: match &node.tag {
                            Some(YamlTag::Local(name)) => name.clone(),
                            _ => String::new(),
                        },
                        source: scalar.text.clone(),
                    },
                },
            },
            // A `!!pairs` / `!!omap` sequence's items are pairs, which the model does not hold.
            YamlNodeKind::Sequence { items, pairs, .. } => AstNodeKind::Seq {
                items: if *pairs { Vec::new() } else { items.iter().filter_map(|item| ids[*item]).collect() },
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

/// What ECMAScript's `String(value)` writes for the value a `yaml-1.1` tag resolves to — the
/// one reading of such a value the model offers, as a key's text: a `!!binary` value is a
/// `Buffer` (its bytes as UTF-8), `!!merge` a symbol. A `!!timestamp` is a `Date`, whose text
/// depends on the host's time zone; it keeps its source.
fn opaque_text(tag: Option<&YamlTag>, text: &str) -> String {
    match tag {
        Some(YamlTag::Core(name)) if name == "binary" => String::from_utf8_lossy(&node_base64(text)).into_owned(),
        Some(YamlTag::Core(name)) if name == "merge" => "Symbol(<<)".to_string(),
        _ => text.to_string(),
    }
}

/// Node's `Buffer.from(text, 'base64')`: both alphabets, every other character skipped,
/// decoding ending at the first `=`.
fn node_base64(text: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    bytes
}
