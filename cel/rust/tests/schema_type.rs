//! Typing from JSON Schema: `schema_type` and `field_map_type` held to tables of Node's
//! answers — the type with every record written out, the type as printed, every node
//! that could not be judged, every recursive reference, and how often the host's
//! resolver was asked.
//!
//! No Node test file is the twin of this one: `json-schema-type.test.ts` reads every
//! answer through `check`, and arrives with the checker. Every expected value is the
//! Node build's answer, executed: `@telorun/cel 0.118.0 at 63c81d00`. What is this
//! crate's own: pointer identity where Node asserts `===`, and the tests named
//! `difference_…`, where this crate answers by its own rule and Node's answer is named
//! in the test.

mod schema_support;

use std::sync::{Arc, Mutex};

use schema_support::*;
use telorun_cel::{
    field_map_type, format_type, parse_type_expression, schema_type, CelType, CelTypeTextError, FieldDeclaration,
    JsonSchemaDocument, JsonValue, SchemaConversion, SchemaTypeAnswer, SchemaTypeResolver, UnjudgedReason,
    UnjudgedSchemaNode, UNJUDGED_REASONS,
};
use telorun_cel_value::PropertyMap;

#[test]
fn types_a_schema_as_node_does() {
    const NODE_ROWS: &[Row] = &[
        row("a scalar", "{\"type\":\"string\"}", &[], &[], "string", "string", &[], 1),
        row("an integer", "{\"type\":\"integer\"}", &[], &[], "int", "int", &[], 1),
        row("a number", "{\"type\":\"number\"}", &[], &[], "double", "double", &[], 1),
        row("a boolean", "{\"type\":\"boolean\"}", &[], &[], "bool", "bool", &[], 1),
        row("a null", "{\"type\":\"null\"}", &[], &[], "null", "null", &[], 1),
        row("an object with properties, closed", "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"},\"b\":{\"type\":\"integer\"}}}", &[], &[], "{a: string, b: int}", "map", &[], 3),
        row("properties beside additionalProperties true, open", "{\"properties\":{\"a\":{\"type\":\"string\"}},\"additionalProperties\":true}", &[], &[], "{a: string, ...}", "map", &[], 2),
        row("properties beside a typed additionalProperties, closed", "{\"properties\":{\"a\":{\"type\":\"string\"}},\"additionalProperties\":{\"type\":\"integer\"}}", &[], &[], "{a: string}", "map", &[], 3),
        row("an object of typed values", "{\"type\":\"object\",\"additionalProperties\":{\"type\":\"integer\"}}", &[], &[], "map<string, int>", "map<string, int>", &[], 2),
        row("an object that admits no field", "{\"type\":\"object\",\"additionalProperties\":false}", &[], &[], "{}", "map", &[], 1),
        row("an object that admits anything", "{\"type\":\"object\",\"additionalProperties\":true}", &[], &[], "map<string, dyn>", "map<string, dyn>", &[], 1),
        row("an object", "{\"type\":\"object\"}", &[], &[], "map<string, dyn>", "map<string, dyn>", &[], 1),
        row("an array of strings", "{\"type\":\"array\",\"items\":{\"type\":\"string\"}}", &[], &[], "list<string>", "list<string>", &[], 2),
        row("an array", "{\"type\":\"array\"}", &[], &[], "list<dyn>", "list", &[], 1),
        row("a tuple", "{\"type\":\"array\",\"items\":[{\"type\":\"string\"}]}", &[], &[], "list<dyn>", "list", &["shape-not-read pointer= keywords=items"], 1),
        row("items with no type", "{\"items\":{\"type\":\"integer\"}}", &[], &[], "list<int>", "list<int>", &[], 2),
        row("nested", "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"object\",\"properties\":{\"b\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"c\":{\"type\":\"boolean\"}}}}}}}}", &[], &[], "{a: {b: list<{c: bool}>}}", "map", &[], 5),
        row("a type list", "{\"type\":[\"string\",\"null\"]}", &[], &[], "string|null", "string|null", &[], 1),
        row("a type list over an object", "{\"type\":[\"string\",\"object\"],\"properties\":{\"a\":{\"type\":\"integer\"}}}", &[], &[], "string|{a: int}", "string|map", &[], 2),
        row("a type list naming one type twice", "{\"type\":[\"integer\",\"integer\"]}", &[], &[], "int", "int", &[], 1),
        row("anyOf", "{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}", &[], &[], "string|int", "string|int", &[], 3),
        row("oneOf with a duplicate", "{\"oneOf\":[{\"type\":\"integer\"},{\"type\":\"string\"},{\"type\":\"integer\"}]}", &[], &[], "int|string", "int|string", &[], 4),
        row("anyOf and oneOf together", "{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"integer\"}],\"oneOf\":[{\"type\":\"integer\"},{\"type\":\"boolean\"}]}", &[], &[], "int", "int", &[], 5),
        row("allOf merges records, the left's fields first", "{\"allOf\":[{\"properties\":{\"b\":{\"type\":\"string\"},\"a\":{\"type\":\"integer\"}}},{\"properties\":{\"c\":{\"type\":\"boolean\"},\"a\":{\"type\":\"integer\"}},\"additionalProperties\":true}]}", &[], &[], "{b: string, a: int, c: bool}", "map", &[], 7),
        row("allOf of two open records is open", "{\"allOf\":[{\"properties\":{\"a\":{}},\"additionalProperties\":true},{\"properties\":{\"b\":{}},\"additionalProperties\":true}]}", &[], &[], "{a: dyn, b: dyn, ...}", "map", &[], 5),
        row("allOf narrows a field", "{\"allOf\":[{\"properties\":{\"a\":{}}},{\"properties\":{\"a\":{\"type\":\"string\"}}}]}", &[], &[], "{a: string}", "map", &[], 5),
        row("allOf whose halves disagree on a field", "{\"allOf\":[{\"properties\":{\"a\":{\"type\":\"integer\"}}},{\"properties\":{\"a\":{\"type\":\"string\"}}}]}", &[], &[], "dyn", "dyn", &["intersection-empty pointer= keywords=allOf"], 5),
        row("allOf of two scalars", "{\"allOf\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}", &[], &[], "dyn", "dyn", &["intersection-empty pointer= keywords=allOf"], 3),
        row("allOf of three, the third empty against the met two", "{\"allOf\":[{\"type\":[\"string\",\"integer\"]},{\"type\":[\"integer\",\"null\"]},{\"type\":\"string\"}]}", &[], &[], "dyn", "dyn", &["intersection-empty pointer= keywords=allOf"], 4),
        row("type beside anyOf", "{\"type\":\"string\",\"anyOf\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}", &[], &[], "string", "string", &[], 3),
        row("unions meet member by member", "{\"allOf\":[{\"type\":[\"string\",\"integer\",\"null\"]},{\"type\":[\"integer\",\"null\",\"boolean\"]}]}", &[], &[], "int|null", "int|null", &[], 3),
        row("a record meets a map of its values", "{\"allOf\":[{\"properties\":{\"a\":{\"type\":\"string\"}}},{\"additionalProperties\":{\"type\":\"string\"}}]}", &[], &[], "{a: string}", "map", &[], 5),
        row("a map meets a record", "{\"allOf\":[{\"additionalProperties\":{\"type\":\"string\"}},{\"properties\":{\"a\":{},\"b\":{\"type\":\"string\"}}}]}", &[], &[], "{a: string, b: string}", "map", &[], 6),
        row("a record whose field no map value admits", "{\"allOf\":[{\"properties\":{\"a\":{\"type\":\"integer\"}}},{\"additionalProperties\":{\"type\":\"string\"}}]}", &[], &[], "dyn", "dyn", &["intersection-empty pointer= keywords=allOf"], 5),
        row("two maps meet", "{\"allOf\":[{\"additionalProperties\":{}},{\"additionalProperties\":{\"type\":\"integer\"}}]}", &[], &[], "map<string, int>", "map<string, int>", &[], 5),
        row("two lists meet", "{\"allOf\":[{\"type\":\"array\"},{\"items\":{\"type\":\"string\"}}]}", &[], &[], "list<string>", "list<string>", &[], 4),
        row("two lists that cannot meet", "{\"allOf\":[{\"items\":{\"type\":\"integer\"}},{\"items\":{\"type\":\"string\"}}]}", &[], &[], "dyn", "dyn", &["intersection-empty pointer= keywords=allOf"], 5),
        row("an object meets a record", "{\"allOf\":[{\"type\":\"object\"},{\"properties\":{\"a\":{\"type\":\"string\"}}}]}", &[], &[], "{a: string}", "map", &[], 4),
        row("type beside a constant reads the type", "{\"type\":\"integer\",\"const\":5}", &[], &[], "int", "int", &[], 1),
        row("a string constant", "{\"const\":\"x\"}", &[], &[], "string", "string", &[], 1),
        row("an integral constant", "{\"const\":1}", &[], &[], "int", "int", &[], 1),
        row("a constant written 1.0", "{\"const\":1.0}", &[], &[], "int", "int", &[], 1),
        row("a fractional constant", "{\"const\":1.5}", &[], &[], "double", "double", &[], 1),
        row("a constant of 1e400", "{\"const\":1e400}", &[], &[], "double", "double", &[], 1),
        row("a null constant", "{\"const\":null}", &[], &[], "null", "null", &[], 1),
        row("a boolean constant", "{\"const\":true}", &[], &[], "bool", "bool", &[], 1),
        row("a list constant", "{\"const\":[1]}", &[], &[], "list<dyn>", "list", &[], 1),
        row("an object constant", "{\"const\":{\"a\":1}}", &[], &[], "map<string, dyn>", "map<string, dyn>", &[], 1),
        row("an enum", "{\"enum\":[\"a\",1,null]}", &[], &[], "string|int|null", "string|int|null", &[], 1),
        row("an enum of numbers", "{\"enum\":[1,2.5,3]}", &[], &[], "int|double", "int|double", &[], 1),
        row("an enum beside a type", "{\"type\":\"string\",\"enum\":[1]}", &[], &[], "string", "string", &[], 1),
        row("a local reference", "{\"$ref\":\"#/$defs/S\",\"$defs\":{\"S\":{\"type\":\"string\"}}}", &[], &[], "string", "string", &[], 2),
        row("a reference beside properties", "{\"$defs\":{\"Base\":{\"properties\":{\"a\":{\"type\":\"string\"}}}},\"$ref\":\"#/$defs/Base\",\"properties\":{\"b\":{\"type\":\"integer\"}}}", &[], &[], "{a: string, b: int}", "map", &[], 4),
        row("a reference beside a type that excludes it", "{\"$defs\":{\"S\":{\"type\":\"string\"}},\"$ref\":\"#/$defs/S\",\"type\":\"integer\"}", &[], &[], "dyn", "dyn", &["intersection-empty pointer= keywords=$ref,type"], 2),
        row("a reference that leaves the document", "{\"$ref\":\"other.json#/x\"}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer naming nothing", "{\"$ref\":\"#/$defs/Missing\"}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("an anchor", "{\"$ref\":\"#shape\"}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer to a scalar", "{\"$ref\":\"#/$defs/n\",\"$defs\":{\"n\":5}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer through a scalar", "{\"$ref\":\"#/$defs/s/x\",\"$defs\":{\"s\":\"text\"}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer through null", "{\"$ref\":\"#/$defs/n/x\",\"$defs\":{\"n\":null}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer to an array", "{\"$ref\":\"#/$defs/list\",\"$defs\":{\"list\":[{\"type\":\"string\"}]}}", &[], &[], "dyn", "dyn", &[], 2),
        row("a pointer escaping its segment", "{\"$ref\":\"#/$defs/a~1b~0c\",\"$defs\":{\"a/b~c\":{\"type\":\"integer\"}}}", &[], &[], "int", "int", &[], 2),
        row("a pointer whose escapes do not chain", "{\"$ref\":\"#/$defs/~01\",\"$defs\":{\"~1\":{\"type\":\"integer\"},\"/\":{\"type\":\"string\"}}}", &[], &[], "int", "int", &[], 2),
        row("a reference to the root, recursively", "{\"properties\":{\"self\":{\"$ref\":\"#\"}}}", &[], &[], "{self: dyn}", "map", &["recursive pointer= reference=#"], 2),
        row("a reference to the root from the root", "{\"$ref\":\"#\"}", &[], &[], "dyn", "dyn", &["recursive pointer= reference=#"], 1),
        row("mutual recursion", "{\"$ref\":\"#/$defs/A\",\"$defs\":{\"A\":{\"properties\":{\"b\":{\"$ref\":\"#/$defs/B\"}}},\"B\":{\"properties\":{\"a\":{\"$ref\":\"#/$defs/A\"}}}}}", &[], &[], "{b: {a: dyn}}", "map", &["recursive pointer=/$defs/A reference=#/$defs/A"], 5),
        row("recursion through items", "{\"$defs\":{\"T\":{\"type\":\"array\",\"items\":{\"$ref\":\"#/$defs/T\"}}},\"$ref\":\"#/$defs/T\"}", &[], &[], "list<dyn>", "list", &["recursive pointer=/$defs/T reference=#/$defs/T"], 3),
        row("a node reached twice is read once", "{\"properties\":{\"a\":{\"$ref\":\"#/$defs/S\"},\"b\":{\"$ref\":\"#/$defs/S\"}},\"$defs\":{\"S\":{\"type\":\"string\",\"not\":{}}}}", &[], &[], "{a: string, b: string}", "map", &["keyword-not-read pointer=/$defs/S keywords=not"], 4),
        row("a pointer names the document, not the node", "{\"type\":\"object\",\"properties\":{\"a\":{\"$ref\":\"#\"}}}", &["properties", "a"], &[], "{a: dyn}", "map", &["recursive pointer=/properties/a"], 2),
        row("a node of a document", "{\"$defs\":{\"S\":{\"type\":\"boolean\",\"if\":{}}},\"properties\":{\"a\":{\"$ref\":\"#/$defs/S\"}}}", &["properties", "a"], &[], "bool", "bool", &["keyword-not-read pointer=/$defs/S keywords=if"], 2),
        row("unread keywords before the children, an empty intersection after", "{\"if\":{},\"allOf\":[{\"type\":\"string\",\"not\":{}},{\"type\":\"integer\"}]}", &[], &[], "dyn", "dyn", &["keyword-not-read pointer= keywords=if", "keyword-not-read pointer=/allOf/0 keywords=not", "intersection-empty pointer= keywords=allOf"], 3),
        row("every unread keyword in the list's order", "{\"then\":{},\"if\":{},\"else\":{}}", &[], &[], "dyn", "dyn", &["keyword-not-read pointer= keywords=else,if,then"], 1),
        row("each unread keyword", "{\"$dynamicRef\":\"#a\",\"$recursiveRef\":\"#\",\"additionalItems\":{},\"dependentSchemas\":{},\"not\":{},\"patternProperties\":{},\"prefixItems\":[],\"unevaluatedItems\":{},\"unevaluatedProperties\":{},\"if\":{},\"then\":{},\"else\":{}}", &[], &[], "dyn", "dyn", &["keyword-not-read pointer= keywords=$dynamicRef,$recursiveRef,additionalItems,dependentSchemas,else,if,not,patternProperties,prefixItems,then,unevaluatedItems,unevaluatedProperties"], 1),
        row("a type naming no JSON type", "{\"type\":\"strng\"}", &[], &[], "dyn", "dyn", &["shape-not-read pointer= keywords=type"], 1),
        row("a type list naming two that are none", "{\"type\":[\"string\",\"nope\",\"nope2\"]}", &[], &[], "dyn", "dyn", &["shape-not-read pointer= keywords=type", "shape-not-read pointer= keywords=type"], 1),
        row("a type list holding a number", "{\"type\":[\"string\",5]}", &[], &[], "dyn", "dyn", &["shape-not-read pointer= keywords=type"], 1),
        row("a type list of two numbers", "{\"type\":[5,6]}", &[], &[], "dyn", "dyn", &["shape-not-read pointer= keywords=type", "shape-not-read pointer= keywords=type"], 1),
        row("a number in a type list beside properties", "{\"type\":[5],\"properties\":{\"a\":{\"type\":\"string\"}}}", &[], &[], "dyn", "dyn", &["shape-not-read pointer= keywords=type"], 1),
        row("a number in a type list reports after a child's", "{\"allOf\":[{\"if\":{}}],\"type\":[5]}", &[], &[], "dyn", "dyn", &["keyword-not-read pointer=/allOf/0 keywords=if", "shape-not-read pointer= keywords=type"], 2),
        row("an object type list reading the tuple twice", "{\"type\":[\"array\",\"array\"],\"items\":[{}]}", &[], &[], "list<dyn>", "list", &["shape-not-read pointer= keywords=items", "shape-not-read pointer= keywords=items"], 1),
        row("a property named with a slash and a tilde", "{\"properties\":{\"a/b~c\":{\"if\":{}}}}", &[], &[], "{a/b~c: dyn}", "map", &["keyword-not-read pointer=/properties/a~1b~0c keywords=if"], 2),
        row("field order is the object's own", "{\"properties\":{\"b\":{},\"10\":{},\"a\":{},\"2\":{}}}", &[], &[], "{2: dyn, 10: dyn, b: dyn, a: dyn}", "map", &[], 5),
        row("the additional schema is read beside properties", "{\"properties\":{\"a\":{}},\"additionalProperties\":{\"type\":\"string\",\"if\":{}}}", &[], &[], "{a: dyn}", "map", &["keyword-not-read pointer=/additionalProperties keywords=if"], 3),
        row("a resolver names a type", "{\"brand\":\"Money\",\"type\":\"integer\"}", &[], &[], "Money", "Money", &[], 1),
        row("a resolver names a type with arguments", "{\"brand\":\"Pair\",\"args\":[\"int\",\"list<string>\"]}", &[], &[], "Pair<int, list<string>>", "Pair<int, list<string>>", &[], 1),
        row("a resolver names a type nothing registers", "{\"brand\":\"Nope\",\"type\":\"integer\",\"if\":{}}", &[], &[], "int", "int", &["named-type-unregistered pointer= keywords= type=Nope", "keyword-not-read pointer= keywords=if"], 1),
        row("a named type skips the node's own keywords", "{\"brand\":\"Money\",\"if\":{}}", &[], &[], "Money", "Money", &[], 1),
        row("a document crossing", "{\"properties\":{\"a\":{\"$ref\":\"ext:a\"}}}", &[], &[doc("ext:a", "{\"properties\":{\"x\":{\"if\":{}}}}", &[])], "{a: {x: dyn}}", "map", &["keyword-not-read pointer=/properties/x through=/properties/a keywords=if"], 4),
        row("a crossing skips the referring node's keywords", "{\"properties\":{\"a\":{\"$ref\":\"ext:a\",\"if\":{}}}}", &[], &[doc("ext:a", "{\"type\":\"string\"}", &[])], "{a: string}", "map", &[], 3),
        row("the first crossing is kept", "{\"properties\":{\"a\":{\"$ref\":\"ext:a\"}}}", &[], &[doc("ext:a", "{\"properties\":{\"b\":{\"$ref\":\"ext:b\"}}}", &[]), doc("ext:b", "{\"properties\":{\"c\":{\"not\":{}}}}", &[])], "{a: {b: {c: dyn}}}", "map", &["keyword-not-read pointer=/properties/c through=/properties/a keywords=not"], 6),
        row("a crossing into a node of a document", "{\"properties\":{\"a\":{\"$ref\":\"ext:c\"}}}", &[], &[doc("ext:c", "{\"$defs\":{\"C\":{\"$ref\":\"#/$defs/D\"},\"D\":{\"type\":\"string\",\"not\":{}}}}", &["$defs", "C"])], "{a: string}", "map", &["keyword-not-read pointer=/$defs/D through=/properties/a keywords=not"], 4),
        row("a recursive crossing", "{\"properties\":{\"a\":{\"$ref\":\"ext:r\"}}}", &[], &[doc("ext:r", "{\"properties\":{\"again\":{\"$ref\":\"ext:r\"}}}", &[])], "{a: {again: dyn}}", "map", &["recursive pointer= through=/properties/a"], 4),
        row("a crossing reached twice is read once", "{\"properties\":{\"a\":{\"$ref\":\"ext:s\"},\"b\":{\"$ref\":\"ext:s\"}}}", &[], &[doc("ext:s", "{\"type\":\"string\",\"not\":{}}", &[])], "{a: string, b: string}", "map", &["keyword-not-read pointer= through=/properties/a keywords=not"], 4),
        row("a crossing into the document's own node reads it under a second root", "{\"$defs\":{\"S\":{\"type\":\"string\",\"not\":{}}},\"properties\":{\"a\":{\"$ref\":\"ext:own\"},\"b\":{\"$ref\":\"#/$defs/S\"}}}", &[], &[doc_in_main("ext:own", &["$defs", "S"], true)], "{a: string, b: string}", "map", &["keyword-not-read pointer= through=/properties/a keywords=not", "keyword-not-read pointer=/$defs/S keywords=not"], 5),
        row("a crossing into the document's own node under its root is the same read", "{\"$defs\":{\"S\":{\"type\":\"string\",\"not\":{}}},\"properties\":{\"a\":{\"$ref\":\"ext:same\"},\"b\":{\"$ref\":\"#/$defs/S\"}}}", &[], &[doc_in_main("ext:same", &["$defs", "S"], false)], "{a: string, b: string}", "map", &["keyword-not-read pointer= through=/properties/a keywords=not"], 4),
        row("the resolver is asked about an array", "{\"properties\":{\"a\":{\"$ref\":\"#/$defs/list\"}},\"$defs\":{\"list\":[]}}", &[], &[], "{a: dyn}", "map", &[], 3),
        row("a node that is no object", "true", &[], &[], "dyn", "dyn", &[], 0),
        row("a property that is no object", "{\"properties\":{\"a\":true,\"b\":5}}", &[], &[], "{a: dyn, b: dyn}", "map", &[], 1),
        row("a branch that is no object", "{\"allOf\":[true,{\"type\":\"string\"}]}", &[], &[], "string", "string", &[], 2),
        row("additionalProperties holding a number", "{\"additionalProperties\":5}", &[], &[], "map<string, dyn>", "map<string, dyn>", &[], 1),
        row("additionalProperties holding null", "{\"additionalProperties\":null}", &[], &[], "map<string, dyn>", "map<string, dyn>", &[], 1),
        row("additionalProperties holding a list", "{\"additionalProperties\":[]}", &[], &[], "map<string, dyn>", "map<string, dyn>", &[], 2),
        row("items holding true", "{\"items\":true}", &[], &[], "list<dyn>", "list", &[], 1),
        row("items holding false", "{\"items\":false}", &[], &[], "list<dyn>", "list", &[], 1),
        row("items holding null", "{\"items\":null}", &[], &[], "list<dyn>", "list", &[], 1),
        row("items holding a number", "{\"items\":5}", &[], &[], "list<dyn>", "list", &[], 1),
        row("an empty node", "{}", &[], &[], "dyn", "dyn", &[], 1),
        row("a keyword on no list", "{\"someKeywordNobodyListed\":{\"type\":\"string\"}}", &[], &[], "dyn", "dyn", &[], 1),
        row("a value keyword", "{\"type\":\"string\",\"nullable\":true,\"required\":[\"x\"],\"pattern\":\"^a\"}", &[], &[], "string", "string", &[], 1),
        row("a pointer to an array's __proto__", "{\"$ref\":\"#/$defs/list/__proto__\",\"$defs\":{\"list\":[]}}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer to constructor", "{\"$ref\":\"#/constructor\"}", &[], &[], "dyn", "dyn", &["reference-unresolved pointer= keywords=$ref"], 1),
        row("a pointer to an own __proto__", "{\"$ref\":\"#/$defs/__proto__\",\"$defs\":{\"__proto__\":{\"type\":\"string\"}}}", &[], &[], "string", "string", &[], 2),
    ];
    assert_rows(NODE_ROWS);
}

