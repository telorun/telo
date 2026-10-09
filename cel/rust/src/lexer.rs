//! CEL's tokens — `lexer.ts`.
//!
//! The lexer decodes literals as it reads them: a string token carries its text with
//! every escape resolved, a bytes token its bytes, an integer its magnitude. It stops
//! at the first thing it cannot read, reporting one diagnostic and ending the token
//! stream where that text begins, so the parser reads every token before it exactly as
//! it would read the source cut there.
//!
//! The readings that are deliberate are Node's, stated in `lexer.ts`: the bytes marker
//! comes first (`br` is raw bytes, `rb` a name beside a string); a raw literal lets a
//! backslash take the next character with it, except a line feed in a single-line
//! literal, which ends it; a bytes literal holds the UTF-8 of its text; a double may
//! begin with its point. One is recorded as interim: a carriage return is content in a
//! single-line literal and in a quoted member name.
//!
//! **Positions.** One cursor advances a byte offset and a UTF-16 code-unit offset
//! together; there is no position table and no rescan. Every range lies within the
//! source and splits no character: a character outside the basic plane is reported
//! over its two code units, and an escape is ranged as it is written — the backslash,
//! its marker and the digits actually there.
//!
//! **Where this file answers differently from Node:**
//! - A source of more than `MAX_SOURCE_UNITS` (4,294,967,285) UTF-16 code units is
//!   refused whole — `limit_exceeded`, range `[0, 0)` — so that every offset fits the
//!   `u32` a range holds. Node cannot hold such a source.
//!
//! Node items with no twin in this file:
//! - `MAX_INT`, `MIN_INT`, `MAX_UINT` — an int is an `i64` and a uint a `u64`, so the
//!   range is the type.
//! - `textOf`, the chunked code-unit-to-text helper — a string literal is decoded
//!   straight into a `String`.
//! - Every raw-lone-surrogate path: a lone surrogate written raw in a string or a
//!   bytes literal, which Node carries and no `&str` can deliver.
//!
//! Private, as on Node's entry: the tokenizer and its token.

use telorun_cel_value::json_quote;

use crate::reserved_words::{word_reading, WordReading};
use crate::syntax_diagnostic::{CelSyntaxCode, FirstSyntaxDiagnostic};

const SIMPLE_ESCAPE_UNITS: u32 = 2;
const HEX_ESCAPE_UNITS: u32 = 4;
const OCTAL_ESCAPE_UNITS: u32 = 4;
const SHORT_UNICODE_ESCAPE_UNITS: u32 = 6;
const LONG_UNICODE_ESCAPE_UNITS: u32 = 10;

/// The width of the widest escape, `\U` and eight digits.
const WIDEST_ESCAPE_UNITS: u32 = LONG_UNICODE_ESCAPE_UNITS;

/// The longest source read, in UTF-16 code units: `u32::MAX` less the widest escape.
/// No offset the front end computes exceeds the source's length, so each fits a `u32`.
const MAX_SOURCE_UNITS: u32 = 4_294_967_285;

const _: () = {
    assert!(MAX_SOURCE_UNITS as u64 + WIDEST_ESCAPE_UNITS as u64 == u32::MAX as u64);
    assert!(SIMPLE_ESCAPE_UNITS <= WIDEST_ESCAPE_UNITS);
    assert!(HEX_ESCAPE_UNITS <= WIDEST_ESCAPE_UNITS);
    assert!(OCTAL_ESCAPE_UNITS <= WIDEST_ESCAPE_UNITS);
    assert!(SHORT_UNICODE_ESCAPE_UNITS <= WIDEST_ESCAPE_UNITS);
    assert!(LONG_UNICODE_ESCAPE_UNITS <= WIDEST_ESCAPE_UNITS);
};

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum TokenKind {
    /// A name, and a word read as a literal (`true`, `false`, `null`).
    Ident,
    /// A member name written between backticks, whatever it spells.
    QuotedIdent,
    /// A reserved word with no other reading: refused wherever a name is read.
    Reserved,
    /// An operator written as a word (`in`).
    Keyword,
    /// `at_boundary` marks a magnitude of exactly 2^63 — legal only directly under a
    /// unary minus, which is how the int64 minimum is written.
    Int { magnitude: u64, at_boundary: bool },
    Uint(u64),
    Double(f64),
    String,
    Bytes,
    Punct(&'static str),
    Eof,
}

/// What a string or bytes token decoded to.
pub(crate) enum Decoded {
    Nothing,
    Text(String),
    Bytes(Vec<u8>),
}

pub(crate) struct Token {
    pub(crate) kind: TokenKind,
    /// The token's span in UTF-16 code units.
    pub(crate) start: u32,
    pub(crate) end: u32,
    /// The token's span in bytes of the source, for reading its text.
    pub(crate) byte_start: usize,
    pub(crate) byte_end: usize,
    pub(crate) decoded: Decoded,
}

/// One position in the source, counted both ways.
#[derive(Clone, Copy)]
struct Cursor {
    byte: usize,
    unit: u32,
}

impl Cursor {
    /// Past `count` ASCII characters.
    fn ahead(self, count: u32) -> Cursor {
        Cursor { byte: self.byte + count as usize, unit: self.unit + count }
    }
}

fn is_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

fn is_octal_digit(byte: u8) -> bool {
    (b'0'..=b'7').contains(&byte)
}

fn is_ident_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic()
}

