//! RE2's pattern language, read into RE2's syntax tree. No Node twin: Node reads a
//! pattern with re2js 2.8.3's `Parser`, a file of a dependency.
//!
//! This is that parser, twinned step for step, because what it accepts, the kind it
//! refuses with and the fragment it quotes are the answer `matches` gives. Every syntax
//! re2js reads in its Perl mode is read here: inline flags `i`, `m`, `s` and `U` with `-`,
//! `(?:…)`, `(?P<name>…)` and `(?<name>…)`, `\Q…\E`, `\A` `\z` `\b` `\B`, octal and `\x`
//! escapes, the ASCII Perl classes, the POSIX classes, `\p` / `\P` over the engine's
//! Unicode 17.0 tables, and case folding over its fold orbit with the single-code-point
//! casing fallback re2js takes from the host — here from the same tables.
//!
//! What it reproduces exactly, because a limit is decided by it:
//! - the node arena, its free list, and the count of nodes allocated fresh, which decides
//!   when the size and height checks start;
//! - the size and height memos, keyed by node and stale where re2js's are;
//! - the alternation factoring, whose rounds decide the tree a limit is measured on.
//!
//! re2js's recursive walks — the size, the height, the repeat product, structural
//! equality, the factoring that collapses its own suffixes, the leading-string removal —
//! each run on a heap work list here: nothing recurses with a pattern's height.
//!
//! Not twinned, because the engine never asks for it: the POSIX (non-Perl) mode, the
//! literal mode, turning off Unicode groups, lookbehind (`(?<=` and `(?<!` are named
//! captures with invalid names here, exactly as re2js reads them without its
//! `LOOKBEHINDS` flag), and `Regexp.toString`. re2js's `LazyMap` resolves a `\p` name
//! with JavaScript's `in`, so `\p{constructor}` and the other `Object.prototype` names
//! reach the prototype there; here a name is a table name or it is unknown.

use std::collections::HashMap;

use crate::regular_expression::Re2PatternErrorKind;
use crate::unicode_tables::{
    CASE_ORBIT, CATEGORY_TABLES, FOLD_CATEGORY_TABLES, FOLD_SCRIPT_TABLES, LOWERCASE_MAPPINGS, MAX_FOLD, MIN_FOLD,
    SCRIPT_TABLES, UPPERCASE_MAPPINGS,
};

// ------------------------------------------------------------------- flags

pub(crate) const FOLD_CASE: u32 = 1;
pub(crate) const CLASS_NL: u32 = 4;
pub(crate) const DOT_NL: u32 = 8;
pub(crate) const ONE_LINE: u32 = 16;
pub(crate) const NON_GREEDY: u32 = 32;
pub(crate) const PERL_X: u32 = 64;
pub(crate) const UNICODE_GROUPS: u32 = 128;
pub(crate) const WAS_DOLLAR: u32 = 256;
/// re2js's `RE2Flags.PERL`, the mode every pattern is read in.
pub(crate) const PERL: u32 = CLASS_NL | ONE_LINE | PERL_X | UNICODE_GROUPS;

pub(crate) const MAX_RUNE: u32 = 0x10FFFF;
const MAX_HEIGHT: i64 = 1000;
const MAX_SIZE: i64 = 3_355_443;
const MAX_RUNES: u64 = 33_554_432;

// ------------------------------------------------------------------- Unicode

fn mapping(table: &'static [(u32, &'static [u32])], code: u32) -> Option<&'static [u32]> {
    table.binary_search_by_key(&code, |&(from, _)| from).ok().map(|index| table[index].1)
}

/// re2js's `Codepoint.toLowerCase`: the code point's lowercase when the host's full
/// mapping of it is one code point whose uppercase is the code point again, else the code
/// point itself. The host's full mapping is the engine's table.
pub(crate) fn single_lowercase(code: u32) -> u32 {
    if code < 0x80 {
        return if (0x41..=0x5A).contains(&code) { code + 32 } else { code };
    }
    single_case(code, LOWERCASE_MAPPINGS, UPPERCASE_MAPPINGS)
}

/// re2js's `Codepoint.toUpperCase`, as `single_lowercase` with the two mappings swapped.
pub(crate) fn single_uppercase(code: u32) -> u32 {
    if code < 0x80 {
        return if (0x61..=0x7A).contains(&code) { code - 32 } else { code };
    }
    single_case(code, UPPERCASE_MAPPINGS, LOWERCASE_MAPPINGS)
}

fn single_case(code: u32, there: &'static [(u32, &'static [u32])], back: &'static [(u32, &'static [u32])]) -> u32 {
    let mapped = match mapping(there, code) {
        None => return code,
        Some(mapped) => mapped,
    };
    if mapped.len() != 1 {
        return code;
    }
    let origin = mapping(back, mapped[0]).unwrap_or(std::slice::from_ref(&mapped[0]));
    if origin.len() != 1 || origin[0] != code {
        return code;
    }
    mapped[0]
}

/// re2js's `Unicode.simpleFold`: the next code point of the fold orbit, or the casing
/// fallback for a code point outside it.
pub(crate) fn simple_fold(code: u32) -> u32 {
    if let Ok(index) = CASE_ORBIT.binary_search_by_key(&code, |&(from, _)| from) {
        return CASE_ORBIT[index].1;
    }
    let lower = single_lowercase(code);
    if lower != code {
        return lower;
    }
    single_uppercase(code)
}

/// re2js's `Unicode.equalsIgnoreCase`.
pub(crate) fn equals_ignore_case(a: u32, b: u32) -> bool {
    if a == b {
        return true;
    }
    if a <= 0x7F && b <= 0x7F {
        let fold = |c: u32| if (0x41..=0x5A).contains(&c) { c | 0x20 } else { c };
        return fold(a) == fold(b);
    }
    let mut r = simple_fold(a);
    while r != a {
        if r == b {
            return true;
        }
        r = simple_fold(r);
    }
    false
}

fn min_fold_rune(code: u32) -> u32 {
    if !(MIN_FOLD..=MAX_FOLD).contains(&code) {
        return code;
    }
    let mut min = code;
    let mut r = simple_fold(code);
    while r != code {
        min = min.min(r);
        r = simple_fold(r);
    }
    min
}

type Table = &'static [(u32, u32)];

fn named_table(tables: &'static [(&'static str, Table)], name: &str) -> Option<Table> {
    tables.binary_search_by(|(entry, _)| entry.as_bytes().cmp(name.as_bytes())).ok().map(|index| tables[index].1)
}

static ANY_TABLE: [(u32, u32); 1] = [(0, MAX_RUNE)];
static ASCII_TABLE: [(u32, u32); 1] = [(0, 0x7F)];
static ASCII_FOLD_TABLE: [(u32, u32); 3] = [(0, 0x7F), (0x17F, 0x17F), (0x212A, 0x212A)];

/// re2js's `Parser.unicodeTable`: the table a `\p` name denotes, what folding adds to it,
/// and whether it is denoted negated.
fn unicode_table(name: &str) -> Option<(Table, Option<Table>, i32)> {
    match name {
        "Any" => return Some((&ANY_TABLE, Some(&ANY_TABLE), 1)),
        "Ascii" => return Some((&ASCII_TABLE, Some(&ASCII_FOLD_TABLE), 1)),
        "Assigned" => {
            let unassigned = named_table(CATEGORY_TABLES, "Cn").expect("the category tables hold Cn");
            return Some((unassigned, Some(unassigned), -1));
        }
        "Lc" => {
            let cased = named_table(CATEGORY_TABLES, "LC").expect("the category tables hold LC");
            return Some((cased, named_table(FOLD_CATEGORY_TABLES, "LC"), 1));
        }
        _ => {}
    }
    if let Some(table) = named_table(CATEGORY_TABLES, name) {
        return Some((table, named_table(FOLD_CATEGORY_TABLES, name), 1));
    }
    named_table(SCRIPT_TABLES, name).map(|table| (table, named_table(FOLD_SCRIPT_TABLES, name), 1))
}

// ------------------------------------------------------------------- char classes

/// re2js's `CharClass`: a list of `[lo, hi]` pairs built by appending, merged with the last
/// two pairs as it goes and sorted only when cleaned — so its raw order is re2js's own.
struct CharClass {
    r: Vec<u32>,
}

impl CharClass {
    fn new() -> Self {
        Self { r: Vec::new() }
    }

    fn of(r: Vec<u32>) -> Self {
        Self { r }
    }

    fn clean(&mut self) -> &mut Self {
        if self.r.len() < 4 {
            return self;
        }
        let mut pairs: Vec<(u32, u32)> = self.r.chunks_exact(2).map(|pair| (pair[0], pair[1])).collect();
        pairs.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let mut out: Vec<u32> = Vec::with_capacity(self.r.len());
        out.push(pairs[0].0);
        out.push(pairs[0].1);
        for &(lo, hi) in &pairs[1..] {
            let last = out.len() - 1;
            if lo <= out[last] + 1 {
                if hi > out[last] {
                    out[last] = hi;
                }
                continue;
            }
            out.push(lo);
            out.push(hi);
        }
        self.r = out;
        self
    }

    fn append_literal(&mut self, x: u32, flags: u32) -> &mut Self {
        if flags & FOLD_CASE != 0 {
            self.append_folded_range(x, x)
        } else {
            self.append_range(x, x)
        }
    }

    fn append_range(&mut self, lo: u32, hi: u32) -> &mut Self {
        let len = self.r.len();
        if len > 0 {
            for i in [2usize, 4] {
                if len >= i {
                    let rlo = self.r[len - i];
                    let rhi = self.r[len - i + 1];
                    if lo <= rhi + 1 && rlo <= hi + 1 {
                        if lo < rlo {
                            self.r[len - i] = lo;
                        }
                        if hi > rhi {
                            self.r[len - i + 1] = hi;
                        }
                        return self;
                    }
                }
            }
        }
        self.r.push(lo);
        self.r.push(hi);
        self
    }

    fn append_folded_range(&mut self, mut lo: u32, mut hi: u32) -> &mut Self {
        if lo <= MIN_FOLD && hi >= MAX_FOLD {
            return self.append_range(lo, hi);
        }
        if hi < MIN_FOLD || lo > MAX_FOLD {
            return self.append_range(lo, hi);
        }
        if lo < MIN_FOLD {
            self.append_range(lo, MIN_FOLD - 1);
            lo = MIN_FOLD;
        }
        if hi > MAX_FOLD {
            self.append_range(MAX_FOLD + 1, hi);
            hi = MAX_FOLD;
        }
        for c in lo..=hi {
            self.append_range(c, c);
            let mut f = simple_fold(c);
            while f != c {
                self.append_range(f, f);
                f = simple_fold(f);
            }
        }
        self
    }

    fn append_class(&mut self, x: &[u32]) -> &mut Self {
        for pair in x.chunks_exact(2) {
            self.append_range(pair[0], pair[1]);
        }
        self
    }

