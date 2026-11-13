//! YAML, as much of it as the release model reads and writes.
//!
//! No Node twin: the Node package hands this job to the `yaml` package
//! (2.8.3). Reading goes through `saphyr-parser`'s events into a tree that
//! keeps each scalar's source range, resolved by the YAML 1.2 core schema the
//! way `yaml`'s `toJSON()` resolves it. Writing is a port of `yaml`'s string
//! stringifier and block-map layout, so a ledger or a fragment written here is
//! byte for byte the one Node writes. One difference is deliberate: `yaml`
//! recovers from a malformed document and answers what it could read, where
//! this reader refuses it, naming the fault.

use saphyr_parser::{Event, Parser, ScalarStyle as SaphyrStyle, Tag};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone)]
pub struct YamlError {
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarStyle {
    Plain,
    SingleQuoted,
    DoubleQuoted,
    Block,
}

#[derive(Debug, Clone)]
pub struct Scalar {
    pub value: String,
    pub style: ScalarStyle,
    tag: Option<String>,
    /// Byte offsets of the scalar's own source, quotes included.
    pub range: (usize, usize),
}

#[derive(Debug, Clone)]
pub enum Node {
    Scalar(Scalar),
    Seq(Vec<Node>),
    Map(Vec<(Node, Node)>),
}

enum Frame {
    Seq(Vec<Node>, usize),
    Map(Vec<(Node, Node)>, Option<Node>, usize),
}

/// The first document of `text`, or `None` when it holds no content.
pub fn parse_document(text: &str) -> Result<Option<Node>, YamlError> {
    let offsets: Vec<usize> = text.char_indices().map(|(at, _)| at).chain([text.len()]).collect();
    let byte = |index: usize| offsets.get(index).copied().unwrap_or(text.len());
    let mut anchors: Vec<(usize, Node)> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut root: Option<Node> = None;
    let mut started = false;
    for event in Parser::new_from_str(text) {
        let (event, span) = event.map_err(|err| YamlError { message: err.to_string() })?;
        let node = match event {
            Event::DocumentStart(_) => {
                if started {
                    break;
                }
                started = true;
                continue;
            }
            Event::DocumentEnd => break,
            Event::StreamStart | Event::StreamEnd | Event::Nothing => continue,
            Event::SequenceStart(anchor, _) => {
                stack.push(Frame::Seq(Vec::new(), anchor));
                continue;
            }
            Event::MappingStart(anchor, _) => {
                stack.push(Frame::Map(Vec::new(), None, anchor));
                continue;
            }
            Event::SequenceEnd => match stack.pop() {
                Some(Frame::Seq(items, anchor)) => remember(&mut anchors, anchor, Node::Seq(items)),
                _ => return Err(YamlError { message: "a sequence ends that never started".into() }),
            },
            Event::MappingEnd => match stack.pop() {
                Some(Frame::Map(pairs, _, anchor)) => remember(&mut anchors, anchor, Node::Map(pairs)),
                _ => return Err(YamlError { message: "a mapping ends that never started".into() }),
            },
            Event::Alias(id) => anchors
                .iter()
                .rev()
                .find(|(anchor, _)| *anchor == id)
                .map(|(_, node)| node.clone())
                .ok_or_else(|| YamlError { message: "an alias names no anchor".into() })?,
            Event::Scalar(value, style, anchor, tag) => {
                let start = byte(span.start.index());
                let (style, end) = match style {
                    SaphyrStyle::Plain => (ScalarStyle::Plain, byte(span.end.index())),
                    SaphyrStyle::SingleQuoted => (ScalarStyle::SingleQuoted, quoted_end(text, start, b'\'')),
                    SaphyrStyle::DoubleQuoted => (ScalarStyle::DoubleQuoted, quoted_end(text, start, b'"')),
                    _ => (ScalarStyle::Block, byte(span.end.index())),
                };
                let start = if style == ScalarStyle::Block { block_header(text, start) } else { start };
                let scalar = Scalar {
                    value: value.into_owned(),
                    style,
                    tag: tag.map(|tag| tag_text(&tag)),
                    range: (start, end.max(start)),
                };
                remember(&mut anchors, anchor, Node::Scalar(scalar))
            }
        };
        match stack.last_mut() {
            Some(Frame::Seq(items, _)) => items.push(node),
            Some(Frame::Map(pairs, key, _)) => match key.take() {
                Some(k) => pairs.push((k, node)),
                None => *key = Some(node),
            },
            None => root = Some(node),
        }
    }
    Ok(root)
}

fn tag_text(tag: &Tag) -> String {
    if tag.is_yaml_core_schema() {
        format!("!!{}", tag.suffix)
    } else {
        tag.to_string()
    }
}

fn remember(anchors: &mut Vec<(usize, Node)>, anchor: usize, node: Node) -> Node {
    if anchor != 0 {
        anchors.push((anchor, node.clone()));
    }
    node
}

/// Where a block scalar whose content starts at `content` begins: its `|` or
/// `>` indicator, on the line above.
fn block_header(text: &str, content: usize) -> usize {
    let before = &text[..content];
    let Some(nl) = before.trim_end_matches([' ', '\t']).rfind('\n') else { return content };
    let line_start = before[..nl].rfind('\n').map_or(0, |at| at + 1);
    let line = &before[line_start..nl];
    let line = match line.find(" #") {
        Some(comment) => &line[..comment],
        None => line,
    };
    match line.rfind(['|', '>']) {
        Some(at) => line_start + at,
        None => content,
    }
}

/// Where a quoted scalar starting at `start` ends, its closing quote included.
fn quoted_end(text: &str, start: usize, quote: u8) -> usize {
    let bytes = text.as_bytes();
    let mut i = start + 1;
    while i < bytes.len() {
        let b = bytes[i];
        if quote == b'"' && b == b'\\' {
            i += 2;
            continue;
        }
        if b == quote {
            if quote == b'\'' && bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

/// `parseDocument(text).toJSON()`, refusing what does not parse.
pub fn parse_json(text: &str) -> Result<Value, YamlError> {
    Ok(parse_document(text)?.as_ref().map_or(Value::Null, to_json))
}

pub fn to_json(node: &Node) -> Value {
    match node {
        Node::Scalar(scalar) => resolve(scalar),
        Node::Seq(items) => Value::Array(items.iter().map(to_json).collect()),
        Node::Map(pairs) => {
            let mut map = Map::new();
            for (key, value) in pairs {
                map.insert(key_text(&to_json(key)), to_json(value));
            }
            Value::Object(map)
        }
    }
}

/// How a key that is no string becomes a JavaScript object key.
fn key_text(key: &Value) -> String {
    match key {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number(number),
        other => other.to_string(),
    }
}

fn js_number(number: &Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    let float = number.as_f64().unwrap_or(0.0);
    if float.fract() == 0.0 && float.abs() < 1e21 {
        format!("{float:.0}")
    } else {
        format!("{float}")
    }
}

/// The core schema's reading of a scalar.
fn resolve(scalar: &Scalar) -> Value {
    let text = scalar.value.as_str();
    match scalar.tag.as_deref() {
        Some("!!str") => return Value::String(text.to_string()),
        Some("!!null" | "!!bool" | "!!int" | "!!float") => {}
        Some(_) => return Value::String(text.to_string()),
        None if scalar.style != ScalarStyle::Plain => return Value::String(text.to_string()),
        None => {}
    }
    if matches!(text, "" | "~" | "null" | "Null" | "NULL") {
        return Value::Null;
    }
    if matches!(text, "true" | "True" | "TRUE") {
        return Value::Bool(true);
    }
    if matches!(text, "false" | "False" | "FALSE") {
        return Value::Bool(false);
    }
    if let Some(digits) = text.strip_prefix("0o").filter(|d| !d.is_empty() && d.bytes().all(|b| (b'0'..=b'7').contains(&b))) {
        return number(u64::from_str_radix(digits, 8).map(|n| n as f64).unwrap_or(f64::INFINITY));
    }
    if let Some(digits) = text.strip_prefix("0x").filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_hexdigit())) {
        return number(u64::from_str_radix(digits, 16).map(|n| n as f64).unwrap_or(f64::INFINITY));
    }
    if is_decimal_int(text) {
        if let Ok(int) = text.parse::<i64>() {
            return Value::Number(int.into());
        }
        return number(text.parse::<f64>().unwrap_or(0.0));
    }
    if is_float_special(text) || is_float(text) {
        return number(text.trim_start_matches('+').parse::<f64>().unwrap_or(0.0));
    }
    Value::String(text.to_string())
}

/// A number as JSON can hold it; JSON holds no NaN or infinity, which stand
/// in as 0 so the value still reads as a number.
fn number(value: f64) -> Value {
    Number::from_f64(value).map_or(Value::Number(0.into()), Value::Number)
}

fn is_decimal_int(text: &str) -> bool {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn is_float_special(text: &str) -> bool {
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    matches!(unsigned, ".inf" | ".Inf" | ".INF") || matches!(text, ".nan" | ".NaN" | ".NAN")
}

/// `^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$`, with either
/// a fraction or an exponent — a bare integer is an int.
fn is_float(text: &str) -> bool {
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some((int, frac)) => {
            let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            (int.is_empty() && !frac.is_empty() && digits(frac)) || (!int.is_empty() && digits(int) && digits(frac))
        }
        None => !mantissa.is_empty() && mantissa.bytes().all(|b| b.is_ascii_digit()),
    };
    if !mantissa_ok {
        return false;
    }
    match exponent {
        Some(exp) => {
            let digits = exp.strip_prefix(['-', '+']).unwrap_or(exp);
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        }
        None => mantissa.contains('.'),
    }
}

/// `doc.getIn(tokens, true)` when it is a scalar: a map is entered by a key
/// that reads as the token's string, a sequence by an index.
pub fn scalar_at<'a>(node: &'a Node, tokens: &[String]) -> Option<&'a Scalar> {
    let mut current = node;
    for token in tokens {
        current = match current {
            Node::Map(pairs) => pairs
                .iter()
                .find(|(key, _)| matches!(key, Node::Scalar(_)) && to_json(key) == Value::String(token.clone()))
                .map(|(_, value)| value)?,
            Node::Seq(items) => {
                let index: usize = token.parse().ok().filter(|_| token.bytes().all(|b| b.is_ascii_digit()))?;
                items.get(index)?
            }
            Node::Scalar(_) => return None,
        };
    }
    match current {
        Node::Scalar(scalar) => Some(scalar),
        _ => None,
    }
}

