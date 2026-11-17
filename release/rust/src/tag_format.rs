//! A unit's release tag as a rendered template.
//!
//! A tag format is text with the placeholders `{key}`, `{name}` and
//! `{version}`. Resolved against one unit it becomes a tag pattern — the text
//! around each `{version}` — so rendering is a join, and whether two units can
//! ever be tagged alike is decided on the patterns alone, before any tag
//! exists.

use std::collections::{HashSet, VecDeque};

pub const TAG_PLACEHOLDERS: &[&str] = &["key", "name", "version"];

/// The format of a unit no `tagFormat` names.
pub const DEFAULT_TAG_FORMAT: &str = "{key}@{version}";
/// The root unit's (key `.`): `.@1.0.0` is no legal git ref.
pub const ROOT_TAG_FORMAT: &str = "v{version}";

/// The version a format is rendered with to judge it against git's rules.
pub const SAMPLE_TAG_VERSION: &str = "0.0.0";

/// The sentence a refused format's report ends with.
pub const TAG_FORMAT_HINT: &str =
    "A tag format is text with the placeholders {key}, {name} and {version}, e.g. '{key}@{version}'.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagFormatPart {
    Literal(String),
    Key,
    Name,
    Version,
}

/// The text around each `{version}` of a unit's tag: `["web/", ""]`.
pub type TagPattern = Vec<String>;

/// A format's parts, or what is wrong with it, worded to follow its value.
pub fn parse_tag_format(format: &str) -> Result<Vec<TagFormatPart>, String> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut i = 0;
    while i < format.len() {
        let c = format[i..].chars().next().expect("a char at a boundary");
        if c == '}' {
            return Err("which holds a '}' that closes no placeholder".into());
        }
        if c != '{' {
            literal.push(c);
            i += c.len_utf8();
            continue;
        }
        let end = format[i + 1..].find('}').map(|at| at + i + 1);
        let open = format[i + 1..].find('{').map(|at| at + i + 1);
        let end = match (end, open) {
            (Some(end), Some(open)) if open < end => return Err("which holds a '{' that opens no placeholder".into()),
            (Some(end), _) => end,
            (None, _) => return Err("which holds a '{' that opens no placeholder".into()),
        };
        let name = &format[i + 1..end];
        let part = match name {
            "key" => TagFormatPart::Key,
            "name" => TagFormatPart::Name,
            "version" => TagFormatPart::Version,
            _ => return Err(format!("whose '{{{name}}}' is no placeholder")),
        };
        if !literal.is_empty() {
            parts.push(TagFormatPart::Literal(std::mem::take(&mut literal)));
        }
        parts.push(part);
        i = end + 1;
    }
    if !literal.is_empty() {
        parts.push(TagFormatPart::Literal(literal));
    }
    if !parts.contains(&TagFormatPart::Version) {
        return Err("which holds no {version}, so every version of a unit would get the same tag".into());
    }
    Ok(parts)
}

/// The format of a unit that names none.
pub fn default_tag_format(key: &str) -> &'static str {
    if key == "." {
        ROOT_TAG_FORMAT
    } else {
        DEFAULT_TAG_FORMAT
    }
}

/// The pattern of a unit that names no format.
pub fn default_tag_pattern(key: &str) -> TagPattern {
    if key == "." {
        vec!["v".into(), String::new()]
    } else {
        vec![format!("{key}@"), String::new()]
    }
}

/// `parts` resolved for one unit; `None` when it uses `{name}` and the unit
/// has none.
pub fn tag_pattern_of(parts: &[TagFormatPart], key: &str, name: Option<&str>) -> Option<TagPattern> {
    let mut pattern = vec![String::new()];
    for part in parts {
        let last = pattern.last_mut().expect("a pattern is never empty");
        match part {
            TagFormatPart::Literal(text) => last.push_str(text),
            TagFormatPart::Key => last.push_str(key),
            TagFormatPart::Name => last.push_str(name?),
            TagFormatPart::Version => pattern.push(String::new()),
        }
    }
    Some(pattern)
}

pub fn render_tag(pattern: &[String], version: &str) -> String {
    pattern.join(version)
}

/// Why git refuses `tag` as a tag name (`git check-ref-format`), or `None`.
pub fn git_tag_refusal(tag: &str) -> Option<String> {
    for c in tag.chars() {
        let code = c as u32;
        if code < 0x20 || code == 0x7f {
            return Some("it holds a control character".into());
        }
        if c == ' ' {
            return Some("it holds a space".into());
        }
        if "~^:?*[\\".contains(c) {
            return Some(format!("it holds '{c}'"));
        }
    }
    if tag == "@" {
        return Some("it is '@'".into());
    }
    if tag.contains("..") {
        return Some("it holds '..'".into());
    }
    if tag.contains("@{") {
        return Some("it holds '@{'".into());
    }
    if tag.starts_with('/') || tag.ends_with('/') || tag.contains("//") {
        return Some("it starts or ends with '/', or holds '//'".into());
    }
    if tag.ends_with('.') {
        return Some("it ends with '.'".into());
    }
    for part in tag.split('/') {
        if part.starts_with('.') {
            return Some("a part of it starts with '.'".into());
        }
        if part.ends_with(".lock") {
            return Some("a part of it ends with '.lock'".into());
        }
    }
    None
}

