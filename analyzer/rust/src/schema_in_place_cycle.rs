//! The one reader of the in-place cycle rule: a schema whose references come back to the node
//! they left at the same data position recurses without bound under any validator, so it is
//! refused where it is declared (`SCHEMA_IN_PLACE_CYCLE`) and nothing is validated against it.
//! Mirrors `../../nodejs/src/schema-in-place-cycle.ts`.
//!
//! A keyword is IN PLACE when it applies its subschema to the value its own node applies to:
//! `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if` / `then` / `else`, `dependencies` /
//! `dependentSchemas`. Every other keyword holding a subschema descends into a part of the
//! value, and recursion through one is how a tree is written.
//!
//! The graph is over REFERENCE NODES — the schema nodes holding a `$ref` — since every cycle
//! crosses a reference. A node's successors are the reference nodes met from the node its
//! reference names through in-place keywords alone.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::manifest_schemas::MANIFEST_SCHEMA_URI;

pub const SCHEMA_IN_PLACE_CYCLE: &str = "SCHEMA_IN_PLACE_CYCLE";

/// The keywords a reference may recurse through, each descending into a part of the value.
pub const DESCENDING_KEYWORDS: [&str; 7] =
    ["properties", "patternProperties", "additionalProperties", "items", "additionalItems", "prefixItems", "contains"];

/// Keywords whose value is data, never a subschema.
const DATA_KEYWORDS: [&str; 4] = ["const", "enum", "default", "examples"];

fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// Percent-decoding as `decodeURIComponent` reads it, or `None` where it refuses.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The segments of a JSON Pointer fragment, URI- and tilde-decoded.
pub fn pointer_segments(pointer: &str) -> Vec<String> {
    let pointer = pointer.strip_prefix('#').unwrap_or(pointer);
    pointer
        .split('/')
        .skip(1)
        .map(|segment| {
            // A segment that is not URI-encoded is read as written.
            let decoded = decode_uri_component(segment).unwrap_or_else(|| segment.to_string());
            decoded.replace("~1", "/").replace("~0", "~")
        })
        .collect()
}

/// A pointer in the one spelling every node of the graph is keyed by.
pub fn canonical_pointer(pointer: &str) -> String {
    let segments = pointer_segments(pointer);
    if segments.is_empty() {
        return "#".to_string();
    }
    format!("#/{}", segments.iter().map(|s| escape_segment(s)).collect::<Vec<_>>().join("/"))
}

/// The node `pointer` names in `document`.
pub fn node_at<'d>(document: &'d Value, pointer: &str) -> Option<&'d Value> {
    let mut node = document;
    for segment in pointer_segments(pointer) {
        node = match node {
            Value::Object(map) => map.get(&segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(node)
}

/// A `$ref` a document writes: the pointer of the node holding it, and the reference as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrittenReference {
    pub at: String,
    pub reference: String,
}

/// Every reference `document` writes, at any keyword, in written order.
pub fn written_references(document: &Value) -> Vec<WrittenReference> {
    let mut out = Vec::new();
    let mut work: Vec<(&Value, String)> = vec![(document, "#".to_string())];
    while let Some((node, at)) = work.pop() {
        match node {
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate().rev() {
                    work.push((item, format!("{at}/{i}")));
                }
            }
            Value::Object(map) => {
                if let Some(Value::String(reference)) = map.get("$ref") {
                    out.push(WrittenReference { at: at.clone(), reference: reference.clone() });
                }
                let children: Vec<_> = map
                    .iter()
                    .filter(|(key, _)| key.as_str() != "$ref" && !DATA_KEYWORDS.contains(&key.as_str()))
                    .collect();
                for (key, child) in children.into_iter().rev() {
                    work.push((child, format!("{at}/{}", escape_segment(key))));
                }
            }
            _ => {}
        }
    }
    out
}