    fn append_folded_class(&mut self, x: &[u32]) -> &mut Self {
        for pair in x.chunks_exact(2) {
            self.append_folded_range(pair[0], pair[1]);
        }
        self
    }

    fn append_negated_class(&mut self, x: &[u32]) -> &mut Self {
        let mut next_lo = 0u32;
        for pair in x.chunks_exact(2) {
            if pair[0] > next_lo {
                self.append_range(next_lo, pair[0] - 1);
            }
            next_lo = pair[1] + 1;
        }
        if next_lo <= MAX_RUNE {
            self.append_range(next_lo, MAX_RUNE);
        }
        self
    }

    fn append_table(&mut self, table: Table) -> &mut Self {
        for &(lo, hi) in table {
            self.append_range(lo, hi);
        }
        self
    }

    fn append_negated_table(&mut self, table: Table) -> &mut Self {
        let mut next_lo = 0u32;
        for &(lo, hi) in table {
            if lo > next_lo {
                self.append_range(next_lo, lo - 1);
            }
            next_lo = hi + 1;
        }
        if next_lo <= MAX_RUNE {
            self.append_range(next_lo, MAX_RUNE);
        }
        self
    }

    fn append_table_with_sign(&mut self, table: Table, sign: i32) -> &mut Self {
        if sign < 0 {
            self.append_negated_table(table)
        } else {
            self.append_table(table)
        }
    }

    fn negate(&mut self) -> &mut Self {
        let mut next_lo = 0u32;
        let mut out = Vec::with_capacity(self.r.len() + 2);
        for pair in self.r.chunks_exact(2) {
            if pair[0] > next_lo {
                out.push(next_lo);
                out.push(pair[0] - 1);
            }
            next_lo = pair[1] + 1;
        }
        if next_lo <= MAX_RUNE {
            out.push(next_lo);
            out.push(MAX_RUNE);
        }
        self.r = out;
        self
    }

    fn append_class_with_sign(&mut self, x: &[u32], sign: i32) -> &mut Self {
        if sign < 0 {
            self.append_negated_class(x)
        } else {
            self.append_class(x)
        }
    }

    fn append_group(&mut self, group: &CharGroup, fold_case: bool) -> &mut Self {
        if fold_case {
            let mut folded = CharClass::new();
            folded.append_folded_class(group.class).clean();
            self.append_class_with_sign(&folded.r, group.sign)
        } else {
            self.append_class_with_sign(group.class, group.sign)
        }
    }
}

/// re2js's `CharGroup`: a Perl or POSIX class and whether it is written negated.
struct CharGroup {
    sign: i32,
    class: &'static [u32],
}

const DIGIT: &[u32] = &[0x30, 0x39];
const SPACE: &[u32] = &[0x09, 0x0A, 0x0C, 0x0D, 0x20, 0x20];
const WORD: &[u32] = &[0x30, 0x39, 0x41, 0x5A, 0x5F, 0x5F, 0x61, 0x7A];

fn perl_group(escape: &str) -> Option<CharGroup> {
    let (sign, class) = match escape {
        "\\d" => (1, DIGIT),
        "\\D" => (-1, DIGIT),
        "\\s" => (1, SPACE),
        "\\S" => (-1, SPACE),
        "\\w" => (1, WORD),
        "\\W" => (-1, WORD),
        _ => return None,
    };
    Some(CharGroup { sign, class })
}

fn posix_group(name: &str) -> Option<CharGroup> {
    let (negated, bare) = match name.strip_prefix("[:^") {
        Some(rest) => (true, rest),
        None => (false, name.strip_prefix("[:")?),
    };
    let class: &'static [u32] = match bare {
        "alnum:]" => &[0x30, 0x39, 0x41, 0x5A, 0x61, 0x7A],
        "alpha:]" => &[0x41, 0x5A, 0x61, 0x7A],
        "ascii:]" => &[0x00, 0x7F],
        "blank:]" => &[0x09, 0x09, 0x20, 0x20],
        "cntrl:]" => &[0x00, 0x1F, 0x7F, 0x7F],
        "digit:]" => &[0x30, 0x39],
        "graph:]" => &[0x21, 0x7E],
        "lower:]" => &[0x61, 0x7A],
        "print:]" => &[0x20, 0x7E],
        "punct:]" => &[0x21, 0x2F, 0x3A, 0x40, 0x5B, 0x60, 0x7B, 0x7E],
        "space:]" => &[0x09, 0x0D, 0x20, 0x20],
        "upper:]" => &[0x41, 0x5A],
        "word:]" => &[0x30, 0x39, 0x41, 0x5A, 0x5F, 0x5F, 0x61, 0x7A],
        "xdigit:]" => &[0x30, 0x39, 0x41, 0x46, 0x61, 0x66],
        _ => return None,
    };
    Some(CharGroup { sign: if negated { -1 } else { 1 }, class })
}

// ------------------------------------------------------------------- the tree

/// re2js's `Regexp.Op`, in its order: the parser compares operators by it.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) enum Op {
    NoMatch,
    EmptyMatch,
    Literal,
    CharClass,
    AnyCharNotNl,
    AnyChar,
    BeginLine,
    EndLine,
    BeginText,
    EndText,
    WordBoundary,
    NoWordBoundary,
    Capture,
    Star,
    Plus,
    Quest,
    Repeat,
    Concat,
    Alternate,
    LeftParen,
    VerticalBar,
}

impl Op {
    fn is_pseudo(self) -> bool {
        self >= Op::LeftParen
    }
}

pub(crate) type NodeId = u32;

/// The link a node on the free list holds where its first child was: none.
const NO_NODE: NodeId = NodeId::MAX;

/// re2js's `Regexp`: one node of the arena.
#[derive(Clone, Debug)]
pub(crate) struct Regexp {
    pub(crate) op: Op,
    pub(crate) flags: u32,
    pub(crate) subs: Vec<NodeId>,
    pub(crate) runes: Vec<u32>,
    pub(crate) min: i32,
    pub(crate) max: i32,
    pub(crate) cap: u32,
    pub(crate) name: Option<String>,
}

impl Regexp {
    pub(crate) fn new(op: Op) -> Self {
        Self { op, flags: 0, subs: Vec::new(), runes: Vec::new(), min: 0, max: 0, cap: 0, name: None }
    }
}

/// A pattern read whole: the arena, its root, and the named groups by capture index.
pub(crate) struct ParsedPattern {
    pub(crate) nodes: Vec<Regexp>,
    pub(crate) root: NodeId,
    pub(crate) named_groups: Vec<(String, u32)>,
}

/// Why the parser refused a pattern: RE2's kind, and the text it quotes, if any.
#[derive(Clone, Debug)]
pub(crate) struct SyntaxError {
    pub(crate) kind: Re2PatternErrorKind,
    pub(crate) input: Option<String>,
}

fn refuse<T>(kind: Re2PatternErrorKind, input: &str) -> Result<T, SyntaxError> {
    Err(SyntaxError { kind, input: (!input.is_empty()).then(|| input.to_owned()) })
}

fn too_large<T>() -> Result<T, SyntaxError> {
    Err(SyntaxError { kind: Re2PatternErrorKind::ExpressionTooLarge, input: None })
}

/// Structural equality, re2js's `Regexp.equals`: a literal's or a class's runes compared
/// without its flags, as re2js compares them.
fn regexps_equal(nodes: &[Regexp], a: NodeId, b: NodeId) -> bool {
    let mut pending = vec![(a, b)];
    while let Some((a, b)) = pending.pop() {
        let (x, y) = (&nodes[a as usize], &nodes[b as usize]);
        if x.op != y.op {
            return false;
        }
        match x.op {
            Op::EndText => {
                if x.flags & WAS_DOLLAR != y.flags & WAS_DOLLAR {
                    return false;
                }
            }
            Op::Literal | Op::CharClass => {
                if x.runes != y.runes {
                    return false;
                }
            }
            Op::Alternate | Op::Concat => {
                if x.subs.len() != y.subs.len() {
                    return false;
                }
                pending.extend(x.subs.iter().copied().zip(y.subs.iter().copied()).rev());
            }
            Op::Star | Op::Plus | Op::Quest => {
                if x.flags & NON_GREEDY != y.flags & NON_GREEDY {
                    return false;
                }
                pending.push((x.subs[0], y.subs[0]));
            }
            Op::Repeat => {
                if x.flags & NON_GREEDY != y.flags & NON_GREEDY || x.min != y.min || x.max != y.max {
                    return false;
                }
                pending.push((x.subs[0], y.subs[0]));
            }
            Op::Capture => {
                if x.cap != y.cap || x.name != y.name {
                    return false;
                }
                pending.push((x.subs[0], y.subs[0]));
            }
            _ => {}
        }
    }
    true
}

/// The largest capture index in a tree, re2js's `Regexp.maxCap`.
pub(crate) fn max_cap(nodes: &[Regexp], root: NodeId) -> u32 {
    let mut max = 0;
    let mut pending = vec![root];
    while let Some(id) = pending.pop() {
        let node = &nodes[id as usize];
        if node.op == Op::Capture {
            max = max.max(node.cap);
        }
        pending.extend(node.subs.iter().copied());
    }
    max
}

// ------------------------------------------------------------------- the text

/// re2js's `StringIterator`, over byte positions. Every position it stops at is a
/// character boundary, as every one re2js stops at is a code-point boundary.
struct Cursor<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn more(&self) -> bool {
        self.pos < self.text.len()
    }

    fn peek(&self) -> Option<char> {
        self.text[self.pos..].chars().next()
    }

    fn pop(&mut self) -> char {
        let c = self.peek().expect("the parser pops only where text remains");
        self.pos += c.len_utf8();
        c
    }

    fn skip(&mut self, bytes: usize) {
        self.pos += bytes;
    }

    fn looking_at(&self, prefix: &str) -> bool {
        self.text[self.pos..].starts_with(prefix)
    }

    fn rest(&self) -> &'a str {
        &self.text[self.pos..]
    }

    fn from(&self, start: usize) -> &'a str {
        &self.text[start..self.pos]
    }
}

fn is_alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

fn unhex(c: char) -> Option<u32> {
    c.to_digit(16).filter(|_| c.is_ascii())
}

fn is_octal(c: Option<char>) -> bool {
    matches!(c, Some('0'..='7'))
}

