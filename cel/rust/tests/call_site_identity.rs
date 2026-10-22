//! A call site answers the same **cold** as it does **warm** — the twin of
//! `cel/nodejs/tests/call-site-identity.test.ts`, over CEL's own library; its sweep over
//! the function catalog arrives with the catalog.
//!
//! A site resolves its overload on its first call and then holds it, reached by comparing
//! the arguments' type names, with a bounded cache behind it for every other combination.
//! So every call has two paths and nothing else compares them. A compile from text is
//! memoized, so every "fresh site" here is compiled from a parsed tree, which is not.
//!
//! The registry sweep's calls carry literal arguments, so the types at a generated site
//! never vary; the second half drives one site through several types, and first asserts
//! that each case's types answer differently — a case whose types all answer alike cannot
//! tell a type-blind guard from a correct one. Each answer there is also held to what Node
//! answered, executed — `@telorun/cel 0.120.1 at b4a2b6e9`.

mod evaluation_support;
mod value_support;

use std::collections::HashSet;
use std::sync::Arc;

use evaluation_support::{bindings, call_source, loose, program_answer};
use telorun_cel::{CelEnvironment, CelEnvironmentOptions, CelProgram, CelValue};
use value_support::{b, by, d, i, l, s};

#[test]
fn answers_every_registered_call_the_same_cold_as_warm_and_as_a_site_that_never_ran() {
    let environment = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    let fresh = |source: &str| environment.compile_parsed(&environment.parse(source)).unwrap();
    let functions = environment.definitions().functions;
    let mut differences = Vec::new();
    for held in &functions {
        let source = call_source(held);
        // The standard library holds no volatile call; one would be held to its type.
        assert!(held.deterministic, "{source}");
        let program = fresh(&source);
        let cold = program_answer(&program, &());
        let warm = program_answer(&program, &());
        let warmer = program_answer(&program, &());
        let never_ran = program_answer(&fresh(&source), &());
        if cold != warm || warm != warmer || cold != never_ran {
            differences.push(format!("{source}: cold {cold}, warm {warm}/{warmer}, fresh site {never_ran}"));
        }
    }
    assert_eq!(differences, Vec::<String>::new());
    assert_eq!(functions.len(), 214);
}

/// One site, several argument types, each with Node's answer.
fn cases() -> Vec<(&'static str, Vec<(CelValue, &'static str)>)> {
    vec![
        (
            "int(subject)",
            vec![(s("7"), "value int 7"), (d(2.9), "value int 2"), (i(5), "value int 5")],
        ),
        ("uint(subject)", vec![(s("5"), "value uint 5"), (d(2.7), "value uint 2")]),
        (
            "double(subject)",
            vec![
                (s("2.5"), "value double 2.5"),
                (i(7), "value double 7"),
                (b(true), "error no_matching_overload [0, 15] no overload of \"double\" takes (bool)"),
            ],
        ),
        (
            "timestamp(subject)",
            vec![
                (s("1970-01-01T00:00:01Z"), "value timestamp 1970-01-01T00:00:01Z"),
                (i(61), "value timestamp 1970-01-01T00:01:01Z"),
            ],
        ),
        (
            "subject + subject",
            vec![
                (s("x"), "value string \"xx\""),
                (i(3), "value int 6"),
                (d(2.5), "value double 5"),
                (l(vec![i(1)]), "value list(int 1, int 1)"),
            ],
        ),
        (
            "string(subject)",
            vec![(d(2.5), "value string \"2.5\""), (i(7), "value string \"7\""), (by(&[65]), "value string \"A\"")],
        ),
        (
            "size(subject)",
            vec![(s("abc"), "value int 3"), (l(vec![i(1), i(2)]), "value int 2"), (by(&[1, 2, 3, 4]), "value int 4")],
        ),
        ("subject.size()", vec![(s("ab"), "value int 2"), (l(vec![i(1), i(2), i(3)]), "value int 3")]),
    ]
}

fn environment() -> CelEnvironment {
    let mut environment = loose();
    environment.register_variable("subject", "dyn", None).unwrap();
    environment
}

fn fresh_program(environment: &CelEnvironment, source: &str) -> Arc<CelProgram> {
    environment.compile_parsed(&environment.parse(source)).unwrap()
}

fn answered(program: &CelProgram, value: &CelValue) -> String {
    program_answer(program, &bindings(vec![("subject", value.clone())]))
}

#[test]
fn is_built_from_cases_whose_types_answer_differently_or_it_proves_nothing() {
    let environment = environment();
    let mut weak = Vec::new();
    for (source, values) in cases() {
        let answers: Vec<String> =
            values.iter().map(|(value, _)| answered(&fresh_program(&environment, source), value)).collect();
        if answers.iter().collect::<HashSet<_>>().len() != answers.len() {
            weak.push(format!("{source}: {}", answers.join(" | ")));
        }
    }
    assert_eq!(weak, Vec::<String>::new());
}

#[test]
fn answers_each_type_as_a_site_that_never_ran_would() {
    let environment = environment();
    let mut differences = Vec::new();
    let mut compared = 0;
    for (source, values) in cases() {
        let shared = fresh_program(&environment, source);
        for (value, node) in &values {
            // Twice through the shared site: the second call is the held path for THIS
            // type, after the site has already resolved under another one.
            let first = answered(&shared, value);
            let second = answered(&shared, value);
            let fresh = answered(&fresh_program(&environment, source), value);
            compared += 1;
            if first != fresh || second != fresh || fresh != *node {
                differences.push(format!("{source} over {value:?}: {first}/{second}, fresh {fresh}, Node {node}"));
            }
        }
        // And back to the first type, so a site that resolved for the LAST type is caught.
        let (first_value, _) = &values[0];
        let again = answered(&shared, first_value);
        let fresh = answered(&fresh_program(&environment, source), first_value);
        if again != fresh {
            differences.push(format!("{source} back to the first type: {again}, fresh {fresh}"));
        }
    }
    assert_eq!(differences, Vec::<String>::new());
    assert!(compared > 20);
}
