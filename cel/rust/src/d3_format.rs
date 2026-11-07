//! No Node twin: the role of Node's dependency `d3-format` 3.1.2, the number-formatting
//! specifier grammar `catalog-runtime.ts` formats through, under the locale it pins —
//! decimal `.`, thousands `,` grouped by three, currency `$` before, minus `-`, percent `%`,
//! `NaN` for a value that is not a number. Recorded against d3-format 3.1.2 under Node
//! v24.11.1 (V8 13.6.233.10-node.28).
//!
//! **The specifier is read as d3's pattern reads it**, `[[fill]align][sign][symbol][0][width]
//! [,][.precision][~][type]` under JavaScript's case-insensitive mode: a fill is one UTF-16
//! code unit that is not a line terminator, so a character outside the basic plane can never
//! be one; a fill and an alignment the rest cannot follow give way to an alignment alone,
//! then to neither; a type letter folds over ASCII alone, and is kept as written (`E` is no
//! type d3 knows). A text the pattern refuses is an invalid specifier.
//!
//! **Formatting is d3's, step for step**: every type `efgrs%pbodxXcn`, any other letter and
//! none read as `.12~g`; `~` trimming, `#` prefixes, `$`, grouping, the sign forms, zero
//! padding, the alignments and the width, counted in UTF-16 code units; SI prefixes from
//! `y` to `Y`, the exponent kept per call where d3 keeps it in a module variable; a negative
//! value that formats as zero loses its sign, judged by ECMAScript's `Number()` of the text.
//! The number methods are `es_number_text.rs`.
//!
//! **A width past the longest text a string holds** — `longest_text.rs`, V8's limit — is
//! too long where the padding would be written, which is wherever the width is
//! more than the number's own text; d3 throws V8's `RangeError` there. Each operation has its
//! own refusal, worded by the caller: reading a specifier answers `InvalidSpecifier`, and
//! formatting a value `TooLong`, carrying the width as d3 read it.
//!
//! Formatters are kept in one process-wide cache of `FORMATTER_CACHE_CAPACITY` (256)
//! entries keyed by the specifier as written; a hit is a borrowed lookup, and a refusal is
//! never kept.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock};

use telorun_cel_value::es_number;

use crate::bounded_cache::BoundedCache;
use crate::es_number_text::{
    math_round, radix_integer_text, to_exponential, to_fixed, to_precision, whole_number_digits,
};
use crate::longest_text::LONGEST_TEXT;
use crate::value_text::es_string_to_number;

/// How many formatters the process keeps.
pub(crate) const FORMATTER_CACHE_CAPACITY: usize = 256;

/// d3's pattern does not read the specifier.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct InvalidSpecifier;

/// The padded text would be longer than a string holds.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct TooLong {
    /// The width the specifier wrote, as d3 read it.
    pub(crate) width: f64,
}

/// The type a formatter writes with, once `n`, an unknown letter and none are read as `g`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FormatType {
    Percent,
    Binary,
    Char,
    Decimal,
    Exponent,
    Fixed,
    General,
    Octal,
    PercentRounded,
    Rounded,
    SiPrefix,
    HexUpper,
    HexLower,
}

impl FormatType {
    fn of(letter: u8) -> Option<FormatType> {
        Some(match letter {
            b'%' => FormatType::Percent,
            b'b' => FormatType::Binary,
            b'c' => FormatType::Char,
            b'd' => FormatType::Decimal,
            b'e' => FormatType::Exponent,
            b'f' => FormatType::Fixed,
            b'g' => FormatType::General,
            b'o' => FormatType::Octal,
            b'p' => FormatType::PercentRounded,
            b'r' => FormatType::Rounded,
            b's' => FormatType::SiPrefix,
            b'X' => FormatType::HexUpper,
            b'x' => FormatType::HexLower,
            _ => return None,
        })
    }

    /// d3's `/[defgprs%]/`: a type whose text may hold a point or an exponent.
    fn may_hold_suffix(self) -> bool {
        !matches!(self, FormatType::Binary | FormatType::Char | FormatType::Octal | FormatType::HexUpper | FormatType::HexLower)
    }

    /// d3's `/[gprs]/`: a type whose precision counts significant digits.
    fn counts_significant(self) -> bool {
        matches!(self, FormatType::General | FormatType::PercentRounded | FormatType::Rounded | FormatType::SiPrefix)
    }
}

/// The groups of d3's specifier pattern, as written.
struct Groups<'a> {
    fill: Option<char>,
    align: Option<u8>,
    sign: Option<u8>,
    symbol: Option<u8>,
    zero: bool,
    width: Option<&'a str>,
    comma: bool,
    precision: Option<&'a str>,
    trim: bool,
    letter: Option<u8>,
}

/// What `.` matches without the `s` flag: one UTF-16 code unit other than a line terminator.
fn reads_as_fill(c: char) -> bool {
    c.len_utf16() == 1 && !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn is_align(c: char) -> bool {
    matches!(c, '<' | '>' | '=' | '^')
}

/// `([+\-( ])?([$#])?(0)?(\d+)?(,)?(\.\d+)?(~)?([a-z%])?$` from the start of `text`. Each
/// group is taken greedily: none can give back what a later group would read.
fn read_after_align<'a>(text: &'a str, fill: Option<char>, align: Option<u8>) -> Option<Groups<'a>> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let take = |at: &mut usize, accepts: &dyn Fn(u8) -> bool| -> Option<u8> {
        let byte = *bytes.get(*at)?;
        accepts(byte).then(|| {
            *at += 1;
            byte
        })
    };
    let sign = take(&mut at, &|b| matches!(b, b'+' | b'-' | b'(' | b' '));
    let symbol = take(&mut at, &|b| matches!(b, b'$' | b'#'));
    let zero = take(&mut at, &|b| b == b'0').is_some();
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let width_len = digits(at);
    let width = (width_len > 0).then(|| &text[at..at + width_len]);
    at += width_len;
    let comma = take(&mut at, &|b| b == b',').is_some();
    let mut precision = None;
    if bytes.get(at) == Some(&b'.') {
        let len = digits(at + 1);
        if len > 0 {
            precision = Some(&text[at + 1..at + 1 + len]);
            at += 1 + len;
        }
    }
    let trim = take(&mut at, &|b| b == b'~').is_some();
    let letter = take(&mut at, &|b| b.is_ascii_alphabetic() || b == b'%');
    (at == bytes.len()).then_some(Groups { fill, align, sign, symbol, zero, width, comma, precision, trim, letter })
}

/// d3's `formatSpecifier` pattern, with the backtracking JavaScript's engine does over its
/// optional fill and alignment.
fn read_specifier(text: &str) -> Option<Groups<'_>> {
    let mut chars = text.chars();
    let first = chars.next();
    let second = chars.next();
    if let (Some(fill), Some(align)) = (first, second) {
        if reads_as_fill(fill) && is_align(align) {
            let rest = &text[fill.len_utf8() + 1..];
            if let Some(groups) = read_after_align(rest, Some(fill), Some(align as u8)) {
                return Some(groups);
            }
        }
    }
    if let Some(align) = first.filter(|c| is_align(*c)) {
        if let Some(groups) = read_after_align(&text[1..], None, Some(align as u8)) {
            return Some(groups);
        }
    }
    read_after_align(text, None, None)
}

/// A specifier read and prepared, as d3's `newFormat` prepares it.
#[derive(Debug)]
pub(crate) struct D3Format {
    fill: char,
    align: u8,
    sign: u8,
    zero: bool,
    width: Option<f64>,
    comma: bool,
    precision: usize,
    trim: bool,
    format_type: FormatType,
    prefix: &'static str,
    suffix: &'static str,
}

