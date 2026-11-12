//! The YAML composer: a manifest's text read into documents of nodes, each with `yaml`'s
//! ranges, and `yaml`'s errors — a twin of `yaml@2.8.3`'s `dist/compose/composer.js`,
//! `compose-doc.js`, `compose-node.js`, `compose-collection.js`, `compose-scalar.js`,
//! `resolve-block-map.js`, `resolve-block-seq.js`, `resolve-flow-collection.js` and
//! `util-map-includes.js`, over the lexer and CST parser twins, with the stream half of
//! `dist/doc/directives.js` and `parseAllDocuments`' error positions.
//!
//! No Telo twin (see `yaml_cst.rs`). What a manifest reader can observe of `yaml` is
//! reproduced for the core schema and Telo's custom tags: every document, every node's
//! `[start, valueEnd, end]` in UTF-16 code units, every scalar's value, every anchor and
//! alias, and every error in `doc.errors` — its code, message and position — in its order.
//! What differs, each where the tag layer refuses the tree as a construct this reader
//! cannot hold or where `yaml` itself does not answer:
//!
//! - a document under `%YAML 1.1` resolves its plain scalars by the core schema here;
//! - the `!!omap`, `!!pairs` and `!!set` tags' values are not built (their errors are raised
//!   as `yaml` raises them, `!!set`'s reading no comment on a null value);
//! - a scalar's text holds U+FFFD where an escape writes half a surrogate pair;
//! - nesting deep enough to overflow the JavaScript stack, which `yaml` reports as
//!   `RESOURCE_EXHAUSTION` at the collection it reached, composes here;
//! - an escape past U+10FFFF in a document's root scalar, which throws out of
//!   `parseAllDocuments`, is a `RESOURCE_EXHAUSTION` error at the scalar here, as it is
//!   inside a collection in both.
//!
//! The collection resolvers call `composeNode` on each child, so `yaml` composes on the
//! call stack; here each resolver is a frame on an explicit stack with its loop state, so
//! nothing recurses on the depth of the input.

use std::collections::HashSet;

use crate::builtins::default_registry;
use crate::yaml_cst::{Kind, SourceToken, Token, TokenId, TokenType, Units};
use crate::yaml_cst_parser::Parser;
use crate::yaml_errors::{line_pos, ErrorAt, YamlError};
use crate::yaml_lexer::{Lexer, State};
use crate::yaml_resolve::{
    contains_newline, cst_at, empty_scalar_position, number_of, resolve_block_scalar, resolve_end, resolve_flow_scalar,
    resolve_props, scalar_tag_by_name, scalar_tag_by_test, tag_name, timestamp_test, token_at, Errors, FlowStyle,
    NextToken, Props, PropsArgs, RawError, ScalarTag, TagHandles, Thrown,
};

/// Index of a node in its document's arena.
pub type NodeId = usize;

/// The tag a node is written behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YamlTag {
    /// A local tag, `!<name>` — the engines' and the expansion tags' form; `!` alone is
    /// `Local("")`.
    Local(String),
    /// A tag of YAML's core schema, `!!<name>`.
    Core(String),
    /// Any other tag, as `yaml` resolves it.
    Other(String),
}

impl YamlTag {
    fn of_name(name: &str) -> Self {
        if let Some(core) = name.strip_prefix("tag:yaml.org,2002:") {
            YamlTag::Core(core.to_string())
        } else if let Some(local) = name.strip_prefix('!') {
            YamlTag::Local(local.to_string())
        } else {
            YamlTag::Other(name.to_string())
        }
    }

    /// The tag as an author writes it.
    pub fn written(&self) -> String {
        match self {
            YamlTag::Local(name) => format!("!{name}"),
            YamlTag::Core(name) => format!("!!{name}"),
            YamlTag::Other(text) => text.clone(),
        }
    }

    /// The tag as the `yaml` package names it on a node (`!cel`, `tag:yaml.org,2002:str`).
    pub fn yaml_name(&self) -> String {
        match self {
            YamlTag::Local(name) => format!("!{name}"),
            YamlTag::Core(name) => format!("tag:yaml.org,2002:{name}"),
            YamlTag::Other(text) => text.clone(),
        }
    }
}

/// How a scalar was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YamlScalarStyle {
    Plain,
    SingleQuoted,
    DoubleQuoted,
    Literal,
    Folded,
}

/// What a scalar resolves to, as the `yaml` package with the manifest tags resolves it.
#[derive(Debug, Clone, PartialEq)]
pub enum ScalarValue {
    Null,
    Bool(bool),
    Number(f64),
    /// The scalar's text.
    String,
    /// The scalar is behind a registered engine's tag: the loaders make it a tagged sentinel.
    Engine,
    /// A value of a `yaml-1.1` tag the core schema knows (`!!binary`, `!!timestamp`,
    /// `!!merge`), which no manifest tree holds.
    Opaque,
}

#[derive(Debug, Clone)]
pub struct YamlScalar {
    /// The parsed text — escapes, folding and chomping applied.
    pub text: String,
    pub style: YamlScalarStyle,
    pub value: ScalarValue,
    /// An empty node `yaml` composes where nothing is written (`key:` with no value).
    pub implied: bool,
}

/// One entry of a mapping. `value` is `None` where nothing gave the key a value (`? key`
/// alone, `{ key }`), which `yaml` keeps as a pair with no value.
#[derive(Debug, Clone, Copy)]
pub struct YamlEntry {
    pub key: NodeId,
    pub value: Option<NodeId>,
}

#[derive(Debug, Clone)]
pub enum YamlNodeKind {
    Scalar(YamlScalar),
    /// `pairs`: the items are pairs, as `!!pairs` and `!!omap` make them, which a reader of
    /// the sequence's items does not see.
    Sequence { items: Vec<NodeId>, flow: bool, pairs: bool },
    Mapping { entries: Vec<YamlEntry>, flow: bool },
    /// `target` is the latest node before the alias, in the document's order, anchored by
    /// its name; `None` when there is none.
    Alias { target: Option<NodeId> },
}

#[derive(Debug, Clone)]
pub struct YamlNode {
    pub kind: YamlNodeKind,
    pub tag: Option<YamlTag>,
    /// Whether a non-empty anchor names this node.
    pub anchored: bool,
    /// `[start, valueEnd]` in UTF-16 code units: from the node's first character after its
    /// tag and anchor to the end of its own text.
    pub range: [usize; 2],
    /// Where the node ends, trailing comments and line break included (`range[2]`).
    pub end: usize,
}

/// One document of a stream.
#[derive(Debug, Clone)]
pub struct YamlDocument {
    pub nodes: Vec<YamlNode>,
    /// The document's contents; `yaml` composes an empty node where nothing is written.
    pub root: Option<NodeId>,
    /// `[range[0], range[2]]` in UTF-16 code units.
    pub range: [usize; 2],
    /// Whether a `---` marker opens it.
    pub explicit_start: bool,
    /// Whether it is under `%YAML 1.1`.
    pub yaml_1_1: bool,
}

/// A stream read: every document `yaml` yields, and every error in each one's `errors`, in
/// order.
#[derive(Debug, Clone)]
pub struct YamlStream {
    pub documents: Vec<YamlDocument>,
    pub errors: Vec<YamlError>,
}

/// Read `text` as a YAML stream (`parseAllDocuments`).
pub fn compose_yaml(text: &str) -> YamlStream {
    compose(text, usize::MAX)
}

/// Read only the first document of `text`: the stream stops once `yaml` would yield it.
pub fn compose_first_yaml_document(text: &str) -> YamlStream {
    compose(text, 1)
}

