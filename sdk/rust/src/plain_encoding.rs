//! Plain encodings — the one canonical JSON form of each non-live `instance`
//! value type, keyed by the symbolic `encoding` an entry declares.
//!
//! The Rust half of `sdk/nodejs/src/plain-encoding.ts`, and it must read and
//! write exactly what that file does: an entry names its encoding as a symbol,
//! and each runtime maps the symbol to its own codec. `decode` answers "is this
//! text in the encoding, and what does it say" rather than failing, so a reader
//! can leave text it cannot decode for the slot's assertion to report.

use crate::cel_value_identity::{Duration, Timestamp};

/// One plain encoding: its symbol, and how the text is written, for a message
/// pointing an author at the form.
#[derive(Debug, Clone, Copy)]
pub struct PlainEncoding {
    pub name: &'static str,
    pub form: &'static str,
}

/// Every plain encoding this runtime implements — the closed set an entry's
/// `encoding` may name, identical to the Node table.
pub const PLAIN_ENCODINGS: &[PlainEncoding] = &[
    PlainEncoding { name: "base64url", form: "base64url text without padding" },
    PlainEncoding { name: "rfc3339", form: "RFC 3339 text (2026-01-15T09:30:00Z)" },
    PlainEncoding { name: "cel-duration", form: "a CEL duration string within ±315576000000s (1h30m, 250ms, 5400s)" },
];

/// `base64url` — bytes as base64url without padding.
pub mod base64url {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    fn sextet(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }

    /// The bytes `text` encodes, or `None` when it is not base64url. As the
    /// forgiving decoder the Node half uses, bits left over past the last whole
    /// byte are discarded; a length of 1 mod 4 names no whole byte.
    pub fn decode(text: &str) -> Option<Vec<u8>> {
        let input = text.as_bytes();
        if input.len() % 4 == 1 {
            return None;
        }
        let mut out = Vec::with_capacity(input.len() * 3 / 4);
        let mut buffer: u32 = 0;
        let mut bits = 0;
        for &c in input {
            buffer = (buffer << 6) | sextet(c)?;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
        Some(out)
    }

    /// The canonical text of `bytes`.
    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
        for chunk in bytes.chunks(3) {
            let n = chunk.len();
            let word = (chunk[0] as u32) << 16
                | (*chunk.get(1).unwrap_or(&0) as u32) << 8
                | *chunk.get(2).unwrap_or(&0) as u32;
            for i in 0..=n {
                out.push(ALPHABET[((word >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }
}

/// `rfc3339` — a timestamp as RFC 3339 text, written in UTC with milliseconds.
pub mod rfc3339 {
    use super::Timestamp;

    fn digits(text: &[u8], at: usize, count: usize) -> Option<i64> {
        let slice = text.get(at..at + count)?;
        let mut value = 0i64;
        for &c in slice {
            if !c.is_ascii_digit() {
                return None;
            }
            value = value * 10 + (c - b'0') as i64;
        }
        Some(value)
    }

    fn expect(text: &[u8], at: usize, byte: u8) -> Option<()> {
        (text.get(at) == Some(&byte)).then_some(())
    }

    /// The timestamp `text` encodes, or `None`. Any offset is read; a fraction
    /// is read to the millisecond, the precision a timestamp holds.
    pub fn decode(text: &str) -> Option<Timestamp> {
        let t = text.as_bytes();
        let year = digits(t, 0, 4)?;
        expect(t, 4, b'-')?;
        let month = digits(t, 5, 2)?;
        expect(t, 7, b'-')?;
        let day = digits(t, 8, 2)?;
        if !matches!(t.get(10), Some(b'T') | Some(b't')) {
            return None;
        }
        let hour = digits(t, 11, 2)?;
        expect(t, 13, b':')?;
        let minute = digits(t, 14, 2)?;
        expect(t, 16, b':')?;
        let second = digits(t, 17, 2)?;
        let mut at = 19;
        let mut millis = 0i64;
        if t.get(at) == Some(&b'.') {
            let start = at + 1;
            let mut end = start;
            while t.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return None;
            }
            for i in 0..3 {
                millis = millis * 10 + t.get(start + i).filter(|_| start + i < end).map_or(0, |c| (c - b'0') as i64);
            }
            at = end;
        }
        let zone_minutes = match t.get(at) {
            Some(b'Z') | Some(b'z') if t.len() == at + 1 => 0,
            Some(sign @ (b'+' | b'-')) if t.len() == at + 6 => {
                let hours = digits(t, at + 1, 2)?;
                expect(t, at + 3, b':')?;
                let minutes = digits(t, at + 4, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let magnitude = hours * 60 + minutes;
                if *sign == b'-' { -magnitude } else { magnitude }
            }
            _ => return None,
        };
        if !(1..=12).contains(&month)
            || day < 1
            || day > days_in_month(year, month)
            || hour > 23
            || minute > 59
            || second > 59
        {
            return None;
        }
        let fields = days_from_civil(year, month, day) * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1000;
        Timestamp::from_unix_millis(fields + millis - zone_minutes * 60_000)
    }

    /// The canonical text: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    pub fn encode(timestamp: &Timestamp) -> String {
        let millis = timestamp.unix_millis();
        let days = millis.div_euclid(86_400_000);
        let of_day = millis.rem_euclid(86_400_000);
        let (year, month, day) = civil_from_days(days);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            of_day / 3_600_000,
            of_day / 60_000 % 60,
            of_day / 1000 % 60,
            of_day % 1000
        )
    }

    fn is_leap(year: i64) -> bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }

    fn days_in_month(year: i64, month: i64) -> i64 {
        match month {
            2 if is_leap(year) => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        }
    }

    /// Days since 1970-01-01 in the proleptic Gregorian calendar.
    fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (month + 9) % 12;
        let doy = (153 * mp + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    fn civil_from_days(days: i64) -> (i64, i64, i64) {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
        (year, month, day)
    }
}

/// `cel-duration` — a duration as a CEL duration string. Any string CEL's own
/// `duration()` reads is read; the canonical text is seconds (`5400s`).
pub mod cel_duration {
    use super::Duration;

    const NANOS_PER_SECOND: i128 = 1_000_000_000;

    /// protobuf Duration's range, which CEL adopts, in whole seconds either side of zero.
    pub const MAX_SECONDS: u64 = 315_576_000_000;

    fn unit_nanos(unit: &str) -> i128 {
        match unit {
            "h" => 3_600 * NANOS_PER_SECOND,
            "m" => 60 * NANOS_PER_SECOND,
            "s" => NANOS_PER_SECOND,
            "ms" => 1_000_000,
            "us" | "µs" => 1_000,
            _ => 1,
        }
    }

    /// The first unit `rest` starts with, in the order CEL's reader tries them.
    fn unit_at(rest: &str) -> Option<&'static str> {
        ["ns", "us", "µs", "ms", "s", "m", "h"].into_iter().find(|unit| rest.starts_with(unit))
    }

    /// The duration `text` encodes, or `None` — the grammar of CEL's
    /// `duration()`: an optional sign, then one or more decimal numbers, each
    /// with an optional fraction and a unit (`ns`, `us`, `µs`, `ms`, `s`, `m`,
    /// `h`). A fraction is read to 13 digits. A duration outside
    /// ±[`MAX_SECONDS`] is not one.
    pub fn decode(text: &str) -> Option<Duration> {
        if text.is_empty() {
            return None;
        }
        let negative = text.starts_with('-');
        let mut rest = text.strip_prefix(['-', '+']).unwrap_or(text);
        let mut total: i128 = 0;
        loop {
            let integer_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            let integer = &rest[..integer_end];
            let mut after = &rest[integer_end..];
            let mut fraction = "";
            if let Some(stripped) = after.strip_prefix('.') {
                let end = stripped.find(|c: char| !c.is_ascii_digit()).unwrap_or(stripped.len());
                fraction = &stripped[..end];
                after = &stripped[end..];
            }
            let unit = unit_at(after)?;
            let nanos = unit_nanos(unit);
            let whole = if integer.is_empty() { 0 } else { integer.parse::<i128>().ok()? };
            let mut part = whole.checked_mul(nanos)?;
            if !fraction.is_empty() {
                let digits: String = fraction.chars().take(13).collect();
                let padded = format!("{digits:0<13}").parse::<i128>().ok()?;
                part = part.checked_add(padded.checked_mul(nanos)? / 10_000_000_000_000)?;
            }
            total = total.checked_add(part)?;
            rest = &after[unit.len()..];
            if rest.is_empty() {
                break;
            }
        }
        Duration::from_total_nanos(if negative { -total } else { total })
            .filter(|duration| duration.seconds().unsigned_abs() <= MAX_SECONDS)
    }

    /// The canonical text: seconds with a trimmed fraction, as the protobuf JSON
    /// form writes a duration.
    pub fn encode(duration: &Duration) -> String {
        let total = duration.total_nanos();
        let sign = if total < 0 { "-" } else { "" };
        let magnitude = total.unsigned_abs();
        let nanos = magnitude % NANOS_PER_SECOND as u128;
        let fraction = if nanos == 0 {
            String::new()
        } else {
            format!(".{}", format!("{nanos:09}").trim_end_matches('0'))
        };
        format!("{sign}{}{fraction}s", magnitude / NANOS_PER_SECOND as u128)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timestamp_with_an_offset_is_the_same_instant_as_its_utc_text() {
        let east = rfc3339::decode("2026-01-15T09:30:00+02:00").unwrap();
        let utc = rfc3339::decode("2026-01-15T07:30:00Z").unwrap();
        let later = rfc3339::decode("2026-01-15T07:30:00.001Z").unwrap();
        assert_eq!(east, utc);
        assert!(east < later);
        assert_eq!(rfc3339::encode(&east), "2026-01-15T07:30:00.000Z");
    }

    #[test]
    fn reads_every_duration_string_cel_reads() {
        let read = |text: &str| cel_duration::decode(text).map(|d| cel_duration::encode(&d));
        assert_eq!(read("1h30m").as_deref(), Some("5400s"));
        assert_eq!(read("-1.5h").as_deref(), Some("-5400s"));
        assert_eq!(read("250ms").as_deref(), Some("0.25s"));
        assert_eq!(read("1µs").as_deref(), Some("0.000001s"));
        assert_eq!(read("s").as_deref(), Some("0s"));
        assert_eq!(read("1.5.5s"), None);
        assert_eq!(read("5"), None);
        assert_eq!(read("-315576000000.999999999s").as_deref(), Some("-315576000000.999999999s"));
        assert_eq!(read("315576000001s"), None);
        assert_eq!(read(&format!("1{}h", "0".repeat(40))), None);
        assert_eq!(read(""), None);
    }
}