fn is_ident_part(byte: u8) -> bool {
    is_ident_start(byte) || byte.is_ascii_digit()
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0c | 0x0b)
}

fn simple_escape(byte: u8) -> Option<u8> {
    Some(match byte {
        b'\\' => 0x5c,
        b'\'' => 0x27,
        b'"' => 0x22,
        b'`' => 0x60,
        b'?' => 0x3f,
        b'a' => 0x07,
        b'b' => 0x08,
        b'f' => 0x0c,
        b'n' => 0x0a,
        b'r' => 0x0d,
        b't' => 0x09,
        b'v' => 0x0b,
        _ => return None,
    })
}

fn punctuation_pair(pair: &[u8]) -> Option<&'static str> {
    Some(match pair {
        b"==" => "==",
        b"!=" => "!=",
        b"<=" => "<=",
        b">=" => ">=",
        b"&&" => "&&",
        b"||" => "||",
        _ => return None,
    })
}

fn punctuation(byte: u8) -> Option<&'static str> {
    Some(match byte {
        b'<' => "<",
        b'>' => ">",
        b'(' => "(",
        b')' => ")",
        b'[' => "[",
        b']' => "]",
        b'{' => "{",
        b'}' => "}",
        b'.' => ".",
        b',' => ",",
        b':' => ":",
        b'?' => "?",
        b'!' => "!",
        b'+' => "+",
        b'-' => "-",
        b'*' => "*",
        b'/' => "/",
        b'%' => "%",
        _ => return None,
    })
}

/// What a word before a quote makes of the literal: `(raw, bytes)`. cel-spec nests the
/// two markers with the bytes marker first, so `rb'…'` is not a literal at all.
fn string_prefix(text: &str) -> Option<(bool, bool)> {
    if text.eq_ignore_ascii_case("r") {
        Some((true, false))
    } else if text.eq_ignore_ascii_case("b") {
        Some((false, true))
    } else if text.eq_ignore_ascii_case("br") {
        Some((true, true))
    } else {
        None
    }
}

/// What a literal holds of its text: characters in a string, bytes in a bytes literal.
enum LiteralContent {
    Text(String),
    Bytes(Vec<u8>),
}

impl LiteralContent {
    /// One character as the source writes it: itself in a string, its UTF-8 in bytes.
    fn push_written(&mut self, written: char) {
        match self {
            Self::Text(text) => text.push(written),
            Self::Bytes(bytes) => bytes.extend_from_slice(written.encode_utf8(&mut [0; 4]).as_bytes()),
        }
    }

    /// What an escape names below 256: that code point in a string, that byte in bytes.
    fn push_named(&mut self, value: u8) {
        match self {
            Self::Text(text) => text.push(char::from(value)),
            Self::Bytes(bytes) => bytes.push(value),
        }
    }
}

fn token(kind: TokenKind, start: Cursor, end: Cursor) -> Token {
    Token { kind, start: start.unit, end: end.unit, byte_start: start.byte, byte_end: end.byte, decoded: Decoded::Nothing }
}

struct Lexer<'s> {
    source: &'s str,
    bytes: &'s [u8],
    at: Cursor,
    diagnostics: FirstSyntaxDiagnostic,
}