fn compose(text: &str, max_documents: usize) -> YamlStream {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut lexer = Lexer::new(&units);
    let mut parser = Parser::new(&units);
    let mut composer = StreamComposer::new(Units { text: &units });
    let mut lexemes = Vec::new();
    let mut tokens = Vec::new();
    let mut state = State::Stream;
    let mut stopped = false;
    while lexer.has_more() {
        state = lexer.step(state, &mut lexemes);
        for lexeme in lexemes.drain(..) {
            parser.next(lexeme, &mut tokens);
        }
        for token in tokens.drain(..) {
            composer.next(&parser.arena, token);
        }
        if parser.is_idle() {
            parser.arena.clear();
        }
        if composer.done.len() >= max_documents {
            stopped = true;
            break;
        }
    }
    if !stopped {
        parser.end(&mut tokens);
        for token in tokens.drain(..) {
            composer.next(&parser.arena, token);
        }
        composer.end();
    }
    let line_starts = parser.line_starts;
    let mut documents = Vec::new();
    let mut errors = Vec::new();
    for (document_index, done) in composer.done.into_iter().take(max_documents).enumerate() {
        for error in done.errors {
            let pos = error.at.pos();
            errors.push(YamlError {
                document_index,
                code: error.code,
                message: error.message,
                pos,
                line_pos: [line_pos(&line_starts, pos[0]), line_pos(&line_starts, pos[1])],
            });
        }
        documents.push(done.document);
    }
    YamlStream { documents, errors }
}

/// A document composed, with the errors `yaml` puts in its `errors`.
struct DocOut {
    document: YamlDocument,
    errors: Vec<RawError>,
}

/// The stream's directives (`Composer.directives`).
#[derive(Clone)]
struct Directives {
    version_1_1: bool,
    handles: TagHandles,
    at_next_document: bool,
}

impl Directives {
    fn default_handles() -> TagHandles {
        let mut handles = TagHandles::new();
        handles.insert("!!".to_string(), "tag:yaml.org,2002:".to_string());
        handles
    }

    fn new() -> Self {
        Self { version_1_1: false, handles: Self::default_handles(), at_next_document: false }
    }

    /// `atDocument`: the directives of the next document, the stream's reset after it.
    fn at_document(&mut self) -> Directives {
        let doc = self.clone();
        if self.version_1_1 {
            self.at_next_document = true;
        } else {
            self.at_next_document = false;
            self.handles = Self::default_handles();
        }
        doc
    }

    /// `add`: each complaint as `(offset in the line, message, warning)`.
    fn add(&mut self, line: &str, on_error: &mut dyn FnMut(usize, String, bool)) {
        if self.at_next_document {
            self.version_1_1 = true;
            self.handles = Self::default_handles();
            self.at_next_document = false;
        }
        let trimmed = telorun_cel_value::es_trim(line);
        let mut parts: Vec<&str> = trimmed.split([' ', '\t']).filter(|part| !part.is_empty()).collect();
        if trimmed.is_empty() {
            parts = vec![""];
        }
        let name = parts.remove(0);
        match name {
            "%TAG" => {
                if parts.len() != 2 {
                    on_error(0, "%TAG directive should contain exactly two parts".to_string(), false);
                    if parts.len() < 2 {
                        return;
                    }
                }
                self.handles.insert(parts[0].to_string(), parts[1].to_string());
            }
            "%YAML" => {
                if parts.len() != 1 {
                    on_error(0, "%YAML directive should contain exactly one part".to_string(), false);
                    return;
                }
                match parts[0] {
                    "1.1" => self.version_1_1 = true,
                    "1.2" => self.version_1_1 = false,
                    version => {
                        let valid = version.split_once('.').is_some_and(|(a, b)| {
                            !a.is_empty() && !b.is_empty() && a.chars().chain(b.chars()).all(|c| c.is_ascii_digit())
                        });
                        on_error(6, format!("Unsupported YAML version {version}"), valid);
                    }
                }
            }
            name => on_error(0, format!("Unknown directive {name}"), true),
        }
    }
}

struct StreamComposer<'s> {
    units: Units<'s>,
    directives: Directives,
    at_directives: bool,
    errors: Vec<RawError>,
    doc: Option<DocOut>,
    done: Vec<DocOut>,
}

impl<'s> StreamComposer<'s> {
    fn new(units: Units<'s>) -> Self {
        Self { units, directives: Directives::new(), at_directives: false, errors: Vec::new(), doc: None, done: Vec::new() }
    }

    fn next(&mut self, arena: &[Token], id: TokenId) {
        let token = &arena[id];
        match token {
            Token::Directive { offset, source } => {
                let line = self.units.string(*source);
                let pos = [*offset, offset + source.len()];
                let errors = &mut self.errors;
                self.directives.add(&line, &mut |rel, message, warning| {
                    if !warning {
                        errors.push(RawError { at: ErrorAt::Range(pos[0] + rel, pos[1]), code: "BAD_DIRECTIVE", message });
                    }
                });
                self.at_directives = true;
            }
            Token::Document { .. } => {
                let directives = self.directives.at_document();
                let mut doc = compose_doc(self.units, arena, id, &directives, &mut self.errors);
                if self.at_directives && !doc.document.explicit_start {
                    self.errors.push(RawError {
                        at: cst_at(token),
                        code: "MISSING_CHAR",
                        message: "Missing directives-end/doc-start indicator line".to_string(),
                    });
                }
                doc.errors = std::mem::take(&mut self.errors);
                if let Some(previous) = self.doc.take() {
                    self.done.push(previous);
                }
                self.doc = Some(doc);
                self.at_directives = false;
            }
            Token::Source(source) => match source.ty {
                TokenType::ByteOrderMark | TokenType::Space | TokenType::Comment | TokenType::Newline => {}
                ty => self.errors.push(RawError {
                    at: cst_at(token),
                    code: "UNEXPECTED_TOKEN",
                    message: format!("Unsupported token {}", ty.name()),
                }),
            },
            Token::Error { offset, message, source } => {
                let message = if source.is_empty() {
                    message.clone()
                } else {
                    format!("{message}: {}", json_string(&self.units.string(*source)))
                };
                let error = RawError { at: ErrorAt::Range(*offset, offset + source.len()), code: "UNEXPECTED_TOKEN", message };
                match self.doc.as_mut() {
                    Some(doc) if !self.at_directives => doc.errors.push(error),
                    _ => self.errors.push(error),
                }
            }
            Token::DocEnd { offset, source, end } => {
                if self.doc.is_none() {
                    self.errors.push(RawError {
                        at: cst_at(token),
                        code: "UNEXPECTED_TOKEN",
                        message: "Unexpected doc-end without preceding document".to_string(),
                    });
                    return;
                }
                let (_, end_offset) =
                    resolve_end(end.as_deref(), offset + source.len(), true, &mut Errors { list: &mut self.errors });
                let doc = self.doc.as_mut().expect("a document");
                doc.errors.append(&mut self.errors);
                doc.document.range[1] = end_offset;
            }
            other => self.errors.push(RawError {
                at: cst_at(other),
                code: "UNEXPECTED_TOKEN",
                message: format!("Unsupported token {}", other.kind().name()),
            }),
        }
    }

    fn end(&mut self) {
        if let Some(mut doc) = self.doc.take() {
            doc.errors.append(&mut self.errors);
            self.done.push(doc);
        }
    }
}

/// `JSON.stringify` of a string.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

