//! Twin of `templating/nodejs/tests/formatting-registration.test.ts`: claims about the
//! formatting functions' registration and static typing, which a manifest cannot state.

use telo_templating::{build_cel_environment, CelHandlers};
use telorun_cel::CelEnvironment;

fn env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

#[test]
fn resolves_a_timestamp_argument_which_needs_the_protobuf_type_name() {
    let env = env();
    assert!(env.check("dateIn(timestamp('2026-03-01T00:30:00Z'), 'America/New_York')").valid);
    assert!(env.check("isoIn(timestamp(0))").valid);
}

#[test]
fn types_a_calendar_shift_as_a_timestamp_so_it_composes_with_timestamp_arithmetic() {
    let env = env();
    assert_eq!(env.check("startOfMonth(timestamp(0))").type_name, "google.protobuf.Timestamp");
    assert_eq!(env.check("addMonths(timestamp(0), 1)").type_name, "google.protobuf.Timestamp");
    assert_eq!(env.check("string(startOfMonth(timestamp(0)))").type_name, "string");
}

#[test]
fn registers_both_arities_of_round() {
    let env = env();
    assert!(env.check("round(1.5)").valid);
    assert!(env.check("round(1.5, 2)").valid);
}

#[test]
fn registers_each_zone_taking_function_at_both_arities() {
    let env = env();
    for call in ["dateIn", "isoIn", "startOfMonth"] {
        assert!(env.check(&format!("{call}(timestamp(0))")).valid, "{call} minimal arity");
        assert!(env.check(&format!("{call}(timestamp(0), 'UTC')")).valid, "{call} with zone");
    }
    assert!(env.check("addMonths(timestamp(0), 1, 'UTC')").valid);
}

#[test]
fn types_every_formatter_as_a_string_so_it_composes_with_concatenation() {
    let env = env();
    assert!(env.check("'x' + format(1.0, '.2f')").valid);
    assert!(env.check("'x' + fixed(1.0, 2)").valid);
    assert!(env.check("'x' + formatDuration(510, 480)").valid);
}
