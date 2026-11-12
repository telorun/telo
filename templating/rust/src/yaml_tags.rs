//! YAML tag handling — the single place tag configuration lives, mirroring
//! `../../nodejs/src/yaml-tags.ts`.
//!
//! The Node implementation hands the `yaml` parser a `customTags` array built from the
//! engine registry, and `doc.toJSON()` applies it. The Rust composer
//! (`yaml_composer.rs`) keeps tags on its nodes instead, so the equivalent configuration is
//! this conversion of a composed document to the plain-JSON manifest tree: a tag is an
//! engine when the registry holds it, each recognised one becomes a [`crate::sentinel`]
//! marker object, an expansion tag's mapping loads with its marker first, and aliases
//! expand as `yaml` expands them, under its `maxAliasCount` bound.
//!
//! Node items with no twin: `stringify` / `identify`, which serve the editor's round trip —
//! no Rust reader writes YAML back.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value as Json};
use telorun_cel_value::es_number;

use crate::engines::include::{INCLUDE_BYTES_ENGINE, INCLUDE_TEXT_ENGINE};
use crate::engines::module_path::MODULE_PATH_ENGINE;
use crate::expansion_tags::{expansion_shape_code, expansion_tag_keys, is_expansion_tag, EXPANSION_MARKER};
use crate::sentinel::{make_tagged_sentinel, REF_ENGINE};
use crate::yaml_composer::{NodeId, ScalarValue, YamlDocument, YamlNode, YamlNodeKind, YamlScalar, YamlTag};

/// Engines this kernel reads.
///
/// The two `!include-*` tags ARE here, because the tag set is part of what a
/// manifest means and a kernel that silently skipped them would read an embedded
/// file as an unresolved marker. `kernel/rust` resolves them at resource
/// creation; `!include-bytes` fails there with an explicit message, since this
/// kernel's manifest tree is `serde_json::Value` and has no bytes variant to
/// carry the result. `!module-path` resolves there too, to an absolute path.
const KNOWN_ENGINES: &[&str] = &[
    REF_ENGINE,
    INCLUDE_TEXT_ENGINE,
    INCLUDE_BYTES_ENGINE,
    MODULE_PATH_ENGINE,
];

/// Tags whose scalar holds CEL — the whole scalar under `!cel`, each `${{ }}`
/// hole under `!interpolate` and `!sql`. This kernel has no expression engine,
/// and reading one as an opaque value would evaluate it as a literal, so each is
/// refused by name rather than as an unknown tag.
const EXPRESSION_ENGINES: &[&str] = &["cel", "interpolate", "sql"];

/// How far a document's aliases may multiply its data: `yaml`'s `maxAliasCount`. One bound
/// with the Node loader's `MAX_ALIAS_COUNT` (`analyzer/nodejs/src/parse-loaded-file.ts`),
/// which hands it to `yaml` by name; the two change together.
const MAX_ALIAS_COUNT: u64 = 100;

/// How deep the JSON tree may nest — the bound the Rust reader has always had. Every reader
/// of a `serde_json::Value` (its drop included) recurses on it, so a deeper document is
/// refused before any part of it is built; the composed document itself has no bound.
const MAX_DEPTH: usize = 128;

/// The refusal of a document nesting past [`MAX_DEPTH`].
pub const NESTING_REFUSAL: &str =
    "the document nests deeper than 128 levels here, which this kernel's manifest tree does not hold";

