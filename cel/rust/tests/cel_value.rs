//! The value domain at evaluation — the evaluating cases of
//! `cel/nodejs/tests/cel-value.test.ts`: values built outside the engine compute as
//! the engine's own do, a map holding a look-alike brand key is data, and a value of a
//! host's named type answers by the name it carries.
//!
//! Node builds its foreign values by hand from the value key, as a second copy of the
//! engine would; a value here is a member of one closed union however it was built, so
//! each is built through the value crate's constructors. Every expected answer is what
//! Node's `CelEnvironment.evaluate` answered, executed — `@telorun/cel 0.120.1 at b4a2b6e9`.

mod evaluation_support;
mod value_support;

use std::sync::Arc;

use evaluation_support::{bindings, loose, source_answer};
use telorun_cel::{CelHostValue, CelValue, PropertyMap};
use value_support::{du, rec, s, ts, u};

#[test]
fn computes_with_a_uint_built_outside_the_engine() {
    let held = bindings(vec![("held", u(7))]);
    assert_eq!(source_answer(&loose(), "type(held) == uint", &held), "value bool true");
    assert_eq!(source_answer(&loose(), "held + 1u", &held), "value uint 8");
}

#[test]
fn computes_with_an_instant_and_a_duration_built_outside_the_engine() {
    let held = bindings(vec![("at", ts(1234567890, 0)), ("by", du(90, 0))]);
    assert_eq!(source_answer(&loose(), "string(at + by)", &held), "value string \"2009-02-13T23:33:00Z\"");
}

#[test]
fn reads_a_map_carrying_a_look_alike_brand_key_as_data() {
    let held = bindings(vec![("held", rec(vec![("telo.cel.value", s("uint")), ("value", s("7"))]))]);
    assert_eq!(source_answer(&loose(), "type(held) == map", &held), "value bool true");
    assert_eq!(source_answer(&loose(), "held['telo.cel.value']", &held), "value string \"uint\"");
}

#[test]
fn dispatches_a_value_of_a_hosts_named_type_by_the_name_it_carries() {
    // `Money` is registered nowhere, so no overload of `type` takes it.
    let money = CelHostValue::with_entries("Money", Arc::new(()), PropertyMap::new()).unwrap();
    let held = bindings(vec![("held", CelValue::Host(money))]);
    assert_eq!(
        source_answer(&loose(), "type(held)", &held),
        "error no_matching_overload [0, 10] no overload of \"type\" takes (Money)"
    );
}
