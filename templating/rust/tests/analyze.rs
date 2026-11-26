//! Twin of `templating/nodejs/tests/analyze.test.ts`, case for case, but for the cases of
//! `validateChainAgainstSchema`, which has no twin here (`src/cel/analyze.rs` says why).

use telo_templating::cel::analyze::{extract_access_chains, extract_read_chains, extract_value_read_chains};
use telo_templating::{build_cel_environment, CelHandlers};
use telorun_cel::CelEnvironment;

fn env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

fn chains(source: &str) -> Vec<Vec<String>> {
    extract_access_chains(&env().parse(source).root)
}

fn chain(segments: &[&str]) -> Vec<String> {
    segments.iter().map(|segment| segment.to_string()).collect()
}

// --- extractAccessChains ------------------------------------------------------

#[test]
fn returns_a_single_chain_for_a_dotted_member_access() {
    assert_eq!(chains("request.query.name"), [chain(&["request", "query", "name"])]);
}

#[test]
fn treats_bracket_index_access_as_a_sentinel_segment() {
    assert_eq!(chains("items[0].value"), [chain(&["items", "[*]", "value"])]);
}

#[test]
fn returns_multiple_chains_when_several_roots_are_referenced() {
    let found = chains("variables.a + secrets.b");
    assert!(found.contains(&chain(&["variables", "a"])));
    assert!(found.contains(&chain(&["secrets", "b"])));
}

#[test]
fn ignores_variables_bound_by_comprehension_macros() {
    let found = chains("items.filter(x, x.valid)");
    assert!(found.contains(&chain(&["items"])));
    assert!(!found.iter().any(|held| held[0] == "x"));
}

#[test]
fn descends_through_unary_operators() {
    assert_eq!(chains("!steps.parseManifest.result"), [chain(&["steps", "parseManifest", "result"])]);
    assert_eq!(chains("-counter.value"), [chain(&["counter", "value"])]);
}

#[test]
fn recovers_chains_from_inside_optional_access() {
    assert!(chains("steps.x.result.docs[?0].?kind.orValue('')").contains(&chain(&["steps", "x", "result", "docs"])));
}

// --- cel.bind ---------------------------------------------------------------------

#[test]
fn scopes_the_bound_name_to_the_body_and_leaves_init_in_the_enclosing_scope() {
    let found = chains("cel.bind(c, request.q, string(c) + item.x)");
    assert!(found.contains(&chain(&["request", "q"])));
    assert!(found.contains(&chain(&["item", "x"])));
    assert!(!found.contains(&chain(&["c"])));
}

#[test]
fn does_not_emit_a_chain_for_the_cel_pseudo_receiver() {
    assert!(!chains("cel.bind(c, 150, string(c))").contains(&chain(&["cel"])));
}

#[test]
fn still_reports_a_name_used_in_init_which_the_binding_does_not_cover() {
    assert_eq!(chains("cel.bind(c, c, string(c))"), [chain(&["c"])]);
}

#[test]
fn resolves_both_names_when_binds_are_nested() {
    assert_eq!(chains("cel.bind(a, variables.x, cel.bind(b, a + 1, string(a) + string(b)))"), [chain(&["variables", "x"])]);
}

// --- extractValueReadChains ---------------------------------------------------

fn reads(source: &str) -> Vec<Vec<String>> {
    extract_value_read_chains(&env().parse(source).root)
}

fn whole(source: &str) -> Vec<Vec<String>> {
    extract_read_chains(&env().parse(source).root)
}

#[test]
fn value_reads_a_bare_iteration_variable_as_each_element_of_its_range() {
    assert!(reads("self.m.all(k, k in self.names)").contains(&chain(&["self", "m", "[]", "[]!"])));
    assert!(whole("self.m.all(k, k in self.names)").contains(&chain(&["self", "m"])));
}

#[test]
fn value_reads_the_range_of_an_in_test_as_each_element_of_it() {
    assert!(reads("n in self.m").contains(&chain(&["self", "m", "[]", "[]!"])));
    assert!(whole("n in self.m").contains(&chain(&["self", "m"])));
}

#[test]
fn value_reads_keep_a_member_read_through_the_variable() {
    assert!(reads("self.xs.all(x, x.path != '')").contains(&chain(&["self", "xs", "[]", "path"])));
}

#[test]
fn value_reads_leave_a_range_that_is_only_iterated_unread() {
    assert_eq!(reads("self.xs.all(x, true)"), [chain(&["self", "xs", "[]"])]);
}