/// A construct this reader cannot hold, which the Node loader reads: never a diagnostic, a
/// refusal of the Rust kernel's load alone. Each variant names the condition that retires it.
#[derive(Debug, Clone, PartialEq)]
pub enum UnsupportedConstruct {
    /// A tag holding CEL. Retired when the Rust kernel evaluates expressions.
    ExpressionTag { engine: String },
    /// A plain string holding `${{` — the legacy spelling the Node loader migrates. Retired
    /// when this reader runs the `untagged-interpolation` migration.
    UntaggedInterpolation { text: String },
    /// A tag this reader does not read, or a known one on a node it cannot be read on
    /// (`written_on`: a collection). Retired when the manifest tree holds what `yaml`
    /// makes of every tag.
    UnsupportedTag { tag: String, written_on: Option<&'static str> },
    /// A mapping key that is no scalar: a collection, or a scalar behind a tag (`written`
    /// says which). Retired when the two loaders agree on a refusal of such a key.
    CollectionKey { written: String },
    /// `.inf` / `.nan`. Retired when the manifest tree holds a non-finite number.
    NonFiniteNumber { value: f64 },
    /// A tree deeper than [`MAX_DEPTH`]. Retired when no reader of the tree recurses on it.
    TreeDepth,
    /// Flow collections nested past saphyr's 255 levels. Retired when the event source
    /// reads any depth.
    FlowDepth,
    /// An alias inside the value its own anchor names. Retired when the two loaders agree on
    /// a refusal of a value containing itself.
    SelfContainingAlias,
}

impl UnsupportedConstruct {
    /// The one sentence each construct is refused with.
    pub fn message(&self) -> String {
        match self {
            UnsupportedConstruct::ExpressionTag { engine } => format!(
                "`!{engine}` holds CEL, and this kernel has no expression engine: reading it as a literal would silently produce the wrong value"
            ),
            UnsupportedConstruct::UntaggedInterpolation { text } => format!(
                "plain string {text:?} holds `${{{{`: untagged interpolation is a legacy spelling of `!cel` / `!interpolate`, and this kernel has no expression engine to evaluate either — reading it as a literal string would silently produce the wrong value"
            ),
            UnsupportedConstruct::UnsupportedTag { tag, written_on: Some(written) } => {
                format!("`{tag}` expects a scalar string, got {written}")
            }
            UnsupportedConstruct::UnsupportedTag { tag, written_on: None } => format!(
                "unsupported YAML tag `{tag}`; this kernel recognises: {}",
                KNOWN_ENGINES.iter().map(|e| format!("!{e}")).collect::<Vec<_>>().join(", ")
            ),
            UnsupportedConstruct::CollectionKey { written } => {
                format!("manifest mapping keys must be scalars, got {written}")
            }
            UnsupportedConstruct::NonFiniteNumber { value } => {
                format!("number {} has no JSON representation", es_number(*value))
            }
            UnsupportedConstruct::TreeDepth | UnsupportedConstruct::FlowDepth => NESTING_REFUSAL.to_string(),
            UnsupportedConstruct::SelfContainingAlias => "this alias sits inside the value its anchor names, so the value would contain itself, which a manifest tree cannot hold".to_string(),
        }
    }
}

/// Why the tag layer refuses a node: a refusal both loaders name under one code, or a
/// construct only this reader cannot hold.
#[derive(Debug, Clone, PartialEq)]
pub enum TagRefusal {
    Loader { code: &'static str, message: String },
    Unsupported(UnsupportedConstruct),
}

#[derive(Debug)]
pub struct TagError {
    pub refusal: TagRefusal,
    /// The refused node's `[start, valueEnd]`, in UTF-16 code units.
    pub range: Option<[usize; 2]>,
}

impl std::fmt::Display for TagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.refusal {
            TagRefusal::Loader { message, .. } => f.write_str(message),
            TagRefusal::Unsupported(construct) => f.write_str(&construct.message()),
        }
    }
}

impl std::error::Error for TagError {}

impl TagError {
    fn unsupported(node: &YamlNode, construct: UnsupportedConstruct) -> Self {
        Self { refusal: TagRefusal::Unsupported(construct), range: Some(node.range) }
    }

    fn coded(node: &YamlNode, code: &'static str, message: impl Into<String>) -> Self {
        Self { refusal: TagRefusal::Loader { code, message: message.into() }, range: Some(node.range) }
    }

    /// The code both loaders name the refusal under, for a loader refusal.
    pub fn code(&self) -> Option<&'static str> {
        match &self.refusal {
            TagRefusal::Loader { code, .. } => Some(code),
            TagRefusal::Unsupported(_) => None,
        }
    }
}

/// Why a composed document has no JSON tree.
#[derive(Debug)]
pub enum JsonRefusal {
    /// The tag layer refuses a node.
    Tag(TagError),
    /// The document's aliases expand past `yaml`'s bound — a YAML error both loaders name.
    AliasLimit,
}

impl From<TagError> for JsonRefusal {
    fn from(error: TagError) -> Self {
        JsonRefusal::Tag(error)
    }
}

