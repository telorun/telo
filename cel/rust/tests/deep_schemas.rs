//! Nothing recurses with a schema's depth: a schema nested, referenced, composed and
//! intersected 100,000 levels deep is read, its reports written, its type released, and
//! a field map as deep is typed, copied, compared, printed and released, on a stack of
//! 256 KiB, in a debug build.
//!
//! No Node test file is the twin of this one. What is Node's answer, executed
//! (`@telorun/cel 0.118.0 at 63c81d00`): every answer on the three-deep instance of each
//! row — the type written out, every report and the resolver's call count. What is this
//! crate's own, because Node's reader recurses and throws `RangeError` on these inputs:
//! that each deep input is handled at all, and every answer on it, which is the
//! three-deep answer carried to its depth.

mod schema_support;

use std::fmt::{self, Write};

use schema_support::{described, read_schema, report_lines};
use telorun_cel::{field_map_type, format_type, parse_type_expression, CelType, FieldDeclaration};
use telorun_cel_value::PropertyMap;

/// The one stack size any test of this crate names.
const STACK_BYTES: usize = 256 * 1024;

const DEPTH: usize = 100_000;

fn on_a_small_stack(work: impl FnOnce() + Send + 'static) {
    let thread = std::thread::Builder::new().stack_size(STACK_BYTES).spawn(work).expect("the thread starts");
    thread.join().expect("the work ran to its end");
}

fn nested(open: &str, inner: &str, close: &str, depth: usize) -> String {
    format!("{}{inner}{}", open.repeat(depth), close.repeat(depth))
}

/// How many records deep a record nests through its field `name`, and what is at the
/// bottom.
fn record_depth<'t>(mut ty: &'t CelType, name: &str) -> (usize, &'t CelType) {
    let mut depth = 0;
    while let CelType::Record(record) = ty {
        match record.fields.get(name) {
            Some(field) => {
                ty = field;
                depth += 1;
            }
            None => break,
        }
    }
    (depth, ty)
}

/// One schema at both depths: Node's three-deep answer, and the same answer carried to
/// `DEPTH` by `deep`.
fn at_both_depths(
    schema: impl Fn(usize) -> String,
    node_described: &str,
    node_reports: &[&str],
    node_calls: usize,
    deep: impl Fn(usize, &CelType, Vec<String>, usize),
) {
    let (result, calls) = read_schema(&schema(3), &[], &[]);
    let result = result.expect("reads");
    assert_eq!(described(&result.ty), node_described);
    assert_eq!(report_lines(&result), node_reports);
    assert_eq!(calls, node_calls);
    for depth in [3, DEPTH] {
        let (result, calls) = read_schema(&schema(depth), &[], &[]);
        let result = result.expect("reads");
        let reports = report_lines(&result);
        deep(depth, &result.ty, reports, calls);
    }
}