impl Scalar {
    /// The value, when the core schema reads it as a string.
    pub fn string_value(&self) -> Option<&str> {
        match resolve(self) {
            Value::String(_) => Some(self.value.as_str()),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// A value to write: a string, or a map of them in order.
pub enum Out {
    Str(String),
    Map(Vec<(String, Out)>),
}

const INDENT_STEP: &str = "  ";
const MIN_CONTENT_WIDTH: usize = 20;
const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;

#[derive(Clone)]
struct Ctx {
    indent: String,
    implicit_key: bool,
    indent_at_start: Option<usize>,
    line_width: usize,
    force_block_indent: bool,
}

/// `new Document(map).toString({ lineWidth })`.
pub fn stringify_document(map: &[(String, Out)], line_width: usize) -> String {
    let ctx = Ctx { indent: String::new(), implicit_key: false, indent_at_start: None, line_width, force_block_indent: false };
    format!("{}\n", stringify_map(map, &ctx))
}

fn stringify_map(map: &[(String, Out)], ctx: &Ctx) -> String {
    if map.is_empty() {
        return "{}".into();
    }
    let lines: Vec<String> = map.iter().map(|(key, value)| stringify_pair(key, value, ctx)).collect();
    let mut out = lines[0].clone();
    for line in &lines[1..] {
        if line.is_empty() {
            out.push('\n');
        } else {
            out.push('\n');
            out.push_str(&ctx.indent);
            out.push_str(line);
        }
    }
    out
}

fn stringify_pair(key: &str, value: &Out, ctx: &Ctx) -> String {
    let mut inner = ctx.clone();
    inner.implicit_key = true;
    inner.indent = format!("{}{}", ctx.indent, INDENT_STEP);
    let key_str = stringify_string(key, &mut inner);
    let explicit = utf16_len(&key_str) > 1024;
    let mut out = if explicit { format!("? {key_str}\n{}:", ctx.indent) } else { format!("{key_str}:") };
    inner.implicit_key = false;
    match value {
        Out::Str(text) => {
            if !explicit {
                inner.indent_at_start = Some(utf16_len(&out) + 1);
            }
            let value_str = stringify_string(text, &mut inner);
            let ws = if value_str.is_empty() || value_str.starts_with('\n') { "" } else { " " };
            out.push_str(ws);
            out.push_str(&value_str);
        }
        Out::Map(entries) => {
            let value_str = stringify_map(entries, &inner);
            if !explicit && !entries.is_empty() {
                out.push('\n');
                out.push_str(&inner.indent);
            } else {
                out.push(' ');
            }
            out.push_str(&value_str);
        }
    }
    out
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn stringify_string(value: &str, ctx: &mut Ctx) -> String {
    let forces_double = value.chars().any(|c| {
        let code = c as u32;
        code <= 0x08 || (0x0b..=0x1f).contains(&code) || (0x7f..=0x9f).contains(&code)
    });
    if forces_double {
        double_quoted(value, ctx)
    } else {
        plain(value, ctx)
    }
}

fn contains_document_marker(text: &str) -> bool {
    let starts = std::iter::once(0).chain(text.match_indices(['\n', '\r']).map(|(at, _)| at + 1));
    for start in starts {
        let rest = &text[start..];
        if rest.starts_with('%') || rest.starts_with("---") || rest.starts_with("...") {
            return true;
        }
    }
    false
}

fn plain(value: &str, ctx: &mut Ctx) -> String {
    if ctx.implicit_key && value.contains('\n') {
        return quoted(value, ctx);
    }
    if plain_forbidden(value) {
        return if ctx.implicit_key || !value.contains('\n') { quoted(value, ctx) } else { block(value, ctx) };
    }
    if !ctx.implicit_key && value.contains('\n') {
        return block(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            ctx.force_block_indent = true;
            return block(value, ctx);
        } else if ctx.implicit_key && ctx.indent == INDENT_STEP {
            return quoted(value, ctx);
        }
    }
    let replaced = replace_newline_runs(value, |run| format!("{run}\n{}", ctx.indent));
    if resolves_to_other_type(&replaced) {
        return quoted(value, ctx);
    }
    if ctx.implicit_key {
        replaced
    } else {
        fold_flow_lines(&replaced, &ctx.indent, Fold::Flow, ctx.indent_at_start, ctx.line_width, false).0
    }
}

/// `/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/`
fn plain_forbidden(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    if let Some(&first) = chars.first() {
        if "\n\t ,[]{}#&*!|>'\"%@`".contains(first) {
            return true;
        }
        if (first == '?' || first == '-') && (chars.len() == 1 || matches!(chars[1], ' ' | '\t')) {
            return true;
        }
    }
    for pair in chars.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if matches!(a, '\n' | ':') && matches!(b, ' ' | '\t') {
            return true;
        }
        if matches!(a, ' ' | '\t') && b == '\n' {
            return true;
        }
        if matches!(a, '\n' | '\t' | ' ') && b == '#' {
            return true;
        }
    }
    matches!(chars.last(), Some('\n' | '\t' | ' ' | ':'))
}

/// Whether a plain scalar of this text would read back as a null, a boolean
/// or a number under the core schema.
fn resolves_to_other_type(text: &str) -> bool {
    let probe = Scalar { value: text.to_string(), style: ScalarStyle::Plain, tag: None, range: (0, 0) };
    !matches!(resolve(&probe), Value::String(_))
}

fn quoted(value: &str, ctx: &mut Ctx) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

fn single_quoted(value: &str, ctx: &mut Ctx) -> String {
    let around_newline = value.contains(" \n") || value.contains("\t\n") || value.contains("\n ") || value.contains("\n\t");
    if (ctx.implicit_key && value.contains('\n')) || around_newline {
        return double_quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        "  ".into()
    } else {
        String::new()
    };
    let body = replace_newline_runs(&value.replace('\'', "''"), |run| format!("{run}\n{indent}"));
    let res = format!("'{body}'");
    if ctx.implicit_key {
        res
    } else {
        fold_flow_lines(&res, &indent, Fold::Flow, ctx.indent_at_start, ctx.line_width, false).0
    }
}

/// `JSON.stringify` of a string.
pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn double_quoted(value: &str, ctx: &mut Ctx) -> String {
    let json = json_string(value);
    let b = json.as_bytes();
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        "  ".into()
    } else {
        String::new()
    };
    let at = |i: usize| b.get(i).copied();
    let mut out = String::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        let mut ch = b[i];
        if ch == b' ' && at(i + 1) == Some(b'\\') && at(i + 2) == Some(b'n') {
            out.push_str(&json[start..i]);
            out.push_str("\\ ");
            i += 1;
            start = i;
            ch = b'\\';
        }
        if ch == b'\\' {
            match at(i + 1) {
                Some(b'u') => {
                    out.push_str(&json[start..i]);
                    let code = &json[i + 2..i + 6];
                    match code {
                        "0000" => out.push_str("\\0"),
                        "0007" => out.push_str("\\a"),
                        "000b" => out.push_str("\\v"),
                        "001b" => out.push_str("\\e"),
                        "0085" => out.push_str("\\N"),
                        "00a0" => out.push_str("\\_"),
                        "2028" => out.push_str("\\L"),
                        "2029" => out.push_str("\\P"),
                        _ if code.starts_with("00") => {
                            out.push_str("\\x");
                            out.push_str(&code[2..]);
                        }
                        _ => out.push_str(&json[i..i + 6]),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some(b'n') => {
                    if ctx.implicit_key || at(i + 2) == Some(b'"') || utf16_len(&json) < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH {
                        i += 1;
                    } else {
                        out.push_str(&json[start..i]);
                        out.push_str("\n\n");
                        while at(i + 2) == Some(b'\\') && at(i + 3) == Some(b'n') && at(i + 4) != Some(b'"') {
                            out.push('\n');
                            i += 2;
                        }
                        out.push_str(&indent);
                        if at(i + 2) == Some(b' ') {
                            out.push('\\');
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let text = if start > 0 { format!("{out}{}", &json[start..]) } else { json.clone() };
    if ctx.implicit_key {
        text
    } else {
        fold_flow_lines(&text, &indent, Fold::Quoted, ctx.indent_at_start, ctx.line_width, false).0
    }
}

fn line_length_over_limit(text: &str, line_width: usize, indent_length: usize) -> bool {
    if line_width == 0 {
        return false;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let limit = line_width as isize - indent_length as isize;
    let len = units.len() as isize;
    if len <= limit {
        return false;
    }
    let mut start: isize = 0;
    for (i, &unit) in units.iter().enumerate() {
        if unit == u16::from(b'\n') {
            if i as isize - start > limit {
                return true;
            }
            start = i as isize + 1;
            if len - start <= limit {
                return false;
            }
        }
    }
    true
}

fn block(value: &str, ctx: &mut Ctx) -> String {
    let trailing_whitespace_line = value
        .rfind('\n')
        .is_some_and(|nl| value.len() > nl + 1 && value[nl + 1..].chars().all(|c| c == ' ' || c == '\t'));
    if trailing_whitespace_line {
        return quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if ctx.force_block_indent || contains_document_marker(value) {
        "  ".into()
    } else {
        String::new()
    };
    let literal = !line_length_over_limit(value, ctx.line_width, utf16_len(&indent));
    if value.is_empty() {
        return if literal { "|\n".into() } else { ">\n".into() };
    }
    let chars: Vec<char> = value.chars().collect();
    let mut end_start = chars.len();
    while end_start > 0 && matches!(chars[end_start - 1], '\n' | '\t' | ' ') {
        end_start -= 1;
    }
    let mut end: String = chars[end_start..].iter().collect();
    let end_nl = end.find('\n');
    let chomp = match end_nl {
        None => "-",
        Some(pos) if end_start == 0 || pos != end.len() - 1 => "+",
        Some(_) => "",
    };
    let mut body: String = chars[..end_start].iter().collect();
    if !end.is_empty() {
        if end.ends_with('\n') {
            end.pop();
        }
        end = indent_inner_newline_runs(&end, &indent);
    }
    let body_chars: Vec<char> = body.chars().collect();
    let mut start_with_space = false;
    let mut start_nl: isize = -1;
    let mut start_end = 0usize;
    while start_end < body_chars.len() {
        match body_chars[start_end] {
            ' ' => start_with_space = true,
            '\n' => start_nl = start_end as isize,
            _ => break,
        }
        start_end += 1;
    }
    let start_len = if start_nl < start_end as isize { (start_nl + 1) as usize } else { start_end };
    let mut start: String = body_chars[..start_len].iter().collect();
    if !start.is_empty() {
        body = body_chars[start_len..].iter().collect();
        start = replace_newline_runs(&start, |run| format!("{run}{indent}"));
    }
    let indent_size = if indent.is_empty() { "1" } else { "2" };
    let header = format!("{}{chomp}", if start_with_space { indent_size } else { "" });
    if !literal {
        let doubled = replace_newline_runs(&body, |run| format!("\n{run}"));
        let unfolded = keep_more_indented(&doubled);
        let folded = replace_newline_runs(&unfolded, |run| format!("{run}{indent}"));
        let (text, overflowed) =
            fold_flow_lines(&format!("{start}{folded}{end}"), &indent, Fold::Block, Some(utf16_len(&ctx.indent)), ctx.line_width, true);
        if !overflowed {
            return format!(">{header}\n{indent}{text}");
        }
    }
    let body = replace_newline_runs(&body, |run| format!("{run}{indent}"));
    format!("|{header}\n{indent}{start}{body}{end}")
}

/// `text.replace(/\n+/g, f)`: each maximal run of newlines replaced.
fn replace_newline_runs(text: &str, f: impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run_start: Option<usize> = None;
    for (at, c) in text.char_indices() {
        if c == '\n' {
            run_start.get_or_insert(at);
            continue;
        }
        if let Some(start) = run_start.take() {
            out.push_str(&f(&text[start..at]));
        }
        out.push(c);
    }
    if let Some(start) = run_start {
        out.push_str(&f(&text[start..]));
    }
    out
}

/// `/(^|(?<!\n))\n+(?!\n|$)/g` replaced with `$&<indent>`: a run of newlines
/// not ending the text gets the indent after it.
fn indent_inner_newline_runs(text: &str, indent: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run_start: Option<usize> = None;
    for (at, c) in text.char_indices() {
        if c == '\n' {
            run_start.get_or_insert(at);
            continue;
        }
        if let Some(start) = run_start.take() {
            out.push_str(&text[start..at]);
            out.push_str(indent);
        }
        out.push(c);
    }
    if let Some(start) = run_start {
        out.push_str(&text[start..]);
    }
    out
}

/// `/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g` replaced with `$1$2`:
/// more-indented lines are not folded.
fn keep_more_indented(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let line_end = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let mut out = String::new();
    let mut k = 0usize;
    while k < chars.len() {
        let group = if k == 0 && matches!(chars[0], '\t' | ' ') {
            Some(0)
        } else if chars[k] == '\n' && matches!(chars.get(k + 1), Some('\t' | ' ')) {
            Some(k + 1)
        } else {
            None
        };
        let Some(g) = group else {
            out.push(chars[k]);
            k += 1;
            continue;
        };
        let mut e = g;
        while e < chars.len() && !line_end(chars[e]) {
            e += 1;
        }
        let mut r = e;
        while r < chars.len() && matches!(chars[r], '\n' | '\t' | ' ') {
            r += 1;
        }
        out.extend(&chars[g..e]);
        if r > e && chars[r - 1] == '\n' {
            out.extend(&chars[e..r - 1]);
            k = r;
        } else {
            k = e;
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fold {
    Flow,
    Block,
    Quoted,
}

/// `foldFlowLines`, over UTF-16 units as JavaScript counts them. Answers the
/// text and whether a line overflowed.
fn fold_flow_lines(
    text: &str,
    indent: &str,
    mode: Fold,
    indent_at_start: Option<usize>,
    line_width: usize,
    watch_overflow: bool,
) -> (String, bool) {
    if line_width == 0 {
        return (text.to_string(), false);
    }
    let t: Vec<u16> = text.encode_utf16().collect();
    let ind = utf16_len(indent) as isize;
    let lw = line_width as isize;
    let min_content = if line_width < MIN_CONTENT_WIDTH { 0 } else { MIN_CONTENT_WIDTH as isize };
    let end_step = (1 + min_content).max(1 + lw - ind);
    if (t.len() as isize) <= end_step {
        return (text.to_string(), false);
    }
    let at = |i: isize| if i >= 0 { t.get(i as usize).copied() } else { None };
    let sp = u16::from(b' ');
    let tab = u16::from(b'\t');
    let nl = u16::from(b'\n');
    let mut folds: Vec<isize> = Vec::new();
    let mut escaped: Vec<isize> = Vec::new();
    let mut end = lw - ind;
    if let Some(start) = indent_at_start {
        if start as isize > lw - 2.max(min_content) {
            folds.push(0);
        } else {
            end = lw - start as isize;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: isize = -1;
    let mut esc_start: isize = -1;
    let mut esc_end: isize = -1;
    if mode == Fold::Block {
        i = consume_more_indented_lines(&t, i, ind);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(mut ch) = at(i) else { break };
        if mode == Fold::Quoted && ch == u16::from(b'\\') {
            esc_start = i;
            i += match at(i + 1).map(|u| u as u8 as char) {
                Some('x') => 3,
                Some('u') => 5,
                Some('U') => 9,
                _ => 1,
            };
            esc_end = i;
        }
        let mut current = Some(ch);
        if ch == nl {
            if mode == Fold::Block {
                i = consume_more_indented_lines(&t, i, ind);
            }
            end = i + ind + end_step;
            split = None;
        } else {
            if ch == sp && prev.is_some_and(|p| p != sp && p != nl && p != tab) {
                let next = at(i + 1);
                if next.is_some_and(|n| n != sp && n != nl && n != tab) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(s) = split.filter(|&s| s != 0) {
                    folds.push(s);
                    end = s + end_step;
                    split = None;
                } else if mode == Fold::Quoted {
                    while prev == Some(sp) || prev == Some(tab) {
                        prev = current;
                        i += 1;
                        current = at(i);
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped.contains(&j) {
                        return (text.to_string(), false);
                    }
                    folds.push(j);
                    escaped.push(j);
                    end = j + end_step;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        if let Some(c) = current {
            ch = c;
            prev = Some(ch);
        } else {
            prev = None;
        }
    }
    let overflowed = overflow && watch_overflow;
    if folds.is_empty() {
        return (text.to_string(), overflowed);
    }
    let slice = |a: isize, b: isize| -> Vec<u16> {
        let len = t.len() as isize;
        let norm = |x: isize| if x < 0 { (len + x).max(0) } else { x.min(len) } as usize;
        let (a, b) = (norm(a), norm(b));
        if a < b { t[a..b].to_vec() } else { Vec::new() }
    };
    let indent_units: Vec<u16> = indent.encode_utf16().collect();
    let mut res: Vec<u16> = slice(0, folds[0]);
    for (n, &fold) in folds.iter().enumerate() {
        let next_end = match folds.get(n + 1) {
            Some(&f) if f != 0 => f,
            _ => t.len() as isize,
        };
        if fold == 0 {
            res = vec![nl];
            res.extend(&indent_units);
            res.extend(slice(0, next_end));
        } else {
            if mode == Fold::Quoted && escaped.contains(&fold) {
                if let Some(c) = at(fold) {
                    res.push(c);
                }
                res.push(u16::from(b'\\'));
            }
            res.push(nl);
            res.extend(&indent_units);
            res.extend(slice(fold + 1, next_end));
        }
    }
    (String::from_utf16_lossy(&res), overflowed)
}

fn consume_more_indented_lines(t: &[u16], mut i: isize, indent: isize) -> isize {
    let at = |i: isize| if i >= 0 { t.get(i as usize).copied() } else { None };
    let sp = u16::from(b' ');
    let tab = u16::from(b'\t');
    let nl = u16::from(b'\n');
    let mut end = i;
    let mut start = i + 1;
    let mut ch = at(start);
    while ch == Some(sp) || ch == Some(tab) {
        if i < start + indent {
            i += 1;
            ch = at(i);
        } else {
            loop {
                i += 1;
                ch = at(i);
                if ch.is_none() || ch == Some(nl) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = at(start);
        }
    }
    end
}
