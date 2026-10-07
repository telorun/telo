//! Durations: reading one, writing one, and the fields of one — `duration-value.ts`.
//!
//! Two ranges, and only one of them is the type's. `CelDuration` carries any total
//! whose whole seconds fit an `i64`, because a duration arriving from a transport or a
//! journal must always be representable. CEL's own duration is the signed 64-bit range
//! of its total NANOSECONDS (`-9223372036.854775808s … 9223372036.854775807s`), and
//! that range belongs to CEL's constructor (`cel_duration_from_nanos`,
//! `parse_duration`) and to the check made where a duration this engine did not build
//! is used (`duration_out_of_range`).
//!
//! Declared here and not in the Node file: the carrier constructors and accessors of
//! `CelDuration`. Node builds a host's duration as an object literal; here a wider one
//! is built by `CelDuration::new` / `from_total_nanos`, which answer nothing on a bad
//! shape and apply no CEL range.

use std::fmt;

use crate::cel_value::{cel_error, CelDuration, CelError, CelEvaluationCode};
use crate::value_text::json_quote;

/// The widest and narrowest total a CEL duration holds, in nanoseconds: int64.
pub const MAX_DURATION_NANOS: i128 = i64::MAX as i128;
pub const MIN_DURATION_NANOS: i128 = i64::MIN as i128;

const NANOS_PER_SECOND: i128 = 1_000_000_000;

impl CelDuration {
    /// The duration of `seconds` and `nanos`, or `None` when their signs differ or
    /// `nanos` is a whole second or more.
    pub fn new(seconds: i64, nanos: i32) -> Option<Self> {
        if nanos.unsigned_abs() >= 1_000_000_000 || (seconds > 0 && nanos < 0) || (seconds < 0 && nanos > 0) {
            return None;
        }
        Some(Self { total_nanos: i128::from(seconds) * NANOS_PER_SECOND + i128::from(nanos) })
    }

    /// The duration of `total_nanos`, or `None` when its seconds exceed an `i64`.
    pub fn from_total_nanos(total_nanos: i128) -> Option<Self> {
        i64::try_from(total_nanos / NANOS_PER_SECOND).ok().map(|_| Self { total_nanos })
    }

    pub fn total_nanos(&self) -> i128 {
        self.total_nanos
    }

    /// Whole seconds, truncated toward zero.
    pub fn seconds(&self) -> i64 {
        (self.total_nanos / NANOS_PER_SECOND) as i64
    }

    /// The nanoseconds past `seconds`, with the same sign.
    pub fn nanos(&self) -> i32 {
        (self.total_nanos % NANOS_PER_SECOND) as i32
    }
}

impl fmt::Display for CelDuration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_duration(*self))
    }
}

fn out_of_range() -> CelError {
    cel_error(CelEvaluationCode::InvalidConversion, "duration out of range", None)
}

/// A duration from a total in nanoseconds, or the range error.
pub fn cel_duration_from_nanos(total: i128) -> Result<CelDuration, CelError> {
    if !(MIN_DURATION_NANOS..=MAX_DURATION_NANOS).contains(&total) {
        return Err(out_of_range());
    }
    Ok(CelDuration { total_nanos: total })
}

/// The error a duration this engine did not build is outside CEL's range. Checked
/// where such a duration is used, not where it arrives.
pub fn duration_out_of_range(value: CelDuration) -> Option<CelError> {
    (!(MIN_DURATION_NANOS..=MAX_DURATION_NANOS).contains(&value.total_nanos)).then(out_of_range)
}

/// The duration's total nanoseconds — what arithmetic and ordering compare.
pub fn duration_nanos(value: CelDuration) -> i128 {
    value.total_nanos
}

/// In the order the grammar tries them, so `ms` is read before `m` and `s`.
const UNIT_NANOS: [(&str, u128); 8] = [
    ("ns", 1),
    ("us", 1_000),
    ("\u{b5}s", 1_000),
    ("\u{3bc}s", 1_000),
    ("ms", 1_000_000),
    ("s", 1_000_000_000),
    ("m", 60_000_000_000),
    ("h", 3_600_000_000_000),
];

