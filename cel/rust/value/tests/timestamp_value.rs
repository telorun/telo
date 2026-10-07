//! Instant text, range and calendar, as literal tables.
//!
//! No Node test twins this file: `cel/nodejs` proves `timestamp-value.ts` through
//! evaluation and through the conformance vectors, neither of which this crate may
//! read. Each row is the Node build's answer for that input, executed — the civil
//! fields are its `zonedFields` in UTC.

use telorun_cel_value::{
    cel_timestamp, cel_timestamp_from_millis, civil_from_days, days_from_civil, days_in_month,
    format_timestamp, is_leap_year, parse_timestamp, seconds_from_fields, timestamp_nanos, utc_fields,
    CelError, CelTimestamp, CivilFields, MAX_TIMESTAMP_SECONDS, MIN_TIMESTAMP_SECONDS,
};

type Refusal = (&'static str, &'static str);

fn refusal(error: CelError) -> (&'static str, String) {
    assert_eq!(error.range, None);
    (error.code.as_str(), error.message)
}

fn expected(refusal: &Refusal) -> (&'static str, String) {
    (refusal.0, refusal.1.to_string())
}

#[test]
fn reads_rfc_3339_text_leniently_and_writes_it_canonically() {
    // The text, then the seconds, the nanoseconds and the canonical text it reads as.
    const NODE_TEXT: &[(&str, Result<(i64, u32, &str), Refusal>)] = &[
        ("2026-01-15T09:30:00Z", Ok((1768469400, 0, "2026-01-15T09:30:00Z"))),
        ("2026-01-15t09:30:00z", Ok((1768469400, 0, "2026-01-15T09:30:00Z"))),
        ("2026-01-15 09:30:00Z", Ok((1768469400, 0, "2026-01-15T09:30:00Z"))),
        ("2026-01-15T09:30:00+02:00", Ok((1768462200, 0, "2026-01-15T07:30:00Z"))),
        ("2026-01-15T09:30:00-08:00", Ok((1768498200, 0, "2026-01-15T17:30:00Z"))),
        ("2026-01-15T09:30:00+00:00", Ok((1768469400, 0, "2026-01-15T09:30:00Z"))),
        ("2026-01-15T09:30:00-00:00", Ok((1768469400, 0, "2026-01-15T09:30:00Z"))),
        ("2026-01-15T09:30:00+99:99", Ok((1768107060, 0, "2026-01-11T04:51:00Z"))),
        ("2026-01-15T09:30:00-99:99", Ok((1768831740, 0, "2026-01-19T14:09:00Z"))),
        ("2026-01-15T09:30:00+24:00", Ok((1768383000, 0, "2026-01-14T09:30:00Z"))),
        ("2026-01-15T09:30:00+00:60", Ok((1768465800, 0, "2026-01-15T08:30:00Z"))),
        ("2026-01-15T09:30:00.5Z", Ok((1768469400, 500000000, "2026-01-15T09:30:00.5Z"))),
        ("2026-01-15T09:30:00.5+02:00", Ok((1768462200, 500000000, "2026-01-15T07:30:00.5Z"))),
        ("2026-01-15T09:30:00.000Z", Ok((1768469400, 0, "2026-01-15T09:30:00Z"))),
        ("2026-01-15T09:30:00.123456789Z", Ok((1768469400, 123456789, "2026-01-15T09:30:00.123456789Z"))),
        ("2026-01-15T09:30:00.0000000019Z", Ok((1768469400, 1, "2026-01-15T09:30:00.000000001Z"))),
        ("2026-01-15T09:30:00.1234567891234Z", Ok((1768469400, 123456789, "2026-01-15T09:30:00.123456789Z"))),
        ("2026-01-15T09:30:00.000000001Z", Ok((1768469400, 1, "2026-01-15T09:30:00.000000001Z"))),
        ("2026-01-15T09:30:00.Z", Err(("invalid_conversion", "\"2026-01-15T09:30:00.Z\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00", Err(("invalid_conversion", "\"2026-01-15T09:30:00\" is not an RFC 3339 instant"))),
        ("2026-01-15", Err(("invalid_conversion", "\"2026-01-15\" is not an RFC 3339 instant"))),
        ("", Err(("invalid_conversion", "\"\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00+0200", Err(("invalid_conversion", "\"2026-01-15T09:30:00+0200\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00+02", Err(("invalid_conversion", "\"2026-01-15T09:30:00+02\" is not an RFC 3339 instant"))),
        ("2026-1-15T09:30:00Z", Err(("invalid_conversion", "\"2026-1-15T09:30:00Z\" is not an RFC 3339 instant"))),
        ("2026-01-15T9:30:00Z", Err(("invalid_conversion", "\"2026-01-15T9:30:00Z\" is not an RFC 3339 instant"))),
        ("2026-01-15_09:30:00Z", Err(("invalid_conversion", "\"2026-01-15_09:30:00Z\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00ZZ", Err(("invalid_conversion", "\"2026-01-15T09:30:00ZZ\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00 Z", Err(("invalid_conversion", "\"2026-01-15T09:30:00 Z\" is not an RFC 3339 instant"))),
        (" 2026-01-15T09:30:00Z", Err(("invalid_conversion", "\" 2026-01-15T09:30:00Z\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00Z\u{a}", Err(("invalid_conversion", "\"2026-01-15T09:30:00Z\\n\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30Z", Err(("invalid_conversion", "\"2026-01-15T09:30Z\" is not an RFC 3339 instant"))),
        ("٢٠٢٦-01-15T09:30:00Z", Err(("invalid_conversion", "\"٢٠٢٦-01-15T09:30:00Z\" is not an RFC 3339 instant"))),
        ("say \"when\"", Err(("invalid_conversion", "\"say \\\"when\\\"\" is not an RFC 3339 instant"))),
        ("2026-01-15T09:30:00 Z", Err(("invalid_conversion", "\"2026-01-15T09:30:00 Z\" is not an RFC 3339 instant"))),
        ("2026-13-15T09:30:00Z", Err(("invalid_conversion", "\"2026-13-15T09:30:00Z\" is not an instant"))),
        ("2026-00-15T09:30:00Z", Err(("invalid_conversion", "\"2026-00-15T09:30:00Z\" is not an instant"))),
        ("2026-01-00T09:30:00Z", Err(("invalid_conversion", "\"2026-01-00T09:30:00Z\" is not an instant"))),
        ("2026-01-32T09:30:00Z", Err(("invalid_conversion", "\"2026-01-32T09:30:00Z\" is not an instant"))),
        ("2026-04-31T09:30:00Z", Err(("invalid_conversion", "\"2026-04-31T09:30:00Z\" is not an instant"))),
        ("2024-02-29T00:00:00Z", Ok((1709164800, 0, "2024-02-29T00:00:00Z"))),
        ("2023-02-29T00:00:00Z", Err(("invalid_conversion", "\"2023-02-29T00:00:00Z\" is not an instant"))),
        ("1900-02-29T00:00:00Z", Err(("invalid_conversion", "\"1900-02-29T00:00:00Z\" is not an instant"))),
        ("2000-02-29T00:00:00Z", Ok((951782400, 0, "2000-02-29T00:00:00Z"))),
        ("2026-01-15T24:00:00Z", Err(("invalid_conversion", "\"2026-01-15T24:00:00Z\" is not an instant"))),
        ("2026-01-15T23:60:00Z", Err(("invalid_conversion", "\"2026-01-15T23:60:00Z\" is not an instant"))),
        ("2026-01-15T23:59:60Z", Err(("invalid_conversion", "\"2026-01-15T23:59:60Z\" is not an instant"))),
        ("2026-01-15T23:59:59Z", Ok((1768521599, 0, "2026-01-15T23:59:59Z"))),
        ("1970-01-01T00:00:00Z", Ok((0, 0, "1970-01-01T00:00:00Z"))),
        ("1969-12-31T23:59:59.999999999Z", Ok((-1, 999999999, "1969-12-31T23:59:59.999999999Z"))),
        ("0001-01-01T00:00:00Z", Ok((-62135596800, 0, "0001-01-01T00:00:00Z"))),
        ("0000-12-31T23:59:59Z", Err(("invalid_conversion", "timestamp out of range"))),
        ("0000-02-30T00:00:00Z", Err(("invalid_conversion", "\"0000-02-30T00:00:00Z\" is not an instant"))),
        ("0001-01-01T00:00:00+00:01", Err(("invalid_conversion", "timestamp out of range"))),
        ("0001-01-01T00:00:00-00:01", Ok((-62135596740, 0, "0001-01-01T00:01:00Z"))),
        ("0000-12-31T23:59:59-00:01", Ok((-62135596741, 0, "0001-01-01T00:00:59Z"))),
        ("9999-12-31T23:59:59.999999999Z", Ok((253402300799, 999999999, "9999-12-31T23:59:59.999999999Z"))),
        ("9999-12-31T23:59:59Z", Ok((253402300799, 0, "9999-12-31T23:59:59Z"))),
        ("9999-12-31T23:59:59-00:01", Err(("invalid_conversion", "timestamp out of range"))),
        ("9999-12-31T23:59:59+00:01", Ok((253402300739, 0, "9999-12-31T23:58:59Z"))),
        ("10000-01-01T00:00:00Z", Err(("invalid_conversion", "\"10000-01-01T00:00:00Z\" is not an RFC 3339 instant"))),
        ("2009-02-13T23:31:30Z", Ok((1234567890, 0, "2009-02-13T23:31:30Z"))),
        ("2009-02-13T23:31:30.321Z", Ok((1234567890, 321000000, "2009-02-13T23:31:30.321Z"))),
    ];
    for (text, parsed) in NODE_TEXT {
        assert_eq!(
            parse_timestamp(text)
                .map(|held| (held.seconds(), held.subsec_nanos(), format_timestamp(held)))
                .map_err(refusal),
            parsed.as_ref().map(|(seconds, nanos, canonical)| (*seconds, *nanos, canonical.to_string())).map_err(expected),
            "{text:?}"
        );
    }
}

#[test]
fn normalizes_seconds_and_nanoseconds_of_any_sign_into_the_range() {
    // Seconds and nanoseconds as given, then: the normalized pair, the nanoseconds
    // since the epoch, the canonical text, and the civil fields in UTC.
    const NODE_PARTS: &[(i128, i128, Result<(i64, u32, i128, &str, [i64; 6]), Refusal>)] = &[
        (0, 0, Ok((0, 0, 0, "1970-01-01T00:00:00Z", [1970, 1, 1, 0, 0, 0]))),
        (1768462200, 0, Ok((1768462200, 0, 1768462200000000000, "2026-01-15T07:30:00Z", [2026, 1, 15, 7, 30, 0]))),
        (-2, 500000000, Ok((-2, 500000000, -1500000000, "1969-12-31T23:59:58.5Z", [1969, 12, 31, 23, 59, 58]))),
        (0, -1, Ok((-1, 999999999, -1, "1969-12-31T23:59:59.999999999Z", [1969, 12, 31, 23, 59, 59]))),
        (0, 1000000000, Ok((1, 0, 1000000000, "1970-01-01T00:00:01Z", [1970, 1, 1, 0, 0, 1]))),
        (0, -1000000000, Ok((-1, 0, -1000000000, "1969-12-31T23:59:59Z", [1969, 12, 31, 23, 59, 59]))),
        (5, 2500000000, Ok((7, 500000000, 7500000000, "1970-01-01T00:00:07.5Z", [1970, 1, 1, 0, 0, 7]))),
        (5, -2500000000, Ok((2, 500000000, 2500000000, "1970-01-01T00:00:02.5Z", [1970, 1, 1, 0, 0, 2]))),
        (-62135596800, 0, Ok((-62135596800, 0, -62135596800000000000, "0001-01-01T00:00:00Z", [1, 1, 1, 0, 0, 0]))),
        (-62135596800, -1, Err(("invalid_conversion", "timestamp out of range"))),
        (-62135596801, 1000000000, Ok((-62135596800, 0, -62135596800000000000, "0001-01-01T00:00:00Z", [1, 1, 1, 0, 0, 0]))),
        (253402300799, 999999999, Ok((253402300799, 999999999, 253402300799999999999, "9999-12-31T23:59:59.999999999Z", [9999, 12, 31, 23, 59, 59]))),
        (253402300799, 1000000000, Err(("invalid_conversion", "timestamp out of range"))),
        (253402300800, 0, Err(("invalid_conversion", "timestamp out of range"))),
        (253402300800, -1, Ok((253402300799, 999999999, 253402300799999999999, "9999-12-31T23:59:59.999999999Z", [9999, 12, 31, 23, 59, 59]))),
        (0, 253402300799999999999, Ok((253402300799, 999999999, 253402300799999999999, "9999-12-31T23:59:59.999999999Z", [9999, 12, 31, 23, 59, 59]))),
        (0, 253402300800000000000, Err(("invalid_conversion", "timestamp out of range"))),
        (1234567890, 0, Ok((1234567890, 0, 1234567890000000000, "2009-02-13T23:31:30Z", [2009, 2, 13, 23, 31, 30]))),
        (951782400, 0, Ok((951782400, 0, 951782400000000000, "2000-02-29T00:00:00Z", [2000, 2, 29, 0, 0, 0]))),
        (1000000000, 100000000, Ok((1000000000, 100000000, 1000000000100000000, "2001-09-09T01:46:40.1Z", [2001, 9, 9, 1, 46, 40]))),
        (1000000000, 1, Ok((1000000000, 1, 1000000000000000001, "2001-09-09T01:46:40.000000001Z", [2001, 9, 9, 1, 46, 40]))),
        (1000000000, 120000, Ok((1000000000, 120000, 1000000000000120000, "2001-09-09T01:46:40.00012Z", [2001, 9, 9, 1, 46, 40]))),
        (-1, 999999999, Ok((-1, 999999999, -1, "1969-12-31T23:59:59.999999999Z", [1969, 12, 31, 23, 59, 59]))),
        (-86400, 0, Ok((-86400, 0, -86400000000000, "1969-12-31T00:00:00Z", [1969, 12, 31, 0, 0, 0]))),
        (-86401, 0, Ok((-86401, 0, -86401000000000, "1969-12-30T23:59:59Z", [1969, 12, 30, 23, 59, 59]))),
        (68169600, 0, Ok((68169600, 0, 68169600000000000, "1972-02-29T00:00:00Z", [1972, 2, 29, 0, 0, 0]))),
        (4107542399, 0, Ok((4107542399, 0, 4107542399000000000, "2100-02-28T23:59:59Z", [2100, 2, 28, 23, 59, 59]))),
    ];
    for (seconds, nanos, built) in NODE_PARTS {
        let held = cel_timestamp(*seconds, *nanos);
        let Ok((whole, rest, total, canonical, [year, month, day, hour, minute, second])) = built else {
            assert_eq!(held.map_err(refusal).err(), built.as_ref().map_err(expected).err(), "{seconds} {nanos}");
            continue;
        };
        let held = held.unwrap();
        assert_eq!((held.seconds(), held.subsec_nanos(), held.unix_nanos()), (*whole, *rest, *total));
        assert_eq!(timestamp_nanos(held), *total);
        assert_eq!(CelTimestamp::new(*whole, *rest), Some(held));
        assert_eq!(CelTimestamp::from_unix_nanos(*total), Some(held));
        assert_eq!(format_timestamp(held), *canonical);
        assert_eq!(held.to_string(), *canonical);
        let fields =
            CivilFields { year: *year, month: *month, day: *day, hour: *hour, minute: *minute, second: *second };
        assert_eq!(utc_fields(*whole), fields, "{canonical}");
        assert_eq!(seconds_from_fields(&fields), *whole, "{canonical}");
        let days = whole.div_euclid(86_400);
        assert_eq!(days_from_civil(*year, *month, *day), days, "{canonical}");
        assert_eq!(civil_from_days(days), (*year, *month, *day), "{canonical}");
    }
}

#[test]
fn reads_epoch_milliseconds_keeping_the_sub_millisecond_part() {
    // The reading, as the bits of its double.
    const NODE_MILLIS: &[(u64, Result<(i64, u32), Refusal>)] = &[
        (0x4279bc08facc0000, /* 1768462200000 */ Ok((1768462200, 0))),
        (0xc097700000000000, /* -1500 */ Ok((-2, 500000000))),
        (0x3eb0c6f7a0b5ed8d, /* 0.000001 */ Ok((0, 1))),
        (0x42eccefa43fb8000, /* 253402300800000 */ Err(("invalid_conversion", "timestamp out of range"))),
        (0x7ff8000000000000, /* NaN */ Err(("invalid_conversion", "timestamp out of range"))),
        (0x7ff0000000000000, /* Infinity */ Err(("invalid_conversion", "timestamp out of range"))),
        (0xfff0000000000000, /* -Infinity */ Err(("invalid_conversion", "timestamp out of range"))),
        (0x0000000000000000, /* 0 */ Ok((0, 0))),
        (0x8000000000000000, /* 0 */ Ok((0, 0))),
        (0x3ff8000000000000, /* 1.5 */ Ok((0, 1500000))),
        (0xbfe0000000000000, /* -0.5 */ Ok((-1, 999500000))),
        (0x3e9ad7f29abcaf48, /* 4e-7 */ Ok((0, 0))),
        (0x3ea0c6f7a0b5ed8d, /* 5e-7 */ Ok((0, 1))),
        (0x3eb92a737110e454, /* 0.0000015 */ Ok((0, 2))),
        (0x7e37e43c8800759c, /* 1e+300 */ Err(("invalid_conversion", "timestamp out of range"))),
        (0xfe37e43c8800759c, /* -1e+300 */ Err(("invalid_conversion", "timestamp out of range"))),
        (0xc2cc4189166c0000, /* -62135596800000 */ Ok((-62135596800, 0))),
        (0xc2cc4189166c0080, /* -62135596800001 */ Err(("invalid_conversion", "timestamp out of range"))),
        (0xc2cc4189166c0040, /* -62135596800000.5 */ Err(("invalid_conversion", "timestamp out of range"))),
        (0x42eccefa43fb7fe0, /* 253402300799999 */ Ok((253402300799, 999000000))),
        (0x42eccefa43fb7ffd, /* 253402300799999.9 */ Ok((253402300799, 999906250))),
        (0x4279bc08fad3b74c, /* 1768462200123.456 */ Ok((1768462200, 123456055))),
        (0x3fd3333333333334, /* 0.30000000000000004 */ Ok((0, 300000))),
        (0xbeb0c6f7a0b5ed8d, /* -0.000001 */ Ok((-1, 999999999))),
        (0x408f3ffffff29407, /* 999.9999999 */ Ok((1, 0))),
        (0x408f3fffffca501b, /* 999.9999996 */ Ok((1, 0))),
        (0x4271f71fb04cb74f, /* 1234567890123.4568 */ Ok((1234567890, 123456787))),
    ];
    for (bits, built) in NODE_MILLIS {
        let millis = f64::from_bits(*bits);
        assert_eq!(
            cel_timestamp_from_millis(millis).map(|held| (held.seconds(), held.subsec_nanos())).map_err(refusal),
            built.as_ref().map(|parts| *parts).map_err(expected),
            "{millis}"
        );
    }
}

/// The carrier's own refusals and the calendar's month lengths. Node has no carrier
/// constructor and exports no month length, so these are this crate's: the SDK's
/// `Timestamp` answers, and the lengths `parse_timestamp` refuses a day by.
#[test]
fn answers_nothing_for_an_instant_the_carrier_does_not_hold() {
    assert_eq!(CelTimestamp::new(0, 1_000_000_000), None);
    assert_eq!(CelTimestamp::new(MIN_TIMESTAMP_SECONDS - 1, 999_999_999), None);
    assert_eq!(CelTimestamp::new(MAX_TIMESTAMP_SECONDS + 1, 0), None);
    assert_eq!(CelTimestamp::from_unix_nanos(CelTimestamp::MIN_UNIX_NANOS - 1), None);
    assert_eq!(CelTimestamp::from_unix_nanos(CelTimestamp::MAX_UNIX_NANOS + 1), None);
    assert_eq!(CelTimestamp::new(MIN_TIMESTAMP_SECONDS, 0).map(format_timestamp).as_deref(), Some("0001-01-01T00:00:00Z"));
    assert!(CelTimestamp::new(-1, 999_999_999) < CelTimestamp::new(0, 0));

    assert_eq!([2024, 2023, 1900, 2000].map(is_leap_year), [true, false, false, true]);
    assert_eq!((1..=12).map(|month| days_in_month(2023, month)).collect::<Vec<_>>(), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    assert_eq!(days_in_month(2024, 2), 29);
}