/// Convert a composed document to the plain-JSON manifest tree the kernel works with,
/// rewriting recognised tags to sentinels. `None` for a document holding nothing, or null.
pub fn document_to_json(doc: &YamlDocument) -> Result<Option<Json>, JsonRefusal> {
    let Some(root) = doc.root else { return Ok(None) };
    let json = Converter::new(doc).convert(root)?;
    Ok(if json.is_null() { None } else { Some(json) })
}

enum Work {
    /// A node and its depth in the tree, the root's collection at 1.
    Value(NodeId, usize),
    Key(NodeId),
    Null,
    CloseSequence(NodeId, usize),
    CloseMapping(NodeId, usize, Option<String>),
}

#[derive(Clone, Copy)]
struct AnchorData {
    count: u64,
    alias_count: u64,
}

struct Converter<'d> {
    doc: &'d YamlDocument,
    built: HashMap<NodeId, Json>,
    /// How many levels each anchored node's tree holds, for an alias copying it.
    heights: HashMap<NodeId, usize>,
    open: HashSet<NodeId>,
    anchors: HashMap<NodeId, AnchorData>,
}

impl<'d> Converter<'d> {
    fn new(doc: &'d YamlDocument) -> Self {
        Self { doc, built: HashMap::new(), heights: HashMap::new(), open: HashSet::new(), anchors: HashMap::new() }
    }

    fn convert(mut self, root: NodeId) -> Result<Json, JsonRefusal> {
        let mut work = vec![Work::Value(root, 1)];
        let mut values: Vec<Json> = Vec::new();
        // Beside each value, how many levels its tree holds.
        let mut heights: Vec<usize> = Vec::new();
        while let Some(item) = work.pop() {
            match item {
                Work::Null => {
                    values.push(Json::Null);
                    heights.push(0);
                }
                Work::Value(id, depth) => {
                    let node = &self.doc.nodes[id];
                    if node.anchored {
                        self.anchors.insert(id, AnchorData { count: 1, alias_count: 0 });
                    }
                    match &node.kind {
                        YamlNodeKind::Scalar(scalar) => {
                            let json = scalar_json(node, scalar)?;
                            if node.anchored {
                                self.built.insert(id, json.clone());
                                self.heights.insert(id, 0);
                            }
                            values.push(json);
                            heights.push(0);
                        }
                        YamlNodeKind::Alias { target } => {
                            let height = self.heights.get(target).copied().unwrap_or(0);
                            if depth - 1 + height > MAX_DEPTH {
                                return Err(too_deep(node).into());
                            }
                            values.push(self.alias(node, *target)?);
                            heights.push(height);
                        }
                        YamlNodeKind::Sequence { items, .. } => {
                            if depth > MAX_DEPTH {
                                return Err(too_deep(node).into());
                            }
                            collection_tag(node, "a list")?;
                            if node.anchored {
                                self.open.insert(id);
                            }
                            work.push(Work::CloseSequence(id, items.len()));
                            work.extend(items.iter().rev().map(|item| Work::Value(*item, depth + 1)));
                        }
                        YamlNodeKind::Mapping { entries, .. } => {
                            if depth > MAX_DEPTH {
                                return Err(too_deep(node).into());
                            }
                            let expansion = collection_tag(node, "a mapping")?;
                            if let Some(tag) = &expansion {
                                let writes_marker = entries.iter().any(|entry| {
                                    matches!(&self.doc.nodes[entry.key].kind,
                                        YamlNodeKind::Scalar(key) if key.value == ScalarValue::String && key.text == EXPANSION_MARKER)
                                });
                                if writes_marker {
                                    return Err(TagError::coded(
                                        node,
                                        expansion_shape_code(tag),
                                        format!("'!{tag}' holds a key '{EXPANSION_MARKER}', which is reserved for the tag's own marker. Remove it."),
                                    )
                                    .into());
                                }
                            }
                            if node.anchored {
                                self.open.insert(id);
                            }
                            work.push(Work::CloseMapping(id, entries.len(), expansion));
                            for entry in entries.iter().rev() {
                                work.push(entry.value.map_or(Work::Null, |value| Work::Value(value, depth + 1)));
                                work.push(Work::Key(entry.key));
                            }
                        }
                    }
                }
                Work::Key(id) => {
                    let key = self.key(id)?;
                    values.push(Json::String(key));
                    heights.push(0);
                }
                Work::CloseSequence(id, len) => {
                    let items = values.split_off(values.len() - len);
                    let height = 1 + heights.split_off(heights.len() - len).into_iter().max().unwrap_or(0);
                    let json = Json::Array(items);
                    self.close(id, &json, height);
                    values.push(json);
                    heights.push(height);
                }
                Work::CloseMapping(id, len, expansion) => {
                    let pairs = values.split_off(values.len() - 2 * len);
                    let height = 1 + heights.split_off(heights.len() - 2 * len).into_iter().max().unwrap_or(0);
                    let mut out = Map::with_capacity(len + usize::from(expansion.is_some()));
                    if let Some(tag) = expansion {
                        out.insert(EXPANSION_MARKER.to_string(), Json::String(tag));
                    }
                    let mut pairs = pairs.into_iter();
                    while let (Some(Json::String(key)), Some(value)) = (pairs.next(), pairs.next()) {
                        out.insert(key, value);
                    }
                    let json = Json::Object(out);
                    self.close(id, &json, height);
                    values.push(json);
                    heights.push(height);
                }
            }
        }
        Ok(values.pop().unwrap_or(Json::Null))
    }

