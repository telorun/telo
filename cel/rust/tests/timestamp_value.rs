//! A timestamp's fields in a time zone — `zoned_fields` and `timestamp_field`, the
//! engine half of `timestamp-value.ts`, over the IANA database the engine bundles.
//!
//! Every expected field and refusal is what Node's `zonedFields` and `timestampField`
//! answered, executed — `@telorun/cel 0.120.1 at b4a2b6e9`, on Node 24.21.0 with ICU
//! 78.3 and tz data 2026c — except the named readings below, each naming Node's answer.
//! The zone cases of `evaluate.test.ts` evaluate expressions; their twin is `evaluate.rs`.

use telorun_cel::{
    parse_timestamp, timestamp_field, zoned_fields, CelEvaluationCode, CivilFields, SourceRange, TimestampField,
};

const RANGE: SourceRange = SourceRange { start: 3, end: 9 };

fn fields(instant: &str, zone: Option<&str>) -> Result<[i64; 6], String> {
    let at = parse_timestamp(instant).expect("an instant");
    zoned_fields(at, zone, Some(RANGE))
        .map(|CivilFields { year, month, day, hour, minute, second }| [year, month, day, hour, minute, second])
        .map_err(|error| {
            assert_eq!((error.code, error.range), (CelEvaluationCode::InvalidArgument, Some(RANGE)), "{zone:?}");
            error.message
        })
}

