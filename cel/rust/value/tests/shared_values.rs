//! Shared aggregates: a clone shares what it holds, a value is never changed once
//! built, and a value of any depth is released, compared and printed on a small stack.
//!
//! These are the domain's own properties — Node's values are shared references, and
//! its engine has no stack to spare a depth for — so no expected value here is a Node
//! answer, except the record's order, which `cel_value.rs` pins against Node.

use std::any::Any;
use std::sync::Arc;

use telorun_cel_value::{
    cel_map_from_entries, cel_none, cel_some, CelHostValue, CelList, CelRecord, CelValue, PropertyMap,
};

const DEPTH: usize = 100_000;

fn text(value: &str) -> CelValue {
    CelValue::String(value.into())
}

fn on_a_small_stack(work: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new().stack_size(256 * 1024).spawn(work).unwrap().join().unwrap();
}

fn payload() -> Arc<dyn Any + Send + Sync> {
    Arc::new(())
}

/// One level of nesting of each aggregate kind, in turn; with `hosts` false, a host
/// value's entries are left out, since two host values are one only as one object.
fn wrap(held: CelValue, level: usize, hosts: bool) -> CelValue {
    match level % if hosts { 5 } else { 4 } {
        0 => CelValue::List(vec![held].into()),
        1 => CelValue::Map(cel_map_from_entries([(CelValue::Int(1), held)]).unwrap()),
        2 => CelValue::Record(CelRecord::from_iter([("k", held)])),
        3 => CelValue::Optional(cel_some(held)),
        _ => CelValue::Host(
            CelHostValue::with_entries("Box", payload(), [("k", held)].into_iter().collect()).unwrap(),
        ),
    }
}

fn deep(leaf: CelValue, hosts: bool) -> CelValue {
    (0..DEPTH).fold(leaf, |held, level| wrap(held, level, hosts))
}

#[test]
fn clones_an_aggregate_by_sharing_what_it_holds() {
    let long = "x".repeat(10 * 1024 * 1024);
    let CelValue::String(original) = text(&long) else { unreachable!() };
    let cloned = original.clone();
    assert!(std::ptr::eq(original.as_ptr(), cloned.as_ptr()));

    let list: CelList = (0..1_000_000).map(CelValue::Int).collect();
    assert!(std::ptr::eq(list.as_ptr(), list.clone().as_ptr()));

    let map = cel_map_from_entries((0..1000).map(|at| (CelValue::Int(at), CelValue::Int(at)))).unwrap();
    let first = |map: &telorun_cel_value::CelMap| map.iter().next().unwrap().1 as *const CelValue;
    assert!(std::ptr::eq(first(&map), first(&map.clone())));

    let record: CelRecord = (0..1000).map(|at| (at.to_string(), CelValue::Int(at))).collect();
    let first = |record: &CelRecord| record.iter().next().unwrap().1 as *const CelValue;
    assert!(std::ptr::eq(first(&record), first(&record.clone())));

    let optional = cel_some(CelValue::List(list.clone()));
    assert!(std::ptr::eq(optional.held().unwrap(), optional.clone().held().unwrap()));

    let host = CelHostValue::with_entries("Box", payload(), [("k", CelValue::Int(1))].into_iter().collect()).unwrap();
    assert!(std::ptr::eq(host.entries(), host.clone().entries()));
}

#[test]
fn changes_no_value_another_shares() {
    let mut record = CelRecord::from_iter([("a", CelValue::Int(1))]);
    let held = record.clone();
    assert_eq!(record.insert("a", CelValue::Int(2)), Some(CelValue::Int(1)));
    record.insert("b", CelValue::Null);
    assert_eq!(held.get("a"), Some(&CelValue::Int(1)));
    assert!(!held.contains_key("b"));
    assert_eq!(record.keys().collect::<Vec<_>>(), ["a", "b"]);
}

#[test]
fn holds_a_host_values_own_entries() {
    let entries: PropertyMap<CelValue> = [("amount", CelValue::Int(5)), ("currency", text("EUR"))].into_iter().collect();
    let money = CelHostValue::with_entries("Money", payload(), entries.clone()).unwrap();
    assert_eq!(money.type_name(), Some("Money"));
    assert_eq!(money.entries(), &entries);
    assert!(CelHostValue::named("Money", payload()).unwrap().entries().is_empty());
    assert!(CelHostValue::unnamed(payload()).entries().is_empty());
    assert_eq!(CelHostValue::with_entries("map", payload(), entries.clone()).unwrap_err().name(), "map");
    // One value only when it is the same object: name, payload and entries.
    assert_eq!(CelValue::Host(money.clone()), CelValue::Host(money.clone()));
    let shared = payload();
    assert_ne!(
        CelValue::Host(CelHostValue::with_entries("Money", shared.clone(), entries.clone()).unwrap()),
        CelValue::Host(CelHostValue::with_entries("Money", shared, entries).unwrap())
    );
}