    fn close(&mut self, id: NodeId, json: &Json, height: usize) {
        if self.doc.nodes[id].anchored {
            self.open.remove(&id);
            self.built.insert(id, json.clone());
            self.heights.insert(id, height);
        }
    }

    /// An alias's value: a copy of its anchor's, counted as `yaml` counts it.
    fn alias(&mut self, node: &YamlNode, target: NodeId) -> Result<Json, JsonRefusal> {
        if self.open.contains(&target) {
            return Err(TagError::unsupported(node, UnsupportedConstruct::SelfContainingAlias).into());
        }
        let mut data = self.anchors.get(&target).copied().unwrap_or(AnchorData { count: 1, alias_count: 0 });
        data.count += 1;
        if data.alias_count == 0 {
            data.alias_count = self.alias_count_of(target);
        }
        self.anchors.insert(target, data);
        if data.count.saturating_mul(data.alias_count) > MAX_ALIAS_COUNT {
            return Err(JsonRefusal::AliasLimit);
        }
        Ok(self.built.get(&target).cloned().unwrap_or(Json::Null))
    }

    /// `yaml`'s `getAliasCount`: the largest expansion factor anywhere beneath a node — an
    /// alias its anchor's count times its own factor, a scalar 1, a collection the largest
    /// of its children (0 when it has none).
    fn alias_count_of(&self, node: NodeId) -> u64 {
        enum Step {
            Enter(NodeId),
            Missing,
            Fold(usize),
        }
        let mut steps = vec![Step::Enter(node)];
        let mut counts: Vec<u64> = Vec::new();
        while let Some(step) = steps.pop() {
            match step {
                Step::Missing => counts.push(1),
                Step::Fold(len) => {
                    let folded = counts.split_off(counts.len() - len).into_iter().max().unwrap_or(0);
                    counts.push(folded);
                }
                Step::Enter(id) => match &self.doc.nodes[id].kind {
                    YamlNodeKind::Alias { target } => counts.push(
                        self.anchors.get(target).map_or(0, |data| data.count.saturating_mul(data.alias_count)),
                    ),
                    YamlNodeKind::Scalar(_) => counts.push(1),
                    YamlNodeKind::Sequence { items, .. } => {
                        steps.push(Step::Fold(items.len()));
                        steps.extend(items.iter().map(|item| Step::Enter(*item)));
                    }
                    YamlNodeKind::Mapping { entries, .. } => {
                        steps.push(Step::Fold(entries.len() * 2));
                        for entry in entries {
                            steps.push(Step::Enter(entry.key));
                            steps.push(entry.value.map_or(Step::Missing, Step::Enter));
                        }
                    }
                },
            }
        }
        counts.pop().unwrap_or(0)
    }

