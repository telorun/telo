//! Twin of `templating/nodejs/tests/registry.test.ts` — the closed engine table and its
//! read-only registry.
//!
//! Node cases with no twin: registering an engine, the duplicate refusal, registration order
//! and a fresh registry per call — the table is static and nothing registers into it.

use telo_templating::{default_registry, BUILTIN_ENGINES};

#[test]
fn returns_nothing_for_unknown_engine_names() {
    assert!(default_registry().get("missing").is_none());
    assert!(!default_registry().has("missing"));
}

#[test]
fn ships_the_closed_built_in_set() {
    let mut names: Vec<&str> = BUILTIN_ENGINES.iter().map(|engine| engine.name()).collect();
    names.sort();
    assert_eq!(names, ["cel", "include-bytes", "include-text", "interpolate", "literal", "module-path", "ref", "sql"]);
}

#[test]
fn the_default_registry_holds_every_builtin_in_table_order() {
    let registry = default_registry();
    for engine in BUILTIN_ENGINES {
        assert!(registry.has(engine.name()));
        assert_eq!(registry.get(engine.name()).unwrap().name(), engine.name());
    }
    let listed: Vec<&str> = registry.list().iter().map(|engine| engine.name()).collect();
    let table: Vec<&str> = BUILTIN_ENGINES.iter().map(|engine| engine.name()).collect();
    assert_eq!(listed, table);
}

#[test]
fn is_one_registry_for_every_caller() {
    assert!(std::ptr::eq(default_registry(), default_registry()));
}
