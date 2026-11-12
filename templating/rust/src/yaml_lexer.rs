//! Splits a YAML text into lexical tokens — a twin of `yaml@2.8.3`'s `dist/parse/lexer.js`.
//!
//! No Telo twin (see `yaml_cst.rs`). The whole text is in hand, so the lexer runs as the
//! `yaml` one does with `incomplete = false`: no state waits for more input. Each `parse_*`
//! function is the method of the same name, returning the next state where the original
//! returns one and calling on where it tail-calls; the two methods that call themselves per
//! indicator on a line (`parseBlockStart`, `pushIndicators`) are loops, so no call nests on
//! the input.

use crate::yaml_cst::{Src, BOM, DOCUMENT, FLOW_END, SCALAR};

/// The lexer's states (`lexer.next`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Stream,
    LineStart,
    BlockStart,
    Doc,
    Flow,
    QuotedScalar,
    BlockScalar,
    PlainScalar,
}

const SP: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const LF: u16 = b'\n' as u16;
const CR: u16 = b'\r' as u16;

fn is(ch: Option<u16>, c: char) -> bool {
    ch == Some(c as u16)
}

/// A code unit as a character to match on; a surrogate half is none of the characters the
/// lexer looks for.
fn unit_char(unit: u16) -> char {
    char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}')
}

/// `isEmpty`: the end of the text, or a space, tab or line break.
pub fn is_empty(ch: Option<u16>) -> bool {
    matches!(ch, None | Some(SP | LF | CR | TAB))
}

fn is_hex(ch: Option<u16>) -> bool {
    matches!(ch, Some(c) if (c as u8 as u16 == c) && (c as u8).is_ascii_hexdigit())
}

fn is_tag_char(ch: u16) -> bool {
    ch < 0x80
        && (ch as u8).is_ascii_alphanumeric()
        || matches!(char::from_u32(u32::from(ch)), Some('-' | '#' | ';' | '/' | '?' | ':' | '@' | '&' | '=' | '+' | '$' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')'))
}

fn is_flow_indicator(ch: Option<u16>) -> bool {
    matches!(ch.and_then(|c| char::from_u32(u32::from(c))), Some(',' | '[' | ']' | '{' | '}'))
}

/// `isNotAnchorChar`.
fn is_not_anchor_char(ch: Option<u16>) -> bool {
    match ch {
        None => true,
        Some(c) => matches!(char::from_u32(u32::from(c)), Some(' ' | ',' | '[' | ']' | '{' | '}' | '\n' | '\r' | '\t')),
    }
}

/// A line as `getLine` returns it: the units from where it was read to its end, its line
/// break left out.
#[derive(Clone, Copy)]
struct Line {
    start: usize,
    end: usize,
}

impl Line {
    fn len(self) -> usize {
        self.end - self.start
    }
}

pub struct Lexer<'s> {
    buf: &'s [u16],
    /// The explicit indent of a block scalar header, less one; -1 when not set.
    block_scalar_indent: i64,
    block_scalar_keep: bool,
    flow_key: bool,
    flow_level: i64,
    indent_next: i64,
    indent_value: i64,
    line_end_pos: Option<i64>,
    pos: usize,
}

impl<'s> Lexer<'s> {
    pub fn new(buf: &'s [u16]) -> Self {
        Self {
            buf,
            block_scalar_indent: -1,
            block_scalar_keep: false,
            flow_key: false,
            flow_level: 0,
            indent_next: 0,
            indent_value: 0,
            line_end_pos: None,
            pos: 0,
        }
    }

    /// Whether `lex`'s loop goes on: a state remains and the text has a unit left.
    pub fn has_more(&self) -> bool {
        self.has_chars(1)
    }