impl<'s> Lexer<'s> {
    fn new(source: &'s str, at: Cursor) -> Self {
        Lexer { source, bytes: source.as_bytes(), at, diagnostics: FirstSyntaxDiagnostic::default() }
    }

    /// Every token up to the end of the source, or up to the first unreadable text.
    fn tokenize(mut self) -> (Vec<Token>, FirstSyntaxDiagnostic) {
        let mut tokens = Vec::new();
        loop {
            self.skip_ignored();
            let start = self.at;
            let read = if start.byte < self.bytes.len() { self.next() } else { None };
            match read {
                Some(read) => tokens.push(read),
                None => {
                    // The stream ends where the unreadable text begins, as the cut source would.
                    tokens.push(token(TokenKind::Eof, start, start));
                    return (tokens, self.diagnostics);
                }
            }
        }
    }

    fn byte_at(&self, byte: usize) -> Option<u8> {
        self.bytes.get(byte).copied()
    }

    /// The position past the whole character at `at`, and the character.
    fn past_character(&self, at: Cursor) -> (Cursor, char) {
        let character = self.source[at.byte..].chars().next().expect("the cursor is before the end of the source");
        (Cursor { byte: at.byte + character.len_utf8(), unit: at.unit + character.len_utf16() as u32 }, character)
    }

    fn skip_ignored(&mut self) {
        while let Some(byte) = self.byte_at(self.at.byte) {
            if is_space(byte) {
                self.at = self.at.ahead(1);
            } else if byte == b'/' && self.byte_at(self.at.byte + 1) == Some(b'/') {
                while self.byte_at(self.at.byte).is_some_and(|byte| byte != b'\n') {
                    self.at = self.past_character(self.at).0;
                }
            } else {
                return;
            }
        }
    }

    fn next(&mut self) -> Option<Token> {
        let start = self.at;
        let byte = self.bytes[start.byte];
        if byte == b'\'' || byte == b'"' {
            return self.read_quoted(start, start, false, false);
        }
        if is_ident_start(byte) {
            return self.read_word(start);
        }
        if byte.is_ascii_digit() {
            return self.read_number(start);
        }
        // A double may begin with its point: cel-spec's FLOAT_LIT is `DIGIT* . DIGIT+`.
        if byte == b'.' && self.byte_at(start.byte + 1).is_some_and(|next| next.is_ascii_digit()) {
            return self.read_number(start);
        }
        if byte == b'`' {
            return self.read_quoted_identifier(start);
        }
        self.read_punctuation(start, byte)
    }

    fn read_punctuation(&mut self, start: Cursor, byte: u8) -> Option<Token> {
        let pair = self.bytes.get(start.byte..start.byte + 2).and_then(punctuation_pair);
        if let Some(text) = pair.or_else(|| punctuation(byte)) {
            self.at = start.ahead(text.len() as u32);
            return Some(token(TokenKind::Punct(text), start, self.at));
        }
        let (past, character) = self.past_character(start);
        self.diagnostics.report(
            CelSyntaxCode::UnexpectedCharacter,
            format!("unexpected character {}", json_quote(character.encode_utf8(&mut [0; 4]))),
            start.unit,
            past.unit,
        );
        None
    }

    /// A member name between backticks. It takes no escapes and cannot hold a backtick,
    /// so the text between them is the name as written.
    fn read_quoted_identifier(&mut self, start: Cursor) -> Option<Token> {
        let mut at = start.ahead(1);
        let mut holds_line_feed = false;
        while let Some(byte) = self.byte_at(at.byte) {
            if byte == b'`' {
                break;
            }
            holds_line_feed |= byte == b'\n';
            at = self.past_character(at).0;
        }
        if at.byte >= self.bytes.len() || holds_line_feed {
            self.diagnostics.report(
                CelSyntaxCode::UnterminatedString,
                "a quoted member name ends at its closing backtick",
                start.unit,
                at.unit,
            );
            return None;
        }
        self.at = at.ahead(1);
        Some(token(TokenKind::QuotedIdent, start, self.at))
    }