#[test]
fn reads_nested_properties() {
    on_a_small_stack(|| {
        at_both_depths(
            |depth| nested(r#"{"properties":{"a":"#, r#"{"if":{}}"#, "}}", depth),
            "{a: {a: {a: dyn}}}",
            &["keyword-not-read pointer=/properties/a/properties/a/properties/a keywords=if"],
            4,
            |depth, ty, reports, calls| {
                let (levels, bottom) = record_depth(ty, "a");
                assert_eq!((levels, format_type(bottom, true)), (depth, "dyn".to_string()));
                assert_eq!(reports, [format!("keyword-not-read pointer={} keywords=if", "/properties/a".repeat(depth))]);
                assert_eq!(calls, depth + 1);
            },
        );
    });
}

#[test]
fn reads_nested_items() {
    on_a_small_stack(|| {
        at_both_depths(
            |depth| nested(r#"{"items":"#, r#"{"type":"string"}"#, "}", depth),
            "list<list<list<string>>>",
            &[],
            4,
            |depth, ty, reports, calls| {
                assert_eq!(format_type(ty, true), nested("list<", "string", ">", depth));
                assert!(reports.is_empty());
                assert_eq!(calls, depth + 1);
            },
        );
    });
}

#[test]
fn reads_nested_all_of() {
    on_a_small_stack(|| {
        at_both_depths(
            |depth| nested(r#"{"allOf":["#, r#"{"type":"string"}"#, "]}", depth),
            "string",
            &[],
            4,
            |depth, ty, reports, calls| {
                assert_eq!(format_type(ty, true), "string");
                assert!(reports.is_empty());
                assert_eq!(calls, depth + 1);
            },
        );
    });
}

fn definitions(depth: usize, each: impl Fn(usize) -> String, last: &str) -> String {
    let mut text = String::from(r##"{"$ref":"#/$defs/d0","$defs":{"##);
    for at in 0..depth {
        write!(text, r#""d{at}":{},"#, each(at + 1)).expect("writes");
    }
    write!(text, r#""d{depth}":{last}}}}}"#).expect("writes");
    text
}

#[test]
fn follows_a_chain_of_references() {
    on_a_small_stack(|| {
        at_both_depths(
            |depth| definitions(depth, |next| format!(r##"{{"$ref":"#/$defs/d{next}"}}"##), r#"{"type":"string","not":{}}"#),
            "string",
            &["keyword-not-read pointer=/$defs/d3 keywords=not"],
            5,
            |depth, ty, reports, calls| {
                assert_eq!(format_type(ty, true), "string");
                assert_eq!(reports, [format!("keyword-not-read pointer=/$defs/d{depth} keywords=not")]);
                assert_eq!(calls, depth + 2);
            },
        );
    });
}

#[test]
fn declares_a_reference_re_entered_at_the_end_of_a_chain() {
    on_a_small_stack(|| {
        at_both_depths(
            |depth| {
                definitions(
                    depth,
                    |next| format!(r##"{{"properties":{{"next":{{"$ref":"#/$defs/d{next}"}}}}}}"##),
                    r##"{"$ref":"#/$defs/d0"}"##,
                )
            },
            "{next: {next: {next: dyn}}}",
            &["recursive pointer=/$defs/d0 reference=#/$defs/d0"],
            8,
            |depth, ty, reports, calls| {
                let (levels, bottom) = record_depth(ty, "next");
                assert_eq!((levels, format_type(bottom, true)), (depth, "dyn".to_string()));
                assert_eq!(reports, ["recursive pointer=/$defs/d0 reference=#/$defs/d0"]);
                assert_eq!(calls, 2 * depth + 2);
            },
        );
    });
}

fn two_halves(left: &str, right: &str, depth: usize) -> String {
    format!(
        r#"{{"allOf":[{},{}]}}"#,
        nested(r#"{"properties":{"a":"#, left, "}}", depth),
        nested(r#"{"properties":{"a":"#, right, "}}", depth)
    )
}

#[test]
fn intersects_two_deep_records() {
    on_a_small_stack(|| {
        at_both_depths(
            |depth| two_halves("{}", r#"{"type":"string"}"#, depth),
            "{a: {a: {a: string}}}",
            &[],
            9,
            |depth, ty, reports, calls| {
                let (levels, bottom) = record_depth(ty, "a");
                assert_eq!((levels, format_type(bottom, true)), (depth, "string".to_string()));
                assert!(reports.is_empty());
                assert_eq!(calls, 2 * depth + 3);
            },
        );
        at_both_depths(
            |depth| two_halves(r#"{"type":"integer"}"#, r#"{"type":"string"}"#, depth),
            "dyn",
            &["intersection-empty pointer= keywords=allOf"],
            9,
            |depth, ty, reports, calls| {
                assert_eq!(format_type(ty, true), "dyn");
                assert_eq!(reports, ["intersection-empty pointer= keywords=allOf"]);
                assert_eq!(calls, 2 * depth + 3);
            },
        );
    });
}

#[test]
fn intersects_at_every_level_of_a_nested_all_of() {
    // Each level meets what the levels below it read with a record of another field, so
    // a meet that compared the parts all the way down at each level would be quadratic.
    on_a_small_stack(|| {
        at_both_depths(
            |depth| {
                nested(
                    r#"{"allOf":[{"properties":{"x":"#,
                    r#"{"type":"string"}"#,
                    r#"}},{"properties":{"y":{"type":"string"}}}]}"#,
                    depth,
                )
            },
            "{x: {x: {x: string, y: string}, y: string}, y: string}",
            &[],
            13,
            |depth, ty, reports, calls| {
                let (levels, bottom) = record_depth(ty, "x");
                assert_eq!((levels, format_type(bottom, true)), (depth, "string".to_string()));
                assert!(reports.is_empty());
                assert_eq!(calls, 4 * depth + 1);
            },
        );
    });
}

/// Counts what is written and keeps none of it.
struct Counted(usize);

impl Write for Counted {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.0 += text.len();
        Ok(())
    }
}

#[test]
fn types_copies_compares_prints_and_releases_a_deep_field_map() {
    on_a_small_stack(|| {
        let mut map = PropertyMap::new();
        map.insert("a", FieldDeclaration::Type("int".into()));
        for _ in 0..DEPTH {
            let mut outer = PropertyMap::new();
            outer.insert("a", FieldDeclaration::Fields(map));
            map = outer;
        }
        let ty = field_map_type(&map, &|text| parse_type_expression(text, None)).expect("reads");
        let (levels, bottom) = record_depth(&ty, "a");
        assert_eq!((levels, format_type(bottom, true)), (DEPTH + 1, "int".to_string()));
        let declaration = FieldDeclaration::Fields(map);
        let copy = declaration.clone();
        assert_eq!(copy, declaration);
        let mut counted = Counted(0);
        write!(counted, "{declaration:?}").expect("prints");
        assert_eq!(counted.0, r#"Fields({"a": "#.len() * (DEPTH + 1) + r#"Type("int")"#.len() + "})".len() * (DEPTH + 1));
    });
}