const SI_PREFIXES: [&str; 17] = ["y", "z", "a", "f", "p", "n", "µ", "m", "", "k", "M", "G", "T", "P", "E", "Z", "Y"];

/// Reads a specifier as d3's `format(specifier)` does.
pub(crate) fn parse_format(specifier: &str) -> Result<D3Format, InvalidSpecifier> {
    let groups = read_specifier(specifier).ok_or(InvalidSpecifier)?;
    let mut comma = groups.comma;
    let mut trim = groups.trim;
    let mut precision = groups.precision.map(es_string_to_number);
    let format_type = match groups.letter {
        Some(b'n') => {
            comma = true;
            FormatType::General
        }
        letter => match letter.and_then(FormatType::of) {
            Some(known) => known,
            None => {
                precision.get_or_insert(12.0);
                trim = true;
                FormatType::General
            }
        },
    };
    let mut fill = groups.fill.unwrap_or(' ');
    let mut align = groups.align.unwrap_or(b'>');
    let mut zero = groups.zero;
    if zero || (fill == '0' && align == b'=') {
        zero = true;
        fill = '0';
        align = b'=';
    }
    let prefix = match (groups.symbol, format_type) {
        (Some(b'$'), _) => "$",
        (Some(b'#'), FormatType::Binary) => "0b",
        (Some(b'#'), FormatType::Octal) => "0o",
        (Some(b'#'), FormatType::HexUpper | FormatType::HexLower) => "0x",
        _ => "",
    };
    let suffix = match (groups.symbol, format_type) {
        (Some(b'$'), _) => "",
        (_, FormatType::Percent | FormatType::PercentRounded) => "%",
        _ => "",
    };
    let precision = match precision {
        None => 6.0,
        Some(p) if format_type.counts_significant() => p.min(21.0).max(1.0),
        Some(p) => p.min(20.0).max(0.0),
    } as usize;
    Ok(D3Format {
        fill,
        align,
        sign: groups.sign.unwrap_or(b'-'),
        zero,
        width: groups.width.map(es_string_to_number),
        comma,
        precision,
        trim,
        format_type,
        prefix,
        suffix,
    })
}

fn formatter_cache() -> &'static Mutex<BoundedCache<Arc<str>, Arc<D3Format>>> {
    static CACHE: OnceLock<Mutex<BoundedCache<Arc<str>, Arc<D3Format>>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let capacity = NonZeroUsize::new(FORMATTER_CACHE_CAPACITY).expect("the formatter cache holds an entry");
        Mutex::new(BoundedCache::new(capacity))
    })
}

const CACHE_LOCK: &str = "the formatter cache's lock is held only to read or write an entry";

/// The formatter for a specifier, from the process's cache or read and kept there.
pub(crate) fn d3_formatter(specifier: &str) -> Result<Arc<D3Format>, InvalidSpecifier> {
    if let Some(held) = formatter_cache().lock().expect(CACHE_LOCK).get(specifier) {
        return Ok(Arc::clone(held));
    }
    let built = Arc::new(parse_format(specifier)?);
    formatter_cache().lock().expect(CACHE_LOCK).set(Arc::from(specifier), Arc::clone(&built));
    Ok(built)
}

/// d3's `formatDecimalParts`: the significant digits and exponent of a positive finite
/// value, `digits` of them or, with none, the shortest; nothing for zero or a value that is
/// not finite.
fn decimal_parts(value: f64, digits: usize) -> Option<(String, i32)> {
    if !value.is_finite() || value == 0.0 {
        return None;
    }
    let text = to_exponential(value, digits.checked_sub(1));
    let (mantissa, exponent) = text.split_once('e').expect("exponent notation");
    let coefficient = mantissa.replace('.', "");
    Some((coefficient, exponent.parse().expect("the exponent is an integer")))
}

/// d3's `formatRounded`.
fn format_rounded(value: f64, digits: usize) -> String {
    let Some((coefficient, exponent)) = decimal_parts(value, digits) else { return es_number(value) };
    if exponent < 0 {
        format!("0.{}{coefficient}", "0".repeat((-exponent - 1) as usize))
    } else if coefficient.len() > exponent as usize + 1 {
        let at = exponent as usize + 1;
        format!("{}.{}", &coefficient[..at], &coefficient[at..])
    } else {
        let zeros = exponent as usize + 1 - coefficient.len();
        format!("{coefficient}{}", "0".repeat(zeros))
    }
}

/// d3's `formatPrefixAuto`, answering the SI exponent beside the text — d3's
/// `prefixExponent`, `None` where d3 leaves it undefined.
fn format_prefix_auto(value: f64, digits: usize) -> (String, Option<i32>) {
    let Some((coefficient, exponent)) = decimal_parts(value, digits) else {
        return (to_precision(value, digits), None);
    };
    let prefix_exponent = exponent.div_euclid(3).clamp(-8, 8);
    let i = exponent - prefix_exponent * 3 + 1;
    let n = coefficient.len() as i32;
    let text = if i == n {
        coefficient
    } else if i > n {
        format!("{coefficient}{}", "0".repeat((i - n) as usize))
    } else if i > 0 {
        format!("{}.{}", &coefficient[..i as usize], &coefficient[i as usize..])
    } else {
        let rest = decimal_parts(value, (digits as i32 + i - 1).max(0) as usize).expect("a finite value other than zero").0;
        format!("0.{}{rest}", "0".repeat((-i) as usize))
    };
    (text, Some(prefix_exponent * 3))
}

/// d3's `formatDecimal` of a magnitude: `toString` of the nearest whole number, or
/// `toLocaleString("en")` without separators at or above 10^21.
fn format_decimal(magnitude: f64) -> String {
    whole_number_digits(math_round(magnitude))
}

/// d3's `formatTrim`: insignificant zeros after the point removed, `1.2000k` to `1.2k`.
fn trim_zeros(text: String) -> String {
    let bytes = text.as_bytes();
    let (mut first_zero, mut last_zero): (isize, isize) = (-1, 0);
    for (i, byte) in bytes.iter().enumerate().skip(1) {
        match byte {
            b'.' => {
                first_zero = i as isize;
                last_zero = i as isize;
            }
            b'0' => {
                if first_zero == 0 {
                    first_zero = i as isize;
                }
                last_zero = i as isize;
            }
            b'1'..=b'9' => {
                if first_zero > 0 {
                    first_zero = 0;
                }
            }
            _ => break,
        }
    }
    if first_zero > 0 {
        format!("{}{}", &text[..first_zero as usize], &text[last_zero as usize + 1..])
    } else {
        text
    }
}

/// d3's `formatGroup` over the pinned grouping of three: the digits split by commas from
/// the right, within `width` code units where the text came with padding.
fn group(value: &str, width: f64) -> String {
    let mut i = value.len() as i64;
    let mut parts: Vec<&str> = Vec::new();
    let mut length = 0f64;
    let mut size = 3i64;
    while i > 0 && size > 0 {
        if length + size as f64 + 1.0 > width {
            size = ((width - length) as i64).max(1);
        }
        i -= size;
        let from = i.max(0) as usize;
        let to = (i + size).max(0) as usize;
        parts.push(&value[from..to.min(value.len())]);
        length += size as f64 + 1.0;
        if length > width {
            break;
        }
        size = 3;
    }
    parts.reverse();
    parts.join(",")
}

/// Whether padding a text of `length` code units to `width` writes more than a string holds.
fn pads_past_longest_text(length: f64, width: f64) -> bool {
    length < width && width > LONGEST_TEXT as f64
}

