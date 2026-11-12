//! The leaf steps of composing — a twin of `yaml@2.8.3`'s `dist/compose/resolve-props.js`,
//! `resolve-end.js`, `resolve-flow-scalar.js`, `resolve-block-scalar.js`,
//! `util-empty-scalar-position.js` and `util-contains-newline.js`, of the tag-name half of
//! `dist/doc/directives.js`, and of the scalar tags of the core schema (`dist/schema/core/*`,
//! `common/*`) and the `yaml-1.1` tags the core schema knows (`binary`, `merge`, `timestamp`).
//!
//! No Telo twin (see `yaml_cst.rs`). Each function is the one of the same name; every
//! message is `yaml`'s, word for word.

use std::collections::HashMap;

use telorun_cel_value::es_string_to_number;

use crate::yaml_cst::{Kind, SourceToken, Src, Token, TokenId, TokenType, Units};
use crate::yaml_errors::ErrorAt;

/// An error `onError` is handed: where, `yaml`'s code and message. Warnings are dropped
/// where they are raised — no loader reads one.
#[derive(Debug, Clone)]
pub struct RawError {
    pub at: ErrorAt,
    pub code: &'static str,
    pub message: String,
}

/// The error sink, `onError`.
pub struct Errors<'e> {
    pub list: &'e mut Vec<RawError>,
}

impl Errors<'_> {
    pub fn error(&mut self, at: ErrorAt, code: &'static str, message: impl Into<String>) {
        self.list.push(RawError { at, code, message: message.into() });
    }

    /// `onError(..., warning)`: a warning is dropped, an error kept.
    pub fn maybe(&mut self, at: ErrorAt, code: &'static str, message: impl Into<String>, warning: bool) {
        if !warning {
            self.error(at, code, message);
        }
    }
}

/// A token as an error position: its offset and its source's length.
pub fn token_at(token: &SourceToken) -> ErrorAt {
    ErrorAt::Token { offset: token.offset, len: Some(token.source.len()) }
}

/// A composite token as an error position.
pub fn cst_at(token: &Token) -> ErrorAt {
    ErrorAt::Token { offset: token.offset(), len: token.source().map(Src::len) }
}

/// What `resolveProps` reads of its `next` token.
#[derive(Debug, Clone, Copy)]
pub struct NextToken {
    pub kind: Kind,
    pub offset: usize,
    pub source_empty: bool,
}

impl NextToken {
    pub fn of_token(token: &Token) -> Self {
        Self { kind: token.kind(), offset: token.offset(), source_empty: token.source().is_some_and(Src::is_empty) }
    }

    pub fn of_source(token: &SourceToken) -> Self {
        Self { kind: Kind::Source(token.ty), offset: token.offset, source_empty: token.source.is_empty() }
    }

    fn is(&self, ty: TokenType) -> bool {
        self.kind == Kind::Source(ty)
    }
}

pub struct PropsArgs {
    pub flow: Option<&'static str>,
    pub indicator: TokenType,
    pub next: Option<NextToken>,
    pub offset: usize,
    pub parent_indent: usize,
    pub start_on_newline: bool,
}

/// `resolveProps`'s result. `comment` is kept as the code units `yaml` builds it from, since
/// a flow collection cuts it by length.
#[derive(Debug, Clone)]
pub struct Props {
    pub comma: Option<SourceToken>,
    pub found: Option<SourceToken>,
    pub comment: Vec<u16>,
    pub has_newline: bool,
    pub anchor: Option<SourceToken>,
    pub tag: Option<SourceToken>,
    pub newline_after_prop: Option<SourceToken>,
    pub end: usize,
    pub start: usize,
}