/// `composeDoc`.
fn compose_doc(units: Units<'_>, arena: &[Token], id: TokenId, directives: &Directives, errors: &mut Vec<RawError>) -> DocOut {
    let Token::Document { offset, start, value, end } = &arena[id] else { unreachable!("a document") };
    let mut composing = Composing {
        units,
        arena,
        nodes: Vec::new(),
        at_key: false,
        at_root: true,
        handles: &directives.handles,
        errors,
        frames: Vec::new(),
        anchors: Vec::new(),
        aliases: Vec::new(),
    };
    let next = match value {
        Some(value) => Some(NextToken::of_token(&arena[*value])),
        None => end.as_ref().and_then(|end| end.first()).map(NextToken::of_source),
    };
    let props = resolve_props(
        units,
        start,
        PropsArgs {
            flow: None,
            indicator: TokenType::DocStart,
            next,
            offset: *offset,
            parent_indent: 0,
            start_on_newline: true,
        },
        &mut composing.sink(),
    );
    let explicit_start = props.found.is_some();
    if explicit_start {
        if let Some(value) = value {
            if matches!(arena[*value].kind(), Kind::BlockMap | Kind::BlockSeq) && !props.has_newline {
                composing.error(
                    ErrorAt::Offset(props.end),
                    "MISSING_CHAR",
                    "Block collection cannot start on same line with directives-end marker",
                );
            }
        }
    }
    let root = match value {
        Some(value) => match composing.run(*value, props) {
            Ok(root) => root,
            Err(thrown) => {
                // `yaml` throws out of `parseAllDocuments` here; the document reads as one
                // that holds nothing, its failure an error at the value.
                composing.error(cst_at(&arena[*value]), "RESOURCE_EXHAUSTION", thrown.message);
                composing.nodes.clear();
                composing.anchors.clear();
                composing.aliases.clear();
                composing.compose_empty_node(arena[*value].offset(), None, &empty_props(arena[*value].offset()), None)
            }
        },
        None => composing.compose_empty_node(props.end, Some(start), &props, None),
    };
    let content_end = composing.nodes[root].end;
    let (_, re) = resolve_end(end.as_deref(), content_end, false, &mut composing.sink());
    let mut nodes = composing.nodes;
    resolve_aliases(&mut nodes, composing.anchors, composing.aliases);
    DocOut {
        document: YamlDocument {
            nodes,
            root: Some(root),
            range: [*offset, re],
            explicit_start,
            yaml_1_1: directives.version_1_1,
        },
        errors: Vec::new(),
    }
}

fn empty_props(at: usize) -> Props {
    Props {
        comma: None,
        found: None,
        comment: Vec::new(),
        has_newline: false,
        anchor: None,
        tag: None,
        newline_after_prop: None,
        end: at,
        start: at,
    }
}

/// `Alias.resolve` for every alias: the last node before it, in the document's order, with
/// an anchor of its name. The arena holds the nodes in that order.
fn resolve_aliases(nodes: &mut [YamlNode], mut anchors: Vec<(NodeId, String)>, mut aliases: Vec<(NodeId, String)>) {
    if aliases.is_empty() {
        return;
    }
    anchors.sort_by_key(|(id, _)| *id);
    aliases.sort_by_key(|(id, _)| *id);
    let mut latest: std::collections::HashMap<String, NodeId> = std::collections::HashMap::new();
    let mut anchors = anchors.into_iter().peekable();
    for (alias, name) in aliases {
        while let Some((id, anchor)) = anchors.next_if(|(id, _)| *id < alias) {
            latest.insert(anchor, id);
        }
        if let YamlNodeKind::Alias { target } = &mut nodes[alias].kind {
            *target = latest.get(&name).copied();
        }
    }
}

/// What a scalar can be told apart by as a mapping key: `yaml` compares key scalars'
/// values with `===`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum KeyIdentity {
    Null,
    Bool(bool),
    Number(u64),
    String(String),
}

fn key_identity(node: &YamlNode) -> Option<KeyIdentity> {
    let YamlNodeKind::Scalar(scalar) = &node.kind else { return None };
    Some(match scalar.value {
        ScalarValue::Null => KeyIdentity::Null,
        ScalarValue::Bool(b) => KeyIdentity::Bool(b),
        ScalarValue::Number(n) if n.is_nan() => return None,
        ScalarValue::Number(n) => KeyIdentity::Number(if n == 0.0 { 0 } else { n.to_bits() }),
        ScalarValue::String => KeyIdentity::String(scalar.text.clone()),
        ScalarValue::Engine | ScalarValue::Opaque => return None,
    })
}

/// The tag a collection resolves with (`composeCollection`).
#[derive(Debug, Clone)]
enum CollectionTag {
    /// No tag of the schema: the node keeps `name` (the core collection tag for `!`).
    Plain(Option<String>),
    /// An expansion tag.
    Expansion(String),
    /// `!!omap`, `!!pairs` or `!!set`.
    Known(String),
}

enum Begin {
    Done(Result<NodeId, Thrown>),
    Pushed,
}