/// The references met from the node at `pointer` of `document` through in-place keywords
/// alone, the node's own included.
pub fn in_place_references(document: &Value, pointer: &str) -> Vec<WrittenReference> {
    let mut out = Vec::new();
    let start = canonical_pointer(pointer);
    let Some(node) = node_at(document, &start) else { return out };
    let mut work: Vec<(&Value, String)> = vec![(node, start)];
    while let Some((node, at)) = work.pop() {
        let Value::Object(map) = node else { continue };
        if let Some(Value::String(reference)) = map.get("$ref") {
            out.push(WrittenReference { at: at.clone(), reference: reference.clone() });
        }
        let mut children: Vec<(&Value, String)> = Vec::new();
        for key in ["allOf", "anyOf", "oneOf"] {
            if let Some(Value::Array(list)) = map.get(key) {
                for (i, child) in list.iter().enumerate() {
                    children.push((child, format!("{at}/{key}/{i}")));
                }
            }
        }
        for key in ["not", "if", "then", "else"] {
            if let Some(child) = map.get(key) {
                children.push((child, format!("{at}/{key}")));
            }
        }
        // `dependencies` holds a property list or a schema per key; only a schema applies.
        for key in ["dependentSchemas", "dependencies"] {
            if let Some(Value::Object(entries)) = map.get(key) {
                for (name, child) in entries {
                    children.push((child, format!("{at}/{key}/{}", escape_segment(name))));
                }
            }
        }
        for child in children.into_iter().rev() {
            work.push(child);
        }
    }
    out
}

/// Where a reference lands: a document and the pointer into it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InPlaceTarget {
    pub document: String,
    pub pointer: String,
}

/// A reference as the graph reads it: `reference` at `at` of `document` names `target`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InPlaceHop {
    pub document: String,
    pub at: String,
    pub reference: String,
    pub target: InPlaceTarget,
}

/// The documents a search reads.
pub trait InPlaceGraph {
    /// The schema a document holds, or `None` when nothing answers it.
    fn document_of(&self, document: &str) -> Option<Value>;
    /// Where a reference written in `document` lands, or `None` when the search does not
    /// follow it.
    fn target_of(&self, reference: &str, document: &str) -> Option<InPlaceTarget>;
}

/// The target of `reference` written in `document` for a search answering named documents
/// through `has`: a local pointer stays in `document`, any other reference names the document
/// before its `#` — but the built-in manifest fragments, which hold no author schema.
pub fn lookup_target(reference: &str, document: &str, has: impl Fn(&str) -> bool) -> Option<InPlaceTarget> {
    let (shape, pointer) = match reference.find('#') {
        Some(at) => (&reference[..at], &reference[at..]),
        None => (reference, "#"),
    };
    if shape.is_empty() {
        return Some(InPlaceTarget { document: document.to_string(), pointer: canonical_pointer(pointer) });
    }
    if shape == MANIFEST_SCHEMA_URI || !has(shape) {
        return None;
    }
    Some(InPlaceTarget { document: shape.to_string(), pointer: canonical_pointer(pointer) })
}

#[derive(Clone)]
struct Node {
    key: String,
    document: String,
    at: String,
    reference: String,
}

fn node_key(document: &str, at: &str) -> String {
    format!("{document}\u{0}{at}")
}

/// The reference graph of a search, its successors memoised.
struct PlainGraph<'g> {
    graph: &'g dyn InPlaceGraph,
    successors: HashMap<String, Vec<(Node, InPlaceHop)>>,
}

impl<'g> PlainGraph<'g> {
    fn new(graph: &'g dyn InPlaceGraph) -> Self {
        Self { graph, successors: HashMap::new() }
    }

    fn nodes_of(&self, document: &str) -> Vec<Node> {
        let Some(schema) = self.graph.document_of(document) else { return Vec::new() };
        written_references(&schema)
            .into_iter()
            .map(|WrittenReference { at, reference }| Node {
                key: node_key(document, &at),
                document: document.to_string(),
                at,
                reference,
            })
            .collect()
    }