/// re2js's `Parser.parseEscape`: one escape, the backslash under the cursor.
fn parse_escape(t: &mut Cursor) -> Result<u32, SyntaxError> {
    use Re2PatternErrorKind::*;
    let start = t.pos;
    t.skip(1);
    if !t.more() {
        return Err(SyntaxError { kind: TrailingBackslash, input: None });
    }
    let c = t.pop();
    match c {
        '1'..='7' | '0' if c == '0' || is_octal(t.peek()) => {
            let mut r = c as u32 - '0' as u32;
            for _ in 1..3 {
                match t.peek() {
                    Some(d @ '0'..='7') => {
                        r = r * 8 + (d as u32 - '0' as u32);
                        t.skip(1);
                    }
                    _ => break,
                }
            }
            return Ok(r);
        }
        'x' => {
            if t.more() {
                let c = t.pop();
                if c == '{' {
                    let mut digits = 0;
                    let mut r: u32 = 0;
                    loop {
                        if !t.more() {
                            return refuse(InvalidEscapeSequence, t.from(start));
                        }
                        let c = t.pop();
                        if c == '}' {
                            break;
                        }
                        let Some(v) = unhex(c) else {
                            return refuse(InvalidEscapeSequence, t.from(start));
                        };
                        r = r * 16 + v;
                        if r > MAX_RUNE {
                            return refuse(InvalidEscapeSequence, t.from(start));
                        }
                        digits += 1;
                    }
                    if digits == 0 {
                        return refuse(InvalidEscapeSequence, t.from(start));
                    }
                    return Ok(r);
                }
                let x = unhex(c);
                if t.more() {
                    let y = unhex(t.pop());
                    if let (Some(x), Some(y)) = (x, y) {
                        return Ok(x * 16 + y);
                    }
                }
            }
        }
        'a' => return Ok(0x07),
        'f' => return Ok(0x0C),
        'n' => return Ok(0x0A),
        'r' => return Ok(0x0D),
        't' => return Ok(0x09),
        'v' => return Ok(0x0B),
        _ => {
            if c.is_ascii() && !is_alnum(c) {
                return Ok(c as u32);
            }
        }
    }
    refuse(InvalidEscapeSequence, t.from(start))
}

fn parse_class_char(t: &mut Cursor, class_start: usize) -> Result<u32, SyntaxError> {
    if !t.more() {
        return refuse(Re2PatternErrorKind::MissingClosingBracket, t.from(class_start));
    }
    if t.looking_at("\\") {
        return parse_escape(t);
    }
    Ok(t.pop() as u32)
}

/// re2js's `Parser.parseInt`: the digits under the cursor; `-1` for none or a leading
/// zero, `-2` for more than eight.
fn parse_int(t: &mut Cursor) -> i64 {
    let start = t.pos;
    while matches!(t.peek(), Some('0'..='9')) {
        t.skip(1);
    }
    let digits = t.from(start);
    if digits.is_empty() || (digits.len() > 1 && digits.starts_with('0')) {
        return -1;
    }
    if digits.len() > 8 {
        return -2;
    }
    digits.parse().expect("eight decimal digits read as a number")
}

/// re2js's `Parser.parseRepeat`: `{n}`, `{n,}` or `{n,m}` under the cursor, or nothing
/// when the brace is a literal.
fn parse_repeat(t: &mut Cursor) -> Result<Option<(i32, i32)>, SyntaxError> {
    let start = t.pos;
    if !t.more() || !t.looking_at("{") {
        return Ok(None);
    }
    t.skip(1);
    let min = parse_int(t);
    if min == -1 || !t.more() {
        return Ok(None);
    }
    let max;
    if !t.looking_at(",") {
        max = min;
    } else {
        t.skip(1);
        if !t.more() {
            return Ok(None);
        }
        if t.looking_at("}") {
            max = -1;
        } else {
            max = parse_int(t);
            if max == -1 {
                return Ok(None);
            }
        }
    }
    if !t.more() || !t.looking_at("}") {
        return Ok(None);
    }
    t.skip(1);
    if min < 0 || min > 1000 || max == -2 || max > 1000 || (max >= 0 && min > max) {
        return refuse(Re2PatternErrorKind::InvalidRepeatCount, t.from(start));
    }
    Ok(Some((min as i32, max as i32)))
}

fn is_valid_capture_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c == '_' || is_alnum(c))
}

// ------------------------------------------------------------------- the parser

/// A suspended activation of re2js's mutually recursive `collapse` and `factor`.
enum FactorStep {
    /// `factor` running over an alternation's subexpressions.
    Factor(Box<Factor>),
    /// `collapse(…, ALTERNATE)` waiting for `factor` to answer the subexpressions of `node`.
    Collapse(NodeId),
}

/// One `factor` call's locals, so it can stop at a nested `collapse` and resume.
struct Factor {
    array: Vec<NodeId>,
    round: u8,
    i: usize,
    lensub: usize,
    lenout: usize,
    start: usize,
    text: Option<Vec<u32>>,
    text_len: usize,
    text_flags: u32,
    first: Option<NodeId>,
    /// The common prefix of the run whose suffixes are being collapsed.
    prefix: NodeId,
    /// Round 1: the current entry's literal, length and flags, applied once resumed.
    next_text: (Option<Vec<u32>>, usize, u32),
    /// Round 2: the current entry's leading subexpression, applied once resumed.
    next_first: Option<NodeId>,
}

/// What a `factor` step asks for.
enum FactorAsk {
    Done(Vec<NodeId>),
    Collapse(Vec<NodeId>),
}

struct Parser<'a> {
    whole: &'a str,
    flags: u32,
    nodes: Vec<Regexp>,
    stack: Vec<NodeId>,
    free: Option<NodeId>,
    num_cap: u32,
    named_groups: Vec<(String, u32)>,
    num_regexp: u64,
    num_runes: u64,
    repeats: i64,
    height: Option<HashMap<NodeId, i64>>,
    size: Option<HashMap<NodeId, i64>>,
}

/// Reads `pattern` in RE2's Perl mode, as re2js's `Parser.parse(pattern, RE2Flags.PERL)`.
pub(crate) fn parse(pattern: &str) -> Result<ParsedPattern, SyntaxError> {
    let mut parser = Parser {
        whole: pattern,
        flags: PERL,
        nodes: Vec::new(),
        stack: Vec::new(),
        free: None,
        num_cap: 0,
        named_groups: Vec::new(),
        num_regexp: 0,
        num_runes: 0,
        repeats: 0,
        height: None,
        size: None,
    };
    let root = parser.parse_internal()?;
    Ok(ParsedPattern { nodes: parser.nodes, root, named_groups: parser.named_groups })
}

impl<'a> Parser<'a> {
    fn node(&self, id: NodeId) -> &Regexp {
        &self.nodes[id as usize]
    }

    fn node_mut(&mut self, id: NodeId) -> &mut Regexp {
        &mut self.nodes[id as usize]
    }

    fn new_regexp(&mut self, op: Op) -> NodeId {
        if let Some(free) = self.free {
            let node = &mut self.nodes[free as usize];
            if !node.subs.is_empty() {
                let next = node.subs[0];
                self.free = (next != NO_NODE).then_some(next);
                *node = Regexp::new(op);
                return free;
            }
        }
        self.nodes.push(Regexp::new(op));
        self.num_regexp += 1;
        (self.nodes.len() - 1) as NodeId
    }

    fn reuse(&mut self, id: NodeId) {
        if let Some(height) = self.height.as_mut() {
            height.remove(&id);
        }
        let free = self.free.unwrap_or(NO_NODE);
        let node = &mut self.nodes[id as usize];
        if !node.subs.is_empty() {
            node.subs[0] = free;
        }
        self.free = Some(id);
    }

    // ---------------------------------------------------------- the limits

    fn check_limits(&mut self, id: NodeId) -> Result<(), SyntaxError> {
        if self.num_runes > MAX_RUNES {
            return too_large();
        }
        self.check_size(id)?;
        self.check_height(id)
    }

    fn check_size(&mut self, id: NodeId) -> Result<(), SyntaxError> {
        if self.size.is_none() {
            if self.repeats == 0 {
                self.repeats = 1;
            }
            let node = self.node(id);
            if node.op == Op::Repeat {
                let mut n = node.max as i64;
                if n == -1 {
                    n = node.min as i64;
                }
                if n <= 0 {
                    n = 1;
                }
                if n > MAX_SIZE / self.repeats {
                    self.repeats = MAX_SIZE;
                } else {
                    self.repeats *= n;
                }
            }
            if (self.num_regexp as i64) < MAX_SIZE / self.repeats {
                return Ok(());
            }
            self.size = Some(HashMap::new());
            for index in 0..self.stack.len() {
                let entry = self.stack[index];
                if self.calc_size(entry, true) > MAX_SIZE {
                    return too_large();
                }
            }
        }
        if self.calc_size(id, true) > MAX_SIZE {
            return too_large();
        }
        Ok(())
    }

    /// re2js's `calcSize`: a node's size from its children's, each memoized — a memo that
    /// outlives a change to its node, as re2js's does — and the root computed afresh.
    fn calc_size(&mut self, root: NodeId, force: bool) -> i64 {
        let mut pending = vec![(root, force, false)];
        let mut answer = 0;
        while let Some((id, forced, expanded)) = pending.pop() {
            let memo = self.size.as_ref().and_then(|size| size.get(&id).copied());
            if !forced && !expanded {
                if let Some(value) = memo {
                    answer = value;
                    continue;
                }
            }
            if !expanded {
                pending.push((id, forced, true));
                for &sub in self.node(id).subs.iter().rev() {
                    pending.push((sub, false, false));
                }
                continue;
            }
            let child = |sub: NodeId| self.size.as_ref().and_then(|size| size.get(&sub).copied()).unwrap_or(0);
            let node = self.node(id);
            let size = match node.op {
                Op::Literal => node.runes.len() as i64,
                Op::Capture | Op::Star => 2 + child(node.subs[0]),
                Op::Plus | Op::Quest => 1 + child(node.subs[0]),
                Op::Concat => node.subs.iter().map(|&sub| child(sub)).sum(),
                Op::Alternate => {
                    let sum: i64 = node.subs.iter().map(|&sub| child(sub)).sum();
                    if node.subs.len() > 1 {
                        sum + node.subs.len() as i64 - 1
                    } else {
                        sum
                    }
                }
                Op::Repeat => {
                    let sub = child(node.subs[0]);
                    if node.max == -1 {
                        if node.min == 0 {
                            2 + sub
                        } else {
                            1 + node.min as i64 * sub
                        }
                    } else {
                        node.max as i64 * sub + (node.max - node.min) as i64
                    }
                }
                _ => 0,
            }
            .max(1);
            self.size.get_or_insert_with(HashMap::new).insert(id, size);
            answer = size;
        }
        answer
    }

    fn check_height(&mut self, id: NodeId) -> Result<(), SyntaxError> {
        if (self.num_regexp as i64) < MAX_HEIGHT {
            return Ok(());
        }
        if self.height.is_none() {
            self.height = Some(HashMap::new());
            for index in 0..self.stack.len() {
                let entry = self.stack[index];
                if self.calc_height(entry, true) > MAX_HEIGHT {
                    return Err(SyntaxError { kind: Re2PatternErrorKind::ExpressionNestsTooDeeply, input: None });
                }
            }
        }
        if self.calc_height(id, true) > MAX_HEIGHT {
            return Err(SyntaxError { kind: Re2PatternErrorKind::ExpressionNestsTooDeeply, input: None });
        }
        Ok(())
    }

