//! The type model: printing, the two equalities, unions, assignability, unification and
//! the reporting helpers, as literal tables.
//!
//! No Node test file is the twin of this one: Node's tests reach these functions only
//! through `check`. Every row is the Node build's answer, executed:
//! `@telorun/cel 0.118.0 at 63c81d00`. What is this crate's own: `==` on a type (the
//! data equality, which Node does not have) and that a union of ten thousand distinct
//! branches is built in time that grows with the branches.

use std::sync::Arc;
use std::time::Instant;

use telorun_cel::{
    admits_null, assignable, format_type, is_numeric, list_of, map_of, parameter_of, parse_type_expression,
    types_equal, unify, union_of, without_null, without_parameters, CelType, NominalType, RecordType, TypeFields,
    DOUBLE, DYN, INT, NULL, STRING, UINT,
};

fn ty(text: &str) -> CelType {
    parse_type_expression(text, None).unwrap_or_else(|error| panic!("{text}: {error}"))
}

fn record(fields: &[(&str, CelType)], open: bool, name: Option<&str>) -> CelType {
    CelType::Record(RecordType {
        name: name.map(Into::into),
        fields: fields.iter().map(|(field, ty)| (*field, ty.clone())).collect(),
        open,
    })
}

fn nominal(name: &str, base: CelType, args: Vec<CelType>, fields: Option<TypeFields>) -> CelType {
    CelType::Nominal(NominalType { name: name.into(), base: Arc::new(base), args: args.into(), fields })
}

#[test]
fn prints_each_type_as_node_does() {
    // `(text, formatType(t), formatType(t, true))`.
    const NODE_PRINTED: [(&str, &str, &str); 22] = [
        ("dyn", "dyn", "dyn"),
        ("int", "int", "int"),
        ("uint", "uint", "uint"),
        ("double", "double", "double"),
        ("bool", "bool", "bool"),
        ("string", "string", "string"),
        ("bytes", "bytes", "bytes"),
        ("null", "null", "null"),
        ("null_type", "null", "null"),
        ("type", "type", "type"),
        ("timestamp", "google.protobuf.Timestamp", "google.protobuf.Timestamp"),
        ("duration", "google.protobuf.Duration", "google.protobuf.Duration"),
        ("google.protobuf.Timestamp", "google.protobuf.Timestamp", "google.protobuf.Timestamp"),
        ("google.protobuf.Duration", "google.protobuf.Duration", "google.protobuf.Duration"),
        ("list<int>", "list<int>", "list<int>"),
        ("list<dyn>", "list<dyn>", "list"),
        ("map<string, int>", "map<string, int>", "map<string, int>"),
        ("map<dyn, dyn>", "map<dyn, dyn>", "map"),
        ("map<dyn, int>", "map<dyn, int>", "map<dyn, int>"),
        ("optional<A>", "optional<A>", "optional<A>"),
        ("list<list<map<K, V>>>", "list<list<map<K, V>>>", "list<list<map<K, V>>>"),
        ("A", "A", "A"),
    ];
    for (text, printed, at_top) in NODE_PRINTED {
        assert_eq!(format_type(&ty(text), false), printed, "{text}");
        assert_eq!(format_type(&ty(text), true), at_top, "{text}");
    }
    // An unnamed record prints as `map`, so two of them print — and key — alike.
    assert_eq!(format_type(&record(&[("a", INT)], false, None), false), "map");
    assert_eq!(format_type(&record(&[], true, Some("Named")), false), "Named");
    assert_eq!(format_type(&nominal("Money", INT, vec![], None), false), "Money");
    assert_eq!(format_type(&nominal("Holder", DYN, vec![STRING, list_of(INT)], None), false), "Holder<string, list<int>>");
    assert_eq!(format_type(&union_of([INT, NULL, STRING]), false), "int|null|string");
    assert_eq!(format_type(&list_of(union_of([INT, NULL])), true), "list<int|null>");
}

