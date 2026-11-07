//! No Node twin: the longest text a string can hold — the role of V8's longest string,
//! 536,870,888 UTF-16 code units, past which Node's host refuses to build one.
//!
//! Every text the engine builds that can come out longer than its longest input is held
//! to it, and its length is found **before any storage for it is allocated**: within the
//! bound the text is built, past it the call answers
//! `<function>: the text built would exceed the longest text a string can hold (536870888
//! UTF-16 code units)`, `invalid_argument`. A length is a text's UTF-16 length, so a
//! character outside the basic plane counts twice; a text's UTF-8 length is never less,
//! which is what lets a builder skip measuring where its worst case is within the bound.

use telorun_cel_value::CelEvaluationCode;

/// The longest text a string can hold, in UTF-16 code units.
pub(crate) const LONGEST_TEXT: usize = 536_870_888;

/// The refusal of a text built past [`LONGEST_TEXT`], by the function building it.
pub(crate) fn text_too_long(what: &str) -> String {
    format!("{what}: the text built would exceed the longest text a string can hold ({LONGEST_TEXT} UTF-16 code units)")
}

/// The code a text built past the bound answers with.
pub(crate) const TEXT_TOO_LONG_CODE: CelEvaluationCode = CelEvaluationCode::InvalidArgument;

/// A text's size before it is built: its UTF-16 length, by which it is judged, and its
/// UTF-8 length, which is what its storage is reserved at. Sums and products saturate, so
/// a size past any memory still reads as past the bound.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct TextSize {
    pub(crate) units: usize,
    pub(crate) bytes: usize,
}

impl TextSize {
    /// The size of a text that exists.
    pub(crate) fn of(text: &str) -> Self {
        Self { units: utf16_length(text), bytes: text.len() }
    }

    /// The size of a text of one byte per code unit, as ASCII is.
    pub(crate) fn ascii(length: usize) -> Self {
        Self { units: length, bytes: length }
    }

    pub(crate) fn plus(self, other: Self) -> Self {
        Self { units: self.units.saturating_add(other.units), bytes: self.bytes.saturating_add(other.bytes) }
    }

    pub(crate) fn minus(self, other: Self) -> Self {
        Self { units: self.units.saturating_sub(other.units), bytes: self.bytes.saturating_sub(other.bytes) }
    }

    pub(crate) fn times(self, count: usize) -> Self {
        Self { units: self.units.saturating_mul(count), bytes: self.bytes.saturating_mul(count) }
    }

    /// Whether a text of this size is past the bound.
    pub(crate) fn exceeds(self) -> bool {
        self.units > LONGEST_TEXT
    }
}

/// A text's UTF-16 length: one unit per character, and a second for each character of four
/// bytes, whose lead byte is the one at or above `0xF0`. Read eight bytes at a time.
pub(crate) fn utf16_length(text: &str) -> usize {
    if text.is_ascii() {
        return text.len();
    }
    const HIGH_BITS: u64 = 0x8080_8080_8080_8080;
    let bytes = text.as_bytes();
    let mut chunks = bytes.chunks_exact(8);
    let mut four_byte_leads = 0;
    for chunk in &mut chunks {
        let word = u64::from_le_bytes(chunk.try_into().expect("a chunk of eight bytes"));
        four_byte_leads += (word & (word << 1) & (word << 2) & (word << 3) & HIGH_BITS).count_ones() as usize;
    }
    four_byte_leads += chunks.remainder().iter().filter(|&&byte| byte >= 0xf0).count();
    text.chars().count() + four_byte_leads
}

/// Whether a text whose UTF-8 length is at most `bytes` is within the bound, without
/// counting it: its UTF-16 length is never more.
pub(crate) fn within_by_bytes(bytes: usize) -> bool {
    bytes <= LONGEST_TEXT
}

/// The size of the text bytes decode to, as `bytes_to_text` decodes them — a byte-order
/// mark at the start dropped — or nothing where they are not UTF-8.
pub(crate) fn decoded_size(bytes: &[u8]) -> Option<TextSize> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Some(TextSize::of(text))
}