    /// An identifier, a literal word, or the prefix of a string literal.
    fn read_word(&mut self, start: Cursor) -> Option<Token> {
        let mut at = start;
        while self.byte_at(at.byte).is_some_and(is_ident_part) {
            at = at.ahead(1);
        }
        let text = &self.source[start.byte..at.byte];
        if let Some((raw, bytes)) = string_prefix(text) {
            if matches!(self.byte_at(at.byte), Some(b'\'' | b'"')) {
                return self.read_quoted(start, at, raw, bytes);
            }
        }
        self.at = at;
        let kind = match word_reading(text) {
            WordReading::Operator => TokenKind::Keyword,
            WordReading::Refused => TokenKind::Reserved,
            WordReading::Name | WordReading::Literal => TokenKind::Ident,
        };
        Some(token(kind, start, at))
    }

    fn read_number(&mut self, start: Cursor) -> Option<Token> {
        let bytes = self.bytes;
        let digit_at = |at: usize| bytes.get(at).is_some_and(|byte| byte.is_ascii_digit());
        // A number is ASCII, so a position inside one is its distance from the start.
        let cursor = |at: usize| start.ahead((at - start.byte) as u32);
        let mut at = start.byte;
        let mut double = false;
        let hexadecimal = bytes[at] == b'0' && matches!(bytes.get(at + 1), Some(b'x' | b'X'));
        let from;
        if hexadecimal {
            at += 2;
            from = at;
            while bytes.get(at).is_some_and(|byte| is_hex_digit(*byte)) {
                at += 1;
            }
            if at == from {
                return self.invalid_number(start, cursor(at));
            }
        } else {
            from = at;
            while digit_at(at) {
                at += 1;
            }
            if bytes.get(at) == Some(&b'.') && digit_at(at + 1) {
                double = true;
                at += 1;
                while digit_at(at) {
                    at += 1;
                }
            }
            if matches!(bytes.get(at), Some(b'e' | b'E')) {
                let mut exponent = at + 1;
                if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
                    exponent += 1;
                }
                if digit_at(exponent) {
                    double = true;
                    at = exponent;
                    while digit_at(at) {
                        at += 1;
                    }
                }
            }
        }
        let digits = &self.source[from..at];

        let unsigned = matches!(bytes.get(at), Some(b'u' | b'U'));
        if unsigned {
            at += 1;
        }
        if bytes.get(at).is_some_and(|byte| is_ident_part(*byte)) {
            return self.invalid_number(start, cursor(at));
        }

        let end = cursor(at);
        self.at = end;
        if double {
            if unsigned {
                return self.invalid_number(start, end);
            }
            // The standard parse is correctly rounded, as `Number(digits)` is in every
            // engine Node runs on; it overflows to infinity and underflows to zero.
            let value: f64 = digits.parse().expect("the digits of a double literal are a decimal number");
            return Some(token(TokenKind::Double(value), start, end));
        }