#[test]
fn types_equal_is_nodes_equality_and_eq_is_the_data() {
    let ab = record(&[("a", INT), ("b", STRING)], false, None);
    let ba = record(&[("b", STRING), ("a", INT)], false, None);
    let with_fields = nominal("M", INT, vec![], Some([("x", INT)].into_iter().collect()));
    // `(left, right, typesEqual on Node, ==)`.
    let rows: [(CelType, CelType, bool, bool); 7] = [
        (ab.clone(), ba.clone(), true, false),
        (nominal("M", INT, vec![], None), nominal("M", STRING, vec![], None), true, false),
        (with_fields, nominal("M", INT, vec![], None), true, false),
        (record(&[("a", INT)], false, None), record(&[("a", INT)], true, None), false, false),
        (record(&[], false, Some("N")), record(&[], false, None), false, false),
        (union_of([INT, STRING]), union_of([STRING, INT]), false, false),
        (parameter_of("A"), parameter_of("B"), false, false),
    ];
    for (left, right, equal, same_data) in rows {
        assert_eq!(types_equal(&left, &right), equal, "{left:?} / {right:?}");
        assert_eq!(left == right, same_data, "{left:?} / {right:?}");
        assert!(left == left.clone() && types_equal(&left, &left));
    }
}

#[test]
fn builds_a_union_of_distinct_members_in_first_seen_order() {
    let ab = record(&[("a", INT), ("b", STRING)], false, None);
    let ba = record(&[("b", STRING), ("a", INT)], false, None);
    let rows: Vec<(Vec<CelType>, &str)> = vec![
        (vec![], "dyn"),
        (vec![INT], "int"),
        (vec![INT, INT], "int"),
        (vec![INT, DYN, STRING], "dyn"),
        (vec![INT, union_of([STRING, INT]), NULL], "int|string|null"),
        (vec![ab, ba], "map"),
        (vec![nominal("M", INT, vec![], None), nominal("M", STRING, vec![], None)], "M"),
        (vec![STRING, INT], "string|int"),
    ];
    for (members, printed) in rows {
        assert_eq!(format_type(&union_of(members.clone()), false), printed, "{members:?}");
    }
    // A member that is itself a union is flattened, not nested.
    let flattened = union_of([INT, union_of([STRING, NULL])]);
    let CelType::Union(union) = &flattened else { panic!("a union") };
    assert_eq!(union.members(), &[INT, STRING, NULL]);
}

#[test]
fn deduplicates_ten_thousand_distinct_records_in_linear_time() {
    let branch = |at: usize| record(&[(&format!("f{at}"), INT), ("shared", STRING)], false, None);
    let timed = |count: usize| {
        let members: Vec<CelType> = (0..count).map(branch).chain((0..count).map(branch)).collect();
        let started = Instant::now();
        let union = union_of(members);
        (started.elapsed(), union)
    };
    let (small, _) = timed(1_000);
    let (large, union) = timed(10_000);
    let CelType::Union(union) = &union else { panic!("a union") };
    assert_eq!(union.members().len(), 10_000);
    assert!(union.members().iter().enumerate().all(|(at, member)| types_equal(member, &branch(at))));
    // Ten times the members, far less than a hundred times the work.
    assert!(large < small * 40 + std::time::Duration::from_millis(50), "{small:?} then {large:?}");
}

#[test]
fn decides_assignability_as_node_does() {
    // `(from, to, assignable on Node)`.
    const NODE_ASSIGNABLE: [(&str, &str, bool); 13] = [
        ("int", "int", true),
        ("int", "double", false),
        ("int", "dyn", true),
        ("dyn", "int", true),
        ("A", "int", true),
        ("int", "A", true),
        ("list<int>", "list<dyn>", true),
        ("list<int>", "list<string>", false),
        ("map<string, int>", "map<string, dyn>", true),
        ("optional<int>", "optional<int>", true),
        ("int", "optional<int>", false),
        ("null", "int", false),
        ("string", "bytes", false),
    ];
    for (from, to, held) in NODE_ASSIGNABLE {
        assert_eq!(assignable(&ty(from), &ty(to)), held, "{from} -> {to}");
    }
    let ab = record(&[("a", INT), ("b", STRING)], false, None);
    let ba = record(&[("b", STRING), ("a", INT)], false, None);
    let rows: [(CelType, CelType, bool); 14] = [
        (union_of([INT, NULL]), INT, false),
        (union_of([INT, NULL]), union_of([NULL, STRING, INT]), true),
        (INT, union_of([NULL, INT]), true),
        (ab.clone(), map_of(STRING, DYN), true),
        (ab.clone(), map_of(STRING, INT), false),
        (record(&[("a", INT)], false, None), map_of(STRING, INT), true),
        (record(&[("a", INT)], true, None), map_of(STRING, INT), false),
        (record(&[("a", INT)], true, None), map_of(STRING, DYN), true),
        (record(&[("a", INT)], false, None), map_of(INT, INT), false),
        (ab, ba, true),
        (nominal("M", INT, vec![], None), INT, false),
        (INT, nominal("M", INT, vec![], None), false),
        (nominal("M", INT, vec![], None), nominal("M", STRING, vec![], None), true),
        (record(&[], false, None), map_of(STRING, INT), true),
    ];
    for (from, to, held) in rows {
        assert_eq!(assignable(&from, &to), held, "{from:?} -> {to:?}");
    }
}

