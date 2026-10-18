//! Where a text stops being a prefix of any RFC 8259 JSON text — `json-text-scan.ts`.
//!
//! On Node the host's `JSON.parse` decides whether a text is JSON and this scan only
//! words the refusal. Here the scan is the verdict too: [`read_json_text`] reads a text
//! only once [`scan_json_prefix`] has accepted it, so acceptance and the refusal's offset
//! are one computation. Both run on heap state, so nesting is bounded by memory.
//!
//! Node items with no twin in this file: `SIMPLE_ESCAPES` — the scan tests the escape
//! letters where it reads one.
//!
//! Declared here and not in the Node file:
//! - [`read_json_text`] and [`JsonTextError`] — the reader Node gets from its host.
//!   `JSON.parse` accepts an escape that names an unpaired surrogate; no Rust string
//!   holds one, so the reader refuses it, at the escape's backslash.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::PropertyMap;

use crate::json_value::JsonValue;

/// Where a text stops being JSON, in UTF-16 code units: the first offending unit, or
/// the text's length when every prefix is viable and the text is merely incomplete.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct JsonRefusal {
    pub offset: usize,
    pub end_of_input: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ScanState {
    Value,
    ValueOrClose,
    Key,
    KeyOrClose,
    After,
}

const QUOTE: u16 = 0x22;
const BACKSLASH: u16 = 0x5c;

fn unit_is(units: &[u16], at: usize, expected: u8) -> bool {
    units.get(at) == Some(&(expected as u16))
}

fn is_whitespace(unit: Option<&u16>) -> bool {
    matches!(unit, Some(0x20 | 0x09 | 0x0a | 0x0d))
}

fn is_digit(unit: Option<&u16>) -> bool {
    matches!(unit, Some(unit) if (0x30..=0x39).contains(unit))
}

fn is_hex_digit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66)
}

struct Scanner<'a> {
    units: &'a [u16],
    at: usize,
}

impl Scanner<'_> {
    fn peek(&self) -> Option<&u16> {
        self.units.get(self.at)
    }

    fn skip_whitespace(&mut self) {
        while is_whitespace(self.peek()) {
            self.at += 1;
        }
    }

    // Each token reader answers the offset it refuses, or nothing once past the token.

    fn read_string(&mut self) -> Option<usize> {
        let length = self.units.len();
        self.at += 1;
        loop {
            let Some(&code) = self.peek() else { return Some(length) };
            if code == QUOTE {
                self.at += 1;
                return None;
            }
            if code < 0x20 {
                return Some(self.at);
            }
            self.at += 1;
            if code != BACKSLASH {
                continue;
            }
            let Some(&escape) = self.peek() else { return Some(length) };
            if escape == b'u' as u16 {
                self.at += 1;
                for _ in 0..4 {
                    let Some(&digit) = self.peek() else { return Some(length) };
                    if !is_hex_digit(digit) {
                        return Some(self.at);
                    }
                    self.at += 1;
                }
            } else if b"\"\\/bfnrt".iter().any(|simple| *simple as u16 == escape) {
                self.at += 1;
            } else {
                return Some(self.at);
            }
        }
    }

    fn read_digits(&mut self) -> Option<usize> {
        if !is_digit(self.peek()) {
            return Some(self.at);
        }
        while is_digit(self.peek()) {
            self.at += 1;
        }
        None
    }

    fn read_number(&mut self) -> Option<usize> {
        if unit_is(self.units, self.at, b'-') {
            self.at += 1;
        }
        if unit_is(self.units, self.at, b'0') {
            self.at += 1;
        } else if let Some(refused) = self.read_digits() {
            return Some(refused);
        }
        if unit_is(self.units, self.at, b'.') {
            self.at += 1;
            if let Some(refused) = self.read_digits() {
                return Some(refused);
            }
        }
        if unit_is(self.units, self.at, b'e') || unit_is(self.units, self.at, b'E') {
            self.at += 1;
            if unit_is(self.units, self.at, b'+') || unit_is(self.units, self.at, b'-') {
                self.at += 1;
            }
            return self.read_digits();
        }
        None
    }

    fn read_literal(&mut self, literal: &str) -> Option<usize> {
        for expected in literal.bytes() {
            if !unit_is(self.units, self.at, expected) {
                return Some(self.at);
            }
            self.at += 1;
        }
        None
    }
}