#[test]
fn prints_each_aggregate_as_its_derived_form_would() {
    let list = CelValue::List(vec![CelValue::Int(1), text("a")].into());
    assert_eq!(format!("{list:?}"), r#"List([Int(1), String("a")])"#);
    let map = CelValue::Map(cel_map_from_entries([(CelValue::Int(1), CelValue::Bool(true))]).unwrap());
    assert_eq!(format!("{map:?}"), "Map({Int(1): Bool(true)})");
    let record = CelValue::Record(CelRecord::from_iter([("a", CelValue::Null), ("b", CelValue::Bytes(vec![1, 2].into()))]));
    assert_eq!(format!("{record:?}"), r#"Record({"a": Null, "b": Bytes([1, 2])})"#);
    assert_eq!(format!("{:?}", CelValue::Optional(cel_some(CelValue::Int(1)))), "Optional(CelOptional { held: Some(Int(1)) })");
    assert_eq!(format!("{:?}", CelValue::Optional(cel_none())), "Optional(CelOptional { held: None })");
    let host = CelHostValue::with_entries("Money", payload(), [("a", CelValue::Int(1))].into_iter().collect()).unwrap();
    assert_eq!(format!("{:?}", CelValue::Host(host)), r#"Host(CelHostValue { type_name: Some("Money"), entries: {"a": Int(1)}, .. })"#);
}

#[test]
fn releases_compares_and_prints_a_value_of_any_depth_on_a_small_stack() {
    on_a_small_stack(|| {
        let value = deep(CelValue::Int(1), false);
        assert_eq!(value, deep(CelValue::Int(1), false));
        assert_ne!(value, deep(CelValue::Int(2), false));
        let printed = format!("{value:?}");
        assert!(printed.starts_with("Optional(CelOptional { held: Some(Record({\"k\": Map({Int(1): List([Optional("));
        // Each cycle closes a list, a map, a record and an optional, innermost first.
        assert!(printed.contains("Map({Int(1): List([Int(1)])})"));
        assert!(printed.ends_with(&"])})})) })".repeat(DEPTH / 4)));
        drop(value);
        let hosts = deep(CelValue::Int(1), true);
        assert_eq!(hosts, hosts.clone());
        assert!(format!("{hosts:?}").starts_with("Host(CelHostValue { type_name: Some(\"Box\"), entries: {\"k\": Optional("));
        drop(hosts);
    });
}

#[test]
fn releases_a_child_shared_twice_once() {
    on_a_small_stack(|| {
        let child = deep(text("leaf"), true);
        let parent = CelValue::List(vec![child.clone(), child.clone()].into());
        drop(child);
        drop(parent);
    });
}

/// Every level holds the level below it twice, through one shared `Arc` — the shape
/// that recursed when a shared child was released by `Arc::get_mut` alone.
#[test]
fn releases_children_sharing_one_value_at_every_level() {
    on_a_small_stack(|| {
        let mut value = CelValue::Int(0);
        for level in 0..DEPTH {
            value = match level % 3 {
                0 => CelValue::List(vec![value.clone(), value].into()),
                1 => CelValue::Record(CelRecord::from_iter([("a", value.clone()), ("b", value)])),
                _ => CelValue::Map(cel_map_from_entries([(CelValue::Int(0), value.clone()), (CelValue::Int(1), value)]).unwrap()),
            };
        }
        assert_eq!(value, value.clone());
        drop(value);
    });
}

#[test]
fn releases_one_deep_value_from_many_threads_at_once() {
    on_a_small_stack(|| {
        let value = deep(CelValue::Null, true);
        let holders: Vec<_> = (0..8)
            .map(|_| {
                let held = value.clone();
                std::thread::Builder::new().stack_size(256 * 1024).spawn(move || drop(held)).unwrap()
            })
            .collect();
        drop(value);
        for holder in holders {
            holder.join().unwrap();
        }
    });
}