    /// re2js's `calcHeight`, memoized as `calc_size` is.
    fn calc_height(&mut self, root: NodeId, force: bool) -> i64 {
        let mut pending = vec![(root, force, false)];
        let mut answer = 0;
        while let Some((id, forced, expanded)) = pending.pop() {
            let memo = self.height.as_ref().and_then(|height| height.get(&id).copied());
            if !forced && !expanded {
                if let Some(value) = memo {
                    answer = value;
                    continue;
                }
            }
            if !expanded {
                pending.push((id, forced, true));
                for &sub in self.node(id).subs.iter().rev() {
                    pending.push((sub, false, false));
                }
                continue;
            }
            let height = self.height.get_or_insert_with(HashMap::new);
            let mut h = 1;
            for &sub in &self.nodes[id as usize].subs {
                h = h.max(1 + height.get(&sub).copied().unwrap_or(0));
            }
            height.insert(id, h);
            answer = h;
        }
        answer
    }

    /// re2js's `repeatIsValid`: no product of nested counts above `n`.
    fn repeat_is_valid(&self, root: NodeId, n: i64) -> bool {
        let mut pending = vec![(root, n)];
        while let Some((id, mut n)) = pending.pop() {
            let node = self.node(id);
            if node.op == Op::Repeat {
                let mut m = node.max as i64;
                if m == 0 {
                    continue;
                }
                if m < 0 {
                    m = node.min as i64;
                }
                if m > n {
                    return false;
                }
                if m > 0 {
                    n /= m;
                }
            }
            for &sub in node.subs.iter().rev() {
                pending.push((sub, n));
            }
        }
        true
    }

    // ---------------------------------------------------------- the stack

    fn push(&mut self, id: NodeId) -> Result<Option<NodeId>, SyntaxError> {
        let (op, runes) = {
            let node = self.node(id);
            (node.op, node.runes.clone())
        };
        self.num_runes += runes.len() as u64;
        if op == Op::CharClass && runes.len() == 2 && runes[0] == runes[1] {
            if self.maybe_concat(runes[0] as i64, self.flags & !FOLD_CASE) {
                return Ok(None);
            }
            let flags = self.flags & !FOLD_CASE;
            let node = self.node_mut(id);
            node.op = Op::Literal;
            node.runes = vec![runes[0]];
            node.flags = flags;
        } else if op == Op::CharClass
            && ((runes.len() == 4
                && runes[0] == runes[1]
                && runes[2] == runes[3]
                && simple_fold(runes[0]) == runes[2]
                && simple_fold(runes[2]) == runes[0])
                || (runes.len() == 2
                    && runes[0] + 1 == runes[1]
                    && simple_fold(runes[0]) == runes[1]
                    && simple_fold(runes[1]) == runes[0]))
        {
            if self.maybe_concat(runes[0] as i64, self.flags | FOLD_CASE) {
                return Ok(None);
            }
            let flags = self.flags | FOLD_CASE;
            let node = self.node_mut(id);
            node.op = Op::Literal;
            node.runes = vec![runes[0]];
            node.flags = flags;
        } else {
            self.maybe_concat(-1, 0);
        }
        self.stack.push(id);
        self.check_limits(id)?;
        Ok(Some(id))
    }

    fn maybe_concat(&mut self, r: i64, flags: u32) -> bool {
        let n = self.stack.len();
        if n < 2 {
            return false;
        }
        let re1 = self.stack[n - 1];
        let re2 = self.stack[n - 2];
        let (a, b) = (self.node(re1), self.node(re2));
        if a.op != Op::Literal || b.op != Op::Literal || a.flags & FOLD_CASE != b.flags & FOLD_CASE {
            return false;
        }
        let tail = a.runes.clone();
        self.node_mut(re2).runes.extend(tail);
        if r >= 0 {
            let node = self.node_mut(re1);
            node.runes = vec![r as u32];
            node.flags = flags;
            return true;
        }
        self.stack.pop();
        self.reuse(re1);
        false
    }

    fn new_literal(&mut self, mut r: u32, flags: u32) -> NodeId {
        let id = self.new_regexp(Op::Literal);
        if flags & FOLD_CASE != 0 {
            r = min_fold_rune(r);
        }
        let node = self.node_mut(id);
        node.flags = flags;
        node.runes = vec![r];
        id
    }

    fn literal(&mut self, r: u32) -> Result<(), SyntaxError> {
        let id = self.new_literal(r, self.flags);
        self.push(id).map(|_| ())
    }

    fn op(&mut self, op: Op) -> Result<NodeId, SyntaxError> {
        let id = self.new_regexp(op);
        self.node_mut(id).flags = self.flags;
        self.push(id)?;
        Ok(id)
    }

    fn repeat(
        &mut self,
        op: Op,
        min: i32,
        max: i32,
        before: usize,
        t: &mut Cursor,
        last_repeat: Option<usize>,
    ) -> Result<(), SyntaxError> {
        use Re2PatternErrorKind::*;
        let mut flags = self.flags;
        if t.more() && t.looking_at("?") {
            t.skip(1);
            flags ^= NON_GREEDY;
        }
        if let Some(last) = last_repeat {
            return refuse(InvalidNestedRepetitionOperator, t.from(last));
        }
        let Some(&sub) = self.stack.last() else {
            return refuse(MissingArgumentToRepetitionOperator, t.from(before));
        };
        if self.node(sub).op.is_pseudo() {
            return refuse(MissingArgumentToRepetitionOperator, t.from(before));
        }
        let id = self.new_regexp(op);
        let node = self.node_mut(id);
        node.min = min;
        node.max = max;
        node.flags = flags;
        node.subs = vec![sub];
        let top = self.stack.len() - 1;
        self.stack[top] = id;
        self.check_limits(id)?;
        if op == Op::Repeat && (min >= 2 || max >= 2) && !self.repeat_is_valid(id, 1000) {
            return refuse(InvalidRepeatCount, t.from(before));
        }
        Ok(())
    }

    fn pop_to_pseudo(&mut self) -> Vec<NodeId> {
        let mut i = self.stack.len();
        while i > 0 && !self.node(self.stack[i - 1]).op.is_pseudo() {
            i -= 1;
        }
        self.stack.split_off(i)
    }

    fn concat(&mut self) -> Result<Option<NodeId>, SyntaxError> {
        self.maybe_concat(-1, 0);
        let subs = self.pop_to_pseudo();
        if subs.is_empty() {
            let id = self.new_regexp(Op::EmptyMatch);
            return self.push(id);
        }
        let id = self.collapse_concat(subs);
        self.push(id)
    }

    fn alternate(&mut self) -> Result<Option<NodeId>, SyntaxError> {
        let subs = self.pop_to_pseudo();
        if let Some(&last) = subs.last() {
            self.clean_alt(last);
        }
        if subs.is_empty() {
            let id = self.new_regexp(Op::NoMatch);
            return self.push(id);
        }
        let id = self.collapse_alternate(subs)?;
        self.push(id)
    }

    fn clean_alt(&mut self, id: NodeId) {
        let node = self.node_mut(id);
        if node.op != Op::CharClass {
            return;
        }
        let mut class = CharClass::of(std::mem::take(&mut node.runes));
        class.clean();
        node.runes = class.r;
        if node.runes == [0, MAX_RUNE] {
            node.runes = Vec::new();
            node.op = Op::AnyChar;
        } else if node.runes == [0, 0x09, 0x0B, MAX_RUNE] {
            node.runes = Vec::new();
            node.op = Op::AnyCharNotNl;
        }
    }

    /// `subs` with every subexpression of operator `op` spliced in its place.
    fn flatten(&mut self, subs: Vec<NodeId>, op: Op) -> Vec<NodeId> {
        let mut out = Vec::with_capacity(subs.len());
        for sub in subs {
            if self.node(sub).op == op {
                out.extend(self.node(sub).subs.iter().copied());
                self.reuse(sub);
            } else {
                out.push(sub);
            }
        }
        out
    }

    fn collapse_concat(&mut self, subs: Vec<NodeId>) -> NodeId {
        if subs.len() == 1 {
            return subs[0];
        }
        let subs = self.flatten(subs, Op::Concat);
        let id = self.new_regexp(Op::Concat);
        self.node_mut(id).subs = subs;
        id
    }

    /// The first half of `collapse(subs, ALTERNATE)`: the alternation node, its
    /// subexpressions still to be factored.
    fn open_alternate(&mut self, subs: Vec<NodeId>) -> NodeId {
        let subs = self.flatten(subs, Op::Alternate);
        let id = self.new_regexp(Op::Alternate);
        self.node_mut(id).subs = subs;
        id
    }

    /// The second half: the factored subexpressions in place, and a single one in place of
    /// the alternation.
    fn close_alternate(&mut self, id: NodeId, factored: Vec<NodeId>) -> NodeId {
        if factored.len() == 1 {
            let only = factored[0];
            self.node_mut(id).subs = factored;
            self.reuse(id);
            return only;
        }
        self.node_mut(id).subs = factored;
        id
    }

    /// re2js's `collapse(subs, ALTERNATE)`, with `factor` and the `collapse` calls it makes
    /// for each run's suffixes suspended on a heap stack.
    fn collapse_alternate(&mut self, subs: Vec<NodeId>) -> Result<NodeId, SyntaxError> {
        if subs.len() == 1 {
            return Ok(subs[0]);
        }
        let id = self.open_alternate(subs);
        let array = self.node(id).subs.clone();
        let mut steps = vec![FactorStep::Collapse(id), FactorStep::Factor(Box::new(Factor::new(array)))];
        let mut delivered: Option<NodeId> = None;
        loop {
            let Some(FactorStep::Factor(mut factor)) = steps.pop() else {
                unreachable!("a factor is on top until the outermost collapse answers");
            };
            match self.run_factor(&mut factor, delivered.take())? {
                FactorAsk::Collapse(subs) => {
                    steps.push(FactorStep::Factor(factor));
                    if subs.len() == 1 {
                        delivered = Some(subs[0]);
                        continue;
                    }
                    let inner = self.open_alternate(subs);
                    let array = self.node(inner).subs.clone();
                    steps.push(FactorStep::Collapse(inner));
                    steps.push(FactorStep::Factor(Box::new(Factor::new(array))));
                }
                FactorAsk::Done(factored) => {
                    let Some(FactorStep::Collapse(node)) = steps.pop() else {
                        unreachable!("a factor is always above the collapse it answers");
                    };
                    let collapsed = self.close_alternate(node, factored);
                    if steps.is_empty() {
                        return Ok(collapsed);
                    }
                    delivered = Some(collapsed);
                }
            }
        }
    }

    fn leading_regexp(&self, id: NodeId) -> Option<NodeId> {
        let node = self.node(id);
        if node.op == Op::EmptyMatch {
            return None;
        }
        if node.op == Op::Concat && !node.subs.is_empty() {
            let sub = node.subs[0];
            if self.node(sub).op == Op::EmptyMatch {
                return None;
            }
            return Some(sub);
        }
        Some(id)
    }

