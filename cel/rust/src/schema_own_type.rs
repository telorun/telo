//! Whether two versions of a schema document agree on one node's own type — the twin of
//! `schema-own-type.ts`, whose header states the definition: a node's `type`, `const` and
//! `enum`, the names in `properties` and the patterns in `patternProperties`, a boolean
//! `additionalProperties`, how many members
//! `allOf` / `anyOf` / `oneOf` hold and how many positions `items` / `prefixItems` do, a
//! `$ref`'s text and what the host's resolver answers for it, every subschema position masked
//! to its presence and form (absent, `true`, `false` or a schema), a `not` schema's to
//! whether it holds anything beyond annotations and whether it holds a value keyword. A pointer naming no
//! node in either document agrees; naming one in only one of them does not.

use std::sync::Arc;

use crate::json_schema_type::{
    node_at_pointer, JsonSchemaDocument, SchemaTypeAnswer, SchemaTypeResolver, ANNOTATION_KEYWORDS, NEGATION_TYPE_KEYWORDS,
};
use telorun_cel_value::PropertyMap;

use crate::json_value::JsonValue;

/// How two answers of the host's resolver are compared.
pub type SchemaAnswersAgree<'a> = dyn Fn(&SchemaTypeAnswer, &SchemaTypeAnswer) -> bool + 'a;

/// What the agreement asks of the host.
#[derive(Clone, Default)]
pub struct SchemaOwnTypeAgreement<'a> {
    /// Asked at the node in each document, as a conversion asks it.
    pub resolve_schema_type: Option<SchemaTypeResolver>,
    /// Whether the resolver's two answers say the same. By default a named type agrees with
    /// the same name and arguments, and a document with the same document by identity —
    /// its node and its root.
    pub answers_agree: Option<&'a SchemaAnswersAgree<'a>>,
}

/// Whether `pointer` names a node of the same own type in both documents, each pointer
/// relative to its document's `node` and each `#…` reference within it read against its
/// `root` (the node itself where absent).
pub fn schema_own_types_agree(
    left: &JsonSchemaDocument,
    right: &JsonSchemaDocument,
    pointer: &str,
    agreement: &SchemaOwnTypeAgreement<'_>,
) -> bool {
    let (left_node, right_node) = match (node_at_pointer(&left.node, pointer), node_at_pointer(&right.node, pointer)) {
        (None, None) => return true,
        (Some(left_node), Some(right_node)) => (left_node, right_node),
        _ => return false,
    };
    if !own_types_equal(&left_node, &right_node) {
        return false;
    }
    let Some(resolve) = &agreement.resolve_schema_type else { return true };
    let asked = |document: &JsonSchemaDocument, node: Arc<JsonValue>| {
        let root = Arc::clone(document.root.as_ref().unwrap_or(&document.node));
        resolve(&JsonSchemaDocument { node, root: Some(root) })
    };
    match (asked(left, left_node), asked(right, right_node)) {
        (None, None) => true,
        (Some(left_answer), Some(right_answer)) => match agreement.answers_agree {
            Some(answers_agree) => answers_agree(&left_answer, &right_answer),
            None => answers_agree_by_default(&left_answer, &right_answer),
        },
        _ => false,
    }
}

fn keyword<'n>(node: &'n JsonValue, name: &str) -> Option<&'n Arc<JsonValue>> {
    match node {
        JsonValue::Object(entries) => entries.get(name),
        _ => None,
    }
}

/// A subschema position's form: a boolean as itself, a schema masked.
#[derive(PartialEq)]
enum Form {
    Bool(bool),
    Schema,
}

fn form(value: &JsonValue) -> Form {
    match value {
        JsonValue::Bool(value) => Form::Bool(*value),
        _ => Form::Schema,
    }
}