    /// One turn of `lex`'s loop: run `state`, pushing the tokens it emits, and give the next.
    pub fn step(&mut self, state: State, out: &mut Vec<Src>) -> State {
        match state {
            State::Stream => self.parse_stream(out),
            State::LineStart => self.parse_line_start(out),
            State::BlockStart => self.parse_block_start(out),
            State::Doc => self.parse_document(out),
            State::Flow => self.parse_flow_collection(out),
            State::QuotedScalar => self.parse_quoted_scalar(out),
            State::BlockScalar => self.parse_block_scalar(out),
            State::PlainScalar => self.parse_plain_scalar(out),
        }
    }

    fn at(&self, i: i64) -> Option<u16> {
        if i < 0 {
            return None;
        }
        self.buf.get(i as usize).copied()
    }

    fn char_at(&self, n: usize) -> Option<u16> {
        self.buf.get(self.pos + n).copied()
    }

    fn line_at(&self, line: Line, n: usize) -> Option<u16> {
        let i = line.start + n;
        if i < line.end {
            Some(self.buf[i])
        } else {
            None
        }
    }

    fn has_chars(&self, n: usize) -> bool {
        self.pos + n <= self.buf.len()
    }

    fn index_of(&self, unit: u16, from: usize) -> i64 {
        if from >= self.buf.len() {
            return -1;
        }
        match self.buf[from..].iter().position(|c| *c == unit) {
            Some(i) => (from + i) as i64,
            None => -1,
        }
    }

    fn starts_with_at(&self, at: usize, text: &str) -> bool {
        text.encode_utf16().enumerate().all(|(i, unit)| self.buf.get(at + i) == Some(&unit))
    }

    fn at_line_end(&self) -> bool {
        let mut i = self.pos;
        let mut ch = self.buf.get(i).copied();
        while matches!(ch, Some(SP | TAB)) {
            i += 1;
            ch = self.buf.get(i).copied();
        }
        match ch {
            None => true,
            Some(c) if c == b'#' as u16 || c == LF => true,
            Some(CR) => self.buf.get(i + 1) == Some(&LF),
            _ => false,
        }
    }

    fn continue_scalar(&self, offset: i64) -> i64 {
        let mut ch = self.at(offset);
        if self.indent_next > 0 {
            let mut indent: i64 = 0;
            while ch == Some(SP) {
                indent += 1;
                ch = self.at(indent + offset);
            }
            if ch == Some(CR) {
                let next = self.at(indent + offset + 1);
                if next == Some(LF) {
                    return offset + indent + 1;
                }
            }
            return if ch == Some(LF) || indent >= self.indent_next { offset + indent } else { -1 };
        }
        if is(ch, '-') || is(ch, '.') {
            let at = offset as usize;
            if (self.starts_with_at(at, "---") || self.starts_with_at(at, "...")) && is_empty(self.at(offset + 3)) {
                return -1;
            }
        }
        offset
    }

    fn get_line(&mut self) -> Line {
        let mut end = match self.line_end_pos {
            Some(end) if end == -1 || end >= self.pos as i64 => end,
            _ => {
                let end = self.index_of(LF, self.pos);
                self.line_end_pos = Some(end);
                end
            }
        };
        if end == -1 {
            return Line { start: self.pos, end: self.buf.len() };
        }
        if self.at(end - 1) == Some(CR) {
            end -= 1;
        }
        // `substring` swaps reversed bounds.
        let (a, b) = (self.pos as i64, end);
        let (a, b) = if b < a { (b, a) } else { (a, b) };
        Line { start: a as usize, end: b as usize }
    }

