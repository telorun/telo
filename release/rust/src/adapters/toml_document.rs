//! A TOML document read into values that keep their source spans, so a caller
//! can splice one string without re-serializing the file. The whole TOML 1.0
//! grammar is read (inline tables may span lines and end in a comma, as TOML
//! 1.1 allows); a date or time is kept as its text. Anything else is refused
//! naming the line, never guessed at. Spans are byte offsets into the text
//! read, a byte-order mark included.

use std::fmt;

use indexmap::IndexMap;

use crate::ReleaseError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TomlError {
    pub message: String,
}

impl fmt::Display for TomlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TomlError {}

impl From<TomlError> for ReleaseError {
    fn from(err: TomlError) -> ReleaseError {
        ReleaseError::new(err.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TomlQuote {
    Basic,
    Literal,
    MultiBasic,
    MultiLiteral,
}

impl TomlQuote {
    pub fn as_str(self) -> &'static str {
        match self {
            TomlQuote::Basic => "\"",
            TomlQuote::Literal => "'",
            TomlQuote::MultiBasic => "\"\"\"",
            TomlQuote::MultiLiteral => "'''",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TomlString {
    pub value: String,
    pub start: usize,
    pub end: usize,
    pub quote: TomlQuote,
}

/// An inline table, a table a header defined, or one only named by a dotted
/// key or header path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableOrigin {
    Inline,
    Header,
    Dotted,
    Implicit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TomlTable {
    pub entries: IndexMap<String, TomlValue>,
    pub origin: TableOrigin,
}

impl TomlTable {
    fn new(origin: TableOrigin) -> TomlTable {
        TomlTable { entries: IndexMap::new(), origin }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TomlValue {
    String(TomlString),
    /// The integer in decimal, unbounded.
    Integer(String),
    /// The float as written.
    Float(String),
    Boolean(bool),
    Datetime(String),
    Array { items: Vec<TomlValue>, of_tables: bool },
    Table(TomlTable),
}

impl TomlValue {
    pub fn kind(&self) -> &'static str {
        match self {
            TomlValue::String(_) => "string",
            TomlValue::Integer(_) => "integer",
            TomlValue::Float(_) => "float",
            TomlValue::Boolean(_) => "boolean",
            TomlValue::Datetime(_) => "datetime",
            TomlValue::Array { .. } => "array",
            TomlValue::Table(_) => "table",
        }
    }
}

fn is_bare_key(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

struct Reader<'a> {
    text: &'a str,
    pos: usize,
    at: &'a str,
}

impl Reader<'_> {
    fn error(&self, message: String, at: usize) -> TomlError {
        let line = self.text.as_bytes()[..at.min(self.text.len())].iter().filter(|b| **b == b'\n').count() + 1;
        TomlError { message: format!("{}:{line}: {message}", self.at) }
    }

    fn fail<T>(&self, message: String) -> Result<T, TomlError> {
        Err(self.error(message, self.pos))
    }

    fn peek(&self) -> Option<char> {
        self.text.get(self.pos..).and_then(|rest| rest.chars().next())
    }

    /// The next character as a refusal names it, `the end` past the last.
    fn shown(&self) -> String {
        self.peek().map_or_else(|| "the end".to_string(), String::from)
    }

    fn advance(&mut self) {
        if let Some(c) = self.peek() {
            self.pos += c.len_utf8();
        }
    }

    fn starts_with(&self, token: &str) -> bool {
        self.text.get(self.pos..).is_some_and(|rest| rest.starts_with(token))
    }

    fn at_end(&self) -> bool {
        self.pos >= self.text.len()
    }

    fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.pos += 1;
        }
    }

    fn skip_comment(&mut self) {
        if self.peek() != Some('#') {
            return;
        }
        while !self.at_end() && self.peek() != Some('\n') {
            self.advance();
        }
    }

    /// Spaces, a comment, then a newline or the end.
    fn end_of_line(&mut self) -> Result<(), TomlError> {
        self.skip_spaces();
        self.skip_comment();
        if self.at_end() {
            return Ok(());
        }
        if self.starts_with("\r\n") {
            self.pos += 2;
        } else if self.peek() == Some('\n') {
            self.pos += 1;
        } else {
            return self.fail(format!("expected the end of the line, found '{}'", self.shown()));
        }
        Ok(())
    }

    /// Whitespace, newlines and comments, as inside an array.
    fn skip_blank(&mut self) {
        loop {
            self.skip_spaces();
            self.skip_comment();
            if self.starts_with("\r\n") {
                self.pos += 2;
            } else if self.peek() == Some('\n') {
                self.pos += 1;
            } else {
                return;
            }
        }
    }

    fn key(&mut self) -> Result<Vec<String>, TomlError> {
        let mut parts = Vec::new();
        loop {
            self.skip_spaces();
            if matches!(self.peek(), Some('"' | '\'')) {
                let literal = self.string()?;
                if matches!(literal.quote, TomlQuote::MultiBasic | TomlQuote::MultiLiteral) {
                    return self.fail("a key cannot be a multi-line string".into());
                }
                parts.push(literal.value);
            } else {
                let start = self.pos;
                while self.peek().is_some_and(is_bare_key) {
                    self.pos += 1;
                }
                if self.pos == start {
                    return self.fail(format!("expected a key, found '{}'", self.shown()));
                }
                parts.push(self.text[start..self.pos].to_string());
            }
            self.skip_spaces();
            if self.peek() != Some('.') {
                return Ok(parts);
            }
            self.pos += 1;
        }
    }

    fn string(&mut self) -> Result<TomlString, TomlError> {
        let start = self.pos;
        if self.starts_with("\"\"\"") {
            return self.multiline(start, TomlQuote::MultiBasic);
        }
        if self.starts_with("'''") {
            return self.multiline(start, TomlQuote::MultiLiteral);
        }
        let (quote, kind) = if self.peek() == Some('"') { ('"', TomlQuote::Basic) } else { ('\'', TomlQuote::Literal) };
        self.pos += 1;
        let mut value = String::new();
        loop {
            let c = match self.peek() {
                None | Some('\n') => return Err(self.error("a string is not closed on its line".into(), start)),
                Some(c) => c,
            };
            self.advance();
            if c == quote {
                break;
            }
            if quote == '"' && c == '\\' {
                value.push_str(&self.escape()?);
            } else {
                value.push(c);
            }
        }
        Ok(TomlString { value, start, end: self.pos, quote: kind })
    }

    fn multiline(&mut self, start: usize, quote: TomlQuote) -> Result<TomlString, TomlError> {
        let delimiter = quote.as_str();
        let mark = delimiter.as_bytes()[0];
        self.pos += 3;
        if self.starts_with("\r\n") {
            self.pos += 2;
        } else if self.peek() == Some('\n') {
            self.pos += 1;
        }
        let mut value = String::new();
        loop {
            if self.at_end() {
                return Err(self.error("a multi-line string is not closed".into(), start));
            }
            if self.starts_with(delimiter) {
                // Up to two quotes may sit right before the closing three.
                let bytes = self.text.as_bytes();
                let mut extra = 0;
                while extra < 2 && bytes.get(self.pos + 3 + extra) == Some(&mark) {
                    extra += 1;
                }
                for _ in 0..extra {
                    value.push(mark as char);
                }
                self.pos += 3 + extra;
                return Ok(TomlString { value, start, end: self.pos, quote });
            }
            let Some(c) = self.peek() else { continue };
            self.advance();
            if quote == TomlQuote::MultiBasic && c == '\\' {
                let rest = &self.text[self.pos..];
                let spaces = rest.len() - rest.trim_start_matches([' ', '\t']).len();
                let after = &rest[spaces..];
                let newline = if after.starts_with("\r\n") {
                    2
                } else if after.starts_with('\n') {
                    1
                } else {
                    0
                };
                if newline > 0 {
                    self.pos += spaces + newline;
                    while !self.at_end() && matches!(self.peek(), Some(' ' | '\t' | '\r' | '\n')) {
                        self.pos += 1;
                    }
                    continue;
                }
                value.push_str(&self.escape()?);
            } else {
                value.push(c);
            }
        }
    }

    fn escape(&mut self) -> Result<String, TomlError> {
        let c = self.peek();
        self.advance();
        let simple = match c {
            Some('b') => Some('\u{8}'),
            Some('t') => Some('\t'),
            Some('n') => Some('\n'),
            Some('f') => Some('\u{c}'),
            Some('r') => Some('\r'),
            Some('e') => Some('\u{1b}'),
            Some('"') => Some('"'),
            Some('\\') => Some('\\'),
            _ => None,
        };
        if let Some(simple) = simple {
            return Ok(simple.to_string());
        }
        let shown = c.map(String::from).unwrap_or_default();
        let width = match c {
            Some('u') => 4,
            Some('U') => 8,
            Some('x') => 2,
            _ => return self.fail(format!("'\\{shown}' is not an escape a TOML string knows")),
        };
        let hex: String = self.text[self.pos..].chars().take(width).collect();
        if hex.chars().count() != width || !hex.chars().all(|h| h.is_ascii_hexdigit()) {
            return self.fail(format!("'\\{shown}{hex}' is not a valid escape"));
        }
        self.pos += width;
        let scalar = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32);
        match scalar {
            Some(scalar) => Ok(scalar.to_string()),
            None => self.fail(format!("'\\{shown}{hex}' names no Unicode scalar value")),
        }
    }

    fn value(&mut self) -> Result<TomlValue, TomlError> {
        let first = self.peek();
        match first {
            Some('"' | '\'') => return Ok(TomlValue::String(self.string()?)),
            Some('[') => return self.array(),
            Some('{') => return Ok(TomlValue::Table(self.inline_table()?)),
            _ => {}
        }
        let start = self.pos;
        while !self.at_end() && !matches!(self.peek(), Some(',' | ']' | '}' | '\n' | '#' | '\r')) {
            self.advance();
        }
        // Read to the next delimiter, since a local date-time holds a space.
        let raw = self.text[start..self.pos].trim_end_matches([' ', '\t']).to_string();
        self.pos = start + raw.len();
        if raw.is_empty() {
            return self.fail(format!("expected a value, found '{}'", first.map_or_else(|| "the end".to_string(), String::from)));
        }
        if raw == "true" || raw == "false" {
            return Ok(TomlValue::Boolean(raw == "true"));
        }
        if is_datetime(&raw) {
            return Ok(TomlValue::Datetime(raw));
        }
        if let Some(decimal) = decimal_integer(&raw) {
            return Ok(TomlValue::Integer(decimal));
        }
        if let Some(decimal) = radix_integer(&raw) {
            return Ok(TomlValue::Integer(decimal));
        }
        let unsigned = raw.strip_prefix(['+', '-']).unwrap_or(&raw);
        if unsigned == "inf" || unsigned == "nan" || is_float(&raw) {
            return Ok(TomlValue::Float(raw));
        }
        Err(self.error(format!("'{raw}' is not a TOML value"), start))
    }

    fn array(&mut self) -> Result<TomlValue, TomlError> {
        self.pos += 1;
        let mut items = Vec::new();
        loop {
            self.skip_blank();
            if self.peek() == Some(']') {
                break;
            }
            items.push(self.value()?);
            self.skip_blank();
            if self.peek() == Some(',') {
                self.pos += 1;
                continue;
            }
            if self.peek() != Some(']') {
                return self.fail(format!("expected ',' or ']' in an array, found '{}'", self.shown()));
            }
            break;
        }
        self.pos += 1;
        Ok(TomlValue::Array { items, of_tables: false })
    }

    fn inline_table(&mut self) -> Result<TomlTable, TomlError> {
        self.pos += 1;
        let mut inline = TomlTable::new(TableOrigin::Inline);
        loop {
            self.skip_blank();
            if self.peek() == Some('}') {
                break;
            }
            let key = self.key()?;
            self.skip_spaces();
            if self.peek() != Some('=') {
                return self.fail(format!("expected '=' after the key '{}'", key.join(".")));
            }
            self.pos += 1;
            self.skip_spaces();
            let value = self.value()?;
            assign(self, &mut inline, &key, value)?;
            self.skip_blank();
            if self.peek() == Some(',') {
                self.pos += 1;
                continue;
            }
            if self.peek() != Some('}') {
                return self.fail(format!("expected ',' or '}}' in an inline table, found '{}'", self.shown()));
            }
            break;
        }
        self.pos += 1;
        Ok(inline)
    }
}

fn digits(bytes: &[u8], at: usize, count: usize) -> bool {
    bytes.get(at..at + count).is_some_and(|run| run.iter().all(u8::is_ascii_digit))
}

/// `^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$`
/// or `^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$`.
fn is_datetime(raw: &str) -> bool {
    let b = raw.as_bytes();
    let time = |mut i: usize| -> usize {
        // `\d{2}:\d{2}` is matched by the caller.
        if b.get(i) == Some(&b':') && digits(b, i + 1, 2) {
            i += 3;
            if b.get(i) == Some(&b'.') && digits(b, i + 1, 1) {
                i += 1;
                while digits(b, i, 1) {
                    i += 1;
                }
            }
        }
        i
    };
    if digits(b, 0, 4) && b.get(4) == Some(&b'-') && digits(b, 5, 2) && b.get(7) == Some(&b'-') && digits(b, 8, 2) {
        if b.len() == 10 {
            return true;
        }
        if !(matches!(b.get(10), Some(b'T' | b't' | b' ')) && digits(b, 11, 2) && b.get(13) == Some(&b':') && digits(b, 14, 2)) {
            return false;
        }
        let mut i = time(16);
        if matches!(b.get(i), Some(b'Z' | b'z')) {
            i += 1;
        } else if matches!(b.get(i), Some(b'+' | b'-')) && digits(b, i + 1, 2) && b.get(i + 3) == Some(&b':') && digits(b, i + 4, 2) {
            i += 6;
        }
        return i == b.len();
    }
    digits(b, 0, 2) && b.get(2) == Some(&b':') && digits(b, 3, 2) && time(5) == b.len()
}

/// The end of `d(_?d)*` from `at`, where `d` is a digit of `radix`.
fn digit_run(b: &[u8], at: usize, radix: u32) -> Option<usize> {
    let is_digit = |i: usize| b.get(i).is_some_and(|c| (*c as char).is_digit(radix));
    if !is_digit(at) {
        return None;
    }
    let mut i = at + 1;
    loop {
        if is_digit(i) {
            i += 1;
        } else if b.get(i) == Some(&b'_') && is_digit(i + 1) {
            i += 2;
        } else {
            return Some(i);
        }
    }
}

/// `[+-]?(0|[1-9](_?\d)*)` from the start; its end.
fn decimal_part(b: &[u8]) -> Option<usize> {
    let sign = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    match b.get(sign) {
        Some(b'0') => Some(sign + 1),
        Some(b'1'..=b'9') => digit_run(b, sign, 10),
        _ => None,
    }
}

/// `^[+-]?(0|[1-9](_?\d)*)$`, in decimal.
fn decimal_integer(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    if decimal_part(b)? != b.len() {
        return None;
    }
    let negative = raw.starts_with('-');
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    Some(if digits == "0" || !negative { digits } else { format!("-{digits}") })
}

/// `^(0x[0-9A-Fa-f](_?[0-9A-Fa-f])*|0o[0-7](_?[0-7])*|0b[01](_?[01])*)$`, in decimal.
fn radix_integer(raw: &str) -> Option<String> {
    let radix = match raw.get(..2)? {
        "0x" => 16,
        "0o" => 8,
        "0b" => 2,
        _ => return None,
    };
    if digit_run(raw.as_bytes(), 2, radix)? != raw.len() {
        return None;
    }
    Some(to_decimal(raw[2..].chars().filter(|c| *c != '_'), radix))
}

/// Digits of `radix` written in decimal, at any length.
fn to_decimal(digits: impl Iterator<Item = char>, radix: u32) -> String {
    const BASE: u64 = 1_000_000_000;
    // Little-endian limbs of nine decimal digits.
    let mut limbs: Vec<u64> = vec![0];
    for digit in digits {
        let mut carry = u64::from(digit.to_digit(radix).unwrap_or(0));
        for limb in &mut limbs {
            let next = *limb * u64::from(radix) + carry;
            *limb = next % BASE;
            carry = next / BASE;
        }
        while carry > 0 {
            limbs.push(carry % BASE);
            carry /= BASE;
        }
    }
    let mut out = limbs.last().map_or_else(String::new, u64::to_string);
    for limb in limbs.iter().rev().skip(1) {
        out.push_str(&format!("{limb:09}"));
    }
    out
}

/// `^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$`
fn is_float(raw: &str) -> bool {
    let b = raw.as_bytes();
    let Some(mut i) = decimal_part(b) else { return false };
    if b.get(i) == Some(&b'.') {
        match digit_run(b, i + 1, 10) {
            Some(end) => i = end,
            None => return false,
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
        match digit_run(b, i + 1 + sign, 10) {
            Some(end) => i = end,
            None => return false,
        }
    }
    i == b.len()
}

/// `value` stored at `key` beneath `into`, creating the dotted tables between.
fn assign(reader: &Reader<'_>, into: &mut TomlTable, key: &[String], value: TomlValue) -> Result<(), TomlError> {
    let Some((last, parents)) = key.split_last() else { return Ok(()) };
    let mut current = into;
    for part in parents {
        let existing = current.entries.entry(part.clone()).or_insert_with(|| TomlValue::Table(TomlTable::new(TableOrigin::Dotted)));
        match existing {
            TomlValue::Table(table) if table.origin == TableOrigin::Dotted => current = table,
            _ => return reader.fail(format!("'{}' extends '{part}', which is already defined as a value", key.join("."))),
        }
    }
    if current.entries.contains_key(last) {
        return reader.fail(format!("'{}' is defined twice", key.join(".")));
    }
    current.entries.insert(last.clone(), value);
    Ok(())
}

/// Read a whole TOML document.
pub fn read_toml_document(text: &str, at: &str) -> Result<TomlTable, TomlError> {
    let mut reader = Reader { text, pos: if text.starts_with('\u{feff}') { 3 } else { 0 }, at };
    let mut root = TomlTable::new(TableOrigin::Header);
    // The keys of the table key/value lines go into, from the root.
    let mut current: Vec<String> = Vec::new();
    while !reader.at_end() {
        reader.skip_spaces();
        let c = reader.peek();
        if matches!(c, None | Some('#' | '\n' | '\r')) {
            reader.end_of_line()?;
            continue;
        }
        if c == Some('[') {
            let array_of_tables = reader.starts_with("[[");
            reader.pos += if array_of_tables { 2 } else { 1 };
            let key = reader.key()?;
            let close = if array_of_tables { "]]" } else { "]" };
            if !reader.starts_with(close) {
                return reader.fail("a table header is not closed".into());
            }
            reader.pos += close.len();
            reader.end_of_line()?;
            if array_of_tables {
                append_table(&reader, &mut root, &key)?;
            } else {
                open_table(&reader, &mut root, &key)?;
            }
            current = key;
            continue;
        }
        let key = reader.key()?;
        if reader.peek() != Some('=') {
            return reader.fail(format!("expected '=' after the key '{}'", key.join(".")));
        }
        reader.pos += 1;
        reader.skip_spaces();
        let value = reader.value()?;
        assign(&reader, table_at(&mut root, &current), &key, value)?;
        reader.end_of_line()?;
    }
    Ok(root)
}

/// The table a header opened, reached as `parent_of` reached it: through
/// tables, and through the last table of an array of tables.
fn table_at<'t>(root: &'t mut TomlTable, keys: &[String]) -> &'t mut TomlTable {
    let mut current = root;
    for key in keys {
        current = match current.entries.get_mut(key) {
            Some(TomlValue::Table(table)) => table,
            Some(TomlValue::Array { items, of_tables: true }) => match items.last_mut() {
                Some(TomlValue::Table(table)) => table,
                _ => unreachable!("an array of tables holds tables"),
            },
            _ => unreachable!("a header path the reader opened"),
        };
    }
    current
}

/// The table beneath `key`'s parents, each parent made or reached.
fn parent_of<'t>(reader: &Reader<'_>, root: &'t mut TomlTable, key: &[String]) -> Result<&'t mut TomlTable, TomlError> {
    let mut current = root;
    for part in &key[..key.len() - 1] {
        let existing = current.entries.entry(part.clone()).or_insert_with(|| TomlValue::Table(TomlTable::new(TableOrigin::Implicit)));
        current = match existing {
            TomlValue::Table(table) if table.origin != TableOrigin::Inline => table,
            TomlValue::Array { items, of_tables: true } => match items.last_mut() {
                Some(TomlValue::Table(table)) => table,
                _ => unreachable!("an array of tables holds tables"),
            },
            _ => {
                return reader.fail(format!("the header '{}' passes through '{part}', which is not a table", key.join(".")));
            }
        };
    }
    Ok(current)
}

fn open_table(reader: &Reader<'_>, root: &mut TomlTable, key: &[String]) -> Result<(), TomlError> {
    let parent = parent_of(reader, root, key)?;
    let last = &key[key.len() - 1];
    match parent.entries.get_mut(last) {
        None => {
            parent.entries.insert(last.clone(), TomlValue::Table(TomlTable::new(TableOrigin::Header)));
            Ok(())
        }
        Some(TomlValue::Table(existing)) if existing.origin == TableOrigin::Implicit => {
            existing.origin = TableOrigin::Header;
            Ok(())
        }
        Some(_) => reader.fail(format!("the table '{}' is defined twice", key.join("."))),
    }
}

fn append_table(reader: &Reader<'_>, root: &mut TomlTable, key: &[String]) -> Result<(), TomlError> {
    let parent = parent_of(reader, root, key)?;
    let last = &key[key.len() - 1];
    let made = TomlValue::Table(TomlTable::new(TableOrigin::Header));
    match parent.entries.get_mut(last) {
        None => {
            parent.entries.insert(last.clone(), TomlValue::Array { items: vec![made], of_tables: true });
            Ok(())
        }
        Some(TomlValue::Array { items, of_tables: true }) => {
            items.push(made);
            Ok(())
        }
        Some(_) => reader.fail(format!("'{}' is not an array of tables", key.join("."))),
    }
}

/// The value at `path` beneath `from`, or `None` when any step is absent or
/// not a table (or the path is empty).
pub fn toml_at<'t>(from: &'t TomlTable, path: &[&str]) -> Option<&'t TomlValue> {
    let (last, parents) = path.split_last()?;
    let mut current = from;
    for part in parents {
        match current.entries.get(*part)? {
            TomlValue::Table(table) => current = table,
            _ => return None,
        }
    }
    current.entries.get(*last)
}

/// The text a TOML basic string literal spelling `value` is written as.
pub fn toml_basic_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The text of a string literal rewritten to hold `value`, in its author's
/// quote style where that style can hold it: a literal string or a basic one
/// with no escape is spliced as written; anything else becomes a basic string.
pub fn respell_toml_string(text: &str, literal: &TomlString, value: &str) -> String {
    let q = literal.quote.as_str().len();
    let inner = &text[literal.start + q..literal.end - q];
    let controls = value.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if literal.quote == TomlQuote::Literal && !controls && !value.contains('\'') {
        return format!("'{value}'");
    }
    if literal.quote == TomlQuote::Basic && !controls && !inner.contains('\\') && !value.contains('"') && !value.contains('\\') {
        return format!("\"{value}\"");
    }
    toml_basic_string(value)
}