        // The magnitude with a flag for one that 64 bits cannot hold: leading zeros
        // never overflow, and no digit count is a limit.
        let radix = if hexadecimal { 16 } else { 10 };
        let magnitude = digits.bytes().try_fold(0u64, |magnitude, digit| {
            let digit = char::from(digit).to_digit(radix).expect("the digits of an integer literal are in its radix");
            magnitude.checked_mul(u64::from(radix))?.checked_add(u64::from(digit))
        });
        let text = &self.source[start.byte..at];
        const INT_BOUNDARY: u64 = 1 << 63;
        if unsigned {
            let Some(magnitude) = magnitude else {
                self.diagnostics.report(
                    CelSyntaxCode::InvalidUnsignedInteger,
                    format!("{text} is outside the range of an unsigned 64-bit integer"),
                    start.unit,
                    end.unit,
                );
                return None;
            };
            return Some(token(TokenKind::Uint(magnitude), start, end));
        }
        match magnitude {
            Some(magnitude) if magnitude <= INT_BOUNDARY => {
                Some(token(TokenKind::Int { magnitude, at_boundary: magnitude == INT_BOUNDARY }, start, end))
            }
            _ => {
                self.diagnostics.report(
                    CelSyntaxCode::InvalidInteger,
                    format!("{text} is outside the range of a 64-bit integer"),
                    start.unit,
                    end.unit,
                );
                None
            }
        }
    }

    fn invalid_number(&mut self, start: Cursor, at: Cursor) -> Option<Token> {
        let mut end = at;
        while self.byte_at(end.byte).is_some_and(is_ident_part) {
            end = end.ahead(1);
        }
        self.diagnostics.report(
            CelSyntaxCode::InvalidNumber,
            format!("{} is not a number", &self.source[start.byte..end.byte]),
            start.unit,
            end.unit,
        );
        None
    }

    /// A string or bytes literal. `start` is the literal's own start (its prefix, when
    /// it has one) and `quote_at` the opening quote.
    fn read_quoted(&mut self, start: Cursor, quote_at: Cursor, raw: bool, bytes: bool) -> Option<Token> {
        let quote = self.bytes[quote_at.byte];
        let triple = self.bytes[quote_at.byte..].starts_with(&[quote; 3]);
        let terminator = if triple { vec![quote; 3] } else { vec![quote] };
        let mut content = if bytes { LiteralContent::Bytes(Vec::new()) } else { LiteralContent::Text(String::new()) };
        let end = self.scan_literal(quote_at, &terminator, triple, raw, &mut content)?;
        self.at = end;
        let mut token = token(if bytes { TokenKind::Bytes } else { TokenKind::String }, start, end);
        token.decoded = match content {
            LiteralContent::Text(text) => Decoded::Text(text),
            LiteralContent::Bytes(bytes) => Decoded::Bytes(bytes),
        };
        Some(token)
    }

    /// Decodes a literal's content, answering where the literal ends. A raw literal
    /// reads no escape: a backslash takes the next character with it, both kept as
    /// written — except a line feed in a single-line literal, which ends it.
    fn scan_literal(
        &mut self,
        quote_at: Cursor,
        terminator: &[u8],
        triple: bool,
        raw: bool,
        content: &mut LiteralContent,
    ) -> Option<Cursor> {
        let width = terminator.len() as u32;
        let mut at = quote_at.ahead(width);
        while let Some(byte) = self.byte_at(at.byte) {
            if self.bytes[at.byte..].starts_with(terminator) {
                return Some(at.ahead(width));
            }
            if !triple && byte == b'\n' {
                break;
            }
            if byte != b'\\' {
                at = self.literal_character(at, content);
            } else if !raw {
                at = self.read_escape(at, content)?;
            } else if self.byte_at(at.byte + 1).is_some_and(|next| triple || next != b'\n') {
                content.push_named(0x5c);
                at = self.literal_character(at.ahead(1), content);
            } else {
                at = self.literal_character(at, content);
            }
        }
        self.diagnostics.report(CelSyntaxCode::UnterminatedString, "unterminated string", quote_at.unit, at.unit);
        None
    }

    /// One character of a literal's text, as the literal holds it.
    fn literal_character(&self, at: Cursor, content: &mut LiteralContent) -> Cursor {
        let (past, character) = self.past_character(at);
        content.push_written(character);
        past
    }

    /// Decodes one escape sequence onto `content`, answering where it ends.
    fn read_escape(&mut self, at: Cursor, content: &mut LiteralContent) -> Option<Cursor> {
        let Some(byte) = self.byte_at(at.byte + 1) else {
            self.diagnostics.report(
                CelSyntaxCode::InvalidEscapeSequence,
                "the escape has no character",
                at.unit,
                at.unit + 1,
            );
            return None;
        };
        if let Some(simple) = simple_escape(byte) {
            content.push_named(simple);
            return Some(at.ahead(SIMPLE_ESCAPE_UNITS));
        }
        match byte {
            b'x' | b'X' => self.read_hex_escape(at, content),
            b'u' | b'U' => {
                if matches!(content, LiteralContent::Bytes(_)) {
                    self.diagnostics.report(
                        CelSyntaxCode::BytesUnicodeEscape,
                        format!(
                            "\\{} names text, which a bytes literal cannot hold — write the bytes with \\x",
                            char::from(byte)
                        ),
                        at.unit,
                        at.unit + 2,
                    );
                    return None;
                }
                let width = if byte == b'u' { SHORT_UNICODE_ESCAPE_UNITS } else { LONG_UNICODE_ESCAPE_UNITS };
                self.read_unicode_escape(at, width, content)
            }
            byte if is_octal_digit(byte) => self.read_octal_escape(at, content),
            _ => {
                let (past, character) = self.past_character(at.ahead(1));
                self.diagnostics.report(
                    CelSyntaxCode::InvalidEscapeSequence,
                    format!("\\{character} is not an escape sequence"),
                    at.unit,
                    past.unit,
                );
                None
            }
        }
    }

    /// The `count` digits from `from`, when the source holds that many and `admits`
    /// each.
    fn escape_digits(&self, from: usize, count: usize, admits: fn(u8) -> bool) -> Option<&'s str> {
        let digits = self.bytes.get(from..from + count)?;
        digits.iter().all(|byte| admits(*byte)).then(|| &self.source[from..from + count])
    }

    /// Where an escape that is short of its digits ends as written: past the run
    /// `admits` takes after its `opening` units.
    fn written_end(&self, at: Cursor, opening: u32, admits: fn(u8) -> bool) -> u32 {
        let mut end = at.ahead(opening);
        while self.byte_at(end.byte).is_some_and(admits) {
            end = end.ahead(1);
        }
        end.unit
    }

    fn read_hex_escape(&mut self, at: Cursor, content: &mut LiteralContent) -> Option<Cursor> {
        let Some(digits) = self.escape_digits(at.byte + 2, 2, is_hex_digit) else {
            self.diagnostics.report(
                CelSyntaxCode::InvalidHexEscape,
                "a \\x escape takes two hexadecimal digits",
                at.unit,
                self.written_end(at, 2, is_hex_digit),
            );
            return None;
        };
        content.push_named(u8::from_str_radix(digits, 16).expect("two hexadecimal digits are a byte"));
        Some(at.ahead(HEX_ESCAPE_UNITS))
    }

    fn read_octal_escape(&mut self, at: Cursor, content: &mut LiteralContent) -> Option<Cursor> {
        let end = at.unit + OCTAL_ESCAPE_UNITS;
        let Some(digits) = self.escape_digits(at.byte + 1, 3, is_octal_digit) else {
            self.diagnostics.report(
                CelSyntaxCode::InvalidOctalEscape,
                "an octal escape takes three octal digits",
                at.unit,
                self.written_end(at, 1, is_octal_digit),
            );
            return None;
        };
        let value = u32::from_str_radix(digits, 8).expect("three octal digits are a number");
        let Ok(value) = u8::try_from(value) else {
            self.diagnostics.report(
                CelSyntaxCode::OctalEscapeOutOfRange,
                format!("\\{digits} is above 255"),
                at.unit,
                end,
            );
            return None;
        };
        content.push_named(value);
        Some(at.ahead(OCTAL_ESCAPE_UNITS))
    }

    /// `width` is the whole escape's: the backslash, the letter and its digits.
    fn read_unicode_escape(&mut self, at: Cursor, width: u32, content: &mut LiteralContent) -> Option<Cursor> {
        let count = width as usize - 2;
        let Some(digits) = self.escape_digits(at.byte + 2, count, is_hex_digit) else {
            let letter = if width == SHORT_UNICODE_ESCAPE_UNITS { 'u' } else { 'U' };
            self.diagnostics.report(
                CelSyntaxCode::InvalidUnicodeEscape,
                format!("a \\{letter} escape takes {count} hexadecimal digits"),
                at.unit,
                self.written_end(at, 2, is_hex_digit),
            );
            return None;
        };
        let end = at.ahead(width);
        let point = u32::from_str_radix(digits, 16).expect("eight hexadecimal digits fit 32 bits");
        if point > 0x10ffff {
            self.diagnostics.report(
                CelSyntaxCode::InvalidUnicodeEscape,
                format!("U+{digits} is not a code point"),
                at.unit,
                end.unit,
            );
            return None;
        }
        if (0xdc00..=0xdfff).contains(&point) {
            self.diagnostics.report(
                CelSyntaxCode::InvalidUnicodeSurrogate,
                format!("U+{digits} is a trailing surrogate"),
                at.unit,
                end.unit,
            );
            return None;
        }
        if (0xd800..=0xdbff).contains(&point) {
            return self.read_surrogate_pair(at, end, point, content);
        }
        content.push_written(char::from_u32(point).expect("a code point outside the surrogates is a character"));
        Some(end)
    }

    /// A leading surrogate stands only beside the trailing one that completes it.
    fn read_surrogate_pair(&mut self, at: Cursor, end: Cursor, lead: u32, content: &mut LiteralContent) -> Option<Cursor> {
        let trail = self
            .bytes
            .get(end.byte..end.byte + 2)
            .filter(|opening| *opening == b"\\u")
            .and_then(|_| self.escape_digits(end.byte + 2, 4, is_hex_digit))
            .map(|digits| u32::from_str_radix(digits, 16).expect("four hexadecimal digits fit 32 bits"))
            .filter(|trail| (0xdc00..=0xdfff).contains(trail));
        let Some(trail) = trail else {
            self.diagnostics.report(
                CelSyntaxCode::InvalidUnicodeSurrogate,
                "a leading surrogate must be followed by a trailing surrogate escape",
                at.unit,
                end.unit,
            );
            return None;
        };
        let point = 0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00);
        content.push_written(char::from_u32(point).expect("a surrogate pair names a character"));
        Some(end.ahead(SHORT_UNICODE_ESCAPE_UNITS))
    }
}