/// A duration from CEL's own text: a sign, then one or more number-and-unit parts over
/// `ns`, `us`, `ms`, `s`, `m` and `h` (`1h30m`, `1.5s`, `-10m`), under CEL's range.
pub fn parse_duration(text: &str) -> Result<CelDuration, CelError> {
    cel_duration_from_nanos(duration_nanos_from_text(text)?)
}

fn leading_digits(text: &str) -> (&str, &str) {
    text.split_at(text.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(text.len()))
}

/// Decimal digits as a number, or nothing past 128 bits. No digits is zero.
fn magnitude_of(digits: &str) -> Option<u128> {
    digits
        .bytes()
        .try_fold(0u128, |value, digit| value.checked_mul(10)?.checked_add(u128::from(digit - b'0')))
}

/// The same text as a TOTAL OF NANOSECONDS, with no range applied: a consumer outside
/// CEL has the same grammar with a different range, and applies its own.
///
/// The grammar is judged first — malformed text is not a duration however large an
/// earlier part is. A well-formed total that 128 bits cannot hold is out of every
/// caller's range, and is answered as such.
pub fn duration_nanos_from_text(text: &str) -> Result<i128, CelError> {
    let refuse =
        || cel_error(CelEvaluationCode::InvalidConversion, format!("{} is not a duration", json_quote(text)), None);
    let (negative, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if body == "0" {
        return Ok(0);
    }
    if body.is_empty() {
        return Err(refuse());
    }
    let mut magnitude = Some(0u128);
    let mut rest = body;
    while !rest.is_empty() {
        let (digits, mut after) = leading_digits(rest);
        let mut fraction = "";
        if let Some(stripped) = after.strip_prefix('.') {
            (fraction, after) = leading_digits(stripped);
        }
        let Some((unit, scale)) = UNIT_NANOS.iter().find(|(unit, _)| after.starts_with(unit)) else {
            return Err(refuse());
        };
        if digits.is_empty() && fraction.is_empty() {
            return Err(refuse());
        }
        let mut part = magnitude_of(digits).and_then(|whole| whole.checked_mul(*scale));
        if !fraction.is_empty() {
            // Read to the nanosecond; further digits are dropped, not rounded.
            let padded = format!("{fraction}000000000");
            let read = padded[..9].bytes().fold(0u128, |value, digit| value * 10 + u128::from(digit - b'0'));
            let nanos = read * scale / NANOS_PER_SECOND as u128;
            part = part.and_then(|whole| whole.checked_add(nanos));
        }
        magnitude = magnitude.zip(part).and_then(|(total, part)| total.checked_add(part));
        rest = &after[unit.len()..];
    }
    let total = magnitude.and_then(|magnitude| {
        if negative {
            0i128.checked_sub_unsigned(magnitude)
        } else {
            i128::try_from(magnitude).ok()
        }
    });
    total.ok_or_else(out_of_range)
}

/// Seconds with an `s` suffix, the fraction trimmed to what it carries.
pub fn format_duration(value: CelDuration) -> String {
    let sign = if value.total_nanos < 0 { "-" } else { "" };
    let magnitude = value.total_nanos.unsigned_abs();
    let nanos = magnitude % NANOS_PER_SECOND as u128;
    let fraction = if nanos == 0 {
        String::new()
    } else {
        format!(".{}", format!("{nanos:09}").trim_end_matches('0'))
    };
    format!("{sign}{}{fraction}s", magnitude / NANOS_PER_SECOND as u128)
}

/// Which field of a duration a getter answers. The names are cel-spec's.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum DurationField {
    GetHours,
    GetMinutes,
    GetSeconds,
    GetMilliseconds,
}

/// A field of a duration. `GetHours`, `GetMinutes` and `GetSeconds` answer the WHOLE
/// SPAN in that unit, truncated toward zero; `GetMilliseconds` answers the COMPONENT —
/// the milliseconds inside the second, so `123.321456789s` answers 321.
pub fn duration_field(value: CelDuration, field: DurationField) -> i64 {
    match field {
        DurationField::GetHours => (value.total_nanos / 3_600_000_000_000) as i64,
        DurationField::GetMinutes => (value.total_nanos / 60_000_000_000) as i64,
        DurationField::GetSeconds => value.seconds(),
        DurationField::GetMilliseconds => i64::from(value.nanos() / 1_000_000),
    }
}