    /// A mapping key as the text the loaders key the entry by.
    fn key(&mut self, id: NodeId) -> Result<String, JsonRefusal> {
        let node = &self.doc.nodes[id];
        if node.anchored {
            self.anchors.insert(id, AnchorData { count: 1, alias_count: 0 });
        }
        let json = match &node.kind {
            YamlNodeKind::Scalar(scalar) => {
                match &node.tag {
                    None | Some(YamlTag::Core(_)) => {}
                    Some(YamlTag::Local(name)) if is_expansion_tag(name) => return Err(expansion_misuse(node, name, "a scalar").into()),
                    Some(tag) => {
                        return Err(collection_key(node, format!("a `{}`-tagged value", tag.written())).into())
                    }
                }
                let json = scalar_value_json(node, scalar)?;
                if node.anchored {
                    self.built.insert(id, json.clone());
                }
                json
            }
            YamlNodeKind::Alias { target } => self.alias(node, *target)?,
            YamlNodeKind::Sequence { .. } => return Err(collection_key(node, "a list").into()),
            YamlNodeKind::Mapping { .. } => return Err(collection_key(node, "a mapping").into()),
        };
        match json {
            Json::Null => Ok(String::new()),
            Json::Bool(b) => Ok(b.to_string()),
            Json::Number(n) => Ok(es_number(n.as_f64().unwrap_or(f64::NAN))),
            Json::String(s) => Ok(s),
            Json::Array(_) => Err(collection_key(node, "a list").into()),
            Json::Object(_) => Err(collection_key(node, "a mapping").into()),
        }
    }
}

/// A collection's tag: an expansion tag's name for a mapping, nothing for no tag or a core
/// collection tag, and a refusal for anything else — every tag but an expansion tag holds a
/// scalar.
fn collection_tag(node: &YamlNode, written: &'static str) -> Result<Option<String>, TagError> {
    let Some(tag) = &node.tag else { return Ok(None) };
    match tag {
        YamlTag::Core(name) if name == "map" || name == "seq" => Ok(None),
        YamlTag::Local(name) if is_expansion_tag(name) => {
            if written == "a mapping" {
                Ok(Some(name.clone()))
            } else {
                Err(expansion_misuse(node, name, "a sequence"))
            }
        }
        YamlTag::Local(name) if EXPRESSION_ENGINES.contains(&name.as_str()) => Err(expression_refusal(node, name)),
        YamlTag::Local(name) if KNOWN_ENGINES.contains(&name.as_str()) => Err(TagError::unsupported(
            node,
            UnsupportedConstruct::UnsupportedTag { tag: tag.written(), written_on: Some(written) },
        )),
        other => Err(unsupported_tag(node, other)),
    }
}

/// A scalar value's JSON: its engine's sentinel, a refusal, or what it resolves to.
fn scalar_json(node: &YamlNode, scalar: &YamlScalar) -> Result<Json, TagError> {
    match &node.tag {
        None | Some(YamlTag::Core(_)) => {}
        Some(YamlTag::Local(name)) if is_expansion_tag(name) => return Err(expansion_misuse(node, name, "a scalar")),
        Some(YamlTag::Local(name)) if EXPRESSION_ENGINES.contains(&name.as_str()) => return Err(expression_refusal(node, name)),
        Some(YamlTag::Local(name)) if KNOWN_ENGINES.contains(&name.as_str()) => return Ok(make_tagged_sentinel(name, &scalar.text)),
        Some(other) => return Err(unsupported_tag(node, other)),
    }
    let json = scalar_value_json(node, scalar)?;
    if let Json::String(s) = &json {
        // The legacy inline expression form. Passing it through as a literal
        // would be the one failure mode worse than rejecting it: the value
        // reaches a controller looking like an expression that was never
        // evaluated. Rejected on the same grounds as `!cel`.
        if s.contains("${{") {
            return Err(TagError::unsupported(node, UnsupportedConstruct::UntaggedInterpolation { text: s.clone() }));
        }
    }
    Ok(json)
}

