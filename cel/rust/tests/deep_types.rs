//! Nothing recurses with its input: type text, types, signatures and JSON text of any
//! depth are read, printed, compared, matched, rebuilt and released on a stack of
//! 256 KiB, in a debug build.
//!
//! No Node test file is the twin of this one. What is Node's answer, executed
//! (`@telorun/cel 0.118.0 at 63c81d00`): every answer on the three-deep instance of
//! each row — the text printed, the type reported, unified, matched, listed, and the
//! scan's verdict. What is this crate's own, because Node cannot answer it — its
//! reader, printer and comparisons throw `RangeError` on these inputs: that each deep
//! input is handled at all, and every answer on it, which is the three-deep answer
//! carried to its depth.

use std::fmt::{self, Write};
use std::sync::Arc;

use telorun_cel::{
    assignable, format_signature, parameter_of, format_type, parse_signature, parse_type_expression, read_json_text,
    register_standard_library, scan_json_prefix, types_equal, unify, union_of, without_parameters, CallForm,
    CelEnvironment, CelType, FunctionRegistry, JsonRefusal, JsonValue, NominalType, NominalTypeDefinition,
    RecordType, StandardLibraryOptions, INT, NULL,
};

/// The one stack size any test of this crate names.
const STACK_BYTES: usize = 256 * 1024;

const DEPTH: usize = 100_000;

fn on_a_small_stack(work: impl FnOnce() + Send + 'static) {
    let thread = std::thread::Builder::new().stack_size(STACK_BYTES).spawn(work).expect("the thread starts");
    thread.join().expect("the work ran to its end");
}

/// Counts what is written and keeps none of it.
struct Counted(usize);

impl Write for Counted {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.0 += text.len();
        Ok(())
    }
}

fn nested(open: &str, inner: &str, close: &str, depth: usize) -> String {
    format!("{}{inner}{}", open.repeat(depth), close.repeat(depth))
}

fn lists(inner: &str, depth: usize) -> String {
    nested("list<", inner, ">", depth)
}

#[test]
fn reads_prints_compares_and_releases_a_deep_type() {
    on_a_small_stack(|| {
        for depth in [3, DEPTH] {
            let ints = parse_type_expression(&lists("int", depth), None).expect("reads");
            assert_eq!(format_type(&ints, false), lists("int", depth));
            let again = parse_type_expression(&lists("int", depth), None).expect("reads");
            assert!(types_equal(&ints, &again) && ints == again);
            assert!(assignable(&ints, &parse_type_expression(&lists("dyn", depth), None).expect("reads")));
            let parameters = parse_type_expression(&lists("A", depth), None).expect("reads");
            assert_eq!(format_type(&without_parameters(&parameters), false), lists("dyn", depth));
            // Equal sides unify at once; the union of two equal types is the type.
            assert!(unify(&ints, &again) == ints);
            assert!(union_of([ints.clone(), again]) == ints);
            let mut counted = Counted(0);
            write!(counted, "{ints:?}").expect("writes");
            assert!(counted.0 > depth);
        }
    });
}

#[test]
fn compares_and_releases_deep_records_named_types_and_unions() {
    on_a_small_stack(|| {
        let build = |depth: usize| {
            let mut ty = INT;
            for at in 0..depth {
                let record = CelType::Record(RecordType {
                    name: None,
                    fields: [("x", ty), ("y", parameter_of("A"))].into_iter().collect(),
                    open: false,
                });
                ty = if at % 2 == 0 {
                    union_of([record, NULL])
                } else {
                    CelType::Nominal(NominalType { name: "N".into(), base: Arc::new(INT), args: Arc::new([record]), fields: None })
                };
            }
            ty
        };
        for depth in [3, DEPTH] {
            let ty = build(depth);
            let again = build(depth);
            assert!(types_equal(&ty, &again) && ty == again);
            assert!(union_of([ty.clone(), again.clone()]) == ty);
            let reported = without_parameters(&ty);
            assert!(!types_equal(&reported, &ty));
            assert!(types_equal(&without_parameters(&again), &reported));
            let mut counted = Counted(0);
            write!(counted, "{ty:?}").expect("writes");
            assert!(counted.0 > depth);
        }
    });
}

#[test]
fn unifies_two_deep_types_that_differ_at_the_bottom() {
    // Each level compares what is below it, so the work is the square of the depth;
    // five thousand levels are deeper than a recursive walk survives on this stack.
    on_a_small_stack(|| {
        for depth in [3, 5_000] {
            let parameters = parse_type_expression(&lists("A", depth), None).expect("reads");
            let ints = parse_type_expression(&lists("int", depth), None).expect("reads");
            assert_eq!(format_type(&unify(&parameters, &ints), false), lists("int", depth));
        }
    });
}

#[test]
fn resolves_and_lists_calls_over_deep_types() {
    on_a_small_stack(|| {
        let mut registry = FunctionRegistry::new();
        register_standard_library(&mut registry, StandardLibraryOptions::default());
        for depth in [3, DEPTH] {
            let ints = parse_type_expression(&lists("int", depth), None).expect("reads");
            let resolution = registry.resolve("+", CallForm::Global, &[ints.clone(), ints.clone()], None).expect("resolves");
            assert_eq!(format_signature(&resolution.resolved.signature), "+(list<A>, list<A>): list<A>");
            assert!(resolution.returns == ints);
            let text = format!("f({}): {}", lists("int", depth), lists("string", depth));
            assert_eq!(format_signature(&parse_signature(&text, None).expect("reads")), text);
        }
        for depth in [3, DEPTH] {
            let mut environment = CelEnvironment::default();
            environment
                .register_type(NominalTypeDefinition {
                    name: "Box".into(),
                    base: "list<A>".into(),
                    parameters: vec!["A".into()],
                    ..Default::default()
                })
                .expect("registers");
            let text = nested("Box<", "int", ">", depth);
            environment.register_variable("v", text.as_str(), None).expect("registers");
            let listed = environment.definitions().variables.into_iter().find(|variable| variable.name == "v").expect("listed");
            assert_eq!(listed.type_name, text);
        }
    });
}

#[test]
fn scans_reads_compares_and_releases_deep_json() {
    on_a_small_stack(|| {
        for depth in [3, DEPTH] {
            let arrays = nested("[", "", "]", depth);
            assert_eq!(scan_json_prefix(&arrays), None);
            assert_eq!(scan_json_prefix(&"[".repeat(depth)), Some(JsonRefusal { offset: depth, end_of_input: true }));
            let objects = nested("{\"a\":", "1", "}", depth);
            assert_eq!(scan_json_prefix(&objects), None);
            for text in [arrays, objects] {
                let value = read_json_text(&text).expect("reads");
                let again = read_json_text(&text).expect("reads");
                assert!(*value == *again);
                let mut counted = Counted(0);
                write!(counted, "{value:?}").expect("writes");
                assert!(counted.0 > depth);
                let mut depth_read = 0;
                let mut at: &JsonValue = &value;
                loop {
                    match at {
                        JsonValue::Array(items) if !items.is_empty() => at = &items[0],
                        JsonValue::Object(entries) => at = entries.get("a").expect("nested"),
                        _ => break,
                    }
                    depth_read += 1;
                }
                assert_eq!(depth_read, depth - usize::from(matches!(*value, JsonValue::Array(_))));
            }
        }
    });
}
