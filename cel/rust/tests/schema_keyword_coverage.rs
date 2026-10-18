//! The gate over the closed keyword list: every keyword that can move a type is either
//! read or reported, held in both directions — twin of `schema-keyword-coverage.test.ts`,
//! case for case, which passes on `@telorun/cel 0.118.0 at 63c81d00`.
//!
//! - A keyword on `TYPE_KEYWORDS_READ` must decide the type: its probe types differently
//!   from the same node without it, and is never reported.
//! - A keyword on the closed list and not on `TYPE_KEYWORDS_READ` is reported, with
//!   `keyword-not-read`, at the node that carries it.
//! - Every keyword on the closed list has a probe here.
//!
//! **The class this cannot reach**: a keyword that constrains a type and is on no list at
//! all reads as a node carrying nothing — `dyn`, unreported. Nothing in the engine knows
//! JSON Schema's vocabulary beyond the list, so the cost of a missing entry is pinned below
//! as a stated fact, and the list and the reader are held to each other here.

mod schema_support;

use std::sync::Arc;

use schema_support::json;
use telorun_cel::{
    format_type, schema_type, JsonSchemaDocument, JsonValue, SchemaConversion, UnjudgedReason, UnjudgedSchemaNode,
    TYPE_CONSTRAINING_KEYWORDS, TYPE_KEYWORDS_READ,
};
use telorun_cel_value::{compare_code_units, PropertyMap};

/// A node carrying exactly one of the keywords, and the document it is read in.
const PROBES: [(&str, &str, Option<&str>); 22] = [
    ("$dynamicRef", r##"{"$dynamicRef":"#shape"}"##, None),
    ("$recursiveRef", r##"{"$recursiveRef":"#"}"##, None),
    ("$ref", r##"{"$ref":"#/$defs/Shape"}"##, Some(r##"{"$ref":"#/$defs/Shape","$defs":{"Shape":{"type":"string"}}}"##)),
    ("additionalItems", r#"{"additionalItems":{"type":"string"}}"#, None),
    ("additionalProperties", r#"{"additionalProperties":{"type":"string"}}"#, None),
    ("allOf", r#"{"allOf":[{"type":"string"}]}"#, None),
    ("anyOf", r#"{"anyOf":[{"type":"string"}]}"#, None),
    ("const", r#"{"const":"fixed"}"#, None),
    ("dependentSchemas", r#"{"dependentSchemas":{"a":{"type":"string"}}}"#, None),
    ("else", r#"{"else":{"type":"string"}}"#, None),
    ("enum", r#"{"enum":["fixed"]}"#, None),
    ("if", r#"{"if":{"type":"string"}}"#, None),
    ("items", r#"{"items":{"type":"string"}}"#, None),
    ("not", r#"{"not":{"const":"fixed"}}"#, None),
    ("oneOf", r#"{"oneOf":[{"type":"string"}]}"#, None),
    ("patternProperties", r#"{"patternProperties":{"^a":{"type":"string"}}}"#, None),
    ("prefixItems", r#"{"prefixItems":[{"type":"string"}]}"#, None),
    ("properties", r#"{"properties":{"a":{"type":"string"}}}"#, None),
    ("then", r#"{"then":{"type":"string"}}"#, None),
    ("type", r#"{"type":"string"}"#, None),
    ("unevaluatedItems", r#"{"unevaluatedItems":{"type":"string"}}"#, None),
    ("unevaluatedProperties", r#"{"unevaluatedProperties":{"type":"string"}}"#, None),
];

fn probe(keyword: &str) -> JsonSchemaDocument {
    let (_, node, root) = PROBES.iter().find(|(name, _, _)| *name == keyword).expect("every keyword has a probe");
    JsonSchemaDocument { node: json(node), root: root.map(json) }
}

/// The same node without one keyword, so what that keyword decided is measurable.
fn strip(node: &JsonValue, keyword: &str) -> Arc<JsonValue> {
    let JsonValue::Object(entries) = node else { panic!("a probe is an object") };
    let rest: PropertyMap<Arc<JsonValue>> =
        entries.iter().filter(|(name, _)| *name != keyword).map(|(name, value)| (name, Arc::clone(value))).collect();
    Arc::new(JsonValue::Object(rest))
}

/// Sorted as JavaScript's default `sort` orders strings, each once.
fn sorted_distinct(names: &[&'static str]) -> Vec<&'static str> {
    let mut held = names.to_vec();
    held.sort_by(|left, right| compare_code_units(left, right));
    held.dedup();
    held
}

#[test]
fn is_sorted_holds_no_duplicate_and_has_the_read_ones_among_it() {
    assert_eq!(TYPE_CONSTRAINING_KEYWORDS, sorted_distinct(TYPE_CONSTRAINING_KEYWORDS));
    assert_eq!(TYPE_KEYWORDS_READ, sorted_distinct(TYPE_KEYWORDS_READ));
    for keyword in TYPE_KEYWORDS_READ {
        assert!(TYPE_CONSTRAINING_KEYWORDS.contains(keyword), "{keyword}");
    }
}

#[test]
fn has_a_probe_for_every_keyword_on_it_and_probes_nothing_that_is_not() {
    let probed: Vec<&'static str> = PROBES.iter().map(|(name, _, _)| *name).collect();
    assert_eq!(sorted_distinct(&probed), sorted_distinct(TYPE_CONSTRAINING_KEYWORDS));
    // An object's keys are distinct on Node; a probe listed twice is refused here.
    assert_eq!(probed.len(), TYPE_CONSTRAINING_KEYWORDS.len());
}

#[test]
fn reads_every_keyword_it_claims_to_read_and_that_keyword_decides_the_type() {
    for keyword in TYPE_KEYWORDS_READ {
        let probe = probe(keyword);
        let read = schema_type(&probe, &SchemaConversion::default()).expect("reads");
        let without = schema_type(
            &JsonSchemaDocument { node: strip(&probe.node, keyword), root: probe.root.clone() },
            &SchemaConversion::default(),
        )
        .expect("reads");
        assert_ne!(format_type(&read.ty, true), format_type(&without.ty, true), "{keyword}");
        let naming: Vec<&UnjudgedSchemaNode> =
            read.unjudged.iter().filter(|entry| entry.keywords.contains(keyword)).collect();
        assert!(naming.is_empty(), "{keyword}: {naming:?}");
    }
}

#[test]
fn reports_every_keyword_it_does_not_read_with_the_node_that_carries_it() {
    let unread: Vec<&'static str> =
        TYPE_CONSTRAINING_KEYWORDS.iter().copied().filter(|keyword| !TYPE_KEYWORDS_READ.contains(keyword)).collect();
    assert!(!unread.is_empty());
    for keyword in unread {
        let read = schema_type(&probe(keyword), &SchemaConversion::default()).expect("reads");
        assert_eq!(
            read.unjudged,
            [UnjudgedSchemaNode {
                pointer: String::new(),
                through_reference: None,
                keywords: vec![keyword],
                type_name: None,
                reason: UnjudgedReason::KeywordNotRead,
            }],
            "{keyword}"
        );
    }
}

#[test]
fn is_silent_about_a_keyword_on_no_list_the_stated_cost_of_an_entry_nobody_added() {
    let node = json(r#"{"someKeywordNobodyListed":{"type":"string"}}"#);
    let read = schema_type(&JsonSchemaDocument { node, root: None }, &SchemaConversion::default()).expect("reads");
    assert_eq!(format_type(&read.ty, true), "dyn");
    assert!(read.unjudged.is_empty());
    assert!(read.recursive.is_empty());
}