/// What an untagged or core-tagged scalar resolves to, as JSON.
fn scalar_value_json(node: &YamlNode, scalar: &YamlScalar) -> Result<Json, TagError> {
    if let Some(YamlTag::Core(name)) = &node.tag {
        if !matches!(name.as_str(), "str" | "int" | "float" | "bool" | "null") {
            return Err(unsupported_tag(node, node.tag.as_ref().expect("tagged")));
        }
    }
    Ok(match scalar.value {
        ScalarValue::Null => Json::Null,
        ScalarValue::Bool(b) => Json::Bool(b),
        ScalarValue::Number(n) => number_json(node, n)?,
        ScalarValue::String | ScalarValue::Engine => Json::String(scalar.text.clone()),
    })
}

/// A number as the JSON tree holds it: an integral one as an integer, as the Node tree's
/// double serializes; a non-finite one has no JSON form.
fn number_json(node: &YamlNode, n: f64) -> Result<Json, TagError> {
    const TWO_63: f64 = 9_223_372_036_854_775_808.0;
    if n.is_finite() && n.fract() == 0.0 {
        if (-TWO_63..TWO_63).contains(&n) {
            return Ok(Json::from(n as i64));
        }
        if (0.0..2.0 * TWO_63).contains(&n) {
            return Ok(Json::from(n as u64));
        }
    }
    Number::from_f64(n)
        .map(Json::Number)
        .ok_or_else(|| TagError::unsupported(node, UnsupportedConstruct::NonFiniteNumber { value: n }))
}

fn too_deep(node: &YamlNode) -> TagError {
    TagError::unsupported(node, UnsupportedConstruct::TreeDepth)
}

fn collection_key(node: &YamlNode, written: impl Into<String>) -> TagError {
    TagError::unsupported(node, UnsupportedConstruct::CollectionKey { written: written.into() })
}

fn expansion_misuse(node: &YamlNode, tag: &str, written: &str) -> TagError {
    TagError::coded(
        node,
        expansion_shape_code(tag),
        format!("'!{tag}' is written on {written}; it takes a mapping ({}).", expansion_tag_keys(tag)),
    )
}

fn expression_refusal(node: &YamlNode, engine: &str) -> TagError {
    TagError::unsupported(node, UnsupportedConstruct::ExpressionTag { engine: engine.to_string() })
}

fn unsupported_tag(node: &YamlNode, tag: &YamlTag) -> TagError {
    TagError::unsupported(node, UnsupportedConstruct::UnsupportedTag { tag: tag.written(), written_on: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yaml_composer::compose_yaml;

    fn parse(text: &str) -> Result<Json, JsonRefusal> {
        let stream = compose_yaml(text);
        assert!(stream.errors.is_empty(), "{:?}", stream.errors);
        document_to_json(&stream.documents[0]).map(|json| json.unwrap_or(Json::Null))
    }

    fn refusal(text: &str) -> TagError {
        match parse(text) {
            Err(JsonRefusal::Tag(error)) => error,
            other => panic!("expected a tag refusal, got {other:?}"),
        }
    }

    #[test]
    fn ref_tags_become_sentinels() {
        let json = parse("invoke: !ref Console.writeLine").unwrap();
        assert_eq!(
            json["invoke"],
            serde_json::json!({
                "__tagged": true,
                "engine": "ref",
                "source": "Console.writeLine",
                "parsed": { "alias": "Console", "name": "writeLine", "indexes": [] }
            })
        );
    }

    #[test]
    fn expression_tags_are_refused_by_name() {
        let err = refusal("value: !cel \"1 + 1\"");
        assert_eq!(err.refusal, TagRefusal::Unsupported(UnsupportedConstruct::ExpressionTag { engine: "cel".into() }));
        let err = refusal("value: !interpolate \"port ${{ variables.port }}\"");
        assert_eq!(err.refusal, TagRefusal::Unsupported(UnsupportedConstruct::ExpressionTag { engine: "interpolate".into() }));
    }

    #[test]
    fn inline_expressions_are_rejected_rather_than_read_as_literals() {
        let err = refusal("value: \"port ${{ variables.port }}\"");
        assert!(err.to_string().contains("`!interpolate`"), "{err}");
    }

    #[test]
    fn ordinary_braces_are_left_alone() {
        // Console markup is `{style content}` — single-brace, no `$` — and must
        // not be mistaken for an expression.
        let json = parse("value: \"hello {green world}\"").unwrap();
        assert_eq!(json["value"], serde_json::json!("hello {green world}"));
    }
}
