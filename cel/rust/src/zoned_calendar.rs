//! The calendar in a time zone: an instant's wall-clock fields, and the instant a wall
//! clock names — `zoned-calendar.ts`.
//!
//! The function catalog reads every calendar field through here. Node takes a zone's rules
//! from its host's Intl; here they are the bundled IANA database's (`zone_database.rs`,
//! tzdata 2026c), and what this file reproduces is how Node applies them — including
//! where it computes through `Date.UTC`. An instant is a whole number of milliseconds
//! since the epoch, as Node's are; an answer Node cannot give — it throws a `RangeError`
//! or answers `NaN` — is `None`.
//!
//! **A zone** is a name of the bundled database, matched ignoring ASCII case (`UTC` among
//! them, and `Factory`), or a signed fixed offset `±HH:MM` with hours at most 23 and
//! minutes at most 59, read arithmetically. Node's host also takes `+05`, `+0530` and ICU's
//! own names, and refuses `Factory`; those differ by charter.
//!
//! **Node's readings, reproduced.** `Date.UTC` reads a year from 0 to 99 as 1900 to 1999,
//! and the offset, the solver and `iso_text_in` compute through it; a wall-clock year at or
//! below zero is written as Intl writes it, its era year (`1 − year`) with no era; and the
//! date of every spelling but exactly `UTC` (or `Z`) writes its year unpadded; an instant
//! whose wall clock lies past the time range writes its offset `-NaN:NaN`; and a wall clock
//! that occurs twice resolves to whichever instant the solver's first guess lands on —
//! the later east of UTC — where Node's own comment promises the earlier. Each is held by a
//! named test. `Date.UTC`'s arithmetic is `ecmascript_time_value`, the one place it lives,
//! and the solver is `solve_wall_clock`, pure over the two readings it is handed.
//!
//! Node items with no twin: none.

use telorun_cel_value::{civil_from_days, utc_fields};

use crate::es_number_text::math_round;
use crate::zone_database::{zone_named, Zone};

/// A wall clock, to the second: what a zone makes of an instant. Its year is the era year
/// Intl writes, so a wall clock before year 1 reads as a positive year.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CivilTime {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
}

/// ECMAScript's time range: an instant is at most 8.64 × 10^15 ms from the epoch.
const MAX_TIME_VALUE: i64 = 8_640_000_000_000_000;

const MS_PER_DAY: f64 = 86_400_000.0;

enum CalendarZone {
    /// A fixed offset, in milliseconds east of UTC.
    Offset(i64),
    Named(&'static Zone),
}

impl CalendarZone {
    fn offset_ms(&self, instant: i64) -> i64 {
        match self {
            CalendarZone::Offset(offset) => *offset,
            CalendarZone::Named(zone) => zone.offset_at(instant.div_euclid(1000)) * 1000,
        }
    }
}

/// `±HH:MM`, signed, hours at most 23 and minutes at most 59.
fn signed_offset(zone: &str) -> Option<i64> {
    let bytes = zone.as_bytes();
    let sign = match bytes.first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let digit = |at: usize| bytes.get(at).filter(|byte| byte.is_ascii_digit()).map(|byte| i64::from(byte - b'0'));
    if bytes.len() != 6 || bytes[3] != b':' {
        return None;
    }
    let hours = digit(1)? * 10 + digit(2)?;
    let minutes = digit(4)? * 10 + digit(5)?;
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 3_600_000 + minutes * 60_000))
}

fn calendar_zone(zone: &str) -> Option<CalendarZone> {
    match signed_offset(zone) {
        Some(offset) => Some(CalendarZone::Offset(offset)),
        None => zone_named(zone).map(CalendarZone::Named),
    }
}

/// Whether the engine knows the zone.
pub fn known_time_zone(zone: &str) -> bool {
    calendar_zone(zone).is_some()
}

fn in_time_range(instant: i64) -> bool {
    (-MAX_TIME_VALUE..=MAX_TIME_VALUE).contains(&instant)
}

fn civil_in(instant: i64, zone: &CalendarZone) -> Option<CivilTime> {
    if !in_time_range(instant) {
        return None;
    }
    let fields = utc_fields((instant + zone.offset_ms(instant)).div_euclid(1000));
    Some(CivilTime {
        year: if fields.year <= 0 { 1 - fields.year } else { fields.year },
        month: fields.month,
        day: fields.day,
        hour: fields.hour,
        minute: fields.minute,
        second: fields.second,
    })
}

