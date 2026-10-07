//! The value-level cases of `cel/nodejs/tests/evaluate.test.ts`: the millisecond
//! clock, the widest duration, a wider host duration refused at use, and a duration's
//! getters. Every other case of that file evaluates an expression and is the engine's.
//!
//! Where Node asks through an expression (`duration('1h30m').getMinutes()`), the same
//! question is asked of the function that expression reaches. Every expected value,
//! code and message is the Node build's answer, executed.

use telorun_cel_value::{
    cel_duration_from_nanos, cel_timestamp, cel_timestamp_from_millis, duration_field, duration_nanos,
    duration_out_of_range, format_duration, parse_duration, CelDuration, DurationField,
};

#[test]
fn reads_a_hosts_millisecond_clock_as_an_instant_and_holds_it_to_the_range() {
    assert_eq!(cel_timestamp_from_millis(1768462200000.0), cel_timestamp(1768462200, 0));
    assert_eq!(cel_timestamp_from_millis(-1500.0), cel_timestamp(-2, 500_000_000));
    // A fractional reading keeps its sub-millisecond part.
    assert_eq!(cel_timestamp_from_millis(0.000001), cel_timestamp(0, 1));
    for refused in [253402300800000.0, f64::NAN] {
        let error = cel_timestamp_from_millis(refused).unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("invalid_conversion", "timestamp out of range"));
    }
}

#[test]
fn admits_the_widest_duration_there_is_and_nothing_one_nanosecond_past_it() {
    for widest in ["9223372036.854775807s", "-9223372036.854775808s"] {
        assert_eq!(parse_duration(widest).map(format_duration).as_deref(), Ok(widest));
    }
    for past in ["9223372036.854775808s", "-9223372036.854775809s", "320000000000s"] {
        let error = parse_duration(past).unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("invalid_conversion", "duration out of range"));
    }
}

#[test]
fn carries_a_hosts_wider_duration_and_refuses_it_where_cel_would_use_it() {
    // What a host hands over from the wider range a transport carries: 200,000,000,000s.
    let wide = CelDuration::new(200_000_000_000, 0).expect("the carrier holds it");
    assert_eq!(format_duration(wide), "200000000000s");
    let at_use = duration_out_of_range(wide).expect_err("CEL's range does not hold it");
    assert_eq!((at_use.code.as_str(), at_use.message.as_str()), ("invalid_conversion", "duration out of range"));
    assert_eq!(cel_duration_from_nanos(duration_nanos(wide)), Err(at_use));
    assert_eq!(duration_out_of_range(parse_duration("9223372036.854775807s").unwrap()), Ok(()));
}

#[test]
fn splits_a_durations_getters_the_whole_span_but_milliseconds_is_the_component() {
    use DurationField::*;
    for (text, field, expected) in [
        ("123.321456789s", GetMilliseconds, 321),
        ("123.321456789s", GetSeconds, 123),
        ("1h30m", GetMinutes, 90),
        ("1h30m", GetHours, 1),
        ("1h30m", GetSeconds, 5400),
        ("-1.5s", GetMilliseconds, -500),
        ("-1.5s", GetSeconds, -1),
        ("-1h30m", GetHours, -1),
        ("-1h30m", GetMinutes, -90),
        ("0.9999s", GetMilliseconds, 999),
    ] {
        assert_eq!(duration_field(parse_duration(text).unwrap(), field), expected, "{text} {field:?}");
    }
}
