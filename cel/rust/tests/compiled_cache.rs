//! The compiled-expression cache and what a program holds: each of the eight
//! registrations forgets what was compiled, so a compile after one reads it — while a
//! program already held keeps answering with what it compiled against.
//!
//! Each "after" answer is what Node's `CelEnvironment.evaluate` answered after the same
//! registration, executed — `@telorun/cel 0.120.1 at b4a2b6e9`. What a held program
//! answers is this crate's own rule and a difference from Node, named where it is
//! asserted.

mod evaluation_support;
mod value_support;

use std::sync::Arc;

use evaluation_support::{bindings, loose, program_answer};
use telorun_cel::{
    CelActivation, CelCallContext, CelEnvironment, CelEnvironmentOptions, CelHostValue, CelImplementation,
    CelProgram, CelValue, EvaluateOptions, FunctionMetadata, NamespaceOptions, NominalTypeDefinition, PropertyMap,
};
use value_support::{i, rec, s};

#[allow(unused_variables)]
fn answering(value: CelValue) -> FunctionMetadata {
    let implementation: CelImplementation = Arc::new(move |context: &CelCallContext, args: &[CelValue]| value.clone());
    FunctionMetadata { implementation: Some(implementation), ..FunctionMetadata::default() }
}

/// Compiles `source`, registers, compiles again: a different program, answering what Node
/// answers after the registration, while the program held from before answers as before.
fn forgets(
    mut environment: CelEnvironment,
    source: &str,
    activation: &dyn CelActivation,
    register: impl FnOnce(&mut CelEnvironment),
    before: &str,
    after: &str,
) {
    let held = environment.compile(source).unwrap();
    assert_eq!(program_answer(&held, activation), before, "{source} before");
    register(&mut environment);
    let compiled = environment.compile(source).unwrap();
    assert!(!Arc::ptr_eq(&held, &compiled), "{source} was served from the cache");
    assert_eq!(program_answer(&compiled, activation), after, "{source} after");
    assert_eq!(program_answer(&held, activation), before, "{source} held");
}

fn sizes() -> CelEnvironment {
    CelEnvironment::default()
}

#[test]
fn forgets_what_it_compiled_when_a_function_is_registered() {
    forgets(
        sizes(),
        "size('ab')",
        &(),
        |environment| environment.register_function("size(string): int", answering(i(99))).unwrap(),
        "value int 2",
        "value int 99",
    );
}

#[test]
fn forgets_what_it_compiled_when_a_function_is_removed() {
    forgets(
        sizes(),
        "size('ab')",
        &(),
        |environment| assert!(environment.remove_function("size(string): int").unwrap()),
        "value int 2",
        "error no_matching_overload [0, 10] no overload of \"size\" takes (string)",
    );
}

#[test]
fn forgets_what_it_compiled_when_every_function_of_a_name_is_removed() {
    forgets(
        sizes(),
        "size('ab')",
        &(),
        |environment| assert!(environment.remove_functions_named("size") > 0),
        "value int 2",
        "error no_matching_overload [0, 10] no overload of \"size\" takes (string)",
    );
}

#[test]
fn forgets_what_it_compiled_when_an_operator_is_registered() {
    forgets(
        sizes(),
        "'a' + 'b'",
        &(),
        |environment| environment.register_operator("+", &["string", "string"], "string", answering(s("joined"))).unwrap(),
        "value string \"ab\"",
        "value string \"joined\"",
    );
}

fn chain_activation() -> PropertyMap<CelValue> {
    bindings(vec![("a.b", rec(vec![("c", i(99))])), ("a", rec(vec![("b", rec(vec![("c", i(1))]))]))])
}

#[test]
fn forgets_what_it_compiled_when_a_variable_is_declared() {
    forgets(
        loose(),
        "a.b.c",
        &chain_activation(),
        |environment| environment.register_variable("a", "map<string, dyn>", None).unwrap(),
        "value int 99",
        "value int 1",
    );
}

#[test]
fn forgets_what_it_compiled_when_a_constant_is_declared() {
    forgets(
        loose(),
        "a.b.c",
        &chain_activation(),
        |environment| environment.register_constant("a", "map<string, dyn>", None).unwrap(),
        "value int 99",
        "value int 1",
    );
}