    fn successors(&mut self, node: &Node) -> Vec<(Node, InPlaceHop)> {
        if let Some(known) = self.successors.get(&node.key) {
            return known.clone();
        }
        let mut out = Vec::new();
        if let Some(target) = self.graph.target_of(&node.reference, &node.document) {
            if let Some(schema) = self.graph.document_of(&target.document) {
                let hop = InPlaceHop {
                    document: node.document.clone(),
                    at: node.at.clone(),
                    reference: node.reference.clone(),
                    target: target.clone(),
                };
                for WrittenReference { at, reference } in in_place_references(&schema, &target.pointer) {
                    out.push((
                        Node { key: node_key(&target.document, &at), document: target.document.clone(), at, reference },
                        hop.clone(),
                    ));
                }
            }
        }
        self.successors.insert(node.key.clone(), out.clone());
        out
    }
}

/// The first in-place cycle through a reference `document` writes, as the hops that close
/// it in order, or `None` when there is none.
pub fn in_place_cycle_through(document: &str, graph: &dyn InPlaceGraph) -> Option<Vec<InPlaceHop>> {
    let mut plain = PlainGraph::new(graph);
    for seed in plain.nodes_of(document) {
        if let Some(cycle) = cycle_back(&seed, &mut plain) {
            return Some(cycle);
        }
    }
    None
}

/// The hops of a path from `seed` back to itself, breadth first.
fn cycle_back(seed: &Node, plain: &mut PlainGraph) -> Option<Vec<InPlaceHop>> {
    let mut parent: HashMap<String, (String, InPlaceHop)> = HashMap::new();
    let mut queue: VecDeque<Node> = VecDeque::from([seed.clone()]);
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(node) = queue.pop_front() {
        for (next, hop) in plain.successors(&node) {
            if next.key == seed.key {
                let mut hops = vec![hop];
                let mut at = node.key.clone();
                while at != seed.key {
                    let (from, step) = parent.get(&at).expect("a node reached has a parent").clone();
                    hops.insert(0, step);
                    at = from;
                }
                return Some(hops);
            }
            if !seen.insert(next.key.clone()) {
                continue;
            }
            parent.insert(next.key.clone(), (node.key.clone(), hop));
            queue.push_back(next);
        }
    }
    None
}

const ROOT_DOCUMENT: &str = "\u{0}root";

/// Whether a schema reaches an in-place cycle through any keyword — the question a validator
/// asks before it validates a value against the schema. Named documents are answered by
/// `lookup`.
pub fn recurses_in_place(schema: &Value, lookup: &dyn Fn(&str) -> Option<Value>) -> bool {
    struct Guarded<'l> {
        root: &'l Value,
        lookup: &'l dyn Fn(&str) -> Option<Value>,
    }
    impl InPlaceGraph for Guarded<'_> {
        fn document_of(&self, document: &str) -> Option<Value> {
            if document == ROOT_DOCUMENT {
                Some(self.root.clone())
            } else {
                (self.lookup)(document)
            }
        }
        fn target_of(&self, reference: &str, document: &str) -> Option<InPlaceTarget> {
            lookup_target(reference, document, |id| (self.lookup)(id).is_some())
        }
    }
    let graph = Guarded { root: schema, lookup };
    let mut plain = PlainGraph::new(&graph);
    // Every document reached through any reference, each read whole.
    let mut nodes: Vec<Node> = Vec::new();
    let mut pending = vec![ROOT_DOCUMENT.to_string()];
    let mut read: HashSet<String> = pending.iter().cloned().collect();
    while let Some(document) = pending.pop() {
        for node in plain.nodes_of(&document) {
            if let Some(target) = graph.target_of(&node.reference, &document) {
                if read.insert(target.document.clone()) {
                    pending.push(target.document.clone());
                }
            }
            nodes.push(node);
        }
    }
    holds_cycle(&nodes, &mut plain)
}

