//! The `!ref` grammar, mirroring `../../../nodejs/src/engines/ref.ts`.
//!
//! Three forms: `<name>`, `<Alias>.<name>`, and `<family>` followed by one or
//! more `[<binding>.key]` / `[<binding>.index]`. Every name is an identifier, no
//! whitespace is allowed, there is no quoting rule, and an alias with an index is
//! refused. Both loaders read `!ref` text through this one parse and run the
//! shared vectors in `templating/tag-conformance/ref.json`.

use serde_json::{json, Value};

/// The code a text outside the grammar is refused under.
pub const REF_MEMBER_INVALID: &str = "REF_MEMBER_INVALID";

/// One `[<binding>.key]` / `[<binding>.index]` of an indexed reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefIndex {
    pub binding: String,
    /// `key` or `index`.
    pub member: &'static str,
}

/// What a reference names. `alias` is kept as written, `Self` included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRef {
    pub alias: Option<String>,
    pub name: String,
    pub indexes: Vec<RefIndex>,
}

/// The engine's verdict on a `!ref` text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefVerdict {
    Parsed(ParsedRef),
    /// The text is outside the grammar; the UTF-16 offset of its first
    /// inadmissible character (its length when it ends too early).
    Refusal { offset: usize },
}

impl RefVerdict {
    /// The verdict as the sentinel carries it: `{ "parsed": … }` or
    /// `{ "refusal": { code, offset } }`.
    pub fn to_json_entry(&self) -> (&'static str, Value) {
        match self {
            RefVerdict::Parsed(parsed) => {
                let indexes: Vec<Value> = parsed
                    .indexes
                    .iter()
                    .map(|index| json!({ "binding": index.binding, "member": index.member }))
                    .collect();
                let mut object = serde_json::Map::new();
                if let Some(alias) = &parsed.alias {
                    object.insert("alias".to_string(), Value::String(alias.clone()));
                }
                object.insert("name".to_string(), Value::String(parsed.name.clone()));
                object.insert("indexes".to_string(), Value::Array(indexes));
                ("parsed", Value::Object(object))
            }
            RefVerdict::Refusal { offset } => {
                ("refusal", json!({ "code": REF_MEMBER_INVALID, "offset": offset }))
            }
        }
    }
}

/// Parse a `!ref` text.
pub fn parse_ref_source(source: &str) -> RefVerdict {
    let chars: Vec<char> = source.chars().collect();
    // UTF-16 offsets, so a refusal names the same position as the Node half's.
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut at = 0;
    for ch in &chars {
        offsets.push(at);
        at += ch.len_utf16();
    }
    offsets.push(at);

    let mut pos = 0;
    let refuse = |pos: usize| RefVerdict::Refusal { offset: offsets[pos] };
    let identifier = |pos: &mut usize| -> Option<String> {
        let start = *pos;
        if *pos >= chars.len() || !is_identifier_start(chars[*pos]) {
            return None;
        }
        *pos += 1;
        while *pos < chars.len() && is_identifier_part(chars[*pos]) {
            *pos += 1;
        }
        Some(chars[start..*pos].iter().collect())
    };

    let head = match identifier(&mut pos) {
        Some(head) => head,
        None => return refuse(pos),
    };
    if pos == chars.len() {
        return RefVerdict::Parsed(ParsedRef { alias: None, name: head, indexes: vec![] });
    }

    if chars[pos] == '.' {
        pos += 1;
        let name = match identifier(&mut pos) {
            Some(name) => name,
            None => return refuse(pos),
        };
        if pos != chars.len() {
            return refuse(pos);
        }
        return RefVerdict::Parsed(ParsedRef { alias: Some(head), name, indexes: vec![] });
    }

    let mut indexes = Vec::new();
    while pos < chars.len() {
        if chars[pos] != '[' {
            return refuse(pos);
        }
        pos += 1;
        let binding = match identifier(&mut pos) {
            Some(binding) => binding,
            None => return refuse(pos),
        };
        if pos >= chars.len() || chars[pos] != '.' {
            return refuse(pos);
        }
        pos += 1;
        let member_start = pos;
        let member: &'static str = match identifier(&mut pos).as_deref() {
            Some("key") => "key",
            Some("index") => "index",
            _ => return refuse(member_start),
        };
        if pos >= chars.len() || chars[pos] != ']' {
            return refuse(pos);
        }
        pos += 1;
        indexes.push(RefIndex { binding, member });
    }
    RefVerdict::Parsed(ParsedRef { alias: None, name: head, indexes })
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_identifier_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}