pub fn resolve_props(units: Units<'_>, tokens: &[SourceToken], args: PropsArgs, errors: &mut Errors<'_>) -> Props {
    let mut at_newline = args.start_on_newline;
    let mut has_space = args.start_on_newline;
    let mut comment: Vec<u16> = Vec::new();
    let mut comment_sep: Vec<u16> = Vec::new();
    let mut has_newline = false;
    let mut req_space = false;
    let mut tab: Option<SourceToken> = None;
    let mut anchor: Option<SourceToken> = None;
    let mut tag: Option<SourceToken> = None;
    let mut newline_after_prop: Option<SourceToken> = None;
    let mut comma: Option<SourceToken> = None;
    let mut found: Option<SourceToken> = None;
    let mut start: Option<usize> = None;
    for token in tokens {
        if req_space {
            if !matches!(token.ty, TokenType::Space | TokenType::Newline | TokenType::Comma) {
                errors.error(
                    ErrorAt::Offset(token.offset),
                    "MISSING_CHAR",
                    "Tags and anchors must be separated from the next token by white space",
                );
            }
            req_space = false;
        }
        if let Some(t) = tab.take() {
            if at_newline && !matches!(token.ty, TokenType::Comment | TokenType::Newline) {
                errors.error(token_at(&t), "TAB_AS_INDENT", "Tabs are not allowed as indentation");
            }
        }
        match token.ty {
            TokenType::Space => {
                // At the doc level, tabs at line start may be parsed as leading white space
                // rather than indentation. In a flow collection, only the parser handles indent.
                if args.flow.is_none()
                    && (args.indicator != TokenType::DocStart
                        || args.next.map(|next| next.kind) != Some(Kind::FlowCollection))
                    && units.of(token.source).contains(&(b'\t' as u16))
                {
                    tab = Some(*token);
                }
                has_space = true;
            }
            TokenType::Comment => {
                if !has_space {
                    errors.error(
                        token_at(token),
                        "MISSING_CHAR",
                        "Comments must be separated from other tokens by white space characters",
                    );
                }
                let source = units.of(token.source);
                let cb: &[u16] = if source.len() > 1 { &source[1..] } else { &[b' ' as u16] };
                if comment.is_empty() {
                    comment = cb.to_vec();
                } else {
                    comment.extend_from_slice(&comment_sep);
                    comment.extend_from_slice(cb);
                }
                comment_sep.clear();
                at_newline = false;
            }
            TokenType::Newline => {
                if at_newline {
                    if !comment.is_empty() {
                        comment.extend_from_slice(units.of(token.source));
                    }
                } else {
                    comment_sep.extend_from_slice(units.of(token.source));
                }
                at_newline = true;
                has_newline = true;
                if anchor.is_some() || tag.is_some() {
                    newline_after_prop = Some(*token);
                }
                has_space = true;
            }
            TokenType::Anchor => {
                if anchor.is_some() {
                    errors.error(token_at(token), "MULTIPLE_ANCHORS", "A node can have at most one anchor");
                }
                anchor = Some(*token);
                start.get_or_insert(token.offset);
                at_newline = false;
                has_space = false;
                req_space = true;
            }
            TokenType::Tag => {
                if tag.is_some() {
                    errors.error(token_at(token), "MULTIPLE_TAGS", "A node can have at most one tag");
                }
                tag = Some(*token);
                start.get_or_insert(token.offset);
                at_newline = false;
                has_space = false;
                req_space = true;
            }
            ty if ty == args.indicator => {
                if anchor.is_some() || tag.is_some() {
                    errors.error(
                        token_at(token),
                        "BAD_PROP_ORDER",
                        format!("Anchors and tags must be after the {} indicator", units.string(token.source)),
                    );
                }
                if found.is_some() {
                    errors.error(
                        token_at(token),
                        "UNEXPECTED_TOKEN",
                        format!("Unexpected {} in {}", units.string(token.source), args.flow.unwrap_or("collection")),
                    );
                }
                found = Some(*token);
                at_newline = matches!(args.indicator, TokenType::SeqItemInd | TokenType::ExplicitKeyInd);
                has_space = false;
            }
            TokenType::Comma if args.flow.is_some() => {
                if comma.is_some() {
                    errors.error(
                        token_at(token),
                        "UNEXPECTED_TOKEN",
                        format!("Unexpected , in {}", args.flow.unwrap_or_default()),
                    );
                }
                comma = Some(*token);
                at_newline = false;
                has_space = false;
            }
            ty => {
                errors.error(token_at(token), "UNEXPECTED_TOKEN", format!("Unexpected {} token", ty.name()));
                at_newline = false;
                has_space = false;
            }
        }
    }
    let end = match tokens.last() {
        Some(last) => last.offset + last.source.len(),
        None => args.offset,
    };
    if req_space {
        if let Some(next) = args.next {
            if !next.is(TokenType::Space)
                && !next.is(TokenType::Newline)
                && !next.is(TokenType::Comma)
                && (next.kind != Kind::FlowScalar(crate::yaml_cst::FlowScalarType::Scalar) || !next.source_empty)
            {
                errors.error(
                    ErrorAt::Offset(next.offset),
                    "MISSING_CHAR",
                    "Tags and anchors must be separated from the next token by white space",
                );
            }
        }
    }
    if let Some(t) = tab {
        if (at_newline && t.indent <= args.parent_indent)
            || args.next.is_some_and(|next| matches!(next.kind, Kind::BlockMap | Kind::BlockSeq))
        {
            errors.error(token_at(&t), "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
    }
    Props {
        comma,
        found,
        comment,
        has_newline,
        anchor,
        tag,
        newline_after_prop,
        end,
        start: start.unwrap_or(end),
    }
}

/// `resolveEnd`: the offset past a node's trailing tokens.
pub fn resolve_end(
    end: Option<&[SourceToken]>,
    mut offset: usize,
    req_space: bool,
    errors: &mut Errors<'_>,
) -> (bool, usize) {
    let mut has_comment = false;
    if let Some(end) = end {
        let mut has_space = false;
        for token in end {
            match token.ty {
                TokenType::Space => has_space = true,
                TokenType::Comment => {
                    if req_space && !has_space {
                        errors.error(
                            token_at(token),
                            "MISSING_CHAR",
                            "Comments must be separated from other tokens by white space characters",
                        );
                    }
                    has_comment = true;
                }
                TokenType::Newline => has_space = true,
                ty => errors.error(token_at(token), "UNEXPECTED_TOKEN", format!("Unexpected {} at node end", ty.name())),
            }
            offset += token.source.len();
        }
    }
    (has_comment, offset)
}

/// `emptyScalarPosition`.
pub fn empty_scalar_position(mut offset: usize, before: Option<&[SourceToken]>) -> usize {
    if let Some(before) = before {
        let mut i = before.len();
        while i > 0 {
            i -= 1;
            let st = &before[i];
            if matches!(st.ty, TokenType::Space | TokenType::Comment | TokenType::Newline) {
                offset -= st.source.len();
                continue;
            }
            // An empty scalar is technically right after the last non-empty node, but placed
            // after any whitespace.
            let mut j = i + 1;
            while let Some(st) = before.get(j).filter(|st| st.ty == TokenType::Space) {
                offset += st.source.len();
                j += 1;
            }
            break;
        }
    }
    offset
}

/// `containsNewline`, over an explicit stack.
pub fn contains_newline(units: Units<'_>, arena: &[Token], key: Option<TokenId>) -> bool {
    let Some(key) = key else { return false };
    let mut stack = vec![key];
    while let Some(id) = stack.pop() {
        match &arena[id] {
            Token::FlowScalar { source, end, .. } => {
                if units.of(*source).contains(&(b'\n' as u16)) {
                    return true;
                }
                if end.as_ref().is_some_and(|end| end.iter().any(|st| st.ty == TokenType::Newline)) {
                    return true;
                }
            }
            Token::FlowCollection { items, .. } => {
                // Depth first, items in order: the first newline anywhere answers.
                let mut nested = Vec::new();
                for it in items {
                    if it.start.iter().any(|st| st.ty == TokenType::Newline) {
                        return true;
                    }
                    if it.sep.as_ref().is_some_and(|sep| sep.iter().any(|st| st.ty == TokenType::Newline)) {
                        return true;
                    }
                    nested.extend(it.key);
                    nested.extend(it.value);
                }
                // The answer is a disjunction, so the order of the walk cannot change it.
                stack.extend(nested);
            }
            _ => return true,
        }
    }
    false
}

/// A flow scalar's resolution: its value as code units, its style, and
/// `[start, valueEnd, end]`.
pub struct FlowScalarValue {
    pub value: Vec<u16>,
    pub style: FlowStyle,
    pub range: [usize; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowStyle {
    Plain,
    SingleQuoted,
    DoubleQuoted,
}

/// A JavaScript exception thrown while composing, which `composeCollection` catches.
#[derive(Debug, Clone)]
pub struct Thrown {
    pub message: String,
}

fn u(c: char) -> u16 {
    c as u16
}

fn is_ws(c: Option<&u16>) -> bool {
    matches!(c, Some(&c) if c == u(' ') || c == u('\t'))
}

/// `resolveFlowScalar`. A scalar written with an escape past U+10FFFF throws, as
/// `String.fromCodePoint` does.
pub fn resolve_flow_scalar(
    style: FlowStyle,
    offset: usize,
    source: &[u16],
    end: Option<&[SourceToken]>,
    strict: bool,
    errors: &mut Errors<'_>,
) -> Result<FlowScalarValue, Thrown> {
    let value = match style {
        FlowStyle::Plain => plain_value(source, offset, errors),
        FlowStyle::SingleQuoted => single_quoted_value(source, offset, errors),
        FlowStyle::DoubleQuoted => double_quoted_value(source, offset, errors)?,
    };
    let value_end = offset + source.len();
    let (_, re) = resolve_end(end, value_end, strict, errors);
    Ok(FlowScalarValue { value, style, range: [offset, value_end, re] })
}

fn plain_value(source: &[u16], offset: usize, errors: &mut Errors<'_>) -> Vec<u16> {
    let bad = match source.first().and_then(|c| char::from_u32(u32::from(*c))) {
        Some('\t') => Some("a tab character".to_string()),
        Some(',') => Some("flow indicator character ,".to_string()),
        Some('%') => Some("directive indicator character %".to_string()),
        Some(c @ ('|' | '>')) => Some(format!("block scalar indicator {c}")),
        Some(c @ ('@' | '`')) => Some(format!("reserved character {c}")),
        _ => None,
    };
    if let Some(bad) = bad {
        errors.error(ErrorAt::Offset(offset), "BAD_SCALAR_START", format!("Plain value cannot start with {bad}"));
    }
    fold_lines(source)
}

fn single_quoted_value(source: &[u16], offset: usize, errors: &mut Errors<'_>) -> Vec<u16> {
    if source.last() != Some(&u('\'')) || source.len() == 1 {
        errors.error(ErrorAt::Offset(offset + source.len()), "MISSING_CHAR", "Missing closing 'quote");
    }
    let inner: &[u16] = if source.len() >= 2 { &source[1..source.len() - 1] } else { &[] };
    let folded = fold_lines(inner);
    let mut out = Vec::with_capacity(folded.len());
    let mut i = 0;
    while i < folded.len() {
        if folded[i] == u('\'') && folded.get(i + 1) == Some(&u('\'')) {
            out.push(u('\''));
            i += 2;
        } else {
            out.push(folded[i]);
            i += 1;
        }
    }
    out
}

/// `foldLines`: each line trimmed of the white space around it, single line breaks folded
/// to a space and runs of them to all but one.
fn fold_lines(source: &[u16]) -> Vec<u16> {
    let lf = u('\n');
    let cr = u('\r');
    let Some(first_nl) = source.iter().position(|c| *c == lf) else { return source.to_vec() };
    let mut q = first_nl;
    if q > 0 && source[q - 1] == cr {
        q -= 1;
    }
    while q > 0 && is_ws(source.get(q - 1)) {
        q -= 1;
    }
    let mut res: Vec<u16> = source[..q].to_vec();
    let mut sep: &[u16] = &[b' ' as u16];
    let newline: &[u16] = &[b'\n' as u16];
    let space: &[u16] = &[b' ' as u16];
    let mut pos = first_nl + 1;
    while let Some(rel) = source[pos..].iter().position(|c| *c == lf) {
        let nl = pos + rel;
        let mut b = pos;
        while b < nl && is_ws(source.get(b)) {
            b += 1;
        }
        let mut e = nl;
        if e > b && source[e - 1] == cr {
            e -= 1;
        }
        while e > b && is_ws(source.get(e - 1)) {
            e -= 1;
        }
        let line = &source[b..e];
        if line.is_empty() {
            if sep == newline {
                res.extend_from_slice(sep);
            } else {
                sep = newline;
            }
        } else {
            res.extend_from_slice(sep);
            res.extend_from_slice(line);
            sep = space;
        }
        pos = nl + 1;
    }
    let mut b = pos;
    while b < source.len() && is_ws(source.get(b)) {
        b += 1;
    }
    res.extend_from_slice(sep);
    res.extend_from_slice(&source[b..]);
    res
}

fn escape_code(c: u16) -> Option<&'static [u16]> {
    const NUL: &[u16] = &[0];
    const BEL: &[u16] = &[7];
    const BS: &[u16] = &[8];
    const ESC: &[u16] = &[0x1b];
    const FF: &[u16] = &[0x0c];
    const LF: &[u16] = &[0x0a];
    const CR: &[u16] = &[0x0d];
    const TAB: &[u16] = &[0x09];
    const VT: &[u16] = &[0x0b];
    const NEL: &[u16] = &[0x85];
    const NBSP: &[u16] = &[0xa0];
    const LS: &[u16] = &[0x2028];
    const PS: &[u16] = &[0x2029];
    const SPACE: &[u16] = &[0x20];
    const QUOTE: &[u16] = &[0x22];
    const SLASH: &[u16] = &[0x2f];
    const BACKSLASH: &[u16] = &[0x5c];
    Some(match char::from_u32(u32::from(c))? {
        '0' => NUL,
        'a' => BEL,
        'b' => BS,
        'e' => ESC,
        'f' => FF,
        'n' => LF,
        'r' => CR,
        't' => TAB,
        'v' => VT,
        'N' => NEL,
        '_' => NBSP,
        'L' => LS,
        'P' => PS,
        ' ' => SPACE,
        '"' => QUOTE,
        '/' => SLASH,
        '\\' => BACKSLASH,
        '\t' => TAB,
        _ => return None,
    })
}

fn double_quoted_value(source: &[u16], offset: usize, errors: &mut Errors<'_>) -> Result<Vec<u16>, Thrown> {
    let at = |i: usize| source.get(i).copied();
    let mut res: Vec<u16> = Vec::new();
    let mut i = 1;
    while i + 1 < source.len() {
        let ch = source[i];
        if ch == u('\r') && at(i + 1) == Some(u('\n')) {
            i += 1;
            continue;
        }
        if ch == u('\n') {
            let (fold, next) = fold_newline(source, i);
            res.extend_from_slice(&fold);
            i = next;
        } else if ch == u('\\') {
            i += 1;
            let next = at(i);
            if let Some(code) = next.and_then(escape_code) {
                res.extend_from_slice(code);
            } else if next == Some(u('\n')) {
                // Skip escaped newlines, but still trim the following line.
                let mut n = at(i + 1);
                while n == Some(u(' ')) || n == Some(u('\t')) {
                    i += 1;
                    n = at(i + 1);
                }
            } else if next == Some(u('\r')) && at(i + 1) == Some(u('\n')) {
                // Skip escaped CRLF newlines, but still trim the following line.
                i += 1;
                let mut n = at(i + 1);
                while n == Some(u(' ')) || n == Some(u('\t')) {
                    i += 1;
                    n = at(i + 1);
                }
            } else if next == Some(u('x')) || next == Some(u('u')) || next == Some(u('U')) {
                let length = if next == Some(u('x')) {
                    2
                } else if next == Some(u('u')) {
                    4
                } else {
                    8
                };
                res.extend(parse_char_code(source, i + 1, length, offset, errors)?);
                i += length;
            } else {
                let raw: Vec<u16> = source[i - 1..(i + 1).min(source.len())].to_vec();
                errors.error(
                    ErrorAt::Offset(offset + i - 1),
                    "BAD_DQ_ESCAPE",
                    format!("Invalid escape sequence {}", String::from_utf16_lossy(&raw)),
                );
                res.extend(raw);
            }
        } else if ch == u(' ') || ch == u('\t') {
            // Trim trailing white space.
            let ws_start = i;
            let mut next = at(i + 1);
            while next == Some(u(' ')) || next == Some(u('\t')) {
                i += 1;
                next = at(i + 1);
            }
            if next != Some(u('\n')) && !(next == Some(u('\r')) && at(i + 2) == Some(u('\n'))) {
                if i > ws_start {
                    res.extend_from_slice(&source[ws_start..=i]);
                } else {
                    res.push(ch);
                }
            }
        } else {
            res.push(ch);
        }
        i += 1;
    }
    if source.last() != Some(&u('"')) || source.len() == 1 {
        errors.error(ErrorAt::Offset(offset + source.len()), "MISSING_CHAR", "Missing closing \"quote");
    }
    Ok(res)
}

/// `foldNewline`: a single newline folds to a space, several to all but one. `offset` is
/// at the newline.
fn fold_newline(source: &[u16], mut offset: usize) -> (Vec<u16>, usize) {
    let mut fold: Vec<u16> = Vec::new();
    let mut ch = source.get(offset + 1).copied();
    while matches!(ch, Some(c) if c == u(' ') || c == u('\t') || c == u('\n') || c == u('\r')) {
        if ch == Some(u('\r')) && source.get(offset + 2) != Some(&u('\n')) {
            break;
        }
        if ch == Some(u('\n')) {
            fold.push(u('\n'));
        }
        offset += 1;
        ch = source.get(offset + 1).copied();
    }
    if fold.is_empty() {
        fold.push(u(' '));
    }
    (fold, offset)
}

fn parse_char_code(
    source: &[u16],
    at: usize,
    length: usize,
    offset: usize,
    errors: &mut Errors<'_>,
) -> Result<Vec<u16>, Thrown> {
    let cc: &[u16] = &source[at.min(source.len())..(at + length).min(source.len())];
    let ok = cc.len() == length && cc.iter().all(|c| (*c as u8 as u16 == *c) && (*c as u8).is_ascii_hexdigit());
    if !ok {
        let raw = &source[(at - 2).min(source.len())..(at + length).min(source.len())];
        errors.error(
            ErrorAt::Offset(offset + at - 2),
            "BAD_DQ_ESCAPE",
            format!("Invalid escape sequence {}", String::from_utf16_lossy(raw)),
        );
        return Ok(raw.to_vec());
    }
    let text = String::from_utf16_lossy(cc);
    let code = u64::from_str_radix(&text, 16).expect("hex digits");
    if code > 0x10ffff {
        return Err(Thrown { message: format!("Invalid code point {code}") });
    }
    let code = code as u32;
    if (0xd800..0xe000).contains(&code) {
        return Ok(vec![code as u16]);
    }
    let c = char::from_u32(code).expect("a scalar value");
    let mut buf = [0u16; 2];
    Ok(c.encode_utf16(&mut buf).to_vec())
}

/// A block scalar's resolution.
pub struct BlockScalarValue {
    pub value: Vec<u16>,
    pub folded: bool,
    pub range: [usize; 3],
}

/// What a block scalar's header holds (`parseBlockScalarHeader`).
struct BlockHeader {
    folded: bool,
    indent: usize,
    chomp: u16,
    length: usize,
}

/// `resolveBlockScalar`. `None` is the impossible missing header, `yaml`'s typeless value.
pub fn resolve_block_scalar(
    units: Units<'_>,
    arena: &[Token],
    token: TokenId,
    at_root: bool,
    strict: bool,
    errors: &mut Errors<'_>,
) -> Option<BlockScalarValue> {
    let Token::BlockScalar { offset, indent: scalar_indent, props, source } = &arena[token] else { return None };
    let start = *offset;
    let Some(header) = parse_block_scalar_header(units, arena, start, props, strict, errors) else {
        return Some(BlockScalarValue { value: Vec::new(), folded: false, range: [start, start, start] });
    };
    let source = units.of(*source);
    let lines = if source.is_empty() { Vec::new() } else { split_lines(source) };
    let is_blank = |content: &[u16]| content.is_empty() || content == [u('\r')];
    // The end of content, and the start of chomping.
    let mut chomp_start = lines.len();
    for i in (0..lines.len()).rev() {
        if is_blank(lines[i].1) {
            chomp_start = i;
        } else {
            break;
        }
    }
    // A shortcut for empty contents.
    if chomp_start == 0 {
        let value = if header.chomp == u('+') && !lines.is_empty() {
            vec![u('\n'); 1.max(lines.len() - 1)]
        } else {
            Vec::new()
        };
        let mut end = start + header.length;
        if !source.is_empty() {
            end += source.len();
        }
        return Some(BlockScalarValue { value, folded: header.folded, range: [start, end, end] });
    }
    // The indentation to trim from each line.
    let mut trim_indent = scalar_indent + header.indent;
    let mut offset = start + header.length;
    let mut content_start = 0;
    for i in 0..chomp_start {
        let (indent, content) = lines[i];
        if is_blank(content) {
            if header.indent == 0 && indent.len() > trim_indent {
                trim_indent = indent.len();
            }
        } else {
            if indent.len() < trim_indent {
                errors.error(
                    ErrorAt::Offset(offset + indent.len()),
                    "MISSING_CHAR",
                    "Block scalars with more-indented leading empty lines must use an explicit indentation indicator",
                );
            }
            if header.indent == 0 {
                trim_indent = indent.len();
            }
            content_start = i;
            if trim_indent == 0 && !at_root {
                errors.error(ErrorAt::Offset(offset), "BAD_INDENT", "Block scalar values in collections must be indented");
            }
            break;
        }
        offset += indent.len() + content.len() + 1;
    }
    // Trailing more-indented empty lines are content.
    for i in (chomp_start..lines.len()).rev() {
        if lines[i].0.len() > trim_indent {
            chomp_start = i + 1;
        }
    }
    let slice_from = |text: &[u16], from: usize| -> Vec<u16> { text.get(from..).map(<[u16]>::to_vec).unwrap_or_default() };
    let mut value: Vec<u16> = Vec::new();
    let mut sep: Vec<u16> = Vec::new();
    let mut prev_more_indented = false;
    // Leading white space is kept intact.
    for line in lines.iter().take(content_start) {
        value.extend(slice_from(line.0, trim_indent));
        value.push(u('\n'));
    }
    for line in lines.iter().take(chomp_start).skip(content_start) {
        let (mut indent, mut content) = *line;
        offset += indent.len() + content.len() + 1;
        let crlf = content.last() == Some(&u('\r'));
        if crlf {
            content = &content[..content.len() - 1];
        }
        if !content.is_empty() && indent.len() < trim_indent {
            let src = if header.indent != 0 { "explicit indentation indicator" } else { "first line" };
            errors.error(
                ErrorAt::Offset(offset - content.len() - if crlf { 2 } else { 1 }),
                "BAD_INDENT",
                format!("Block scalar lines must not be less indented than their {src}"),
            );
            indent = &[];
        }
        if !header.folded {
            value.extend_from_slice(&sep);
            value.extend(slice_from(indent, trim_indent));
            value.extend_from_slice(content);
            sep = vec![u('\n')];
        } else if indent.len() > trim_indent || content.first() == Some(&u('\t')) {
            // More-indented content within a folded block.
            if sep == [u(' ')] {
                sep = vec![u('\n')];
            } else if !prev_more_indented && sep == [u('\n')] {
                sep = vec![u('\n'), u('\n')];
            }
            value.extend_from_slice(&sep);
            value.extend(slice_from(indent, trim_indent));
            value.extend_from_slice(content);
            sep = vec![u('\n')];
            prev_more_indented = true;
        } else if content.is_empty() {
            // An empty line.
            if sep == [u('\n')] {
                value.push(u('\n'));
            } else {
                sep = vec![u('\n')];
            }
        } else {
            value.extend_from_slice(&sep);
            value.extend_from_slice(content);
            sep = vec![u(' ')];
            prev_more_indented = false;
        }
    }
    if header.chomp == u('-') {
    } else if header.chomp == u('+') {
        for line in lines.iter().skip(chomp_start) {
            value.push(u('\n'));
            value.extend(slice_from(line.0, trim_indent));
        }
        if value.last() != Some(&u('\n')) {
            value.push(u('\n'));
        }
    } else {
        value.push(u('\n'));
    }
    let end = start + header.length + source.len();
    Some(BlockScalarValue { value, folded: header.folded, range: [start, end, end] })
}

fn parse_block_scalar_header(
    units: Units<'_>,
    arena: &[Token],
    offset: usize,
    props: &[crate::yaml_cst::BlockScalarProp],
    strict: bool,
    errors: &mut Errors<'_>,
) -> Option<BlockHeader> {
    use crate::yaml_cst::BlockScalarProp;
    let header = match props.first() {
        Some(BlockScalarProp::Source(token)) if token.ty == TokenType::BlockScalarHeader => *token,
        other => {
            let at = match other {
                Some(BlockScalarProp::Source(token)) => token_at(token),
                Some(BlockScalarProp::Token(id)) => cst_at(&arena[*id]),
                None => ErrorAt::Offset(offset),
            };
            errors.error(at, "IMPOSSIBLE", "Block scalar header not found");
            return None;
        }
    };
    let source = units.of(header.source);
    let folded = source.first() == Some(&u('>'));
    let mut indent = 0;
    let mut chomp: u16 = 0;
    let mut error: Option<usize> = None;
    for (i, ch) in source.iter().enumerate().skip(1) {
        if chomp == 0 && (*ch == u('-') || *ch == u('+')) {
            chomp = *ch;
        } else {
            let n = if (u('0')..=u('9')).contains(ch) { usize::from(*ch - u('0')) } else { 0 };
            if indent == 0 && n != 0 {
                indent = n;
            } else if error.is_none() {
                error = Some(offset + i);
            }
        }
    }
    if let Some(error) = error {
        errors.error(
            ErrorAt::Offset(error),
            "UNEXPECTED_TOKEN",
            format!("Block scalar header includes extra characters: {}", String::from_utf16_lossy(source)),
        );
    }
    let mut has_space = false;
    let mut length = source.len();
    for prop in props.iter().skip(1) {
        match prop {
            BlockScalarProp::Source(token) => match token.ty {
                TokenType::Space => {
                    has_space = true;
                    length += token.source.len();
                }
                TokenType::Newline => length += token.source.len(),
                TokenType::Comment => {
                    if strict && !has_space {
                        errors.error(
                            token_at(token),
                            "MISSING_CHAR",
                            "Comments must be separated from other tokens by white space characters",
                        );
                    }
                    length += token.source.len();
                }
                ty => {
                    errors.error(
                        token_at(token),
                        "UNEXPECTED_TOKEN",
                        format!("Unexpected token in block scalar header: {}", ty.name()),
                    );
                    length += token.source.len();
                }
            },
            BlockScalarProp::Token(id) => {
                let token = &arena[*id];
                match token {
                    Token::Error { message, source, .. } => {
                        errors.error(cst_at(token), "UNEXPECTED_TOKEN", message.clone());
                        length += source.len();
                    }
                    other => {
                        errors.error(
                            cst_at(other),
                            "UNEXPECTED_TOKEN",
                            format!("Unexpected token in block scalar header: {}", other.kind().name()),
                        );
                        if let Some(source) = other.source() {
                            length += source.len();
                        }
                    }
                }
            }
        }
    }
    Some(BlockHeader { folded, indent, chomp, length })
}

/// `splitLines`: `[indent, content]` per line.
fn split_lines(source: &[u16]) -> Vec<(&[u16], &[u16])> {
    let mut lines = Vec::new();
    for segment in source.split(|c| *c == u('\n')) {
        let spaces = segment.iter().take_while(|c| **c == u(' ')).count();
        lines.push((&segment[..spaces], &segment[spaces..]));
    }
    lines
}

/// Tag handles in force for a document (`Directives.tags`).
pub type TagHandles = HashMap<String, String>;

/// `Directives.tagName`: the resolved tag, or `None` when it cannot be; every complaint on
/// the way is reported.
pub fn tag_name(source: &str, handles: &TagHandles, on_error: &mut dyn FnMut(String)) -> Option<String> {
    if source == "!" {
        return Some("!".to_string());
    }
    if !source.starts_with('!') {
        on_error(format!("Not a valid tag: {source}"));
        return None;
    }
    if source[1..].starts_with('<') {
        let inner_end = if source.len() >= 3 { source.len() - 1 } else { 2 };
        let verbatim = source.get(2..inner_end.max(2)).unwrap_or("");
        if verbatim == "!" || verbatim == "!!" {
            on_error(format!("Verbatim tags aren't resolved, so {source} is invalid."));
            return None;
        }
        if !source.ends_with('>') {
            on_error("Verbatim tags must end with a >".to_string());
        }
        return Some(verbatim.to_string());
    }
    let split = source.rfind('!').expect("starts with !") + 1;
    let (handle, suffix) = source.split_at(split);
    if suffix.is_empty() {
        on_error(format!("The {source} tag has no suffix"));
    }
    if let Some(prefix) = handles.get(handle).filter(|prefix| !prefix.is_empty()) {
        return match decode_uri_component(suffix) {
            Some(decoded) => Some(format!("{prefix}{decoded}")),
            None => {
                on_error("URIError: URI malformed".to_string());
                None
            }
        };
    }
    if handle == "!" {
        return Some(source.to_string());
    }
    on_error(format!("Could not resolve tag: {source}"));
    None
}

/// ECMAScript's `decodeURIComponent`, `None` where it throws.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
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

/// The scalar tags a document resolves with: the core schema's, the engines', and the
/// `yaml-1.1` ones the core schema knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScalarTag {
    Str,
    Null,
    Bool,
    Int,
    Float,
    /// A registered engine's tag.
    Engine,
    Binary,
    Merge,
    Timestamp,
}

/// `findScalarTagByName`: `Ok` with the tag, or `Err(warning?)` for an unresolved one, which
/// reads as a string.
pub fn scalar_tag_by_name(value: &str, tag_name: &str, is_engine: impl Fn(&str) -> bool) -> Result<ScalarTag, bool> {
    const CORE: &str = "tag:yaml.org,2002:";
    if tag_name == "!" {
        return Ok(ScalarTag::Str);
    }
    if let Some(name) = tag_name.strip_prefix('!') {
        if is_engine(name) {
            return Ok(ScalarTag::Engine);
        }
    }
    if let Some(name) = tag_name.strip_prefix(CORE) {
        let tested = match name {
            "str" => return Ok(ScalarTag::Str),
            "null" => null_test(value).then_some(ScalarTag::Null),
            "bool" => bool_test(value).then_some(ScalarTag::Bool),
            "int" => int_test(value).then_some(ScalarTag::Int),
            "float" => float_test(value).then_some(ScalarTag::Float),
            "binary" => return Ok(ScalarTag::Binary),
            "merge" => return Ok(ScalarTag::Merge),
            "timestamp" => return Ok(ScalarTag::Timestamp),
            _ => None,
        };
        if let Some(tag) = tested {
            return Ok(tag);
        }
    }
    Err(tag_name != "tag:yaml.org,2002:str")
}

/// `findScalarTagByTest` over the core schema's default tags, in their order.
pub fn scalar_tag_by_test(value: &str) -> ScalarTag {
    if null_test(value) {
        ScalarTag::Null
    } else if bool_test(value) {
        ScalarTag::Bool
    } else if int_test(value) {
        ScalarTag::Int
    } else if float_test(value) {
        ScalarTag::Float
    } else {
        ScalarTag::Str
    }
}

fn digits(text: &str, digit: impl Fn(char) -> bool) -> bool {
    !text.is_empty() && text.chars().all(digit)
}

fn null_test(text: &str) -> bool {
    matches!(text, "" | "~" | "null" | "Null" | "NULL")
}

fn bool_test(text: &str) -> bool {
    matches!(text, "true" | "True" | "TRUE" | "false" | "False" | "FALSE")
}

/// `intOct`, `int` and `intHex`'s tests.
fn int_test(text: &str) -> bool {
    if let Some(octal) = text.strip_prefix("0o") {
        if digits(octal, |c| ('0'..='7').contains(&c)) {
            return true;
        }
    }
    if let Some(hex) = text.strip_prefix("0x") {
        if digits(hex, |c| c.is_ascii_hexdigit()) {
            return true;
        }
    }
    digits(text.strip_prefix(['-', '+']).unwrap_or(text), |c| c.is_ascii_digit())
}

/// `floatNaN`, `floatExp` and `float`'s tests.
fn float_test(text: &str) -> bool {
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") || matches!(text, ".nan" | ".NaN" | ".NAN") {
        return true;
    }
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some(("", fraction)) => digits(fraction, |c| c.is_ascii_digit()),
        Some((whole, fraction)) => digits(whole, |c| c.is_ascii_digit()) && fraction.chars().all(|c| c.is_ascii_digit()),
        None => exponent.is_some() && digits(mantissa, |c| c.is_ascii_digit()),
    };
    let exponent_ok = exponent.is_none_or(|exponent| digits(exponent.strip_prefix(['-', '+']).unwrap_or(exponent), |c| c.is_ascii_digit()));
    mantissa_ok && exponent_ok
}

