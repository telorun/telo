//! The YAML composer: a manifest's text read into documents of nodes, each with the
//! range the Node loader gives it, plus the YAML errors in the closed set of kinds both
//! loaders word alike.
//!
//! No Node twin: the Node loaders compose with the `yaml` package, and this file stands in
//! for it over `saphyr-parser`, read as an event source only. Everything a manifest reader
//! can observe of the `yaml` package is reproduced here and nothing else:
//!
//! - scalars resolve by YAML 1.2's core schema as `yaml` resolves them (`yes` is a string,
//!   `0x1F` and `0o17` integers, `.inf` / `.nan` doubles, `~` null) and an explicit core tag
//!   (`!!str`, `!!int`, …) the way its test reads the text; `<<` is a plain key;
//! - a key written twice in one mapping is an error, at the second key, and the later value
//!   wins (`yaml`'s `uniqueKeys`, which compares scalar values by `===`);
//! - each node's range is `yaml`'s `[start, valueEnd]` plus the node end a parent's range
//!   is built from — a block collection ends where its last value's trailing comment lines
//!   end, by the attribution rule of `yaml`'s CST parser — in UTF-16 code units;
//! - an alias resolves to the latest anchor of its name before it in its document.
//!
//! Every walk here is a loop over events or an explicit stack; nothing recurses on the
//! depth of the input.

use std::collections::{HashMap, HashSet};

use saphyr_parser::{Event, Parser, ScalarStyle, ScanError, Span, Tag};
use telorun_cel_value::es_string_to_number;

use crate::builtins::default_registry;

/// Index of a node in its document's arena.
pub type NodeId = usize;

/// The tag a node is written behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YamlTag {
    /// A local tag, `!<name>` — the engines' and the expansion tags' form.
    Local(String),
    /// A tag of YAML's core schema, `!!<name>`.
    Core(String),
    /// Any other tag, as written.
    Other(String),
}

impl YamlTag {
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
}

#[derive(Debug, Clone)]
pub struct YamlScalar {
    /// The parsed text — escapes, folding and chomping applied.
    pub text: String,
    pub style: YamlScalarStyle,
    pub value: ScalarValue,
    /// An empty plain scalar the text implies rather than writes (`key:` with no value).
    pub implied: bool,
}

/// One entry of a mapping. `value` is `None` where nothing, not even an indicator, gave
/// the key a value (`? key` alone, `{ key }`), which `yaml` keeps as a pair with no value.
#[derive(Debug, Clone, Copy)]
pub struct YamlEntry {
    pub key: NodeId,
    pub value: Option<NodeId>,
}

#[derive(Debug, Clone)]
pub enum YamlNodeKind {
    Scalar(YamlScalar),
    Sequence { items: Vec<NodeId>, flow: bool },
    Mapping { entries: Vec<YamlEntry>, flow: bool },
    Alias { target: NodeId },
}

#[derive(Debug, Clone)]
pub struct YamlNode {
    pub kind: YamlNodeKind,
    pub tag: Option<YamlTag>,
    /// Whether an anchor names this node.
    pub anchored: bool,
    /// `[start, valueEnd]` in UTF-16 code units: from the node's first character after its
    /// tag and anchor to the end of its own text.
    pub range: [usize; 2],
    /// Where the node ends, trailing comments and line break included — what `yaml` calls
    /// `range[2]`, and what a block collection holding it as its last child ends at.
    pub end: usize,
}

/// One document of a stream.
#[derive(Debug, Clone)]
pub struct YamlDocument {
    pub nodes: Vec<YamlNode>,
    pub root: Option<NodeId>,
    /// `[start, end]` in UTF-16 code units: from the `---` marker or the first content to
    /// the start of the next document, past a `...` marker that ends it.
    pub range: [usize; 2],
    /// False for the document a fatal error cut short; its `root` is `None`.
    pub complete: bool,
}

/// The closed set of YAML errors both loaders name. Each half classifies its own parser's
/// errors into one of these; an error neither can place is [`YamlErrorKind::Unreadable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YamlErrorKind {
    DuplicateKey,
    UnresolvedAlias,
    AliasLimit,
    UnclosedQuote,
    UnclosedFlowCollection,
    TabIndentation,
    PlainValueColon,
    BadIndentation,
    InvalidEscape,
    ReservedCharacter,
    Unreadable,
    /// Flow collections nested past saphyr's 255 levels — a bound of the Rust reader alone,
    /// worded as the tree bound is (`yaml_tags::NESTING_REFUSAL`), and no YAML error.
    NestingTooDeep,
}

/// A YAML error: its kind, the document it is in and where, in UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YamlError {
    pub document_index: usize,
    pub kind: YamlErrorKind,
    pub range: Option<[usize; 2]>,
}

/// A stream read. `documents` holds every document begun, the one a fatal error cut short
/// last; `errors` the duplicate keys found on the way, then that fatal error.
#[derive(Debug, Clone)]
pub struct YamlStream {
    pub documents: Vec<YamlDocument>,
    pub errors: Vec<YamlError>,
}

/// Read `text` as a YAML stream.
pub fn compose_yaml(text: &str) -> YamlStream {
    compose(text, usize::MAX)
}

/// Read only the first document of `text` — the stream stops there, so a large archive's
/// later documents are never parsed.
pub fn compose_first_yaml_document(text: &str) -> YamlStream {
    compose(text, 1)
}

