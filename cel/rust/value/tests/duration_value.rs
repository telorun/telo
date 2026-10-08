//! Duration text, range and fields, as literal tables.
//!
//! No Node test twins this file: `cel/nodejs` proves `duration-value.ts` through
//! evaluation and through the conformance vectors, neither of which this crate may
//! read. Each row is the Node build's answer for that input, executed — except where a
//! comment says the answer is this crate's own.

use telorun_cel_value::{
    cel_duration_from_nanos, duration_field, duration_nanos, duration_nanos_from_text,
    duration_out_of_range, format_duration, parse_duration, CelDuration, CelError, DurationField,
    MAX_DURATION_NANOS, MIN_DURATION_NANOS,
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
fn reads_duration_text_with_and_without_cels_range() {
    // The text, its total of nanoseconds with no range applied, and its canonical text
    // under CEL's range.
    const NODE_TEXT: &[(&str, Result<i128, Refusal>, Result<&str, Refusal>)] = &[
        ("0", Ok(0), Ok("0s")),
        ("+0", Ok(0), Ok("0s")),
        ("-0", Ok(0), Ok("0s")),
        ("", Err(("invalid_conversion", "\"\" is not a duration")), Err(("invalid_conversion", "\"\" is not a duration"))),
        ("+", Err(("invalid_conversion", "\"+\" is not a duration")), Err(("invalid_conversion", "\"+\" is not a duration"))),
        ("-", Err(("invalid_conversion", "\"-\" is not a duration")), Err(("invalid_conversion", "\"-\" is not a duration"))),
        ("s", Err(("invalid_conversion", "\"s\" is not a duration")), Err(("invalid_conversion", "\"s\" is not a duration"))),
        (".s", Err(("invalid_conversion", "\".s\" is not a duration")), Err(("invalid_conversion", "\".s\" is not a duration"))),
        ("1.s", Ok(1000000000), Ok("1s")),
        (".5s", Ok(500000000), Ok("0.5s")),
        ("+.5s", Ok(500000000), Ok("0.5s")),
        ("0.s", Ok(0), Ok("0s")),
        ("0.", Err(("invalid_conversion", "\"0.\" is not a duration")), Err(("invalid_conversion", "\"0.\" is not a duration"))),
        (".", Err(("invalid_conversion", "\".\" is not a duration")), Err(("invalid_conversion", "\".\" is not a duration"))),
        ("1s", Ok(1000000000), Ok("1s")),
        ("-1s", Ok(-1000000000), Ok("-1s")),
        ("+1s", Ok(1000000000), Ok("1s")),
        ("1h30m", Ok(5400000000000), Ok("5400s")),
        ("1.5s", Ok(1500000000), Ok("1.5s")),
        ("-10m", Ok(-600000000000), Ok("-600s")),
        ("-1.5h", Ok(-5400000000000), Ok("-5400s")),
        ("250ms", Ok(250000000), Ok("0.25s")),
        ("1ns", Ok(1), Ok("0.000000001s")),
        ("1us", Ok(1000), Ok("0.000001s")),
        ("1µs", Ok(1000), Ok("0.000001s")),
        ("1μs", Ok(1000), Ok("0.000001s")),
        ("1ms", Ok(1000000), Ok("0.001s")),
        ("1m", Ok(60000000000), Ok("60s")),
        ("1h", Ok(3600000000000), Ok("3600s")),
        ("1h1m1s1ms1us1ns", Ok(3661001001001), Ok("3661.001001001s")),
        ("0.0000000001h", Ok(0), Ok("0s")),
        ("0.000000001s", Ok(1), Ok("0.000000001s")),
        ("0.0000000019s", Ok(1), Ok("0.000000001s")),
        ("1.0000000009s", Ok(1000000000), Ok("1s")),
        ("0.5ns", Ok(0), Ok("0s")),
        ("1.5ns", Ok(1), Ok("0.000000001s")),
        ("1.5us", Ok(1500), Ok("0.0000015s")),
        ("1.9999999999us", Ok(1999), Ok("0.000001999s")),
        ("00", Err(("invalid_conversion", "\"00\" is not a duration")), Err(("invalid_conversion", "\"00\" is not a duration"))),
        ("5", Err(("invalid_conversion", "\"5\" is not a duration")), Err(("invalid_conversion", "\"5\" is not a duration"))),
        ("1.5.5s", Err(("invalid_conversion", "\"1.5.5s\" is not a duration")), Err(("invalid_conversion", "\"1.5.5s\" is not a duration"))),
        ("1 s", Err(("invalid_conversion", "\"1 s\" is not a duration")), Err(("invalid_conversion", "\"1 s\" is not a duration"))),
        (" 1s", Err(("invalid_conversion", "\" 1s\" is not a duration")), Err(("invalid_conversion", "\" 1s\" is not a duration"))),
        ("1s ", Err(("invalid_conversion", "\"1s \" is not a duration")), Err(("invalid_conversion", "\"1s \" is not a duration"))),
        ("1S", Err(("invalid_conversion", "\"1S\" is not a duration")), Err(("invalid_conversion", "\"1S\" is not a duration"))),
        ("1d", Err(("invalid_conversion", "\"1d\" is not a duration")), Err(("invalid_conversion", "\"1d\" is not a duration"))),
        ("1hm", Err(("invalid_conversion", "\"1hm\" is not a duration")), Err(("invalid_conversion", "\"1hm\" is not a duration"))),
        ("h1", Err(("invalid_conversion", "\"h1\" is not a duration")), Err(("invalid_conversion", "\"h1\" is not a duration"))),
        ("--1s", Err(("invalid_conversion", "\"--1s\" is not a duration")), Err(("invalid_conversion", "\"--1s\" is not a duration"))),
        ("+-1s", Err(("invalid_conversion", "\"+-1s\" is not a duration")), Err(("invalid_conversion", "\"+-1s\" is not a duration"))),
        ("1.5", Err(("invalid_conversion", "\"1.5\" is not a duration")), Err(("invalid_conversion", "\"1.5\" is not a duration"))),
        ("1e3s", Err(("invalid_conversion", "\"1e3s\" is not a duration")), Err(("invalid_conversion", "\"1e3s\" is not a duration"))),
        ("0s", Ok(0), Ok("0s")),
        ("0h", Ok(0), Ok("0s")),
        ("-0s", Ok(0), Ok("0s")),
        ("1.5m30s", Ok(120000000000), Ok("120s")),
        ("1msms", Err(("invalid_conversion", "\"1msms\" is not a duration")), Err(("invalid_conversion", "\"1msms\" is not a duration"))),
        ("1m1ms", Ok(60001000000), Ok("60.001s")),
        ("1sm", Err(("invalid_conversion", "\"1sm\" is not a duration")), Err(("invalid_conversion", "\"1sm\" is not a duration"))),
        ("0x1s", Err(("invalid_conversion", "\"0x1s\" is not a duration")), Err(("invalid_conversion", "\"0x1s\" is not a duration"))),
        ("1_000s", Err(("invalid_conversion", "\"1_000s\" is not a duration")), Err(("invalid_conversion", "\"1_000s\" is not a duration"))),
        ("\"q\"s", Err(("invalid_conversion", "\"\\\"q\\\"s\" is not a duration")), Err(("invalid_conversion", "\"\\\"q\\\"s\" is not a duration"))),
        ("tab\u{9}s", Err(("invalid_conversion", "\"tab\\ts\" is not a duration")), Err(("invalid_conversion", "\"tab\\ts\" is not a duration"))),
        ("π", Err(("invalid_conversion", "\"π\" is not a duration")), Err(("invalid_conversion", "\"π\" is not a duration"))),
        ("١s", Err(("invalid_conversion", "\"١s\" is not a duration")), Err(("invalid_conversion", "\"١s\" is not a duration"))),
        ("1ｓ", Err(("invalid_conversion", "\"1ｓ\" is not a duration")), Err(("invalid_conversion", "\"1ｓ\" is not a duration"))),
        ("1h\u{a}", Err(("invalid_conversion", "\"1h\\n\" is not a duration")), Err(("invalid_conversion", "\"1h\\n\" is not a duration"))),
        ("1µ", Err(("invalid_conversion", "\"1µ\" is not a duration")), Err(("invalid_conversion", "\"1µ\" is not a duration"))),
        ("µs", Err(("invalid_conversion", "\"µs\" is not a duration")), Err(("invalid_conversion", "\"µs\" is not a duration"))),
        ("9223372036.854775807s", Ok(9223372036854775807), Ok("9223372036.854775807s")),
        ("-9223372036.854775808s", Ok(-9223372036854775808), Ok("-9223372036.854775808s")),
        ("9223372036.854775808s", Ok(9223372036854775808), Err(("invalid_conversion", "duration out of range"))),
        ("-9223372036.854775809s", Ok(-9223372036854775809), Err(("invalid_conversion", "duration out of range"))),
        ("9223372036854775807ns", Ok(9223372036854775807), Ok("9223372036.854775807s")),
        ("-9223372036854775808ns", Ok(-9223372036854775808), Ok("-9223372036.854775808s")),
        ("320000000000s", Ok(320000000000000000000), Err(("invalid_conversion", "duration out of range"))),
        ("200000000000s", Ok(200000000000000000000), Err(("invalid_conversion", "duration out of range"))),
        ("-200000000000s", Ok(-200000000000000000000), Err(("invalid_conversion", "duration out of range"))),
        ("315576000000s", Ok(315576000000000000000), Err(("invalid_conversion", "duration out of range"))),
        ("-315576000000.999999999s", Ok(-315576000000999999999), Err(("invalid_conversion", "duration out of range"))),
        ("2562047h47m16.854775807s", Ok(9223372036854775807), Ok("9223372036.854775807s")),
        ("2562047h47m16.854775808s", Ok(9223372036854775808), Err(("invalid_conversion", "duration out of range"))),
        ("170141183460469231731687303715884105727ns", Ok(170141183460469231731687303715884105727), Err(("invalid_conversion", "duration out of range"))),
        ("-170141183460469231731687303715884105728ns", Ok(-170141183460469231731687303715884105728), Err(("invalid_conversion", "duration out of range"))),
        ("10000000000000000000000000000000000000000h x", Err(("invalid_conversion", "\"10000000000000000000000000000000000000000h x\" is not a duration")), Err(("invalid_conversion", "\"10000000000000000000000000000000000000000h x\" is not a duration"))),
        ("10000000000000000000000000000000000000000", Err(("invalid_conversion", "\"10000000000000000000000000000000000000000\" is not a duration")), Err(("invalid_conversion", "\"10000000000000000000000000000000000000000\" is not a duration"))),
        ("10000000000000000000000000000000000000000h1", Err(("invalid_conversion", "\"10000000000000000000000000000000000000000h1\" is not a duration")), Err(("invalid_conversion", "\"10000000000000000000000000000000000000000h1\" is not a duration"))),
    ];
    for (text, total, parsed) in NODE_TEXT {
        assert_eq!(
            duration_nanos_from_text(text).map_err(refusal),
            total.as_ref().map(|total| *total).map_err(expected),
            "{text:?}"
        );
        assert_eq!(
            parse_duration(text).map(format_duration).map_err(refusal),
            parsed.as_ref().map(|canonical| canonical.to_string()).map_err(expected),
            "{text:?}"
        );
    }
}

#[test]
fn answers_a_total_128_bits_cannot_hold_as_out_of_range() {
    // Node holds each of these totals in an unbounded integer (commented beside the
    // row) and refuses the text under CEL's range, which is the answer pinned here.
    // With no range applied this crate answers the same refusal: 128 bits is past
    // every caller's range.
    const NODE_TEXT: &[(&str, Result<&str, Refusal>)] = &[
        ("170141183460469231731687303715884105728ns", /* node total: 170141183460469231731687303715884105728 */ Err(("invalid_conversion", "duration out of range"))),
        ("-170141183460469231731687303715884105729ns", /* node total: -170141183460469231731687303715884105729 */ Err(("invalid_conversion", "duration out of range"))),
        ("10000000000000000000000000000000000000000h", /* node total: 36000000000000000000000000000000000000000000000000000 */ Err(("invalid_conversion", "duration out of range"))),
        ("-10000000000000000000000000000000000000000h", /* node total: -36000000000000000000000000000000000000000000000000000 */ Err(("invalid_conversion", "duration out of range"))),
    ];
    for (text, parsed) in NODE_TEXT {
        let under_range = parse_duration(text).map(format_duration).map_err(refusal);
        assert_eq!(under_range, parsed.as_ref().map(|canonical| canonical.to_string()).map_err(expected), "{text:?}");
        assert_eq!(duration_nanos_from_text(text).map_err(refusal), Err(under_range.unwrap_err()), "{text:?}");
    }
}

#[test]
fn writes_any_duration_the_carrier_holds() {
    // Seconds and nanos as a host would hand them over, then the total and the
    // canonical text.
    const NODE_CARRIERS: &[(i64, i32, i128, &str)] = &[
        (0, 0, 0, "0s"),
        (1, 0, 1000000000, "1s"),
        (-1, 0, -1000000000, "-1s"),
        (0, 1, 1, "0.000000001s"),
        (0, -1, -1, "-0.000000001s"),
        (1, 500000000, 1500000000, "1.5s"),
        (-1, -500000000, -1500000000, "-1.5s"),
        (123, 321456789, 123321456789, "123.321456789s"),
        (5400, 0, 5400000000000, "5400s"),
        (0, 250000000, 250000000, "0.25s"),
        (0, 1000, 1000, "0.000001s"),
        (0, 999999999, 999999999, "0.999999999s"),
        (0, -999999999, -999999999, "-0.999999999s"),
        (9223372036, 854775807, 9223372036854775807, "9223372036.854775807s"),
        (-9223372036, -854775808, -9223372036854775808, "-9223372036.854775808s"),
        (9223372036, 854775808, 9223372036854775808, "9223372036.854775808s"),
        (-9223372036, -854775809, -9223372036854775809, "-9223372036.854775809s"),
        (200000000000, 0, 200000000000000000000, "200000000000s"),
        (-200000000000, 0, -200000000000000000000, "-200000000000s"),
        (315576000000, 0, 315576000000000000000, "315576000000s"),
        (-315576000000, -999999999, -315576000000999999999, "-315576000000.999999999s"),
        (9223372036854775807, 999999999, 9223372036854775807999999999, "9223372036854775807.999999999s"),
        (-9223372036854775808, -999999999, -9223372036854775808999999999, "-9223372036854775808.999999999s"),
    ];
    for (seconds, nanos, total, canonical) in NODE_CARRIERS {
        let held = CelDuration::new(*seconds, *nanos).expect("the carrier holds it");
        assert_eq!(CelDuration::from_total_nanos(*total), Some(held));
        assert_eq!((held.seconds(), held.nanos(), held.total_nanos()), (*seconds, *nanos, *total));
        assert_eq!(duration_nanos(held), *total);
        assert_eq!(format_duration(held), *canonical);
        assert_eq!(held.to_string(), *canonical);
    }
}

/// The check at use and the getters at the ends `tests/evaluate.rs` does not ask: the
/// narrowest CEL duration, one nanosecond past each end of CEL's range, and durations
/// only the carrier holds, whose getters still fit an int.
#[test]
fn checks_and_reads_the_fields_of_a_duration_at_the_ends_of_both_ranges() {
    // Seconds and nanos, the refusal where CEL would use it, and the four getters.
    const NODE_ENDS: &[(i64, i32, Option<Refusal>, [i64; 4])] = &[
        (-9223372036, -854775808, None, [-2562047, -153722867, -9223372036, -854]),
        (9223372036, 854775808, Some(("invalid_conversion", "duration out of range")), [2562047, 153722867, 9223372036, 854]),
        (-9223372036, -854775809, Some(("invalid_conversion", "duration out of range")), [-2562047, -153722867, -9223372036, -854]),
        (-200000000000, 0, Some(("invalid_conversion", "duration out of range")), [-55555555, -3333333333, -200000000000, 0]),
        (315576000000, 0, Some(("invalid_conversion", "duration out of range")), [87660000, 5259600000, 315576000000, 0]),
        (-315576000000, -999999999, Some(("invalid_conversion", "duration out of range")), [-87660000, -5259600000, -315576000000, -999]),
        (9223372036854775807, 999999999, Some(("invalid_conversion", "duration out of range")), [2562047788015215, 153722867280912930, 9223372036854775807, 999]),
        (-9223372036854775808, -999999999, Some(("invalid_conversion", "duration out of range")), [-2562047788015215, -153722867280912930, -9223372036854775808, -999]),
    ];
    for (seconds, nanos, at_use, fields) in NODE_ENDS {
        let held = CelDuration::new(*seconds, *nanos).expect("the carrier holds it");
        assert_eq!(duration_out_of_range(held).map_err(refusal).err(), at_use.as_ref().map(expected), "{held}");
        let read = [
            DurationField::GetHours,
            DurationField::GetMinutes,
            DurationField::GetSeconds,
            DurationField::GetMilliseconds,
        ]
        .map(|field| duration_field(held, field));
        assert_eq!(read, *fields, "{held}");
    }
}

#[test]
fn builds_a_cel_duration_from_a_total_inside_int64_of_nanoseconds() {
    const NODE_TOTALS: &[(i128, Result<(i64, i32), Refusal>)] = &[
        (0, Ok((0, 0))),
        (1, Ok((0, 1))),
        (-1, Ok((0, -1))),
        (1500000000, Ok((1, 500000000))),
        (-1500000000, Ok((-1, -500000000))),
        (9223372036854775807, Ok((9223372036, 854775807))),
        (-9223372036854775808, Ok((-9223372036, -854775808))),
        (9223372036854775808, Err(("invalid_conversion", "duration out of range"))),
        (-9223372036854775809, Err(("invalid_conversion", "duration out of range"))),
        (200000000000000000000, Err(("invalid_conversion", "duration out of range"))),
        (-200000000000000000000, Err(("invalid_conversion", "duration out of range"))),
    ];
    for (total, built) in NODE_TOTALS {
        assert_eq!(
            cel_duration_from_nanos(*total).map(|held| (held.seconds(), held.nanos())).map_err(refusal),
            built.as_ref().map(|parts| *parts).map_err(expected),
            "{total}"
        );
    }
    assert_eq!((MIN_DURATION_NANOS, MAX_DURATION_NANOS), (i128::from(i64::MIN), i128::from(i64::MAX)));
}

/// The carrier's own refusals. Node has no carrier constructor — a host writes the
/// object — so these are the SDK's `Duration` answers, which this type now gives.
#[test]
fn answers_nothing_for_a_shape_the_carrier_does_not_hold() {
    assert_eq!(CelDuration::new(1, -1), None);
    assert_eq!(CelDuration::new(-1, 1), None);
    assert_eq!(CelDuration::new(0, 1_000_000_000), None);
    assert_eq!(CelDuration::new(0, -1_000_000_000), None);
    assert_eq!(CelDuration::from_total_nanos((i128::from(i64::MAX) + 1) * 1_000_000_000), None);
    assert_eq!(CelDuration::from_total_nanos((i128::from(i64::MIN) - 1) * 1_000_000_000), None);
    assert!(CelDuration::new(0, -1) < CelDuration::new(0, 0));
}