fn exceeds_source_bound(units: u64) -> bool {
    units > u64::from(MAX_SOURCE_UNITS)
}

/// What a source past the bound reads as: nothing, refused at its start.
fn refuse_over_long() -> (Vec<Token>, FirstSyntaxDiagnostic) {
    let start = Cursor { byte: 0, unit: 0 };
    let mut diagnostics = FirstSyntaxDiagnostic::default();
    diagnostics.report(
        CelSyntaxCode::LimitExceeded,
        format!("the expression has more UTF-16 code units than the limit of {MAX_SOURCE_UNITS}"),
        0,
        0,
    );
    (vec![token(TokenKind::Eof, start, start)], diagnostics)
}

/// Every token of the source, with at most one diagnostic for where it stopped.
pub(crate) fn tokenize(source: &str) -> (Vec<Token>, FirstSyntaxDiagnostic) {
    // A source has no more code units than bytes, so only a long one is counted.
    let over_long = source.len() as u64 > u64::from(MAX_SOURCE_UNITS)
        && exceeds_source_bound(source.chars().map(|character| character.len_utf16() as u64).sum());
    if over_long {
        return refuse_over_long();
    }
    Lexer::new(source, Cursor { byte: 0, unit: 0 }).tokenize()
}

#[cfg(test)]
mod tests {
    //! The source bound, proven on the counters: a source of 4 GiB is not a fixture.
    //!
    //! The refusal and its number are this crate's own answer; Node cannot hold such a
    //! source. Each tail's range is the Node build's executed answer for the tail read
    //! alone (`@telorun/cel` 0.112.0, this branch's build, by the procedure the README's
    //! Tests section states), moved by where the tail starts.