/// The wall clock an instant reads as in a zone; `None` for a zone the engine does not
/// know or an instant outside ECMAScript's range.
pub fn civil_time_in(instant: i64, zone: &str) -> Option<CivilTime> {
    civil_in(instant, &calendar_zone(zone)?)
}

/// V8's `MakeDay`: the day number of a year, a zero-based month and a date, or `None` (NaN)
/// outside the years and months V8 computes.
fn make_day(year: f64, month: f64, date: f64) -> Option<f64> {
    if !((-1_000_000.0..=1_000_000.0).contains(&year) && (-10_000_000.0..=10_000_000.0).contains(&month) && date.is_finite())
    {
        return None;
    }
    let mut year = year.trunc() as i64;
    let mut month = month.trunc() as i64;
    year += month / 12;
    month %= 12;
    if month < 0 {
        month += 12;
        year -= 1;
    }
    const YEAR_DELTA: i64 = 399_999;
    let days_before = |year: i64| {
        let shifted = year + YEAR_DELTA;
        365 * shifted + shifted / 4 - shifted / 100 + shifted / 400
    };
    let common = (year % 4 != 0) || (year % 100 == 0 && year % 400 != 0);
    const COMMON: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const LEAP: [i64; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    let day_of_year = if common { COMMON } else { LEAP }[month as usize];
    let day = days_before(year) - days_before(1970) + day_of_year;
    Some((day - 1) as f64 + date.trunc())
}

/// ECMAScript's time value of a UTC wall clock, the year read as itself — `setUTCFullYear`
/// then `setUTCHours` on the epoch: `MakeDate(MakeDay(…), MakeTime(…))` in double
/// arithmetic, clipped to the time range. `None` is ECMAScript's NaN.
fn ecmascript_time_value(year: f64, month: f64, day: f64, hours: f64, minutes: f64, seconds: f64) -> Option<i64> {
    let day = make_day(year, month, day)?;
    let time = hours.trunc() * 3_600_000.0 + minutes.trunc() * 60_000.0 + seconds.trunc() * 1000.0;
    let date = time + day * MS_PER_DAY;
    (date.is_finite() && date.abs() <= MAX_TIME_VALUE as f64).then(|| date.trunc() as i64)
}

/// The instant a wall clock names read as UTC, its year read as itself — Node's `utcInstantOf`.
fn utc_instant_of(fields: &CivilTime) -> Option<i64> {
    ecmascript_time_value(
        fields.year as f64,
        fields.month as f64 - 1.0,
        fields.day as f64,
        fields.hour as f64,
        fields.minute as f64,
        fields.second as f64,
    )
}

/// The zone's offset at an instant as Node reads it: the wall clock read as UTC, minus the
/// instant. `None` where the instant or that reading is NaN.
fn offset_at(instant: i64, zone: &CalendarZone) -> Option<i64> {
    Some(utc_instant_of(&civil_in(instant, zone)?)? - instant)
}

fn same_wall_clock(left: &CivilTime, right: &CivilTime) -> bool {
    let pairs = [
        (left.year, right.year),
        (left.month, right.month),
        (left.day, right.day),
        (left.hour, right.hour),
        (left.minute, right.minute),
        (left.second, right.second),
    ];
    pairs.iter().all(|&(left, right)| left as f64 == right as f64)
}

/// The instant whose wall clock in `zone` is these fields. The first candidate is the wall
/// clock read as UTC corrected by the offset there, and it wins whenever the offset at it
/// reads back unchanged — which decides every wall clock that occurs twice in the bundled
/// database: the earlier instant west of UTC, the later east of it. Otherwise a second
/// candidate is taken from the offset at the first; the one whose wall clock reads back
/// wins, the earlier where both do, and the later where neither does, so a wall clock a
/// gap skips moves forward out of it, keeping its day. `None` where Node throws: an unknown
/// zone, or a reading outside the time range.
pub fn instant_of_civil_time(fields: &CivilTime, zone: &str) -> Option<i64> {
    let zone = calendar_zone(zone)?;
    solve_wall_clock(fields, |instant| offset_at(instant, &zone), |instant| civil_in(instant, &zone))
}

/// `instantOfCivilTime`'s algorithm, pure over its two readings: `offset_at`, Node's
/// `offsetAt`, and `wall_clock_at`, its `civilTimeIn`; `None` from either is Node's throw.
///
/// The zone's own readings are consistent — `offset_at` is `utc_instant_of` of `wall_clock_at`
/// minus the instant — so a first candidate whose wall clock reads back has an unchanged
/// offset and has already been answered: under them the two branches where it reads back
/// are never reached, and only readings handed in apart reach them.
fn solve_wall_clock(
    fields: &CivilTime,
    offset_at: impl Fn(i64) -> Option<i64>,
    wall_clock_at: impl Fn(i64) -> Option<CivilTime>,
) -> Option<i64> {
    let as_utc = utc_instant_of(fields)?;
    let offset_a = offset_at(as_utc)?;
    let candidate_a = as_utc - offset_a;
    let offset_b = offset_at(candidate_a)?;
    if offset_a == offset_b {
        return Some(candidate_a);
    }
    let candidate_b = as_utc - offset_b;
    let a_holds = same_wall_clock(&wall_clock_at(candidate_a)?, fields);
    let b_holds = same_wall_clock(&wall_clock_at(candidate_b)?, fields);
    Some(match (a_holds, b_holds) {
        (true, true) => candidate_a.min(candidate_b),
        (true, false) => candidate_a,
        (false, true) => candidate_b,
        (false, false) => candidate_a.max(candidate_b),
    })
}

/// The days in a month of a year, the year read as itself; `None` where ECMAScript's
/// answer is NaN, outside its time range.
pub fn days_in_month(year: i64, month: i64) -> Option<i64> {
    let last = ecmascript_time_value(year as f64, month as f64, 0.0, 0.0, 0.0, 0.0)?;
    Some(civil_from_days(last.div_euclid(86_400_000)).2)
}

/// `Date.prototype.toISOString`: `YYYY-MM-DDTHH:mm:ss.sssZ`, the year as six digits with a
/// sign outside 0 to 9999.
fn iso_utc(instant: i64) -> String {
    let fields = utc_fields(instant.div_euclid(1000));
    let year = if (0..=9999).contains(&fields.year) {
        format!("{:04}", fields.year)
    } else {
        format!("{}{:06}", if fields.year < 0 { '-' } else { '+' }, fields.year.unsigned_abs())
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        fields.month,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
        instant.rem_euclid(1000)
    )
}

/// The calendar date (`YYYY-MM-DD`) an instant reads as in a zone. Exactly `UTC` and `Z`
/// take the ISO text's first ten characters; every other zone writes its era year unpadded.
pub fn date_text_in(instant: i64, zone: &str) -> Option<String> {
    if zone == "UTC" || zone == "Z" {
        return in_time_range(instant).then(|| iso_utc(instant)[..10].to_owned());
    }
    let fields = civil_time_in(instant, zone)?;
    Some(format!("{}-{:02}-{:02}", fields.year, fields.month, fields.day))
}

/// A whole number as JavaScript's `String()` writes it, or `NaN`.
fn number_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else {
        format!("{}", value as i64)
    }
}