    fn parse_stream(&mut self, out: &mut Vec<Src>) -> State {
        let mut line = self.get_line();
        if self.line_at(line, 0) == Some(BOM) {
            self.push_count(1, out);
            line.start += 1;
        }
        if is(self.line_at(line, 0), '%') {
            let mut dir_end = line.len() as i64;
            let mut cs = self.line_index_of(line, b'#' as u16, 0);
            while cs != -1 {
                let ch = if cs >= 1 { self.line_at(line, (cs - 1) as usize) } else { None };
                if ch == Some(SP) || ch == Some(TAB) {
                    dir_end = cs - 1;
                    break;
                }
                cs = self.line_index_of(line, b'#' as u16, (cs + 1) as usize);
            }
            loop {
                let ch = if dir_end >= 1 { self.line_at(line, (dir_end - 1) as usize) } else { None };
                if ch == Some(SP) || ch == Some(TAB) {
                    dir_end -= 1;
                } else {
                    break;
                }
            }
            let n = self.push_count(dir_end.max(0) as usize, out) + self.push_spaces(true, out);
            self.push_count(line.len().saturating_sub(n), out);
            // The original calls `pushNewline()` here without delegating to it, which pushes
            // nothing: the line break is read by the next turn.
            return State::Stream;
        }
        if self.at_line_end() {
            let sp = self.push_spaces(true, out);
            self.push_count(line.len().saturating_sub(sp), out);
            self.push_newline(out);
            return State::Stream;
        }
        out.push(Src::Control(DOCUMENT));
        self.parse_line_start(out)
    }

    fn line_index_of(&self, line: Line, unit: u16, from: usize) -> i64 {
        let from = line.start + from;
        if from >= line.end {
            return -1;
        }
        match self.buf[from..line.end].iter().position(|c| *c == unit) {
            Some(i) => (from + i - line.start) as i64,
            None => -1,
        }
    }

    fn parse_line_start(&mut self, out: &mut Vec<Src>) -> State {
        let ch = self.char_at(0);
        if is(ch, '-') || is(ch, '.') {
            let dashes = self.starts_with_at(self.pos, "---");
            if (dashes || self.starts_with_at(self.pos, "...")) && is_empty(self.char_at(3)) {
                self.push_count(3, out);
                self.indent_value = 0;
                self.indent_next = 0;
                return if dashes { State::Doc } else { State::Stream };
            }
        }
        self.indent_value = self.push_spaces(false, out) as i64;
        if self.indent_next > self.indent_value && !is_empty(self.char_at(1)) {
            self.indent_next = self.indent_value;
        }
        self.parse_block_start(out)
    }

    fn parse_block_start(&mut self, out: &mut Vec<Src>) -> State {
        loop {
            let ch0 = self.char_at(0);
            let ch1 = self.char_at(1);
            if (is(ch0, '-') || is(ch0, '?') || is(ch0, ':')) && is_empty(ch1) {
                let n = self.push_count(1, out) + self.push_spaces(true, out);
                self.indent_next = self.indent_value + 1;
                self.indent_value += n as i64;
                continue;
            }
            return State::Doc;
        }
    }

    fn parse_document(&mut self, out: &mut Vec<Src>) -> State {
        self.push_spaces(true, out);
        let line = self.get_line();
        let mut n = self.push_indicators(out);
        match self.line_at(line, n).map(unit_char) {
            Some('#') => {
                self.push_count(line.len().saturating_sub(n), out);
                self.push_newline(out);
                self.parse_line_start(out)
            }
            None => {
                self.push_newline(out);
                self.parse_line_start(out)
            }
            Some('{' | '[') => {
                self.push_count(1, out);
                self.flow_key = false;
                self.flow_level = 1;
                State::Flow
            }
            Some('}' | ']') => {
                // An error.
                self.push_count(1, out);
                State::Doc
            }
            Some('*') => {
                self.push_until(is_not_anchor_char, out);
                State::Doc
            }
            Some('"' | '\'') => self.parse_quoted_scalar(out),
            Some('|' | '>') => {
                n += self.parse_block_scalar_header(out);
                n += self.push_spaces(true, out);
                self.push_count(line.len().saturating_sub(n), out);
                self.push_newline(out);
                self.parse_block_scalar(out)
            }
            _ => self.parse_plain_scalar(out),
        }
    }

