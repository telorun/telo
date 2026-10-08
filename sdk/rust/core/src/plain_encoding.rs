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

/// `rfc3339` — a timestamp as RFC 3339 text, written in UTC with its fraction
/// trimmed to the nanosecond it holds.
///
/// The STRICT form of the value domain's lenient reading: the shape is checked
/// here, and the calendar, the offset arithmetic and the range are
/// `parse_timestamp`'s.
pub mod rfc3339 {
    use telorun_cel_value::{format_timestamp, parse_timestamp};

    use super::Timestamp;

    fn two_digits(text: &[u8]) -> Option<u8> {
        match text {
            [tens @ b'0'..=b'9', units @ b'0'..=b'9'] => Some((tens - b'0') * 10 + (units - b'0')),
            _ => None,
        }
    }

    /// What this form refuses of text the lenient reading accepts: a space between
    /// the date and the time, a fraction past the nanosecond, and an offset beyond
    /// ±23:59. Everything else about the shape is the lenient reading's to refuse.
    fn is_strict(text: &str) -> bool {
        let text = text.as_bytes();
        if !matches!(text.get(10), Some(b'T' | b't')) {
            return false;
        }
        let Some(mut rest) = text.get(19..) else {
            return false;
        };
        if let Some(fraction) = rest.strip_prefix(b".") {
            let digits = fraction.iter().take_while(|c| c.is_ascii_digit()).count();
            if digits > 9 {
                return false;
            }
            rest = &fraction[digits..];
        }
        match rest {
            [b'+' | b'-', hours @ .., b':', minute_tens, minute_units] => {
                match (two_digits(hours), two_digits(&[*minute_tens, *minute_units])) {
                    (Some(hours), Some(minutes)) => hours <= 23 && minutes <= 59,
                    _ => false,
                }
            }
            _ => true,
        }
    }

    /// The timestamp `text` encodes, or `None`. Any offset is read; a fraction
    /// is read to the nanosecond, the precision a timestamp holds, and a tenth
    /// fractional digit names a precision no timestamp carries, so it is refused
    /// rather than rounded away.
    pub fn decode(text: &str) -> Option<Timestamp> {
        if !is_strict(text) {
            return None;
        }
        parse_timestamp(text).ok().map(Timestamp::from)
    }

    /// The canonical text: `YYYY-MM-DDTHH:MM:SSZ` in UTC, with the fraction
    /// absent when the instant is a whole second and otherwise one to nine
    /// digits with no trailing zero — the rule a duration's text follows.
    pub fn encode(timestamp: &Timestamp) -> String {
        format_timestamp((*timestamp).into())
    }
}

/// `cel-duration` — a duration as a CEL duration string; the canonical text is
/// seconds (`5400s`).
///
/// `decode` reads with a grammar of its own, which is not yet the value domain's
/// `duration_nanos_from_text`: moving to it changes what some text reads as, and
/// awaits the user's confirmation.
pub mod cel_duration {
    use telorun_cel_value::format_duration;

    use super::Duration;

    const NANOS_PER_SECOND: i128 = 1_000_000_000;

    /// protobuf Duration's range, in whole seconds either side of zero. CEL's own
    /// range is narrower and is applied where a duration enters the engine.
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

    /// The duration `text` encodes, or `None`: an optional sign, then one or more decimal numbers, each
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
        format_duration((*duration).into())
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
        assert_eq!(rfc3339::encode(&east), "2026-01-15T07:30:00Z");
    }

    #[test]
    fn reads_a_fraction_to_the_nanosecond_and_refuses_a_tenth_digit() {
        let read = |text: &str| rfc3339::decode(text).map(|t| rfc3339::encode(&t));
        assert_eq!(read("2026-01-15T07:30:00.000000001Z").as_deref(), Some("2026-01-15T07:30:00.000000001Z"));
        assert_eq!(read("2026-01-15T07:30:00.5Z").as_deref(), Some("2026-01-15T07:30:00.5Z"));
        assert_eq!(read("2026-01-15T07:30:00.000Z").as_deref(), Some("2026-01-15T07:30:00Z"));
        assert_eq!(read("2026-01-15T07:30:00.0000000001Z"), None);
        assert_eq!(read("2026-01-15T07:30:00.Z"), None);
        assert_eq!(read("9999-12-31T23:59:59.999999999Z").as_deref(), Some("9999-12-31T23:59:59.999999999Z"));
        assert_eq!(read("0001-01-01T00:00:00Z").as_deref(), Some("0001-01-01T00:00:00Z"));
        assert_eq!(read("0000-12-31T23:59:59Z"), None);
    }

    /// The "plain encodings" cases of `sdk/nodejs/tests/value-type.test.ts`, each answer
    /// the Node SDK's, executed. Every case of that file is here: none is among the
    /// duration texts the two grammars still read differently.
    #[test]
    fn answers_the_node_sdks_plain_encoding_cases() {
        assert_eq!(base64url::encode(&[251, 255, 0]), "-_8A");
        assert_eq!(base64url::decode("-_8A"), Some(vec![251, 255, 0]));
        assert_eq!(base64url::decode("-_8A="), None);

        let instant = |text: &str| rfc3339::decode(text).map(|t| (t.seconds(), t.subsec_nanos(), rfc3339::encode(&t)));
        assert_eq!(instant("2026-01-15T09:30:00.25+02:00"), Some((1768462200, 250000000, "2026-01-15T07:30:00.25Z".into())));
        assert_eq!(instant("2026-01-15T07:30:00.000Z"), Some((1768462200, 0, "2026-01-15T07:30:00Z".into())));
        assert_eq!(instant("2026-01-15T07:30:00.000000001Z"), Some((1768462200, 1, "2026-01-15T07:30:00.000000001Z".into())));
        assert_eq!(rfc3339::encode(&Timestamp::new(1768462200, 1).unwrap()), "2026-01-15T07:30:00.000000001Z");
        // A year below 100 is that year.
        assert_eq!(instant("0050-01-01T00:00:00Z"), Some((-60589296000, 0, "0050-01-01T00:00:00Z".into())));
        for refused in [
            "2026-02-30T00:00:00Z",
            "2026-01-15T09:30:00+24:00",
            "2026-01-15 09:30",
            "2026-01-15T07:30:00.0000000001Z",
            "10000-01-01T00:00:00Z",
        ] {
            assert_eq!(rfc3339::decode(refused), None, "{refused}");
        }

        let span = |text: &str| cel_duration::decode(text).map(|d| cel_duration::encode(&d));
        assert_eq!(span("1h30m").as_deref(), Some("5400s"));
        assert_eq!(cel_duration::encode(&Duration::from_total_nanos(-1_500_000_000).unwrap()), "-1.5s");
        assert_eq!(span("90 minutes"), None);
        // The range is protobuf's, wider than CEL's own: both bounds are pinned.
        assert_eq!(span("-315576000000.999999999s").as_deref(), Some("-315576000000.999999999s"));
        assert_eq!(span("20000000000s").as_deref(), Some("20000000000s"));
        assert_eq!(span("315576000001s"), None);
        assert_eq!(span(&format!("1{}h", "0".repeat(40))), None);
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