fn scan_units(units: &[u16]) -> Option<JsonRefusal> {
    let length = units.len();
    let refused_at = |offset: usize| Some(JsonRefusal { offset, end_of_input: offset >= length });
    let mut scanner = Scanner { units, at: 0 };
    let mut open: Vec<u8> = Vec::new();
    let mut state = ScanState::Value;
    loop {
        scanner.skip_whitespace();
        let c = scanner.peek().copied();
        let is = |expected: u8| c == Some(expected as u16);

        if state == ScanState::After {
            let Some(&container) = open.last() else {
                return if scanner.at == length { None } else { refused_at(scanner.at) };
            };
            if is(b',') {
                scanner.at += 1;
                state = if container == b'{' { ScanState::Key } else { ScanState::Value };
            } else if is(if container == b'{' { b'}' } else { b']' }) {
                scanner.at += 1;
                open.pop();
            } else {
                return refused_at(scanner.at);
            }
            continue;
        }

        if state == ScanState::Key || state == ScanState::KeyOrClose {
            if state == ScanState::KeyOrClose && is(b'}') {
                scanner.at += 1;
                open.pop();
                state = ScanState::After;
                continue;
            }
            if !is(b'"') {
                return refused_at(scanner.at);
            }
            if let Some(refused) = scanner.read_string() {
                return refused_at(refused);
            }
            scanner.skip_whitespace();
            if !unit_is(units, scanner.at, b':') {
                return refused_at(scanner.at);
            }
            scanner.at += 1;
            state = ScanState::Value;
            continue;
        }

        if state == ScanState::ValueOrClose && is(b']') {
            scanner.at += 1;
            open.pop();
            state = ScanState::After;
            continue;
        }
        if is(b'{') || is(b'[') {
            scanner.at += 1;
            let opened = if is(b'{') { b'{' } else { b'[' };
            open.push(opened);
            state = if opened == b'{' { ScanState::KeyOrClose } else { ScanState::ValueOrClose };
            continue;
        }
        let refused = if is(b'"') {
            scanner.read_string()
        } else if is(b'-') || is_digit(c.as_ref()) {
            scanner.read_number()
        } else if is(b't') {
            scanner.read_literal("true")
        } else if is(b'f') {
            scanner.read_literal("false")
        } else if is(b'n') {
            scanner.read_literal("null")
        } else {
            Some(scanner.at)
        };
        if let Some(refused) = refused {
            return refused_at(refused);
        }
        state = ScanState::After;
    }
}

/// The refusal of `text`, or nothing when it is a JSON text — neither stricter nor
/// laxer than RFC 8259.
pub fn scan_json_prefix(text: &str) -> Option<JsonRefusal> {
    scan_units(&text.encode_utf16().collect::<Vec<u16>>())
}

/// Why a text was not read as a JSON value.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JsonTextError {
    /// The text is not JSON; the refusal is [`scan_json_prefix`]'s.
    NotJson(JsonRefusal),
    /// A `\u` escape names a surrogate with no partner. `offset` is the escape's
    /// backslash, in UTF-16 code units.
    UnpairedSurrogate { offset: usize },
}

impl fmt::Display for JsonTextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JsonTextError::NotJson(refusal) if refusal.end_of_input => {
                write!(f, "the text ends where JSON continues, at offset {}", refusal.offset)
            }
            JsonTextError::NotJson(refusal) => write!(f, "the text is not JSON at offset {}", refusal.offset),
            JsonTextError::UnpairedSurrogate { offset } => {
                write!(f, "the escape at offset {offset} names a surrogate with no partner")
            }
        }
    }
}

impl std::error::Error for JsonTextError {}

/// A container being read: its entries so far, and the key an object's next value takes.
enum Open {
    Array(Vec<Arc<JsonValue>>),
    Object(PropertyMap<Arc<JsonValue>>, Option<String>),
}

struct Reader<'a> {
    units: &'a [u16],
    at: usize,
}

fn hex_value(units: &[u16]) -> u16 {
    units.iter().fold(0, |value, unit| {
        let digit = match *unit {
            0x30..=0x39 => unit - 0x30,
            0x41..=0x46 => unit - 0x41 + 10,
            _ => unit - 0x61 + 10,
        };
        value * 16 + digit
    })
}

