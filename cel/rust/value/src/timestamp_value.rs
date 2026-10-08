//! Instants: reading one, writing one, and the civil calendar — `timestamp-value.ts`.
//!
//! A timestamp is held to the nanosecond, inside `0001-01-01T00:00:00Z …
//! 9999-12-31T23:59:59.999999999Z`; an instant outside that range is an error wherever
//! it would be built, so no wider carrier exists.
//!
//! Node exports that live in the engine crate's `timestamp_value.rs`:
//! - `zonedFields`, `timestampField`, `TimestampField` — a getter reads a field in a
//!   time zone, an IANA name among them, and the zone database is a dependency this
//!   crate may not have. UTC, a fixed offset and a named zone are one function there.
//!
//! Declared here and not exported by the Node file: the civil calendar those build on
//! (`utc_fields`, `days_from_civil` and their companions), public so the engine's half
//! does not restate it, and the carrier constructors and accessors of `CelTimestamp`.

use std::fmt;

use crate::cel_value::{cel_error, CelError, CelEvaluationCode, CelTimestamp};
use crate::value_text::json_quote;

/// `0001-01-01T00:00:00Z` and `9999-12-31T23:59:59Z`, in seconds since the epoch.
pub const MIN_TIMESTAMP_SECONDS: i64 = -62_135_596_800;
pub const MAX_TIMESTAMP_SECONDS: i64 = 253_402_300_799;

const NANOS_PER_SECOND: i128 = 1_000_000_000;

impl CelTimestamp {
    pub const MIN_UNIX_NANOS: i128 = MIN_TIMESTAMP_SECONDS as i128 * NANOS_PER_SECOND;
    pub const MAX_UNIX_NANOS: i128 = MAX_TIMESTAMP_SECONDS as i128 * NANOS_PER_SECOND + 999_999_999;

    /// The instant `nanos` past `seconds` after the epoch, or `None` when `nanos` is a
    /// whole second or more, or the instant is outside the range.
    pub fn new(seconds: i64, nanos: u32) -> Option<Self> {
        if nanos >= 1_000_000_000 {
            return None;
        }
        Self::from_unix_nanos(i128::from(seconds) * NANOS_PER_SECOND + i128::from(nanos))
    }

    /// The instant `unix_nanos` after the epoch, or `None` outside the range.
    pub fn from_unix_nanos(unix_nanos: i128) -> Option<Self> {
        (Self::MIN_UNIX_NANOS..=Self::MAX_UNIX_NANOS).contains(&unix_nanos).then_some(Self { unix_nanos })
    }

    pub fn unix_nanos(&self) -> i128 {
        self.unix_nanos
    }

    /// Whole seconds since the epoch, rounded toward negative infinity.
    pub fn seconds(&self) -> i64 {
        self.unix_nanos.div_euclid(NANOS_PER_SECOND) as i64
    }

    /// The nanoseconds past `seconds`, always non-negative.
    pub fn subsec_nanos(&self) -> u32 {
        self.unix_nanos.rem_euclid(NANOS_PER_SECOND) as u32
    }
}

impl fmt::Display for CelTimestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_timestamp(*self))
    }
}

fn out_of_range() -> CelError {
    cel_error(CelEvaluationCode::InvalidConversion, "timestamp out of range", None)
}

/// An instant from seconds and nanoseconds of any sign, normalized, or the range error.
pub fn cel_timestamp(seconds: i128, nanos: i128) -> Result<CelTimestamp, CelError> {
    seconds
        .checked_mul(NANOS_PER_SECOND)
        .and_then(|whole| whole.checked_add(nanos))
        .and_then(CelTimestamp::from_unix_nanos)
        .ok_or_else(out_of_range)
}