/// Whether the reference graph over `nodes` holds a cycle: a depth-first walk meeting a node
/// still on its path.
fn holds_cycle(nodes: &[Node], plain: &mut PlainGraph) -> bool {
    let mut state: HashMap<String, u8> = HashMap::new();
    for start in nodes {
        if state.contains_key(&start.key) {
            continue;
        }
        state.insert(start.key.clone(), 1);
        let mut stack: Vec<(Node, usize)> = vec![(start.clone(), 0)];
        while let Some((top, next)) = stack.last().cloned() {
            let successors = plain.successors(&top);
            if next >= successors.len() {
                state.insert(top.key.clone(), 2);
                stack.pop();
                continue;
            }
            stack.last_mut().expect("the top frame").1 += 1;
            let following = &successors[next].0;
            match state.get(&following.key) {
                Some(1) => return true,
                Some(_) => {}
                None => {
                    state.insert(following.key.clone(), 1);
                    stack.push((following.clone(), 0));
                }
            }
        }
    }
    false
}

/// A pointer as a message quotes it: its root as the document itself.
fn pointer_text(pointer: &str) -> String {
    if pointer == "#" {
        String::new()
    } else {
        pointer.strip_prefix("#/").unwrap_or(pointer).to_string()
    }
}

/// The refusal's sentence, after `owner` (`'S'`): the hops of the cycle in order, each
/// document named by `label`.
pub fn in_place_cycle_message(owner: &str, hops: &[InPlaceHop], label: &dyn Fn(&str) -> String) -> String {
    let at = |pointer: &str, document: &str| {
        if pointer == "#" {
            label(document)
        } else {
            format!("'{}' of {}", pointer_text(pointer), label(document))
        }
    };
    let target = |hop: &InPlaceHop| {
        let pointer = if hop.target.pointer == "#" { String::new() } else { format!(" at '{}'", pointer_text(&hop.target.pointer)) };
        format!("{}{pointer}", label(&hop.target.document))
    };
    let chain = hops
        .iter()
        .enumerate()
        .map(|(i, hop)| {
            let written = format!("{} refers to {}", at(&hop.at, &hop.document), target(hop));
            if i == 0 {
                written
            } else {
                format!("where {written}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (last, rest) = DESCENDING_KEYWORDS.split_last().expect("descending keywords");
    format!(
        "{owner}: its schema comes back to where it started without descending into the value — {chain} — so validating any value against it never ends. A schema may refer back to itself only beneath {} or '{last}'.",
        rest.iter().map(|keyword| format!("'{keyword}'")).collect::<Vec<_>>().join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_cycle(schema: &Value) -> Option<Vec<InPlaceHop>> {
        struct Local<'s>(&'s Value);
        impl InPlaceGraph for Local<'_> {
            fn document_of(&self, document: &str) -> Option<Value> {
                (document == "schema").then(|| self.0.clone())
            }
            fn target_of(&self, reference: &str, document: &str) -> Option<InPlaceTarget> {
                lookup_target(reference, document, |_| false)
            }
        }
        in_place_cycle_through("schema", &Local(schema))
    }

    #[test]
    fn a_reference_back_to_its_own_node_is_a_cycle_one_descending_is_not() {
        assert!(local_cycle(&serde_json::json!({ "type": "object", "$ref": "#" })).is_some());
        let tree = serde_json::json!({ "type": "object", "properties": { "tree": { "$ref": "#" } } });
        assert!(local_cycle(&tree).is_none());
        assert!(!recurses_in_place(&tree, &|_| None));
        assert!(recurses_in_place(&serde_json::json!({ "anyOf": [{ "$ref": "#" }] }), &|_| None));
    }

    #[test]
    fn the_message_names_each_reference_closing_the_cycle() {
        let schema = serde_json::json!({ "$defs": { "Loop": { "type": "object", "$ref": "#/$defs/Loop" } } });
        let cycle = local_cycle(&schema).expect("a cycle");
        assert_eq!(
            in_place_cycle_message("'Router'", &cycle, &|document| document.to_string()),
            "'Router': its schema comes back to where it started without descending into the value — '$defs/Loop' of schema refers to schema at '$defs/Loop' — so validating any value against it never ends. A schema may refer back to itself only beneath 'properties', 'patternProperties', 'additionalProperties', 'items', 'additionalItems', 'prefixItems' or 'contains'."
        );
    }
}