fn code_units(text: &str) -> usize {
    if text.is_ascii() {
        text.len()
    } else {
        text.encode_utf16().count()
    }
}

impl D3Format {
    /// The text d3's formatter answers for a value, or `TooLong` where it would throw.
    pub(crate) fn format(&self, value: f64) -> Result<String, TooLong> {
        let mut value_prefix: String;
        let mut value_suffix: String;
        let mut value_text: String;
        if self.format_type == FormatType::Char {
            value_prefix = self.prefix.to_owned();
            value_suffix = format!("{}{}", es_number(value), self.suffix);
            value_text = String::new();
        } else {
            let mut negative = value < 0.0 || (value == 0.0 && value.is_sign_negative());
            let mut prefix_exponent = None;
            let mut text = if value.is_nan() {
                "NaN".to_owned()
            } else {
                let magnitude = value.abs();
                let p = self.precision;
                match self.format_type {
                    FormatType::Percent => to_fixed(magnitude * 100.0, p),
                    FormatType::Binary => radix_integer_text(math_round(magnitude), 2),
                    FormatType::Decimal => format_decimal(magnitude),
                    FormatType::Exponent => to_exponential(magnitude, Some(p)),
                    FormatType::Fixed => to_fixed(magnitude, p),
                    FormatType::General => to_precision(magnitude, p),
                    FormatType::Octal => radix_integer_text(math_round(magnitude), 8),
                    FormatType::PercentRounded => format_rounded(magnitude * 100.0, p),
                    FormatType::Rounded => format_rounded(magnitude, p),
                    FormatType::SiPrefix => {
                        let (text, exponent) = format_prefix_auto(magnitude, p);
                        prefix_exponent = exponent;
                        text
                    }
                    FormatType::HexUpper => radix_integer_text(math_round(magnitude), 16).to_ascii_uppercase(),
                    FormatType::HexLower => radix_integer_text(math_round(magnitude), 16),
                    FormatType::Char => unreachable!("the character type is written above"),
                }
            };
            if self.trim {
                text = trim_zeros(text);
            }
            if negative && es_string_to_number(&text) == 0.0 && self.sign != b'+' {
                negative = false;
            }
            value_prefix = match (negative, self.sign) {
                (true, b'(') => "(".to_owned(),
                (true, _) => "-".to_owned(),
                (false, b'-' | b'(') => String::new(),
                (false, sign) => (sign as char).to_string(),
            };
            value_prefix.push_str(self.prefix);
            let si = match prefix_exponent {
                Some(exponent) if self.format_type == FormatType::SiPrefix && !es_string_to_number(&text).is_nan() => {
                    SI_PREFIXES[(8 + exponent / 3) as usize]
                }
                _ => "",
            };
            value_suffix = format!("{si}{}{}", self.suffix, if negative && self.sign == b'(' { ")" } else { "" });
            if self.format_type.may_hold_suffix() {
                // The locale's decimal mark is the point itself, so the tail moves as written.
                if let Some(at) = text.bytes().position(|byte| !byte.is_ascii_digit()) {
                    value_suffix.insert_str(0, &text[at..]);
                    text.truncate(at);
                }
            }
            value_text = text;
        }
        if self.comma && !self.zero {
            value_text = group(&value_text, f64::INFINITY);
        }
        let length = (code_units(&value_prefix) + value_text.len() + code_units(&value_suffix)) as f64;
        let mut padding = String::new();
        if let Some(width) = self.width.filter(|width| length < *width) {
            if pads_past_longest_text(length, width) {
                return Err(TooLong { width });
            }
            padding = std::iter::repeat(self.fill).take((width - length) as usize).collect();
        }
        if self.comma && self.zero {
            let bound = match self.width {
                Some(width) if !padding.is_empty() => width - code_units(&value_suffix) as f64,
                _ => f64::INFINITY,
            };
            value_text = group(&format!("{padding}{value_text}"), bound);
            padding.clear();
        }
        Ok(match self.align {
            b'<' => format!("{value_prefix}{value_text}{value_suffix}{padding}"),
            b'=' => format!("{value_prefix}{padding}{value_text}{value_suffix}"),
            b'^' => {
                let half = padding.chars().count() >> 1;
                let split = padding.char_indices().nth(half).map_or(padding.len(), |(at, _)| at);
                format!("{}{value_prefix}{value_text}{value_suffix}{}", &padding[..split], &padding[split..])
            }
            _ => format!("{padding}{value_prefix}{value_text}{value_suffix}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    use super::*;

    struct Counting;

    thread_local! {
        static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    }

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|n| n.set(n.get() + 1));
            System.alloc(layout)
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            System.dealloc(pointer, layout)
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|n| n.set(n.get() + 1));
            System.realloc(pointer, layout, size)
        }
    }

    // Counts this crate's test binary's allocations per thread.
    #[global_allocator]
    static COUNTING: Counting = Counting;

    fn allocations_during(run: impl FnOnce()) -> usize {
        let before = ALLOCATIONS.with(Cell::get);
        run();
        ALLOCATIONS.with(Cell::get) - before
    }

