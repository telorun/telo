//! The IANA time zone database, read by the engine — no Node twin: Node reads a zone
//! through its host's Intl, whose data is the host's ICU build.
//!
//! The database is `jiff-tzdb` 0.1.8's: IANA tzdata **2026c**, compiled by `zic` in its
//! default build from the rearguard data, slim. That crate answers two things only —
//! which names exist, matched ignoring ASCII case, and each zone's compiled TZif bytes.
//! Everything else is here: the TZif version 2+ body (its 64-bit transitions and their
//! offsets) and the POSIX TZ string in its footer, which a slim file relies on for every
//! instant after its last transition — `Mm.w.d`, `Jn` and `n` dates, and transition
//! times of extended hours (RFC 8536).
//!
//! A zone is read once per process, on first use, and then served without a lock; the
//! memo is bounded by the database's names. The bytes are pinned with the crate, so a
//! zone this reader cannot read is a defect of the engine and panics naming it.

use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};

use telorun_cel_value::{days_from_civil, days_in_month, is_leap_year, utc_fields};

/// One zone: its explicit transitions, and the rule after the last of them.
pub(crate) struct Zone {
    /// UTC seconds of each transition, ascending.
    transitions: Vec<i64>,
    /// The offset from UTC, in seconds, from each transition on.
    offsets: Vec<i32>,
    /// The offset before the first transition: the file's first local time type.
    initial: i32,
    /// The footer's rule, for every instant from the last transition on.
    rule: Option<PosixRule>,
}

/// Where a rule's daylight time starts or ends: a date in the year, and a time on it.
#[derive(Clone, Copy, Debug)]
struct RuleTransition {
    date: RuleDate,
    /// Seconds after the date's midnight, local time; RFC 8536 lets it run −167…167 hours.
    time: i64,
}

#[derive(Clone, Copy, Debug)]
enum RuleDate {
    /// `Jn`: day 1…365, February 29 never counted.
    Julian(i64),
    /// `n`: day 0…365, February 29 counted.
    Ordinal(i64),
    /// `Mm.w.d`: the `w`-th day `d` (0 Sunday) of month `m`, week 5 the last.
    Weekday { month: i64, week: i64, day: i64 },
}

#[derive(Clone, Copy, Debug)]
struct Daylight {
    offset: i64,
    start: RuleTransition,
    end: RuleTransition,
}

/// A POSIX TZ string: standard time, and daylight time with its two transitions.
#[derive(Clone, Copy, Debug)]
struct PosixRule {
    /// Seconds east of UTC.
    standard: i64,
    daylight: Option<Daylight>,
}

/// Every name the database holds, by its canonical spelling, each read on first use.
static ZONES: LazyLock<HashMap<&'static str, OnceLock<Zone>>> =
    LazyLock::new(|| jiff_tzdb::available().map(|name| (name, OnceLock::new())).collect());

/// The zone a name names, matched ignoring ASCII case, or nothing.
pub(crate) fn zone_named(name: &str) -> Option<&'static Zone> {
    let (canonical, bytes) = jiff_tzdb::get(name)?;
    let slot = ZONES.get(canonical).expect("every name the database answers is listed");
    Some(slot.get_or_init(|| read_tzif(canonical, bytes)))
}

impl Zone {
    /// The offset from UTC, in seconds, at an instant given in UTC seconds.
    pub(crate) fn offset_at(&self, seconds: i64) -> i64 {
        let Some(&last) = self.transitions.last() else {
            return match &self.rule {
                Some(rule) => rule.offset_at(seconds),
                None => i64::from(self.initial),
            };
        };
        if seconds >= last {
            if let Some(rule) = &self.rule {
                return rule.offset_at(seconds);
            }
        }
        match self.transitions.partition_point(|&at| at <= seconds) {
            0 => i64::from(self.initial),
            after => i64::from(self.offsets[after - 1]),
        }
    }
}

