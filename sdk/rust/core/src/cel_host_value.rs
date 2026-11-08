//! The one seam a CEL value crosses on its way out to a host reader — `cel-host-value.ts`.
//!
//! The value domain has two representations of one map: a [`CelMap`], keyed by each key's
//! own typed value so one container holds CEL's four key types, and a [`CelRecord`], whose
//! keys are all strings, which is how a host hands a map over and the one a JSON Schema
//! validator, a controller's inputs and a module function's parameters read. So every
//! boundary where a value the engine computed reaches a host reader converts here: the
//! result of a compiled value, and the arguments of a module function's call.
//!
//! A map with an int, uint or bool key is left exactly as it is, its values included: a
//! record cannot hold such a key, and converting would collapse the key types to text.
//! Every other value crosses unchanged — a uint, a duration, an instant and bytes are what
//! a typed slot declares.
//!
//! The walk keeps its own work list, so a value of any depth costs no stack.
//!
//! Node items with no twin: `withLegacyDurationMethods` — a Rust duration has no class
//! whose methods a controller published against an older SDK reads.

use telorun_cel_value::{CelList, CelMap, CelRecord, CelValue};

/// `value` in the form a host holds it: every map whose keys are all strings a record,
/// at every depth. Where nothing moved the answer shares the value it was given.
pub fn host_value_of(value: &CelValue) -> CelValue {
    enum Task<'a> {
        Visit(&'a CelValue),
        /// Gather a list's elements, already converted.
        List(&'a CelValue, &'a CelList),
        /// Gather a record's values, already converted.
        Record(&'a CelValue, &'a CelRecord),
        /// Gather a string-keyed map's values, already converted, into a record.
        MapRecord(&'a CelMap),
    }
    // Each converted value, and whether it differs from the one it came from.
    let mut done: Vec<(CelValue, bool)> = Vec::new();
    let mut tasks = vec![Task::Visit(value)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(held) => match held {
                CelValue::List(list) if !list.is_empty() => {
                    tasks.push(Task::List(held, list));
                    tasks.extend(list.iter().rev().map(Task::Visit));
                }
                CelValue::Record(record) if !record.is_empty() => {
                    tasks.push(Task::Record(held, record));
                    let values: Vec<&CelValue> = record.iter().map(|(_, value)| value).collect();
                    tasks.extend(values.into_iter().rev().map(Task::Visit));
                }
                CelValue::Map(map) if map.iter().all(|(key, _)| matches!(key, CelValue::String(_))) => {
                    tasks.push(Task::MapRecord(map));
                    let values: Vec<&CelValue> = map.iter().map(|(_, value)| value).collect();
                    tasks.extend(values.into_iter().rev().map(Task::Visit));
                }
                _ => done.push((held.clone(), false)),
            },
            Task::List(held, list) => {
                let converted = done.split_off(done.len() - list.len());
                done.push(rebuilt(held, converted, |values| CelValue::List(values.collect())));
            }
            Task::Record(held, record) => {
                let converted = done.split_off(done.len() - record.len());
                done.push(rebuilt(held, converted, |values| {
                    CelValue::Record(record.keys().zip(values).collect())
                }));
            }
            Task::MapRecord(map) => {
                let converted = done.split_off(done.len() - map.len());
                let keys = map.iter().map(|(key, _)| match key {
                    CelValue::String(key) => key.to_string(),
                    _ => unreachable!("only a map whose keys are all strings is written as a record"),
                });
                done.push((CelValue::Record(keys.zip(converted.into_iter().map(|(value, _)| value)).collect()), true));
            }
        }
    }
    done.pop().expect("the walk answers the value it was given").0
}

/// The aggregate rebuilt from its converted children, or shared whole where none moved.
fn rebuilt(
    held: &CelValue,
    converted: Vec<(CelValue, bool)>,
    build: impl FnOnce(&mut dyn Iterator<Item = CelValue>) -> CelValue,
) -> (CelValue, bool) {
    if converted.iter().all(|(_, moved)| !moved) {
        return (held.clone(), false);
    }
    (build(&mut converted.into_iter().map(|(value, _)| value)), true)
}