#[test]
fn names_each_reason_as_node_spells_it() {
    let spelled: Vec<&str> = UNJUDGED_REASONS.iter().map(|reason| reason.as_str()).collect();
    assert_eq!(
        spelled,
        ["keyword-not-read", "shape-not-read", "reference-unresolved", "intersection-empty", "named-type-unregistered"]
    );
}

/// An object of the entries given, each value shared as given.
fn object(entries: Vec<(&str, Arc<JsonValue>)>) -> Arc<JsonValue> {
    Arc::new(JsonValue::Object(entries.into_iter().collect::<PropertyMap<_>>()))
}

#[test]
fn reads_a_node_two_places_share_once() {
    // Node: one object at `properties.a` and at `properties.b.items`.
    let shared = json(r#"{"type":"string","not":{}}"#);
    let node = object(vec![(
        "properties",
        object(vec![("a", Arc::clone(&shared)), ("b", object(vec![("items", Arc::clone(&shared))]))]),
    )]);
    let result = schema_type(&JsonSchemaDocument { node, root: None }, &SchemaConversion::default()).expect("reads");
    assert_eq!(described(&result.ty), "{a: string, b: list<string>}");
    assert_eq!(report_lines(&result), ["keyword-not-read pointer=/properties/a keywords=not"]);
}

#[test]
fn reads_a_node_that_holds_itself_as_a_recursive_reference() {
    // Node: an object whose `properties.next` is the object itself. A `JsonValue` cannot
    // hold itself, so the same answer is asked of a node reached again through a
    // document crossing, the one way a host hands an `Arc` back.
    let node = json(r#"{"properties":{"next":{"$ref":"ext:self"}}}"#);
    let again = JsonSchemaDocument { node: Arc::clone(&node), root: None };
    let resolve: SchemaTypeResolver = Arc::new(move |document: &JsonSchemaDocument| {
        let JsonValue::Object(entries) = &*document.node else { return None };
        entries.get("$ref").map(|_| SchemaTypeAnswer::Document(again.clone()))
    });
    let conversion = SchemaConversion { resolve_schema_type: Some(resolve), lookup_named_type: None };
    let result = schema_type(&JsonSchemaDocument { node, root: None }, &conversion).expect("reads");
    assert_eq!(described(&result.ty), "{next: dyn}");
    assert_eq!(report_lines(&result), ["recursive pointer= through=/properties/next"]);
}

#[test]
fn hands_the_resolver_the_node_it_holds_with_its_document() {
    // Node: the node itself, then `$defs.S`, each with the document it belongs to; a node
    // standing as its own document is handed over as its own root.
    let root = json(r##"{"$defs":{"S":{"type":"string"}},"properties":{"a":{"$ref":"#/$defs/S"}}}"##);
    let node = walk(&root, &["properties", "a"]);
    let target = walk(&root, &["$defs", "S"]);
    let seen: Arc<Mutex<Vec<JsonSchemaDocument>>> = Arc::default();
    let held = Arc::clone(&seen);
    let resolve: SchemaTypeResolver = Arc::new(move |document: &JsonSchemaDocument| {
        held.lock().expect("unpoisoned").push(document.clone());
        None
    });
    let conversion = SchemaConversion { resolve_schema_type: Some(resolve.clone()), lookup_named_type: None };
    schema_type(&JsonSchemaDocument { node: Arc::clone(&node), root: Some(Arc::clone(&root)) }, &conversion).expect("reads");
    let asked = std::mem::take(&mut *seen.lock().expect("unpoisoned"));
    assert_eq!(asked.len(), 2);
    assert!(Arc::ptr_eq(&asked[0].node, &node) && Arc::ptr_eq(&asked[1].node, &target));
    assert!(asked.iter().all(|document| document.root.as_ref().is_some_and(|held| Arc::ptr_eq(held, &root))));

    let alone = json(r#"{"type":"string"}"#);
    schema_type(&JsonSchemaDocument { node: Arc::clone(&alone), root: None }, &conversion).expect("reads");
    let asked = std::mem::take(&mut *seen.lock().expect("unpoisoned"));
    assert_eq!(asked.len(), 1);
    assert!(Arc::ptr_eq(&asked[0].node, &alone));
    assert!(asked[0].root.as_ref().is_some_and(|held| Arc::ptr_eq(held, &alone)));
}

#[test]
fn reports_a_named_type_with_no_lookup_as_unregistered() {
    let resolve: SchemaTypeResolver = Arc::new(|document: &JsonSchemaDocument| match &*document.node {
        JsonValue::Object(entries) if entries.contains_key("brand") => {
            Some(SchemaTypeAnswer::Named { name: "Money".into(), args: Vec::new() })
        }
        _ => None,
    });
    let conversion = SchemaConversion { resolve_schema_type: Some(resolve), lookup_named_type: None };
    let node = json(r#"{"brand":"Money","type":"integer"}"#);
    let result = schema_type(&JsonSchemaDocument { node, root: None }, &conversion).expect("reads");
    assert_eq!(format_type(&result.ty, true), "int");
    assert_eq!(report_lines(&result), ["named-type-unregistered pointer= keywords= type=Money"]);
    assert_eq!(
        result.unjudged[0],
        UnjudgedSchemaNode {
            pointer: String::new(),
            through_reference: None,
            keywords: Vec::new(),
            type_name: Some("Money".into()),
            reason: UnjudgedReason::NamedTypeUnregistered,
        }
    );
}

#[test]
fn reads_with_no_host_at_all() {
    let node = json(r#"{"$ref":"ext:a","properties":{"a":{"type":"string"}}}"#);
    let result = schema_type(&JsonSchemaDocument { node, root: None }, &SchemaConversion::default()).expect("reads");
    assert_eq!(described(&result.ty), "{a: string}");
    assert_eq!(report_lines(&result), ["reference-unresolved pointer= keywords=$ref"]);
}

#[test]
fn fails_where_the_named_type_lookup_fails() {
    // `(the type arguments the resolver answers for Pair, the class and text Node throws)`.
    const NODE_REFUSED: [(&str, &str, &str); 2] = [
        ("list<", "CelTypeExpressionError", "\"list<\" names no type at offset 5"),
        ("Nope", "CelUnknownTypeNameError", "no type is registered under the name \"Nope\""),
    ];
    for (argument, class, message) in NODE_REFUSED {
        let root = format!(r#"{{"brand":"Pair","args":["{argument}"]}}"#);
        let (result, _) = read_schema(Box::leak(root.into_boxed_str()), &[], &[]);
        let error = result.expect_err("refused");
        let named = match &error {
            CelTypeTextError::Expression(_) => "CelTypeExpressionError",
            CelTypeTextError::UnknownName(_) => "CelUnknownTypeNameError",
            CelTypeTextError::Registration(_) => "CelTypeRegistrationError",
        };
        assert_eq!((named, error.to_string().as_str()), (class, message), "{argument}");
    }
}

fn fields(entries: Vec<(&str, FieldDeclaration)>) -> PropertyMap<FieldDeclaration> {
    entries.into_iter().collect()
}

#[test]
fn types_a_field_map_as_node_does() {
    let read = |text: &str| parse_type_expression(text, None);
    let map = fields(vec![
        ("b", "int".into()),
        ("10", "string".into()),
        ("a", FieldDeclaration::Fields(fields(vec![("y", "list<int>".into()), ("x", "map<string, bool>".into())]))),
        ("2", FieldDeclaration::Fields(PropertyMap::new())),
    ]);
    let ty = field_map_type(&map, &read).expect("reads");
    assert_eq!(described(&ty), "{2: {}, 10: string, b: int, a: {y: list<int>, x: map<string, bool>}}");
    assert_eq!(format_type(&ty, true), "map");
    let CelType::Record(record) = &ty else { panic!("a record") };
    assert!(!record.open && record.name.is_none());
    assert_eq!(described(&field_map_type(&PropertyMap::new(), &read).expect("reads")), "{}");

    // `(the field map, the class and text Node throws)`.
    let deep = fields(vec![(
        "a",
        FieldDeclaration::Fields(fields(vec![("b", FieldDeclaration::Fields(fields(vec![("c", "list<".into())])))])),
    )]);
    let error = field_map_type(&deep, &read).expect_err("refused");
    assert!(matches!(error, CelTypeTextError::Expression(_)));
    assert_eq!(error.to_string(), "\"list<\" names no type at offset 5");
    let unknown = fields(vec![("a", "int".into()), ("b", "Nope".into())]);
    let error = field_map_type(&unknown, &read).expect_err("refused");
    assert!(matches!(error, CelTypeTextError::UnknownName(_)));
    assert_eq!(error.to_string(), "no type is registered under the name \"Nope\"");
}

#[test]
fn copies_and_compares_a_field_map_as_data() {
    let map = FieldDeclaration::Fields(fields(vec![
        ("a", "int".into()),
        ("b", FieldDeclaration::Fields(fields(vec![("c", "string".into())]))),
    ]));
    let copy = map.clone();
    assert_eq!(copy, map);
    let reordered = FieldDeclaration::Fields(fields(vec![
        ("b", FieldDeclaration::Fields(fields(vec![("c", "string".into())]))),
        ("a", "int".into()),
    ]));
    assert_eq!(reordered, map);
    assert_ne!(FieldDeclaration::Fields(fields(vec![("a", "uint".into())])), FieldDeclaration::Fields(fields(vec![("a", "int".into())])));
    assert_eq!(format!("{map:?}"), r#"Fields({"a": Type("int"), "b": Fields({"c": Type("string")})})"#);
}

/// `(schema, the type written out, every report)` under no host.
fn assert_answers(rows: &[(&str, &str, &[&str])]) {
    for (schema, expected, reports) in rows {
        let result =
            schema_type(&JsonSchemaDocument { node: json(schema), root: None }, &SchemaConversion::default()).expect("reads");
        assert_eq!(described(&result.ty), *expected, "{schema}");
        assert_eq!(report_lines(&result), *reports, "{schema}");
    }
}

#[test]
fn difference_a_type_named_on_the_object_prototype_is_a_type_naming_no_json_type() {
    // Node reads the name as a property of a plain object: `type: "constructor"`,
    // `"toString"` and `"__proto__"` each type the node as that property — a function, or
    // the prototype itself — where a type should be, and report nothing.
    assert_answers(&[
        (r#"{"type":"constructor"}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":"toString"}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":"__proto__"}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":["string","hasOwnProperty"]}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
    ]);
}

#[test]
fn difference_a_pointer_to_the_object_prototype_names_nothing() {
    // Node reaches `Object.prototype` through `#/__proto__` and reads it as a node: `dyn`,
    // nothing reported.
    assert_answers(&[(r##"{"$ref":"#/__proto__"}"##, "dyn", &["reference-unresolved pointer= keywords=$ref"])]);
}

#[test]
fn difference_a_read_keyword_of_a_json_type_its_shape_excludes_is_read_as_absent() {
    // Node's answer for each, in order: `type` — ignored for a number, null or an object
    // (`dyn`, `{a: string}`, `list<string>`, `dyn`), a listed list coerced to its text
    // (`string`), a listed null to the `null` type (`null`), nothing reported for either;
    // `properties` — a string read as its characters (`{0: dyn}`, beside an object type
    // too), a number as no field (`{}`), a list as its indices (`{0: string}`), null
    // ignored (`dyn`); `allOf` of a string throws a `TypeError`, of an object is ignored;
    // `anyOf` and `oneOf` throw for an object and a number, and ignore null; `enum` throws
    // for a string and ignores a number; `$ref` is ignored (`dyn`, `string`); the
    // several-at-once row throws, and the child's row answers `{a: dyn}`. No row but the
    // listed number reports anything.
    assert_answers(&[
        (r#"{"type":5}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":5,"properties":{"a":{"type":"string"}}}"#, "{a: string}", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":null,"items":{"type":"string"}}"#, "list<string>", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":{}}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":[["string"]]}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"type":[null]}"#, "dyn", &["shape-not-read pointer= keywords=type"]),
        (r#"{"properties":"x"}"#, "dyn", &["shape-not-read pointer= keywords=properties"]),
        (r#"{"properties":5}"#, "dyn", &["shape-not-read pointer= keywords=properties"]),
        (r#"{"properties":[{"type":"string"}]}"#, "dyn", &["shape-not-read pointer= keywords=properties"]),
        (r#"{"properties":null}"#, "dyn", &["shape-not-read pointer= keywords=properties"]),
        (r#"{"type":"object","properties":"x"}"#, "map<string, dyn>", &["shape-not-read pointer= keywords=properties"]),
        (r#"{"allOf":"ab"}"#, "dyn", &["shape-not-read pointer= keywords=allOf"]),
        (r#"{"allOf":{"type":"string"}}"#, "dyn", &["shape-not-read pointer= keywords=allOf"]),
        (r#"{"anyOf":{}}"#, "dyn", &["shape-not-read pointer= keywords=anyOf"]),
        (r#"{"oneOf":5}"#, "dyn", &["shape-not-read pointer= keywords=oneOf"]),
        (r#"{"anyOf":null}"#, "dyn", &["shape-not-read pointer= keywords=anyOf"]),
        (r#"{"enum":"ab"}"#, "dyn", &["shape-not-read pointer= keywords=enum"]),
        (r#"{"enum":5}"#, "dyn", &["shape-not-read pointer= keywords=enum"]),
        (r#"{"$ref":5}"#, "dyn", &["shape-not-read pointer= keywords=$ref"]),
        (r#"{"$ref":null,"type":"string"}"#, "string", &["shape-not-read pointer= keywords=$ref"]),
        (
            r#"{"type":5,"allOf":"x","$ref":1,"if":{}}"#,
            "dyn",
            &["keyword-not-read pointer= keywords=if", "shape-not-read pointer= keywords=$ref,allOf,type"],
        ),
        (r#"{"properties":{"a":{"enum":1}}}"#, "{a: dyn}", &["shape-not-read pointer=/properties/a keywords=enum"]),
    ]);
}

#[test]
fn difference_a_mis_shaped_keyword_node_never_consults_is_still_reported() {
    // Node answers `string` for the first, reporting nothing: it reads `type` and never
    // looks at `enum`. For the second it throws a `TypeError` on `allOf`. Here the
    // keyword-level report comes before the node's children, and the element-level one
    // when the type names are read: two reports at one pointer.
    assert_answers(&[
        (r#"{"type":"string","enum":"x"}"#, "string", &["shape-not-read pointer= keywords=enum"]),
        (
            r#"{"type":[5],"allOf":"x"}"#,
            "dyn",
            &["shape-not-read pointer= keywords=allOf", "shape-not-read pointer= keywords=type"],
        ),
    ]);
}