/// A double rounded to the nearest integer, a tie toward positive infinity — the
/// rounding the millisecond reading is defined by.
fn round_half_up(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// An instant from epoch MILLISECONDS — a host clock reading, or an epoch-millis
/// column — or the range error. A fractional reading keeps its sub-millisecond part.
pub fn cel_timestamp_from_millis(millis: f64) -> Result<CelTimestamp, CelError> {
    if !millis.is_finite() {
        return Err(out_of_range());
    }
    let whole = (millis / 1000.0).floor();
    let nanos = round_half_up((millis - whole * 1000.0) * 1_000_000.0);
    // Both casts saturate, and a saturated reading is out of range.
    cel_timestamp(whole as i128, nanos as i128)
}

/// The instant's nanoseconds since the epoch — what arithmetic and ordering compare.
pub fn timestamp_nanos(value: CelTimestamp) -> i128 {
    value.unix_nanos
}

struct Rfc3339 {
    fields: CivilFields,
    nanos: i128,
    /// Seconds to add to the civil reading to reach UTC.
    offset: i64,
}

fn digits(text: &[u8], at: usize, count: usize) -> Option<i64> {
    text.get(at..at + count)?
        .iter()
        .try_fold(0i64, |value, c| c.is_ascii_digit().then(|| value * 10 + i64::from(c - b'0')))
}

fn expect(text: &[u8], at: usize, byte: u8) -> Option<()> {
    (text.get(at) == Some(&byte)).then_some(())
}

/// The SHAPE alone: `YYYY-MM-DD`, then `T`, `t` or a space, then `HH:MM:SS`, an
/// optional fraction of any length, and `Z`, `z` or `±HH:MM`. No field is ranged here.
fn rfc3339_shape(text: &str) -> Option<Rfc3339> {
    let t = text.as_bytes();
    let year = digits(t, 0, 4)?;
    expect(t, 4, b'-')?;
    let month = digits(t, 5, 2)?;
    expect(t, 7, b'-')?;
    let day = digits(t, 8, 2)?;
    if !matches!(t.get(10), Some(b'T' | b't' | b' ')) {
        return None;
    }
    let hour = digits(t, 11, 2)?;
    expect(t, 13, b':')?;
    let minute = digits(t, 14, 2)?;
    expect(t, 16, b':')?;
    let second = digits(t, 17, 2)?;
    let mut at = 19;
    let mut nanos = 0i128;
    if t.get(at) == Some(&b'.') {
        let start = at + 1;
        let length = t[start..].iter().take_while(|c| c.is_ascii_digit()).count();
        if length == 0 {
            return None;
        }
        // Read to the nanosecond; further digits are dropped, not rounded.
        for index in 0..9 {
            nanos = nanos * 10 + if index < length { i128::from(t[start + index] - b'0') } else { 0 };
        }
        at = start + length;
    }
    let offset = match t.get(at) {
        Some(b'Z' | b'z') if t.len() == at + 1 => 0,
        Some(sign @ (b'+' | b'-')) if t.len() == at + 6 => {
            let hours = digits(t, at + 1, 2)?;
            expect(t, at + 3, b':')?;
            let minutes = digits(t, at + 4, 2)?;
            let ahead = hours * 3600 + minutes * 60;
            if *sign == b'-' {
                ahead
            } else {
                -ahead
            }
        }
        _ => return None,
    };
    Some(Rfc3339 { fields: CivilFields { year, month, day, hour, minute, second }, nanos, offset })
}

/// An instant from RFC 3339 text, with any offset and any fractional precision. An
/// offset's digits are not ranged: `+99:99` is read as the arithmetic it names.
pub fn parse_timestamp(text: &str) -> Result<CelTimestamp, CelError> {
    let refuse = |what: &str| {
        cel_error(CelEvaluationCode::InvalidConversion, format!("{} is not {what}", json_quote(text)), None)
    };
    let Some(Rfc3339 { fields, nanos, offset }) = rfc3339_shape(text) else {
        return Err(refuse("an RFC 3339 instant"));
    };
    if fields.month < 1
        || fields.month > 12
        || fields.day < 1
        || fields.day > days_in_month(fields.year, fields.month)
        || fields.hour > 23
        || fields.minute > 59
        || fields.second > 59
    {
        return Err(refuse("an instant"));
    }
    cel_timestamp(i128::from(seconds_from_fields(&fields) + offset), nanos)
}

/// RFC 3339 in UTC, with the fraction written to the precision it carries and omitted
/// when the instant is whole (`2009-02-13T23:31:30Z`).
pub fn format_timestamp(value: CelTimestamp) -> String {
    let fields = utc_fields(value.seconds());
    let nanos = value.subsec_nanos();
    let fraction = if nanos == 0 {
        String::new()
    } else {
        format!(".{}", format!("{nanos:09}").trim_end_matches('0'))
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{fraction}Z",
        fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second
    )
}

// --- the calendar ----------------------------------------------------------

/// A date and a time of day in the proleptic Gregorian calendar, with no zone.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CivilFields {
    pub year: i64,
    /// 1 … 12.
    pub month: i64,
    /// 1 … 31.
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
}

pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// The days in a month, 1 … 12.
pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from the epoch to a civil date, by Howard Hinnant's `days_from_civil`.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The civil date a day count names — `(year, month, day)` — the inverse of
/// `days_from_civil`.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// The seconds since the epoch at which civil fields fall, read as UTC.
pub fn seconds_from_fields(fields: &CivilFields) -> i64 {
    days_from_civil(fields.year, fields.month, fields.day) * 86_400
        + fields.hour * 3600
        + fields.minute * 60
        + fields.second
}

/// The civil fields, in UTC, of a count of seconds since the epoch.
pub fn utc_fields(seconds: i64) -> CivilFields {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    CivilFields { year, month, day, hour: rest / 3600, minute: rest % 3600 / 60, second: rest % 60 }
}