    fn parse_flow_collection(&mut self, out: &mut Vec<Src>) -> State {
        let mut indent: i64 = -1;
        loop {
            let nl = self.push_newline(out);
            let mut sp;
            if nl > 0 {
                sp = self.push_spaces(false, out);
                indent = sp as i64;
                self.indent_value = indent;
            } else {
                sp = 0;
            }
            sp += self.push_spaces(true, out);
            if nl + sp == 0 {
                break;
            }
        }
        let line = self.get_line();
        let first = self.line_at(line, 0);
        let marker = (self.starts_with_at(line.start, "---") || self.starts_with_at(line.start, "..."))
            && line.len() >= 3
            && is_empty(self.line_at(line, 3));
        if (indent != -1 && indent < self.indent_next && !is(first, '#')) || (indent == 0 && marker) {
            // A terminal `]` or `}` at the indent of the opening one is technically invalid, but
            // accepted.
            let at_flow_end_marker =
                indent == self.indent_next - 1 && self.flow_level == 1 && (is(first, ']') || is(first, '}'));
            if !at_flow_end_marker {
                // An error.
                self.flow_level = 0;
                out.push(Src::Control(FLOW_END));
                return self.parse_line_start(out);
            }
        }
        let mut n = 0;
        while is(self.line_at(line, n), ',') {
            n += self.push_count(1, out);
            n += self.push_spaces(true, out);
            self.flow_key = false;
        }
        n += self.push_indicators(out);
        match self.line_at(line, n).map(unit_char) {
            None => State::Flow,
            Some('#') => {
                self.push_count(line.len().saturating_sub(n), out);
                State::Flow
            }
            Some('{' | '[') => {
                self.push_count(1, out);
                self.flow_key = false;
                self.flow_level += 1;
                State::Flow
            }
            Some('}' | ']') => {
                self.push_count(1, out);
                self.flow_key = true;
                self.flow_level -= 1;
                if self.flow_level != 0 {
                    State::Flow
                } else {
                    State::Doc
                }
            }
            Some('*') => {
                self.push_until(is_not_anchor_char, out);
                State::Flow
            }
            Some('"' | '\'') => {
                self.flow_key = true;
                self.parse_quoted_scalar(out)
            }
            Some(':') => {
                let next = self.char_at(1);
                if self.flow_key || is_empty(next) || is(next, ',') {
                    self.flow_key = false;
                    self.push_count(1, out);
                    self.push_spaces(true, out);
                    return State::Flow;
                }
                self.flow_key = false;
                self.parse_plain_scalar(out)
            }
            _ => {
                self.flow_key = false;
                self.parse_plain_scalar(out)
            }
        }
    }

    fn parse_quoted_scalar(&mut self, out: &mut Vec<Src>) -> State {
        let quote = self.char_at(0).expect("a quote");
        let mut end = self.index_of(quote, self.pos + 1);
        if quote == b'\'' as u16 {
            while end != -1 && self.at(end + 1) == Some(quote) {
                end = self.index_of(quote, (end + 2) as usize);
            }
        } else {
            while end != -1 {
                let mut n = 0;
                while self.at(end - 1 - n) == Some(b'\\' as u16) {
                    n += 1;
                }
                if n % 2 == 0 {
                    break;
                }
                end = self.index_of(quote, (end + 1) as usize);
            }
        }
        // Only newlines within the quotes are looked for: `qb` is the text before `end`.
        let qb_len = if end < 0 { 0 } else { end as usize };
        let qb_index = |from: usize| -> i64 {
            if from >= qb_len {
                return -1;
            }
            match self.buf[from..qb_len].iter().position(|c| *c == LF) {
                Some(i) => (from + i) as i64,
                None => -1,
            }
        };
        let mut nl = qb_index(self.pos);
        if nl != -1 {
            while nl != -1 {
                let cs = self.continue_scalar(nl + 1);
                if cs == -1 {
                    break;
                }
                nl = qb_index(cs as usize);
            }
            if nl != -1 {
                // An error caused by an unexpected unindent.
                end = nl - if self.at(nl - 1) == Some(CR) { 2 } else { 1 };
            }
        }
        if end == -1 {
            end = self.buf.len() as i64;
        }
        self.push_to_index((end + 1) as usize, false, out);
        if self.flow_level != 0 {
            State::Flow
        } else {
            State::Doc
        }
    }

