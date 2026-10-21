//! A JSON value, and a reader of JSON text into one. No Node twin: a JavaScript host
//! hands the core a value `JSON.parse` (or a YAML reader) already built, and this crate
//! takes no dependency to build one. It is what `read_message` / `read_text` read and
//! what the CLDR data and the conformance vectors are read with.
//!
//! An object keeps ECMAScript's own-property order, so a reader of one answers in the
//! order the Node core does: keys that are array indices first, ascending, then every
//! other key where it was first written; a key written twice keeps its first place and
//! takes its last value.

use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, JsonValue)]> {
        match self {
            JsonValue::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            JsonValue::Array(items) => Some(items),
            _ => None,
        }
    }

    /// The value at `key` of an object; `None` for anything else.
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        self.as_object()?.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    /// Builds an object, putting its keys in ECMAScript's own-property order.
    pub fn object(entries: Vec<(String, JsonValue)>) -> JsonValue {
        let mut ordered: Vec<(String, JsonValue)> = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            match ordered.iter_mut().find(|(name, _)| *name == key) {
                Some(slot) => slot.1 = value,
                None => ordered.push((key, value)),
            }
        }
        let (mut indices, others): (Vec<_>, Vec<_>) =
            ordered.into_iter().partition(|(key, _)| array_index(key).is_some());
        indices.sort_by_key(|(key, _)| array_index(key));
        indices.extend(others);
        JsonValue::Object(indices)
    }
}

/// A key ECMAScript orders as an array index: the canonical text of an integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonError {
    /// Byte offset where the text stops being JSON.
    pub offset: usize,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the text is not JSON at byte {}", self.offset)
    }
}

impl std::error::Error for JsonError {}

pub fn parse_json(text: &str) -> Result<JsonValue, JsonError> {
    let mut reader = Reader { bytes: text.as_bytes(), text, at: 0 };
    reader.whitespace();
    let value = reader.value()?;
    reader.whitespace();
    if reader.at != reader.bytes.len() {
        return Err(reader.error());
    }
    Ok(value)
}

struct Reader<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

impl Reader<'_> {
    fn error(&self) -> JsonError {
        JsonError { offset: self.at }
    }

    fn whitespace(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: JsonValue) -> Result<JsonValue, JsonError> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error())
        }
    }

    fn value(&mut self) -> Result<JsonValue, JsonError> {
        match self.bytes.get(self.at) {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(JsonValue::String(self.string()?)),
            Some(b't') => self.literal("true", JsonValue::Bool(true)),
            Some(b'f') => self.literal("false", JsonValue::Bool(false)),
            Some(b'n') => self.literal("null", JsonValue::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.error()),
        }
    }

    fn object(&mut self) -> Result<JsonValue, JsonError> {
        self.at += 1;
        let mut entries = Vec::new();
        self.whitespace();
        if self.bytes.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(JsonValue::object(entries));
        }
        loop {
            self.whitespace();
            if self.bytes.get(self.at) != Some(&b'"') {
                return Err(self.error());
            }
            let key = self.string()?;
            self.whitespace();
            if self.bytes.get(self.at) != Some(&b':') {
                return Err(self.error());
            }
            self.at += 1;
            self.whitespace();
            entries.push((key, self.value()?));
            self.whitespace();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(JsonValue::object(entries));
                }
                _ => return Err(self.error()),
            }
        }
    }

    fn array(&mut self) -> Result<JsonValue, JsonError> {
        self.at += 1;
        let mut items = Vec::new();
        self.whitespace();
        if self.bytes.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(JsonValue::Array(items));
        }
        loop {
            self.whitespace();
            items.push(self.value()?);
            self.whitespace();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(JsonValue::Array(items));
                }
                _ => return Err(self.error()),
            }
        }
    }

    fn number(&mut self) -> Result<JsonValue, JsonError> {
        let start = self.at;
        if self.bytes.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        let digits = |reader: &mut Self| {
            let from = reader.at;
            while matches!(reader.bytes.get(reader.at), Some(b'0'..=b'9')) {
                reader.at += 1;
            }
            reader.at > from
        };
        if self.bytes.get(self.at) == Some(&b'0') {
            self.at += 1;
        } else if !digits(self) {
            return Err(self.error());
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !digits(self) {
                return Err(self.error());
            }
        }
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !digits(self) {
                return Err(self.error());
            }
        }
        self.text[start..self.at].parse::<f64>().map(JsonValue::Number).map_err(|_| JsonError { offset: start })
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let digits = self.text.get(self.at..self.at + 4).ok_or_else(|| self.error())?;
        let value = u32::from_str_radix(digits, 16).map_err(|_| self.error())?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(self.error());
        }
        self.at += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let run = self.at;
            while matches!(self.bytes.get(self.at), Some(b) if *b != b'"' && *b != b'\\' && *b >= 0x20) {
                self.at += 1;
            }
            out.push_str(&self.text[run..self.at]);
            match self.bytes.get(self.at) {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    let escape = self.at;
                    self.at += 1;
                    let marker = *self.bytes.get(self.at).ok_or_else(|| self.error())?;
                    self.at += 1;
                    match marker {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&unit) {
                                if !self.text[self.at..].starts_with("\\u") {
                                    return Err(JsonError { offset: escape });
                                }
                                self.at += 2;
                                let low = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err(JsonError { offset: escape });
                                }
                                0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                unit
                            };
                            out.push(char::from_u32(code).ok_or(JsonError { offset: escape })?);
                        }
                        _ => return Err(JsonError { offset: escape }),
                    }
                }
                _ => return Err(self.error()),
            }
        }
    }
}