    use super::*;

    /// `(tail, the range Node answers for the tail as a whole source)`.
    const NODE_TAILS: [(&str, [u32; 2]); 4] = [
        ("\"\\x", [1, 3]),
        ("\"\\0", [1, 3]),
        ("\"\\u", [1, 3]),
        ("\"\\U", [1, 3]),
    ];

    #[test]
    fn ranges_a_tail_ending_in_each_escape_form_within_the_longest_source() {
        for (tail, [start, end]) in NODE_TAILS {
            let offset = MAX_SOURCE_UNITS - tail.len() as u32;
            let (tokens, diagnostics) = Lexer::new(tail, Cursor { byte: 0, unit: offset }).tokenize();
            assert_eq!(tokens.len(), 1, "{tail}");
            let diagnostic = diagnostics.first().expect(tail);
            assert_eq!([diagnostic.range.start, diagnostic.range.end], [offset + start, offset + end], "{tail}");
            assert_eq!(diagnostic.range.end, MAX_SOURCE_UNITS, "{tail}");
        }
    }

    #[test]
    fn accepts_a_source_of_exactly_the_bound_and_refuses_one_unit_more() {
        assert!(!exceeds_source_bound(4_294_967_285));
        assert!(exceeds_source_bound(4_294_967_286));
        let (tokens, diagnostics) = refuse_over_long();
        assert!(matches!(tokens.as_slice(), [Token { kind: TokenKind::Eof, start: 0, end: 0, .. }]));
        let diagnostic = diagnostics.first().expect("the refusal");
        assert_eq!(diagnostic.code, CelSyntaxCode::LimitExceeded);
        assert_eq!(diagnostic.message, "the expression has more UTF-16 code units than the limit of 4294967285");
        assert_eq!([diagnostic.range.start, diagnostic.range.end], [0, 0]);
    }
}