    fn fnv(text: &str) -> u64 {
        text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3))
    }

    fn answer(format: &D3Format, value: f64) -> String {
        match format.format(value) {
            Ok(text) => text,
            Err(TooLong { .. }) => "TOOLONG".into(),
        }
    }

    #[test]
    fn every_specifier_reads_and_formats_as_d3() {
        let mut wrong = Vec::new();
        for &(specifier, digest) in D3_SPECIFIERS {
            let answers = match parse_format(specifier) {
                Err(InvalidSpecifier) => None,
                Ok(format) => Some(D3_VALUES.iter().map(|bits| answer(&format, f64::from_bits(*bits))).collect::<Vec<_>>()),
            };
            if answers.as_ref().map(|answers| fnv(&answers.join("\n"))) != digest {
                wrong.push(format!("{specifier:?}: {answers:?}"));
            }
        }
        assert!(wrong.is_empty(), "{} of {} specifiers answer otherwise:\n{}", wrong.len(), D3_SPECIFIERS.len(), wrong.join("\n"));
    }

    #[test]
    fn each_recorded_row_formats_as_d3() {
        for &(specifier, bits, expected) in D3_ROWS {
            let format = parse_format(specifier).expect("a recorded specifier reads");
            assert_eq!(answer(&format, f64::from_bits(bits)), expected, "{specifier:?} of {:e}", f64::from_bits(bits));
        }
    }

    #[test]
    fn the_longest_text_is_padded_to_and_no_further() {
        let longest = LONGEST_TEXT as f64;
        assert!(!pads_past_longest_text(1.0, longest));
        assert!(pads_past_longest_text(1.0, longest + 1.0));
        assert!(pads_past_longest_text(1.0, f64::INFINITY));
        // A text as long as its width is not padded, whatever the width.
        assert!(!pads_past_longest_text(longest + 1.0, longest + 1.0));
        // Recorded: d3 pads `1` to a million code units, the number last.
        let padded = parse_format("1000000").expect("a width").format(1.0).expect("within the limit");
        assert_eq!((padded.len(), &padded[padded.len() - 3..]), (1_000_000, "  1"));
    }

    #[test]
    fn the_cache_keeps_what_reads_and_a_hit_allocates_only_the_answer() {
        // One test, so that no other test's formatters move this one's entries.
        let held = d3_formatter("$,.7f").expect("a specifier");
        assert!(Arc::ptr_eq(&held, &d3_formatter("$,.7f").expect("held")));
        assert_eq!(d3_formatter("$,.7f%%").err(), Some(InvalidSpecifier));
        assert!(formatter_cache().lock().expect(CACHE_LOCK).get("$,.7f%%").is_none(), "a refusal is not kept");
        let direct = allocations_during(|| drop(held.format(-1234.5)));
        let through = allocations_during(|| drop(d3_formatter("$,.7f").expect("held").format(-1234.5)));
        assert!(direct > 0, "the answer itself is counted");
        assert_eq!(through, direct, "a hit allocates what formatting does, and nothing more");
        let mut first = None;
        for n in 0..=FORMATTER_CACHE_CAPACITY {
            let specifier = format!(">{}.2f", 1_000_000 + n);
            d3_formatter(&specifier).expect("a specifier");
            first.get_or_insert(specifier);
        }
        let first = first.expect("one written");
        assert!(formatter_cache().lock().expect(CACHE_LOCK).get(first.as_str()).is_none(), "the oldest of 257 is dropped");
    }
    // Recorded by executing d3-format 3.1.2's formatLocale({ decimal: ".", thousands: ",", grouping: [3], currency: ["$", ""], minus: "-", percent: "%", nan: "NaN" }) under Node v24.21.0 (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c),
    // against @telorun/cel 0.129.0 at 2ee5ef49.
    /// The values every specifier formats, as bits.
    const D3_VALUES: &[u64] = &[
        0x0000000000000000, 0x8000000000000000, 0x3ff0000000000000, 0xbff0000000000000, 0x3fe0000000000000,
        0xbfe0000000000000, 0x3ff8000000000000, 0x4004000000000000, 0xc004000000000000, 0x3fb999999999999a,
        0x3fc999999999999a, 0x3fd3333333333333, 0x3fd5555555555555, 0xbfe5555555555555, 0x3f50624dd2f1a9fc,
        0x3f40624dd2f1a9fc, 0x3f400e6afcce1c58, 0x3e7ad7f29abcaf48, 0xbe7ad7f29abcaf48, 0x3de49da7e361ce4c,
        0x3b92e3b40a0e9b4f, 0x3af357c299a88ea7, 0x3abef2d0f5da7dd9, 0x39b4484bfeebc2a0, 0x0000000000000001,
        0x4028000000000000, 0x405ec00000000000, 0x4093480000000000, 0x40c81c8000000000, 0x40fe240000000000,
        0x4132d68700000000, 0x41678c29c0000000, 0x419d6f3454000000, 0x41d26580b4800000, 0xc132d687e4189375,
        0x408f3ffef9db22d1, 0x412e847f00000000, 0x4023fd70a3d70a3d, 0x4058ffae147ae148, 0x3fefd70a3d70a3d7,
        0x3feffffef39085f5, 0x3ff0147ae147ae14, 0x3ff0b851eb851eb8, 0x3ff4147ae147ae14, 0x4005666666666666,
        0x4020b0a3d70a3d71, 0x400921fb54442d11, 0xc00921fb54442d11, 0x4005bf0a8b145769, 0x4045000000000000,
        0xc045000000000000, 0x406fe00000000000, 0x4070000000000000, 0x40affe0000000000, 0x40efffe000000000,
        0x4130000000000000, 0xc12fffff00000000, 0x412e848000000000, 0x41cdcd6500000000, 0x426d1a94a2000000,
        0x430c6bf526340000, 0x43abc16d674ec800, 0x4415af1d78b58c40, 0x444b1ae4d6e2ef50, 0xc44b1ae4d6e2ef50,
        0x4454542ba12a337c, 0x45246c993044fd55, 0x54b249ad2594c37d, 0x7e37e43c8800759c, 0x7fefffffffffffff,
        0xffefffffffffffff, 0x4340000000000000, 0x4340000000000001, 0xc340000000000000, 0x433fffffffffffff,
        0x3f202e7ef70994dd, 0x3f8948a661fef899, 0x405edd2f1a9fbe77, 0xc05edd2f1a9fbe77, 0x3fa70a3d70a3d70a,
        0x3fac28f5c28f5c29, 0x408f440000000000, 0x3eea36e2eb1c432d, 0x3e401b2b29a4692b, 0x3ed2dfd694ccab3f,
        0x3f7a9fbe76c8b439, 0x4040aaaaa7ded6bb, 0x4050aaaaa7ded6bb, 0x4059000000000000, 0x408f400000000000,
        0x3fc0000000000000, 0x3fd8000000000000, 0x3f50624dd2f1a9fc, 0x3ec0c6f7a0b5ed8d, 0x3e29c511dc3a41df,
        0x3d919799812dea11, 0x3cf6849b86a12b9b, 0x3c5bab8cbabb6581, 0x7ff8000000000000, 0x7ff0000000000000,
        0xfff0000000000000,
    ];

    /// `(specifier, digest)`: FNV-1a 64 over the UTF-8 of the answer for each of `D3_VALUES` in order,
    /// joined by line feeds, `TOOLONG` where d3 throws `RangeError`; `None` where `format(specifier)`
    /// throws. 469 specifiers, 64 of them invalid and 6 too long.
    const D3_SPECIFIERS: &[(&str, Option<u64>)] = &[
        ("", Some(0x691a73f6f7dd1397)),
        (".0", Some(0x7c5c257cd94ed836)),
        (".2", Some(0x132252856d07cdd8)),
        (".6", Some(0x7597ca5e412a243b)),
        (".12", Some(0x691a73f6f7dd1397)),
        (".21", Some(0x294bfcff0bc52a1f)),
        (".999", Some(0x294bfcff0bc52a1f)),
        ("e", Some(0x1d44cb571adb44e2)),
        (".0e", Some(0xfee68f181c97844b)),
        (".2e", Some(0xab461234e27fd2fa)),
        (".6e", Some(0x1d44cb571adb44e2)),
        (".12e", Some(0x429afc07750f3755)),
        (".21e", Some(0xb64c424e0bca2d61)),
        (".999e", Some(0xb64c424e0bca2d61)),
        ("f", Some(0x77f15afa17e8943b)),
        (".0f", Some(0x2a296d8c1b4b00e0)),
        (".2f", Some(0x44dcb19552a0303d)),
        (".6f", Some(0x77f15afa17e8943b)),
        (".12f", Some(0x5c032cd8a75c4507)),
        (".21f", Some(0x95e785caa286a986)),
        (".999f", Some(0x95e785caa286a986)),
        ("g", Some(0x3682623f1ade6181)),
        (".0g", Some(0x7c5c257cd94ed836)),
        (".2g", Some(0x683a9adb22e4b6bc)),
        (".6g", Some(0x3682623f1ade6181)),
        (".12g", Some(0x13bee8dcd451b41b)),
        (".21g", Some(0x73954bcafbc2036f)),
        (".999g", Some(0x73954bcafbc2036f)),
        ("r", Some(0x35b13a1bc6de298f)),
        (".0r", Some(0x238e9e1657059018)),
        (".2r", Some(0xe813d20b09fbc306)),
        (".6r", Some(0x35b13a1bc6de298f)),
        (".12r", Some(0xd47717c93ad2daa6)),
        (".21r", Some(0x5737c0cb556c76c4)),
        (".999r", Some(0x5737c0cb556c76c4)),
        ("s", Some(0x9965e710a6813621)),
        (".0s", Some(0x24dc463d1f96221b)),
        (".2s", Some(0xb2a729804b5302f6)),
        (".6s", Some(0x9965e710a6813621)),
        (".12s", Some(0x2e7f393040db81bb)),
        (".21s", Some(0x9c7c583b633a4f3a)),
        (".999s", Some(0x9c7c583b633a4f3a)),
        ("%", Some(0xfa449e3501fb90f7)),
        (".0%", Some(0x67f7ad35ec689730)),
        (".2%", Some(0x2e4bf8b5ed472d78)),
        (".6%", Some(0xfa449e3501fb90f7)),
        (".12%", Some(0x86313236064c3b47)),
        (".21%", Some(0x5c5d55e882a4f0d9)),
        (".999%", Some(0x5c5d55e882a4f0d9)),
        ("p", Some(0x1d27bd6415e2df96)),
        (".0p", Some(0x4ecfb083d8f671ea)),
        (".2p", Some(0xa6e64e6245918a5c)),
        (".6p", Some(0x1d27bd6415e2df96)),
        (".12p", Some(0xccb4ee05d3fd0c1f)),
        (".21p", Some(0x3fa553ab0b775ba8)),
        (".999p", Some(0x3fa553ab0b775ba8)),
        ("b", Some(0x281e69396283f174)),
        (".0b", Some(0x281e69396283f174)),
        (".2b", Some(0x281e69396283f174)),
        (".6b", Some(0x281e69396283f174)),
        (".12b", Some(0x281e69396283f174)),
        (".21b", Some(0x281e69396283f174)),
        (".999b", Some(0x281e69396283f174)),
        ("o", Some(0x057fd17896a420a6)),
        (".0o", Some(0x057fd17896a420a6)),
        (".2o", Some(0x057fd17896a420a6)),
        (".6o", Some(0x057fd17896a420a6)),
        (".12o", Some(0x057fd17896a420a6)),
        (".21o", Some(0x057fd17896a420a6)),
        (".999o", Some(0x057fd17896a420a6)),
        ("d", Some(0x1de01a309d50fd8c)),
        (".0d", Some(0x1de01a309d50fd8c)),
        (".2d", Some(0x1de01a309d50fd8c)),
        (".6d", Some(0x1de01a309d50fd8c)),
        (".12d", Some(0x1de01a309d50fd8c)),
        (".21d", Some(0x1de01a309d50fd8c)),
        (".999d", Some(0x1de01a309d50fd8c)),
        ("x", Some(0x5dd483c9ac8673aa)),
        (".0x", Some(0x5dd483c9ac8673aa)),
        (".2x", Some(0x5dd483c9ac8673aa)),
        (".6x", Some(0x5dd483c9ac8673aa)),
        (".12x", Some(0x5dd483c9ac8673aa)),
        (".21x", Some(0x5dd483c9ac8673aa)),
        (".999x", Some(0x5dd483c9ac8673aa)),
        ("X", Some(0xcdba3f173eed70ca)),
        (".0X", Some(0xcdba3f173eed70ca)),
        (".2X", Some(0xcdba3f173eed70ca)),
        (".6X", Some(0xcdba3f173eed70ca)),
        (".12X", Some(0xcdba3f173eed70ca)),
        (".21X", Some(0xcdba3f173eed70ca)),
        (".999X", Some(0xcdba3f173eed70ca)),
        ("c", Some(0x5d331584e1e04be3)),
        (".0c", Some(0x5d331584e1e04be3)),
        (".2c", Some(0x5d331584e1e04be3)),
        (".6c", Some(0x5d331584e1e04be3)),
        (".12c", Some(0x5d331584e1e04be3)),
        (".21c", Some(0x5d331584e1e04be3)),
        (".999c", Some(0x5d331584e1e04be3)),
        ("n", Some(0x3daabf1921c0fb53)),
        (".0n", Some(0x7c5c257cd94ed836)),
        (".2n", Some(0x683a9adb22e4b6bc)),
        (".6n", Some(0x3daabf1921c0fb53)),
        (".12n", Some(0xb3a00dee5bba2d13)),
        (".21n", Some(0xc717d91f0cac0bf3)),
        (".999n", Some(0xc717d91f0cac0bf3)),
        ("E", Some(0x691a73f6f7dd1397)),
        (".0E", Some(0x7c5c257cd94ed836)),
        (".2E", Some(0x132252856d07cdd8)),
        (".6E", Some(0x7597ca5e412a243b)),
        (".12E", Some(0x691a73f6f7dd1397)),
        (".21E", Some(0x294bfcff0bc52a1f)),
        (".999E", Some(0x294bfcff0bc52a1f)),
        ("F", Some(0x691a73f6f7dd1397)),
        (".0F", Some(0x7c5c257cd94ed836)),
        (".2F", Some(0x132252856d07cdd8)),
        (".6F", Some(0x7597ca5e412a243b)),
        (".12F", Some(0x691a73f6f7dd1397)),
        (".21F", Some(0x294bfcff0bc52a1f)),
        (".999F", Some(0x294bfcff0bc52a1f)),
        ("G", Some(0x691a73f6f7dd1397)),
        (".0G", Some(0x7c5c257cd94ed836)),
        (".2G", Some(0x132252856d07cdd8)),
        (".6G", Some(0x7597ca5e412a243b)),
        (".12G", Some(0x691a73f6f7dd1397)),
        (".21G", Some(0x294bfcff0bc52a1f)),
        (".999G", Some(0x294bfcff0bc52a1f)),
        ("R", Some(0x691a73f6f7dd1397)),
        (".0R", Some(0x7c5c257cd94ed836)),
        (".2R", Some(0x132252856d07cdd8)),
        (".6R", Some(0x7597ca5e412a243b)),
        (".12R", Some(0x691a73f6f7dd1397)),
        (".21R", Some(0x294bfcff0bc52a1f)),
        (".999R", Some(0x294bfcff0bc52a1f)),
        ("S", Some(0x691a73f6f7dd1397)),
        (".0S", Some(0x7c5c257cd94ed836)),
        (".2S", Some(0x132252856d07cdd8)),
        (".6S", Some(0x7597ca5e412a243b)),
        (".12S", Some(0x691a73f6f7dd1397)),
        (".21S", Some(0x294bfcff0bc52a1f)),
        (".999S", Some(0x294bfcff0bc52a1f)),
        ("P", Some(0x691a73f6f7dd1397)),
        (".0P", Some(0x7c5c257cd94ed836)),
        (".2P", Some(0x132252856d07cdd8)),
        (".6P", Some(0x7597ca5e412a243b)),
        (".12P", Some(0x691a73f6f7dd1397)),
        (".21P", Some(0x294bfcff0bc52a1f)),
        (".999P", Some(0x294bfcff0bc52a1f)),
        ("B", Some(0x691a73f6f7dd1397)),
        (".0B", Some(0x7c5c257cd94ed836)),
        (".2B", Some(0x132252856d07cdd8)),
        (".6B", Some(0x7597ca5e412a243b)),
        (".12B", Some(0x691a73f6f7dd1397)),
        (".21B", Some(0x294bfcff0bc52a1f)),
        (".999B", Some(0x294bfcff0bc52a1f)),
        ("O", Some(0x691a73f6f7dd1397)),
        (".0O", Some(0x7c5c257cd94ed836)),
        (".2O", Some(0x132252856d07cdd8)),
        (".6O", Some(0x7597ca5e412a243b)),
        (".12O", Some(0x691a73f6f7dd1397)),
        (".21O", Some(0x294bfcff0bc52a1f)),
        (".999O", Some(0x294bfcff0bc52a1f)),
        ("D", Some(0x691a73f6f7dd1397)),
        (".0D", Some(0x7c5c257cd94ed836)),
        (".2D", Some(0x132252856d07cdd8)),
        (".6D", Some(0x7597ca5e412a243b)),
        (".12D", Some(0x691a73f6f7dd1397)),
        (".21D", Some(0x294bfcff0bc52a1f)),
        (".999D", Some(0x294bfcff0bc52a1f)),
        ("C", Some(0x691a73f6f7dd1397)),
        (".0C", Some(0x7c5c257cd94ed836)),
        (".2C", Some(0x132252856d07cdd8)),
        (".6C", Some(0x7597ca5e412a243b)),
        (".12C", Some(0x691a73f6f7dd1397)),
        (".21C", Some(0x294bfcff0bc52a1f)),
        (".999C", Some(0x294bfcff0bc52a1f)),
        ("N", Some(0x691a73f6f7dd1397)),
        (".0N", Some(0x7c5c257cd94ed836)),
        (".2N", Some(0x132252856d07cdd8)),
        (".6N", Some(0x7597ca5e412a243b)),
        (".12N", Some(0x691a73f6f7dd1397)),
        (".21N", Some(0x294bfcff0bc52a1f)),
        (".999N", Some(0x294bfcff0bc52a1f)),
        ("q", Some(0x691a73f6f7dd1397)),
        (".0q", Some(0x7c5c257cd94ed836)),
        (".2q", Some(0x132252856d07cdd8)),
        (".6q", Some(0x7597ca5e412a243b)),
        (".12q", Some(0x691a73f6f7dd1397)),
        (".21q", Some(0x294bfcff0bc52a1f)),
        (".999q", Some(0x294bfcff0bc52a1f)),
        ("a", Some(0x691a73f6f7dd1397)),
        (".0a", Some(0x7c5c257cd94ed836)),
        (".2a", Some(0x132252856d07cdd8)),
        (".6a", Some(0x7597ca5e412a243b)),
        (".12a", Some(0x691a73f6f7dd1397)),
        (".21a", Some(0x294bfcff0bc52a1f)),
        (".999a", Some(0x294bfcff0bc52a1f)),
        ("z", Some(0x691a73f6f7dd1397)),
        (".0z", Some(0x7c5c257cd94ed836)),
        (".2z", Some(0x132252856d07cdd8)),
        (".6z", Some(0x7597ca5e412a243b)),
        (".12z", Some(0x691a73f6f7dd1397)),
        (".21z", Some(0x294bfcff0bc52a1f)),
        (".999z", Some(0x294bfcff0bc52a1f)),
        ("Q", Some(0x691a73f6f7dd1397)),
        (".0Q", Some(0x7c5c257cd94ed836)),
        (".2Q", Some(0x132252856d07cdd8)),
        (".6Q", Some(0x7597ca5e412a243b)),
        (".12Q", Some(0x691a73f6f7dd1397)),
        (".21Q", Some(0x294bfcff0bc52a1f)),
        (".999Q", Some(0x294bfcff0bc52a1f)),
        ("<8f", Some(0xf165162ce0f2f93f)),
        ("<12,.3s", Some(0xfe51bcad77676219)),
        ("<+10.1%", Some(0xcc0f6834ba9e5931)),
        ("<^8d", Some(0xcc12075874837694)),
        (">8f", Some(0x360f5852e3188ed7)),
        (">12,.3s", Some(0x55a7a342f564c521)),
        (">+10.1%", Some(0x04579b6f42f9e1e7)),
        (">^8d", Some(0x421b40930bd2f5fa)),
        ("^8f", Some(0x54ec28d4e1dfa931)),
        ("^12,.3s", Some(0xb59996b764b7ab33)),
        ("^+10.1%", Some(0xa4cc25bb1ae383db)),
        ("^^8d", Some(0x815d6a297b840a1a)),
        ("=8f", Some(0xce32fd29578e53cf)),
        ("=12,.3s", Some(0xd910eda7ae77dee1)),
        ("=+10.1%", Some(0x0555bf92f5e6d8ab)),
        ("=^8d", Some(0x1c8b15047fbc66cf)),
        ("x<8f", Some(0xd3175a925e859c37)),
        ("x<12,.3s", Some(0x1ff51547601c02b9)),
        ("x<+10.1%", Some(0x60349861e53acda1)),
        ("x<^8d", None),
        ("x>8f", Some(0x3c60e693cbe31e6f)),
        ("x>12,.3s", Some(0xddbb276697400301)),
        ("x>+10.1%", Some(0x5e5dc4df75460227)),
        ("x>^8d", None),
        ("*^8f", Some(0xfaa00be1e1038323)),
        ("*^12,.3s", Some(0xde24e7172de08dc3)),
        ("*^+10.1%", Some(0x53699b8a59f35b63)),
        ("*^^8d", None),
        ("0=8f", Some(0x40c53264802e3e3f)),
        ("0=12,.3s", Some(0x11db848655f5c893)),
        ("0=+10.1%", Some(0x5aca5af88abdabcb)),
        ("0=^8d", None),
        ("0>8f", Some(0x146d3602fd411987)),
        ("0>12,.3s", Some(0x1cd3bd0821c433e1)),
        ("0>+10.1%", Some(0x52ad2bf70b50b4c7)),
        ("0>^8d", None),
        ("0<8f", Some(0x3cfff47b2b385c2f)),
        ("0<12,.3s", Some(0x58bb820f69cc3579)),
        ("0<+10.1%", Some(0x6a5cb4a27172f571)),
        ("0<^8d", None),
        (" =8f", Some(0xce32fd29578e53cf)),
        (" =12,.3s", Some(0xd910eda7ae77dee1)),
        (" =+10.1%", Some(0x0555bf92f5e6d8ab)),
        (" =^8d", None),
        ("\u{e9}^8f", Some(0x88879b91798d71eb)),
        ("\u{e9}^12,.3s", Some(0x83b86525eb28a729)),
        ("\u{e9}^+10.1%", Some(0x25b67668eff6f6af)),
        ("\u{e9}^^8d", None),
        ("-<8f", Some(0xb07ca1848dfb181a)),
        ("-<12,.3s", Some(0x880d640a587a83fb)),
        ("-<+10.1%", Some(0xe426022265ccfdab)),
        ("-<^8d", None),
        ("+>8f", Some(0x0f8dfdfe9a8b60c6)),
        ("+>12,.3s", Some(0x37d8d92396906d25)),
        ("+>+10.1%", Some(0xad451fdb8cf89a81)),
        ("+>^8d", None),
        ("(^8f", Some(0xc1ac7ad7fe18bb09)),
        ("(^12,.3s", Some(0xc26f200c59bd9af3)),
        ("(^+10.1%", Some(0x2e6416fca542714b)),
        ("(^^8d", None),
        ("$=8f", Some(0x72dc23626fe07dab)),
        ("$=12,.3s", Some(0x27efc44c163e3601)),
        ("$=+10.1%", Some(0x7a51d8181a655803)),
        ("$=^8d", None),
        ("#<8f", Some(0x96090d587dcb6270)),
        ("#<12,.3s", Some(0xb3a7344393daf1fb)),
        ("#<+10.1%", Some(0x900fd28d6410bfab)),
        ("#<^8d", None),
        ("0^8f", Some(0x5b22736d537781c1)),
        ("0^12,.3s", Some(0xed931f81a1983ef3)),
        ("0^+10.1%", Some(0x515b58ffc4d95ebb)),
        ("0^^8d", None),
        ("<<8f", Some(0x389bef924e488ddb)),
        ("<<12,.3s", Some(0xa06e116203fd4fb9)),
        ("<<+10.1%", Some(0x45fa9a7a9da9b1d1)),
        ("<<^8d", None),
        (">>8f", Some(0x32d601b4b97a0765)),
        (">>12,.3s", Some(0x27707b745da06c41)),
        (">>+10.1%", Some(0x0706e44e57db6c83)),
        (">>^8d", None),
        ("^^8f", Some(0x4c9b2d547ddcf807)),
        ("^^12,.3s", Some(0x73ef3a6d1a0757e3)),
        ("^^+10.1%", Some(0xf724c7e638a45ecb)),
        ("^^^8d", None),
        ("==8f", Some(0x1d2b6624275c6b30)),
        ("==12,.3s", Some(0xbb478613415e1e45)),
        ("==+10.1%", Some(0xd7811aaf54e05929)),
        ("==^8d", None),
        ("\u{b5}>8f", Some(0x3f8af2247ff2ca7c)),
        ("\u{b5}>12,.3s", Some(0xb8a28ab9f6581f3f)),
        ("\u{b5}>+10.1%", Some(0x8e27ea14840bd897)),
        ("\u{b5}>^8d", None),
        ("\u{4e2d}^8f", Some(0xb9061053a252bc9a)),
        ("\u{4e2d}^12,.3s", Some(0x6bd597adaa2860b5)),
        ("\u{4e2d}^+10.1%", Some(0x2c1a284e41421c59)),
        ("\u{4e2d}^^8d", None),
        ("\u{ffff}<8f", Some(0x22df0814892c18b2)),
        ("\u{ffff}<12,.3s", Some(0x4573c0cf5e8cf40b)),
        ("\u{ffff}<+10.1%", Some(0x62a3c37fda1bddef)),
        ("\u{ffff}<^8d", None),
        ("\u{2027}>8f", Some(0x294ca730ebb46b10)),
        ("\u{2027}>12,.3s", Some(0x6f56f364146c82ed)),
        ("\u{2027}>+10.1%", Some(0x6a84c5c2dfb83db1)),
        ("\u{2027}>^8d", None),
        ("\n>5", None),
        ("\r^5", None),
        ("\u{2028}<5", None),
        ("\u{2029}=5", None),
        ("\u{1f600}>5", None),
        ("\u{1f600}5", None),
        ("\u{1f600}", None),
        (">\u{1f600}", None),
        ("\t>5", Some(0x84715e8909972c8b)),
        ("\u{85}>5", Some(0xbb134331feb42ebb)),
        ("\u{feff}^9", Some(0x6b964a6a32890794)),
        (">", Some(0x691a73f6f7dd1397)),
        ("<", Some(0x691a73f6f7dd1397)),
        ("^", Some(0x691a73f6f7dd1397)),
        ("=", Some(0x691a73f6f7dd1397)),
        ("xx", None),
        ("<>", Some(0x691a73f6f7dd1397)),
        ("><", Some(0x691a73f6f7dd1397)),
        ("<<<", None),
        ("+-", None),
        ("$$", None),
        ("##", None),
        ("00", Some(0x691a73f6f7dd1397)),
        ("0", Some(0x691a73f6f7dd1397)),
        ("0,", Some(0xc55dc7fb6ed2bc93)),
        (",0", None),
        ("..2", None),
        (".", None),
        (".f", None),
        ("1.2.3", None),
        ("~~", None),
        ("f~", None),
        ("ff", None),
        ("%%", None),
        ("5 f", None),
        (" 5f", Some(0xc226ff9fc212ea29)),
        ("5.", None),
        ("-$", Some(0x6098ca73ca992395)),
        ("$-", None),
        ("(5", Some(0xca9f4b150a275eb9)),
        ("+(", None),
        (" ", Some(0x448d29a2f211bb63)),
        ("  ", None),
        ("  >", None),
        ("x>>", None),
        ("->+", Some(0x93319eb83b794e92)),
        ("+>+", Some(0x93319eb83b794e92)),
        ("0=0", Some(0x691a73f6f7dd1397)),
        ("=0", Some(0x691a73f6f7dd1397)),
        ("==0", Some(0x691a73f6f7dd1397)),
        ("05,", Some(0x8e64680b7da50c5f)),
        ("5,,", None),
        (",.2", Some(0x132252856d07cdd8)),
        (".2,", None),
        ("$#", None),
        ("#$", None),
        ("\u{17f}", None),
        ("K", Some(0x691a73f6f7dd1397)),
        ("\u{e9}", None),
        ("1e5", None),
        ("1_0", None),
        ("\u{661}f", None),
        (">\u{661}", None),
        ("+5x", Some(0xb0134ed4e8013596)),
        ("^-08,.3~X", Some(0x9bcc9dd03f0f34f2)),
        ("$,.2f", Some(0x7f88e5be9b7c83cd)),
        ("+$,.2f", Some(0x8534e6d3e50f3141)),
        ("($,.2f", Some(0xd51a65eef2d25bff)),
        (" ,.0f", Some(0x2fd0cead7906e4c8)),
        ("#b", Some(0x81c6a90fa1509a7e)),
        ("#o", Some(0xa12edcfaceef0a4b)),
        ("#x", Some(0xa1d52d018980a2f2)),
        ("#X", Some(0x192f26b89796de52)),
        ("#08b", Some(0xc4e22fce284eaece)),
        ("$c", Some(0xad518ad2e3ebe2ab)),
        ("08,d", Some(0x324885dd11e26772)),
        ("010,.2f", Some(0xbb5f337902260aaf)),
        ("0=+12,.2f", Some(0xdd9b5d4efba56f99)),
        ("x^+$#012,.4~e", None),
        ("*<(20,.3s", Some(0xc04201261b7820df)),
        ("(.2%", Some(0x81101648510152f0)),
        ("~%", Some(0xf47bd5608f288839)),
        ("~s", Some(0x390531f5282c4f6d)),
        (",.12~g", Some(0xc55dc7fb6ed2bc93)),
        (".3~r", Some(0x6dcf2573d2ecd96b)),
        (".2~p", Some(0xd4c8422b39329424)),
        ("020,s", Some(0xae50b3df3f176d4d)),
        ("0>20,.2f", Some(0x53c383ce8b4e6083)),
        ("_^30,.1e", Some(0xbde483d302de7255)),
        ("536870889", Some(0x3ecf529ec2d344d7)),
        ("x>536870889", Some(0x3ecf529ec2d344d7)),
        ("^536870889", Some(0x3ecf529ec2d344d7)),
        ("0536870889", Some(0x3ecf529ec2d344d7)),
        ("0,536870889", None),
        (",536870889", None),
        ("99999999999", Some(0x3ecf529ec2d344d7)),
        ("10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", Some(0x3ecf529ec2d344d7)),
        ("x< #8.10d", Some(0x9c6d961fad59903c)),
        ("x<20.1P", Some(0x12abad6069314f4e)),
        ("0=(#8P", Some(0xfa4bed208e2711e3)),
        ("0=-#8.10n", Some(0xe72556b58d8ca8fb)),
        ("x>(8", Some(0xff9862907917f133)),
        ("\u{b5}>20.10O", Some(0x1651aac48a1cc917)),
        ("\u{2027}>$8.1P", Some(0x271259a434d164df)),
        ("\u{e9}^+$.1q", Some(0xb5180f1c9cdce8e5)),
        ("==+8.1O", Some(0x59904528a5061c8f)),
        ("0^(.1O", Some(0xd594bd0ba1c9cac2)),
        (">+$.10", Some(0x348ce82861b60e8a)),
        ("\u{b5}> .1n", Some(0xfa856e0513cf8e30)),
        ("x>($.10z", Some(0xcbeefe88629c257b)),
        (">.1q", Some(0x7c5c257cd94ed836)),
        ("\u{4e2d}^ $8F", Some(0x481ad3ee118ab6ac)),
        ("x<-.10%", Some(0x0215c32e5121acd2)),
        ("^^ $8.1q", Some(0x25c60458bcdebc30)),
        (">+q", Some(0x93319eb83b794e92)),
        ("+>$20.1R", Some(0xac136c2b610530b6)),
        (">>$R", Some(0x6098ca73ca992395)),
        ("-<$20.1d", Some(0x0d56d319cbbb7911)),
        ("\u{b5}>20.1R", Some(0x624fa98794c9eb7f)),
        ("0^#8.1r", Some(0x308807f1dee38a0e)),
        (" =(#n", Some(0x7532b0063679dc9f)),
        ("+>-.10q", Some(0xefa9c3ff9bc7a8fd)),
        ("\u{4e2d}^ #8.1P", Some(0xd7f4294e601441c8)),
        ("=+8.1R", Some(0xee032cdc656590fd)),
        ("0>+$8z", Some(0x31dd0f4e08ff4530)),
        ("< $20.10%", Some(0x0b89b448c496fc65)),
        ("\u{ffff}<(8n", Some(0x8482221213c8b5c7)),
        ("^^($20R", Some(0xe35e79c0c75ede2d)),
        ("\u{b5}> 8b", Some(0x4511785439cf3457)),
        ("^-$%", Some(0xae5d153ad266e2d4)),
        ("x< #8.10X", Some(0xb614f4f11b718316)),
        ("0=(#20.1f", Some(0xb0c29c1c4e147118)),
        ("^+$8f", Some(0x31510ea5a613737b)),
        ("0^C", Some(0x691a73f6f7dd1397)),
        ("*^+8.1b", Some(0x50b80658e8520614)),
        ("^^($8.10z", Some(0x107154fe601bfb3f)),
        ("*^($20.10", Some(0xf95bc38c5d16fb0d)),
        ("0=($20.10%", Some(0x81c09a0f6ee1d3ab)),
        ("-$.10O", Some(0x2f5b3afaf4426b73)),
        ("=-$q", Some(0x6098ca73ca992395)),
        ("(^(8b", Some(0xffc48a67d42342be)),
        ("#<-$8.10F", Some(0x9fcf150f745593b8)),
        ("x<-#.10d", Some(0x1de01a309d50fd8c)),
        ("\u{2027}>(20P", Some(0x3bbebdc644ea56f2)),
        (">(#8.10f", Some(0xfb5c2e8b4c22f6f9)),
        ("\u{2027}> 8.10d", Some(0x4213a07817a342fa)),
        ("\u{b5}>(#20.1F", Some(0xbf2508748d308c79)),
        ("x>($8%", Some(0x52b9c352e61c833e)),
        ("= $.10F", Some(0x1fd79ee9b9d2b365)),
        ("-<(20%", Some(0xc3038c31bc3fb7fd)),
        ("\u{ffff}< $8P", Some(0x04c4eccf01135030)),
        ("> $8z", Some(0xc5a7cf1d5c931971)),
        ("*^-$20.1P", Some(0xbc46ceade72e9b72)),
        (" =+$20.10b", Some(0x6d553682f72f70ce)),
        (">-#.10f", Some(0x709aa8ca9d24994b)),
    ];

    /// `(specifier, value's bits, answer)`, `TOOLONG` where d3 throws `RangeError`.
    const D3_ROWS: &[(&str, u64, &str)] = &[
        (".2f", 0xbf70624dd2f1a9fc, "0.00"),
        (".2f", 0xbf747ae147ae147b, "-0.01"),
        (".2f", 0x3ff0147ae147ae14, "1.00"),
        ("+.2f", 0x8000000000000000, "-0.00"),
        ("(.2f", 0xbff8000000000000, "(1.50)"),
        ("(.2f", 0xbf50624dd2f1a9fc, "0.00"),
        (" .1f", 0x4002000000000000, " 2.3"),
        ("$,.2f", 0xc132d687e4189375, "-$1,234,567.89"),
        ("$,.2f", 0x7ff8000000000000, "$NaN"),
        (",", 0x4132d68700000000, "1,234,567"),
        (",.0f", 0x444b1ae4d6e2ef50, "1e+21"),
        ("d", 0x4454542ba12a337c, "1500000000000000000000"),
        ("d", 0xc004000000000000, "-3"),
        ("d", 0x7ff0000000000000, "\u{221e}"),
        (",d", 0x444b1ae4d6e2ef50, "1,000,000,000,000,000,000,000"),
        ("010,.2f", 0xc0934a0000000000, "-001,234.50"),
        ("0=+12,.2f", 0x40934a0000000000, "+0,001,234.50"),
        ("020,s", 0x419d6f3454000000, "000,000,000,123.457M"),
        ("^8d", 0x4045000000000000, "   42   "),
        ("x^9", 0xbff0000000000000, "xxx-1xxxx"),
        ("<8.1%", 0x3fc0000000000000, "12.5%   "),
        ("#x", 0x406fe00000000000, "0xff"),
        ("#X", 0xc06ff00000000000, "-0x100"),
        ("#08b", 0x4014000000000000, "0b000101"),
        ("o", 0x4021000000000000, "11"),
        ("c", 0xbff8000000000000, "-1.5"),
        ("$c", 0x4045000000000000, "$42"),
        ("08c", 0x401c000000000000, "00000007"),
        (".3s", 0x3abef2d0f5da7dd9, "0.10y"),
        (".3s", 0x39b4484bfeebc2a0, "0.000001y"),
        (".3s", 0x0000000000000000, "0.00"),
        (".3s", 0x408f3c0000000000, "1.00k"),
        (".3s", 0x459363156bbee301, "1500Y"),
        ("s", 0xbeb92a737110e454, "-1.50000\u{b5}"),
        ("~s", 0x4097700000000000, "1.5k"),
        (".2~p", 0x3f889374bc6a7efa, "1.2%"),
        (".3~r", 0x3fbf972474538ef3, "0.123"),
        ("r", 0x0000000000000000, "0"),
        ("r", 0xfff0000000000000, "-Infinity"),
        (".12~g", 0x3fd5555555555555, "0.333333333333"),
        ("", 0x444b1ae4d6e2ef50, "1e+21"),
        ("", 0x3eb0c6f7a0b5ed8d, "0.000001"),
        ("", 0x8000000000000000, "0"),
        ("n", 0x4132d687e4189375, "1.23457e+6"),
        ("e", 0x0000000000000000, "0.000000e+0"),
        (".0e", 0x4039000000000000, "3e+1"),
        ("~e", 0x3e7ad7f29abcaf48, "1e-7"),
        ("%", 0x3fb1eb851eb851ec, "7.000000%"),
        ("", 0x7ff8000000000000, "NaN"),
        ("020", 0x7ff8000000000000, "00000000000000000NaN"),
        ("\u{e9}^9", 0x400c000000000000, "\u{e9}\u{e9}\u{e9}3.5\u{e9}\u{e9}\u{e9}"),
        ("\u{ffff}<5", 0x3ff0000000000000, "1\u{ffff}\u{ffff}\u{ffff}\u{ffff}"),
        ("E", 0x4029000000000000, "12.5"),
        ("N", 0x40934a0000000000, "1234.5"),
        (".999f", 0x400921fb54442d18, "3.14159265358979311600"),
        (".25g", 0x400921fb54442d18, "3.14159265358979311600"),
        ("*<(20,.3s", 0xc12e848000000000, "(1.00M)*************"),
        (" =12,.2f", 0xc162d687e6b851ec, "-9,876,543.21"),
        ("0^12", 0x400c000000000000, "00003.500000"),
        (",x", 0x40efffe000000000, "f,fff"),
        (",b", 0x406fe00000000000, "11,111,111"),
    ];
}