// A version a unit may carry — `N.N.N` or `N.N.N-<id>.<k>` — as a DFA; 5 and
// 9 accept.
const VERSION_START: u8 = 0;
const VERSION_ALPHABET: &str = "-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn version_accepting(state: u8) -> bool {
    state == 5 || state == 9
}

fn version_step(state: u8, c: char) -> Option<u8> {
    let digit = c.is_ascii_digit();
    let letter = c.is_ascii_alphabetic();
    match (state, c) {
        (0, _) if digit => Some(1),
        (1, _) if digit => Some(1),
        (1, '.') => Some(2),
        (2, _) if digit => Some(3),
        (3, _) if digit => Some(3),
        (3, '.') => Some(4),
        (4, _) if digit => Some(5),
        (5, _) if digit => Some(5),
        (5, '-') => Some(6),
        (6, _) if letter => Some(7),
        (7, _) if digit || letter => Some(7),
        (7, '.') => Some(8),
        (8, _) if digit && c != '0' => Some(9),
        (9, _) if digit => Some(9),
        _ => None,
    }
}

/// A pattern as items: one char each, `None` a version.
fn items_of(pattern: &[String]) -> Vec<Option<char>> {
    let mut items = Vec::new();
    for (index, text) in pattern.iter().enumerate() {
        if index > 0 {
            items.push(None);
        }
        items.extend(text.chars().map(Some));
    }
    items
}

type Position = (usize, u8);

/// A position and where a finished version moves it, without reading.
fn closure(items: &[Option<char>], (item, state): Position) -> Vec<Position> {
    let mut out = vec![(item, state)];
    if item < items.len() && items[item].is_none() && version_accepting(state) {
        out.push((item + 1, VERSION_START));
    }
    out
}

fn step(items: &[Option<char>], (item, state): Position, c: char) -> Option<Position> {
    match items.get(item)? {
        Some(at) => (*at == c).then_some((item + 1, VERSION_START)),
        None => version_step(state, c).map(|next| (item, next)),
    }
}

fn readable(items: &[Option<char>], (item, state): Position) -> Vec<char> {
    match items.get(item) {
        None => Vec::new(),
        Some(Some(at)) => vec![*at],
        Some(None) => VERSION_ALPHABET.chars().filter(|c| version_step(state, *c).is_some()).collect(),
    }
}

/// The shortest tag both patterns render, each with some version, or `None`
/// when none exists — decided by walking the two patterns together.
pub fn tag_collision(a: &[String], b: &[String]) -> Option<String> {
    // Both read text, not a version, until the shorter leading (or trailing)
    // text ends, so a difference there settles it without the walk.
    let (a0, b0, az, bz) = (a[0].as_bytes(), b[0].as_bytes(), a[a.len() - 1].as_bytes(), b[b.len() - 1].as_bytes());
    let lead = a0.len().min(b0.len());
    let tail = az.len().min(bz.len());
    if a0[..lead] != b0[..lead] || az[az.len() - tail..] != bz[bz.len() - tail..] {
        return None;
    }
    let left = items_of(a);
    let right = items_of(b);
    let start = ((0, VERSION_START), (0, VERSION_START));
    let mut seen: HashSet<(Position, Position)> = HashSet::from([start]);
    let mut frontier: VecDeque<((Position, Position), String)> = VecDeque::from([(start, String::new())]);
    while !frontier.is_empty() {
        let mut next = VecDeque::new();
        for ((p0, q0), text) in &frontier {
            let lefts = closure(&left, *p0);
            let rights = closure(&right, *q0);
            for p in &lefts {
                for q in &rights {
                    if p.0 == left.len() && q.0 == right.len() {
                        return Some(text.clone());
                    }
                }
            }
            for p in &lefts {
                for q in &rights {
                    let theirs = readable(&right, *q);
                    for c in readable(&left, *p) {
                        if !theirs.contains(&c) {
                            continue;
                        }
                        let p2 = step(&left, *p, c).expect("a readable char steps");
                        let q2 = step(&right, *q, c).expect("a readable char steps");
                        if seen.insert((p2, q2)) {
                            let mut grown = text.clone();
                            grown.push(c);
                            next.push_back(((p2, q2), grown));
                        }
                    }
                }
            }
        }
        frontier = next;
    }
    None
}