    fn is_char_class(&self, id: NodeId) -> bool {
        let node = self.node(id);
        (node.op == Op::Literal && node.runes.len() == 1)
            || matches!(node.op, Op::CharClass | Op::AnyCharNotNl | Op::AnyChar)
    }

    /// One `factor` call, from where it stopped: it answers its factored array, or the
    /// suffixes it needs collapsed before it can go on.
    fn run_factor(&mut self, f: &mut Factor, resume: Option<NodeId>) -> Result<FactorAsk, SyntaxError> {
        if let Some(suffix) = resume {
            let concat = self.new_regexp(Op::Concat);
            self.node_mut(concat).subs = vec![f.prefix, suffix];
            f.array[f.lenout] = concat;
            f.lenout += 1;
            f.start = f.i;
            match f.round {
                1 => {
                    let (text, len, flags) = std::mem::take(&mut f.next_text);
                    f.text = text;
                    f.text_len = len;
                    f.text_flags = flags;
                }
                _ => f.first = f.next_first.take(),
            }
            f.i += 1;
        }
        if f.round == 0 {
            if f.array.len() < 2 {
                return Ok(FactorAsk::Done(std::mem::take(&mut f.array)));
            }
            f.round = 1;
            f.lensub = f.array.len();
            f.i = 0;
        }
        if f.round == 1 {
            while f.i <= f.lensub {
                let i = f.i;
                let mut istr: Option<Vec<u32>> = None;
                let mut istrlen = 0;
                let mut iflags = 0;
                if i < f.lensub {
                    let mut re = f.array[i];
                    let node = self.node(re);
                    if node.op == Op::Concat && !node.subs.is_empty() {
                        re = node.subs[0];
                    }
                    let node = self.node(re);
                    if node.op == Op::Literal {
                        istr = Some(node.runes.clone());
                        istrlen = node.runes.len();
                        iflags = node.flags & FOLD_CASE;
                    }
                    if iflags == f.text_flags {
                        let mut same = 0;
                        if let (Some(text), Some(other)) = (&f.text, &istr) {
                            while same < f.text_len && same < istrlen && text[same] == other[same] {
                                same += 1;
                            }
                        }
                        if same > 0 {
                            f.text_len = same;
                            f.i += 1;
                            continue;
                        }
                    }
                }
                if i == f.start {
                } else if i == f.start + 1 {
                    f.array[f.lenout] = f.array[f.start];
                    f.lenout += 1;
                } else {
                    let prefix = self.new_regexp(Op::Literal);
                    let runes = f.text.as_ref().expect("a run of two or more shares a literal")[..f.text_len].to_vec();
                    let node = self.node_mut(prefix);
                    node.flags = f.text_flags;
                    node.runes = runes;
                    for j in f.start..i {
                        let entry = self.remove_leading_string(f.array[j], f.text_len);
                        f.array[j] = entry;
                        self.check_limits(entry)?;
                    }
                    f.prefix = prefix;
                    f.next_text = (istr, istrlen, iflags);
                    return Ok(FactorAsk::Collapse(f.array[f.start..i].to_vec()));
                }
                f.start = i;
                f.text = istr;
                f.text_len = istrlen;
                f.text_flags = iflags;
                f.i += 1;
            }
            f.round = 2;
            f.lensub = f.lenout;
            f.start = 0;
            f.lenout = 0;
            f.first = None;
            f.i = 0;
        }
        if f.round == 2 {
            while f.i <= f.lensub {
                let i = f.i;
                let mut ifirst = None;
                if i < f.lensub {
                    ifirst = self.leading_regexp(f.array[i]);
                    if let (Some(first), Some(candidate)) = (f.first, ifirst) {
                        let node = self.node(first);
                        if regexps_equal(&self.nodes, first, candidate)
                            && (self.is_char_class(first)
                                || (node.op == Op::Repeat && node.min == node.max && self.is_char_class(node.subs[0])))
                        {
                            f.i += 1;
                            continue;
                        }
                    }
                }
                if i == f.start {
                } else if i == f.start + 1 {
                    f.array[f.lenout] = f.array[f.start];
                    f.lenout += 1;
                } else {
                    let prefix = f.first.expect("a run of two or more shares a leading subexpression");
                    for j in f.start..i {
                        let entry = self.remove_leading_regexp(f.array[j], j != f.start);
                        f.array[j] = entry;
                        self.check_limits(entry)?;
                    }
                    f.prefix = prefix;
                    f.next_first = ifirst;
                    return Ok(FactorAsk::Collapse(f.array[f.start..i].to_vec()));
                }
                f.start = i;
                f.first = ifirst;
                f.i += 1;
            }
            f.round = 3;
        }
        // Round 3: runs of single characters and classes merged into one class.
        let lensub = f.lenout;
        let mut start = 0;
        let mut lenout = 0;
        for i in 0..=lensub {
            if i < lensub && self.is_char_class(f.array[i]) {
                continue;
            }
            if i == start {
            } else if i == start + 1 {
                f.array[lenout] = f.array[start];
                lenout += 1;
            } else {
                let mut max = start;
                for j in start + 1..i {
                    let (a, b) = (self.node(f.array[max]), self.node(f.array[j]));
                    if a.op < b.op || (a.op == b.op && a.runes.len() < b.runes.len()) {
                        max = j;
                    }
                }
                f.array.swap(start, max);
                for j in start + 1..i {
                    self.merge_char_class(f.array[start], f.array[j]);
                    self.reuse(f.array[j]);
                }
                self.clean_alt(f.array[start]);
                f.array[lenout] = f.array[start];
                lenout += 1;
            }
            if i < lensub {
                f.array[lenout] = f.array[i];
                lenout += 1;
            }
            start = i + 1;
        }
        // Round 4: a run of empty matches is one.
        let lensub = lenout;
        let mut lenout = 0;
        for i in 0..lensub {
            if i + 1 < lensub
                && self.node(f.array[i]).op == Op::EmptyMatch
                && self.node(f.array[i + 1]).op == Op::EmptyMatch
            {
                continue;
            }
            f.array[lenout] = f.array[i];
            lenout += 1;
        }
        let mut array = std::mem::take(&mut f.array);
        array.truncate(lenout);
        Ok(FactorAsk::Done(array))
    }

    /// re2js's `removeLeadingString`, down the chain of first subexpressions and back.
    fn remove_leading_string(&mut self, root: NodeId, n: usize) -> NodeId {
        let mut chain = Vec::new();
        let mut id = root;
        while self.node(id).op == Op::Concat && !self.node(id).subs.is_empty() {
            chain.push(id);
            id = self.node(id).subs[0];
        }
        let node = self.node_mut(id);
        if node.op == Op::Literal {
            node.runes = node.runes[n.min(node.runes.len())..].to_vec();
            if node.runes.is_empty() {
                node.op = Op::EmptyMatch;
            }
        }
        let mut sub = id;
        while let Some(mut re) = chain.pop() {
            self.node_mut(re).subs[0] = sub;
            if self.node(sub).op == Op::EmptyMatch {
                self.reuse(sub);
                match self.node(re).subs.len() {
                    0 | 1 => {
                        let node = self.node_mut(re);
                        node.op = Op::EmptyMatch;
                        node.subs = Vec::new();
                    }
                    2 => {
                        let old = re;
                        re = self.node(re).subs[1];
                        self.reuse(old);
                    }
                    _ => {
                        let node = self.node_mut(re);
                        node.subs.remove(0);
                    }
                }
            }
            sub = re;
        }
        sub
    }

    fn remove_leading_regexp(&mut self, id: NodeId, reuse: bool) -> NodeId {
        let node = self.node(id);
        if node.op == Op::Concat && !node.subs.is_empty() {
            if reuse {
                let first = node.subs[0];
                self.reuse(first);
            }
            let node = self.node_mut(id);
            node.subs.remove(0);
            match node.subs.len() {
                0 => {
                    node.op = Op::EmptyMatch;
                    node.subs = Vec::new();
                    return id;
                }
                1 => {
                    let only = node.subs[0];
                    self.reuse(id);
                    return only;
                }
                _ => return id,
            }
        }
        if reuse {
            self.reuse(id);
        }
        self.new_regexp(Op::EmptyMatch)
    }

    fn merge_char_class(&mut self, dst: NodeId, src: NodeId) {
        let (src_op, src_runes, src_flags) = {
            let node = self.node(src);
            (node.op, node.runes.clone(), node.flags)
        };
        let dst_node = self.node(dst);
        match dst_node.op {
            Op::AnyChar => {}
            Op::AnyCharNotNl => {
                if match_rune(src_op, &src_runes, 0x0A) {
                    self.node_mut(dst).op = Op::AnyChar;
                }
            }
            Op::CharClass => {
                let mut class = CharClass::of(std::mem::take(&mut self.node_mut(dst).runes));
                if src_op == Op::Literal {
                    class.append_literal(src_runes[0], src_flags);
                } else {
                    class.append_class(&src_runes);
                }
                self.node_mut(dst).runes = class.r;
            }
            Op::Literal => {
                if src_runes[0] == dst_node.runes[0] && src_flags == dst_node.flags {
                    return;
                }
                let (rune, flags) = (dst_node.runes[0], dst_node.flags);
                let mut class = CharClass::new();
                class.append_literal(rune, flags).append_literal(src_runes[0], src_flags);
                let node = self.node_mut(dst);
                node.op = Op::CharClass;
                node.runes = class.r;
            }
            _ => {}
        }
    }

    // ---------------------------------------------------------- the grammar

    fn parse_internal(&mut self) -> Result<NodeId, SyntaxError> {
        let whole = self.whole;
        let mut t = Cursor { text: whole, pos: 0 };
        let mut last_repeat: Option<usize> = None;
        let mut min = -1;
        let mut max = -1;
        while t.more() {
            let mut repeat_pos = None;
            match t.peek().expect("text remains") {
                '(' => {
                    if t.looking_at("(?") {
                        self.parse_perl_flags(&mut t)?;
                    } else {
                        let id = self.op(Op::LeftParen)?;
                        self.num_cap += 1;
                        self.node_mut(id).cap = self.num_cap;
                        t.skip(1);
                    }
                }
                '|' => {
                    self.parse_vertical_bar()?;
                    t.skip(1);
                }
                ')' => {
                    self.parse_right_paren()?;
                    t.skip(1);
                }
                '^' => {
                    self.op(if self.flags & ONE_LINE != 0 { Op::BeginText } else { Op::BeginLine })?;
                    t.skip(1);
                }
                '$' => {
                    if self.flags & ONE_LINE != 0 {
                        let id = self.op(Op::EndText)?;
                        self.node_mut(id).flags |= WAS_DOLLAR;
                    } else {
                        self.op(Op::EndLine)?;
                    }
                    t.skip(1);
                }
                '.' => {
                    self.op(if self.flags & DOT_NL != 0 { Op::AnyChar } else { Op::AnyCharNotNl })?;
                    t.skip(1);
                }
                '[' => self.parse_class(&mut t)?,
                c @ ('*' | '+' | '?') => {
                    repeat_pos = Some(t.pos);
                    t.pop();
                    let op = match c {
                        '*' => Op::Star,
                        '+' => Op::Plus,
                        _ => Op::Quest,
                    };
                    self.repeat(op, min, max, t.pos - 1, &mut t, last_repeat)?;
                }
                '{' => {
                    let before = t.pos;
                    repeat_pos = Some(before);
                    match parse_repeat(&mut t)? {
                        None => {
                            t.pos = before;
                            let c = t.pop();
                            self.literal(c as u32)?;
                        }
                        Some((lo, hi)) => {
                            min = lo;
                            max = hi;
                            self.repeat(Op::Repeat, min, max, before, &mut t, last_repeat)?;
                        }
                    }
                }
                '\\' => self.parse_backslash(&mut t)?,
                _ => {
                    let c = t.pop();
                    self.literal(c as u32)?;
                }
            }
            last_repeat = repeat_pos;
        }
        self.concat()?;
        if self.swap_vertical_bar() {
            self.stack.pop();
        }
        self.alternate()?;
        if self.stack.len() != 1 {
            return refuse(Re2PatternErrorKind::MissingClosingParen, whole);
        }
        Ok(self.stack[0])
    }