/// An instant as ISO-8601 in a zone, with milliseconds: exactly `UTC` and `Z` as `…Z`, any
/// other zone with its offset in minutes — the wall clock read as UTC minus the instant,
/// rounded as `Math.round` rounds — and `Z` where that is zero.
pub fn iso_text_in(instant: i64, zone: &str) -> Option<String> {
    if zone == "UTC" || zone == "Z" {
        return in_time_range(instant).then(|| iso_utc(instant));
    }
    let fields = civil_time_in(instant, zone)?;
    let difference = utc_instant_of(&fields).map_or(f64::NAN, |wall| (wall - instant) as f64);
    let minutes = math_round(difference / 60_000.0);
    let offset = if minutes == 0.0 {
        "Z".to_owned()
    } else {
        format!(
            "{}{:0>2}:{:0>2}",
            if minutes > 0.0 { '+' } else { '-' },
            number_text((minutes.abs() / 60.0).floor()),
            number_text(minutes.abs() % 60.0)
        )
    };
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{offset}",
        fields.year,
        fields.month,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
        instant.rem_euclid(1000)
    ))
}

#[cfg(test)]
mod tests {
    //! The solver over synthetic readings, one per branch of `instantOfCivilTime`. Each
    //! expectation is derived from `cel/nodejs/src/zoned-calendar.ts` at `2ee5ef49` line for
    //! line, with Node's `offsetAt` and `civilTimeIn` replaced by the readings given — the
    //! one place this crate's calendar expectations are not executed on Node.
    //!
    //! The bundled database reaches only three of the five: searched over every zone of
    //! `jiff-tzdb` 0.1.8, from 1800 to 2100, every 5 minutes within two days either side of
    //! each of its 64,266 offset changes — 64.8 million wall clocks — none reaches a branch
    //! where the first candidate reads back. Under the zone's own readings none can: a first
    //! candidate whose wall clock reads back has, by `offsetAt`'s definition, the offset it
    //! was solved with, and was answered before.