/// Whether two nodes say the same about their own type, each subschema position masked to
/// its presence and form; a `not` schema's to whether it holds anything beyond annotations
/// and whether it holds a value keyword, since that is what its reading turns on.
fn own_types_equal(left: &JsonValue, right: &JsonValue) -> bool {
    let at = |name: &str| (keyword(left, name).map(|value| &**value), keyword(right, name).map(|value| &**value));
    let values = ["type", "const", "$ref"].into_iter().all(|name| {
        let (left, right) = at(name);
        left == right
    }) && match at("enum") {
        (Some(JsonValue::Array(left)), Some(JsonValue::Array(right))) => same_enum_sets(left, right),
        (left, right) => left == right,
    };
    let properties = ["properties", "patternProperties"].into_iter().all(|name| match at(name) {
        (Some(JsonValue::Object(left)), Some(JsonValue::Object(right))) => {
            property_names(left) == property_names(right)
                && property_names(left).into_iter().all(|name| {
                    left.get(name).map(|value| form(value)) == right.get(name).map(|value| form(value))
                })
        }
        (Some(JsonValue::Object(_)), _) | (_, Some(JsonValue::Object(_))) => false,
        (left, right) => left == right,
    });
    let forms = ["additionalProperties", "additionalItems", "if", "then", "else"].into_iter().all(|name| match at(name) {
        (None, None) => true,
        (Some(left), Some(right)) => form(left) == form(right),
        _ => false,
    });
    let positions = ["items", "prefixItems"].into_iter().all(|name| match at(name) {
        (None, None) => true,
        (Some(JsonValue::Array(left)), Some(JsonValue::Array(right))) => {
            left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| form(left) == form(right))
        }
        (Some(JsonValue::Array(_)), _) | (_, Some(JsonValue::Array(_))) => false,
        (Some(left), Some(right)) => form(left) == form(right),
        _ => false,
    });
    let negation = match at("not") {
        (None, None) => true,
        (Some(JsonValue::Object(left)), Some(JsonValue::Object(right))) => negation_form(left) == negation_form(right),
        (Some(JsonValue::Object(_)), _) | (_, Some(JsonValue::Object(_))) => false,
        (Some(left), Some(right)) => form(left) == form(right),
        _ => false,
    };
    let members = ["allOf", "anyOf", "oneOf"].into_iter().all(|name| match at(name) {
        (Some(JsonValue::Array(left)), Some(JsonValue::Array(right))) => left.len() == right.len(),
        (Some(JsonValue::Array(_)), _) | (_, Some(JsonValue::Array(_))) => false,
        (left, right) => left == right,
    });
    values && properties && forms && positions && negation && members
}

/// Whether two `enum`s hold the same values, as sets, with their values' JSON types first
/// appearing in the same order — the order of the union each reads as.
fn same_enum_sets(left: &[Arc<JsonValue>], right: &[Arc<JsonValue>]) -> bool {
    let same = |a: &JsonValue, b: &JsonValue| match (a, b) {
        (JsonValue::Number(a), JsonValue::Number(b)) => a == b,
        _ => a == b,
    };
    let within = |from: &[Arc<JsonValue>], to: &[Arc<JsonValue>]| from.iter().all(|value| to.iter().any(|held| same(value, held)));
    within(left, right) && within(right, left) && json_kinds(left) == json_kinds(right)
}

fn json_kinds(values: &[Arc<JsonValue>]) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    for value in values {
        let kind = match &**value {
            JsonValue::Null => "null",
            JsonValue::Bool(_) => "boolean",
            JsonValue::Number(number) if number.trunc() == *number => "integer",
            JsonValue::Number(_) => "number",
            JsonValue::String(_) => "string",
            JsonValue::Array(_) => "array",
            JsonValue::Object(_) => "object",
        };
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
}

/// Whether a `not` schema holds anything beyond annotations, and whether it holds a value keyword.
fn negation_form(entries: &PropertyMap<Arc<JsonValue>>) -> (bool, bool) {
    let constrains = entries.keys().any(|name| !ANNOTATION_KEYWORDS.contains(&name));
    let values = entries.keys().any(|name| !ANNOTATION_KEYWORDS.contains(&name) && !NEGATION_TYPE_KEYWORDS.contains(&name));
    (constrains, values)
}

fn property_names(entries: &PropertyMap<Arc<JsonValue>>) -> Vec<&str> {
    let mut names: Vec<&str> = entries.keys().collect();
    names.sort_unstable();
    names
}

fn answers_agree_by_default(left: &SchemaTypeAnswer, right: &SchemaTypeAnswer) -> bool {
    match (left, right) {
        (
            SchemaTypeAnswer::Named { name: left_name, args: left_args },
            SchemaTypeAnswer::Named { name: right_name, args: right_args },
        ) => left_name == right_name && left_args == right_args,
        (SchemaTypeAnswer::Document(left), SchemaTypeAnswer::Document(right)) => {
            Arc::ptr_eq(&left.node, &right.node)
                && Arc::ptr_eq(left.root.as_ref().unwrap_or(&left.node), right.root.as_ref().unwrap_or(&right.node))
        }
        _ => false,
    }
}