impl Reader<'_> {
    fn skip_whitespace(&mut self) {
        while is_whitespace(self.units.get(self.at)) {
            self.at += 1;
        }
    }

    /// A string the scan accepted, its opening quote at `at`.
    fn string(&mut self) -> Result<String, JsonTextError> {
        self.at += 1;
        let mut text: Vec<u16> = Vec::new();
        loop {
            let unit = self.units[self.at];
            if unit == QUOTE {
                self.at += 1;
                break;
            }
            if unit != BACKSLASH {
                text.push(unit);
                self.at += 1;
                continue;
            }
            let backslash = self.at;
            let escape = self.units[self.at + 1];
            self.at += 2;
            let decoded = match escape {
                0x62 => 0x08,
                0x66 => 0x0c,
                0x6e => 0x0a,
                0x72 => 0x0d,
                0x74 => 0x09,
                0x75 => {
                    let value = hex_value(&self.units[self.at..self.at + 4]);
                    self.at += 4;
                    value
                }
                other => other,
            };
            match decoded {
                0xd800..=0xdbff => {
                    let next = &self.units[self.at..self.units.len().min(self.at + 6)];
                    let low = (next.len() == 6 && next[0] == BACKSLASH && next[1] == b'u' as u16)
                        .then(|| hex_value(&next[2..6]))
                        .filter(|low| (0xdc00..=0xdfff).contains(low));
                    let Some(low) = low else { return Err(JsonTextError::UnpairedSurrogate { offset: backslash }) };
                    text.push(decoded);
                    text.push(low);
                    self.at += 6;
                }
                0xdc00..=0xdfff => return Err(JsonTextError::UnpairedSurrogate { offset: backslash }),
                _ => text.push(decoded),
            }
        }
        Ok(String::from_utf16(&text).expect("every surrogate is paired"))
    }

    fn number(&mut self) -> f64 {
        let from = self.at;
        while self.units.get(self.at).is_some_and(|unit| matches!(*unit, 0x30..=0x39 | 0x2b | 0x2d | 0x2e | 0x45 | 0x65)) {
            self.at += 1;
        }
        let digits = String::from_utf16(&self.units[from..self.at]).expect("a number is ASCII");
        digits.parse::<f64>().expect("the scan accepted the number")
    }
}

/// Reads a JSON text into a value, as `JSON.parse` does: on a key written twice the
/// last value wins at the first position, and every object and array is its own `Arc`.
pub fn read_json_text(text: &str) -> Result<Arc<JsonValue>, JsonTextError> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if let Some(refusal) = scan_units(&units) {
        return Err(JsonTextError::NotJson(refusal));
    }
    let mut reader = Reader { units: &units, at: 0 };
    let mut open: Vec<Open> = Vec::new();
    loop {
        reader.skip_whitespace();
        // Inside an object, a key comes before its value.
        if let Some(Open::Object(_, key @ None)) = open.last_mut() {
            if units[reader.at] == QUOTE {
                *key = Some(reader.string()?);
                reader.skip_whitespace();
                reader.at += 1;
                reader.skip_whitespace();
            }
        }
        let mut value = match units[reader.at] {
            0x7b => {
                reader.at += 1;
                open.push(Open::Object(PropertyMap::new(), None));
                continue_closing(&mut reader, &mut open, b'}')
            }
            0x5b => {
                reader.at += 1;
                open.push(Open::Array(Vec::new()));
                continue_closing(&mut reader, &mut open, b']')
            }
            QUOTE => Some(Arc::new(JsonValue::String(reader.string()?))),
            0x74 => {
                reader.at += 4;
                Some(Arc::new(JsonValue::Bool(true)))
            }
            0x66 => {
                reader.at += 5;
                Some(Arc::new(JsonValue::Bool(false)))
            }
            0x6e => {
                reader.at += 4;
                Some(Arc::new(JsonValue::Null))
            }
            _ => Some(Arc::new(JsonValue::Number(reader.number()))),
        };
        // Place each finished value; a container closed by its last entry finishes too.
        while let Some(finished) = value.take() {
            match open.last_mut() {
                None => return Ok(finished),
                Some(Open::Array(items)) => items.push(finished),
                Some(Open::Object(entries, key)) => {
                    entries.insert(key.take().expect("a value follows its key"), finished);
                }
            }
            reader.skip_whitespace();
            if units[reader.at] == b',' as u16 {
                reader.at += 1;
            } else {
                reader.at += 1;
                value = Some(close(&mut open));
            }
        }
    }
}

/// After an opening bracket: the container finished at once when it is empty.
fn continue_closing(reader: &mut Reader<'_>, open: &mut Vec<Open>, closing: u8) -> Option<Arc<JsonValue>> {
    reader.skip_whitespace();
    if reader.units[reader.at] == closing as u16 {
        reader.at += 1;
        return Some(close(open));
    }
    None
}

fn close(open: &mut Vec<Open>) -> Arc<JsonValue> {
    Arc::new(match open.pop().expect("a container is open") {
        Open::Array(items) => JsonValue::Array(items),
        Open::Object(entries, _) => JsonValue::Object(entries),
    })
}
