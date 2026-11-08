//! The hole grammar — `interpolation-holes.ts`.
//!
//! A hole opens at `${{` and closes at the first `}}` that is outside a quoted literal
//! and outside any `{` the expression itself opened. The reader has no literal rule of
//! its own: it asks the engine (`quoted_literal_end`, the twin of `quotedLiteralEnd`),
//! so a literal ends where the language ends it. A comment is not read.
//!
//! **Offsets are in both units.** Node's offsets are UTF-16 code units; a Rust caller
//! slices by byte. Each hole carries `start`, `end` and `expr_start` in code units, as
//! Node's, and `byte_start`, `byte_end` and `expr_byte_start` beside them; a reading
//! failure carries its offset both ways. The expression is trimmed by ECMAScript's
//! whitespace (U+FEFF goes, U+0085 stays), never by `str::trim`.

use telorun_cel::quoted_literal_end;
use telorun_cel_value::{es_trim, is_es_whitespace};

const OPEN: &str = "${{";

/// One `${{ expr }}` hole in a scalar. Offsets index the scalar's source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterpolationHole {
    /// Offset of the opening `${{`, in UTF-16 code units.
    pub start: usize,
    /// Offset just past the closing `}}`, in UTF-16 code units.
    pub end: usize,
    /// The expression, trimmed of the whitespace inside the delimiters.
    pub expr: String,
    /// Offset of `expr` within the source, in UTF-16 code units.
    pub expr_start: usize,
    /// `start`, in bytes.
    pub byte_start: usize,
    /// `end`, in bytes.
    pub byte_end: usize,
    /// `expr_start`, in bytes.
    pub expr_byte_start: usize,
}

/// What reading a scalar's holes gives: its holes, or the offset of the `${{` that
/// never closes. The failure also carries its byte offset, which Node has no use for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoleReading {
    Holes(Vec<InterpolationHole>),
    Failed { offset: usize, byte_offset: usize, message: String },
}

/// How a scalar's text relates to holes: none at all, exactly one hole with only
/// whitespace around it, holes among text, or a `${{` that opens no readable hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterpolationShape {
    None,
    LoneHole,
    Interpolated,
    Malformed,
}

/// A byte offset's UTF-16 offset, for offsets asked in increasing order.
struct UnitCounter<'s> {
    source: &'s str,
    byte: usize,
    unit: usize,
}

impl<'s> UnitCounter<'s> {
    fn new(source: &'s str) -> Self {
        UnitCounter { source, byte: 0, unit: 0 }
    }

    fn units_at(&mut self, byte: usize) -> usize {
        self.unit += self.source[self.byte..byte].encode_utf16().count();
        self.byte = byte;
        self.unit
    }
}

/// Every `${{ expr }}` hole in `source` — the one hole grammar every tag with holes
/// (`!interpolate`, `!sql`) and the untagged-interpolation migration read. A hole that
/// never closes is a reading failure at its opening offset, never a guess at where it
/// meant to end.
pub fn read_interpolation_holes(source: &str) -> HoleReading {
    let mut holes = Vec::new();
    let mut units = UnitCounter::new(source);
    let mut from = 0;
    loop {
        let Some(found) = source[from..].find(OPEN) else {
            return HoleReading::Holes(holes);
        };
        let start = from + found;
        let Some(close) = closing_offset(source, start + OPEN.len()) else {
            let offset = units.units_at(start);
            return HoleReading::Failed {
                offset,
                byte_offset: start,
                message: format!(
                    "the hole opened at offset {offset} never closes \u{2014} a hole ends at the first '}}}}' outside a string literal and outside any braces it opened"
                ),
            };
        };
        let body = &source[start + OPEN.len()..close];
        let lead = body.len() - body.trim_start_matches(is_es_whitespace).len();
        let expr_byte_start = start + OPEN.len() + lead;
        holes.push(InterpolationHole {
            start: units.units_at(start),
            end: 0,
            expr: es_trim(body).to_string(),
            expr_start: units.units_at(expr_byte_start),
            byte_start: start,
            byte_end: close + 2,
            expr_byte_start,
        });
        let last = holes.last_mut().expect("just pushed");
        last.end = units.units_at(close + 2);
        from = close + 2;
    }
}

/// The shape of `source` under [`read_interpolation_holes`].
pub fn interpolation_shape(source: &str) -> InterpolationShape {
    if !source.contains(OPEN) {
        return InterpolationShape::None;
    }
    let HoleReading::Holes(holes) = read_interpolation_holes(source) else {
        return InterpolationShape::Malformed;
    };
    let [only] = holes.as_slice() else {
        return if holes.is_empty() { InterpolationShape::None } else { InterpolationShape::Interpolated };
    };
    let lone = es_trim(&source[..only.byte_start]).is_empty() && es_trim(&source[only.byte_end..]).is_empty();
    if lone {
        InterpolationShape::LoneHole
    } else {
        InterpolationShape::Interpolated
    }
}

/// The literal text between holes: always `holes.len() + 1` fragments.
pub fn literal_fragments(source: &str, holes: &[InterpolationHole]) -> Vec<String> {
    let mut out = Vec::with_capacity(holes.len() + 1);
    let mut last = 0;
    for hole in holes {
        out.push(source[last..hole.byte_start].to_string());
        last = hole.byte_end;
    }
    out.push(source[last..].to_string());
    out
}

/// Byte offset of the `}}` closing a hole whose body starts at `from`.
fn closing_offset(source: &str, from: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = quoted_literal_end(source, i)?;
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                if depth == 0 {
                    return (bytes.get(i + 1) == Some(&b'}')).then_some(i);
                }
                depth -= 1;
            }
            _ => {}
        }
        i += 1;
    }
    None
}