#[cfg(test)]
mod tests {
    //! Twin of `sdk/nodejs/tests/cel-host-value.test.ts`, case for case.
    use super::*;
    use telorun_cel_value::cel_map_from_entries;

    fn s(text: &str) -> CelValue {
        CelValue::String(text.into())
    }

    fn map(entries: Vec<(CelValue, CelValue)>) -> CelValue {
        CelValue::Map(cel_map_from_entries(entries).unwrap())
    }

    fn string_keyed() -> CelValue {
        map(vec![(s("a"), CelValue::Int(1)), (s("b"), CelValue::List(vec![s("x")].into()))])
    }

    fn host_form() -> CelValue {
        CelValue::Record([("a", CelValue::Int(1)), ("b", CelValue::List(vec![s("x")].into()))].into_iter().collect())
    }

    #[test]
    fn writes_an_all_string_key_map_as_the_record_every_host_reader_can_read() {
        let host = host_value_of(&string_keyed());
        let CelValue::Record(record) = &host else { panic!("not a record: {host:?}") };
        assert_eq!(record.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(host, host_form());
    }

    #[test]
    fn leaves_a_map_with_a_non_string_key_exactly_as_it_is() {
        let int_keyed = map(vec![(CelValue::Int(1), s("one")), (CelValue::Int(2), string_keyed())]);
        let host = host_value_of(&int_keyed);
        assert!(matches!(host, CelValue::Map(_)));
        assert_eq!(host, int_keyed);
        let CelValue::Map(held) = host else { unreachable!() };
        assert!(held.iter().any(|(_, value)| matches!(value, CelValue::Map(_))), "its values are left too");
    }

    #[test]
    fn converts_a_map_nested_in_a_list_a_record_and_another_map() {
        let list = CelValue::List(vec![string_keyed()].into());
        assert_eq!(host_value_of(&list), CelValue::List(vec![host_form()].into()));
        let record = CelValue::Record([("held", string_keyed())].into_iter().collect());
        let converted = host_value_of(&record);
        let CelValue::Record(converted) = converted else { panic!() };
        assert!(matches!(converted.get("held"), Some(CelValue::Record(_))));
        let nested = map(vec![(s("inner"), string_keyed())]);
        let CelValue::Record(nested) = host_value_of(&nested) else { panic!() };
        assert!(matches!(nested.get("inner"), Some(CelValue::Record(_))));
    }

    #[test]
    fn answers_by_sharing_where_nothing_moved_so_an_unchanged_tree_is_not_copied() {
        let list = CelValue::List(vec![CelValue::Int(2)].into());
        let plain = CelValue::Record([("a", CelValue::Int(1)), ("b", list.clone())].into_iter().collect());
        let (CelValue::Record(given), CelValue::Record(answered)) = (&plain, host_value_of(&plain)) else { panic!() };
        let first = |record: &CelRecord| record.iter().next().map(|(_, value)| value as *const CelValue);
        assert_eq!(first(given), first(&answered));
        let (CelValue::List(given), CelValue::List(answered)) = (&list, host_value_of(&list)) else { panic!() };
        assert_eq!(given.as_ptr(), answered.as_ptr());
    }

    #[test]
    fn carries_every_other_value_of_the_domain_through_unchanged() {
        for value in [CelValue::Uint(7), CelValue::Bytes(vec![1, 2].into()), CelValue::Null, s("text"), CelValue::Int(9)] {
            assert_eq!(host_value_of(&value), value);
        }
        assert!(matches!(host_value_of(&CelValue::Uint(7)), CelValue::Uint(7)));
    }

    #[test]
    fn walks_a_value_of_any_depth_on_its_own_work_list() {
        let mut deep = string_keyed();
        for _ in 0..100_000 {
            deep = CelValue::List(vec![deep].into());
        }
        let mut answered = host_value_of(&deep);
        for _ in 0..100_000 {
            let CelValue::List(list) = answered else { panic!() };
            answered = list[0].clone();
        }
        assert_eq!(answered, host_form());
        assert!(matches!(answered, CelValue::Record(_)));
    }
}