/// `(instant, zone, Node's year, month, day, hour, minute and second — or refusal)`.
fn node_answers() -> Vec<(&'static str, Option<&'static str>, Result<[i64; 6], &'static str>)> {
    vec![
        ("2009-02-13T23:31:30Z", None, Ok([2009, 2, 13, 23, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("UTC"), Ok([2009, 2, 13, 23, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("utc"), Ok([2009, 2, 13, 23, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("Etc/UTC"), Ok([2009, 2, 13, 23, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("02:00"), Ok([2009, 2, 14, 1, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("+02:00"), Ok([2009, 2, 14, 1, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("-08:00"), Ok([2009, 2, 13, 15, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("+23:59"), Ok([2009, 2, 14, 23, 30, 30])),
        ("2009-02-13T23:31:30Z", Some("-00:00"), Ok([2009, 2, 13, 23, 31, 30])),
        ("2009-02-13T23:31:30Z", Some("+24:00"), Err("\"+24:00\" is not a time zone")),
        ("2009-02-13T23:31:30Z", Some("+00:60"), Err("\"+00:60\" is not a time zone")),
        ("2009-02-13T23:31:30Z", Some("+5:30"), Err("\"+5:30\" is not a time zone")),
        ("2009-02-13T23:31:30Z", Some(""), Err("\"\" is not a time zone")),
        ("2009-02-13T23:31:30Z", Some("Mars/Olympus"), Err("\"Mars/Olympus\" is not a time zone")),
        ("2009-02-13T23:31:30Z", Some(" UTC"), Err("\" UTC\" is not a time zone")),
        ("2024-03-10T06:59:59Z", Some("America/New_York"), Ok([2024, 3, 10, 1, 59, 59])),
        ("2024-03-10T07:00:00Z", Some("America/New_York"), Ok([2024, 3, 10, 3, 0, 0])),
        ("2024-11-03T05:59:59Z", Some("America/New_York"), Ok([2024, 11, 3, 1, 59, 59])),
        ("2024-11-03T06:00:00Z", Some("America/New_York"), Ok([2024, 11, 3, 1, 0, 0])),
        ("2024-04-06T15:59:59Z", Some("Australia/Sydney"), Ok([2024, 4, 7, 2, 59, 59])),
        ("2024-04-06T16:00:00Z", Some("Australia/Sydney"), Ok([2024, 4, 7, 2, 0, 0])),
        ("2024-10-05T15:59:59Z", Some("Australia/Sydney"), Ok([2024, 10, 6, 1, 59, 59])),
        ("2024-10-05T16:00:00Z", Some("Australia/Sydney"), Ok([2024, 10, 6, 3, 0, 0])),
        ("2024-04-06T14:59:59Z", Some("Australia/Lord_Howe"), Ok([2024, 4, 7, 1, 59, 59])),
        ("2024-04-06T15:00:00Z", Some("Australia/Lord_Howe"), Ok([2024, 4, 7, 1, 30, 0])),
        ("2024-03-31T00:59:59Z", Some("Europe/Warsaw"), Ok([2024, 3, 31, 1, 59, 59])),
        ("2024-03-31T01:00:00Z", Some("Europe/Warsaw"), Ok([2024, 3, 31, 3, 0, 0])),
        ("2100-07-01T12:00:00Z", Some("America/New_York"), Ok([2100, 7, 1, 8, 0, 0])),
        ("2100-01-01T12:00:00Z", Some("America/New_York"), Ok([2100, 1, 1, 7, 0, 0])),
        ("2087-10-26T01:00:00Z", Some("Europe/Warsaw"), Ok([2087, 10, 26, 2, 0, 0])),
        ("2500-03-11T07:00:00Z", Some("America/Chicago"), Ok([2500, 3, 11, 1, 0, 0])),
        ("9999-12-31T23:59:59Z", Some("Pacific/Kiritimati"), Ok([10000, 1, 1, 13, 59, 59])),
        ("2200-04-01T00:00:00Z", Some("America/Santiago"), Ok([2200, 3, 31, 21, 0, 0])),
        ("2300-10-01T00:00:00Z", Some("Pacific/Auckland"), Ok([2300, 10, 1, 13, 0, 0])),
        ("2024-06-01T00:00:00Z", Some("Asia/Kathmandu"), Ok([2024, 6, 1, 5, 45, 0])),
        ("2024-06-01T00:00:00Z", Some("America/St_Johns"), Ok([2024, 5, 31, 21, 30, 0])),
        ("2024-06-01T00:00:00Z", Some("Asia/Kolkata"), Ok([2024, 6, 1, 5, 30, 0])),
        ("2024-06-01T00:00:00Z", Some("Pacific/Chatham"), Ok([2024, 6, 1, 12, 45, 0])),
        ("2024-06-01T00:00:00Z", Some("Africa/Casablanca"), Ok([2024, 6, 1, 1, 0, 0])),
        ("2026-02-20T00:00:00Z", Some("Africa/Casablanca"), Ok([2026, 2, 20, 0, 0, 0])),
        ("1800-01-01T00:00:00Z", Some("America/New_York"), Ok([1799, 12, 31, 19, 3, 58])),
        ("1800-01-01T00:00:00Z", Some("Europe/Warsaw"), Ok([1800, 1, 1, 1, 24, 0])),
        ("1800-01-01T00:00:00Z", Some("Asia/Kolkata"), Ok([1800, 1, 1, 5, 53, 28])),
        ("1000-03-01T12:34:56Z", Some("Europe/Amsterdam"), Ok([1000, 3, 1, 12, 52, 26])),
        ("1500-02-28T23:59:59Z", Some("Asia/Tokyo"), Ok([1500, 3, 1, 9, 18, 58])),
        ("0001-01-01T00:00:00Z", Some("America/New_York"), Ok([0, 12, 31, 19, 3, 58])),
        ("0001-01-01T00:00:00Z", Some("-08:00"), Ok([0, 12, 31, 16, 0, 0])),
        ("9999-12-31T23:59:59Z", Some("Asia/Tokyo"), Ok([10000, 1, 1, 8, 59, 59])),
        ("9999-12-31T23:59:59Z", Some("+05:30"), Ok([10000, 1, 1, 5, 29, 59])),
        ("2024-07-01T00:00:00Z", Some("america/new_york"), Ok([2024, 6, 30, 20, 0, 0])),
        ("2024-07-01T00:00:00Z", Some("EUROPE/KIEV"), Ok([2024, 7, 1, 3, 0, 0])),
        ("2024-07-01T00:00:00Z", Some("US/Pacific"), Ok([2024, 6, 30, 17, 0, 0])),
        ("2024-07-01T00:00:00Z", Some("EST5EDT"), Ok([2024, 6, 30, 20, 0, 0])),
        ("2024-07-01T00:00:00Z", Some("Etc/GMT+5"), Ok([2024, 6, 30, 19, 0, 0])),
        ("2024-07-01T00:00:00Z", Some("GMT"), Ok([2024, 7, 1, 0, 0, 0])),
    ]
}

#[test]
fn reads_an_instant_in_every_form_of_zone_as_node_does() {
    for (instant, zone, expected) in node_answers() {
        assert_eq!(fields(instant, zone), expected.map_err(str::to_string), "{instant} in {zone:?}");
    }
}

const GETTERS: [TimestampField; 10] = [
    TimestampField::GetFullYear,
    TimestampField::GetMonth,
    TimestampField::GetDayOfYear,
    TimestampField::GetDayOfMonth,
    TimestampField::GetDate,
    TimestampField::GetDayOfWeek,
    TimestampField::GetHours,
    TimestampField::GetMinutes,
    TimestampField::GetSeconds,
    TimestampField::GetMilliseconds,
];

/// `(instant, zone, Node's answer for each of GETTERS, in order)`.
fn node_fields() -> Vec<(&'static str, Option<&'static str>, [i64; 10])> {
    vec![
        ("2009-02-13T23:31:30.123456789Z", None, [2009, 1, 43, 12, 13, 5, 23, 31, 30, 123]),
        ("2009-02-13T23:31:30.123456789Z", Some("Australia/Sydney"), [2009, 1, 44, 13, 14, 6, 10, 31, 30, 123]),
        ("2009-02-13T23:31:30.123456789Z", Some("-08:00"), [2009, 1, 43, 12, 13, 5, 15, 31, 30, 123]),
        ("2009-02-13T23:31:30.123456789Z", Some("Pacific/Kiritimati"), [2009, 1, 44, 13, 14, 6, 13, 31, 30, 123]),
        ("2024-12-31T23:59:59.999Z", None, [2024, 11, 365, 30, 31, 2, 23, 59, 59, 999]),
        ("2024-12-31T23:59:59.999Z", Some("Australia/Sydney"), [2025, 0, 0, 0, 1, 3, 10, 59, 59, 999]),
        ("2024-12-31T23:59:59.999Z", Some("-08:00"), [2024, 11, 365, 30, 31, 2, 15, 59, 59, 999]),
        ("2024-12-31T23:59:59.999Z", Some("Pacific/Kiritimati"), [2025, 0, 0, 0, 1, 3, 13, 59, 59, 999]),
        ("2024-02-29T00:00:00Z", None, [2024, 1, 59, 28, 29, 4, 0, 0, 0, 0]),
        ("2024-02-29T00:00:00Z", Some("Australia/Sydney"), [2024, 1, 59, 28, 29, 4, 11, 0, 0, 0]),
        ("2024-02-29T00:00:00Z", Some("-08:00"), [2024, 1, 58, 27, 28, 3, 16, 0, 0, 0]),
        ("2024-02-29T00:00:00Z", Some("Pacific/Kiritimati"), [2024, 1, 59, 28, 29, 4, 14, 0, 0, 0]),
        ("1969-12-31T23:59:59.5Z", None, [1969, 11, 364, 30, 31, 3, 23, 59, 59, 500]),
        ("1969-12-31T23:59:59.5Z", Some("Australia/Sydney"), [1970, 0, 0, 0, 1, 4, 9, 59, 59, 500]),
        ("1969-12-31T23:59:59.5Z", Some("-08:00"), [1969, 11, 364, 30, 31, 3, 15, 59, 59, 500]),
        ("1969-12-31T23:59:59.5Z", Some("Pacific/Kiritimati"), [1969, 11, 364, 30, 31, 3, 13, 19, 59, 500]),
        ("0001-01-01T00:00:00Z", None, [1, 0, 0, 0, 1, 1, 0, 0, 0, 0]),
        ("0001-01-01T00:00:00Z", Some("Australia/Sydney"), [1, 0, 0, 0, 1, 1, 10, 4, 52, 0]),
        ("0001-01-01T00:00:00Z", Some("-08:00"), [0, 11, 365, 30, 31, 0, 16, 0, 0, 0]),
        ("0001-01-01T00:00:00Z", Some("Pacific/Kiritimati"), [0, 11, 365, 30, 31, 0, 13, 30, 40, 0]),
        ("1582-10-10T00:00:00Z", None, [1582, 9, 282, 9, 10, 0, 0, 0, 0, 0]),
        ("1582-10-10T00:00:00Z", Some("Australia/Sydney"), [1582, 9, 282, 9, 10, 0, 10, 4, 52, 0]),
        ("1582-10-10T00:00:00Z", Some("-08:00"), [1582, 9, 281, 8, 9, 6, 16, 0, 0, 0]),
        ("1582-10-10T00:00:00Z", Some("Pacific/Kiritimati"), [1582, 9, 281, 8, 9, 6, 13, 30, 40, 0]),
    ]
}

#[test]
fn answers_every_field_as_node_does() {
    for (instant, zone, expected) in node_fields() {
        let at = parse_timestamp(instant).expect("an instant");
        let answered: Vec<i64> =
            GETTERS.iter().map(|field| timestamp_field(at, *field, zone, None).expect("a field")).collect();
        assert_eq!(answered, expected, "{instant} in {zone:?}");
    }
}

/// IANA merged Europe/Oslo into Europe/Berlin, so the database holds Berlin's history
/// before 1970 for it — and so does Node's ICU 78.3: `13:00` on 1925-01-01T12:00:00Z,
/// Berlin's `13:00`. A host whose ICU kept Oslo's own history would answer otherwise;
/// this engine answers from its bundled database.
#[test]
fn reads_a_merged_zone_before_1970_as_the_zone_it_was_merged_into() {
    assert_eq!(fields("1925-01-01T12:00:00Z", Some("Europe/Oslo")), Ok([1925, 1, 1, 13, 0, 0]));
    assert_eq!(fields("1925-01-01T12:00:00Z", Some("Europe/Berlin")), Ok([1925, 1, 1, 13, 0, 0]));
}

/// Node takes a zone through its host's Intl, which also reads `+05` and `+0530` as
/// offsets (`17:00`, `17:30` on 1925-01-01T12:00:00Z) and ICU's own names — `PST`
/// (`04:00`), `US/Pacific-New` (`04:00`), `SystemV/AST4` (`08:00`) — while refusing the
/// database's `Factory`. Here a zone is `UTC`, a `±HH:MM` offset or a name of the bundled
/// database, `Factory` among them.
#[test]
fn takes_only_the_zones_of_the_bundled_database() {
    for zone in ["+05", "+0530", "PST", "US/Pacific-New", "SystemV/AST4"] {
        assert_eq!(
            fields("1925-01-01T12:00:00Z", Some(zone)),
            Err(format!("\"{zone}\" is not a time zone")),
            "{zone}"
        );
    }
    assert_eq!(fields("1925-01-01T12:00:00Z", Some("Factory")), Ok([1925, 1, 1, 12, 0, 0]));
}
