//! Twin of `cel/nodejs/tests/checker-cost.test.ts`, case for case: checking does not get
//! more expensive as a schema gets deeper, because a schema is converted once, at
//! registration, and a check walks the expression alone.
//!
//! It is asserted as work, never as elapsed time: a counting resolver is asked at every
//! schema node, so the number of nodes read is exact. Every count is the Node build's
//! answer, executed: `@telorun/cel 0.118.0 at 63c81d00` — Node's file asserts a lower bound
//! where this one pins the count.

mod check_support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use check_support::json;
use telorun_cel::{CelEnvironment, CelEnvironmentOptions, JsonSchemaDocument, JsonValue};

/// A schema `depth` levels deep, each level holding `width` properties, as JSON text.
fn deep_schema(depth: usize, width: usize) -> String {
    let mut node = r#"{"type":"object","properties":{"leaf":{"type":"string"}}}"#.to_string();
    for _ in 0..depth {
        let fields: String = (0..width).map(|at| format!(r#","field{at}":{{"type":"integer"}}"#)).collect();
        node = format!(r#"{{"type":"object","properties":{{"next":{node}{fields}}}}}"#);
    }
    node
}

/// The same, every level reached through a document-local reference and merged out of
/// two `allOf` halves.
fn deep_referenced_schema(depth: usize, width: usize) -> String {
    let mut defs = vec![r#""leaf":{"type":"object","properties":{"leaf":{"type":"string"}}}"#.to_string()];
    let mut previous = "leaf".to_string();
    for level in 0..depth {
        let fields: Vec<String> = (0..width).map(|at| format!(r#""field{at}":{{"type":"integer"}}"#)).collect();
        defs.push(format!(
            r##""level{level}":{{"allOf":[{{"type":"object","properties":{{"next":{{"$ref":"#/$defs/{previous}"}}}}}},{{"type":"object","properties":{{{}}}}}]}}"##,
            fields.join(",")
        ));
        previous = format!("level{level}");
    }
    format!(r##"{{"$ref":"#/$defs/{previous}","$defs":{{{}}}}}"##, defs.join(","))
}

/// An environment whose resolver counts every schema node it is asked about, with
/// `subject` registered from `schema`.
fn counting(schema: &str) -> (CelEnvironment, Arc<AtomicUsize>) {
    let read = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&read);
    let mut environment = CelEnvironment::new(CelEnvironmentOptions {
        resolve_schema_type: Some(Arc::new(move |_: &JsonSchemaDocument| {
            counter.fetch_add(1, Ordering::SeqCst);
            None
        })),
        ..Default::default()
    });
    environment.register_variable("subject", JsonSchemaDocument { node: json(schema), root: None }, None).unwrap();
    (environment, read)
}

/// Schema nodes read across 100 checks, once registration has already read the schema.
fn schema_reads_per_check(schema: &str, source: &str, registration_reads: usize) -> usize {
    let (environment, read) = counting(schema);
    assert!(environment.check(source).valid, "{source}");
    let after_registration = read.load(Ordering::SeqCst);
    assert_eq!(after_registration, registration_reads);
    for _ in 0..100 {
        environment.check(source);
    }
    read.load(Ordering::SeqCst) - after_registration
}

#[test]
fn checking_against_a_schema_does_not_grow_with_its_depth() {
    let source = "subject.next.next.field0 + subject.field1";
    let shallow = schema_reads_per_check(&deep_schema(4, 16), source, 70);
    let deep = schema_reads_per_check(&deep_schema(64, 16), source, 1090);
    assert_eq!((shallow, deep), (0, 0));
}

#[test]
fn a_schema_is_converted_once_per_registration_however_often_it_is_checked_against() {
    let (environment, read) = counting(&deep_schema(64, 16));
    assert_eq!(read.load(Ordering::SeqCst), 1090);
    for _ in 0..100 {
        environment.check("subject.next.leaf");
    }
    assert_eq!(read.load(Ordering::SeqCst), 1090);
}

#[test]
fn checking_against_a_schema_of_references_does_not_grow_with_its_depth() {
    let source = "subject.next.next.field0 + subject.field1";
    let shallow = schema_reads_per_check(&deep_referenced_schema(4, 16), source, 83);
    let deep = schema_reads_per_check(&deep_referenced_schema(64, 16), source, 1283);
    assert_eq!((shallow, deep), (0, 0));
}

#[test]
fn a_schema_of_references_is_resolved_and_converted_once_per_registration() {
    let (environment, read) = counting(&deep_referenced_schema(64, 16));
    assert_eq!(read.load(Ordering::SeqCst), 1283);
    assert_eq!(environment.check("subject.next.next.field0").type_name, "int");
    for _ in 0..100 {
        environment.check("subject.next.leaf");
    }
    assert_eq!(read.load(Ordering::SeqCst), 1283);
}

#[test]
fn a_shape_referenced_many_times_is_converted_once_so_the_cost_is_in_the_nodes_reached() {
    let held: String =
        (0..50).map(|at| format!(r##""held{at}":{{"$ref":"#/$defs/Shape"}}"##)).collect::<Vec<_>>().join(",");
    let root = json(&format!(
        r#"{{"type":"object","properties":{{{held}}},"$defs":{{"Shape":{{"type":"object","properties":{{"a":{{"type":"string"}},"b":{{"type":"integer"}},"c":{{"type":"boolean"}}}}}}}}}}"#
    ));
    let entries = |value: &Arc<JsonValue>, key: &str| match &**value {
        JsonValue::Object(entries) => Arc::clone(entries.get(key).unwrap()),
        _ => unreachable!(),
    };
    let shape = entries(&entries(&root, "$defs"), "Shape");
    let shape_properties = entries(&shape, "properties");
    let JsonValue::Object(fields) = &*shape_properties else { unreachable!() };
    let mut shape_nodes: Vec<Arc<JsonValue>> = vec![Arc::clone(&shape)];
    shape_nodes.extend(fields.values().cloned());
    let shape_reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&shape_reads);
    let mut environment = CelEnvironment::new(CelEnvironmentOptions {
        resolve_schema_type: Some(Arc::new(move |document: &JsonSchemaDocument| {
            if shape_nodes.iter().any(|node| Arc::ptr_eq(node, &document.node)) {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            None
        })),
        ..Default::default()
    });
    environment.register_variable("subject", JsonSchemaDocument { node: root, root: None }, None).unwrap();
    // The shape and its three fields, once — not once per reference.
    assert_eq!(shape_reads.load(Ordering::SeqCst), 4);
    assert_eq!(environment.check("subject.held49.c").type_name, "bool");
}