fn compose(text: &str, max_documents: usize) -> YamlStream {
    let mut composer = Composer::new(text);
    let mut parser = Parser::new_from_str(text);
    loop {
        if composer.documents.len() >= max_documents && composer.doc.is_none() {
            break;
        }
        match parser.next_event() {
            None => break,
            Some(Ok((event, span))) => {
                let done = matches!(event, Event::StreamEnd);
                composer.event(event, span);
                if done || composer.stopped {
                    break;
                }
            }
            Some(Err(error)) => {
                composer.fail(&error);
                break;
            }
        }
    }
    YamlStream { documents: composer.documents, errors: composer.errors }
}

/// The text read by character, with each character's UTF-16 offset.
struct Text {
    chars: Vec<char>,
    utf16: Vec<usize>,
}

impl Text {
    fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut utf16 = Vec::with_capacity(chars.len() + 1);
        let mut offset = 0;
        for c in &chars {
            utf16.push(offset);
            offset += c.len_utf16();
        }
        utf16.push(offset);
        Self { chars, utf16 }
    }

    fn len(&self) -> usize {
        self.chars.len()
    }

    fn at(&self, i: usize) -> char {
        self.chars.get(i).copied().unwrap_or('\0')
    }

    /// The UTF-16 offset of character `i`; past the end, one unit per character.
    fn u16(&self, i: usize) -> usize {
        match self.utf16.get(i) {
            Some(offset) => *offset,
            None => self.utf16[self.chars.len()] + (i - self.chars.len()),
        }
    }

    fn is_blank(&self, i: usize) -> bool {
        matches!(self.at(i), ' ' | '\t')
    }

    fn is_break(&self, i: usize) -> bool {
        matches!(self.at(i), '\n' | '\r')
    }

    /// Past the line break at `i` (`\r\n` is one).
    fn past_break(&self, i: usize) -> usize {
        if self.at(i) == '\r' && self.at(i + 1) == '\n' {
            i + 2
        } else {
            i + 1
        }
    }

    fn line_start(&self, i: usize) -> usize {
        let mut p = i.min(self.len());
        while p > 0 && self.chars[p - 1] != '\n' {
            p -= 1;
        }
        p
    }

    /// Past the end of the line holding `i`, its break included.
    fn past_line(&self, i: usize) -> usize {
        let mut p = i;
        while p < self.len() && !self.is_break(p) {
            p += 1;
        }
        if p < self.len() {
            self.past_break(p)
        } else {
            p
        }
    }

    /// The indentation `yaml`'s lexer gives the line at `start`: the length of its leading
    /// whitespace when that starts with a space, else 0.
    fn indent_at(&self, start: usize) -> usize {
        let mut p = start;
        while self.is_blank(p) {
            p += 1;
        }
        if self.at(start) == ' ' {
            p - start
        } else {
            0
        }
    }

    fn column(&self, i: usize) -> usize {
        self.u16(i) - self.u16(self.line_start(i))
    }

    /// Whether a `---` / `...` marker starts the line at `start`.
    fn marker_at(&self, start: usize) -> bool {
        let c = self.at(start);
        (c == '-' || c == '.')
            && self.at(start + 1) == c
            && self.at(start + 2) == c
            && matches!(self.at(start + 3), ' ' | '\t' | '\n' | '\r' | '\0')
    }
}

/// The run of blank lines, comments and indentation from `from` to the next content.
struct Gap {
    /// Where the next content (or a document marker, or the end of the text) starts.
    next: usize,
    /// Each comment in the run: where it starts and its line's indentation.
    comments: Vec<(usize, usize)>,
    /// Where each line break in the run starts.
    breaks: Vec<usize>,
}