/// The number an `int` or `float` tag resolves `text` to — `parseInt` after the radix
/// prefix, `parseFloat`, or the non-finite constants.
pub fn number_of(tag: &ScalarTag, text: &str) -> f64 {
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    let negative = text.starts_with('-');
    if *tag == ScalarTag::Float {
        if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
            return if negative { f64::NEG_INFINITY } else { f64::INFINITY };
        }
        if matches!(text, ".nan" | ".NaN" | ".NAN") {
            return f64::NAN;
        }
        let value = es_string_to_number(unsigned);
        return if negative { -value } else { value };
    }
    if text.starts_with("0o") || text.starts_with("0x") {
        return es_string_to_number(text);
    }
    let magnitude: f64 = unsigned.parse().unwrap_or(f64::NAN);
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

/// `timestamp.test`: `yyyy-mm-dd`, optionally a time and a zone.
pub fn timestamp_test(text: &str) -> bool {
    let b = text.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize, min: usize, max: usize| -> bool {
        let start = *i;
        while *i < b.len() && *i - start < max && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start >= min
    };
    let lit = |i: &mut usize, c: u8| -> bool {
        if *i < b.len() && b[*i] == c {
            *i += 1;
            true
        } else {
            false
        }
    };
    if !(digits(&mut i, 4, 4) && lit(&mut i, b'-') && digits(&mut i, 1, 2) && lit(&mut i, b'-') && digits(&mut i, 1, 2)) {
        return false;
    }
    if i == b.len() {
        return true;
    }
    // The time: `t`, `T` or white space, then `h:m:s(.f)?`, then an optional zone.
    if b[i] == b't' || b[i] == b'T' {
        i += 1;
    } else if b[i] == b' ' || b[i] == b'\t' {
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
    } else {
        return false;
    }
    if !(digits(&mut i, 1, 2) && lit(&mut i, b':') && digits(&mut i, 1, 2) && lit(&mut i, b':') && digits(&mut i, 1, 2)) {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if !digits(&mut i, 1, usize::MAX) {
            return false;
        }
    }
    if i == b.len() {
        return true;
    }
    let zone_start = i;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    if i == b.len() {
        // White space alone is no zone, and nothing may follow the time.
        return zone_start == b.len();
    }
    if b[i] == b'Z' {
        return i + 1 == b.len();
    }
    if b[i] != b'-' && b[i] != b'+' {
        return false;
    }
    i += 1;
    // `[012]?[0-9]`: one or two digits, the first of two at most 2.
    let hour_start = i;
    while i < b.len() && i - hour_start < 2 && b[i].is_ascii_digit() {
        i += 1;
    }
    match i - hour_start {
        0 => return false,
        2 if b[hour_start] > b'2' => return false,
        _ => {}
    }
    if i < b.len() && b[i] == b':' {
        i += 1;
        if !digits(&mut i, 2, 2) {
            return false;
        }
    }
    i == b.len()
}