enum StepOut {
    /// Compose this child, then step the frame again with it.
    Child(TokenId, Props),
    Finished(Result<NodeId, Thrown>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MapPhase {
    Item,
    AfterKey,
    AfterValue,
}

struct BlockMapFrame {
    token: TokenId,
    slot: NodeId,
    i: usize,
    offset: usize,
    comment_end: Option<usize>,
    keys: HashSet<KeyIdentity>,
    entries: Vec<YamlEntry>,
    phase: MapPhase,
    key_props: Option<Props>,
    implicit_key: bool,
    key_start: usize,
    key_node: Option<NodeId>,
}

struct BlockSeqFrame {
    token: TokenId,
    slot: NodeId,
    i: usize,
    offset: usize,
    comment_end: Option<usize>,
    items: Vec<NodeId>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FlowPhase {
    Item,
    SeqValue,
    PairKey,
    PairValue,
}

struct FlowFrame {
    token: TokenId,
    slot: NodeId,
    is_map: bool,
    name: &'static str,
    at_root: bool,
    i: usize,
    offset: usize,
    keys: HashSet<KeyIdentity>,
    entries: Vec<YamlEntry>,
    items: Vec<NodeId>,
    phase: FlowPhase,
    props: Option<Props>,
    key_start: usize,
    key_node: Option<NodeId>,
    value_props: Option<Props>,
    pair_slot: Option<NodeId>,
}

struct CollectionFrame {
    token: TokenId,
    props: Props,
    tag: CollectionTag,
    slot: NodeId,
}

enum Frame {
    Collection(CollectionFrame),
    BlockMap(Box<BlockMapFrame>),
    BlockSeq(BlockSeqFrame),
    Flow(Box<FlowFrame>),
}

/// One document's composing state: `ctx` and the nodes built.
struct Composing<'a> {
    units: Units<'a>,
    arena: &'a [Token],
    nodes: Vec<YamlNode>,
    at_key: bool,
    at_root: bool,
    handles: &'a TagHandles,
    errors: &'a mut Vec<RawError>,
    frames: Vec<Frame>,
    /// Each anchored node and each alias, with its name, for `Alias.resolve`.
    anchors: Vec<(NodeId, String)>,
    aliases: Vec<(NodeId, String)>,
}

const STRICT: bool = true;
const START_COL: &str = "All mapping items must start at the same column";
const BLOCK_IN_FLOW: &str = "Block collections are not allowed within flow collections";

fn is_block(kind: Option<Kind>) -> bool {
    matches!(kind, Some(Kind::BlockMap | Kind::BlockSeq))
}

impl<'a> Composing<'a> {
    fn sink(&mut self) -> Errors<'_> {
        Errors { list: &mut *self.errors }
    }

    fn error(&mut self, at: ErrorAt, code: &'static str, message: impl Into<String>) {
        self.errors.push(RawError { at, code, message: message.into() });
    }

    fn reserve(&mut self) -> NodeId {
        self.nodes.push(YamlNode {
            kind: YamlNodeKind::Scalar(YamlScalar {
                text: String::new(),
                style: YamlScalarStyle::Plain,
                value: ScalarValue::Null,
                implied: true,
            }),
            tag: None,
            anchored: false,
            range: [0, 0],
            end: 0,
        });
        self.nodes.len() - 1
    }

    fn set_anchor(&mut self, node: NodeId, anchor: &SourceToken) -> bool {
        let name = self.units.of(anchor.source);
        let empty = name.len() <= 1;
        self.nodes[node].anchored = !empty;
        if !empty {
            self.anchors.push((node, String::from_utf16_lossy(&name[1..])));
        }
        empty
    }

    /// Compose `token` and everything beneath it.
    fn run(&mut self, token: TokenId, props: Props) -> Result<NodeId, Thrown> {
        let base = self.frames.len();
        let mut delivered = match self.begin(token, props) {
            Begin::Done(result) => return result,
            Begin::Pushed => None,
        };
        loop {
            let mut frame = self.frames.pop().expect("a frame");
            match self.step(&mut frame, delivered.take()) {
                StepOut::Child(child, props) => {
                    self.frames.push(frame);
                    match self.begin(child, props) {
                        Begin::Done(result) => delivered = Some(result),
                        Begin::Pushed => {}
                    }
                }
                StepOut::Finished(result) => {
                    if self.frames.len() == base {
                        return result;
                    }
                    delivered = Some(result);
                }
            }
        }
    }

    fn step(&mut self, frame: &mut Frame, delivered: Option<Result<NodeId, Thrown>>) -> StepOut {
        match frame {
            Frame::Collection(frame) => StepOut::Finished(self.finish_collection(frame, delivered.expect("a collection"))),
            Frame::BlockMap(frame) => self.step_block_map(frame, delivered),
            Frame::BlockSeq(frame) => self.step_block_seq(frame, delivered),
            Frame::Flow(frame) => self.step_flow(frame, delivered),
        }
    }

    /// `composeNode`, up to the point where a collection's resolver takes over.
    fn begin(&mut self, token: TokenId, props: Props) -> Begin {
        let arena = self.arena;
        let cst = &arena[token];
        let node = match cst.kind() {
            Kind::FlowScalar(crate::yaml_cst::FlowScalarType::Alias) => {
                let node = self.compose_alias(token);
                if props.anchor.is_some() || props.tag.is_some() {
                    self.error(cst_at(cst), "ALIAS_PROPS", "An alias node must not specify any properties");
                }
                Some(node)
            }
            Kind::FlowScalar(_) | Kind::BlockScalar => {
                let node = match self.compose_scalar(Some(token), cst.offset(), props.tag.as_ref(), false) {
                    Ok(node) => node,
                    Err(thrown) => return Begin::Done(Err(thrown)),
                };
                if let Some(anchor) = &props.anchor {
                    self.set_anchor(node, anchor);
                }
                Some(node)
            }
            Kind::BlockMap | Kind::BlockSeq | Kind::FlowCollection => {
                self.begin_collection(token, props);
                return Begin::Pushed;
            }
            kind => {
                let message = match cst {
                    Token::Error { message, .. } => message.clone(),
                    _ => format!("Unsupported token (type: {})", kind.name()),
                };
                self.error(cst_at(cst), "UNEXPECTED_TOKEN", message);
                None
            }
        };
        let node = node.unwrap_or_else(|| self.compose_empty_node(cst.offset(), None, &props, None));
        self.check_anchor(node, &props);
        Begin::Done(Ok(node))
    }

    /// `if (anchor && node.anchor === '')`.
    fn check_anchor(&mut self, node: NodeId, props: &Props) {
        if let Some(anchor) = &props.anchor {
            let is_alias = matches!(self.nodes[node].kind, YamlNodeKind::Alias { .. });
            if !is_alias && self.units.of(anchor.source).len() <= 1 {
                self.error(token_at(anchor), "BAD_ALIAS", "Anchor cannot be an empty string");
            }
        }
    }

    fn resolve_tag_name(&mut self, tag: &SourceToken) -> Option<String> {
        let source = self.units.string(tag.source);
        let at = token_at(tag);
        let errors = &mut *self.errors;
        tag_name(&source, self.handles, &mut |message| {
            errors.push(RawError { at, code: "TAG_RESOLVE_FAILED", message });
        })
    }

    /// `composeCollection` up to `resolveCollection`: the tag's checks, then the resolver's
    /// frame.
    fn begin_collection(&mut self, token: TokenId, props: Props) {
        let arena = self.arena;
        let cst = &arena[token];
        let tag_token = props.tag;
        let tag_name = tag_token.as_ref().and_then(|tag| self.resolve_tag_name(tag));
        if cst.kind() == Kind::BlockSeq {
            let last_prop = match (props.anchor, tag_token) {
                (Some(anchor), Some(tag)) => Some(if anchor.offset > tag.offset { anchor } else { tag }),
                (anchor, tag) => anchor.or(tag),
            };
            if let Some(last) = last_prop {
                if props.newline_after_prop.is_none_or(|nl| nl.offset < last.offset) {
                    self.error(token_at(&last), "MISSING_CHAR", "Missing newline after block sequence props");
                }
            }
        }
        let is_map = match cst {
            Token::BlockMap { .. } => true,
            Token::BlockSeq { .. } => false,
            Token::FlowCollection { start, .. } => self.units.of(start.source) == [b'{' as u16],
            _ => false,
        };
        const MAP: &str = "tag:yaml.org,2002:map";
        const SEQ: &str = "tag:yaml.org,2002:seq";
        let tag = match tag_name.as_deref() {
            None => CollectionTag::Plain(None),
            Some("!") => CollectionTag::Plain(Some(if is_map { MAP } else { SEQ }.to_string())),
            Some(name) if (name == MAP && is_map) || (name == SEQ && !is_map) => CollectionTag::Plain(Some(name.to_string())),
            Some(name) => {
                let expansion = name.strip_prefix('!').filter(|n| crate::expansion_tags::is_expansion_tag(n));
                let known = match name {
                    "tag:yaml.org,2002:omap" | "tag:yaml.org,2002:pairs" => !is_map,
                    "tag:yaml.org,2002:set" => is_map,
                    _ => false,
                };
                if expansion.is_some() && is_map {
                    CollectionTag::Expansion(name.to_string())
                } else if known {
                    CollectionTag::Known(name.to_string())
                } else {
                    // A warning: an unresolved tag, or a known one on the other collection type.
                    CollectionTag::Plain(Some(name.to_string()))
                }
            }
        };
        let slot = self.reserve();
        self.frames.push(Frame::Collection(CollectionFrame { token, props, tag, slot }));
        match cst {
            Token::BlockMap { offset, .. } => {
                self.at_root = false;
                self.frames.push(Frame::BlockMap(Box::new(BlockMapFrame {
                    token,
                    slot,
                    i: 0,
                    offset: *offset,
                    comment_end: None,
                    keys: HashSet::new(),
                    entries: Vec::new(),
                    phase: MapPhase::Item,
                    key_props: None,
                    implicit_key: false,
                    key_start: 0,
                    key_node: None,
                })));
            }
            Token::BlockSeq { offset, .. } => {
                self.at_root = false;
                self.at_key = false;
                self.frames.push(Frame::BlockSeq(BlockSeqFrame {
                    token,
                    slot,
                    i: 0,
                    offset: *offset,
                    comment_end: None,
                    items: Vec::new(),
                }));
            }
            Token::FlowCollection { offset, start, .. } => {
                let at_root = self.at_root;
                self.at_root = false;
                self.at_key = false;
                self.frames.push(Frame::Flow(Box::new(FlowFrame {
                    token,
                    slot,
                    is_map,
                    name: if is_map { "flow map" } else { "flow sequence" },
                    at_root,
                    i: 0,
                    offset: offset + start.source.len(),
                    keys: HashSet::new(),
                    entries: Vec::new(),
                    items: Vec::new(),
                    phase: FlowPhase::Item,
                    props: None,
                    key_start: 0,
                    key_node: None,
                    value_props: None,
                    pair_slot: None,
                })));
            }
            _ => unreachable!("a collection"),
        }
    }

    /// The rest of `composeCollection` and `composeNode` once the resolver is done, or its
    /// `catch` when it threw.
    fn finish_collection(&mut self, frame: &CollectionFrame, result: Result<NodeId, Thrown>) -> Result<NodeId, Thrown> {
        let arena = self.arena;
        let node = match result {
            Ok(node) => {
                match &frame.tag {
                    CollectionTag::Plain(name) => self.nodes[node].tag = name.as_deref().map(YamlTag::of_name),
                    CollectionTag::Expansion(name) => self.nodes[node].tag = Some(YamlTag::of_name(name)),
                    CollectionTag::Known(name) => {
                        self.known_collection_tag(node, name, frame.props.tag.as_ref().expect("a tag"));
                        self.nodes[node].tag = Some(YamlTag::of_name(name));
                    }
                }
                if let Some(anchor) = &frame.props.anchor {
                    self.set_anchor(node, anchor);
                }
                node
            }
            Err(thrown) => {
                self.error(cst_at(&arena[frame.token]), "RESOURCE_EXHAUSTION", thrown.message);
                self.compose_empty_node(arena[frame.token].offset(), None, &frame.props, Some(frame.slot))
            }
        };
        self.check_anchor(node, &frame.props);
        Ok(node)
    }

    /// `omap`, `pairs` and `set`'s `resolve`: their complaints.
    fn known_collection_tag(&mut self, node: NodeId, name: &str, tag: &SourceToken) {
        let at = token_at(tag);
        match name {
            "tag:yaml.org,2002:set" => {
                let YamlNodeKind::Mapping { entries, .. } = &self.nodes[node].kind else { return };
                let all_null = entries.iter().all(|entry| match entry.value {
                    None => true,
                    Some(value) => {
                        let value = &self.nodes[value];
                        matches!(&value.kind, YamlNodeKind::Scalar(s) if s.value == ScalarValue::Null) && value.tag.is_none()
                    }
                });
                if !all_null {
                    self.error(at, "TAG_RESOLVE_FAILED", "Set items must all have null values");
                }
            }
            _ => {
                let YamlNodeKind::Sequence { items, .. } = &self.nodes[node].kind else { return };
                let items = items.clone();
                let mut seen: Vec<ScalarValue> = Vec::new();
                let mut seen_text: Vec<String> = Vec::new();
                let mut complaints = Vec::new();
                for item in &items {
                    let key = match &self.nodes[*item].kind {
                        YamlNodeKind::Mapping { entries, .. } => {
                            if entries.len() > 1 {
                                complaints.push("Each pair must have its own sequence indicator".to_string());
                            }
                            entries.first().map(|entry| entry.key)
                        }
                        _ => Some(*item),
                    };
                    if name != "tag:yaml.org,2002:omap" {
                        continue;
                    }
                    let Some(key) = key else {
                        // `new Pair(new Scalar(null))`: a null key.
                        if seen.contains(&ScalarValue::Null) {
                            complaints.push("Ordered maps must not include duplicate keys: null".to_string());
                        } else {
                            seen.push(ScalarValue::Null);
                            seen_text.push(String::new());
                        }
                        continue;
                    };
                    if let YamlNodeKind::Scalar(scalar) = &self.nodes[key].kind {
                        let duplicate = seen.iter().zip(&seen_text).any(|(value, text)| match (value, &scalar.value) {
                            (ScalarValue::String, ScalarValue::String) => *text == scalar.text,
                            (ScalarValue::Number(a), ScalarValue::Number(b)) => a == b || (a.is_nan() && b.is_nan()),
                            (ScalarValue::Engine | ScalarValue::Opaque, _) => false,
                            (a, b) => a == b,
                        });
                        if duplicate {
                            complaints.push(format!("Ordered maps must not include duplicate keys: {}", scalar.text));
                        } else {
                            seen.push(scalar.value.clone());
                            seen_text.push(scalar.text.clone());
                        }
                    }
                }
                // The first loop runs over every item before the second over every pair.
                complaints.sort_by_key(|complaint| !complaint.starts_with("Each pair"));
                for message in complaints {
                    self.error(at, "TAG_RESOLVE_FAILED", message);
                }
                if let YamlNodeKind::Sequence { pairs, .. } = &mut self.nodes[node].kind {
                    *pairs = true;
                }
            }
        }
    }

    fn compose_alias(&mut self, token: TokenId) -> NodeId {
        let arena = self.arena;
        let Token::FlowScalar { offset, source, end, .. } = &arena[token] else { unreachable!("an alias") };
        let name = self.units.of(*source);
        if name.len() <= 1 {
            self.error(ErrorAt::Offset(*offset), "BAD_ALIAS", "Alias cannot be an empty string");
        }
        // An alias ending in `:` is a warning.
        let value_end = offset + source.len();
        let (_, re) = resolve_end(end.as_deref(), value_end, STRICT, &mut self.sink());
        let alias_name = String::from_utf16_lossy(name.get(1..).unwrap_or(&[]));
        self.nodes.push(YamlNode {
            kind: YamlNodeKind::Alias { target: None },
            tag: None,
            anchored: false,
            range: [*offset, value_end],
            end: re,
        });
        let id = self.nodes.len() - 1;
        self.aliases.push((id, alias_name));
        id
    }

    /// `composeEmptyNode`, into `slot` when one is reserved.
    fn compose_empty_node(&mut self, offset: usize, before: Option<&[SourceToken]>, props: &Props, slot: Option<NodeId>) -> NodeId {
        let at = empty_scalar_position(offset, before);
        let node = self
            .compose_scalar_into(None, at, props.tag.as_ref(), true, slot)
            .expect("an empty scalar never throws");
        if let Some(anchor) = &props.anchor {
            if self.set_anchor(node, anchor) {
                self.error(token_at(anchor), "BAD_ALIAS", "Anchor cannot be an empty string");
            }
        }
        if !props.comment.is_empty() {
            self.nodes[node].end = props.end;
        }
        node
    }

    fn compose_scalar(&mut self, token: Option<TokenId>, offset: usize, tag: Option<&SourceToken>, implied: bool) -> Result<NodeId, Thrown> {
        self.compose_scalar_into(token, offset, tag, implied, None)
    }

    /// `composeScalar`. `token` is `None` for the empty plain scalar `composeEmptyNode`
    /// builds at `offset`.
    fn compose_scalar_into(
        &mut self,
        token: Option<TokenId>,
        offset: usize,
        tag_token: Option<&SourceToken>,
        implied: bool,
        slot: Option<NodeId>,
    ) -> Result<NodeId, Thrown> {
        let arena = self.arena;
        let units = self.units;
        let at_root = self.at_root;
        let (value, style, range, plain) = match token.map(|token| &arena[token]) {
            Some(Token::BlockScalar { .. }) => {
                let block = resolve_block_scalar(units, arena, token.expect("a token"), at_root, STRICT, &mut self.sink());
                match block {
                    Some(block) => (
                        block.value,
                        if block.folded { YamlScalarStyle::Folded } else { YamlScalarStyle::Literal },
                        block.range,
                        false,
                    ),
                    None => (Vec::new(), YamlScalarStyle::Plain, [offset, offset, offset], false),
                }
            }
            Some(Token::FlowScalar { ty, offset, source, end, .. }) => {
                let style = match ty {
                    crate::yaml_cst::FlowScalarType::SingleQuoted => FlowStyle::SingleQuoted,
                    crate::yaml_cst::FlowScalarType::DoubleQuoted => FlowStyle::DoubleQuoted,
                    _ => FlowStyle::Plain,
                };
                let resolved =
                    resolve_flow_scalar(style, *offset, units.of(*source), end.as_deref(), STRICT, &mut self.sink())?;
                let scalar_style = match style {
                    FlowStyle::Plain => YamlScalarStyle::Plain,
                    FlowStyle::SingleQuoted => YamlScalarStyle::SingleQuoted,
                    FlowStyle::DoubleQuoted => YamlScalarStyle::DoubleQuoted,
                };
                (resolved.value, scalar_style, resolved.range, style == FlowStyle::Plain)
            }
            _ => (Vec::new(), YamlScalarStyle::Plain, [offset, offset, offset], true),
        };
        let text = String::from_utf16_lossy(&value);
        let tag_name = tag_token.and_then(|tag| self.resolve_tag_name(tag));
        let error_at = match (tag_token, token) {
            (Some(tag), _) => token_at(tag),
            (None, Some(token)) => cst_at(&arena[token]),
            (None, None) => ErrorAt::Token { offset, len: Some(0) },
        };
        let registry = default_registry();
        let chosen = match &tag_name {
            Some(name) => match scalar_tag_by_name(&text, name, |engine| registry.has(engine)) {
                Ok(tag) => tag,
                Err(warning) => {
                    if !warning {
                        self.error(error_at, "TAG_RESOLVE_FAILED", format!("Unresolved tag: {name}"));
                    }
                    ScalarTag::Str
                }
            },
            None if plain => scalar_tag_by_test(&text),
            None => ScalarTag::Str,
        };
        let resolved = match chosen {
            ScalarTag::Str => ScalarValue::String,
            ScalarTag::Null => ScalarValue::Null,
            ScalarTag::Bool => ScalarValue::Bool(text.starts_with(['t', 'T'])),
            ScalarTag::Int | ScalarTag::Float => ScalarValue::Number(number_of(&chosen, &text)),
            ScalarTag::Engine => ScalarValue::Engine,
            ScalarTag::Binary | ScalarTag::Merge => ScalarValue::Opaque,
            ScalarTag::Timestamp => {
                if timestamp_test(&text) {
                    ScalarValue::Opaque
                } else {
                    self.error(error_at, "TAG_RESOLVE_FAILED", "!!timestamp expects a date, starting with yyyy-mm-dd");
                    ScalarValue::String
                }
            }
        };
        let node = YamlNode {
            kind: YamlNodeKind::Scalar(YamlScalar { text, style, value: resolved, implied }),
            tag: tag_name.as_deref().map(YamlTag::of_name),
            anchored: false,
            range: [range[0], range[1]],
            end: range[2],
        };
        Ok(match slot {
            Some(slot) => {
                self.nodes[slot] = node;
                slot
            }
            None => {
                self.nodes.push(node);
                self.nodes.len() - 1
            }
        })
    }

    fn step_block_map(&mut self, f: &mut BlockMapFrame, delivered: Option<Result<NodeId, Thrown>>) -> StepOut {
        let arena = self.arena;
        let units = self.units;
        let Token::BlockMap { offset: bm_offset, indent: bm_indent, items } = &arena[f.token] else { unreachable!() };
        let mut delivered = match delivered {
            Some(Err(thrown)) => return StepOut::Finished(Err(thrown)),
            Some(Ok(node)) => Some(node),
            None => None,
        };
        if let Some(node) = delivered.take_if(|_| f.phase == MapPhase::AfterKey) {
            f.key_node = Some(node);
        }
        loop {
            match f.phase {
                MapPhase::Item => {
                    let Some(item) = items.get(f.i) else {
                        if f.comment_end.is_some_and(|end| end != 0 && end < f.offset) {
                            self.error(
                                ErrorAt::Offset(f.comment_end.expect("an end")),
                                "IMPOSSIBLE",
                                "Map comment with trailing content",
                            );
                        }
                        let node = &mut self.nodes[f.slot];
                        node.kind = YamlNodeKind::Mapping { entries: std::mem::take(&mut f.entries), flow: false };
                        node.range = [*bm_offset, f.offset];
                        node.end = f.comment_end.unwrap_or(f.offset);
                        return StepOut::Finished(Ok(f.slot));
                    };
                    let next = match item.key {
                        Some(key) => Some(NextToken::of_token(&arena[key])),
                        None => item.sep.as_ref().and_then(|sep| sep.first()).map(NextToken::of_source),
                    };
                    let key_props = resolve_props(
                        units,
                        &item.start,
                        PropsArgs {
                            flow: None,
                            indicator: TokenType::ExplicitKeyInd,
                            next,
                            offset: f.offset,
                            parent_indent: *bm_indent,
                            start_on_newline: true,
                        },
                        &mut self.sink(),
                    );
                    let implicit = key_props.found.is_none();
                    if implicit {
                        if let Some(key) = item.key {
                            let key_token = &arena[key];
                            if key_token.kind() == Kind::BlockSeq {
                                self.error(
                                    ErrorAt::Offset(f.offset),
                                    "BLOCK_AS_IMPLICIT_KEY",
                                    "A block sequence may not be used as an implicit map key",
                                );
                            } else if key_token.indent().is_some_and(|indent| indent != *bm_indent) {
                                self.error(ErrorAt::Offset(f.offset), "BAD_INDENT", START_COL);
                            }
                        }
                        if key_props.anchor.is_none() && key_props.tag.is_none() && item.sep.is_none() {
                            f.comment_end = Some(key_props.end);
                            f.i += 1;
                            continue;
                        }
                        if key_props.newline_after_prop.is_some() || contains_newline(units, arena, item.key) {
                            let at = match item.key {
                                Some(key) => cst_at(&arena[key]),
                                None => match item.start.last() {
                                    Some(last) => token_at(last),
                                    None => ErrorAt::Offset(f.offset),
                                },
                            };
                            self.error(at, "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
                        }
                    } else if key_props.found.is_some_and(|found| found.indent != *bm_indent) {
                        self.error(ErrorAt::Offset(f.offset), "BAD_INDENT", START_COL);
                    }
                    self.at_key = true;
                    f.key_start = key_props.end;
                    f.implicit_key = implicit;
                    f.phase = MapPhase::AfterKey;
                    match item.key {
                        Some(key) => {
                            f.key_props = Some(key_props.clone());
                            return StepOut::Child(key, key_props);
                        }
                        None => {
                            let node = self.compose_empty_node(f.key_start, Some(&item.start), &key_props, None);
                            f.key_props = Some(key_props);
                            f.key_node = Some(node);
                        }
                    }
                }
                MapPhase::AfterKey => {
                    let item = &items[f.i];
                    let key_node = f.key_node.expect("a key");
                    self.at_key = false;
                    let identity = key_identity(&self.nodes[key_node]);
                    if identity.as_ref().is_some_and(|identity| f.keys.contains(identity)) {
                        self.error(ErrorAt::Offset(f.key_start), "DUPLICATE_KEY", "Map keys must be unique");
                    }
                    let value_props = resolve_props(
                        units,
                        item.sep.as_deref().unwrap_or(&[]),
                        PropsArgs {
                            flow: None,
                            indicator: TokenType::MapValueInd,
                            next: item.value.map(|value| NextToken::of_token(&arena[value])),
                            offset: self.nodes[key_node].end,
                            parent_indent: *bm_indent,
                            start_on_newline: item.key.is_none_or(|key| arena[key].kind() == Kind::BlockScalar),
                        },
                        &mut self.sink(),
                    );
                    f.offset = value_props.end;
                    if let Some(found) = value_props.found {
                        if f.implicit_key {
                            if item.value.is_some_and(|value| arena[value].kind() == Kind::BlockMap) && !value_props.has_newline {
                                self.error(
                                    ErrorAt::Offset(f.offset),
                                    "BLOCK_AS_IMPLICIT_KEY",
                                    "Nested mappings are not allowed in compact mappings",
                                );
                            }
                            let key_props = f.key_props.as_ref().expect("key props");
                            if STRICT && key_props.start + 1024 < found.offset {
                                let range = self.nodes[key_node].range;
                                self.error(
                                    ErrorAt::Range(range[0], range[1]),
                                    "KEY_OVER_1024_CHARS",
                                    "The : indicator must be at most 1024 chars after the start of an implicit block mapping key",
                                );
                            }
                        }
                        f.phase = MapPhase::AfterValue;
                        match item.value {
                            Some(value) => return StepOut::Child(value, value_props),
                            None => {
                                delivered = Some(self.compose_empty_node(f.offset, item.sep.as_deref(), &value_props, None));
                            }
                        }
                    } else {
                        // A key with no value.
                        if f.implicit_key {
                            let range = self.nodes[key_node].range;
                            self.error(
                                ErrorAt::Range(range[0], range[1]),
                                "MISSING_CHAR",
                                "Implicit map keys need to be followed by map values",
                            );
                        }
                        if let Some(identity) = identity {
                            f.keys.insert(identity);
                        }
                        f.entries.push(YamlEntry { key: key_node, value: None });
                        f.i += 1;
                        f.phase = MapPhase::Item;
                    }
                }
                MapPhase::AfterValue => {
                    let value = delivered.take().expect("a value");
                    let key = f.key_node.take().expect("a key");
                    f.offset = self.nodes[value].end;
                    if let Some(identity) = key_identity(&self.nodes[key]) {
                        f.keys.insert(identity);
                    }
                    f.entries.push(YamlEntry { key, value: Some(value) });
                    f.i += 1;
                    f.phase = MapPhase::Item;
                }
            }
        }
    }

    fn step_block_seq(&mut self, f: &mut BlockSeqFrame, delivered: Option<Result<NodeId, Thrown>>) -> StepOut {
        let arena = self.arena;
        let units = self.units;
        let Token::BlockSeq { offset: bs_offset, indent: bs_indent, items } = &arena[f.token] else { unreachable!() };
        if let Some(result) = delivered {
            match result {
                Err(thrown) => return StepOut::Finished(Err(thrown)),
                Ok(node) => {
                    f.offset = self.nodes[node].end;
                    f.items.push(node);
                    f.i += 1;
                }
            }
        }
        loop {
            let Some(item) = items.get(f.i) else {
                let node = &mut self.nodes[f.slot];
                node.kind = YamlNodeKind::Sequence { items: std::mem::take(&mut f.items), flow: false, pairs: false };
                node.range = [*bs_offset, f.offset];
                node.end = f.comment_end.unwrap_or(f.offset);
                return StepOut::Finished(Ok(f.slot));
            };
            let props = resolve_props(
                units,
                &item.start,
                PropsArgs {
                    flow: None,
                    indicator: TokenType::SeqItemInd,
                    next: item.value.map(|value| NextToken::of_token(&arena[value])),
                    offset: f.offset,
                    parent_indent: *bs_indent,
                    start_on_newline: true,
                },
                &mut self.sink(),
            );
            if props.found.is_none() {
                if props.anchor.is_some() || props.tag.is_some() || item.value.is_some() {
                    if item.value.is_some_and(|value| arena[value].kind() == Kind::BlockSeq) {
                        self.error(ErrorAt::Offset(props.end), "BAD_INDENT", "All sequence items must start at the same column");
                    } else {
                        self.error(ErrorAt::Offset(f.offset), "MISSING_CHAR", "Sequence item without - indicator");
                    }
                } else {
                    f.comment_end = Some(props.end);
                    f.i += 1;
                    continue;
                }
            }
            match item.value {
                Some(value) => return StepOut::Child(value, props),
                None => {
                    let node = self.compose_empty_node(props.end, Some(&item.start), &props, None);
                    f.offset = self.nodes[node].end;
                    f.items.push(node);
                    f.i += 1;
                }
            }
        }
    }

    fn step_flow(&mut self, f: &mut FlowFrame, delivered: Option<Result<NodeId, Thrown>>) -> StepOut {
        let arena = self.arena;
        let units = self.units;
        let Token::FlowCollection { offset: fc_offset, indent: fc_indent, items, end: fc_end, .. } = &arena[f.token] else {
            unreachable!()
        };
        let mut delivered = match delivered {
            Some(Err(thrown)) => return StepOut::Finished(Err(thrown)),
            Some(Ok(node)) => Some(node),
            None => None,
        };
        loop {
            match f.phase {
                FlowPhase::Item => {
                    let Some(item) = items.get(f.i) else { break };
                    let next = match item.key {
                        Some(key) => Some(NextToken::of_token(&arena[key])),
                        None => item.sep.as_ref().and_then(|sep| sep.first()).map(NextToken::of_source),
                    };
                    let mut props = resolve_props(
                        units,
                        &item.start,
                        PropsArgs {
                            flow: Some(f.name),
                            indicator: TokenType::ExplicitKeyInd,
                            next,
                            offset: f.offset,
                            parent_indent: *fc_indent,
                            start_on_newline: false,
                        },
                        &mut self.sink(),
                    );
                    if props.found.is_none() {
                        if props.anchor.is_none() && props.tag.is_none() && item.sep.is_none() && item.value.is_none() {
                            if f.i == 0 && props.comma.is_some() {
                                self.error(
                                    token_at(props.comma.as_ref().expect("a comma")),
                                    "UNEXPECTED_TOKEN",
                                    format!("Unexpected , in {}", f.name),
                                );
                            } else if f.i + 1 < items.len() {
                                self.error(
                                    ErrorAt::Offset(props.start),
                                    "UNEXPECTED_TOKEN",
                                    format!("Unexpected empty item in {}", f.name),
                                );
                            }
                            f.offset = props.end;
                            f.i += 1;
                            continue;
                        }
                        if !f.is_map && STRICT && contains_newline(units, arena, item.key) {
                            self.error(
                                cst_at(&arena[item.key.expect("a key holding a newline")]),
                                "MULTILINE_IMPLICIT_KEY",
                                "Implicit keys of flow sequence pairs need to be on a single line",
                            );
                        }
                    }
                    if f.i == 0 {
                        if let Some(comma) = &props.comma {
                            self.error(token_at(comma), "UNEXPECTED_TOKEN", format!("Unexpected , in {}", f.name));
                        }
                    } else {
                        if props.comma.is_none() {
                            self.error(ErrorAt::Offset(props.start), "MISSING_CHAR", format!("Missing , between {} items", f.name));
                        }
                        if !props.comment.is_empty() {
                            let mut previous_comment: &[u16] = &[];
                            for st in &item.start {
                                match st.ty {
                                    TokenType::Comma | TokenType::Space => {}
                                    TokenType::Comment => {
                                        previous_comment = units.of(st.source).get(1..).unwrap_or(&[]);
                                        break;
                                    }
                                    _ => break,
                                }
                            }
                            if !previous_comment.is_empty() {
                                let holder = if f.is_map { f.entries.len() } else { f.items.len() };
                                if holder == 0 {
                                    // `coll.items[coll.items.length - 1].comment` on no item throws.
                                    return StepOut::Finished(Err(Thrown {
                                        message: "Cannot read properties of undefined (reading 'comment')".to_string(),
                                    }));
                                }
                                let cut = (previous_comment.len() + 1).min(props.comment.len());
                                props.comment.drain(..cut);
                            }
                        }
                    }
                    if !f.is_map && item.sep.is_none() && props.found.is_none() {
                        // A value in a sequence.
                        f.phase = FlowPhase::SeqValue;
                        match item.value {
                            Some(value) => return StepOut::Child(value, props),
                            None => delivered = Some(self.compose_empty_node(props.end, None, &props, None)),
                        }
                    } else {
                        // A key and value pair.
                        if !f.is_map {
                            f.pair_slot = Some(self.reserve());
                        }
                        self.at_key = true;
                        f.key_start = props.end;
                        f.phase = FlowPhase::PairKey;
                        match item.key {
                            Some(key) => {
                                f.props = Some(props.clone());
                                return StepOut::Child(key, props);
                            }
                            None => {
                                let node = self.compose_empty_node(f.key_start, Some(&item.start), &props, None);
                                f.props = Some(props);
                                delivered = Some(node);
                            }
                        }
                    }
                }
                FlowPhase::SeqValue => {
                    let item = &items[f.i];
                    let node = delivered.take().expect("a value");
                    f.items.push(node);
                    f.offset = self.nodes[node].end;
                    if is_block(item.value.map(|value| arena[value].kind())) {
                        let range = self.nodes[node].range;
                        self.error(ErrorAt::Range(range[0], range[1]), "BLOCK_IN_FLOW", BLOCK_IN_FLOW);
                    }
                    f.i += 1;
                    f.phase = FlowPhase::Item;
                }
                FlowPhase::PairKey => {
                    let item = &items[f.i];
                    let key_node = delivered.take().expect("a key");
                    f.key_node = Some(key_node);
                    if is_block(item.key.map(|key| arena[key].kind())) {
                        let range = self.nodes[key_node].range;
                        self.error(ErrorAt::Range(range[0], range[1]), "BLOCK_IN_FLOW", BLOCK_IN_FLOW);
                    }
                    self.at_key = false;
                    let value_props = resolve_props(
                        units,
                        item.sep.as_deref().unwrap_or(&[]),
                        PropsArgs {
                            flow: Some(f.name),
                            indicator: TokenType::MapValueInd,
                            next: item.value.map(|value| NextToken::of_token(&arena[value])),
                            offset: self.nodes[key_node].end,
                            parent_indent: *fc_indent,
                            start_on_newline: false,
                        },
                        &mut self.sink(),
                    );
                    let props = f.props.as_ref().expect("item props");
                    if let Some(found) = value_props.found {
                        if !f.is_map && props.found.is_none() && STRICT {
                            if let Some(sep) = &item.sep {
                                for st in sep {
                                    if st.offset == found.offset && st.ty == found.ty {
                                        break;
                                    }
                                    if st.ty == TokenType::Newline {
                                        self.error(
                                            token_at(st),
                                            "MULTILINE_IMPLICIT_KEY",
                                            "Implicit keys of flow sequence pairs need to be on a single line",
                                        );
                                        break;
                                    }
                                }
                            }
                            if props.start + 1024 < found.offset {
                                self.error(
                                    token_at(&found),
                                    "KEY_OVER_1024_CHARS",
                                    "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key",
                                );
                            }
                        }
                    } else if let Some(value) = item.value {
                        let value_token = &arena[value];
                        let starts_with_colon = value_token
                            .source()
                            .is_some_and(|source| units.of(source).first() == Some(&(b':' as u16)));
                        if starts_with_colon {
                            self.error(cst_at(value_token), "MISSING_CHAR", format!("Missing space after : in {}", f.name));
                        } else {
                            self.error(
                                ErrorAt::Offset(value_props.start),
                                "MISSING_CHAR",
                                format!("Missing , or : between {} items", f.name),
                            );
                        }
                    }
                    f.phase = FlowPhase::PairValue;
                    let found = value_props.found.is_some();
                    f.value_props = Some(value_props);
                    match item.value {
                        Some(value) => {
                            let value_props = f.value_props.clone().expect("value props");
                            return StepOut::Child(value, value_props);
                        }
                        None if found => {
                            let value_props = f.value_props.clone().expect("value props");
                            delivered = Some(self.compose_empty_node(value_props.end, item.sep.as_deref(), &value_props, None));
                        }
                        None => delivered = None,
                    }
                }
                FlowPhase::PairValue => {
                    let item = &items[f.i];
                    let value_node = delivered.take();
                    let key_node = f.key_node.take().expect("a key");
                    if value_node.is_some() && is_block(item.value.map(|value| arena[value].kind())) {
                        let range = self.nodes[value_node.expect("a value")].range;
                        self.error(ErrorAt::Range(range[0], range[1]), "BLOCK_IN_FLOW", BLOCK_IN_FLOW);
                    }
                    let identity = key_identity(&self.nodes[key_node]);
                    if f.is_map {
                        if identity.as_ref().is_some_and(|identity| f.keys.contains(identity)) {
                            self.error(ErrorAt::Offset(f.key_start), "DUPLICATE_KEY", "Map keys must be unique");
                        }
                        if let Some(identity) = identity {
                            f.keys.insert(identity);
                        }
                        f.entries.push(YamlEntry { key: key_node, value: value_node });
                    } else {
                        let pair = f.pair_slot.take().expect("a pair slot");
                        let end_node = &self.nodes[value_node.unwrap_or(key_node)];
                        let (end_value, end_end) = (end_node.range[1], end_node.end);
                        let start = self.nodes[key_node].range[0];
                        let node = &mut self.nodes[pair];
                        node.kind = YamlNodeKind::Mapping {
                            entries: vec![YamlEntry { key: key_node, value: value_node }],
                            flow: true,
                        };
                        node.range = [start, end_value];
                        node.end = end_end;
                        f.items.push(pair);
                    }
                    f.offset = match value_node {
                        Some(value) => self.nodes[value].end,
                        None => f.value_props.as_ref().expect("value props").end,
                    };
                    f.i += 1;
                    f.phase = FlowPhase::Item;
                }
            }
        }
        // The collection's end.
        let expected: u16 = if f.is_map { b'}' as u16 } else { b']' as u16 };
        let mut ce_pos = f.offset;
        let mut rest: Vec<SourceToken> = fc_end.iter().skip(1).copied().collect();
        match fc_end.first() {
            Some(ce) if units.of(ce.source) == [expected] => ce_pos = ce.offset + ce.source.len(),
            ce => {
                let name = if f.is_map { "Flow map" } else { "Flow sequence" };
                let close = if f.is_map { '}' } else { ']' };
                let message = if f.at_root {
                    format!("{name} must end with a {close}")
                } else {
                    format!("{name} in block collection must be sufficiently indented and end with a {close}")
                };
                self.error(ErrorAt::Offset(f.offset), if f.at_root { "MISSING_CHAR" } else { "BAD_INDENT" }, message);
                if let Some(ce) = ce {
                    if ce.source.len() != 1 {
                        rest.insert(0, *ce);
                    }
                }
            }
        }
        let end = if rest.is_empty() {
            ce_pos
        } else {
            resolve_end(Some(&rest), ce_pos, STRICT, &mut self.sink()).1
        };
        let node = &mut self.nodes[f.slot];
        node.kind = if f.is_map {
            YamlNodeKind::Mapping { entries: std::mem::take(&mut f.entries), flow: true }
        } else {
            YamlNodeKind::Sequence { items: std::mem::take(&mut f.items), flow: true, pairs: false }
        };
        node.range = [*fc_offset, ce_pos];
        node.end = end;
        StepOut::Finished(Ok(f.slot))
    }
}