    fn parse_backslash(&mut self, t: &mut Cursor) -> Result<(), SyntaxError> {
        let saved = t.pos;
        t.skip(1);
        if t.more() {
            match t.pop() {
                'A' => return self.op(Op::BeginText).map(|_| ()),
                'b' => return self.op(Op::WordBoundary).map(|_| ()),
                'B' => return self.op(Op::NoWordBoundary).map(|_| ()),
                'C' => return refuse(Re2PatternErrorKind::InvalidEscapeSequence, "\\C"),
                'Q' => {
                    let rest = t.rest();
                    let literal = match rest.find("\\E") {
                        Some(end) => {
                            t.skip(end + 2);
                            &rest[..end]
                        }
                        None => {
                            t.skip(rest.len());
                            rest
                        }
                    };
                    for c in literal.chars() {
                        self.literal(c as u32)?;
                    }
                    return Ok(());
                }
                'z' => return self.op(Op::EndText).map(|_| ()),
                _ => t.pos = saved,
            }
        } else {
            t.pos = saved;
        }
        let id = self.new_regexp(Op::CharClass);
        self.node_mut(id).flags = self.flags;
        if t.looking_at("\\p") || t.looking_at("\\P") {
            let mut class = CharClass::new();
            if self.parse_unicode_class(t, &mut class)? {
                self.node_mut(id).runes = class.r;
                self.push(id)?;
                return Ok(());
            }
        }
        let mut class = CharClass::new();
        if self.parse_perl_class_escape(t, &mut class) {
            self.node_mut(id).runes = class.r;
            self.push(id)?;
            return Ok(());
        }
        t.pos = saved;
        self.reuse(id);
        let r = parse_escape(t)?;
        self.literal(r)
    }

    fn parse_perl_flags(&mut self, t: &mut Cursor) -> Result<(), SyntaxError> {
        use Re2PatternErrorKind::*;
        let start = t.pos;
        let s = t.rest();
        if s.starts_with("(?P<") || s.starts_with("(?<") {
            let begin = if s.as_bytes()[2] == b'P' { 4 } else { 3 };
            let Some(end) = s.find('>') else {
                return refuse(InvalidNamedCapture, s);
            };
            let name = &s[begin..end];
            t.skip(name.len());
            t.skip(begin + 1);
            if !is_valid_capture_name(name) {
                return refuse(InvalidNamedCapture, &s[..end + 1]);
            }
            let id = self.op(Op::LeftParen)?;
            self.num_cap += 1;
            self.node_mut(id).cap = self.num_cap;
            if self.named_groups.iter().any(|(existing, _)| existing == name) {
                return refuse(DuplicateCaptureGroupName, name);
            }
            self.named_groups.push((name.to_owned(), self.num_cap));
            self.node_mut(id).name = Some(name.to_owned());
            return Ok(());
        }
        t.skip(2);
        let mut flags = self.flags;
        let mut sign = 1;
        let mut saw_flag = false;
        while t.more() {
            let c = t.pop();
            match c {
                'i' => {
                    flags |= FOLD_CASE;
                    saw_flag = true;
                }
                'm' => {
                    flags &= !ONE_LINE;
                    saw_flag = true;
                }
                's' => {
                    flags |= DOT_NL;
                    saw_flag = true;
                }
                'U' => {
                    flags |= NON_GREEDY;
                    saw_flag = true;
                }
                '-' => {
                    if sign < 0 {
                        break;
                    }
                    sign = -1;
                    flags = !flags;
                    saw_flag = false;
                }
                ':' | ')' => {
                    if sign < 0 {
                        if !saw_flag {
                            break;
                        }
                        flags = !flags;
                    }
                    if c == ':' {
                        self.op(Op::LeftParen)?;
                    }
                    self.flags = flags;
                    return Ok(());
                }
                _ => break,
            }
        }
        refuse(InvalidOrUnsupportedPerlSyntax, t.from(start))
    }

    fn parse_vertical_bar(&mut self) -> Result<(), SyntaxError> {
        self.concat()?;
        if !self.swap_vertical_bar() {
            self.op(Op::VerticalBar)?;
        }
        Ok(())
    }

    fn swap_vertical_bar(&mut self) -> bool {
        let n = self.stack.len();
        if n >= 3
            && self.node(self.stack[n - 2]).op == Op::VerticalBar
            && self.is_char_class(self.stack[n - 1])
            && self.is_char_class(self.stack[n - 3])
        {
            let mut re1 = self.stack[n - 1];
            let mut re3 = self.stack[n - 3];
            if self.node(re1).op > self.node(re3).op {
                std::mem::swap(&mut re1, &mut re3);
                self.stack[n - 3] = re3;
            }
            self.merge_char_class(re3, re1);
            self.reuse(re1);
            self.stack.pop();
            return true;
        }
        if n >= 2 {
            let re1 = self.stack[n - 1];
            let re2 = self.stack[n - 2];
            if self.node(re2).op == Op::VerticalBar {
                if n >= 3 {
                    self.clean_alt(self.stack[n - 3]);
                }
                self.stack[n - 2] = re1;
                self.stack[n - 1] = re2;
                return true;
            }
        }
        false
    }

    fn parse_right_paren(&mut self) -> Result<(), SyntaxError> {
        use Re2PatternErrorKind::UnexpectedParen;
        self.concat()?;
        if self.swap_vertical_bar() {
            self.stack.pop();
        }
        self.alternate()?;
        if self.stack.len() < 2 {
            return refuse(UnexpectedParen, self.whole);
        }
        let re1 = self.stack.pop().expect("two entries");
        let re2 = self.stack.pop().expect("two entries");
        if self.node(re2).op != Op::LeftParen {
            return refuse(UnexpectedParen, self.whole);
        }
        self.flags = self.node(re2).flags;
        if self.node(re2).cap == 0 {
            self.push(re1)?;
        } else {
            let node = self.node_mut(re2);
            node.op = Op::Capture;
            node.subs = vec![re1];
            self.push(re2)?;
        }
        Ok(())
    }

    fn parse_perl_class_escape(&self, t: &mut Cursor, class: &mut CharClass) -> bool {
        let before = t.pos;
        if !t.more() || t.pop() != '\\' || !t.more() {
            return false;
        }
        t.pop();
        let Some(group) = perl_group(t.from(before)) else {
            return false;
        };
        class.append_group(&group, self.flags & FOLD_CASE != 0);
        true
    }

    fn parse_named_class(&self, t: &mut Cursor, class: &mut CharClass) -> Result<bool, SyntaxError> {
        let rest = t.rest();
        let Some(end) = rest.find(":]") else {
            return Ok(false);
        };
        let name = &rest[..end + 2];
        t.skip(name.len());
        let Some(group) = posix_group(name) else {
            return refuse(Re2PatternErrorKind::InvalidCharacterClassRange, name);
        };
        class.append_group(&group, self.flags & FOLD_CASE != 0);
        Ok(true)
    }

    fn parse_unicode_class(&self, t: &mut Cursor, class: &mut CharClass) -> Result<bool, SyntaxError> {
        use Re2PatternErrorKind::InvalidCharacterClassRange;
        let start = t.pos;
        if !t.looking_at("\\p") && !t.looking_at("\\P") {
            return Ok(false);
        }
        t.skip(1);
        let mut sign = if t.pop() == 'P' { -1 } else { 1 };
        if !t.more() {
            t.pos = start;
            return refuse(InvalidCharacterClassRange, t.rest());
        }
        let c = t.pop();
        let mut name: &str;
        if c != '{' {
            name = &t.text[t.pos - c.len_utf8()..t.pos];
        } else {
            let rest = t.rest();
            let Some(end) = rest.find('}') else {
                t.pos = start;
                return refuse(InvalidCharacterClassRange, t.rest());
            };
            name = &rest[..end];
            t.skip(end + 1);
        }
        if let Some(stripped) = name.strip_prefix('^') {
            sign = -sign;
            name = stripped;
        }
        let Some((table, fold, table_sign)) = unicode_table(name) else {
            return refuse(InvalidCharacterClassRange, t.from(start));
        };
        if table_sign < 0 {
            sign = -sign;
        }
        match fold {
            Some(fold) if self.flags & FOLD_CASE != 0 => {
                let mut folded = CharClass::new();
                folded.append_table(table).append_table(fold).clean();
                class.append_class_with_sign(&folded.r, sign);
            }
            _ => {
                class.append_table_with_sign(table, sign);
            }
        }
        Ok(true)
    }

    fn parse_class(&mut self, t: &mut Cursor) -> Result<(), SyntaxError> {
        let start = t.pos;
        t.skip(1);
        let id = self.new_regexp(Op::CharClass);
        self.node_mut(id).flags = self.flags;
        let mut class = CharClass::new();
        let mut sign = 1;
        if t.more() && t.looking_at("^") {
            sign = -1;
            t.skip(1);
        }
        let mut first = true;
        while !t.more() || t.peek() != Some(']') || first {
            first = false;
            let before = t.pos;
            if t.looking_at("[:") {
                if self.parse_named_class(t, &mut class)? {
                    continue;
                }
                t.pos = before;
            }
            if self.parse_unicode_class(t, &mut class)? {
                continue;
            }
            if self.parse_perl_class_escape(t, &mut class) {
                continue;
            }
            t.pos = before;
            let lo = parse_class_char(t, start)?;
            let mut hi = lo;
            if t.more() && t.looking_at("-") {
                t.skip(1);
                if t.more() && t.looking_at("]") {
                    t.pos -= 1;
                } else {
                    hi = parse_class_char(t, start)?;
                    if hi < lo {
                        return refuse(Re2PatternErrorKind::InvalidCharacterClassRange, t.from(before));
                    }
                }
            }
            if self.flags & FOLD_CASE == 0 {
                class.append_range(lo, hi);
            } else {
                class.append_folded_range(lo, hi);
            }
        }
        t.skip(1);
        class.clean();
        if sign < 0 {
            class.negate();
        }
        self.node_mut(id).runes = class.r;
        self.push(id)?;
        Ok(())
    }
}