#[test]
fn unifies_and_reports_as_node_does() {
    // `(left, right, formatType(unify(left, right)))`.
    const NODE_UNIFIED: [(&str, &str, &str); 10] = [
        ("int", "int", "int"),
        ("int", "string", "dyn"),
        ("A", "int", "int"),
        ("int", "B", "int"),
        ("list<A>", "list<int>", "list<int>"),
        ("list<int>", "list<string>", "list<dyn>"),
        ("map<A, int>", "map<string, B>", "map<string, int>"),
        ("optional<A>", "optional<int>", "optional<int>"),
        ("dyn", "int", "dyn"),
        ("list<list<A>>", "list<B>", "list<list<A>>"),
    ];
    for (left, right, unified) in NODE_UNIFIED {
        assert_eq!(format_type(&unify(&ty(left), &ty(right)), false), unified, "{left} / {right}");
    }
    // `(text, formatType(withoutParameters(t)))`.
    const NODE_REPORTED: [(&str, &str); 6] = [
        ("A", "dyn"),
        ("list<A>", "list<dyn>"),
        ("map<K, int>", "map<dyn, int>"),
        ("optional<A>", "optional<dyn>"),
        ("int", "int"),
        ("list<int>", "list<int>"),
    ];
    for (text, reported) in NODE_REPORTED {
        assert_eq!(format_type(&without_parameters(&ty(text)), false), reported, "{text}");
    }
    // A union is rebuilt through `union_of`, so two members that become one collapse.
    let collapsed = union_of([list_of(parameter_of("A")), list_of(parameter_of("B"))]);
    assert_eq!(format_type(&without_parameters(&collapsed), false), "list<dyn>");
    assert_eq!(format_type(&without_parameters(&union_of([parameter_of("A"), INT])), false), "dyn");
    let fields = without_parameters(&record(&[("x", parameter_of("T")), ("y", INT)], false, None));
    assert_eq!(fields, record(&[("x", DYN), ("y", INT)], false, None));
    let holder = nominal("H", list_of(parameter_of("A")), vec![parameter_of("A")], None);
    // A named type's arguments are reported; its base is left as declared.
    assert_eq!(without_parameters(&holder), nominal("H", list_of(parameter_of("A")), vec![DYN], None));
    assert_eq!(format_type(&without_parameters(&holder), false), "H<dyn>");
}

#[test]
fn answers_the_null_and_numeric_questions_as_node_does() {
    assert!(admits_null(&NULL));
    assert!(admits_null(&union_of([INT, NULL])));
    assert!(!admits_null(&INT));
    assert!(!admits_null(&DYN));
    assert_eq!(format_type(&without_null(&union_of([INT, NULL])), false), "int");
    assert_eq!(format_type(&without_null(&union_of([INT, NULL, STRING])), false), "int|string");
    assert_eq!(format_type(&without_null(&NULL), false), "null");
    assert_eq!(format_type(&without_null(&DYN), false), "dyn");
    assert_eq!([&INT, &UINT, &DOUBLE, &STRING, &DYN].map(is_numeric), [true, true, true, false, false]);
}

#[test]
fn keeps_a_field_set_again_in_its_first_place() {
    let mut fields = TypeFields::new();
    fields.insert("b", INT);
    fields.insert("a", STRING);
    assert_eq!(fields.insert("b", DOUBLE), Some(INT));
    assert_eq!(fields.iter().map(|(name, ty)| (name, format_type(ty, false))).collect::<Vec<_>>(), [
        ("b", "double".to_string()),
        ("a", "string".to_string())
    ]);
    // A shared set is copied before it is changed.
    let shared = fields.clone();
    fields.insert("c", INT);
    assert_eq!((shared.len(), fields.len()), (2, 3));
}
