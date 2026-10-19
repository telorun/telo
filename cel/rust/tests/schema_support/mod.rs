//! Schemas for tests, and a schema read against the Node build's answer.
//!
//! A schema is written as JSON text and read with `read_json_text`, so every object is
//! its own node, as `JSON.parse` makes it. The host the rows are executed against is the
//! same on both sides: a resolver that answers the document a key names for a node whose
//! `$ref` is that key, and a named type for a node carrying the test-only `brand` key
//! (with `args` as its type arguments); and a lookup knowing `Money` and `Pair`, each a
//! named type over `int`.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use telorun_cel::{
    format_type, parse_type_expression, read_json_text, schema_type, CelType, CelTypeTextError, JsonSchemaDocument,
    JsonValue, NominalType, RecursiveSchemaReference, SchemaConversion, SchemaTypeAnswer, SchemaTypeResolver,
    SchemaTypeResult, UnjudgedSchemaNode, INT,
};

pub fn json(text: &str) -> Arc<JsonValue> {
    read_json_text(text).expect("the row is JSON")
}

/// The node a path of keys and indices names.
pub fn walk(value: &Arc<JsonValue>, path: &[&str]) -> Arc<JsonValue> {
    let mut at = Arc::clone(value);
    for key in path {
        let next = match &*at {
            JsonValue::Object(entries) => Arc::clone(entries.get(key).expect("the path names a key")),
            JsonValue::Array(items) => Arc::clone(&items[key.parse::<usize>().expect("an index")]),
            _ => panic!("the path names a container"),
        };
        at = next;
    }
    at
}

/// A document: the node at `path` of `root`, or `root` standing as its own document.
pub fn document_at(root: &Arc<JsonValue>, path: &[&str]) -> JsonSchemaDocument {
    if path.is_empty() {
        JsonSchemaDocument { node: Arc::clone(root), root: None }
    } else {
        JsonSchemaDocument { node: walk(root, path), root: Some(Arc::clone(root)) }
    }
}

/// A document the resolver answers for the `$ref` key.
pub enum Doc {
    Text { key: &'static str, root: &'static str, at: &'static [&'static str] },
    /// A node of the converted document itself, under that document's root or as its own.
    InMain { key: &'static str, at: &'static [&'static str], own: bool },
}

pub const fn doc(key: &'static str, root: &'static str, at: &'static [&'static str]) -> Doc {
    Doc::Text { key, root, at }
}

