//! `String.prototype.localeCompare` under the root collation, for the names
//! the Node twin sorts with it (ecosystems, anchors, tags).
//!
//! No Node twin: JavaScript ships the collation in its engine. ASCII is
//! ordered as ICU's root order puts it — whitespace, punctuation, symbols,
//! digits, letters with lowercase first — compared on every character before
//! case decides; controls are ignored. Any other character sorts after ASCII
//! by its code point, which is where this differs from ICU.

use std::cmp::Ordering;

const ROOT_ORDER: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

fn primary(c: char) -> Option<u32> {
    if c.is_ascii_control() && !matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r') {
        return None;
    }
    let lower = c.to_ascii_lowercase();
    match ROOT_ORDER.find(lower) {
        Some(at) if c.is_ascii() => Some(at as u32),
        _ => Some(1000 + c as u32),
    }
}

fn keys(text: &str) -> (Vec<u32>, Vec<u8>) {
    let mut weights = Vec::new();
    let mut cases = Vec::new();
    for c in text.chars() {
        if let Some(weight) = primary(c) {
            weights.push(weight);
            cases.push(u8::from(c.is_uppercase()));
        }
    }
    (weights, cases)
}

pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (wa, ca) = keys(a);
    let (wb, cb) = keys(b);
    wa.cmp(&wb).then_with(|| ca.cmp(&cb))
}