    use super::*;

    const FIELDS: CivilTime = CivilTime { year: 2026, month: 6, day: 15, hour: 12, minute: 0, second: 0 };
    /// `Date.UTC(2026, 5, 15, 12, 0, 0)`.
    const AS_UTC: i64 = 1_781_524_800_000;
    const HOUR: i64 = 3_600_000;
    const ELSEWHERE: CivilTime = CivilTime { year: 2026, month: 6, day: 15, hour: 13, minute: 0, second: 0 };

    /// `offsetAt(asUtc)` is an hour and `offsetAt(candidateA)`, at `asUtc − 1h`, two hours,
    /// so `candidateB` is `asUtc − 2h`.
    fn two_offsets(instant: i64) -> Option<i64> {
        Some(if instant == AS_UTC { HOUR } else { 2 * HOUR })
    }

    /// The wall clock reads back at `candidateA` (`asUtc − 1h`) and at `candidateB`
    /// (`asUtc − 2h`) as asked.
    fn reading_back(a: bool, b: bool) -> impl Fn(i64) -> Option<CivilTime> {
        move |instant| {
            let holds = if instant == AS_UTC - HOUR { a } else if instant == AS_UTC - 2 * HOUR { b } else { false };
            Some(if holds { FIELDS } else { ELSEWHERE })
        }
    }

    #[test]
    fn utc_instant_of_the_fields() {
        assert_eq!(utc_instant_of(&FIELDS), Some(AS_UTC));
    }

    /// `offsetA === offsetB` → `candidateA`, `asUtc − 1h`; no wall clock is read.
    #[test]
    fn an_unchanged_offset_answers_the_first_candidate() {
        let solved = solve_wall_clock(&FIELDS, |_| Some(HOUR), |_| panic!("no wall clock is read"));
        assert_eq!(solved, Some(AS_UTC - HOUR));
    }

    /// `aHolds && bHolds` → `Math.min(candidateA, candidateB)`, `asUtc − 2h`.
    #[test]
    fn both_reading_back_answers_the_earlier() {
        assert_eq!(solve_wall_clock(&FIELDS, two_offsets, reading_back(true, true)), Some(AS_UTC - 2 * HOUR));
    }

    /// `aHolds` → `candidateA`, `asUtc − 1h`.
    #[test]
    fn only_the_first_reading_back_answers_it() {
        assert_eq!(solve_wall_clock(&FIELDS, two_offsets, reading_back(true, false)), Some(AS_UTC - HOUR));
    }

    /// `bHolds` → `candidateB`, `asUtc − 2h`.
    #[test]
    fn only_the_second_reading_back_answers_it() {
        assert_eq!(solve_wall_clock(&FIELDS, two_offsets, reading_back(false, true)), Some(AS_UTC - 2 * HOUR));
    }

    /// Neither → `Math.max(candidateA, candidateB)`, `asUtc − 1h`.
    #[test]
    fn neither_reading_back_answers_the_later() {
        assert_eq!(solve_wall_clock(&FIELDS, two_offsets, reading_back(false, false)), Some(AS_UTC - HOUR));
    }

    /// A reading that throws on Node — an offset or a wall clock — answers nothing.
    #[test]
    fn a_reading_that_throws_answers_nothing() {
        assert_eq!(solve_wall_clock(&FIELDS, |_| None, reading_back(true, true)), None);
        assert_eq!(solve_wall_clock(&FIELDS, |instant| (instant == AS_UTC).then_some(HOUR), reading_back(true, true)), None);
        assert_eq!(solve_wall_clock(&FIELDS, two_offsets, |_| None), None);
    }
}