impl Factor {
    fn new(array: Vec<NodeId>) -> Self {
        Self {
            array,
            round: 0,
            i: 0,
            lensub: 0,
            lenout: 0,
            start: 0,
            text: None,
            text_len: 0,
            text_flags: 0,
            first: None,
            prefix: NO_NODE,
            next_text: (None, 0, 0),
            next_first: None,
        }
    }
}

/// re2js's `Parser.matchRune`.
fn match_rune(op: Op, runes: &[u32], r: u32) -> bool {
    match op {
        Op::Literal => runes.len() == 1 && runes[0] == r,
        Op::CharClass => runes.chunks_exact(2).any(|pair| pair[0] <= r && r <= pair[1]),
        Op::AnyCharNotNl => r != 0x0A,
        Op::AnyChar => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    //! The engine's Unicode data against the tables Node reads: for every name `\p`
    //! accepts, the digest of its ranges and of what folding adds to them, and the digests of
    //! the casing and the fold step over every code point — each recorded by executing re2js
    //! 2.8.3 and V8 under Node 24.21 (Unicode 17.0, ICU 78.3; `@telorun/cel 0.120.1 at
    //! b4a2b6e9`). A digest is FNV-1a 64 over the UTF-8 of `lo-hi,` per range, or of
    //! `code:mapping,` per code point whose mapping is not itself.

    use super::*;
    use crate::unicode_tables::UNICODE_VERSION;

    /// `(name, sign, digest of the table, digest of what folding adds)`, from re2js's
    /// `Parser.unicodeTable`.
    const NODE_TABLES: [(&str, i32, u64, Option<u64>); 233] = [
    ("ASCII_Hex_Digit", 1, 0x2081e9755a4ba377, None),
    ("Adlam", 1, 0x26d3ef911d2ff38c, None),
    ("Ahom", 1, 0xede6219ace3ef95a, None),
    ("Alphabetic", 1, 0xf080e1a1e9eb0275, None),
    ("Anatolian_Hieroglyphs", 1, 0x508fb456de05d239, None),
    ("Any", 1, 0xff30e278c398e2b6, Some(0xff30e278c398e2b6)),
    ("Arabic", 1, 0x715a59ae21287cb1, None),
    ("Armenian", 1, 0x87b6ad619d1ef7a9, None),
    ("Ascii", 1, 0x10942ed68f36f46e, Some(0x968ecd14e6868a66)),
    ("Assigned", -1, 0x9e8a47e68123468d, Some(0x9e8a47e68123468d)),
    ("Avestan", 1, 0xe4f64c8f0ae0d8d5, None),
    ("Balinese", 1, 0x9f9218106c295291, None),
    ("Bamum", 1, 0xb405eeefa118eb70, None),
    ("Bassa_Vah", 1, 0xb98601b1bb50fdf0, None),
    ("Batak", 1, 0xa836c6f5265f0c08, None),
    ("Bengali", 1, 0x16103c6d1db05939, None),
    ("Beria_Erfe", 1, 0xb2d1778a3254e861, None),
    ("Bhaiksuki", 1, 0x474a09db99b379c2, None),
    ("Bopomofo", 1, 0x2bc9f31ad11ed718, None),
    ("Brahmi", 1, 0x7ade1bd83d7b497b, None),
    ("Braille", 1, 0x2912012347d9d856, None),
    ("Buginese", 1, 0xfbe1e9e4bdf9c1a0, None),
    ("Buhid", 1, 0xc460986c10f9643b, None),
    ("C", 1, 0xad68c9e22545cd86, None),
    ("Canadian_Aboriginal", 1, 0x87cbdeb8d3512ff0, None),
    ("Carian", 1, 0x0b99af2e06969817, None),
    ("Caucasian_Albanian", 1, 0xe0152787603c0798, None),
    ("Cc", 1, 0x4be86ee95ff4b606, None),
    ("Cf", 1, 0x6703401b9316ca1b, None),
    ("Chakma", 1, 0x7daddc18f114cfb0, None),
    ("Cham", 1, 0x6218b4deb3affee8, None),
    ("Cherokee", 1, 0x7d892b88f94c3c2d, None),
    ("Chorasmian", 1, 0x4d49e3339811066b, None),
    ("Cn", 1, 0x9e8a47e68123468d, None),
    ("Co", 1, 0x3eac3fcc4c1840a6, None),
    ("Common", 1, 0xa2696e81c0cab7fe, Some(0x75a8811218aebfe5)),
    ("Coptic", 1, 0x58b04075d7a80c4a, None),
    ("Cs", 1, 0x88ed8753b492d007, None),
    ("Cuneiform", 1, 0x9812e25509baa89b, None),
    ("Cypriot", 1, 0x447abf2c9ff82896, None),
    ("Cypro_Minoan", 1, 0x678dc03335f8e2fb, None),
    ("Cyrillic", 1, 0x6334093bc4b1be1b, None),
    ("Dash", 1, 0xc120c38ecc9fd38f, None),
    ("Deseret", 1, 0xc0dc490e2c0260c7, None),
    ("Devanagari", 1, 0x397d8cba75468eab, None),
    ("Dives_Akuru", 1, 0x9041917c589376e3, None),
    ("Dogra", 1, 0x39a994c4f83692d7, None),
    ("Duployan", 1, 0x00c1d3e31016b236, None),
    ("Egyptian_Hieroglyphs", 1, 0x6212279123804279, None),
    ("Elbasan", 1, 0xb6e0bf4980d07425, None),
    ("Elymaic", 1, 0xd85595c6cbbe43e6, None),
    ("Emoji", 1, 0x4e06142504eb591f, Some(0x7282b5f5b372cc08)),
    ("Emoji_Component", 1, 0xf26ff9c8de00fd6f, None),
    ("Emoji_Modifier", 1, 0x4dd95fa541238e9e, None),
    ("Emoji_Modifier_Base", 1, 0xf57f91af7860ac6b, None),
    ("Emoji_Presentation", 1, 0x550f70a33d23e59b, None),
    ("Ethiopic", 1, 0x383e84189bc78920, None),
    ("Extended_Pictographic", 1, 0x0bc5ffeefe861e3b, Some(0x7282b5f5b372cc08)),
    ("Garay", 1, 0xfa3ae51654de0819, None),
    ("Georgian", 1, 0x837648a109243e14, None),
    ("Glagolitic", 1, 0x63506a599df74246, None),
    ("Gothic", 1, 0x1370aa1b68378e8a, None),
    ("Grantha", 1, 0xb2b9b9f885c5dfbe, None),
    ("Greek", 1, 0x0e7dc821d3f24031, Some(0x47bcd4800ae52cf1)),
    ("Gujarati", 1, 0x61fe264df90e99a0, None),
    ("Gunjala_Gondi", 1, 0xb8ab5b3d4be5acf1, None),
    ("Gurmukhi", 1, 0x7dc3f06136b3257a, None),
    ("Gurung_Khema", 1, 0xefb16240ad1a2374, None),
    ("Han", 1, 0x4896e67b05fd32e1, None),
    ("Hangul", 1, 0x85010b4ecd931aec, None),
    ("Hanifi_Rohingya", 1, 0x563993de5cd3fb53, None),
    ("Hanunoo", 1, 0xf981d345fe89e612, None),
    ("Hatran", 1, 0xfc011dc4b73f2f7b, None),
    ("Hebrew", 1, 0x2b3589e413ffccae, None),
    ("Hex_Digit", 1, 0xdf979ae7a876190c, None),
    ("Hiragana", 1, 0x38f227f888610f99, None),
    ("Imperial_Aramaic", 1, 0x44782afceb09c1b6, None),
    ("Inherited", 1, 0x979e1f185ba0ea54, Some(0xbdde1ef7c2cc60ea)),
    ("Inscriptional_Pahlavi", 1, 0x46262c389c0b63ba, None),
    ("Inscriptional_Parthian", 1, 0x85a77d2a211d6f61, None),
    ("Javanese", 1, 0x07463d06ad1296b4, None),
    ("Kaithi", 1, 0x14d3efb5c7e5a9fc, None),
    ("Kannada", 1, 0x871b94c5a8e51271, None),
    ("Katakana", 1, 0x8343fc4d4d4a83a8, None),
    ("Kawi", 1, 0x326844ab1942f303, None),
    ("Kayah_Li", 1, 0x1d054cf508c39b03, None),
    ("Kharoshthi", 1, 0x869808a31934db7e, None),
    ("Khitan_Small_Script", 1, 0x6af135e263125d93, None),
    ("Khmer", 1, 0xe6ba2ae3df2302f2, None),
    ("Khojki", 1, 0xed4fcbe81ef1935d, None),
    ("Khudawadi", 1, 0x76a4c1824d780c1e, None),
    ("Kirat_Rai", 1, 0x87ab2c323b2b3d9d, None),
    ("L", 1, 0x27a3bb884343a1fa, Some(0xff07b00b7855d61e)),
    ("LC", 1, 0x1bccdfa588e4b06e, Some(0xff07b00b7855d61e)),
    ("Lao", 1, 0x6b2f218ecab19fb9, None),
    ("Latin", 1, 0x781ad4e8ae7210c0, None),
    ("Lc", 1, 0x1bccdfa588e4b06e, Some(0xff07b00b7855d61e)),
    ("Lepcha", 1, 0xf95685783d5208b2, None),
    ("Limbu", 1, 0xc8eae7d786f9d10f, None),
    ("Linear_A", 1, 0x00482dd586f5a120, None),
    ("Linear_B", 1, 0x47272c32f89c0add, None),
    ("Lisu", 1, 0x3faafca202dcd96b, None),
    ("Ll", 1, 0x7b134f05c55a4ae1, Some(0xf19ec6460b193a44)),
    ("Lm", 1, 0x565a84e8197a7e71, None),
    ("Lo", 1, 0x4223b377acbab0dc, None),
    ("Lowercase", 1, 0x80d0c99bbdd0d356, Some(0xe6ae721785134e28)),
    ("Lt", 1, 0x8af6a1a344061eec, Some(0x02f4475eac1abb2d)),
    ("Lu", 1, 0xe91fe4e30aeddbdb, Some(0xf6bd1657e93b6f6a)),
    ("Lycian", 1, 0x7371519906269216, None),
    ("Lydian", 1, 0xc7a2b8cd455fbe0a, None),
    ("M", 1, 0x42a7bbc26bf1fb81, Some(0xbdde1ef7c2cc60ea)),
    ("Mahajani", 1, 0xd960253c1a218ead, None),
    ("Makasar", 1, 0xab439433ac0ecafc, None),
    ("Malayalam", 1, 0x1ca2d43b24d00c61, None),
    ("Mandaic", 1, 0xb843dae17a051c86, None),
    ("Manichaean", 1, 0x8a31a78064bc8a92, None),
    ("Marchen", 1, 0xfa1942a4ecc209d7, None),
    ("Masaram_Gondi", 1, 0x4a2b19ceb127f399, None),
    ("Math", 1, 0xf09ac43537d8a482, Some(0x452254f389919721)),
    ("Mc", 1, 0xa79921a0dfddc7fc, None),
    ("Me", 1, 0x564d6f36a0cab34e, None),
    ("Medefaidrin", 1, 0x6deaffe56c8b7d80, None),
    ("Meetei_Mayek", 1, 0x22ac33aa596981f6, None),
    ("Mende_Kikakui", 1, 0x9fb28e67196188e9, None),
    ("Meroitic_Cursive", 1, 0x5ca7a2c037aa1ddf, None),
    ("Meroitic_Hieroglyphs", 1, 0xdce7a9acc8290e62, None),
    ("Miao", 1, 0x6b93a31c1829a491, None),
    ("Mn", 1, 0x75b375c6634667ec, Some(0xbdde1ef7c2cc60ea)),
    ("Modi", 1, 0xb62e203cbfa1c34f, None),
    ("Mongolian", 1, 0xe2a0e976797b102e, None),
    ("Mro", 1, 0x15df5b9ca4a026d8, None),
    ("Multani", 1, 0xb6e8b4fd1b03c43f, None),
    ("Myanmar", 1, 0x7946b8ca0ec5d8a9, None),
    ("N", 1, 0xb4bd72fa169c19bb, None),
    ("Nabataean", 1, 0x7370bf38c91bd5d6, None),
    ("Nag_Mundari", 1, 0x576e103eb5f35b8f, None),
    ("Nandinagari", 1, 0x11b2d54e82e74208, None),
    ("Nd", 1, 0xa8dafe9349a8f6d6, None),
    ("New_Tai_Lue", 1, 0xd9b0708f5e87c5ea, None),
    ("Newa", 1, 0x4a7e86ab0bbaa56b, None),
    ("Nko", 1, 0x3bdaa7846895008f, None),
    ("Nl", 1, 0x0478206a3d877092, None),
    ("No", 1, 0x6bda17ea57b3a764, None),
    ("Nushu", 1, 0xd5211db55d346130, None),
    ("Nyiakeng_Puachue_Hmong", 1, 0x39753191e16e5e3e, None),
    ("Ogham", 1, 0x592be153d6d190fe, None),
    ("Ol_Chiki", 1, 0xb572ac326205fe6c, None),
    ("Ol_Onal", 1, 0x264cb4ad9dbf7c8d, None),
    ("Old_Hungarian", 1, 0x313a288ea172da66, None),
    ("Old_Italic", 1, 0xa106b541d4dcd936, None),
    ("Old_North_Arabian", 1, 0xaaa9858801ca73e2, None),
    ("Old_Permic", 1, 0x4119c761c2e851a5, None),
    ("Old_Persian", 1, 0xfac20e6f2727c77d, None),
    ("Old_Sogdian", 1, 0x39cd395ea16377a0, None),
    ("Old_South_Arabian", 1, 0x9eba352c4e9707bd, None),
    ("Old_Turkic", 1, 0x1ee7fe3b9bfc6afa, None),
    ("Old_Uyghur", 1, 0x980721ad8f273883, None),
    ("Oriya", 1, 0xb102b00554556455, None),
    ("Osage", 1, 0x2646ad4616708a64, None),
    ("Osmanya", 1, 0x0e6a12dec557b319, None),
    ("P", 1, 0x2e328bd0ec12c351, None),
    ("Pahawh_Hmong", 1, 0xbb16e3f46d7ba187, None),
    ("Palmyrene", 1, 0x3497510d62f6d8d9, None),
    ("Pau_Cin_Hau", 1, 0xedad03210d3078dd, None),
    ("Pc", 1, 0x2567d47987eaaae3, None),
    ("Pd", 1, 0x439d0454557e169d, None),
    ("Pe", 1, 0x54e686f99f593420, None),
    ("Pf", 1, 0x709dc3a5c13dd16b, None),
    ("Phags_Pa", 1, 0x83d02ae9a40a4be1, None),
    ("Phoenician", 1, 0xe7cd0246279b6920, None),
    ("Pi", 1, 0xe9459ba47f50ecac, None),
    ("Po", 1, 0x16280217dc8fc616, None),
    ("Ps", 1, 0xbd5fe1d6592d401c, None),
    ("Psalter_Pahlavi", 1, 0x2bfc59e80a248411, None),
    ("Quotation_Mark", 1, 0xa804466047284f16, None),
    ("Rejang", 1, 0x16c79834a7c71cef, None),
    ("Runic", 1, 0x557f5157dfc6fa2c, None),
    ("S", 1, 0x234edaf92ccfbc2d, None),
    ("Samaritan", 1, 0x515657d2177c9eb4, None),
    ("Saurashtra", 1, 0x6c1cf8a2d2e99874, None),
    ("Sc", 1, 0xeb5b00160898c6d1, None),
    ("Sharada", 1, 0x40c976952b164bf1, None),
    ("Shavian", 1, 0xbc1aea929166b589, None),
    ("Siddham", 1, 0x1cd837970744f66f, None),
    ("Sidetic", 1, 0xd74c24aa37ecf745, None),
    ("SignWriting", 1, 0xfc9ac606c7ffc4e4, None),
    ("Sinhala", 1, 0xf4b20e494f591db6, None),
    ("Sk", 1, 0x37aa4b63cdec5474, None),
    ("Sm", 1, 0x01afb08a66839416, None),
    ("So", 1, 0x25f3015d3f7776b7, None),
    ("Sogdian", 1, 0xdc238338e34da2f7, None),
    ("Sora_Sompeng", 1, 0x2ed0f9d94413da8d, None),
    ("Soyombo", 1, 0xa6164e23a9830bf7, None),
    ("Sundanese", 1, 0x857ee132bc05f076, None),
    ("Sunuwar", 1, 0x32470ea8b60f88b3, None),
    ("Syloti_Nagri", 1, 0x3bd13cc97fbb083b, None),
    ("Syriac", 1, 0x40f7c399b112f77d, None),
    ("Tagalog", 1, 0x4760d6c3db9e527b, None),
    ("Tagbanwa", 1, 0xb47f0d8901c4653d, None),
    ("Tai_Le", 1, 0x2170b80f088d6f5d, None),
    ("Tai_Tham", 1, 0xf72c3d45b5bed03d, None),
    ("Tai_Viet", 1, 0x0d13bf10e14ebf04, None),
    ("Tai_Yo", 1, 0x5608ba8733da07af, None),
    ("Takri", 1, 0xeca989ac24182a50, None),
    ("Tamil", 1, 0xf85b821355f56243, None),
    ("Tangsa", 1, 0x3acb9b0dc0acfdda, None),
    ("Tangut", 1, 0x85ad67526357186a, None),
    ("Telugu", 1, 0x37dcc1dffbeed384, None),
    ("Terminal_Punctuation", 1, 0x6c0464c416302dc6, None),
    ("Thaana", 1, 0xc3d66bc41638d535, None),
    ("Thai", 1, 0xa5b57c3741d00d51, None),
    ("Tibetan", 1, 0xea4262bcfa1c5d1e, None),
    ("Tifinagh", 1, 0x6fca5769647303a5, None),
    ("Tirhuta", 1, 0x26c5fc4f8684c524, None),
    ("Todhri", 1, 0x2ca775ea854caa78, None),
    ("Tolong_Siki", 1, 0x6fe6033e1cf6d076, None),
    ("Toto", 1, 0x3a2c1256862c0e6b, None),
    ("Tulu_Tigalari", 1, 0x79a5122e4963c4f2, None),
    ("Ugaritic", 1, 0x38b903c17d4a5425, None),
    ("Unknown", 1, 0xb2b65e6b81d0175e, None),
    ("Uppercase", 1, 0x6eb4a32b4ad97183, Some(0x94a290f70a0f9be7)),
    ("Vai", 1, 0xa1ff9615c9e1923d, None),
    ("Vithkuqi", 1, 0xe50a7d5b01354eb4, None),
    ("Wancho", 1, 0x78c856b600d8267b, None),
    ("Warang_Citi", 1, 0x9827f18b89bb7210, None),
    ("White_Space", 1, 0xedf4955cb28a51d1, None),
    ("Yezidi", 1, 0xa424e937048b8950, None),
    ("Yi", 1, 0xa93a7675d4426807, None),
    ("Z", 1, 0x634b7a8996e414d2, None),
    ("Zanabazar_Square", 1, 0x727ffd3875bb9e19, None),
    ("Zl", 1, 0xd5e0f2e4571ec732, None),
    ("Zp", 1, 0x0f2d79e1cd074cf8, None),
    ("Zs", 1, 0xc1bd0065850c4664, None),
    ];

    fn fnv(text: &str) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in text.bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    fn ranges_text(table: Table) -> String {
        table.iter().map(|(lo, hi)| format!("{lo}-{hi},")).collect()
    }

    #[test]
    fn reads_unicode_17() {
        assert_eq!(UNICODE_VERSION, "17.0.0");
    }

    #[test]
    fn resolves_every_name_re2js_resolves_to_its_ranges() {
        for (name, sign, table, fold) in NODE_TABLES {
            let (ours, our_fold, our_sign) = unicode_table(name).unwrap_or_else(|| panic!("{name} names a table"));
            assert_eq!(our_sign, sign, "{name}");
            assert_eq!(fnv(&ranges_text(ours)), table, "{name}");
            assert_eq!(our_fold.map(|fold| fnv(&ranges_text(fold))), fold, "{name}");
        }
    }

    #[test]
    fn cases_and_folds_every_code_point_as_node_does() {
        let mut lower = String::new();
        let mut upper = String::new();
        let mut fold = String::new();
        let list = |mapping: &[u32]| mapping.iter().map(u32::to_string).collect::<Vec<_>>().join(" ");
        for code in (0..=MAX_RUNE).filter(|code| !(0xD800..=0xDFFF).contains(code)) {
            if let Some(mapped) = mapping(LOWERCASE_MAPPINGS, code) {
                lower.push_str(&format!("{code}:{},", list(mapped)));
            }
            if let Some(mapped) = mapping(UPPERCASE_MAPPINGS, code) {
                upper.push_str(&format!("{code}:{},", list(mapped)));
            }
            let folded = simple_fold(code);
            if folded != code {
                fold.push_str(&format!("{code}:{folded},"));
            }
        }
        assert_eq!(fnv(&lower), 0x1044feb26518e2a0, "V8's toLowerCase of each code point");
        assert_eq!(fnv(&upper), 0xb1746b4817299ab3, "V8's toUpperCase of each code point");
        assert_eq!(fnv(&fold), 0xdc62d8cdebc0487b, "re2js's Unicode.simpleFold of each code point");
        assert_eq!((MIN_FOLD, MAX_FOLD), (65, 125251));
    }
}