pub const fn doc_in_main(key: &'static str, at: &'static [&'static str], own: bool) -> Doc {
    Doc::InMain { key, at, own }
}

/// The resolver of the rows, counting how often it is asked.
pub fn resolver(docs: HashMap<String, JsonSchemaDocument>, calls: Arc<AtomicUsize>) -> SchemaTypeResolver {
    Arc::new(move |document: &JsonSchemaDocument| {
        calls.fetch_add(1, Ordering::SeqCst);
        let JsonValue::Object(entries) = &*document.node else { return None };
        if let Some(JsonValue::String(reference)) = entries.get("$ref").map(|value| &**value) {
            if let Some(held) = docs.get(reference) {
                return Some(SchemaTypeAnswer::Document(held.clone()));
            }
        }
        if let Some(JsonValue::String(brand)) = entries.get("brand").map(|value| &**value) {
            let args = match entries.get("args").map(|value| &**value) {
                Some(JsonValue::Array(items)) => items
                    .iter()
                    .map(|item| match &**item {
                        JsonValue::String(text) => text.clone(),
                        _ => panic!("a type argument is text"),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            return Some(SchemaTypeAnswer::Named { name: brand.clone(), args });
        }
        None
    })
}

/// `Money` and `Pair`, each a named type over `int`; nothing else.
pub fn lookup(name: &str, args: &[String]) -> Result<Option<CelType>, CelTypeTextError> {
    if name != "Money" && name != "Pair" {
        return Ok(None);
    }
    let args = args.iter().map(|text| parse_type_expression(text, None)).collect::<Result<Vec<_>, _>>()?;
    Ok(Some(CelType::Nominal(NominalType { name: name.into(), base: Arc::new(INT), args: args.into(), fields: None })))
}

/// A type with every record's fields written out: `{a: string, ...}` for an open one.
pub fn described(ty: &CelType) -> String {
    match ty {
        CelType::Record(record) => {
            let mut parts: Vec<String> = record.fields.iter().map(|(name, ty)| format!("{name}: {}", described(ty))).collect();
            if record.open {
                parts.push("...".into());
            }
            format!("{}{{{}}}", record.name.as_deref().unwrap_or(""), parts.join(", "))
        }
        CelType::List(list) => format!("list<{}>", described(&list.element)),
        CelType::Map(map) => format!("map<{}, {}>", described(&map.key), described(&map.value)),
        CelType::Optional(optional) => format!("optional<{}>", described(&optional.value)),
        CelType::Union(union) => union.members().iter().map(described).collect::<Vec<_>>().join("|"),
        other => format_type(other, false),
    }
}

pub fn unjudged_line(node: &UnjudgedSchemaNode) -> String {
    let mut parts = vec![node.reason.as_str().to_string(), format!("pointer={}", node.pointer)];
    if let Some(through) = &node.through_reference {
        parts.push(format!("through={through}"));
    }
    parts.push(format!("keywords={}", node.keywords.join(",")));
    if let Some(name) = &node.type_name {
        parts.push(format!("type={name}"));
    }
    parts.join(" ")
}

pub fn recursive_line(reference: &RecursiveSchemaReference) -> String {
    let mut parts = vec!["recursive".to_string(), format!("pointer={}", reference.pointer)];
    if let Some(through) = &reference.through_reference {
        parts.push(format!("through={through}"));
    }
    if let Some(reference) = &reference.reference {
        parts.push(format!("reference={reference}"));
    }
    parts.join(" ")
}

/// Every report, the unjudged nodes then the recursive references, one line each.
pub fn report_lines(result: &SchemaTypeResult) -> Vec<String> {
    result.unjudged.iter().map(unjudged_line).chain(result.recursive.iter().map(recursive_line)).collect()
}

/// One schema read under the rows' host, with how often its resolver was asked.
pub fn read_schema(root: &str, at: &[&str], docs: &[Doc]) -> (Result<SchemaTypeResult, CelTypeTextError>, usize) {
    let main = json(root);
    let held: HashMap<String, JsonSchemaDocument> = docs
        .iter()
        .map(|entry| match entry {
            Doc::Text { key, root, at } => (key.to_string(), document_at(&json(root), at)),
            Doc::InMain { key, at, own } => {
                let node = walk(&main, at);
                let root = if *own { None } else { Some(Arc::clone(&main)) };
                (key.to_string(), JsonSchemaDocument { node, root })
            }
        })
        .collect();
    let calls = Arc::new(AtomicUsize::new(0));
    let conversion =
        SchemaConversion { resolve_schema_type: Some(resolver(held, Arc::clone(&calls))), lookup_named_type: Some(&lookup) };
    let result = schema_type(&document_at(&main, at), &conversion);
    (result, calls.load(Ordering::SeqCst))
}

/// A row of the Node build's whole answer for one schema: the type written out, as
/// `formatType` prints it at the top, every report, and the resolver's call count.
pub struct Row {
    pub label: &'static str,
    pub root: &'static str,
    pub at: &'static [&'static str],
    pub docs: &'static [Doc],
    pub described: &'static str,
    pub text: &'static str,
    pub reports: &'static [&'static str],
    pub calls: usize,
}

#[allow(clippy::too_many_arguments)]
pub const fn row(
    label: &'static str,
    root: &'static str,
    at: &'static [&'static str],
    docs: &'static [Doc],
    described: &'static str,
    text: &'static str,
    reports: &'static [&'static str],
    calls: usize,
) -> Row {
    Row { label, root, at, docs, described, text, reports, calls }
}

pub fn assert_rows(rows: &[Row]) {
    for row in rows {
        let (result, calls) = read_schema(row.root, row.at, row.docs);
        let result = result.unwrap_or_else(|error| panic!("{}: {error}", row.label));
        assert_eq!(described(&result.ty), row.described, "{}", row.label);
        assert_eq!(format_type(&result.ty, true), row.text, "{}", row.label);
        assert_eq!(report_lines(&result), row.reports, "{}", row.label);
        assert_eq!(calls, row.calls, "{}", row.label);
    }
}