impl PosixRule {
    fn offset_at(&self, seconds: i64) -> i64 {
        let Some(daylight) = self.daylight else {
            return self.standard;
        };
        // The rule's transitions in the years around the instant, in order; the last one
        // at or before it decides. A tie goes to the later year's, so a rule that ends
        // daylight time at the very instant the next year starts it keeps it all year.
        let year = utc_fields(seconds).year;
        let mut latest: Option<(i64, i64, bool)> = None;
        for year in year - 1..=year + 1 {
            let start = local_seconds(year, daylight.start) - self.standard;
            let end = local_seconds(year, daylight.end) - daylight.offset;
            for (at, is_start, order) in [(start, true, year * 2 + 1), (end, false, year * 2)] {
                if at <= seconds && latest.is_none_or(|(held, held_order, _)| (at, order) > (held, held_order)) {
                    latest = Some((at, order, is_start));
                }
            }
        }
        match latest {
            Some((_, _, true)) => daylight.offset,
            _ => self.standard,
        }
    }
}

/// The local seconds since the epoch at which a rule's transition falls in a year.
fn local_seconds(year: i64, transition: RuleTransition) -> i64 {
    let day = match transition.date {
        RuleDate::Julian(day) => days_from_civil(year, 1, 1) + day - 1 + i64::from(is_leap_year(year) && day >= 60),
        RuleDate::Ordinal(day) => days_from_civil(year, 1, 1) + day,
        RuleDate::Weekday { month, week, day } => {
            let first = days_from_civil(year, month, 1);
            // The epoch was a Thursday, day 4 counting Sunday as 0.
            let first_weekday = (first + 4).rem_euclid(7);
            let mut date = 1 + (day - first_weekday).rem_euclid(7) + (week - 1) * 7;
            while date > days_in_month(year, month) {
                date -= 7;
            }
            first + date - 1
        }
    };
    day * 86_400 + transition.time
}

// --- reading TZif ----------------------------------------------------------

struct Bytes<'a> {
    zone: &'a str,
    data: &'a [u8],
    at: usize,
}

impl<'a> Bytes<'a> {
    fn take(&mut self, count: usize) -> &'a [u8] {
        let taken = self
            .data
            .get(self.at..self.at + count)
            .unwrap_or_else(|| panic!("the bundled zone {} ends inside its TZif data", self.zone));
        self.at += count;
        taken
    }

    fn u32(&mut self) -> usize {
        u32::from_be_bytes(self.take(4).try_into().expect("four bytes")) as usize
    }

    fn i32(&mut self) -> i32 {
        i32::from_be_bytes(self.take(4).try_into().expect("four bytes"))
    }

    fn i64(&mut self) -> i64 {
        i64::from_be_bytes(self.take(8).try_into().expect("eight bytes"))
    }
}

struct Counts {
    utc_indicators: usize,
    standard_indicators: usize,
    leaps: usize,
    transitions: usize,
    types: usize,
    designations: usize,
}

fn header(bytes: &mut Bytes<'_>) -> (u8, Counts) {
    if bytes.take(4) != b"TZif" {
        panic!("the bundled zone {} is not TZif", bytes.zone);
    }
    let version = bytes.take(1)[0];
    bytes.take(15);
    let counts = Counts {
        utc_indicators: bytes.u32(),
        standard_indicators: bytes.u32(),
        leaps: bytes.u32(),
        transitions: bytes.u32(),
        types: bytes.u32(),
        designations: bytes.u32(),
    };
    (version, counts)
}

fn read_tzif(zone: &str, data: &[u8]) -> Zone {
    let mut bytes = Bytes { zone, data, at: 0 };
    let (version, first) = header(&mut bytes);
    if version < b'2' {
        panic!("the bundled zone {zone} is TZif version 1, which holds no 64-bit data");
    }
    // The version 1 body, which the version 2+ body repeats with 64-bit times.
    bytes.take(
        first.transitions * 5
            + first.types * 6
            + first.designations
            + first.leaps * 8
            + first.standard_indicators
            + first.utc_indicators,
    );
    let (_, counts) = header(&mut bytes);
    let transitions: Vec<i64> = (0..counts.transitions).map(|_| bytes.i64()).collect();
    let indices: Vec<usize> = bytes.take(counts.transitions).iter().map(|&index| index as usize).collect();
    let offsets_of_types: Vec<i32> = (0..counts.types)
        .map(|_| {
            let offset = bytes.i32();
            bytes.take(2);
            offset
        })
        .collect();
    bytes.take(counts.designations + counts.leaps * 12 + counts.standard_indicators + counts.utc_indicators);
    let type_offset = |index: usize| {
        *offsets_of_types.get(index).unwrap_or_else(|| panic!("the bundled zone {zone} names a time type it lacks"))
    };
    let footer = &data[bytes.at..];
    let footer = footer
        .strip_prefix(b"\n")
        .and_then(|rest| rest.iter().position(|&byte| byte == b'\n').map(|end| &rest[..end]))
        .unwrap_or_else(|| panic!("the bundled zone {zone} has no TZ string footer"));
    let footer = std::str::from_utf8(footer).unwrap_or_else(|_| panic!("the bundled zone {zone}'s footer is not text"));
    Zone {
        offsets: indices.iter().map(|&index| type_offset(index)).collect(),
        transitions,
        initial: type_offset(0),
        rule: (!footer.is_empty()).then(|| read_posix_rule(zone, footer)),
    }
}