fn place_value() -> CelValue {
    let entries: PropertyMap<CelValue> = [("street", s("Main"))].into_iter().collect();
    CelValue::Host(CelHostValue::with_entries("Place", Arc::new(()), entries).unwrap())
}

fn place(conversions: Vec<String>) -> NominalTypeDefinition {
    NominalTypeDefinition {
        name: "Place".into(),
        base: "dyn".into(),
        fields: Some([("street", "string".to_string())].into_iter().collect()),
        conversions,
        ..Default::default()
    }
}

#[test]
fn forgets_what_it_compiled_when_a_type_is_registered() {
    // Node's held program reads the environment's types live, and answers `"Main"` here.
    forgets(
        loose(),
        "dyn(p).street",
        &bindings(vec![("p", place_value())]),
        |environment| environment.register_type(place(Vec::new())).unwrap(),
        "error unsupported_container [0, 13] this value holds no members",
        "value string \"Main\"",
    );
}

#[test]
fn forgets_what_it_compiled_when_a_type_registration_is_refused_part_way() {
    // The type is held before the conversion naming an unregistered type is refused.
    forgets(
        loose(),
        "dyn(p).street",
        &bindings(vec![("p", place_value())]),
        |environment| assert!(environment.register_type(place(vec!["string(Self): Nope".into()])).is_err()),
        "error unsupported_container [0, 13] this value holds no members",
        "value string \"Main\"",
    );
}

#[test]
#[allow(unused_variables)]
fn forgets_what_it_compiled_when_a_namespace_is_registered() {
    let mut environment = loose();
    let held = environment.compile("Billing.total(1)").unwrap();
    environment.register_namespace("Billing", vec!["total(int): int".into()], NamespaceOptions::default()).unwrap();
    let compiled = environment.compile("Billing.total(1)").unwrap();
    assert!(!Arc::ptr_eq(&held, &compiled));
    let seven: CelImplementation = Arc::new(|context: &CelCallContext, args: &[CelValue]| i(7));
    let bind = |namespace: &str, name: &str| Some(Arc::clone(&seven));
    let options = EvaluateOptions { namespace_function: Some(&bind) };
    let answer = |program: &CelProgram| evaluation_support::answer(program.evaluate(&(), &options).map_err(Into::into));
    assert_eq!(answer(&compiled), "value int 7");
    assert_eq!(answer(&held), "error no_such_variable [0, 7] no such variable: Billing");
}

/// A difference: Node's program reads the live registry where a call site has not yet
/// resolved — a held, never-evaluated `size('ab')` answers `99` after the registration —
/// and the old one where it has (`2`). Here a program answers with the library it was
/// compiled against, whichever sites ran.
#[test]
fn keeps_the_library_a_held_program_compiled_against_whether_its_sites_ran_or_not() {
    let mut environment = sizes();
    let cold = environment.compile_parsed(&environment.parse("size('ab')")).unwrap();
    let warm = environment.compile_parsed(&environment.parse("size('ab')")).unwrap();
    assert_eq!(program_answer(&warm, &()), "value int 2");
    environment.register_function("size(string): int", answering(i(99))).unwrap();
    assert_eq!(program_answer(&cold, &()), "value int 2");
    assert_eq!(program_answer(&warm, &()), "value int 2");
    assert_eq!(program_answer(&environment.compile("size('ab')").unwrap(), &()), "value int 99");
}

#[test]
fn starts_a_clone_with_an_empty_cache_of_the_capacity_its_options_give() {
    let environment = sizes();
    let held = environment.compile("1 + 1").unwrap();
    let clone = environment.clone();
    assert!(!Arc::ptr_eq(&held, &clone.compile("1 + 1").unwrap()));
    assert!(Arc::ptr_eq(&held, &environment.compile("1 + 1").unwrap()));
    let one = environment.clone_with_options(CelEnvironmentOptions {
        compiled_cache_capacity: 1.try_into().unwrap(),
        ..environment.options().clone()
    });
    let first = one.compile("1 + 1").unwrap();
    one.compile("2 + 2").unwrap();
    assert!(!Arc::ptr_eq(&first, &one.compile("1 + 1").unwrap()));
}

#[test]
fn never_caches_a_tree_handed_in() {
    let environment = sizes();
    let expression = environment.parse("1 + 1");
    let first = environment.compile_parsed(&expression).unwrap();
    assert!(!Arc::ptr_eq(&first, &environment.compile_parsed(&expression).unwrap()));
}
