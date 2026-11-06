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

use crate::longest_text::{within_by_bytes, TextSize};
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

/// A character's full mapping, and its size.
#[derive(Clone, Copy)]
struct Mapping {
    points: [char; LONGEST_MAPPING],
    length: usize,
    size: TextSize,
}

/// Where a casing writes its characters: the text being built, or a count of its size.
trait CaseSink {
    fn put(&mut self, code: char);

    fn put_mapping(&mut self, mapping: &Mapping);
}

impl CaseSink for String {
    fn put(&mut self, code: char) {
        self.push(code);
    }

    fn put_mapping(&mut self, mapping: &Mapping) {
        self.extend(&mapping.points[..mapping.length]);
    }
}

impl CaseSink for TextSize {
    fn put(&mut self, code: char) {
        *self = self.plus(TextSize { units: code.len_utf16(), bytes: code.len_utf8() });
    }

    fn put_mapping(&mut self, mapping: &Mapping) {
        *self = self.plus(mapping.size);
    }
}

/// The longest full mapping a character has, in code points.
const LONGEST_MAPPING: usize = 3;

/// A mapping table, read with the last character looked up and its mapping remembered, so a
/// run of one character is looked up once.
struct Mappings {
    table: &'static [(u32, &'static [u32])],
    last: Option<(char, Mapping)>,
}

impl Mappings {
    fn new(table: &'static [(u32, &'static [u32])]) -> Self {
        Self { table, last: None }
    }

    /// Puts a character's full mapping, or the character itself.
    fn put(&mut self, out: &mut impl CaseSink, code: char) {
        let mapping = match self.last {
            Some((held, mapping)) if held == code => mapping,
            _ => {
                let mut points = [code; LONGEST_MAPPING];
                let mut length = 1;
                if let Ok(at) = self.table.binary_search_by_key(&u32::from(code), |&(from, _)| from) {
                    let mapped = self.table[at].1;
                    length = mapped.len();
                    for (slot, &point) in points.iter_mut().zip(mapped) {
                        *slot = char::from_u32(point).expect("a mapping is a character");
                    }
                }
                let size = points[..length].iter().fold(TextSize::default(), |size, point| {
                    size.plus(TextSize { units: point.len_utf16(), bytes: point.len_utf8() })
                });
                let mapping = Mapping { points, length, size };
                self.last = Some((code, mapping));
                mapping
            }
        };
        out.put_mapping(&mapping);
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
    cased::<Lower>(text, false).expect("a casing not held to the bound answers")
}

/// ECMAScript's `String.prototype.toUpperCase`: each character's full uppercase mapping.
pub fn es_to_upper_case(text: &str) -> String {
    cased::<Upper>(text, false).expect("a casing not held to the bound answers")
}

/// [`es_to_lower_case`] held to the longest text, or nothing where its answer would be
/// past it.
pub(crate) fn es_to_lower_case_within(text: &str) -> Option<String> {
    cased::<Lower>(text, true)
}

/// [`es_to_upper_case`] held to the longest text, or nothing where its answer would be
/// past it.
pub(crate) fn es_to_upper_case_within(text: &str) -> Option<String> {
    cased::<Upper>(text, true)
}

/// No character's full mapping is longer than three UTF-16 code units a byte of it, so a
/// text of at most a third of the longest text's length in bytes is cased unmeasured.
const CASED_UNITS_PER_BYTE: usize = 3;

/// A casing: ASCII alone, or a walk putting every character's mapping.
trait Casing {
    fn ascii(text: &str) -> String;
    fn walk(text: &str, out: &mut impl CaseSink);
}

struct Lower;
struct Upper;

impl Casing for Lower {
    fn ascii(text: &str) -> String {
        text.to_ascii_lowercase()
    }

    fn walk(text: &str, out: &mut impl CaseSink) {
        let mut mappings = Mappings::new(LOWERCASE_MAPPINGS);
        for (at, code) in text.char_indices() {
            if code.is_ascii() {
                out.put(code.to_ascii_lowercase());
            } else if code == CAPITAL_SIGMA {
                let after = &text[at + code.len_utf8()..];
                let ends_a_word = cased_beyond(text[..at].chars().rev()) && !cased_beyond(after.chars());
                out.put(if ends_a_word { FINAL_SIGMA } else { SMALL_SIGMA });
            } else {
                mappings.put(out, code);
            }
        }
    }
}

impl Casing for Upper {
    fn ascii(text: &str) -> String {
        text.to_ascii_uppercase()
    }

    fn walk(text: &str, out: &mut impl CaseSink) {
        let mut mappings = Mappings::new(UPPERCASE_MAPPINGS);
        for code in text.chars() {
            if code.is_ascii() {
                out.put(code.to_ascii_uppercase());
            } else {
                mappings.put(out, code);
            }
        }
    }
}

/// A casing, held to the longest text where `bounded`: measured, without writing, only where
/// its worst case is past the bound, and then built at exactly its size.
fn cased<C: Casing>(text: &str, bounded: bool) -> Option<String> {
    if text.is_ascii() {
        return Some(C::ascii(text));
    }
    if !bounded || within_by_bytes(text.len().saturating_mul(CASED_UNITS_PER_BYTE)) {
        let mut out = String::new();
        C::walk(text, &mut out);
        return Some(out);
    }
    let mut size = TextSize::default();
    C::walk(text, &mut size);
    if size.exceeds() {
        return None;
    }
    let mut out = String::with_capacity(size.bytes);
    C::walk(text, &mut out);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bound [`cased`] skips measuring under.
    #[test]
    fn no_mapping_is_longer_than_three_code_units_a_byte() {
        for (from, to) in LOWERCASE_MAPPINGS.iter().chain(UPPERCASE_MAPPINGS) {
            let from = char::from_u32(*from).unwrap();
            let units: usize = to.iter().map(|&code| char::from_u32(code).unwrap().len_utf16()).sum();
            assert!(units <= CASED_UNITS_PER_BYTE * from.len_utf8(), "{from:?}");
        }
    }

    #[test]
    fn no_mapping_is_longer_than_the_longest_mapping() {
        for (_, to) in LOWERCASE_MAPPINGS.iter().chain(UPPERCASE_MAPPINGS) {
            assert!(to.len() <= LONGEST_MAPPING);
        }
    }

    #[test]
    fn measures_a_casing_as_it_writes_it() {
        for text in ["", "abc", "ß", "İ", "ΐﬃ", "ΑΣ ΑΣΑ Σ", "𐐀𐐨", "K\u{212a}ẞ"] {
            let (mut lower, mut upper) = (TextSize::default(), TextSize::default());
            Lower::walk(text, &mut lower);
            Upper::walk(text, &mut upper);
            assert_eq!(lower, TextSize::of(&es_to_lower_case(text)), "{text}");
            assert_eq!(upper, TextSize::of(&es_to_upper_case(text)), "{text}");
        }
    }
}
