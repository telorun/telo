//! Instants: reading one, writing one, and reading a field of one in a time zone —
//! `timestamp-value.ts`, its engine half.
//!
//! The value crate's `timestamp_value.rs` holds reading, writing and the civil
//! calendar; the items Node's entry exports from this file are re-exported here. What needs the zone database lives here:
//! `zoned_fields`, `timestamp_field` and `TimestampField`.
//!
//! **A zone is named, never computed.** A getter takes `UTC`, a fixed `±HH:MM` offset —
//! arithmetic, an unsigned one ahead of UTC as cel-spec's rows read it — or a name of
//! the IANA database the engine bundles (`zone_database.rs`, tzdata 2026c), matched
//! ignoring ASCII case. Node resolves a name through its host's Intl, which also takes
//! offset forms such as `+05` and `+0530` and ICU's own legacy names; here those are
//! not time zones, and a zone's history is the bundled database's, which can differ from
//! a host's ICU data of another release.

pub use telorun_cel_value::{
    cel_timestamp, cel_timestamp_from_millis, format_timestamp, parse_timestamp, timestamp_nanos, CivilFields,
    MAX_TIMESTAMP_SECONDS, MIN_TIMESTAMP_SECONDS,
};

use telorun_cel_value::{
    cel_error, days_from_civil, json_quote, utc_fields, CelError, CelEvaluationCode, CelTimestamp, SourceRange,
};

use crate::zone_database::zone_named;

fn not_a_zone(zone: &str, range: Option<SourceRange>) -> CelError {
    cel_error(CelEvaluationCode::InvalidArgument, format!("{} is not a time zone", json_quote(zone)), range)
}

/// `[+-]HH:MM`, two ASCII digits each: the offset's sign, hours and minutes.
fn fixed_offset(zone: &str) -> Option<(bool, i64, i64)> {
    let (negative, rest) = match zone.as_bytes().first() {
        Some(b'-') => (true, &zone[1..]),
        Some(b'+') => (false, &zone[1..]),
        _ => (false, zone),
    };
    let bytes = rest.as_bytes();
    let digits = |at: usize| bytes[at..at + 2].iter().all(u8::is_ascii_digit);
    if bytes.len() != 5 || bytes[2] != b':' || !digits(0) || !digits(3) {
        return None;
    }
    Some((negative, rest[..2].parse().ok()?, rest[3..].parse().ok()?))
}

/// The civil fields of an instant in a zone, or the refusal of a zone that is none.
/// Only the instant's whole seconds are read.
pub fn zoned_fields(
    value: CelTimestamp,
    zone: Option<&str>,
    range: Option<SourceRange>,
) -> Result<CivilFields, CelError> {
    let seconds = value.seconds();
    let Some(zone) = zone.filter(|zone| *zone != "UTC") else {
        return Ok(utc_fields(seconds));
    };
    if let Some((negative, hours, minutes)) = fixed_offset(zone) {
        if hours > 23 || minutes > 59 {
            return Err(not_a_zone(zone, range));
        }
        let offset = hours * 3600 + minutes * 60;
        return Ok(utc_fields(seconds + if negative { -offset } else { offset }));
    }
    match zone_named(zone) {
        Some(named) => Ok(utc_fields(seconds + named.offset_at(seconds))),
        None => Err(not_a_zone(zone, range)),
    }
}

/// Which field of an instant a getter answers. The names are cel-spec's.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TimestampField {
    GetFullYear,
    GetMonth,
    GetDayOfYear,
    GetDayOfMonth,
    GetDate,
    GetDayOfWeek,
    GetHours,
    GetMinutes,
    GetSeconds,
    GetMilliseconds,
}

/// A field of an instant. `GetMonth`, `GetDayOfMonth` and `GetDayOfYear` are **zero
/// based** and `GetDate` is one based, which is cel-spec's own split; `GetDayOfWeek`
/// counts from Sunday. `GetMilliseconds` reads the instant itself and never the zone,
/// so it refuses no zone — Node's reading, kept as interim.
pub fn timestamp_field(
    value: CelTimestamp,
    field: TimestampField,
    zone: Option<&str>,
    range: Option<SourceRange>,
) -> Result<i64, CelError> {
    if field == TimestampField::GetMilliseconds {
        return Ok(i64::from(value.subsec_nanos() / 1_000_000));
    }
    let civil = zoned_fields(value, zone, range)?;
    let days = || days_from_civil(civil.year, civil.month, civil.day);
    Ok(match field {
        TimestampField::GetFullYear => civil.year,
        TimestampField::GetMonth => civil.month - 1,
        TimestampField::GetDayOfMonth => civil.day - 1,
        TimestampField::GetDate => civil.day,
        TimestampField::GetDayOfYear => days() - days_from_civil(civil.year, 1, 1),
        TimestampField::GetDayOfWeek => (days() % 7 + 11) % 7,
        TimestampField::GetHours => civil.hour,
        TimestampField::GetMinutes => civil.minute,
        TimestampField::GetSeconds => civil.second,
        TimestampField::GetMilliseconds => unreachable!("answered above"),
    })
}