    fn parse_block_scalar_header(&mut self, out: &mut Vec<Src>) -> usize {
        self.block_scalar_indent = -1;
        self.block_scalar_keep = false;
        let mut i = self.pos;
        loop {
            i += 1;
            let ch = self.buf.get(i).copied();
            if is(ch, '+') {
                self.block_scalar_keep = true;
            } else if let Some(c) = ch.filter(|c| *c > b'0' as u16 && *c <= b'9' as u16) {
                self.block_scalar_indent = i64::from(c - b'0' as u16) - 1;
            } else if !is(ch, '-') {
                break;
            }
        }
        self.push_until(|ch| is_empty(ch) || is(ch, '#'), out)
    }

    fn parse_block_scalar(&mut self, out: &mut Vec<Src>) -> State {
        let mut nl: i64 = self.pos as i64 - 1;
        let mut indent: i64 = 0;
        let mut i = self.pos;
        loop {
            let Some(ch) = self.buf.get(i).copied() else { break };
            match ch {
                SP => indent += 1,
                LF => {
                    nl = i as i64;
                    indent = 0;
                }
                CR if self.buf.get(i + 1) == Some(&LF) => {}
                _ => break,
            }
            i += 1;
        }
        if indent >= self.indent_next {
            if self.block_scalar_indent == -1 {
                self.indent_next = indent;
            } else {
                self.indent_next =
                    self.block_scalar_indent + if self.indent_next == 0 { 1 } else { self.indent_next };
            }
            loop {
                let cs = self.continue_scalar(nl + 1);
                if cs == -1 {
                    break;
                }
                nl = self.index_of(LF, cs as usize);
                if nl == -1 {
                    break;
                }
            }
            if nl == -1 {
                nl = self.buf.len() as i64;
            }
        }
        // Trailing insufficiently indented tabs are invalid; to catch that, they are kept in
        // the block scalar's value.
        let mut i = nl + 1;
        let mut ch = self.at(i);
        while ch == Some(SP) {
            i += 1;
            ch = self.at(i);
        }
        if ch == Some(TAB) {
            while matches!(ch, Some(TAB | SP | CR | LF)) {
                i += 1;
                ch = self.at(i);
            }
            nl = i - 1;
        } else if !self.block_scalar_keep {
            loop {
                let mut i = nl - 1;
                let mut ch = self.at(i);
                if ch == Some(CR) {
                    i -= 1;
                    ch = self.at(i);
                }
                let last_char = i;
                while ch == Some(SP) {
                    i -= 1;
                    ch = self.at(i);
                }
                if ch == Some(LF) && i >= self.pos as i64 && i + 1 + indent > last_char {
                    nl = i;
                } else {
                    break;
                }
            }
        }
        out.push(Src::Control(SCALAR));
        self.push_to_index((nl + 1).max(0) as usize, true, out);
        self.parse_line_start(out)
    }

    fn parse_plain_scalar(&mut self, out: &mut Vec<Src>) -> State {
        let in_flow = self.flow_level > 0;
        let mut end: i64 = self.pos as i64 - 1;
        let mut i: i64 = self.pos as i64 - 1;
        loop {
            i += 1;
            let Some(mut ch) = self.at(i) else { break };
            if ch == b':' as u16 {
                let next = self.at(i + 1);
                if is_empty(next) || (in_flow && is_flow_indicator(next)) {
                    break;
                }
                end = i;
            } else if is_empty(Some(ch)) {
                let mut next = self.at(i + 1);
                if ch == CR {
                    if next == Some(LF) {
                        i += 1;
                        ch = LF;
                        next = self.at(i + 1);
                    } else {
                        end = i;
                    }
                }
                if is(next, '#') || (in_flow && is_flow_indicator(next)) {
                    break;
                }
                if ch == LF {
                    let cs = self.continue_scalar(i + 1);
                    if cs == -1 {
                        break;
                    }
                    // To advance, but still account for ` #`.
                    i = i.max(cs - 2);
                }
            } else {
                if in_flow && is_flow_indicator(Some(ch)) {
                    break;
                }
                end = i;
            }
        }
        out.push(Src::Control(SCALAR));
        self.push_to_index((end + 1).max(0) as usize, true, out);
        if in_flow {
            State::Flow
        } else {
            State::Doc
        }
    }

