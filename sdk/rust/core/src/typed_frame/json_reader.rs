//! The JSON reader the typed frame reads with.
//!
//! No Node twin, by necessity: Node reads a frame with `JSON.parse`, and the
//! frame's reading rules are stated over what `JSON.parse` yields — an unpaired
//! surrogate escape kept as a code unit, members visited in `Object.keys` order, a
//! number read as the nearest double. `serde_json` answers each of those
//! differently, so the Rust half carries this reader instead. It also records the
//! first repeated member name, which `JSON.parse` resolves silently and the frame
//! refuses.

use std::collections::HashMap;

/// A JSON string as `JSON.parse` yields it: UTF-16 code units, which may hold an
/// unpaired surrogate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct JsonText(Vec<u16>);

impl JsonText {
    pub(super) fn lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
    pub(super) fn unpaired(&self) -> bool {
        String::from_utf16(&self.0).is_err()
    }
    pub(super) fn is(&self, text: &str) -> bool {
        self.0.iter().copied().eq(text.encode_utf16())
    }
}

pub(super) enum Json {
    Null,
    Bool(bool),
    Number(f64),
    Text(JsonText),
    Array(Vec<Json>),
    /// Members in the order `Object.keys` visits them: array-index keys ascending,
    /// then the rest by first appearance; a repeated key keeps its last value.
    Object(Vec<(JsonText, Json)>),
}

pub(super) struct JsonReader<'a> {
    source: &'a str,
    text: &'a [u8],
    /// Always on a character boundary of `source`.
    at: usize,
    /// The path of the value being read, keys rendered lossily.
    path: Vec<String>,
    /// The path of the first member, in text order, whose name its object already
    /// carries. Reported once the text has parsed, so a frame that is also not
    /// JSON is refused as that, as `JSON.parse` does first.
    repeated: Option<Vec<String>>,
}

impl<'a> JsonReader<'a> {
    pub(super) fn new(source: &'a str) -> Self {
        JsonReader { source, text: source.as_bytes(), at: 0, path: Vec::new(), repeated: None }
    }

    /// The path of the first repeated member name, once [`JsonReader::document`]
    /// has read the text.
    pub(super) fn repeated(self) -> Option<Vec<String>> {
        self.repeated
    }

    pub(super) fn document(&mut self) -> Result<Json, String> {
        let value = self.value()?;
        self.whitespace();
        if self.at != self.text.len() {
            return Err(format!("unexpected content at position {}", self.at));
        }
        Ok(value)
    }

    fn whitespace(&mut self) {
        while matches!(self.text.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, String> {
        if self.text[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(format!("unexpected token at position {}", self.at))
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.whitespace();
        match self.text.get(self.at) {
            None => Err("unexpected end of input".into()),
            Some(b'n') => self.literal("null", Json::Null),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'"') => self.string().map(Json::Text),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(format!("unexpected token at position {}", self.at)),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.at;
        if self.text[self.at] == b'-' {
            self.at += 1;
        }
        match self.text.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(format!("no number after minus sign at position {}", self.at)),
        }
        if self.text.get(self.at) == Some(&b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(format!("unterminated fractional number at position {}", self.at));
            }
        }
        if matches!(self.text.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.text.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(format!("exponent part is missing a number at position {}", self.at));
            }
        }
        let lexeme = std::str::from_utf8(&self.text[start..self.at]).expect("a number lexeme is ASCII");
        lexeme.parse::<f64>().map(Json::Number).map_err(|e| e.to_string())
    }

    fn hex4(&mut self) -> Result<u16, String> {
        let slice = self.text.get(self.at..self.at + 4).ok_or("bad Unicode escape")?;
        let text = std::str::from_utf8(slice).map_err(|_| "bad Unicode escape")?;
        let unit = u16::from_str_radix(text, 16).map_err(|_| "bad Unicode escape")?;
        if !text.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("bad Unicode escape".into());
        }
        self.at += 4;
        Ok(unit)
    }

    fn string(&mut self) -> Result<JsonText, String> {
        self.at += 1;
        let mut units = Vec::new();
        loop {
            let c = self.source[self.at..].chars().next().ok_or("unterminated string in JSON")?;
            self.at += c.len_utf8();
            match c {
                '"' => return Ok(JsonText(units)),
                '\\' => {
                    let escape = self.text.get(self.at).copied().ok_or("unterminated string in JSON")?;
                    self.at += 1;
                    match escape {
                        b'"' => units.push(0x22),
                        b'\\' => units.push(0x5c),
                        b'/' => units.push(0x2f),
                        b'b' => units.push(0x08),
                        b'f' => units.push(0x0c),
                        b'n' => units.push(0x0a),
                        b'r' => units.push(0x0d),
                        b't' => units.push(0x09),
                        b'u' => units.push(self.hex4()?),
                        _ => return Err(format!("bad escaped character at position {}", self.at - 1)),
                    }
                }
                c if (c as u32) < 0x20 => return Err(format!("bad control character in string at position {}", self.at - 1)),
                c => {
                    let mut buffer = [0u16; 2];
                    units.extend_from_slice(c.encode_utf16(&mut buffer));
                }
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.at += 1;
        let mut items = Vec::new();
        self.whitespace();
        if self.text.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.path.push(items.len().to_string());
            items.push(self.value()?);
            self.path.pop();
            self.whitespace();
            match self.text.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(format!("expected ',' or ']' at position {}", self.at)),
            }
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.at += 1;
        let mut members: Vec<(JsonText, Json)> = Vec::new();
        let mut positions: HashMap<Vec<u16>, usize> = HashMap::new();
        self.whitespace();
        if self.text.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(Json::Object(members));
        }
        loop {
            self.whitespace();
            if self.text.get(self.at) != Some(&b'"') {
                return Err(format!("expected a property name at position {}", self.at));
            }
            let key = self.string()?;
            self.whitespace();
            if self.text.get(self.at) != Some(&b':') {
                return Err(format!("expected ':' after property name at position {}", self.at));
            }
            self.at += 1;
            self.path.push(key.lossy());
            if self.repeated.is_none() && positions.contains_key(&key.0) {
                self.repeated = Some(self.path.clone());
            }
            let value = self.value()?;
            self.path.pop();
            match positions.get(&key.0) {
                Some(&position) => members[position].1 = value,
                None => {
                    positions.insert(key.0.clone(), members.len());
                    members.push((key, value));
                }
            }
            self.whitespace();
            match self.text.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    let (mut indices, rest): (Vec<_>, Vec<_>) =
                        members.into_iter().partition(|(k, _)| array_index(k).is_some());
                    indices.sort_by_key(|(k, _)| array_index(k));
                    indices.extend(rest);
                    return Ok(Json::Object(indices));
                }
                _ => return Err(format!("expected ',' or '}}' at position {}", self.at)),
            }
        }
    }
}

/// An ECMAScript array index: the canonical decimal text of an integer below 2³²−1.
fn array_index(key: &JsonText) -> Option<u32> {
    let text = String::from_utf16(&key.0).ok()?;
    let value: u32 = text.parse().ok()?;
    (value < u32::MAX && value.to_string() == text).then_some(value)
}