/// The size of a text written as a JSON string, as `json_quote` writes it: the quotes, a
/// two-character escape for `"`, `\` and the five named controls, six characters for any
/// other control, and every other character as itself. The escapes are counted eight bytes
/// at a time.
pub(crate) fn json_quoted_size(text: &str) -> TextSize {
    const NAMED_CONTROLS: [u8; 5] = [0x08, 0x0c, b'\n', b'\r', b'\t'];
    let bytes = text.as_bytes();
    let mut chunks = bytes.chunks_exact(8);
    // `"` and `\`, the named controls, and every control.
    let (mut marks, mut named, mut controls) = (0usize, 0usize, 0usize);
    for chunk in &mut chunks {
        let word = u64::from_le_bytes(chunk.try_into().expect("a chunk of eight bytes"));
        marks += bytes_equal(word, b'"') + bytes_equal(word, b'\\');
        named += NAMED_CONTROLS.iter().map(|&control| bytes_equal(word, control)).sum::<usize>();
        // A control has its three high bits clear.
        controls += zero_bytes(word & 0xe0e0_e0e0_e0e0_e0e0);
    }
    for &byte in chunks.remainder() {
        marks += usize::from(byte == b'"' || byte == b'\\');
        named += usize::from(NAMED_CONTROLS.contains(&byte));
        controls += usize::from(byte < 0x20);
    }
    // Each escape is ASCII: one character more for a mark or a named control, five more for
    // any other control.
    let escapes = TextSize::ascii(marks + named + (controls - named) * 5);
    TextSize::of(text).plus(TextSize::ascii(2)).plus(escapes)
}

/// How many of a word's eight bytes are zero.
fn zero_bytes(word: u64) -> usize {
    const LOW_BITS: u64 = 0x7f7f_7f7f_7f7f_7f7f;
    // A byte's high bit is set here exactly when the byte is not zero; nothing carries.
    let nonzero = ((word & LOW_BITS) + LOW_BITS) | word;
    8 - (nonzero & !LOW_BITS).count_ones() as usize
}

/// How many of a word's eight bytes are `byte`.
fn bytes_equal(word: u64, byte: u8) -> usize {
    zero_bytes(word ^ (u64::from(byte) * 0x0101_0101_0101_0101))
}

/// The worst case of [`json_quoted_size`]: six characters a byte, and the quotes.
pub(crate) fn json_quoted_worst(bytes: usize) -> usize {
    bytes.saturating_mul(6).saturating_add(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use telorun_cel_value::json_quote;

    #[test]
    fn counts_a_text_in_utf16_code_units() {
        for text in ["", "a", "ß", "İ", "€", "😀", "a😀b€ß", "\u{10ffff}\u{ffff}", "😀😀😀😀😀😀😀😀😀a", "abcdefg😀", "ßßßßßßßß😀"] {
            assert_eq!(utf16_length(text), text.encode_utf16().count(), "{text}");
        }
    }

    #[test]
    fn measures_a_json_string_as_json_quote_writes_it() {
        let every_control: String = (0u8..0x20).map(char::from).collect();
        for text in ["", "a\"b\\c", "\u{08}\u{0c}\n\r\t", &every_control, "😀ß\u{7f}\u{2028}"] {
            assert_eq!(json_quoted_size(text), TextSize::of(&json_quote(text)), "{text:?}");
            assert!(json_quoted_size(text).bytes <= json_quoted_worst(text.len()));
        }
    }

    #[test]
    fn measures_decoded_bytes_without_their_byte_order_mark() {
        assert_eq!(decoded_size("\u{feff}a😀".as_bytes()), Some(TextSize { units: 3, bytes: 5 }));
        assert_eq!(decoded_size(b"\xff"), None);
    }

    #[test]
    fn holds_a_text_of_the_longest_length_and_refuses_one_past_it() {
        assert!(!TextSize::ascii(LONGEST_TEXT).exceeds());
        assert!(TextSize::ascii(LONGEST_TEXT + 1).exceeds());
        assert!(TextSize::ascii(usize::MAX).times(3).exceeds());
    }
}