    fn push_count(&mut self, n: usize, out: &mut Vec<Src>) -> usize {
        if n > 0 {
            let start = self.pos.min(self.buf.len());
            let end = (self.pos + n).min(self.buf.len());
            out.push(Src::Text { start, end });
            self.pos += n;
            return n;
        }
        0
    }

    fn push_to_index(&mut self, i: usize, allow_empty: bool, out: &mut Vec<Src>) -> usize {
        let end = i.min(self.buf.len());
        if end > self.pos {
            out.push(Src::Text { start: self.pos, end });
            let n = end - self.pos;
            self.pos = end;
            return n;
        }
        if allow_empty {
            out.push(Src::Text { start: self.pos, end: self.pos });
        }
        0
    }

    fn push_indicators(&mut self, out: &mut Vec<Src>) -> usize {
        let mut total = 0;
        loop {
            match self.char_at(0).map(unit_char) {
                Some('!') => {
                    total += self.push_tag(out);
                    total += self.push_spaces(true, out);
                }
                Some('&') => {
                    total += self.push_until(is_not_anchor_char, out);
                    total += self.push_spaces(true, out);
                }
                // `-` is an error here, and `?` outside flow collections.
                Some('-' | '?' | ':') => {
                    let in_flow = self.flow_level > 0;
                    let ch1 = self.char_at(1);
                    if is_empty(ch1) || (in_flow && is_flow_indicator(ch1)) {
                        if !in_flow {
                            self.indent_next = self.indent_value + 1;
                        } else if self.flow_key {
                            self.flow_key = false;
                        }
                        total += self.push_count(1, out);
                        total += self.push_spaces(true, out);
                    } else {
                        return total;
                    }
                }
                _ => return total,
            }
        }
    }

    fn push_tag(&mut self, out: &mut Vec<Src>) -> usize {
        if is(self.char_at(1), '<') {
            let mut i = self.pos + 2;
            let mut ch = self.buf.get(i).copied();
            while !is_empty(ch) && !is(ch, '>') {
                i += 1;
                ch = self.buf.get(i).copied();
            }
            let to = if is(ch, '>') { i + 1 } else { i };
            self.push_to_index(to, false, out)
        } else {
            let mut i = self.pos + 1;
            let mut ch = self.buf.get(i).copied();
            while let Some(c) = ch {
                if is_tag_char(c) {
                    i += 1;
                    ch = self.buf.get(i).copied();
                } else if c == b'%' as u16 && is_hex(self.buf.get(i + 1).copied()) && is_hex(self.buf.get(i + 2).copied()) {
                    i += 3;
                    ch = self.buf.get(i).copied();
                } else {
                    break;
                }
            }
            self.push_to_index(i, false, out)
        }
    }

    fn push_newline(&mut self, out: &mut Vec<Src>) -> usize {
        match self.char_at(0) {
            Some(LF) => self.push_count(1, out),
            Some(CR) if self.char_at(1) == Some(LF) => self.push_count(2, out),
            _ => 0,
        }
    }

    fn push_spaces(&mut self, allow_tabs: bool, out: &mut Vec<Src>) -> usize {
        let mut i = self.pos;
        while let Some(ch) = self.buf.get(i).copied() {
            if ch == SP || (allow_tabs && ch == TAB) {
                i += 1;
            } else {
                break;
            }
        }
        let n = i - self.pos;
        if n > 0 {
            out.push(Src::Text { start: self.pos, end: i });
            self.pos = i;
        }
        n
    }

    fn push_until(&mut self, test: impl Fn(Option<u16>) -> bool, out: &mut Vec<Src>) -> usize {
        let mut i = self.pos;
        let mut ch = self.buf.get(i).copied();
        while !test(ch) {
            i += 1;
            ch = self.buf.get(i).copied();
        }
        self.push_to_index(i, false, out)
    }
}