// --- reading a POSIX TZ string -----------------------------------------------

struct Rule<'a> {
    zone: &'a str,
    text: &'a str,
    at: usize,
}

impl Rule<'_> {
    fn fail(&self) -> ! {
        panic!("the bundled zone {}'s TZ string {:?} does not read at {}", self.zone, self.text, self.at)
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let eaten = self.peek() == Some(byte);
        self.at += usize::from(eaten);
        eaten
    }

    fn name(&mut self) {
        if self.eat(b'<') {
            while !self.eat(b'>') {
                if self.peek().is_none() {
                    self.fail();
                }
                self.at += 1;
            }
            return;
        }
        let from = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_alphabetic()) {
            self.at += 1;
        }
        if self.at - from < 3 {
            self.fail();
        }
    }

    fn number(&mut self) -> i64 {
        let from = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.at += 1;
        }
        self.text[from..self.at].parse().unwrap_or_else(|_| self.fail())
    }

    /// `[+-]hh[:mm[:ss]]`, as seconds.
    fn duration(&mut self) -> i64 {
        let negative = self.eat(b'-');
        if !negative {
            self.eat(b'+');
        }
        let mut seconds = self.number() * 3600;
        if self.eat(b':') {
            seconds += self.number() * 60;
            if self.eat(b':') {
                seconds += self.number();
            }
        }
        if negative {
            -seconds
        } else {
            seconds
        }
    }

    fn transition(&mut self) -> RuleTransition {
        let date = if self.eat(b'J') {
            RuleDate::Julian(self.number())
        } else if self.eat(b'M') {
            let month = self.number();
            if !self.eat(b'.') {
                self.fail();
            }
            let week = self.number();
            if !self.eat(b'.') {
                self.fail();
            }
            RuleDate::Weekday { month, week, day: self.number() }
        } else {
            RuleDate::Ordinal(self.number())
        };
        let time = if self.eat(b'/') { self.duration() } else { 2 * 3600 };
        RuleTransition { date, time }
    }
}

fn read_posix_rule(zone: &str, text: &str) -> PosixRule {
    let mut rule = Rule { zone, text, at: 0 };
    rule.name();
    // POSIX writes an offset west of UTC as positive.
    let standard = -rule.duration();
    if rule.peek().is_none() {
        return PosixRule { standard, daylight: None };
    }
    rule.name();
    let offset = match rule.peek() {
        Some(b',') | None => standard + 3600,
        Some(_) => -rule.duration(),
    };
    let (start, end) = if rule.eat(b',') {
        let start = rule.transition();
        if !rule.eat(b',') {
            rule.fail();
        }
        (start, rule.transition())
    } else {
        // POSIX leaves the rule to the implementation; this is the United States' own.
        (
            RuleTransition { date: RuleDate::Weekday { month: 3, week: 2, day: 0 }, time: 2 * 3600 },
            RuleTransition { date: RuleDate::Weekday { month: 11, week: 1, day: 0 }, time: 2 * 3600 },
        )
    };
    if rule.peek().is_some() {
        rule.fail();
    }
    PosixRule { standard, daylight: Some(Daylight { offset, start, end }) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundles_iana_2026c() {
        assert_eq!(jiff_tzdb::VERSION, Some("2026c"));
    }

    #[test]
    fn reads_every_zone_the_database_holds() {
        assert_eq!(ZONES.len(), 598);
        for name in jiff_tzdb::available() {
            let zone = zone_named(name).unwrap_or_else(|| panic!("{name} is held"));
            zone.offset_at(0);
            zone.offset_at(4_102_444_800);
        }
    }
}
