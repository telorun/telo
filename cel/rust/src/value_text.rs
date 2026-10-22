//! Text: how a value is written as a string, and how text becomes bytes —
//! `value-text.ts`, its engine half.
//!
//! The value crate's `value_text.rs` holds the file's own items — `text_to_bytes`,
//! `bytes_to_text`, `double_text`, re-exported here — and ECMAScript's number text,
//! quoting, whitespace and string order. What needs the engine's Unicode data
//! lives here: ECMAScript's `toLowerCase` and `toUpperCase`, which Node takes from its
//! host and the library's `lowerAscii` / `upperAscii` answer with.
//!
//! **The casing is the engine's own, Unicode 17.0** (`unicode_tables.rs`): every code
//! point's full mapping, and the one condition a language-insensitive casing applies —
//! Final_Sigma, which lowers `Σ` to `ς` at the end of a word. Node answers with its
//! host's Unicode version, 17.0 on the reference host; a host on another version may
//! case a character this engine cases differently, and this engine answers with its own.

pub use telorun_cel_value::{bytes_to_text, double_text, text_to_bytes};
pub(crate) use telorun_cel_value::{es_string_to_number, es_trim, json_quote};

use crate::unicode_tables::{CASED, CASE_IGNORABLE, LOWERCASE_MAPPINGS, UPPERCASE_MAPPINGS};

const CAPITAL_SIGMA: char = '\u{3a3}';
const FINAL_SIGMA: char = '\u{3c2}';
const SMALL_SIGMA: char = '\u{3c3}';

fn holds(table: &[(u32, u32)], code: char) -> bool {
    let code = u32::from(code);
    table
        .binary_search_by(|&(low, high)| {
            if high < code {
                std::cmp::Ordering::Less
            } else if low > code {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Appends a character's full mapping in `table`, or the character itself.
fn push_mapped(out: &mut String, table: &[(u32, &[u32])], code: char) {
    match table.binary_search_by_key(&u32::from(code), |&(from, _)| from) {
        Ok(at) => out.extend(table[at].1.iter().map(|&mapped| char::from_u32(mapped).expect("a mapping is a character"))),
        Err(_) => out.push(code),
    }
}

/// Whether the first character of `characters` that is not case-ignorable is cased.
/// A character that is both is passed over as ignorable, as the reference host's
/// casing reads the condition.
fn cased_beyond(mut characters: impl Iterator<Item = char>) -> bool {
    characters.find(|&code| !holds(CASE_IGNORABLE, code)).is_some_and(|code| holds(CASED, code))
}

/// ECMAScript's `String.prototype.toLowerCase`: each character's full lowercase
/// mapping, and `Σ` as `ς` where a cased letter comes before it and none after it,
/// case-ignorable characters between.
pub fn es_to_lower_case(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    let mut out = String::with_capacity(text.len());
    for (at, code) in text.char_indices() {
        if code.is_ascii() {
            out.push(code.to_ascii_lowercase());
        } else if code == CAPITAL_SIGMA {
            let after = &text[at + code.len_utf8()..];
            let ends_a_word = cased_beyond(text[..at].chars().rev()) && !cased_beyond(after.chars());
            out.push(if ends_a_word { FINAL_SIGMA } else { SMALL_SIGMA });
        } else {
            push_mapped(&mut out, LOWERCASE_MAPPINGS, code);
        }
    }
    out
}

/// ECMAScript's `String.prototype.toUpperCase`: each character's full uppercase mapping.
pub fn es_to_upper_case(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_uppercase();
    }
    let mut out = String::with_capacity(text.len());
    for code in text.chars() {
        if code.is_ascii() {
            out.push(code.to_ascii_uppercase());
        } else {
            push_mapped(&mut out, UPPERCASE_MAPPINGS, code);
        }
    }
    out
}