impl Text {
    fn gap(&self, from: usize) -> Gap {
        let mut gap = Gap { next: self.len(), comments: Vec::new(), breaks: Vec::new() };
        let mut p = from;
        let mut line_start = self.line_start(from);
        loop {
            if p >= self.len() {
                gap.next = self.len();
                return gap;
            }
            let c = self.at(p);
            if c == ' ' || c == '\t' {
                p += 1;
            } else if c == '\n' || c == '\r' {
                gap.breaks.push(p);
                p = self.past_break(p);
                line_start = p;
                if self.marker_at(p) {
                    gap.next = p;
                    return gap;
                }
            } else if c == '#' {
                gap.comments.push((p, self.indent_at(line_start)));
                while p < self.len() && !self.is_break(p) {
                    p += 1;
                }
            } else {
                gap.next = p;
                return gap;
            }
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

struct Frame {
    node: NodeId,
    flow: bool,
    sequence: bool,
    /// Where a block collection starts — its first `-`, `?` or key — once known.
    start: Option<usize>,
    /// The block collection's indentation, as `yaml`'s CST parser counts it.
    indent: usize,
    pending_key: Option<NodeId>,
    keys: HashSet<KeyIdentity>,
}

struct DocumentBuilder {
    nodes: Vec<YamlNode>,
    /// Node ranges and ends in characters while composing; UTF-16 once finished.
    starts: Vec<usize>,
    value_ends: Vec<usize>,
    ends: Vec<usize>,
    /// The `:` an implied empty scalar follows, for the gap its end is read from.
    implied_after: HashMap<NodeId, usize>,
    stack: Vec<Frame>,
    root: Option<NodeId>,
    anchors: HashMap<usize, NodeId>,
    start: usize,
}

struct Composer {
    text: Text,
    documents: Vec<YamlDocument>,
    errors: Vec<YamlError>,
    doc: Option<DocumentBuilder>,
    /// Where the previous event's span ended, in characters.
    prev_end: usize,
    /// Set by a fatal error: nothing after it is read.
    stopped: bool,
}

impl Composer {
    fn new(text: &str) -> Self {
        Self { text: Text::new(text), documents: Vec::new(), errors: Vec::new(), doc: None, prev_end: 0, stopped: false }
    }

    fn document_index(&self) -> usize {
        self.documents.len()
    }

    fn event(&mut self, event: Event<'_>, span: Span) {
        let start = span.start.index();
        let end = span.end.index();
        match event {
            Event::DocumentStart(_) => {
                self.doc = Some(DocumentBuilder {
                    nodes: Vec::new(),
                    starts: Vec::new(),
                    value_ends: Vec::new(),
                    ends: Vec::new(),
                    implied_after: HashMap::new(),
                    stack: Vec::new(),
                    root: None,
                    anchors: HashMap::new(),
                    start,
                });
            }
            Event::DocumentEnd => self.finish_document(start, end),
            Event::Scalar(value, style, anchor, tag) => self.scalar(&value, style, anchor, tag.as_deref(), start, end),
            Event::Alias(anchor) => self.alias(anchor, start, end),
            Event::SequenceStart(anchor, tag) => self.collection_start(true, anchor, tag.as_deref(), start, end),
            Event::MappingStart(anchor, tag) => self.collection_start(false, anchor, tag.as_deref(), start, end),
            Event::SequenceEnd | Event::MappingEnd => self.collection_end(start),
            Event::StreamStart | Event::StreamEnd | Event::Nothing => {}
        }
        self.prev_end = end;
    }

    fn doc(&mut self) -> &mut DocumentBuilder {
        self.doc.as_mut().expect("saphyr opens a document before any node")
    }

    fn push_node(&mut self, node: YamlNode, start: usize, value_end: usize, anchor: usize) -> NodeId {
        let doc = self.doc();
        let id = doc.nodes.len();
        doc.nodes.push(node);
        doc.starts.push(start);
        doc.value_ends.push(value_end);
        doc.ends.push(value_end);
        if anchor != 0 {
            doc.anchors.insert(anchor, id);
            doc.nodes[id].anchored = true;
        }
        id
    }

    /// Past the tag and anchor a span opens with, and the space after them.
    fn skip_props(&self, from: usize) -> usize {
        let mut p = from;
        loop {
            match self.text.at(p) {
                '!' | '&' => {
                    while p < self.text.len() && !matches!(self.text.at(p), ' ' | '\t' | '\n' | '\r') {
                        p += 1;
                    }
                }
                ' ' | '\t' | '\n' | '\r' => p += 1,
                '#' => {
                    while p < self.text.len() && !self.text.is_break(p) {
                        p += 1;
                    }
                }
                _ => return p,
            }
        }
    }

    /// A block scalar's header (`|` or `>`), found forward from the previous token: only
    /// indicators, properties, whitespace and comments lie between.
    fn block_header(&self, from: usize) -> usize {
        let mut p = from;
        while p < self.text.len() {
            match self.text.at(p) {
                '|' | '>' => return p,
                '#' => {
                    while p < self.text.len() && !self.text.is_break(p) {
                        p += 1;
                    }
                }
                '!' | '&' => {
                    while p < self.text.len() && !matches!(self.text.at(p), ' ' | '\t' | '\n' | '\r') {
                        p += 1;
                    }
                }
                _ => p += 1,
            }
        }
        from
    }

    /// Past the quote closing the quoted scalar opening at `open` (`''` and `\"` are no
    /// close).
    fn quoted_end(&self, open: usize) -> usize {
        self.quoted_close(open).unwrap_or(self.text.len())
    }

    /// Past the quote closing the one at `open`, or `None` when the text never closes it.
    fn quoted_close(&self, open: usize) -> Option<usize> {
        let quote = self.text.at(open);
        let mut p = open + 1;
        while p < self.text.len() {
            let c = self.text.at(p);
            if quote == '"' && c == '\\' {
                p += 2;
            } else if c == quote {
                if quote == '\'' && self.text.at(p + 1) == '\'' {
                    p += 2;
                } else {
                    return Some(p + 1);
                }
            } else {
                p += 1;
            }
        }
        None
    }

    /// Where a block scalar's own text ends: after its last content line, or after every
    /// trailing empty line when it keeps them (`|+`).
    fn block_scalar_end(&self, header: usize, content_end: usize) -> usize {
        let mut p = header + 1;
        let mut keep = false;
        while p < self.text.len() && !matches!(self.text.at(p), ' ' | '\t' | '\n' | '\r' | '#') {
            if self.text.at(p) == '+' {
                keep = true;
            }
            p += 1;
        }
        if keep {
            // Not into the indentation of the line after it.
            let line = self.text.line_start(content_end);
            return if (line..content_end).all(|i| self.text.is_blank(i)) { line } else { content_end };
        }
        // Back over trailing empty lines to the break ending the last content line.
        let floor = self.text.past_line(header).min(content_end);
        let mut end = content_end;
        while end > floor {
            let line = self.text.line_start(end - 1);
            let blank = (line..end).all(|i| matches!(self.text.at(i), ' ' | '\t' | '\n' | '\r'));
            if !blank || line < floor {
                break;
            }
            end = line;
        }
        end
    }

    fn scalar(&mut self, value: &str, style: ScalarStyle, anchor: usize, tag: Option<&Tag>, start: usize, end: usize) {
        let tag = tag.map(yaml_tag);
        let style = match style {
            ScalarStyle::Plain => YamlScalarStyle::Plain,
            ScalarStyle::SingleQuoted => YamlScalarStyle::SingleQuoted,
            ScalarStyle::DoubleQuoted => YamlScalarStyle::DoubleQuoted,
            ScalarStyle::Literal => YamlScalarStyle::Literal,
            ScalarStyle::Folded => YamlScalarStyle::Folded,
        };
        let implied = style == YamlScalarStyle::Plain && value.is_empty();
        let (node_start, value_end, colon) = if implied {
            // `yaml` places an empty node right after the indicator before it (and the
            // properties written for it), past the spaces that follow on its line.
            let at_root = self.doc.as_ref().is_some_and(|doc| doc.stack.is_empty());
            let (mut p, colon) = if at_root && !matches!(self.text.at(start), '!' | '&') {
                // A document holding nothing: right after its `---`.
                (self.prev_end, None)
            } else if end > start {
                (end, None)
            } else if self.text.at(start) == ':' {
                (start + 1, Some(start))
            } else {
                (start, None)
            };
            while self.text.is_blank(p) {
                p += 1;
            }
            (p, p, colon)
        } else if matches!(style, YamlScalarStyle::Literal | YamlScalarStyle::Folded) {
            let from = if matches!(self.text.at(start), '!' | '&') { start } else { self.prev_end };
            let header = self.block_header(from);
            (header, self.block_scalar_end(header, end), None)
        } else {
            let node_start = if matches!(self.text.at(start), '!' | '&') { self.skip_props(start) } else { start };
            let value_end = match style {
                YamlScalarStyle::SingleQuoted | YamlScalarStyle::DoubleQuoted => self.quoted_end(node_start),
                _ => {
                    // A plain scalar's span may run on over the space after it.
                    let mut value_end = end;
                    while value_end > node_start && self.text.is_blank(value_end - 1) {
                        value_end -= 1;
                    }
                    value_end
                }
            };
            (node_start, value_end, None)
        };
        let resolved = resolve_scalar(value, style, tag.as_ref());
        let node = YamlNode {
            kind: YamlNodeKind::Scalar(YamlScalar { text: value.to_string(), style, value: resolved, implied }),
            tag,
            anchored: false,
            range: [0, 0],
            end: 0,
        };
        let id = self.push_node(node, node_start, value_end, anchor);
        if let Some(colon) = colon {
            self.doc().implied_after.insert(id, colon);
        }
        self.place(id, start);
    }

    fn alias(&mut self, anchor: usize, start: usize, end: usize) {
        // saphyr refuses an alias naming no anchor in the stream; one whose anchor is in an
        // earlier document names none in its own, as `yaml` reads it.
        let Some(target) = self.doc().anchors.get(&anchor).copied() else {
            self.stop(YamlErrorKind::UnresolvedAlias, (start, end));
            return;
        };
        let node = YamlNode { kind: YamlNodeKind::Alias { target }, tag: None, anchored: false, range: [0, 0], end: 0 };
        let id = self.push_node(node, start, end, 0);
        self.place(id, start);
    }

    fn collection_start(&mut self, sequence: bool, anchor: usize, tag: Option<&Tag>, start: usize, end: usize) {
        // A flow collection's span holds its bracket, after any properties and before the
        // space that follows it.
        let bracket = if matches!(self.text.at(start), '!' | '&') { self.skip_props(start) } else { start };
        let flow = bracket < end && matches!(self.text.at(bracket), '[' | '{');
        let tag = tag.map(yaml_tag);
        let kind = if sequence {
            YamlNodeKind::Sequence { items: Vec::new(), flow }
        } else {
            YamlNodeKind::Mapping { entries: Vec::new(), flow }
        };
        // A flow collection starts at its bracket — or, for a single pair written inside a
        // flow sequence, at its key; a block sequence at its first `-`; a block mapping at
        // its `?`, else at its first key.
        let (node_start, known) = if flow {
            (bracket, true)
        } else if sequence {
            let mut p = end;
            if self.text.at(p) != '-' {
                while p > 0 && matches!(self.text.at(p - 1), ' ' | '\t' | '\n' | '\r') {
                    p -= 1;
                }
                if p > 0 && self.text.at(p - 1) == '-' {
                    p -= 1;
                }
            }
            (p, true)
        } else if self.text.at(end) == '?' {
            (end, true)
        } else {
            (end, false)
        };
        let in_flow = self.doc().stack.last().is_some_and(|frame| frame.flow);
        let node = YamlNode { kind, tag, anchored: false, range: [0, 0], end: 0 };
        let id = self.push_node(node, node_start, node_start, anchor);
        let flow_pair = !sequence && !flow && in_flow;
        // A column costs a walk back to the line start, so only a block collection, whose
        // indentation the trailing-comment rule reads, pays it.
        let indent = if flow || in_flow { 0 } else { self.text.column(node_start) };
        self.doc().stack.push(Frame {
            node: id,
            flow: flow || in_flow,
            sequence,
            start: (known && !flow_pair).then_some(node_start),
            indent,
            pending_key: None,
            keys: HashSet::new(),
        });
    }

    /// `at` is where the closing event's span starts: a flow collection's closing bracket.
    fn collection_end(&mut self, at: usize) {
        let frame = self.doc().stack.pop().expect("saphyr closes only what it opened");
        let id = frame.node;
        let is_flow_bracketed = match &self.doc().nodes[id].kind {
            YamlNodeKind::Sequence { flow, .. } | YamlNodeKind::Mapping { flow, .. } => *flow,
            _ => false,
        };
        let last_child = self.last_child(id);
        if is_flow_bracketed {
            let doc = self.doc();
            doc.value_ends[id] = at + 1;
            doc.ends[id] = at + 1;
        } else if frame.flow {
            // A single pair inside a flow sequence spans its key to its value.
            let doc = self.doc();
            let first = match &doc.nodes[id].kind {
                YamlNodeKind::Mapping { entries, .. } => entries.first().map(|entry| entry.key),
                _ => None,
            };
            if let Some(first) = first {
                doc.starts[id] = doc.starts[first];
            }
            let last_end = last_child.map(|child| doc.value_ends[child]).unwrap_or(doc.starts[id]);
            doc.value_ends[id] = last_end;
            doc.ends[id] = last_end;
        } else {
            let start = frame.start.unwrap_or(self.doc().starts[id]);
            let last_end = last_child.map(|child| self.doc().ends[child]).unwrap_or(start);
            let implied_last = last_child.is_some_and(|child| self.is_implied(child));
            // Trailing comment lines stay with the collection when one of them is indented at
            // least as far as its items; otherwise they belong to whatever holds it.
            let node_end = if implied_last || frame.indent == 0 {
                last_end
            } else {
                let gap = self.text.gap(last_end);
                if gap.comments.iter().any(|(_, indent)| *indent >= frame.indent) {
                    gap.next
                } else {
                    last_end
                }
            };
            let doc = self.doc();
            doc.starts[id] = start;
            doc.value_ends[id] = last_end;
            doc.ends[id] = node_end;
        }
        let placed_at = self.doc().starts[id];
        self.place(id, placed_at);
    }

    fn is_implied(&mut self, id: NodeId) -> bool {
        matches!(&self.doc().nodes[id].kind, YamlNodeKind::Scalar(scalar) if scalar.implied)
    }

    fn last_child(&mut self, id: NodeId) -> Option<NodeId> {
        match &self.doc().nodes[id].kind {
            YamlNodeKind::Sequence { items, .. } => items.last().copied(),
            YamlNodeKind::Mapping { entries, .. } => entries.last().map(|entry| entry.value.unwrap_or(entry.key)),
            _ => None,
        }
    }

    /// Attach a finished node to what holds it, settling its end by where it stands.
    fn place(&mut self, id: NodeId, event_start: usize) {
        let Some(frame) = self.doc().stack.last() else {
            let end = self.block_value_end(id, None);
            let doc = self.doc();
            doc.ends[id] = end;
            doc.root = Some(id);
            return;
        };
        let (flow, sequence, indent, pending) = (frame.flow, frame.sequence, frame.indent, frame.pending_key);
        if sequence {
            let end = if flow { self.doc().value_ends[id] } else { self.block_value_end(id, Some(indent)) };
            let doc = self.doc();
            doc.ends[id] = end;
            let holder = doc.stack.last().expect("a frame").node;
            if let YamlNodeKind::Sequence { items, .. } = &mut doc.nodes[holder].kind {
                items.push(id);
            }
            return;
        }
        match pending {
            None => self.place_key(id),
            Some(key) => {
                let has_value = !self.is_implied(id) || self.value_indicated(key, event_start);
                let end = if flow { self.doc().value_ends[id] } else { self.block_value_end(id, Some(indent)) };
                let doc = self.doc();
                doc.ends[id] = end;
                let frame = doc.stack.last_mut().expect("a frame");
                frame.pending_key = None;
                let holder = frame.node;
                if let YamlNodeKind::Mapping { entries, .. } = &mut doc.nodes[holder].kind {
                    entries.push(YamlEntry { key, value: has_value.then_some(id) });
                }
            }
        }
    }

    fn place_key(&mut self, id: NodeId) {
        let (start, identity) = {
            let doc = self.doc();
            let identity = match &doc.nodes[id].kind {
                YamlNodeKind::Scalar(scalar) => key_identity(scalar),
                _ => None,
            };
            doc.ends[id] = doc.value_ends[id];
            (doc.starts[id], identity)
        };
        let opens_block = self.doc().stack.last().is_some_and(|frame| frame.start.is_none() && !frame.flow);
        let indent = if opens_block { self.text.column(start) } else { 0 };
        let duplicate = {
            let frame = self.doc().stack.last_mut().expect("a frame");
            if frame.start.is_none() {
                frame.start = Some(start);
                frame.indent = indent;
            }
            frame.pending_key = Some(id);
            identity.is_some_and(|identity| !frame.keys.insert(identity))
        };
        if duplicate {
            let range = [self.text.u16(start), self.text.u16(start) + 1];
            let document_index = self.document_index();
            self.errors.push(YamlError { document_index, kind: YamlErrorKind::DuplicateKey, range: Some(range) });
        }
    }

    /// Whether a `:` stands between a key and the empty scalar saphyr gives it — without
    /// one, `yaml` keeps the key with no value at all.
    fn value_indicated(&mut self, key: NodeId, empty_at: usize) -> bool {
        let from = self.doc().value_ends[key];
        let mut p = from;
        while p <= empty_at && p < self.text.len() {
            match self.text.at(p) {
                ':' => return true,
                '#' => {
                    while p < self.text.len() && !self.text.is_break(p) {
                        p += 1;
                    }
                }
                _ => p += 1,
            }
        }
        false
    }

    /// Where a node standing as a block value ends. A flow node takes the rest of its line
    /// — spaces, a comment, the break — and every comment line after it indented past its
    /// collection (`indent`); an implied empty node the comments its indicator's gap
    /// keeps; a block node already knows.
    fn block_value_end(&mut self, id: NodeId, indent: Option<usize>) -> usize {
        let value_end = self.doc().value_ends[id];
        let flow_node = match &self.doc().nodes[id].kind {
            YamlNodeKind::Scalar(scalar) => {
                if scalar.implied {
                    return self.implied_end(id, indent);
                }
                !matches!(scalar.style, YamlScalarStyle::Literal | YamlScalarStyle::Folded)
            }
            YamlNodeKind::Alias { .. } => true,
            YamlNodeKind::Sequence { flow, .. } | YamlNodeKind::Mapping { flow, .. } => *flow,
        };
        if !flow_node {
            return self.doc().ends[id];
        }
        let mut p = value_end;
        while self.text.is_blank(p) {
            p += 1;
        }
        if self.text.at(p) == '#' {
            while p < self.text.len() && !self.text.is_break(p) {
                p += 1;
            }
        }
        if !self.text.is_break(p) {
            return p.max(value_end);
        }
        let mut end = self.text.past_break(p);
        let Some(indent) = indent else { return end };
        // Empty lines, then a comment line indented past the collection, as often as they
        // follow one another.
        let mut line = end;
        loop {
            let mut r = line;
            while self.text.is_blank(r) {
                r += 1;
            }
            if self.text.is_break(r) {
                line = self.text.past_break(r);
            } else if self.text.at(r) == '#' && self.text.indent_at(line) > indent {
                end = self.text.past_line(r);
                line = end;
            } else {
                return end;
            }
        }
    }

    /// The end of an implied empty value: its position, or — when its indicator's gap keeps
    /// a comment — the end of that gap.
    fn implied_end(&mut self, id: NodeId, indent: Option<usize>) -> usize {
        let at = self.doc().value_ends[id];
        let Some(colon) = self.doc().implied_after.get(&id).copied() else { return at };
        let Some(indent) = indent else { return at };
        let gap = self.text.gap(colon + 1);
        let next_indent = if gap.next < self.text.len() {
            self.text.indent_at(self.text.line_start(gap.next))
        } else {
            0
        };
        let at_next_item = gap.next < self.text.len() && !self.text.marker_at(gap.next) && next_indent == indent;
        let kept_end = if at_next_item {
            // Line breaks after the first, past the last comment indented beyond the
            // mapping, go to the next entry.
            let mut breaks: Vec<usize> = Vec::new();
            let mut comments = gap.comments.iter().peekable();
            for &b in &gap.breaks {
                while let Some((c, comment_indent)) = comments.peek() {
                    if *c < b {
                        if *comment_indent > indent {
                            breaks.clear();
                        }
                        comments.next();
                    } else {
                        break;
                    }
                }
                breaks.push(b);
            }
            if breaks.len() >= 2 { breaks[1] } else { gap.next }
        } else {
            gap.next
        };
        if gap.comments.iter().any(|(c, _)| *c < kept_end) {
            kept_end
        } else {
            at
        }
    }

    fn finish_document(&mut self, start: usize, end: usize) {
        let Some(builder) = self.doc.take() else { return };
        let explicit_end = (start..start + 3).all(|i| self.text.at(i) == '.') && end > start;
        // A document ends past a `...` marker; otherwise its root takes the blank lines and
        // comments after it, up to the next `---` — unless the root is an empty node.
        let doc_end = if explicit_end {
            self.text.past_line(start + 3)
        } else {
            match builder.root {
                Some(root) if !matches!(&builder.nodes[root].kind, YamlNodeKind::Scalar(scalar) if scalar.implied) => {
                    self.text.gap(builder.ends[root]).next.min(start.max(builder.ends[root]))
                }
                Some(root) => {
                    let gap = self.text.gap(builder.ends[root]);
                    if gap.comments.is_empty() { builder.ends[root] } else { gap.next.min(start.max(builder.ends[root])) }
                }
                None => start,
            }
        };
        let document = self.finish(builder, doc_end, true);
        self.documents.push(document);
    }

    fn finish(&self, builder: DocumentBuilder, doc_end: usize, complete: bool) -> YamlDocument {
        let mut nodes = builder.nodes;
        for (i, node) in nodes.iter_mut().enumerate() {
            node.range = [self.text.u16(builder.starts[i]), self.text.u16(builder.value_ends[i])];
            node.end = self.text.u16(builder.ends[i]);
        }
        YamlDocument {
            nodes,
            root: if complete { builder.root } else { None },
            range: [self.text.u16(builder.start), self.text.u16(doc_end.max(builder.start))],
            complete,
        }
    }

    /// The parser's fatal error, classified, and the document it cut short.
    fn fail(&mut self, error: &ScanError) {
        let mark = error.marker().index();
        let (kind, range) = self.classify(error.info(), mark);
        self.stop(kind, range);
    }

    /// End the stream at a fatal error, the document it cut short kept as incomplete.
    fn stop(&mut self, kind: YamlErrorKind, range: (usize, usize)) {
        self.stopped = true;
        let document_index = self.document_index();
        self.errors.push(YamlError {
            document_index,
            kind,
            range: Some([self.text.u16(range.0), self.text.u16(range.1)]),
        });
        if let Some(builder) = self.doc.take() {
            let end = self.text.len();
            let document = self.finish(builder, end, false);
            self.documents.push(document);
        }
    }

    /// The kind of a saphyr error, and the character range both loaders report it at.
    fn classify(&mut self, info: &str, mark: usize) -> (YamlErrorKind, (usize, usize)) {
        let point = (mark, mark + 1);
        let len = self.text.len();
        if info == "while parsing node, found unknown anchor" {
            let mut p = mark + 1;
            while p < len && !matches!(self.text.at(p), ' ' | '\t' | '\n' | '\r' | ',' | '[' | ']' | '{' | '}') {
                p += 1;
            }
            return (YamlErrorKind::UnresolvedAlias, (mark, p));
        }
        if info == "recursion limit exceeded" {
            return (YamlErrorKind::NestingTooDeep, point);
        }
        if info == "while scanning a quoted scalar, found unexpected end of stream" {
            return (YamlErrorKind::UnclosedQuote, (len, len + 1));
        }
        // A quote never closed reads on through every line after it, until a line too little
        // indented to continue it.
        if info == "invalid indentation in quoted scalar" {
            if matches!(self.text.at(mark), '"' | '\'') && self.quoted_close(mark).is_none() {
                return (YamlErrorKind::UnclosedQuote, (len, len + 1));
            }
            return (YamlErrorKind::Unreadable, point);
        }
        if info.starts_with("while parsing a flow sequence") || info.starts_with("while parsing a flow mapping") {
            let gap = self.text.gap(mark);
            if gap.next >= len {
                return (YamlErrorKind::UnclosedFlowCollection, point);
            }
            return (YamlErrorKind::Unreadable, point);
        }
        if info.starts_with("tabs disallowed") {
            let mut p = self.text.line_start(mark);
            while self.text.is_blank(p) {
                if self.text.at(p) == '\t' {
                    return (YamlErrorKind::TabIndentation, (p, p + 1));
                }
                p += 1;
            }
            return (YamlErrorKind::Unreadable, point);
        }
        if info == "mapping values are not allowed in this context" {
            if let Some(value_start) = self.compact_value_start(mark) {
                return (YamlErrorKind::PlainValueColon, (value_start, value_start + 1));
            }
            return (YamlErrorKind::Unreadable, point);
        }
        if info == "while parsing a block mapping, did not find expected key"
            || info == "while parsing a block collection, did not find expected '-' indicator"
        {
            let line = self.text.line_start(mark);
            let first_on_line = (line..mark).all(|i| self.text.is_blank(i));
            if first_on_line {
                if let Some(end) = self.innermost_block_child_end() {
                    return (YamlErrorKind::BadIndentation, (end, end + 1));
                }
            }
            return (YamlErrorKind::Unreadable, point);
        }
        if info == "while parsing a quoted scalar, found unknown escape character" {
            let mut p = mark + 1;
            while p < len {
                match self.text.at(p) {
                    '\\' => {
                        if !is_yaml_escape(self.text.at(p + 1)) {
                            return (YamlErrorKind::InvalidEscape, (p, p + 1));
                        }
                        p += 2;
                    }
                    '"' => break,
                    _ => p += 1,
                }
            }
            return (YamlErrorKind::Unreadable, point);
        }
        if info.starts_with("unexpected character:") && matches!(self.text.at(mark), '@' | '`') {
            return (YamlErrorKind::ReservedCharacter, point);
        }
        (YamlErrorKind::Unreadable, point)
    }

    /// Where the plain value a `: ` inside made a nested mapping of starts: the value the
    /// innermost block mapping just read, when the refused `:` (at `mark`) follows it on its
    /// line, or the value being read after a key, when it starts on the key's line.
    fn compact_value_start(&mut self, mark: usize) -> Option<usize> {
        let doc = self.doc.as_ref()?;
        let frame = doc.stack.last()?;
        if frame.flow || frame.sequence {
            return None;
        }
        if frame.pending_key.is_none() {
            let YamlNodeKind::Mapping { entries, .. } = &doc.nodes[frame.node].kind else { return None };
            let value = entries.last()?.value?;
            let plain = matches!(&doc.nodes[value].kind, YamlNodeKind::Scalar(scalar) if scalar.style == YamlScalarStyle::Plain && !scalar.implied);
            let value_end = doc.value_ends[value];
            if !plain || value_end > mark || !(value_end..mark).all(|i| self.text.is_blank(i)) {
                return None;
            }
            return Some(doc.starts[value]);
        }
        let key = frame.pending_key?;
        let key_end = doc.value_ends[key];
        let mut p = key_end;
        while self.text.is_blank(p) {
            p += 1;
        }
        if self.text.at(p) != ':' {
            return None;
        }
        p += 1;
        while self.text.is_blank(p) {
            p += 1;
        }
        if self.text.is_break(p) || p >= self.text.len() || self.text.at(p) == '#' {
            return None;
        }
        Some(p)
    }

    /// Where the last finished child of the innermost block collection ends.
    fn innermost_block_child_end(&mut self) -> Option<usize> {
        let doc = self.doc.as_ref()?;
        let frame = doc.stack.last()?;
        if frame.flow {
            return None;
        }
        let child = match &doc.nodes[frame.node].kind {
            YamlNodeKind::Sequence { items, .. } => items.last().copied(),
            YamlNodeKind::Mapping { entries, .. } => entries.last().map(|entry| entry.value.unwrap_or(entry.key)),
            _ => None,
        }?;
        Some(doc.ends[child])
    }
}

/// Whether `c` may follow a `\` in a double-quoted scalar.
fn is_yaml_escape(c: char) -> bool {
    matches!(
        c,
        '0' | 'a' | 'b' | 't' | '\t' | 'n' | 'v' | 'f' | 'r' | 'e' | ' ' | '"' | '/' | '\\' | 'N' | '_' | 'L' | 'P' | 'x'
            | 'u' | 'U' | '\n' | '\r'
    )
}

fn yaml_tag(tag: &Tag) -> YamlTag {
    if tag.handle == "!" {
        YamlTag::Local(tag.suffix.clone())
    } else if tag.is_yaml_core_schema() {
        YamlTag::Core(tag.suffix.clone())
    } else {
        YamlTag::Other(tag.to_string())
    }
}

fn key_identity(scalar: &YamlScalar) -> Option<KeyIdentity> {
    Some(match scalar.value {
        ScalarValue::Null => KeyIdentity::Null,
        ScalarValue::Bool(b) => KeyIdentity::Bool(b),
        ScalarValue::Number(n) if n.is_nan() => return None,
        ScalarValue::Number(n) => KeyIdentity::Number(if n == 0.0 { 0 } else { n.to_bits() }),
        ScalarValue::String => KeyIdentity::String(scalar.text.clone()),
        ScalarValue::Engine => return None,
    })
}

/// What a scalar resolves to: a registered engine's tag makes it a sentinel, a core tag
/// reads it by that tag's test (a text the test refuses stays a string, as in `yaml`), any
/// other tag and every quoted or block scalar keeps its text, and a plain one resolves by
/// the core schema.
fn resolve_scalar(text: &str, style: YamlScalarStyle, tag: Option<&YamlTag>) -> ScalarValue {
    match tag {
        Some(YamlTag::Local(name)) if default_registry().has(name) => ScalarValue::Engine,
        Some(YamlTag::Core(name)) => match name.as_str() {
            "null" => null_value(text).unwrap_or(ScalarValue::String),
            "bool" => bool_value(text).unwrap_or(ScalarValue::String),
            "int" => int_value(text).unwrap_or(ScalarValue::String),
            "float" => float_value(text).unwrap_or(ScalarValue::String),
            _ => ScalarValue::String,
        },
        Some(_) => ScalarValue::String,
        None if style == YamlScalarStyle::Plain => core_value(text),
        None => ScalarValue::String,
    }
}

/// A plain scalar by YAML 1.2's core schema, tested in `yaml`'s order.
pub fn core_value(text: &str) -> ScalarValue {
    null_value(text)
        .or_else(|| bool_value(text))
        .or_else(|| int_value(text))
        .or_else(|| float_value(text))
        .unwrap_or(ScalarValue::String)
}

fn null_value(text: &str) -> Option<ScalarValue> {
    matches!(text, "" | "~" | "null" | "Null" | "NULL").then_some(ScalarValue::Null)
}

fn bool_value(text: &str) -> Option<ScalarValue> {
    match text {
        "true" | "True" | "TRUE" => Some(ScalarValue::Bool(true)),
        "false" | "False" | "FALSE" => Some(ScalarValue::Bool(false)),
        _ => None,
    }
}

fn is_digits(text: &str, digit: impl Fn(char) -> bool) -> bool {
    !text.is_empty() && text.chars().all(digit)
}

fn int_value(text: &str) -> Option<ScalarValue> {
    if let Some(octal) = text.strip_prefix("0o") {
        if is_digits(octal, |c| ('0'..='7').contains(&c)) {
            return Some(ScalarValue::Number(es_string_to_number(text)));
        }
        return None;
    }
    if let Some(hex) = text.strip_prefix("0x") {
        if is_digits(hex, |c| c.is_ascii_hexdigit()) {
            return Some(ScalarValue::Number(es_string_to_number(text)));
        }
        return None;
    }
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    if is_digits(unsigned, |c| c.is_ascii_digit()) {
        let magnitude: f64 = unsigned.parse().ok()?;
        return Some(ScalarValue::Number(if text.starts_with('-') { -magnitude } else { magnitude }));
    }
    None
}

fn float_value(text: &str) -> Option<ScalarValue> {
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    let negative = text.starts_with('-');
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return Some(ScalarValue::Number(if negative { f64::NEG_INFINITY } else { f64::INFINITY }));
    }
    if matches!(text, ".nan" | ".NaN" | ".NAN") {
        return Some(ScalarValue::Number(f64::NAN));
    }
    // `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, with a point or an exponent.
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some(("", fraction)) => is_digits(fraction, |c| c.is_ascii_digit()),
        Some((whole, fraction)) => {
            is_digits(whole, |c| c.is_ascii_digit()) && fraction.chars().all(|c| c.is_ascii_digit())
        }
        None => exponent.is_some() && is_digits(mantissa, |c| c.is_ascii_digit()),
    };
    let exponent_ok = exponent.is_none_or(|exponent| {
        let digits = exponent.strip_prefix(['-', '+']).unwrap_or(exponent);
        is_digits(digits, |c| c.is_ascii_digit())
    });
    if !mantissa_ok || !exponent_ok {
        return None;
    }
    let value = es_string_to_number(unsigned);
    Some(ScalarValue::Number(if negative { -value } else { value }))
}
