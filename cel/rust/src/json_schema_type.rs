//! JSON Schema as a CEL type, read to full depth — `json-schema-type.ts`.
//!
//! Nested objects become records of records, `items` the element type,
//! `additionalProperties` the value type of a map, and a union stays a union. **Nothing a
//! schema says falls through to `dyn` in silence**: a type-constraining keyword this
//! reader has no rule for, or reads in a form it does not, is reported by JSON Pointer
//! beside the type produced in its place ([`UnjudgedSchemaNode`]). It reports rather than
//! refuses, because a schema is usually a third party's data.
//!
//! A document-local reference (`#/…`) is resolved here, against the document the node
//! belongs to; one that leaves the document is the host's, answered by the
//! [`SchemaTypeResolver`] asked at every node before its structure is read — with a
//! registered type name, or the document to read in place of the node. A reference
//! re-entered on the descent is the one deliberate `dyn`, declared as
//! [`RecursiveSchemaReference`].
//!
//! Conversion is memoized by node identity within a document — a node's identity is its
//! `Arc`'s pointer, an array counting as a node — so a node reached twice is converted
//! and reported once, at the pointer it was first reached by. A key is looked up among a
//! node's own entries only.
//!
//! Nothing here recurses with a schema's depth: the descent and the intersection of two
//! types run on heap work lists, keeping Node's order — the resolver asked, and a
//! `keyword-not-read` report made, before a node's children are read; an
//! `intersection-empty` report after them; the memo written after the read.
//!
//! Node items with no twin in this file: `JsonSchemaNode` — a schema node is a
//! [`JsonValue`].
//!
//! Three kinds of position are judged apart. A *container* (the text of `$ref`, the lists
//! of `allOf` / `anyOf` / `oneOf` / `enum`, the map of `properties`, `type` as a whole)
//! holding the wrong JSON type is mis-shaped: one grouped `shape-not-read` report per
//! node, keywords in the read order, right after its `keyword-not-read` report and before
//! its children, and the keyword is read as absent. A *node* (a subschema, `items`,
//! `additionalProperties`) that is no object reads `dyn`, unreported, as on Node. A
//! *type-name* (each name under `type`) that names no JSON type — a non-string element
//! included — reads `dyn` with its own `shape-not-read` report `[type]`, made when the
//! names are read, so one node can carry a grouped report and element reports.
//!
//! Declared here and not in the Node file: [`UnjudgedReason::as_str`]. Where this file
//! answers differently from Node — a read keyword holding a JSON type its shape excludes,
//! a name on JavaScript's object prototype — is stated in the crate's README.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{es_string_to_number, PropertyMap};

use crate::cel_type::{
    assignable, equal_at_own_level, is_dyn, list_of, map_of, optional_of, record_of, tuple_of, unify, union_copy, union_of, CelType, FieldEnumValue,
    ListType, PatternField, PatternPart, PrimitiveName, RecordType, TypeFields, BOOL, DOUBLE, DYN, INT, NULL, STRING,
};
use crate::function_registry::UNION_EXPANSION_LIMIT;
use crate::record_member::pattern_standing;
use crate::regular_expression::{re2_pattern, Re2Flags};
use crate::json_value::JsonValue;
use crate::type_expression::CelTypeTextError;
use crate::type_visits::count_type_visit;
use crate::schema_dependencies::{
    joined_reads, kept_in, no_schema_reads, node_read, type_identity, EdgeKey, MemberReads,
    SchemaProvenance, SchemaReads, ELEMENT_EDGE,
};
use crate::schema_nodes::{same_type, SchemaNodeAt};

/// A node and the document it belongs to. A `#/…` reference inside `node` resolves
/// against `root`; absent, the node stands as its own document.
#[derive(Clone, PartialEq, Debug)]
pub struct JsonSchemaDocument {
    pub node: Arc<JsonValue>,
    pub root: Option<Arc<JsonValue>>,
}

/// What the host says a schema node is, before its structure is read.
#[derive(Clone, PartialEq, Debug)]
pub enum SchemaTypeAnswer {
    /// A registered type name with its type arguments, as type text.
    Named { name: String, args: Vec<String> },
    /// The document to read in place of this node.
    Document(JsonSchemaDocument),
}

/// Asked at every schema node with the document it belongs to — whose `root` is always
/// present — before the node's structure is read.
pub type SchemaTypeResolver = Arc<dyn Fn(&JsonSchemaDocument) -> Option<SchemaTypeAnswer> + Send + Sync>;

/// How a named type a resolver answers becomes a type: read as the type-expression
/// grammar reads a name, CEL's own types first, then the registered ones; nothing where it
/// is neither.
pub type NamedTypeLookup<'a> = dyn Fn(&str, &[String]) -> Result<Option<CelType>, CelTypeTextError> + 'a;

#[derive(Clone, Default)]
pub struct SchemaConversion<'a> {
    pub resolve_schema_type: Option<SchemaTypeResolver>,
    pub lookup_named_type: Option<&'a NamedTypeLookup<'a>>,
}

/// Why a node could not be judged.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum UnjudgedReason {
    /// The node carries a type-constraining keyword this reader has no rule for.
    KeywordNotRead,
    /// A keyword this reader reads, in a form it does not: `prefixItems` beside
    /// `additionalItems` or an array `items`, a `type` naming no JSON type, a `not` saying
    /// more about a type than `type`, `const` and `enum` do, a `patternProperties` pattern
    /// RE2 refuses, and a meet whose unions would build more than `UNION_EXPANSION_LIMIT`
    /// members.
    ShapeNotRead,
    /// A reference the host did not answer, or a pointer naming nothing.
    ReferenceUnresolved,
    /// Two things the node says about its own type cannot both hold, or the schema admits
    /// no value where absence cannot be stated (a registration's root).
    IntersectionEmpty,
    /// The host's resolver named a type that is neither CEL's own nor registered.
    NamedTypeUnregistered,
}

impl UnjudgedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UnjudgedReason::KeywordNotRead => "keyword-not-read",
            UnjudgedReason::ShapeNotRead => "shape-not-read",
            UnjudgedReason::ReferenceUnresolved => "reference-unresolved",
            UnjudgedReason::IntersectionEmpty => "intersection-empty",
            UnjudgedReason::NamedTypeUnregistered => "named-type-unregistered",
        }
    }
}

pub const UNJUDGED_REASONS: [UnjudgedReason; 5] = [
    UnjudgedReason::KeywordNotRead,
    UnjudgedReason::ShapeNotRead,
    UnjudgedReason::ReferenceUnresolved,
    UnjudgedReason::IntersectionEmpty,
    UnjudgedReason::NamedTypeUnregistered,
];

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnjudgedSchemaNode {
    /// JSON Pointer to the node, within the document it was found in.
    pub pointer: String,
    /// The pointer, in the document the conversion was given, of the reference that
    /// first led out of it; absent for a node of that document.
    pub through_reference: Option<String>,
    /// The keywords at the node that could not be read, in the closed list's order;
    /// none where no keyword is the cause.
    pub keywords: Vec<&'static str>,
    /// The type name the host's resolver answered, where that is the cause.
    pub type_name: Option<String>,
    pub reason: UnjudgedReason,
}

/// A reference re-entered on the descent: a recursive schema, deliberately `dyn`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RecursiveSchemaReference {
    pub pointer: String,
    pub through_reference: Option<String>,
    /// The reference that led back, where a reference did.
    pub reference: Option<String>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct SchemaTypeResult {
    pub ty: CelType,
    /// Every node this reader could not judge. Empty is the whole schema judged.
    pub unjudged: Vec<UnjudgedSchemaNode>,
    pub recursive: Vec<RecursiveSchemaReference>,
}

/// Every keyword that can change what CEL type a node has, sorted.
pub const TYPE_CONSTRAINING_KEYWORDS: &[&str] = &[
    "$dynamicRef",
    "$recursiveRef",
    "$ref",
    "additionalItems",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "dependentSchemas",
    "else",
    "enum",
    "if",
    "items",
    "not",
    "oneOf",
    "patternProperties",
    "prefixItems",
    "properties",
    "then",
    "type",
    "unevaluatedItems",
    "unevaluatedProperties",
];

/// The keywords of that list this reader reads. Every other one on it is reported.
pub const TYPE_KEYWORDS_READ: &[&str] = &[
    "$ref",
    "additionalItems",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "else",
    "enum",
    "if",
    "items",
    "not",
    "oneOf",
    "patternProperties",
    "prefixItems",
    "properties",
    "then",
    "type",
];

/// The type keywords a `not` subschema may carry and still be read: it excludes whole types.
pub(crate) const NEGATION_TYPE_KEYWORDS: &[&str] = &["const", "enum", "type"];

/// Keywords that say nothing about a value: a subschema holding only these admits every value.
pub(crate) const ANNOTATION_KEYWORDS: &[&str] =
    &["$comment", "default", "deprecated", "description", "examples", "readOnly", "title", "writeOnly"];

/// The type a schema declares, read to full depth, beside what it could not judge. It
/// fails only where the named-type lookup does.
pub fn schema_type(
    document: &JsonSchemaDocument,
    conversion: &SchemaConversion<'_>,
) -> Result<SchemaTypeResult, CelTypeTextError> {
    Ok(read_schema_type(document, conversion)?.result)
}

/// A conversion's reading, beside where each type it built came from and what building them
/// cost — the counts read by the cost gates alone.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct SchemaTypeReading {
    pub(crate) result: SchemaTypeResult,
    pub(crate) provenance: SchemaProvenance,
    /// How many holders the containers its intersections built keep.
    pub(crate) held_holders: usize,
    /// How many containers its intersections built, each counted once however many meets
    /// answered it.
    pub(crate) built_containers: usize,
    /// How many entries — nodes, whole types, parts — the readings it built hold.
    pub(crate) reads_entries: usize,
}

/// The same reading, beside where each type it built came from (`schema_dependencies.rs`) and
/// what it cost.
pub(crate) fn read_schema_type(
    document: &JsonSchemaDocument,
    conversion: &SchemaConversion<'_>,
) -> Result<SchemaTypeReading, CelTypeTextError> {
    let mut reader = SchemaReader {
        conversion,
        unjudged: Vec::new(),
        recursive: Vec::new(),
        documents: HashMap::new(),
        tasks: Vec::new(),
        values: Vec::new(),
        edges: HashMap::new(),
        member_nodes: HashMap::new(),
        union_nodes: HashMap::new(),
        declaring: HashMap::new(),
        held_holders: 0,
        built_containers: 0,
        reads_entries: 0,
        answers: MeetAnswers::default(),
        containers: HashMap::new(),
        holder_table: HashMap::new(),
        met_unions: HashMap::new(),
    };
    let root = document.root.clone().unwrap_or_else(|| Arc::clone(&document.node));
    reader.tasks.push(Task::Read(Visit {
        node: Arc::clone(&document.node),
        root,
        base: Arc::clone(&document.node),
        pointer: Pointer::default(),
        through: None,
        arrived_by: None,
    }));
    reader.run()?;
    let (ty, reads, node, none, _) = reader.values.pop().expect("the descent leaves one type");
    // Absence has nowhere to be stated at the root, so a schema admitting no value there is
    // two things it says that cannot both hold.
    if let Some(keywords) = none {
        let mut distinct: Vec<&'static str> = Vec::with_capacity(keywords.len());
        for name in keywords {
            if !distinct.contains(&name) {
                distinct.push(name);
            }
        }
        reader.unjudged.push(UnjudgedSchemaNode {
            pointer: String::new(),
            through_reference: None,
            keywords: distinct,
            type_name: None,
            reason: UnjudgedReason::IntersectionEmpty,
        });
    }
    Ok(SchemaTypeReading {
        result: SchemaTypeResult { ty, unjudged: reader.unjudged, recursive: reader.recursive },
        provenance: SchemaProvenance {
            root: reads,
            root_node: node.expect("a read names the node it was read from"),
            edges: reader.edges,
            member_nodes: reader.member_nodes,
            union_nodes: reader.union_nodes,
        },
        held_holders: reader.held_holders,
        built_containers: reader.built_containers,
        reads_entries: reader.reads_entries,
    })
}

// --- pointers ------------------------------------------------------------------

/// A JSON Pointer shared with the pointer it extends, written out only when reported,
/// so a descent of any depth builds no text proportional to it at each level.
#[derive(Clone, Default)]
pub(crate) struct Pointer(Option<Arc<PointerLink>>);

struct PointerLink {
    parent: Pointer,
    segment: Box<str>,
}

impl Pointer {
    fn extended(&self, segment: String) -> Pointer {
        Pointer(Some(Arc::new(PointerLink { parent: self.clone(), segment: segment.into() })))
    }

    fn written(text: &str) -> Pointer {
        Pointer::default().extended(text.into())
    }

    pub(crate) fn text(&self) -> String {
        let mut segments = Vec::new();
        let mut at = &self.0;
        while let Some(link) = at {
            segments.push(&*link.segment);
            at = &link.parent.0;
        }
        segments.into_iter().rev().collect()
    }
}

impl Drop for PointerLink {
    fn drop(&mut self) {
        let mut next = self.parent.0.take();
        while let Some(link) = next {
            match Arc::into_inner(link) {
                Some(mut held) => next = held.parent.0.take(),
                None => break,
            }
        }
    }
}

/// A JSON Pointer segment, escaped as RFC 6901 writes it.
fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// The node a JSON Pointer names within a document, or nothing where it names none. An
/// array is indexed by the number its segment reads as.
pub(crate) fn node_at_pointer(root: &Arc<JsonValue>, pointer: &str) -> Option<Arc<JsonValue>> {
    if pointer.is_empty() {
        return Some(Arc::clone(root));
    }
    let rest = pointer.strip_prefix('/')?;
    let mut at = root;
    for segment in rest.split('/') {
        let name = segment.replace("~1", "/").replace("~0", "~");
        at = match &**at {
            JsonValue::Array(items) => {
                let index = es_string_to_number(&name);
                if !(index.is_finite() && index.trunc() == index && index >= 0.0 && index < items.len() as f64) {
                    return None;
                }
                &items[index as usize]
            }
            JsonValue::Object(entries) => entries.get(&name)?,
            _ => return None,
        };
    }
    is_node(at).then(|| Arc::clone(at))
}

// --- what a node says ------------------------------------------------------------

fn is_node(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Object(_) | JsonValue::Array(_))
}

fn entries(node: &JsonValue) -> Option<&PropertyMap<Arc<JsonValue>>> {
    match node {
        JsonValue::Object(entries) => Some(entries),
        _ => None,
    }
}

fn keyword<'n>(node: &'n JsonValue, name: &str) -> Option<&'n Arc<JsonValue>> {
    entries(node)?.get(name)
}

fn string_keyword<'n>(node: &'n JsonValue, name: &str) -> Option<&'n str> {
    match keyword(node, name).map(|value| &**value) {
        Some(JsonValue::String(text)) => Some(text),
        _ => None,
    }
}

fn array_keyword<'n>(node: &'n JsonValue, name: &str) -> Option<&'n [Arc<JsonValue>]> {
    match keyword(node, name).map(|value| &**value) {
        Some(JsonValue::Array(items)) => Some(items),
        _ => None,
    }
}

fn object_keyword<'n>(node: &'n JsonValue, name: &str) -> Option<&'n PropertyMap<Arc<JsonValue>>> {
    match keyword(node, name).map(|value| &**value) {
        Some(JsonValue::Object(entries)) => Some(entries),
        _ => None,
    }
}

/// What `type` names: one name, several, or nothing readable.
enum TypeNames<'n> {
    One(&'n str),
    /// A list: an element that is not a string names no JSON type.
    Many(Vec<Option<&'n str>>),
}

fn type_names(node: &JsonValue) -> Option<TypeNames<'_>> {
    match keyword(node, "type").map(|value| &**value) {
        Some(JsonValue::String(name)) => Some(TypeNames::One(name)),
        Some(JsonValue::Array(items)) => Some(TypeNames::Many(
            items
                .iter()
                .map(|item| match &**item {
                    JsonValue::String(name) => Some(name.as_str()),
                    _ => None,
                })
                .collect(),
        )),
        _ => None,
    }
}

/// Whether a read keyword the node carries holds a JSON type the keyword's shape
/// excludes. Such a keyword is read as absent.
fn misshapen(node: &JsonValue, name: &str) -> bool {
    let Some(value) = keyword(node, name) else { return false };
    match name {
        "$ref" => !matches!(&**value, JsonValue::String(_)),
        "allOf" | "anyOf" | "oneOf" | "enum" => !matches!(&**value, JsonValue::Array(_)),
        "properties" | "patternProperties" => !matches!(&**value, JsonValue::Object(_)),
        "type" => !matches!(&**value, JsonValue::String(_) | JsonValue::Array(_)),
        _ => false,
    }
}

fn scalar(name: &str) -> Option<CelType> {
    Some(match name {
        "string" => STRING,
        "integer" => INT,
        "number" => DOUBLE,
        "boolean" => BOOL,
        "null" => NULL,
        _ => return None,
    })
}

/// The JSON type a constant or an enumerated value holds.
fn json_value_type(value: &JsonValue) -> CelType {
    match value {
        JsonValue::Null => NULL,
        JsonValue::Bool(_) => BOOL,
        JsonValue::String(_) => STRING,
        JsonValue::Number(number) if number.is_finite() && number.trunc() == *number => INT,
        JsonValue::Number(_) => DOUBLE,
        JsonValue::Array(_) => list_of(DYN),
        JsonValue::Object(_) => map_of(STRING, DYN),
    }
}

/// The values a node's own `const` and `enum` admit, where every one is a scalar and some are listed.
fn own_values(node: &JsonValue) -> Option<Values> {
    let mut lists = Vec::new();
    if let Some(value) = keyword(node, "const") {
        lists.push(scalars(std::slice::from_ref(value)));
    }
    if let Some(values) = array_keyword(node, "enum") {
        lists.push(scalars(values));
    }
    intersect_values(lists)
}

fn scalars(values: &[Arc<JsonValue>]) -> Option<Values> {
    let scalar = |value: &Arc<JsonValue>| matches!(**value, JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_));
    (!values.is_empty() && values.iter().all(scalar)).then(|| Arc::from(values))
}

/// Two written scalars as one value: a number by its value, so `0` is `-0`.
fn same_scalar(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Null, JsonValue::Null) => true,
        (JsonValue::Bool(a), JsonValue::Bool(b)) => a == b,
        (JsonValue::Number(a), JsonValue::Number(b)) => a == b,
        (JsonValue::String(a), JsonValue::String(b)) => a == b,
        _ => false,
    }
}

/// The values every finite set admits; nothing where no set is finite.
fn intersect_values(sets: Vec<Option<Values>>) -> Option<Values> {
    let mut held: Option<Values> = None;
    for values in sets.into_iter().flatten() {
        held = Some(match held {
            None => values,
            Some(held) => held.iter().filter(|value| values.iter().any(|other| same_scalar(value, other))).cloned().collect(),
        });
    }
    held
}

fn united_values<'v>(sets: impl Iterator<Item = &'v Values>) -> Values {
    let mut united: Vec<Arc<JsonValue>> = Vec::new();
    for values in sets {
        for value in values.iter() {
            if !united.iter().any(|held| same_scalar(held, value)) {
                united.push(Arc::clone(value));
            }
        }
    }
    united.into()
}

/// A record's declared fields as a conversion builds them: a set no value of which survives
/// the meet that built it makes the field absent, and one its type reads no value of carries
/// none.
#[derive(Default)]
struct DeclaredFields {
    types: TypeFields,
    absent: Vec<Arc<str>>,
    enums: Vec<(Arc<str>, Vec<FieldEnumValue>)>,
}

impl DeclaredFields {
    fn declare(&mut self, name: String, ty: CelType, values: Option<&[Arc<JsonValue>]>) {
        if values.is_some_and(|values| values.is_empty()) {
            self.absent.push(name.into());
            return;
        }
        let typed: Vec<FieldEnumValue> = values.unwrap_or(&[]).iter().filter_map(|value| typed_value(value, &ty)).collect();
        if !typed.is_empty() {
            self.enums.push((name.as_str().into(), typed));
        }
        self.types.insert(name, ty);
    }
}

/// A written value as a field's type reads it: an integral number an int where the type holds one, else a double.
fn typed_value(value: &JsonValue, ty: &CelType) -> Option<FieldEnumValue> {
    let held = match value {
        JsonValue::Null => FieldEnumValue::Null,
        JsonValue::Bool(value) => FieldEnumValue::Bool(*value),
        JsonValue::String(value) => FieldEnumValue::String(value.as_str().into()),
        JsonValue::Number(number) => {
            let integral = number.trunc() == *number && *number >= -9_223_372_036_854_775_808.0 && *number < 9_223_372_036_854_775_808.0;
            if integral && admits_scalar(ty, PrimitiveName::Int) {
                return Some(FieldEnumValue::Int(*number as i64));
            }
            FieldEnumValue::double(*number)
        }
        _ => return None,
    };
    held_by(&held, ty).then_some(held)
}

/// Whether a field's type holds values of a scalar type.
fn admits_scalar(ty: &CelType, name: PrimitiveName) -> bool {
    match ty {
        CelType::Dyn => true,
        CelType::Union(union) => union.members().iter().any(|member| admits_scalar(member, name)),
        CelType::Primitive(held) => *held == name,
        _ => false,
    }
}

/// Whether a value of a field's set is one its type reads.
fn held_by(value: &FieldEnumValue, ty: &CelType) -> bool {
    let name = match value {
        FieldEnumValue::Null => PrimitiveName::Null,
        FieldEnumValue::Bool(_) => PrimitiveName::Bool,
        FieldEnumValue::String(_) => PrimitiveName::String,
        FieldEnumValue::Int(_) => PrimitiveName::Int,
        FieldEnumValue::Double(_) => PrimitiveName::Double,
    };
    admits_scalar(ty, name)
}

/// A set's value as a met field's type reads it: a double the type holds no double of is the
/// int it equals, where it is integral and the type holds an int; a value of another type is
/// nothing.
fn read_as(value: &FieldEnumValue, ty: &CelType) -> Option<FieldEnumValue> {
    if held_by(value, ty) {
        return Some(value.clone());
    }
    match value {
        FieldEnumValue::Double(number)
            if number.trunc() == *number
                && *number >= -9_223_372_036_854_775_808.0
                && *number < 9_223_372_036_854_775_808.0
                && admits_scalar(ty, PrimitiveName::Int) =>
        {
            Some(FieldEnumValue::Int(*number as i64))
        }
        _ => None,
    }
}

/// The set of a field two sets meet at: each side's values the met type reads, then those both
/// admit; nothing where neither side carries one, and an empty set where none survives.
fn met_field_enum(left: Option<&[FieldEnumValue]>, right: Option<&[FieldEnumValue]>, ty: &CelType) -> Option<Vec<FieldEnumValue>> {
    let read = |values: &[FieldEnumValue]| -> Vec<FieldEnumValue> { values.iter().filter_map(|value| read_as(value, ty)).collect() };
    match (left, right) {
        (None, None) => None,
        (Some(only), None) | (None, Some(only)) => Some(read(only)),
        (Some(left), Some(right)) => {
            let other = read(right);
            Some(read(left).into_iter().filter(|value| other.contains(value)).collect())
        }
    }
}

fn is_integral(ty: &CelType) -> bool {
    matches!(ty, CelType::Primitive(PrimitiveName::Int | PrimitiveName::Uint))
}

fn is_double(ty: &CelType) -> bool {
    matches!(ty, CelType::Primitive(PrimitiveName::Double))
}

// --- the reader ------------------------------------------------------------------

/// A node to read, where it was reached from.
#[derive(Clone)]
struct Visit {
    node: Arc<JsonValue>,
    root: Arc<JsonValue>,
    /// What `pointer` is relative to: the node a descent began at, or the document a
    /// reference resolved against.
    base: Arc<JsonValue>,
    pointer: Pointer,
    through: Option<Pointer>,
    arrived_by: Option<String>,
}

/// One step of the descent. A step that answers a type leaves it on the value stack; a
/// combining step takes the types its parts left.
enum Task {
    Read(Visit),
    /// The read of `node` under `root` is done: the type on top is memoized, read as that
    /// node.
    Finish { root: usize, node: Arc<JsonValue>, base: Arc<JsonValue>, pointer: Pointer },
    Reference { reference: String, at: Visit },
    OfType { name: Option<String>, at: Visit },
    Record(Visit),
    Array(Visit),
    /// Builds a record or a map from the additional type, the property types and the
    /// pattern types left; `patterns` none where a pattern RE2 refuses left them unread.
    BuildRecord { names: Option<Vec<String>>, additional_read: bool, additional: Option<bool>, patterns: Option<Vec<String>>, at: Visit },
    List,
    /// Reads a tuple's positions one at a time, stopping at one admitting no value.
    TuplePositions(Box<TupleRead>),
    /// Builds a tuple from the positions and the rest left.
    BuildTuple { positions: usize, rest: TupleRest },
    Type(CelType),
    /// A union of the types left; `branches` when they are branches of their own, each a
    /// node, rather than what one node's `type` list names — `keyword` the one naming them.
    Union { count: usize, branches: Option<&'static str> },
    /// `if` / `then` / `else` from the reads left: the `if`, then each present branch.
    Conditional { then: bool, otherwise: bool, at: Visit },
    Meet { keywords: Vec<&'static str>, at: Visit },
    /// What the node's `not` takes out of the type left.
    Negate(Visit),
    /// The values the node's own `const` and `enum` admit, met with the finite set left.
    OwnValues(Arc<JsonValue>),
}

/// A tuple being read: its positions, how many have been read, and its rest.
struct TupleRead {
    at: Visit,
    positions: Vec<Arc<JsonValue>>,
    positions_keyword: &'static str,
    rest: Option<Arc<JsonValue>>,
    rest_keyword: &'static str,
    read: usize,
}

/// What a tuple's rest is when it is built: `dyn` (no rest keyword), the value left, or
/// none (a position admitting no value ended it).
#[derive(Clone, Copy)]
enum TupleRest {
    Dyn,
    Read,
    Ended,
}

/// The keywords that say a schema admits no value — `false`, `not: {}`, a conditional
/// neither branch of which can hold. Its holder states it as absence where it can (a member,
/// the members it does not declare, a tuple's rest, a union branch) and reports it where it
/// cannot.
type NoValue = Vec<&'static str>;

/// A type left by a step, what reading it reads, the node it was read from — absent where
/// the node being read built it — whether it admits no value, and the finite set of values it
/// admits, as written — absent where it is not finite.
type Value = (CelType, Arc<SchemaReads>, Option<SchemaNodeAt>, Option<NoValue>, Option<Values>);

/// A finite set of values as a schema writes them: scalars only.
type Values = Arc<[Arc<JsonValue>]>;

/// What has been read of one document: its memo, and what is being read right now.
#[derive(Default)]
struct DocumentState {
    done: HashMap<usize, (Arc<JsonValue>, CelType, Arc<SchemaReads>, SchemaNodeAt, Option<NoValue>, Option<Values>)>,
    active: HashSet<usize>,
}

struct SchemaReader<'c, 'a> {
    conversion: &'c SchemaConversion<'a>,
    unjudged: Vec<UnjudgedSchemaNode>,
    recursive: Vec<RecursiveSchemaReference>,
    /// Keyed by the document's root, held so its address is never reused.
    documents: HashMap<usize, (Arc<JsonValue>, DocumentState)>,
    tasks: Vec<Task>,
    /// Each type left, beside what reading it reads and the node it was read from.
    values: Vec<Value>,
    edges: HashMap<(u8, usize), (CelType, MemberReads)>,
    member_nodes: HashMap<(u8, usize), HashMap<EdgeKey, SchemaNodeAt>>,
    union_nodes: HashMap<(u8, usize), (CelType, Vec<SchemaNodeAt>)>,
    /// Per container an intersection built, held in `edges`: the parts holding each member.
    declaring: HashMap<(u8, usize), Declaring>,
    /// How many holders the containers an intersection built keep, which is what placing them
    /// costs.
    held_holders: usize,
    built_containers: usize,
    reads_entries: usize,
    /// Every meet this conversion answered (the computed table).
    answers: MeetAnswers,
    /// Each container and union a meet built, by everything its readers observe of it (the
    /// unique table); the unique key covers every side-table entry placement or the listing reads.
    containers: HashMap<String, CelType>,
    /// Each holder by the side, member and typing it stands for, the side held so its address
    /// is never reused: a holder's identity is its content.
    holder_table: HashMap<((u8, usize), EdgeKey, bool), (CelType, Arc<Holder>)>,
    /// The unions a meet built rather than answered as a side, held.
    met_unions: HashMap<(u8, usize), CelType>,
}

/// One meet's answer, beside the two sides it was asked of (held, so their addresses are never
/// reused): the type, or none where they cannot both hold; everything it compared, as one
/// reading; whether it went past the limit.
struct MeetAnswer {
    _sides: (CelType, CelType),
    ty: Option<CelType>,
    compared: Arc<SchemaReads>,
    past: bool,
}

/// The meets one conversion has answered, by mode — as written, swapped, or observed by
/// nothing — and the identities of the two sides: a meet is a function of its two types and the
/// conversion's tables, so the same pair met again is answered from here, its comparison
/// replayed as the one reading it recorded.
#[derive(Default)]
struct MeetAnswers {
    held: HashMap<(u8, (u8, usize), (u8, usize)), MeetAnswer>,
}

impl MeetAnswers {
    fn get(&self, mode: u8, left: &CelType, right: &CelType) -> Option<&MeetAnswer> {
        self.held.get(&(mode, type_identity(left)?, type_identity(right)?))
    }

    fn set(&mut self, mode: u8, left: &CelType, right: &CelType, ty: Option<CelType>, compared: Arc<SchemaReads>, past: bool) {
        let (Some(at_left), Some(at_right)) = (type_identity(left), type_identity(right)) else { return };
        self.held
            .entry((mode, at_left, at_right))
            .or_insert_with(|| MeetAnswer { _sides: (left.clone(), right.clone()), ty, compared, past });
    }
}

/// One part holding a member position of a container an intersection met: the node it read
/// the member from, where it did, what reading that member reads, and whether it types the
/// member as something other than `dyn`.
struct Holder {
    node: Option<SchemaNodeAt>,
    reads: Arc<SchemaReads>,
    typed: bool,
}

/// Per member of a container an intersection built, the parts holding it, in written order.
#[derive(Default)]
struct Declaring {
    members: HashMap<EdgeKey, Vec<Arc<Holder>>>,
    /// Per member declared absent, the parts declaring it so.
    absent: HashMap<String, Vec<Arc<Holder>>>,
}

/// The holders as each distinct one in the order it first occurs, held once or — where it
/// occurs again — twice. Twice already says several parts hold a member, which is all a count
/// is read for; a type an intersection built, met with itself, would otherwise double its list
/// at every level it is met again. Canonical, so a list met again is the list it was, and
/// concatenating canonical lists answers what concatenating the lists they came from would.
fn canonical_holders(holders: Vec<Arc<Holder>>) -> Vec<Arc<Holder>> {
    if holders.len() < 2 {
        return holders;
    }
    let mut counts: HashMap<*const Holder, usize> = HashMap::with_capacity(holders.len());
    let mut distinct: Vec<Arc<Holder>> = Vec::with_capacity(holders.len());
    for holder in holders {
        let count = counts.entry(Arc::as_ptr(&holder)).or_insert(0);
        if *count == 0 {
            distinct.push(holder);
        }
        *count += 1;
    }
    let mut canonical = Vec::with_capacity(distinct.len() * 2);
    for holder in distinct {
        let twice = counts[&Arc::as_ptr(&holder)] > 1;
        if twice {
            canonical.push(Arc::clone(&holder));
        }
        canonical.push(holder);
    }
    canonical
}

/// What a unique-table key names a member type by: its identity, or — for a type with none of
/// its own — what it is.
fn type_key(ty: &CelType) -> String {
    match type_identity(ty) {
        Some((kind, address)) => format!("{kind}.{address}"),
        None => format!("{ty:?}"),
    }
}

fn identity(value: &Arc<JsonValue>) -> usize {
    Arc::as_ptr(value) as usize
}

impl Visit {
    /// A subschema of this node, at `segment` beneath it.
    fn child(&self, node: &Arc<JsonValue>, segment: String) -> Visit {
        Visit {
            node: Arc::clone(node),
            root: Arc::clone(&self.root),
            base: Arc::clone(&self.base),
            pointer: self.pointer.extended(format!("/{segment}")),
            through: self.through.clone(),
            arrived_by: None,
        }
    }
}

impl SchemaReader<'_, '_> {
    fn run(&mut self) -> Result<(), CelTypeTextError> {
        while let Some(task) = self.tasks.pop() {
            match task {
                Task::Read(visit) => self.read(visit)?,
                Task::Finish { root, node, base, pointer } => {
                    let (ty, own, from, none, values) = self.values.pop().expect("a read leaves its type");
                    let read = self.node_read(&base, &pointer, own);
                    let from = from.unwrap_or(SchemaNodeAt { document: base, pointer });
                    // A union a meet built is the conversion's one copy of it, which containers
                    // hold: this node places its own.
                    let ty = match (&ty, type_identity(&ty)) {
                        (CelType::Union(union), Some(at)) if self.met_unions.contains_key(&at) => union_copy(union),
                        _ => ty,
                    };
                    // A union this node built itself holds every member as read from this node.
                    if let (CelType::Union(union), Some(at)) = (&ty, type_identity(&ty)) {
                        let count = union.members().len();
                        self.union_nodes.entry(at).or_insert_with(|| (ty.clone(), vec![from.clone(); count]));
                    }
                    self.values.push((ty.clone(), Arc::clone(&read), Some(from.clone()), none.clone(), values.clone()));
                    let (_, state) = self.documents.get_mut(&root).expect("a document being read has a state");
                    state.active.remove(&identity(&node));
                    state.done.insert(identity(&node), (node, ty, read, from, none, values));
                }
                Task::Reference { reference, at } => self.reference(reference, at),
                Task::OfType { name, at } => self.of_type(name.as_deref(), at),
                Task::Record(at) => self.record(at),
                Task::Array(at) => self.array(at),
                Task::BuildRecord { names, additional_read, additional, patterns, at } => {
                    let pattern_values = patterns.as_ref().map(|patterns| self.values.split_off(self.values.len() - patterns.len()));
                    let fields = names.as_ref().map(|names| self.values.split_off(self.values.len() - names.len()));
                    let additional_value = additional_read.then(|| self.values.pop().expect("the additional type"));
                    let ty = match patterns.zip(pattern_values) {
                        Some(patterns) => self.build_record(names.zip(fields), additional_value, additional, patterns, &at),
                        None => self.build_unread_record(names.zip(fields)),
                    };
                    self.values.push((ty, no_schema_reads(), None, None, None));
                }
                Task::List => {
                    let (element, reads, node, none, _) = self.values.pop().expect("the element type");
                    let node = node.expect("a read names the node it was read from");
                    // An element admitting no value is a list that holds none.
                    let ty = if none.is_some() {
                        self.with_edges(tuple_of(Vec::new(), None), MemberReads::from([(EdgeKey::Additional, reads)]), HashMap::from([(EdgeKey::Additional, node)]))
                    } else {
                        self.with_edges(
                            list_of(element),
                            MemberReads::from([(EdgeKey::member(ELEMENT_EDGE), reads)]),
                            HashMap::from([(EdgeKey::member(ELEMENT_EDGE), node)]),
                        )
                    };
                    self.values.push((ty, no_schema_reads(), None, None, None));
                }
                Task::TuplePositions(tuple) => self.tuple_positions(*tuple),
                Task::BuildTuple { positions, rest } => {
                    let rest_value = matches!(rest, TupleRest::Read).then(|| self.values.pop().expect("the rest type"));
                    let positions = self.values.split_off(self.values.len() - positions);
                    let ty = self.build_tuple(positions, rest_value, rest);
                    self.values.push((ty, no_schema_reads(), None, None, None));
                }
                Task::Type(ty) => self.values.push((ty, no_schema_reads(), None, None, None)),
                Task::Union { count, branches } => {
                    let members = self.values.split_off(self.values.len() - count);
                    let read = match branches {
                        Some(keyword) => self.union_read(members, keyword),
                        None => (union_of(members.into_iter().map(|(ty, ..)| ty)), no_schema_reads(), None, None, None),
                    };
                    self.values.push(read);
                }
                Task::Conditional { then, otherwise, at } => {
                    let count = 1 + usize::from(then) + usize::from(otherwise);
                    let mut reads = self.values.split_off(self.values.len() - count).into_iter();
                    let condition = reads.next().expect("the if read");
                    let then = if then { reads.next() } else { None };
                    let otherwise = if otherwise { reads.next() } else { None };
                    let read = self.conditional(condition, then, otherwise, &at);
                    self.values.push(read);
                }
                Task::Meet { keywords, at } => {
                    let parts = self.values.split_off(self.values.len() - keywords.len());
                    let read = self.meet(&keywords, parts, &at);
                    self.values.push(read);
                }
                Task::Negate(at) => {
                    let own = self.values.pop().expect("the node's own type");
                    let values = own.4.clone();
                    let mut read = self.negated(own, &at);
                    // `not` takes no value out of a finite set: a set wider than the node admits is still sound.
                    read.4 = values;
                    self.values.push(read);
                }
                Task::OwnValues(node) => {
                    let read = self.values.last_mut().expect("the node's own type");
                    read.4 = intersect_values(vec![read.4.take(), own_values(&node)]);
                }
            }
        }
        Ok(())
    }

    fn read(&mut self, visit: Visit) -> Result<(), CelTypeTextError> {
        // `false` admits no value; any other non-object says nothing, so there is nothing to judge.
        if matches!(*visit.node, JsonValue::Bool(false)) {
            let (ty, reads, node, ..) = self.this_node(&visit, DYN);
            self.values.push((ty, reads, node, Some(Vec::new()), None));
            return Ok(());
        }
        if !is_node(&visit.node) {
            let read = self.this_node(&visit, DYN);
            self.values.push(read);
            return Ok(());
        }
        let root = identity(&visit.root);
        let node = identity(&visit.node);
        let (_, state) =
            self.documents.entry(root).or_insert_with(|| (Arc::clone(&visit.root), DocumentState::default()));
        if let Some((_, held, reads, from, none, values)) = state.done.get(&node) {
            self.values.push((held.clone(), Arc::clone(reads), Some(from.clone()), none.clone(), values.clone()));
            return Ok(());
        }
        if state.active.contains(&node) {
            self.recursive.push(RecursiveSchemaReference {
                pointer: visit.pointer.text(),
                through_reference: visit.through.as_ref().map(Pointer::text),
                reference: visit.arrived_by.clone(),
            });
            let read = self.this_node(&visit, DYN);
            self.values.push(read);
            return Ok(());
        }
        state.active.insert(node);
        self.tasks.push(Task::Finish {
            root,
            node: Arc::clone(&visit.node),
            base: Arc::clone(&visit.base),
            pointer: visit.pointer.clone(),
        });
        let answer = self.conversion.resolve_schema_type.as_ref().and_then(|resolve| {
            resolve(&JsonSchemaDocument { node: Arc::clone(&visit.node), root: Some(Arc::clone(&visit.root)) })
        });
        match answer {
            Some(SchemaTypeAnswer::Document(crossed)) => {
                // The descent crosses into the document; the first crossing is kept.
                let root = crossed.root.unwrap_or_else(|| Arc::clone(&crossed.node));
                self.tasks.push(Task::Read(Visit {
                    base: Arc::clone(&crossed.node),
                    node: crossed.node,
                    root,
                    pointer: Pointer::default(),
                    through: Some(visit.through.unwrap_or(visit.pointer)),
                    arrived_by: None,
                }));
                return Ok(());
            }
            Some(SchemaTypeAnswer::Named { name, args }) => {
                if let Some(lookup) = self.conversion.lookup_named_type {
                    if let Some(ty) = lookup(&name, &args)? {
                        self.values.push((ty, no_schema_reads(), None, None, None));
                        return Ok(());
                    }
                }
                self.report(&visit, Vec::new(), UnjudgedReason::NamedTypeUnregistered, Some(name));
            }
            None => {}
        }
        self.report_unread_keywords(&visit);
        self.schedule_parts(visit);
        Ok(())
    }

    fn report_unread_keywords(&mut self, visit: &Visit) {
        let unread: Vec<&'static str> = TYPE_CONSTRAINING_KEYWORDS
            .iter()
            .copied()
            .filter(|name| !TYPE_KEYWORDS_READ.contains(name) && keyword(&visit.node, name).is_some())
            .collect();
        if !unread.is_empty() {
            self.report(visit, unread, UnjudgedReason::KeywordNotRead, None);
        }
        let misshapen: Vec<&'static str> =
            TYPE_KEYWORDS_READ.iter().copied().filter(|name| misshapen(&visit.node, name)).collect();
        if !misshapen.is_empty() {
            self.report(visit, misshapen, UnjudgedReason::ShapeNotRead, None);
        }
    }

    /// Everything the node says about its own type, each with the keyword that said it,
    /// then the one type they all admit.
    fn schedule_parts(&mut self, at: Visit) {
        let node = Arc::clone(&at.node);
        let mut program: Vec<Task> = Vec::new();
        let mut keywords: Vec<&'static str> = Vec::new();
        if let Some(reference) = string_keyword(&node, "$ref") {
            program.push(Task::Reference { reference: reference.into(), at: at.clone() });
            keywords.push("$ref");
        }
        if let Some(branches) = array_keyword(&node, "allOf").filter(|branches| !branches.is_empty()) {
            program.extend(self.branches(&at, "allOf", branches));
            program.push(Task::Meet { keywords: vec!["allOf"; branches.len()], at: at.clone() });
            keywords.push("allOf");
        }
        for name in ["anyOf", "oneOf"] {
            if let Some(branches) = array_keyword(&node, name).filter(|branches| !branches.is_empty()) {
                program.extend(self.branches(&at, name, branches));
                program.push(Task::Union { count: branches.len(), branches: Some(name) });
                keywords.push(name);
            }
        }
        if keyword(&node, "if").is_some() {
            let mut present = |name: &'static str| match keyword(&node, name) {
                Some(branch) => {
                    program.push(Task::Read(at.child(branch, name.into())));
                    true
                }
                None => false,
            };
            present("if");
            let then = present("then");
            let otherwise = present("else");
            program.push(Task::Conditional { then, otherwise, at: at.clone() });
            keywords.push("if");
        }
        if let Some((name, tasks)) = self.structure(&at) {
            program.extend(tasks);
            keywords.push(name);
        }
        let negation = keyword(&node, "not").is_some();
        program.push(Task::Meet { keywords, at: at.clone() });
        if negation {
            program.push(Task::Negate(at));
        }
        program.push(Task::OwnValues(node));
        self.tasks.extend(program.into_iter().rev());
    }

    fn branches(&self, at: &Visit, name: &str, branches: &[Arc<JsonValue>]) -> Vec<Task> {
        branches
            .iter()
            .enumerate()
            .map(|(index, branch)| {
                Task::Read(Visit {
                    node: Arc::clone(branch),
                    root: Arc::clone(&at.root),
                    base: Arc::clone(&at.base),
                    pointer: at.pointer.extended(format!("/{name}/{index}")),
                    through: at.through.clone(),
                    arrived_by: None,
                })
            })
            .collect()
    }

    /// What `type`, `properties`, `items` or a constant value say, the first that is
    /// there.
    fn structure(&self, at: &Visit) -> Option<(&'static str, Vec<Task>)> {
        let node = &at.node;
        if let Some(names) = type_names(node) {
            let tasks = match names {
                TypeNames::One(name) => vec![Task::OfType { name: Some(name.into()), at: at.clone() }],
                TypeNames::Many(names) => {
                    let count = names.len();
                    let mut tasks: Vec<Task> =
                        names.into_iter().map(|name| Task::OfType { name: name.map(String::from), at: at.clone() }).collect();
                    tasks.push(Task::Union { count, branches: None });
                    tasks
                }
            };
            return Some(("type", tasks));
        }
        if object_keyword(node, "properties").is_some()
            || keyword(node, "additionalProperties").is_some()
            || object_keyword(node, "patternProperties").is_some()
        {
            return Some(("properties", vec![Task::Record(at.clone())]));
        }
        if keyword(node, "items").is_some() || keyword(node, "prefixItems").is_some() {
            return Some(("items", vec![Task::Array(at.clone())]));
        }
        // A constant or an enumeration with no `type` still says what JSON type its
        // values hold.
        if let Some(value) = keyword(node, "const") {
            return Some(("const", vec![Task::Type(json_value_type(value))]));
        }
        if let Some(values) = array_keyword(node, "enum").filter(|values| !values.is_empty()) {
            return Some(("enum", vec![Task::Type(union_of(values.iter().map(|value| json_value_type(value))))]));
        }
        None
    }

    fn of_type(&mut self, name: Option<&str>, at: Visit) {
        if let Some(ty) = name.and_then(scalar) {
            self.values.push((ty, no_schema_reads(), None, None, None));
        } else if name == Some("object") {
            self.tasks.push(Task::Record(at));
        } else if name == Some("array") {
            self.tasks.push(Task::Array(at));
        } else {
            self.report(&at, vec!["type"], UnjudgedReason::ShapeNotRead, None);
            self.values.push((DYN, no_schema_reads(), None, None, None));
        }
    }

    fn record(&mut self, at: Visit) {
        let node = Arc::clone(&at.node);
        let patterns: Vec<(String, Arc<JsonValue>)> = object_keyword(&node, "patternProperties")
            .map(|entries| entries.iter().map(|(pattern, schema)| (pattern.to_string(), Arc::clone(schema))).collect())
            .unwrap_or_default();
        let mut program = Vec::new();
        let property = |program: &mut Vec<Task>, name: &str, schema: &Arc<JsonValue>| {
            program.push(Task::Read(Visit {
                node: Arc::clone(schema),
                root: Arc::clone(&at.root),
                base: Arc::clone(&at.base),
                pointer: at.pointer.extended(format!("/properties/{}", escape_segment(name))),
                through: at.through.clone(),
                arrived_by: None,
            }));
        };
        // A pattern RE2 refuses could match any member: every member it does not declare is `dyn`.
        if !patterns.iter().all(|(pattern, _)| re2_pattern(pattern, Re2Flags::NONE).is_ok()) {
            self.report(&at, vec!["patternProperties"], UnjudgedReason::ShapeNotRead, None);
            let names = object_keyword(&node, "properties").map(|properties| {
                properties
                    .iter()
                    .map(|(name, schema)| {
                        property(&mut program, name, schema);
                        name.to_string()
                    })
                    .collect::<Vec<_>>()
            });
            program.push(Task::BuildRecord { names, additional_read: false, additional: None, patterns: None, at });
            self.tasks.extend(program.into_iter().rev());
            return;
        }
        let additional = keyword(&node, "additionalProperties");
        let additional_bool = match additional.map(|value| &**value) {
            Some(JsonValue::Bool(value)) => Some(*value),
            _ => None,
        };
        let additional_read = additional.is_some() && additional_bool.is_none();
        if let (true, Some(value)) = (additional_read, additional) {
            program.push(Task::Read(Visit {
                node: Arc::clone(value),
                root: Arc::clone(&at.root),
                base: Arc::clone(&at.base),
                pointer: at.pointer.extended("/additionalProperties".into()),
                through: at.through.clone(),
                arrived_by: None,
            }));
        }
        let names = object_keyword(&node, "properties")
            .map(|properties| {
                properties
                    .iter()
                    .map(|(name, schema)| {
                        property(&mut program, name, schema);
                        name.to_string()
                    })
                    .collect::<Vec<_>>()
            })
            // Patterns with no declared property still make a record.
            .or_else(|| (!patterns.is_empty()).then(Vec::new));
        for (pattern, schema) in &patterns {
            program.push(Task::Read(at.child(schema, format!("patternProperties/{}", escape_segment(pattern)))));
        }
        let patterns = Some(patterns.into_iter().map(|(pattern, _)| pattern).collect());
        program.push(Task::BuildRecord { names, additional_read, additional: additional_bool, patterns, at });
        self.tasks.extend(program.into_iter().rev());
    }

    fn array(&mut self, at: Visit) {
        let items = keyword(&at.node, "items").map(Arc::clone);
        let array = |value: &Option<Arc<JsonValue>>| match value.as_deref() {
            Some(JsonValue::Array(items)) => Some(items.clone()),
            _ => None,
        };
        if let Some(prefix) = keyword(&at.node, "prefixItems").map(Arc::clone) {
            // 2020-12 spells a tuple `prefixItems` + `items`; draft-07's rest keyword beside
            // it, or a draft-07 tuple, leaves the positions unsaid.
            let mut mixed = vec!["prefixItems"];
            if keyword(&at.node, "additionalItems").is_some() {
                mixed.push("additionalItems");
            }
            if array(&items).is_some() {
                mixed.push("items");
            }
            let positions = array(&Some(Arc::clone(&prefix)));
            if positions.is_none() {
                mixed.push("prefixItems");
            }
            match positions {
                Some(positions) if mixed.len() == 1 => self.tasks.push(Task::TuplePositions(Box::new(TupleRead {
                    at,
                    positions,
                    positions_keyword: "prefixItems",
                    rest: items,
                    rest_keyword: "items",
                    read: 0,
                }))),
                _ => {
                    self.report(&at, mixed, UnjudgedReason::ShapeNotRead, None);
                    self.values.push((list_of(DYN), no_schema_reads(), None, None, None));
                }
            }
            return;
        }
        if let Some(positions) = array(&items) {
            let rest = keyword(&at.node, "additionalItems").map(Arc::clone);
            self.tasks.push(Task::TuplePositions(Box::new(TupleRead {
                at,
                positions,
                positions_keyword: "items",
                rest,
                rest_keyword: "additionalItems",
                read: 0,
            })));
            return;
        }
        match items {
            Some(items) => {
                self.tasks.push(Task::List);
                self.tasks.push(Task::Read(at.child(&items, "items".into())));
            }
            // Absent: nothing said about the elements.
            None => self.values.push((list_of(DYN), no_schema_reads(), None, None, None)),
        }
    }

    /// The next of a tuple's positions, or — every one read, or the last read admitting no
    /// value — its rest and then the tuple.
    fn tuple_positions(&mut self, mut tuple: TupleRead) {
        let ended = tuple.read > 0 && self.values.last().is_some_and(|(_, _, _, none, _)| none.is_some());
        if ended {
            self.tasks.push(Task::BuildTuple { positions: tuple.read, rest: TupleRest::Ended });
            return;
        }
        if tuple.read < tuple.positions.len() {
            let position = Arc::clone(&tuple.positions[tuple.read]);
            let visit = tuple.at.child(&position, format!("{}/{}", tuple.positions_keyword, tuple.read));
            tuple.read += 1;
            self.tasks.push(Task::TuplePositions(Box::new(tuple)));
            self.tasks.push(Task::Read(visit));
            return;
        }
        match tuple.rest.take() {
            Some(rest) => {
                self.tasks.push(Task::BuildTuple { positions: tuple.read, rest: TupleRest::Read });
                self.tasks.push(Task::Read(tuple.at.child(&rest, tuple.rest_keyword.into())));
            }
            None => self.tasks.push(Task::BuildTuple { positions: tuple.read, rest: TupleRest::Dyn }),
        }
    }

    /// A tuple from its positions read — the last of which admits no value where one ended
    /// it — and its rest: `dyn`, the value read (none where it admits no value), or none.
    fn build_tuple(&mut self, positions: Vec<Value>, rest_value: Option<Value>, rest: TupleRest) -> CelType {
        let mut members = MemberReads::new();
        let mut nodes = HashMap::new();
        let mut element_reads = Vec::new();
        let mut held: Vec<Value> = Vec::new();
        let mut prefix = Vec::new();
        for (index, value) in positions.into_iter().enumerate() {
            let key = EdgeKey::Member(index.to_string());
            let (ty, reads, node, none, _) = value;
            let node = node.expect("a read names the node it was read from");
            members.insert(key.clone(), Arc::clone(&reads));
            nodes.insert(key, node.clone());
            element_reads.push(Arc::clone(&reads));
            if none.is_none() {
                prefix.push(ty.clone());
                held.push((ty, reads, Some(node), None, None));
            }
        }
        let mut rest_type = match rest {
            TupleRest::Dyn => Some(DYN),
            _ => None,
        };
        if let Some((ty, reads, node, none, _)) = rest_value {
            let node = node.expect("a read names the node it was read from");
            members.insert(EdgeKey::Additional, Arc::clone(&reads));
            nodes.insert(EdgeKey::Additional, node.clone());
            element_reads.push(Arc::clone(&reads));
            if none.is_none() {
                rest_type = Some(ty.clone());
                held.push((ty, reads, Some(node), None, None));
            }
        }
        let list = tuple_of(prefix, rest_type);
        // The element is every position and the rest at once: a read of it lists each of their nodes.
        let element = EdgeKey::member(ELEMENT_EDGE);
        members.insert(element.clone(), self.joined(element_reads));
        if let [(_, _, Some(node), ..)] = held.as_slice() {
            nodes.insert(element, node.clone());
        }
        if let CelType::List(ListType { element, .. }) = &list {
            if let (CelType::Union(union), Some(identity)) = (&**element, type_identity(element)) {
                let at: Vec<SchemaNodeAt> = union
                    .members()
                    .iter()
                    .map(|member| self.branch_node(&held, member).expect("a member comes from a position"))
                    .collect();
                self.union_nodes.insert(identity, ((**element).clone(), at));
            }
        }
        self.with_edges(list, members, nodes)
    }

    /// A record from the properties read, the members it does not declare and the patterns
    /// read, or a map where it declares no property and carries no pattern: a member admitting
    /// no value is absent, a declared member a pattern matches is met with every pattern
    /// matching it — absent where one admits no value or the meet cannot hold — and undeclared
    /// members admitting none close the record.
    fn build_record(
        &mut self,
        properties: Option<(Vec<String>, Vec<Value>)>,
        additional_value: Option<Value>,
        additional: Option<bool>,
        (patterns, pattern_values): (Vec<String>, Vec<Value>),
        at: &Visit,
    ) -> CelType {
        let mut members = MemberReads::new();
        let mut nodes = HashMap::new();
        let mut additional_type = (additional == Some(true)).then_some(DYN);
        let mut additional_none = false;
        if let Some((ty, reads, node, none, _)) = additional_value {
            let node = node.expect("a read names the node it was read from");
            if properties.is_none() && none.is_none() {
                return self.with_edges(
                    map_of(STRING, ty),
                    MemberReads::from([(EdgeKey::member(ELEMENT_EDGE), reads)]),
                    HashMap::from([(EdgeKey::member(ELEMENT_EDGE), node)]),
                );
            }
            members.insert(EdgeKey::Additional, reads);
            nodes.insert(EdgeKey::Additional, node);
            additional_none = none.is_some();
            if !additional_none {
                additional_type = Some(ty);
            }
        }
        let Some((names, fields)) = properties else {
            if additional == Some(false) || additional_none {
                return self.with_edges(record_of(TypeFields::new(), None, Vec::new(), None, Vec::new(), Vec::new()), members, nodes);
            }
            return map_of(STRING, DYN);
        };
        let pattern_fields: Vec<PatternField> = patterns
            .iter()
            .zip(&pattern_values)
            .map(|(pattern, (ty, _, _, none, _))| PatternField { pattern: pattern.as_str().into(), ty: none.is_none().then(|| ty.clone()) })
            .collect();
        // One schema node is one pattern part, with no undeclared members of its own.
        let parts: Vec<PatternPart> =
            if pattern_fields.is_empty() { Vec::new() } else { vec![PatternPart { fields: pattern_fields, additional_fields: None }] };
        let matcher = record_of(TypeFields::new(), None, Vec::new(), None, parts.clone(), Vec::new());
        let CelType::Record(matcher) = &matcher else { unreachable!("a record") };
        let mut declared = DeclaredFields::default();
        for (name, (ty, reads, node, none, values)) in names.into_iter().zip(fields) {
            let matched = if none.is_some() || parts.is_empty() { Vec::new() } else { matcher.matching_patterns(0, &name) };
            if matched.is_empty() {
                members.insert(EdgeKey::Member(name.clone()), reads);
                nodes.insert(EdgeKey::Member(name.clone()), node.expect("a read names the node it was read from"));
                // A member whose schema admits no value is declared absent.
                if none.is_some() {
                    declared.absent.push(name.into());
                } else {
                    declared.declare(name, ty, values.as_deref());
                }
                continue;
            }
            // Each pattern matching a declared member applies to it with its `properties` entry.
            let applying: Vec<&Value> = matched.iter().map(|at| &pattern_values[*at]).collect();
            let mut part_reads: Vec<Arc<SchemaReads>> = vec![reads];
            part_reads.extend(applying.iter().map(|(_, reads, ..)| Arc::clone(reads)));
            if let Some((_, _, empty, ..)) = applying.iter().find(|(_, _, _, none, _)| none.is_some()) {
                members.insert(EdgeKey::Member(name.clone()), self.joined(part_reads));
                nodes.insert(EdgeKey::Member(name.clone()), empty.clone().expect("a read names the node it was read from"));
                declared.absent.push(name.into());
                continue;
            }
            let mut meeting = PartMeeting { reader: self, compared: Vec::new(), past_limit: false };
            let mut met = Some(ty.clone());
            for (pattern, ..) in &applying {
                met = met.and_then(|held| intersect_types(&held, pattern, &mut meeting));
            }
            let past_limit = meeting.past_limit;
            part_reads.extend(meeting.compared);
            if past_limit {
                let mut types = vec![ty];
                types.extend(applying.iter().map(|(pattern, ..)| pattern.clone()));
                met = Some(self.joined_past_limit(&types, at, vec!["patternProperties"]));
            }
            members.insert(EdgeKey::Member(name.clone()), self.joined(part_reads));
            match met {
                Some(met) => declared.declare(name, met, values.as_deref()),
                None => declared.absent.push(name.into()),
            }
        }
        for (index, (_, reads, node, ..)) in pattern_values.into_iter().enumerate() {
            members.insert(EdgeKey::Pattern(index), reads);
            nodes.insert(EdgeKey::Pattern(index), node.expect("a read names the node it was read from"));
        }
        let DeclaredFields { types, absent, enums } = declared;
        self.with_edges(record_of(types, additional_type, absent, None, parts, enums), members, nodes)
    }

    /// A record whose patterns RE2 refuses one of: its properties as declared, every other
    /// member `dyn`.
    fn build_unread_record(&mut self, properties: Option<(Vec<String>, Vec<Value>)>) -> CelType {
        let mut members = MemberReads::new();
        let mut nodes = HashMap::new();
        let mut declared = DeclaredFields::default();
        for (name, (ty, reads, node, none, values)) in properties.into_iter().flat_map(|(names, fields)| names.into_iter().zip(fields)) {
            members.insert(EdgeKey::Member(name.clone()), reads);
            nodes.insert(EdgeKey::Member(name.clone()), node.expect("a read names the node it was read from"));
            if none.is_some() {
                declared.absent.push(name.into());
            } else {
                declared.declare(name, ty, values.as_deref());
            }
        }
        let DeclaredFields { types, absent, enums } = declared;
        self.with_edges(record_of(types, Some(DYN), absent, None, Vec::new(), enums), members, nodes)
    }

    /// A document-local reference, resolved here; anything else was the host's to answer.
    fn reference(&mut self, reference: String, at: Visit) {
        let Some(pointer) = reference.strip_prefix('#') else {
            self.report(&at, vec!["$ref"], UnjudgedReason::ReferenceUnresolved, None);
            self.values.push((DYN, no_schema_reads(), None, None, None));
            return;
        };
        let Some(target) = node_at_pointer(&at.root, pointer) else {
            self.report(&at, vec!["$ref"], UnjudgedReason::ReferenceUnresolved, None);
            // Where it points is read all the same: a node appearing there would answer it. The
            // type is still read from the reference, since nothing stands where it points.
            let reads = self.node_read(&at.root, &Pointer::written(pointer), no_schema_reads());
            self.values.push((DYN, reads, None, None, None));
            return;
        };
        self.tasks.push(Task::Read(Visit {
            node: target,
            base: Arc::clone(&at.root),
            root: at.root,
            pointer: Pointer::written(pointer),
            through: at.through,
            arrived_by: Some(reference),
        }));
    }

    /// The one type every part admits; two parts that cannot both hold admit no value —
    /// absence to the node's holder, reported at a registration's root. One part reads what
    /// it reads; an intersection of several reads each part's own type and what the meeting
    /// compared.
    fn meet(&mut self, keywords: &[&'static str], mut parts: Vec<Value>, at: &Visit) -> Value {
        if parts.len() <= 1 {
            return parts.pop().unwrap_or_else(|| (DYN, no_schema_reads(), None, None, None));
        }
        let own: Vec<Arc<SchemaReads>> = parts.iter().map(|(_, reads, ..)| Arc::clone(reads)).collect();
        // A part admitting no value leaves nothing for the others to admit.
        if let Some(none) = parts.iter().find_map(|(_, _, _, none, _)| none.clone()) {
            return (DYN, self.joined(own), None, Some(none), None);
        }
        let values = intersect_values(parts.iter().map(|(.., values)| values.clone()).collect());
        let types: Vec<CelType> = parts.into_iter().map(|(ty, ..)| ty).collect();
        let mut meeting = PartMeeting { reader: self, compared: Vec::new(), past_limit: false };
        let mut parts = keywords.iter().copied().zip(types.iter().cloned());
        let (mut met_keyword, mut met) = parts.next().expect("several parts");
        let mut empty = None;
        for (keyword, ty) in parts {
            let both = intersect_types(&met, &ty, &mut meeting);
            if meeting.past_limit {
                break;
            }
            match both {
                Some(both) => {
                    met = both;
                    met_keyword = keyword;
                }
                None => {
                    empty = Some(keyword);
                    break;
                }
            }
        }
        if meeting.past_limit {
            let joined = self.joined_past_limit(&types, at, keywords.to_vec());
            return (joined, self.joined(own), None, None, values);
        }
        let compared = meeting.compared;
        let reads = self.joined(own.into_iter().chain(compared).collect());
        if let Some(keyword) = empty {
            return (DYN, reads, None, Some(vec![met_keyword, keyword]), None);
        }
        (met, reads, None, None, values)
    }

    /// `if` / `then` / `else` as one part: the union of `if` met with `then` (`{}` where
    /// absent) and `else`, a branch that cannot hold dropped; with no `else` it says
    /// nothing. The three nodes are read whole, since the answer rests on all of them.
    fn conditional(&mut self, condition: Value, then: Option<Value>, otherwise: Option<Value>, at: &Visit) -> Value {
        let present: Vec<&Value> = [Some(&condition), then.as_ref(), otherwise.as_ref()].into_iter().flatten().collect();
        let reads = self.whole_reads(present.iter().map(|(ty, reads, ..)| (ty.clone(), Arc::clone(reads))).collect());
        let Some(otherwise) = otherwise else { return (DYN, reads, None, None, None) };
        let holding = match (&condition, &then) {
            ((_, _, _, Some(_), _), _) | (_, Some((_, _, _, Some(_), _))) => None,
            ((condition, ..), Some((then, ..))) => {
                let mut meeting = PartMeeting { reader: self, compared: Vec::new(), past_limit: false };
                let met = intersect_types(condition, then, &mut meeting);
                if meeting.past_limit {
                    Some(self.joined_past_limit(&[condition.clone(), then.clone()], at, vec!["if", "then"]))
                } else {
                    met
                }
            }
            ((condition, ..), None) => Some(condition.clone()),
        };
        let kept: Vec<CelType> = holding.into_iter().chain(otherwise.3.is_none().then_some(otherwise.0)).collect();
        if kept.is_empty() {
            return (DYN, reads, None, Some(vec!["else", "if", "then"]), None);
        }
        (union_of(kept), reads, None, None, None)
    }

    /// Where a container an intersection built reads each member from. A member exactly one
    /// part types other than `dyn` — one held as `dyn` alone, where no part types it — is read
    /// from that part's node; one several parts type was built by the intersection and is read
    /// from none, its reads every one of theirs. A member declared absent is read from the
    /// first part declaring it so, and one the meet made absent from none, its reads every
    /// part's typing it. `positions` names what a member of a record built from both sides'
    /// pattern parts stands on. The container is held in `edges`, so its identity is never
    /// reused.
    fn place(&mut self, built: CelType, first: &CelType, second: &CelType, positions: &HashMap<EdgeKey, Position>) -> CelType {
        let Some(identity) = type_identity(&built) else { return built };
        // Each member's holders in order, an absent one's beside whether some part declares it so.
        let mut placed: Vec<(EdgeKey, Vec<Arc<Holder>>, Option<bool>)> = Vec::new();
        let member = |reader: &mut Self, key: EdgeKey, position: Position| -> (EdgeKey, Vec<Arc<Holder>>, Option<bool>) {
            let position = positions.get(&key).cloned().unwrap_or(position);
            let held = reader.held_by_both(first, second, &position);
            (key, held, None)
        };
        match &built {
            CelType::Record(record) => {
                for (name, _) in record.fields.iter() {
                    placed.push(member(self, EdgeKey::member(name), Position::member(name)));
                }
                if record.additional_fields().is_some() {
                    placed.push(member(self, EdgeKey::Additional, Position::Edge(EdgeKey::Additional)));
                }
                for part in 0..record.pattern_part_count() {
                    for at in record.part_entries(part) {
                        placed.push(member(self, EdgeKey::Pattern(at), Position::Edge(EdgeKey::Pattern(at))));
                    }
                    if record.part_additional(part).is_some() {
                        placed.push(member(self, EdgeKey::PartAdditional(part), Position::Edge(EdgeKey::PartAdditional(part))));
                    }
                }
                for name in record.absent_fields() {
                    let mut declaring_absent = self.absent_holders(first, name);
                    declaring_absent.extend(self.absent_holders(second, name));
                    let declaring_absent = canonical_holders(declaring_absent);
                    let declared = !declaring_absent.is_empty();
                    // A member no part declares absent is one whose meet cannot hold: read from
                    // every part typing it.
                    let held = if declared { declaring_absent } else { self.held_by_both(first, second, &Position::member(name)) };
                    placed.push((EdgeKey::member(name), held, Some(declared)));
                }
            }
            CelType::Map(_) => placed.push(member(self, EdgeKey::member(ELEMENT_EDGE), Position::member(ELEMENT_EDGE))),
            CelType::List(list) => match list.prefix_elements() {
                None => placed.push(member(self, EdgeKey::member(ELEMENT_EDGE), Position::member(ELEMENT_EDGE))),
                Some(prefix) => {
                    for at in 0..prefix.len() {
                        placed.push(member(self, EdgeKey::Member(at.to_string()), Position::Edge(EdgeKey::Member(at.to_string()))));
                    }
                    if list.additional_elements().is_some() {
                        placed.push(member(self, EdgeKey::Additional, Position::Edge(EdgeKey::Additional)));
                    }
                }
            },
            CelType::Optional(_) => {}
            _ => return built,
        }
        // Two meets building what their readers cannot tell apart answer one container.
        let key = container_key(&built, &placed);
        if let Some(held) = self.containers.get(&key) {
            return held.clone();
        }
        self.containers.insert(key, built.clone());
        if matches!(built, CelType::Optional(_)) {
            return built;
        }
        let mut declaring = Declaring::default();
        let mut members = MemberReads::new();
        let mut nodes: HashMap<EdgeKey, SchemaNodeAt> = HashMap::new();
        let mut element = Vec::new();
        for (key, held, absent) in placed {
            let reads = match absent {
                Some(declared) => {
                    if declared {
                        if let Some(node) = &held[0].node {
                            nodes.insert(key.clone(), node.clone());
                        }
                    }
                    self.joined(held.iter().map(|holder| Arc::clone(&holder.reads)).collect())
                }
                None => {
                    let typed: Vec<&Arc<Holder>> = held.iter().filter(|holder| holder.typed).collect();
                    let standing: Vec<&Arc<Holder>> = if typed.is_empty() { held.iter().collect() } else { typed };
                    if let [holder] = standing.as_slice() {
                        if let Some(node) = &holder.node {
                            nodes.insert(key.clone(), node.clone());
                        }
                    }
                    self.joined(standing.iter().map(|holder| Arc::clone(&holder.reads)).collect())
                }
            };
            element.push(Arc::clone(&reads));
            members.insert(key.clone(), reads);
            self.held_holders += held.len();
            match (absent, key) {
                (Some(_), EdgeKey::Member(name)) => {
                    declaring.absent.insert(name, held);
                }
                (_, key) => {
                    declaring.members.insert(key, held);
                }
            }
        }
        // A tuple's element is every position and the rest at once, built by the intersection.
        if matches!(&built, CelType::List(list) if list.prefix_elements().is_some()) {
            let reads = self.joined(element);
            members.insert(EdgeKey::member(ELEMENT_EDGE), reads);
        }
        self.built_containers += 1;
        self.declaring.insert(identity, declaring);
        self.edges.insert(identity, (built.clone(), members));
        self.member_nodes.insert(identity, nodes);
        built
    }

    /// A union a meet built, kept once by its members' identities.
    fn union(&mut self, built: CelType) -> CelType {
        let CelType::Union(union) = &built else { return built };
        let key = format!("u{}", union.members().iter().map(type_key).collect::<Vec<_>>().join(","));
        if let Some(held) = self.containers.get(&key) {
            return held.clone();
        }
        self.containers.insert(key, built.clone());
        built
    }

    /// Both sides' holders of the member at `position`, first side first, canonical
    /// ([`canonical_holders`]).
    fn held_by_both(&mut self, first: &CelType, second: &CelType, position: &Position) -> Vec<Arc<Holder>> {
        let mut held = self.holders(first, position, 0);
        held.extend(self.holders(second, position, 1));
        canonical_holders(held)
    }

    /// The parts of one side of an intersection holding the member at `position`: a declared
    /// member, each pattern matching it, or the undeclared members, element or rest standing
    /// for it — or, for a position naming what each side stands on, side `which`'s. A side an
    /// earlier meeting built stands for every part it was built from.
    fn holders(&mut self, side: &CelType, position: &Position, which: usize) -> Vec<Arc<Holder>> {
        let held: Vec<(EdgeKey, bool)> = match position {
            Position::Edge(edge) => members_at(side, edge).into_iter().map(|(edge, ty)| (edge, !is_dyn(ty))).collect(),
            Position::Sides(sides) => sides[which].clone(),
        };
        if held.is_empty() {
            return Vec::new();
        }
        let identity = type_identity(side);
        if let Some(declared) = identity.and_then(|identity| self.declaring.get(&identity)) {
            return held.iter().flat_map(|(edge, _)| declared.members.get(edge).cloned().unwrap_or_default()).collect();
        }
        held.into_iter().map(|(edge, typed)| self.holder(side, &edge, typed)).collect()
    }

    fn holder(&mut self, side: &CelType, edge: &EdgeKey, typed: bool) -> Arc<Holder> {
        let identity = type_identity(side);
        let built = || {
            Arc::new(Holder {
                node: identity.and_then(|identity| self.member_nodes.get(&identity)).and_then(|nodes| nodes.get(edge)).cloned(),
                reads: identity
                    .and_then(|identity| self.edges.get(&identity))
                    .and_then(|(_, members)| members.get(edge))
                    .cloned()
                    .unwrap_or_else(no_schema_reads),
                typed,
            })
        };
        let Some(at) = identity else { return built() };
        if let Some((_, held)) = self.holder_table.get(&(at, edge.clone(), typed)) {
            return Arc::clone(held);
        }
        let holder = built();
        self.holder_table.insert((at, edge.clone(), typed), (side.clone(), Arc::clone(&holder)));
        holder
    }

    /// The parts of one side declaring a member absent: its own absent name, or each pattern
    /// admitting no value that matches it.
    fn absent_holders(&mut self, side: &CelType, name: &str) -> Vec<Arc<Holder>> {
        let CelType::Record(record) = side else { return Vec::new() };
        let identity = type_identity(side);
        let declared = identity.is_some_and(|identity| self.declaring.contains_key(&identity));
        if record.absent_fields().any(|held| held == name) {
            if declared {
                let declaring = &self.declaring[&identity.expect("a declared side has an identity")];
                return declaring.absent.get(name).cloned().unwrap_or_default();
            }
            return vec![self.holder(side, &EdgeKey::member(name), false)];
        }
        if record.fields.contains_key(name) {
            return Vec::new();
        }
        let mut held = Vec::new();
        for (edge, ty) in pattern_standing(record, name).unwrap_or_default() {
            if ty.is_some() {
                continue;
            }
            if declared {
                let declaring = &self.declaring[&identity.expect("a declared side has an identity")];
                held.extend(declaring.members.get(&edge).cloned().unwrap_or_default());
            } else {
                held.push(self.holder(side, &edge, false));
            }
        }
        held
    }

    /// What `not` takes out of the type the rest of the node says: every value (`{}`,
    /// `true`), nothing (`false`, or a subschema constraining only values), or each union
    /// member the subschema accepts wholly. A subschema saying more about a type is not read.
    fn negated(&mut self, own: Value, at: &Visit) -> Value {
        let (ty, reads, from, none, _) = own;
        let negation = keyword(&at.node, "not").map(Arc::clone).expect("a node negated holds `not`");
        if none.is_some() || matches!(*negation, JsonValue::Bool(false)) {
            return (ty, reads, from, none, None);
        }
        let not = self.node_read(&at.base, &at.pointer.extended("/not".into()), no_schema_reads());
        let reads = self.joined(vec![reads, not]);
        let nothing = || Some(vec!["not"]);
        match &*negation {
            JsonValue::Bool(true) => return (DYN, reads, None, nothing(), None),
            JsonValue::Object(_) if admits_every_value(&negation) => return (DYN, reads, None, nothing(), None),
            JsonValue::Object(_) => {}
            _ => return (ty, reads, from, None, None),
        }
        let unread = TYPE_CONSTRAINING_KEYWORDS
            .iter()
            .any(|name| keyword(&negation, name).is_some() && !NEGATION_TYPE_KEYWORDS.contains(name));
        if unread {
            self.report(at, vec!["not"], UnjudgedReason::ShapeNotRead, None);
            return (ty, reads, from, None, None);
        }
        if is_dyn(&ty) {
            return (ty, reads, from, None, None);
        }
        let members: Vec<CelType> = match &ty {
            CelType::Union(union) => union.members().to_vec(),
            other => vec![other.clone()],
        };
        let kept: Vec<usize> = (0..members.len()).filter(|at| !accepts_wholly(&negation, &members[*at])).collect();
        if kept.len() == members.len() {
            return (ty, reads, from, None, None);
        }
        if kept.is_empty() {
            return (DYN, reads, None, nothing(), None);
        }
        // A member kept is still read from the node it was read from.
        let nodes = type_identity(&ty).and_then(|identity| self.union_nodes.get(&identity)).map(|(_, nodes)| nodes.clone());
        let narrowed = union_of(kept.iter().map(|at| members[*at].clone()));
        let node_of = |at: usize| match &nodes {
            Some(nodes) => nodes.get(at).cloned(),
            None => from.clone(),
        };
        match &narrowed {
            CelType::Union(union) => {
                if nodes.is_some() {
                    let held: Vec<SchemaNodeAt> = union
                        .members()
                        .iter()
                        .map(|member| node_of(members.iter().position(|held| same_type(held, member)).expect("a kept member")).expect("a member's node"))
                        .collect();
                    let identity = type_identity(&narrowed).expect("a union has an identity");
                    self.union_nodes.insert(identity, (narrowed.clone(), held));
                }
                (narrowed, reads, from, None, None)
            }
            single => {
                let node = node_of(members.iter().position(|held| same_type(held, single)).expect("a kept member"));
                (narrowed, reads, node, None, None)
            }
        }
    }

    /// A container type this conversion built, with the reads of each of its members and
    /// the node each was read from.
    fn with_edges(&mut self, ty: CelType, members: MemberReads, nodes: HashMap<EdgeKey, SchemaNodeAt>) -> CelType {
        let identity = type_identity(&ty).expect("a container type has an identity");
        self.edges.insert(identity, (ty.clone(), members));
        self.member_nodes.insert(identity, nodes);
        ty
    }

    /// A union of branches. A branch the union kept is read as a member; one it dropped as
    /// equal to another, or that a `dyn` absorbed, is read whole. Each member is read from
    /// the first branch holding it, and a union that kept one branch's type alone was read
    /// from that branch.
    fn union_read(&mut self, read: Vec<Value>, keyword: &'static str) -> Value {
        // A branch admitting no value is no alternative.
        let (dropped, branches): (Vec<Value>, Vec<Value>) = read.into_iter().partition(|(_, _, _, none, _)| none.is_some());
        let dropped: Vec<Arc<SchemaReads>> = dropped.into_iter().map(|(_, reads, ..)| reads).collect();
        if branches.is_empty() {
            return (DYN, self.joined(dropped), None, Some(vec![keyword]), None);
        }
        // A union of finite sets is finite; one branch that is not makes the union not.
        let values = branches
            .iter()
            .all(|(.., values)| values.is_some())
            .then(|| united_values(branches.iter().filter_map(|(.., values)| values.as_ref())));
        let ty = union_of(branches.iter().map(|(ty, ..)| ty.clone()));
        let from = match &ty {
            CelType::Union(union) => {
                let nodes: Vec<SchemaNodeAt> = union
                    .members()
                    .iter()
                    .map(|member| self.branch_node(&branches, member).expect("a member comes from a branch"))
                    .collect();
                let identity = type_identity(&ty).expect("a union has an identity");
                self.union_nodes.insert(identity, (ty.clone(), nodes));
                None
            }
            single => branches.iter().find(|(branch, ..)| same_type(branch, single)).and_then(|(_, _, node, ..)| node.clone()),
        };
        let (ty, reads) = self.union_reads(ty, branches.into_iter().map(|(ty, reads, ..)| (ty, reads)).collect(), dropped);
        (ty, reads, from, None, values)
    }

    /// What reading a union of branches reads: a branch the union kept is read as a member;
    /// one it dropped as equal to another, or that a `dyn` absorbed, is read whole — the
    /// union's answer rests on it.
    fn union_reads(&mut self, ty: CelType, branches: Vec<(CelType, Arc<SchemaReads>)>, dropped: Vec<Arc<SchemaReads>>) -> (CelType, Arc<SchemaReads>) {
        let mut kept = Vec::new();
        let mut whole = Vec::new();
        for (branch, reads) in branches {
            if kept_in(&ty, &branch) {
                kept.push(reads);
            } else {
                whole.push((branch, reads));
            }
        }
        kept.extend(dropped);
        let joined = self.joined(kept);
        if whole.is_empty() {
            return (ty, joined);
        }
        let whole = self.whole_reads(whole);
        (ty, self.joined(vec![joined, whole]))
    }

    /// [`joined_reads`], counting what a joined reading holds.
    fn joined(&mut self, parts: Vec<Arc<SchemaReads>>) -> Arc<SchemaReads> {
        let addresses: Vec<*const SchemaReads> = parts.iter().map(Arc::as_ptr).collect();
        let reads = joined_reads(parts);
        if !reads.parts.is_empty() && !addresses.contains(&Arc::as_ptr(&reads)) {
            self.reads_entries += reads.parts.len();
        }
        reads
    }

    /// [`node_read`], counting the node it reads.
    fn node_read(&mut self, document: &Arc<JsonValue>, pointer: &Pointer, reads: Arc<SchemaReads>) -> Arc<SchemaReads> {
        self.reads_entries += 1;
        node_read(document, pointer, reads)
    }

    /// The type a node read as itself, and that node.
    fn this_node(&mut self, visit: &Visit, ty: CelType) -> Value {
        let reads = self.node_read(&visit.base, &visit.pointer, no_schema_reads());
        (ty, reads, Some(SchemaNodeAt { document: Arc::clone(&visit.base), pointer: visit.pointer.clone() }), None, None)
    }

    /// A reading of types read whole.
    fn whole_reads(&mut self, whole: Vec<(CelType, Arc<SchemaReads>)>) -> Arc<SchemaReads> {
        self.reads_entries += whole.len();
        Arc::new(SchemaReads { nodes: Vec::new(), whole, parts: Vec::new() })
    }

    /// The node the first branch holding a member read it from.
    fn branch_node(&self, branches: &[Value], member: &CelType) -> Option<SchemaNodeAt> {
        for (branch, _, node, ..) in branches {
            if same_type(branch, member) {
                return node.clone();
            }
            let CelType::Union(union) = branch else { continue };
            if let Some(at) = union.members().iter().position(|held| same_type(held, member)) {
                let held = type_identity(branch).and_then(|identity| self.union_nodes.get(&identity)).and_then(|(_, nodes)| nodes.get(at));
                return held.cloned().or_else(|| node.clone());
            }
        }
        None
    }

    /// A site's meet past the limit, reported at its node and read as [`joined_members`] of
    /// what it met.
    fn joined_past_limit(&mut self, types: &[CelType], at: &Visit, keywords: Vec<&'static str>) -> CelType {
        self.report(at, keywords, UnjudgedReason::ShapeNotRead, None);
        joined_members(types)
    }

    fn report(&mut self, at: &Visit, keywords: Vec<&'static str>, reason: UnjudgedReason, type_name: Option<String>) {
        let mut distinct: Vec<&'static str> = Vec::with_capacity(keywords.len());
        for name in keywords {
            if !distinct.contains(&name) {
                distinct.push(name);
            }
        }
        self.unjudged.push(UnjudgedSchemaNode {
            pointer: at.pointer.text(),
            through_reference: at.through.as_ref().map(Pointer::text),
            keywords: distinct,
            type_name,
            reason,
        });
    }
}



/// Whether a subschema holds nothing but annotations, so every value satisfies it.
fn admits_every_value(node: &JsonValue) -> bool {
    entries(node).is_some_and(|entries| entries.iter().all(|(name, _)| ANNOTATION_KEYWORDS.contains(&name)))
}

/// Whether every value of a type satisfies a `not` subschema holding only `type`, `const`
/// and `enum` among the type keywords: its `type` covers the member and, where it lists
/// values, it lists every value the member has; with no list, no value keyword narrows it.
fn accepts_wholly(negation: &JsonValue, member: &CelType) -> bool {
    let declared = keyword(negation, "type");
    if declared.is_some_and(|declared| !type_covers(declared, member)) {
        return false;
    }
    let mut lists: Vec<Vec<&JsonValue>> = Vec::new();
    if let Some(value) = keyword(negation, "const") {
        lists.push(vec![&**value]);
    }
    if let Some(values) = array_keyword(negation, "enum") {
        lists.push(values.iter().map(|value| &**value).collect());
    }
    if !lists.is_empty() {
        return lists.iter().all(|values| lists_every_value(values, member));
    }
    declared.is_some()
        && entries(negation).is_some_and(|entries| {
            entries.iter().all(|(name, _)| name == "type" || ANNOTATION_KEYWORDS.contains(&name))
        })
}

/// Whether a `type` keyword names a JSON type every value of the member is of.
fn type_covers(declared: &JsonValue, member: &CelType) -> bool {
    let covering: &[&str] = match member {
        CelType::Primitive(PrimitiveName::Null) => &["null"],
        CelType::Primitive(PrimitiveName::Bool) => &["boolean"],
        CelType::Primitive(PrimitiveName::String) => &["string"],
        CelType::Primitive(PrimitiveName::Int | PrimitiveName::Uint) => &["integer", "number"],
        CelType::Primitive(PrimitiveName::Double) => &["number"],
        CelType::Record(_) | CelType::Map(_) => &["object"],
        CelType::List(_) => &["array"],
        _ => &[],
    };
    let names: Vec<&JsonValue> = match declared {
        JsonValue::Array(items) => items.iter().map(|item| &**item).collect(),
        other => vec![other],
    };
    names.into_iter().any(|name| matches!(name, JsonValue::String(name) if covering.contains(&name.as_str())))
}

/// Whether a list of values holds every value of the member: only a null or a bool has so few.
fn lists_every_value(values: &[&JsonValue], member: &CelType) -> bool {
    match member {
        CelType::Primitive(PrimitiveName::Null) => values.iter().any(|value| matches!(value, JsonValue::Null)),
        CelType::Primitive(PrimitiveName::Bool) => {
            values.iter().any(|value| matches!(value, JsonValue::Bool(true)))
                && values.iter().any(|value| matches!(value, JsonValue::Bool(false)))
        }
        _ => false,
    }
}

/// Everything a reader observes of a container a meet built: its kind, each member's type by
/// identity, a record's name, sets, absent names and pattern texts, and each member's holders —
/// an absent one's marked where a part declares it so, since only then is it placed. The unique
/// key covers every side-table entry placement or the listing reads.
fn container_key(built: &CelType, placed: &[(EdgeKey, Vec<Arc<Holder>>, Option<bool>)]) -> String {
    use std::fmt::Write;
    let mut key = String::new();
    let optional = |ty: Option<&CelType>| ty.map_or_else(|| "-".to_string(), type_key);
    match built {
        CelType::Record(record) => {
            let _ = write!(key, "r{:?}(", record.name);
            for (name, ty) in record.fields.iter() {
                let _ = write!(key, "{name:?}:{}{:?},", type_key(ty), record.field_enum(name));
            }
            let _ = write!(key, "){:?}{}", record.absent_fields().collect::<Vec<_>>(), optional(record.additional_fields()));
            for part in 0..record.pattern_part_count() {
                key.push('[');
                for at in record.part_entries(part) {
                    let (pattern, ty) = record.pattern_at(at);
                    let _ = write!(key, "{pattern:?}:{},", optional(ty));
                }
                let _ = write!(key, "|{}]", optional(record.part_additional(part)));
            }
        }
        CelType::Map(map) => {
            let _ = write!(key, "m{},{}", type_key(&map.key), type_key(&map.value));
        }
        CelType::List(list) => match list.prefix_elements() {
            Some(prefix) => {
                let _ = write!(key, "t{}|{}", prefix.iter().map(type_key).collect::<Vec<_>>().join(","), optional(list.additional_elements()));
            }
            None => {
                let _ = write!(key, "l{}", type_key(&list.element));
            }
        },
        CelType::Optional(optional) => {
            let _ = write!(key, "o{}", type_key(&optional.value));
        }
        _ => unreachable!("a meet builds no other container"),
    }
    key.push('/');
    for (edge, held, absent) in placed {
        let mark = match absent {
            Some(true) => "!",
            Some(false) => "~",
            None => "",
        };
        let _ = write!(key, "{mark}{edge:?}=");
        for holder in held {
            let _ = write!(key, "{:p},", Arc::as_ptr(holder));
        }
        key.push(';');
    }
    key
}

// --- intersection ----------------------------------------------------------------

/// A member position two containers meet at: a member's edge key, or what each side stands
/// on for a member a meeting built from both sides' pattern parts — per side, each edge and
/// whether it types the member other than `dyn`.
#[derive(Clone)]
enum Position {
    Edge(EdgeKey),
    Sides(Arc<[Vec<(EdgeKey, bool)>; 2]>),
}

impl Position {
    fn member(name: &str) -> Position {
        Position::Edge(EdgeKey::member(name))
    }
}

/// What a conversion is told of each container meeting, with the two sides in the order their
/// parts were written: the member positions it is about to meet (`compare`), and the container
/// it built (`place`), with what each member of a record met from pattern parts stands on.
trait Meeting {
    fn compare(&mut self, first: &CelType, second: &CelType, keys: &[Position]);
    /// The container the conversion keeps for one a meet built.
    fn place(&mut self, built: CelType, first: &CelType, second: &CelType, positions: &HashMap<EdgeKey, Position>) -> CelType;
    /// The union the conversion keeps for one a meet built.
    fn union(&mut self, built: CelType) -> CelType;
    /// A union meet would have built more members than [`UNION_EXPANSION_LIMIT`].
    fn past_limit(&mut self);
    /// The meets answered so far.
    fn answers(&self) -> &MeetAnswers;
    /// Where a meet in `mode` begins: how much has been compared, and whether the limit was
    /// passed before it — cleared, so the meet's own passing is told apart.
    fn begin(&mut self, mode: u8) -> (usize, bool);
    /// A meet begun at `mark` answered `ty`: what it compared since is folded into one reading,
    /// and the answer remembered.
    fn answer(&mut self, mode: u8, left: &CelType, right: &CelType, ty: Option<CelType>, mark: (usize, bool));
    /// A meet answered before is met again: its comparison is pushed where it would have been,
    /// and its passing of the limit marked again.
    fn replay(&mut self, compared: Arc<SchemaReads>, past: bool);
}

/// A meeting of one conversion's types, collecting what it compares: at every member position
/// several parts hold, the reads of each part holding it as `dyn`, and where several parts
/// type it other than `dyn`, the reads of each of those.
struct PartMeeting<'r, 'c, 'a> {
    reader: &'r mut SchemaReader<'c, 'a>,
    compared: Vec<Arc<SchemaReads>>,
    /// Whether a union meet went past the limit.
    past_limit: bool,
}

impl Meeting for PartMeeting<'_, '_, '_> {
    fn compare(&mut self, first: &CelType, second: &CelType, keys: &[Position]) {
        for key in keys {
            let held = self.reader.held_by_both(first, second, key);
            if held.len() < 2 {
                continue;
            }
            let typed = held.iter().filter(|holder| holder.typed).count();
            self.compared.extend(held.iter().filter(|holder| !holder.typed || typed > 1).map(|holder| Arc::clone(&holder.reads)));
        }
    }

    fn place(&mut self, built: CelType, first: &CelType, second: &CelType, positions: &HashMap<EdgeKey, Position>) -> CelType {
        self.reader.place(built, first, second, positions)
    }

    fn union(&mut self, built: CelType) -> CelType {
        self.reader.union(built)
    }

    fn past_limit(&mut self) {
        self.past_limit = true;
    }

    fn answers(&self) -> &MeetAnswers {
        &self.reader.answers
    }

    fn begin(&mut self, mode: u8) -> (usize, bool) {
        if mode == QUIET {
            return (self.compared.len(), false);
        }
        let outer = self.past_limit;
        self.past_limit = false;
        (self.compared.len(), outer)
    }

    fn answer(&mut self, mode: u8, left: &CelType, right: &CelType, ty: Option<CelType>, (from, outer): (usize, bool)) {
        if let Some(met) = &ty {
            if let (CelType::Union(_), Some(at)) = (met, type_identity(met)) {
                if type_identity(left) != Some(at) && type_identity(right) != Some(at) {
                    self.reader.met_unions.entry(at).or_insert_with(|| met.clone());
                }
            }
        }
        if mode == QUIET {
            self.reader.answers.set(mode, left, right, ty, no_schema_reads(), false);
            return;
        }
        let folded: Vec<Arc<SchemaReads>> = self.compared.split_off(from);
        let compared = self.reader.joined(folded);
        if !Arc::ptr_eq(&compared, &no_schema_reads()) {
            self.compared.push(Arc::clone(&compared));
        }
        let past = self.past_limit;
        self.past_limit = outer || past;
        self.reader.answers.set(mode, left, right, ty, compared, past);
    }

    fn replay(&mut self, compared: Arc<SchemaReads>, past: bool) {
        if !Arc::ptr_eq(&compared, &no_schema_reads()) {
            self.compared.push(compared);
        }
        if past {
            self.past_limit = true;
        }
    }
}

/// A meeting nothing observes: the meet outside a conversion, answering each pair once.
#[derive(Default)]
struct Unobserved {
    answers: MeetAnswers,
}

impl Meeting for Unobserved {
    fn compare(&mut self, _: &CelType, _: &CelType, _: &[Position]) {}
    fn place(&mut self, built: CelType, _: &CelType, _: &CelType, _: &HashMap<EdgeKey, Position>) -> CelType {
        built
    }
    fn union(&mut self, built: CelType) -> CelType {
        built
    }
    fn past_limit(&mut self) {}
    fn answers(&self) -> &MeetAnswers {
        &self.answers
    }
    fn begin(&mut self, _: u8) -> (usize, bool) {
        (0, false)
    }
    fn answer(&mut self, mode: u8, left: &CelType, right: &CelType, ty: Option<CelType>, _: (usize, bool)) {
        self.answers.set(mode, left, right, ty, no_schema_reads(), false);
    }
    fn replay(&mut self, _: Arc<SchemaReads>, _: bool) {}
}

/// The mode of a meeting nothing observes: a decision, or a meet outside a conversion.
const QUIET: u8 = 2;

/// What a meet past [`UNION_EXPANSION_LIMIT`] stands as: the one type joining every member of
/// its operands, records of several shapes joining as a map — wider than the meet, so no read
/// the meet admits is refused.
fn joined_members(types: &[CelType]) -> CelType {
    let mut members = types.iter().flat_map(|ty| match ty {
        CelType::Union(union) => union.members().to_vec(),
        other => vec![other.clone()],
    });
    let first = members.next().expect("a type met");
    members.fold(first, |joined, member| unify(&joined, &member))
}

/// The one type both admit, or nothing when they cannot both hold — the conversion's meet,
/// outside a conversion.
pub(crate) fn meet_types(left: &CelType, right: &CelType) -> Option<CelType> {
    intersect_types(left, right, &mut Unobserved::default())
}

/// The members a container holds at a position a meeting names, each with the edge it is read
/// through: a declared field; else its pattern parts' reading of it — none where a matching
/// entry admits no value — else the undeclared members standing for it — none where it is
/// declared absent or the record is closed; for a pattern part's edge, the entry or undeclared
/// members it keys; a map's value, a plain list's element, a tuple's position or its rest past
/// them.
fn members_at<'t>(side: &'t CelType, position: &EdgeKey) -> Vec<(EdgeKey, &'t CelType)> {
    match side {
        CelType::Record(record) => {
            match position {
                EdgeKey::Member(name) => {
                    if let Some(field) = record.fields.get(name) {
                        return vec![(EdgeKey::Member(name.clone()), field)];
                    }
                    if record.is_absent(name) {
                        return Vec::new();
                    }
                    if let Some(standing) = pattern_standing(record, name) {
                        let entries: Option<Vec<(EdgeKey, &CelType)>> = standing.into_iter().map(|(edge, ty)| ty.map(|ty| (edge, ty))).collect();
                        return entries.unwrap_or_default();
                    }
                }
                EdgeKey::Pattern(at) => {
                    return (*at < record.pattern_count())
                        .then(|| record.pattern_at(*at).1)
                        .flatten()
                        .map(|ty| (position.clone(), ty))
                        .into_iter()
                        .collect();
                }
                EdgeKey::PartAdditional(part) => {
                    return (*part < record.pattern_part_count())
                        .then(|| record.part_additional(*part))
                        .flatten()
                        .map(|ty| (position.clone(), ty))
                        .into_iter()
                        .collect();
                }
                EdgeKey::Additional => {}
            }
            record.additional_fields().map(|ty| (EdgeKey::Additional, ty)).into_iter().collect()
        }
        CelType::Map(map) => vec![(EdgeKey::member(ELEMENT_EDGE), &*map.value)],
        CelType::List(list) => match list.prefix_elements() {
            None => vec![(EdgeKey::member(ELEMENT_EDGE), &*list.element)],
            Some(prefix) => {
                let at = match position {
                    EdgeKey::Member(index) => index.parse::<usize>().ok(),
                    EdgeKey::Additional | EdgeKey::Pattern(_) | EdgeKey::PartAdditional(_) => None,
                };
                match at.and_then(|at| prefix.get(at)) {
                    Some(held) => vec![(position.clone(), held)],
                    None => list.additional_elements().map(|ty| (EdgeKey::Additional, ty)).into_iter().collect(),
                }
            }
        },
        _ => Vec::new(),
    }
}

/// Each meeting carries whether it takes its sides in reverse of the order their parts were
/// written, so a container it builds is placed with its sides in that order.
enum Step<'t> {
    Meet(&'t CelType, &'t CelType, bool),
    /// The answer left met again with a type: a field meeting several patterns in turn.
    Fold(&'t CelType, bool),
    Union(usize),
    Records(RecordMeet<'t>),
    RecordWithMap { record: &'t RecordType, sides: Sides<'t> },
    Map(Sides<'t>),
    List(Sides<'t>),
    /// A tuple of the position meetings left — ending at the first that failed, or at
    /// `positions` where a side has no position there — then the rest's when `rest`.
    Tuple { positions: usize, rest: bool, sides: Sides<'t> },
    Optional(Sides<'t>),
    /// Two records' pattern parts grouped, resuming after a decision met before it — whether
    /// two parts' undeclared members can meet — then the records planned.
    RecordGroups(Box<GroupsPlan<'t>>),
    /// Meetings between a `true` and its `false` are decisions, which nothing observes.
    Quiet(bool),
    /// The answer left is the meet of the pair in `mode`, begun at `mark`.
    Answered { mode: u8, left: &'t CelType, right: &'t CelType, mark: (usize, bool) },
}

/// Two records a meeting is about to meet, held while their pattern parts are grouped: the
/// fields, absent names and undeclared members already planned, with the steps meeting them and
/// the positions comparing them, and the parts, each by an identity a decision is recorded
/// against.
struct GroupsPlan<'t> {
    a: &'t RecordType,
    sides: Sides<'t>,
    reversed: bool,
    fields: Vec<(&'t str, Option<&'t CelType>)>,
    enums: Vec<FieldSets<'t>>,
    absent: Vec<Arc<str>>,
    additional: bool,
    keys: Vec<Position>,
    steps: Vec<Step<'t>>,
    groups: Vec<(usize, PartGroup<'t>)>,
    next: usize,
    /// Pairs of parts whose undeclared members were found to meet, and found not to.
    joinable: Vec<(usize, usize)>,
    apart: Vec<(usize, usize)>,
    /// The pair whose decision is the answer on top of the results.
    pending: Option<(usize, usize)>,
}

impl<'t> GroupsPlan<'t> {
    /// Groups the parts as far as the decisions made allow: `part_groups` in
    /// `json-schema-type.ts`. Parts with the same pattern texts are one part, their entries met by
    /// text and their undeclared members met — unless those cannot meet, when the parts stay apart;
    /// parts with no undeclared members are one part. Answers the pair a decision is still owed
    /// for, or nothing once the parts are grouped.
    fn advance(&mut self) -> Option<(usize, usize)> {
        loop {
            let mut merged = false;
            'pairs: for at in 0..self.groups.len() {
                for other in at + 1..self.groups.len() {
                    let ((left, first), (right, second)) = (&self.groups[at], &self.groups[other]);
                    if !same_texts(first, second) {
                        continue;
                    }
                    let pair = (*left, *right);
                    if !first.additional.is_empty() && !second.additional.is_empty() {
                        if self.apart.contains(&pair) {
                            continue;
                        }
                        if !self.joinable.contains(&pair) {
                            return Some(pair);
                        }
                    }
                    let one = merged_group(first, second);
                    self.groups.remove(other);
                    self.groups[at] = (self.next, one);
                    self.next += 1;
                    merged = true;
                    break 'pairs;
                }
            }
            if !merged {
                let bare: Vec<usize> = (0..self.groups.len()).filter(|at| self.groups[*at].1.additional.is_empty()).collect();
                if bare.len() > 1 {
                    let one = bare[1..].iter().fold(self.groups[bare[0]].1.clone(), |held, at| merged_group(&held, &self.groups[*at].1));
                    self.groups[bare[0]] = (self.next, one);
                    self.next += 1;
                    for at in bare[1..].iter().rev() {
                        self.groups.remove(*at);
                    }
                    merged = true;
                }
            }
            if !merged {
                return None;
            }
        }
    }

    /// The parts the records' meet carries, once grouped: none where no part holds a pattern,
    /// and a part left alone carrying no undeclared members.
    fn grouped(&mut self) -> Vec<PartGroup<'t>> {
        let mut groups: Vec<PartGroup<'t>> = std::mem::take(&mut self.groups).into_iter().map(|(_, group)| group).collect();
        if groups.iter().all(|group| group.entries.is_empty()) {
            return Vec::new();
        }
        if let [only] = groups.as_mut_slice() {
            only.additional.clear();
        }
        groups
    }

    /// Both parts' undeclared members, in written order: what a decision meets.
    fn undeclared(&self, (left, right): (usize, usize)) -> Vec<&'t CelType> {
        let mut sources: Vec<&PartSource<'t>> = self
            .groups
            .iter()
            .filter(|(id, _)| *id == left || *id == right)
            .flat_map(|(_, group)| group.additional.iter())
            .collect();
        sources.sort_by_key(|source| source.which);
        sources.into_iter().filter_map(|source| source.ty).collect()
    }
}

/// How two records meet: each field in order, met (one answer left) or kept as declared;
/// the undeclared members met when both sides type them; the names absent; each pattern
/// part's entries and undeclared members, met (one answer left) or kept; and what each
/// member built from the parts stands on.
struct RecordMeet<'t> {
    left: &'t RecordType,
    fields: Vec<(&'t str, Option<&'t CelType>)>,
    /// Beside each field, the finite set each side declares it with.
    enums: Vec<FieldSets<'t>>,
    additional: bool,
    absent: Vec<Arc<str>>,
    parts: Vec<(Vec<(&'t str, PartPlan<'t>)>, PartPlan<'t>)>,
    positions: HashMap<EdgeKey, Position>,
    sides: Sides<'t>,
}

/// A member of a part two records' meet carries: kept as one source gave it (none: no value),
/// or met from several (one answer left).
enum PartPlan<'t> {
    Kept(Option<&'t CelType>),
    Met,
}

/// One side's entry or undeclared members a part met from both sides stands on: the side,
/// its edge there, and its type — none: no value.
#[derive(Clone)]
struct PartSource<'t> {
    which: usize,
    edge: EdgeKey,
    ty: Option<&'t CelType>,
}

/// A part of a record two records meet: its entries by text, each with its sources, and the
/// sources of its undeclared members.
#[derive(Clone)]
struct PartGroup<'t> {
    entries: Vec<(&'t str, Vec<PartSource<'t>>)>,
    additional: Vec<PartSource<'t>>,
}

fn side_groups<'t>(record: &'t RecordType, which: usize) -> Vec<PartGroup<'t>> {
    let entries = |part: usize| -> Vec<(&'t str, Vec<PartSource<'t>>)> {
        record
            .part_entries(part)
            .map(|at| {
                let (pattern, ty) = record.pattern_at(at);
                (pattern, vec![PartSource { which, edge: EdgeKey::Pattern(at), ty }])
            })
            .collect()
    };
    let parts = record.pattern_part_count();
    if parts > 1 {
        return (0..parts)
            .map(|part| PartGroup {
                entries: entries(part),
                additional: record
                    .part_additional(part)
                    .map(|ty| PartSource { which, edge: EdgeKey::PartAdditional(part), ty: Some(ty) })
                    .into_iter()
                    .collect(),
            })
            .collect();
    }
    vec![PartGroup {
        entries: if parts == 0 { Vec::new() } else { entries(0) },
        additional: record
            .additional_fields()
            .filter(|ty| !is_dyn(ty))
            .map(|ty| PartSource { which, edge: EdgeKey::Additional, ty: Some(ty) })
            .into_iter()
            .collect(),
    }]
}

fn same_texts(left: &PartGroup, right: &PartGroup) -> bool {
    left.entries.len() == right.entries.len() && left.entries.iter().all(|(pattern, _)| right.entries.iter().any(|(other, _)| other == pattern))
}

/// Two parts as one: the first's entries in order, then the second's it lacks, entries of one
/// text met.
fn merged_group<'t>(left: &PartGroup<'t>, right: &PartGroup<'t>) -> PartGroup<'t> {
    let mut entries: Vec<(&'t str, Vec<PartSource<'t>>)> = left
        .entries
        .iter()
        .map(|(pattern, sources)| {
            let mut sources = sources.clone();
            if let Some((_, other)) = right.entries.iter().find(|(held, _)| held == pattern) {
                sources.extend(other.iter().cloned());
            }
            (*pattern, sources)
        })
        .collect();
    entries.extend(right.entries.iter().filter(|(pattern, _)| !left.entries.iter().any(|(held, _)| held == pattern)).cloned());
    PartGroup { entries, additional: left.additional.iter().chain(&right.additional).cloned().collect() }
}

/// How a member of a part two records' meet carries is built from its sources, in written
/// order: kept where one gives it or one admits no value, else met.
fn part_plan<'t>(sources: &[PartSource<'t>], reversed: bool, parts: &mut Vec<Step<'t>>) -> PartPlan<'t> {
    let mut ordered: Vec<&PartSource<'t>> = sources.iter().collect();
    ordered.sort_by_key(|source| source.which);
    let types: Option<Vec<&'t CelType>> = ordered.iter().map(|source| source.ty).collect();
    match types.as_deref() {
        None | Some([]) => PartPlan::Kept(None),
        Some([only]) => PartPlan::Kept(Some(only)),
        Some([first, second, rest @ ..]) => {
            parts.push(Step::Meet(first, second, reversed));
            parts.extend(rest.iter().map(|next| Step::Fold(next, reversed)));
            PartPlan::Met
        }
    }
}

/// What one side holds for a member a meeting built from pattern parts: each source of a side
/// that types it.
fn source_position(sources: &[PartSource], reversed: bool) -> Position {
    let side = |which: usize| -> Vec<(EdgeKey, bool)> {
        sources.iter().filter(|source| source.which == which).filter_map(|source| source.ty.map(|ty| (source.edge.clone(), !is_dyn(ty)))).collect()
    };
    let (first, second) = if reversed { (side(1), side(0)) } else { (side(0), side(1)) };
    Position::Sides(Arc::new([first, second]))
}

/// What stands on a record for a member it does not declare, as types a field meets: its
/// pattern parts' reading of it, or its undeclared members' where those say a type — nothing
/// where the name is absent there.
fn standing_for<'t>(record: &'t RecordType, name: &str) -> Option<Vec<&'t CelType>> {
    if let Some(standing) = pattern_standing(record, name) {
        let types: Option<Vec<&CelType>> = standing.into_iter().map(|(_, ty)| ty).collect();
        return types.map(|types| types.into_iter().filter(|ty| !is_dyn(ty)).collect());
    }
    Some(record.additional_fields().filter(|ty| !is_dyn(ty)).into_iter().collect())
}

/// Types an intersection meets again after building them, each held at an address that lasts
/// as long as the intersection: a chain only ever extended.
#[derive(Default)]
struct HeldTypes {
    first: OnceCell<Box<HeldType>>,
}

struct HeldType {
    ty: CelType,
    next: OnceCell<Box<HeldType>>,
}

impl HeldTypes {
    fn hold(&self, ty: CelType) -> &CelType {
        let mut slot = &self.first;
        while let Some(held) = slot.get() {
            slot = &held.next;
        }
        &slot.get_or_init(|| Box::new(HeldType { ty, next: OnceCell::new() })).ty
    }
}

impl Drop for HeldTypes {
    /// Lets go of the chain link by link, so a long one costs no stack.
    fn drop(&mut self) {
        let mut next = self.first.take();
        while let Some(mut held) = next {
            next = held.next.take();
        }
    }
}

/// The two sides a container was built from, in the order their parts were written.
type Sides<'t> = (&'t CelType, &'t CelType);

/// The finite sets two records declare one field with, each where it does.
type FieldSets<'t> = (Option<&'t [FieldEnumValue]>, Option<&'t [FieldEnumValue]>);

fn in_order<'t>(left: &'t CelType, right: &'t CelType, reversed: bool) -> Sides<'t> {
    if reversed {
        (right, left)
    } else {
        (left, right)
    }
}

/// The kinds two of which meet member by member even where they are equal; a union pairs instead.
fn is_container(ty: &CelType) -> bool {
    matches!(ty, CelType::Record(_) | CelType::Map(_) | CelType::List(_) | CelType::Optional(_))
}

/// Whether a meet of the two is answered from the conversion's table: two containers, or a union.
fn answered_once(left: &CelType, right: &CelType) -> bool {
    matches!(left, CelType::Union(_)) || matches!(right, CelType::Union(_)) || (is_container(left) && is_container(right))
}

/// The type a list holds at a position: a tuple's position or rest, a plain list's element.
fn position_of(list: &ListType, at: usize) -> Option<&CelType> {
    match list.prefix_elements() {
        None => Some(&list.element),
        Some(prefix) => prefix.get(at).or(list.additional_elements()),
    }
}

fn rest_of(list: &ListType) -> Option<&CelType> {
    match list.prefix_elements() {
        None => Some(&list.element),
        Some(_) => list.additional_elements(),
    }
}

/// The pairs of types one intersection has judged equal or not, by address — every type
/// it reaches is borrowed for the whole intersection. Asking whether two parts are equal
/// at every level of a descent so judges each pair of types once, and one question stops
/// at the first pair that differs, as Node's `typesEqual` does.
#[derive(Default)]
struct JudgedPairs {
    held: HashMap<(usize, usize), bool>,
}

fn address(ty: &CelType) -> usize {
    ty as *const CelType as usize
}

impl JudgedPairs {
    /// [`types_equal`](crate::types_equal), remembering every pair it judges: a pair
    /// whose children all agree is equal, and every pair still open when one differs is
    /// not.
    fn equal(&mut self, left: &CelType, right: &CelType) -> bool {
        enum Visit<'t> {
            Enter(&'t CelType, &'t CelType),
            Leave,
        }
        let mut pending = vec![Visit::Enter(left, right)];
        let mut open: Vec<(usize, usize)> = Vec::new();
        while let Some(visit) = pending.pop() {
            let (left, right) = match visit {
                Visit::Enter(left, right) => (left, right),
                Visit::Leave => {
                    let pair = open.pop().expect("a pair is open");
                    self.held.insert(pair, true);
                    continue;
                }
            };
            let pair = (address(left), address(right));
            let equal = match self.held.get(&pair) {
                Some(judged) => *judged,
                None => {
                    let mut beneath = Vec::new();
                    let agrees = equal_at_own_level(left, right, |a, b| beneath.push(Visit::Enter(a, b)));
                    if agrees {
                        open.push(pair);
                        pending.push(Visit::Leave);
                        pending.extend(beneath);
                    }
                    agrees
                }
            };
            if !equal {
                self.held.insert(pair, false);
                self.held.extend(open.into_iter().map(|pair| (pair, false)));
                return false;
            }
        }
        true
    }
}

/// The one type both admit, or nothing when they cannot both hold: records merge
/// field-wise — the left's fields first, closed beating open — a record meets a map's
/// value type field by field, and otherwise the narrower of the two wins. Two containers
/// meet member by member even where they are equal, and two equal unions member by member
/// at matching positions, so each member is declared by both sides and the met type equals
/// each side's; `meeting` is told of each container meeting, with its sides in written order.
fn intersect_types(left: &CelType, right: &CelType, meeting: &mut dyn Meeting) -> Option<CelType> {
    let held = HeldTypes::default();
    let mut judged = JudgedPairs::default();
    let mut steps = vec![Step::Meet(left, right, false)];
    let mut results: Vec<Option<CelType>> = Vec::new();
    // How many decisions are open: their meetings are observed by nothing.
    let mut quiet = 0usize;
    let take = |results: &mut Vec<Option<CelType>>, count: usize| results.split_off(results.len() - count);
    while let Some(step) = steps.pop() {
        match step {
            Step::Meet(left, right, reversed) => {
                count_type_visit();
                if is_dyn(left) {
                    results.push(Some(right.clone()));
                    continue;
                }
                let memberwise = (is_container(left) && is_container(right)) || matches!((left, right), (CelType::Union(_), CelType::Union(_)));
                if is_dyn(right) || (!memberwise && judged.equal(left, right)) {
                    results.push(Some(left.clone()));
                    continue;
                }
                // Two containers or a union are met once per conversion and mode: met again, the
                // pair answers what it answered, its comparison replayed where the meet would
                // have pushed it.
                if answered_once(left, right) {
                    let mode = if quiet > 0 { QUIET } else { u8::from(reversed) };
                    if let Some(answer) = meeting.answers().get(mode, left, right) {
                        let (ty, compared, past) = (answer.ty.clone(), Arc::clone(&answer.compared), answer.past);
                        if quiet == 0 {
                            meeting.replay(compared, past);
                        }
                        results.push(ty);
                        continue;
                    }
                    let mark = meeting.begin(mode);
                    steps.push(Step::Answered { mode, left, right, mark });
                }
                let mut parts: Vec<Step<'_>> = Vec::new();
                match (left, right) {
                    // Two equal unions meet member by member at matching positions, the pairing
                    // their equality fixes.
                    (CelType::Union(a), CelType::Union(b)) if judged.equal(left, right) => {
                        steps.push(Step::Union(a.members().len()));
                        parts.extend(a.members().iter().zip(b.members()).map(|(a, b)| Step::Meet(a, b, reversed)));
                    }
                    // A union on the left is the one ranged over; its member is met first, so
                    // a union on the right meets in reverse.
                    (CelType::Union(union), other) | (other, CelType::Union(union)) => {
                        // Distributed, the meet would build a member per pair: past the limit it
                        // stands as the join.
                        let others = match other {
                            CelType::Union(other) => other.members().len(),
                            _ => 1,
                        };
                        if union.members().len() * others > UNION_EXPANSION_LIMIT {
                            if quiet == 0 {
                                meeting.past_limit();
                            }
                            results.push(Some(joined_members(&[left.clone(), right.clone()])));
                            continue;
                        }
                        let reversed = if matches!(left, CelType::Union(_)) { reversed } else { !reversed };
                        steps.push(Step::Union(union.members().len()));
                        parts.extend(union.members().iter().map(|member| Step::Meet(member, other, reversed)));
                    }
                    (CelType::Record(a), CelType::Record(b)) => {
                        // A field one side declares meets what stands for it on the other side: each
                        // pattern there matching it, else its undeclared members where those say a
                        // type; a name either declares absent, or the other's pattern admits no value
                        // for, is absent; closed beats open.
                        let mut absent: Vec<Arc<str>> = a.absent_fields().chain(b.absent_fields()).map(Arc::from).collect();
                        absent.dedup();
                        let names: Vec<&str> = a
                            .fields
                            .keys()
                            .chain(b.fields.keys().filter(|name| !a.fields.contains_key(name)))
                            .filter(|name| !absent.iter().any(|held| &**held == *name))
                            .collect();
                        let mut fields = Vec::new();
                        let mut enums = Vec::new();
                        let mut keys = Vec::new();
                        for name in names {
                            let (held, other) = (a.fields.get(name), b.fields.get(name));
                            let (start, standing, swapped) = match (held, other) {
                                (Some(held), Some(other)) => (held, Some(vec![other]), false),
                                (Some(held), None) => (held, standing_for(b, name), false),
                                (None, Some(other)) => (other, standing_for(a, name), true),
                                (None, None) => unreachable!("a name one side declares"),
                            };
                            let Some(standing) = standing else {
                                absent.push(name.into());
                                continue;
                            };
                            keys.push(Position::member(name));
                            enums.push((a.field_enum(name), b.field_enum(name)));
                            let order = if swapped { !reversed } else { reversed };
                            match standing.split_first() {
                                Some((first, rest)) => {
                                    parts.push(Step::Meet(start, first, order));
                                    parts.extend(rest.iter().map(|next| Step::Fold(next, order)));
                                    fields.push((name, None));
                                }
                                None => fields.push((name, Some(start))),
                            }
                        }
                        let additional = match (a.additional_fields(), b.additional_fields()) {
                            (Some(left), Some(right)) => {
                                parts.push(Step::Meet(left, right, reversed));
                                keys.push(Position::Edge(EdgeKey::Additional));
                                true
                            }
                            _ => false,
                        };
                        // Each side's pattern parts are kept as parts, so every member a pattern
                        // matches is read exactly; they are grouped before anything is compared.
                        let groups: Vec<(usize, PartGroup<'_>)> = side_groups(a, 0)
                            .into_iter()
                            .chain(side_groups(b, 1))
                            .filter(|group| !group.entries.is_empty() || !group.additional.is_empty())
                            .enumerate()
                            .collect();
                        steps.push(Step::RecordGroups(Box::new(GroupsPlan {
                            a,
                            sides: in_order(left, right, reversed),
                            reversed,
                            fields,
                            enums,
                            absent,
                            additional,
                            keys,
                            steps: std::mem::take(&mut parts),
                            next: groups.len(),
                            groups,
                            joinable: Vec::new(),
                            apart: Vec::new(),
                            pending: None,
                        })));
                    }
                    (CelType::Record(record), CelType::Map(map)) | (CelType::Map(map), CelType::Record(record)) => {
                        // The record's members are met first, so a record on the right meets in reverse.
                        let members_reversed = if matches!(left, CelType::Record(_)) { reversed } else { !reversed };
                        let sides = in_order(left, right, reversed);
                        let mut keys: Vec<Position> = record.fields.keys().map(Position::member).collect();
                        if record.additional_fields().is_some() {
                            keys.push(Position::Edge(EdgeKey::Additional));
                        }
                        for part in 0..record.pattern_part_count() {
                            keys.extend(record.part_entries(part).map(|at| Position::Edge(EdgeKey::Pattern(at))));
                            if record.part_additional(part).is_some() {
                                keys.push(Position::Edge(EdgeKey::PartAdditional(part)));
                            }
                        }
                        if quiet == 0 {
                            meeting.compare(sides.0, sides.1, &keys);
                        }
                        steps.push(Step::RecordWithMap { record, sides });
                        parts.extend(record.fields.values().map(|ty| Step::Meet(ty, &map.value, members_reversed)));
                        if let Some(additional) = record.additional_fields() {
                            parts.push(Step::Meet(additional, &map.value, members_reversed));
                        }
                        parts.extend(record.pattern_fields().filter_map(|(_, ty)| ty).map(|ty| Step::Meet(ty, &map.value, members_reversed)));
                        parts.extend(
                            (0..record.pattern_part_count())
                                .filter_map(|part| record.part_additional(part))
                                .map(|ty| Step::Meet(ty, &map.value, members_reversed)),
                        );
                    }
                    (CelType::Map(a), CelType::Map(b)) => {
                        let sides = in_order(left, right, reversed);
                        if quiet == 0 {
                            meeting.compare(sides.0, sides.1, &[Position::member(ELEMENT_EDGE)]);
                        }
                        steps.push(Step::Map(sides));
                        parts.push(Step::Meet(&a.key, &b.key, reversed));
                        parts.push(Step::Meet(&a.value, &b.value, reversed));
                    }
                    (CelType::List(a), CelType::List(b)) if a.prefix_elements().is_none() && b.prefix_elements().is_none() => {
                        let sides = in_order(left, right, reversed);
                        if quiet == 0 {
                            meeting.compare(sides.0, sides.1, &[Position::member(ELEMENT_EDGE)]);
                        }
                        steps.push(Step::List(sides));
                        parts.push(Step::Meet(&a.element, &b.element, reversed));
                    }
                    // Where either is a tuple, position by position, ending where either side has
                    // no position.
                    (CelType::List(a), CelType::List(b)) => {
                        let length = a.prefix_elements().map_or(0, <[CelType]>::len).max(b.prefix_elements().map_or(0, <[CelType]>::len));
                        let mut keys = Vec::new();
                        let mut ended = false;
                        for at in 0..length {
                            match (position_of(a, at), position_of(b, at)) {
                                (Some(left), Some(right)) => {
                                    parts.push(Step::Meet(left, right, reversed));
                                    keys.push(Position::Edge(EdgeKey::Member(at.to_string())));
                                }
                                _ => {
                                    ended = true;
                                    break;
                                }
                            }
                        }
                        let positions = keys.len();
                        let rest = match (ended, rest_of(a), rest_of(b)) {
                            (false, Some(left), Some(right)) => {
                                parts.push(Step::Meet(left, right, reversed));
                                keys.push(Position::Edge(EdgeKey::Additional));
                                true
                            }
                            _ => false,
                        };
                        let sides = in_order(left, right, reversed);
                        if quiet == 0 {
                            meeting.compare(sides.0, sides.1, &keys);
                        }
                        steps.push(Step::Tuple { positions, rest, sides });
                    }
                    (CelType::Optional(a), CelType::Optional(b)) => {
                        steps.push(Step::Optional(in_order(left, right, reversed)));
                        parts.push(Step::Meet(&a.value, &b.value, reversed));
                    }
                    _ => {
                        // JSON Schema's `integer` is a `number`: an integer met with a double is the integer.
                        results.push(if assignable(left, right) || (is_integral(left) && is_double(right)) {
                            Some(left.clone())
                        } else if assignable(right, left) || (is_integral(right) && is_double(left)) {
                            Some(right.clone())
                        } else {
                            None
                        });
                        continue;
                    }
                }
                steps.extend(parts.into_iter().rev());
            }
            Step::Fold(with, reversed) => match results.pop().expect("the answer folded") {
                Some(met) => steps.push(Step::Meet(held.hold(met), with, reversed)),
                None => results.push(None),
            },
            Step::Union(count) => {
                let met: Vec<CelType> = take(&mut results, count).into_iter().flatten().collect();
                results.push(match met.is_empty() {
                    true => None,
                    false if quiet == 0 => Some(meeting.union(union_of(met))),
                    false => Some(union_of(met)),
                });
            }
            Step::Answered { mode, left, right, mark } => {
                let ty = results.last().expect("the meet answered").clone();
                meeting.answer(mode, left, right, ty, mark);
            }
            Step::Quiet(entering) => {
                if entering {
                    quiet += 1;
                } else {
                    quiet -= 1;
                }
            }
            Step::RecordGroups(mut plan) => {
                if let Some(pair) = plan.pending.take() {
                    match results.pop().expect("the decision's meeting") {
                        Some(_) => plan.joinable.push(pair),
                        None => plan.apart.push(pair),
                    }
                }
                if let Some(pair) = plan.advance() {
                    // Whether the two parts' undeclared members meet, decided before grouping goes on.
                    let undeclared = plan.undeclared(pair);
                    plan.pending = Some(pair);
                    steps.push(Step::RecordGroups(plan));
                    steps.push(Step::Quiet(false));
                    steps.extend(undeclared[2..].iter().rev().map(|next| Step::Fold(next, false)));
                    steps.push(Step::Meet(undeclared[0], undeclared[1], false));
                    steps.push(Step::Quiet(true));
                    continue;
                }
                let reversed = plan.reversed;
                let mut keys = std::mem::take(&mut plan.keys);
                let mut parts = std::mem::take(&mut plan.steps);
                let mut positions = HashMap::new();
                let mut planned = Vec::new();
                let mut flat = 0;
                for (part, group) in plan.grouped().into_iter().enumerate() {
                    let mut entries = Vec::with_capacity(group.entries.len());
                    for (pattern, sources) in &group.entries {
                        entries.push((*pattern, part_plan(sources, reversed, &mut parts)));
                        let position = source_position(sources, reversed);
                        keys.push(position.clone());
                        positions.insert(EdgeKey::Pattern(flat), position);
                        flat += 1;
                    }
                    let undeclared = part_plan(&group.additional, reversed, &mut parts);
                    if !group.additional.is_empty() {
                        let position = source_position(&group.additional, reversed);
                        keys.push(position.clone());
                        positions.insert(EdgeKey::PartAdditional(part), position);
                    }
                    planned.push((entries, undeclared));
                }
                let sides = plan.sides;
                if quiet == 0 {
                    meeting.compare(sides.0, sides.1, &keys);
                }
                steps.push(Step::Records(RecordMeet {
                    left: plan.a,
                    fields: std::mem::take(&mut plan.fields),
                    enums: std::mem::take(&mut plan.enums),
                    additional: plan.additional,
                    absent: std::mem::take(&mut plan.absent),
                    parts: planned,
                    positions,
                    sides,
                }));
                steps.extend(parts.into_iter().rev());
            }
            Step::Records(meet) => {
                let parts_met = meet
                    .parts
                    .iter()
                    .flat_map(|(entries, undeclared)| entries.iter().map(|(_, plan)| plan).chain([undeclared]))
                    .filter(|plan| matches!(plan, PartPlan::Met))
                    .count();
                let mut parts_results = results.split_off(results.len() - parts_met).into_iter();
                let count = meet.fields.iter().filter(|(_, kept)| kept.is_none()).count() + usize::from(meet.additional);
                let mut met = take(&mut results, count).into_iter();
                let mut absent = meet.absent;
                let mut fields = TypeFields::new();
                let mut enums = Vec::new();
                for ((name, kept), (left, right)) in meet.fields.into_iter().zip(meet.enums) {
                    // A field whose meet cannot hold is absent, and so is one whose two finite sets meet at no value.
                    match kept.cloned().or_else(|| met.next().expect("one meeting per field met")) {
                        Some(ty) => match met_field_enum(left, right, &ty) {
                            Some(values) if values.is_empty() => absent.push(name.into()),
                            values => {
                                if let Some(values) = values {
                                    enums.push((Arc::from(name), values));
                                }
                                fields.insert(name, ty);
                            }
                        },
                        None => absent.push(name.into()),
                    }
                }
                // Undeclared members that cannot meet close the record.
                let additional = if meet.additional { met.next().expect("the undeclared members met") } else { None };
                let mut built_of = |plan: PartPlan| match plan {
                    PartPlan::Kept(ty) => ty.cloned(),
                    PartPlan::Met => parts_results.next().expect("one meeting per part member met"),
                };
                let parts: Vec<PatternPart> = meet
                    .parts
                    .into_iter()
                    .map(|(entries, undeclared)| PatternPart {
                        fields: entries.into_iter().map(|(pattern, plan)| PatternField { pattern: pattern.into(), ty: built_of(plan) }).collect(),
                        additional_fields: built_of(undeclared),
                    })
                    .collect();
                let mut built = record_of(fields, additional, absent, meet.left.name.clone(), parts, enums);
                if quiet == 0 {
                    built = meeting.place(built, meet.sides.0, meet.sides.1, &meet.positions);
                }
                results.push(Some(built));
            }
            Step::RecordWithMap { record, sides } => {
                let typed = record.pattern_fields().filter(|(_, ty)| ty.is_some()).count()
                    + (0..record.pattern_part_count()).filter(|part| record.part_additional(*part).is_some()).count();
                let mut patterns = results.split_off(results.len() - typed).into_iter();
                let count = record.fields.len() + usize::from(record.additional_fields().is_some());
                let mut met = take(&mut results, count).into_iter();
                let mut absent: Vec<Arc<str>> = record.absent_fields().map(Arc::from).collect();
                let mut fields = TypeFields::new();
                let mut enums = Vec::new();
                for name in record.fields.keys() {
                    // A field that cannot hold the map's value is absent, and so is one its set keeps no value of.
                    match met.next().expect("one meeting per field") {
                        Some(ty) => match met_field_enum(record.field_enum(name), None, &ty) {
                            Some(values) if values.is_empty() => absent.push(name.into()),
                            values => {
                                if let Some(values) = values {
                                    enums.push((Arc::from(name), values));
                                }
                                fields.insert(name, ty);
                            }
                        },
                        None => absent.push(name.into()),
                    }
                }
                let additional = if record.additional_fields().is_some() { met.next().expect("the undeclared members met") } else { None };
                // A pattern meeting that cannot hold admits no value.
                let mut parts = record.pattern_parts();
                for part in &mut parts {
                    for entry in &mut part.fields {
                        if entry.ty.is_some() {
                            entry.ty = patterns.next().expect("one meeting per typed pattern");
                        }
                    }
                }
                for part in &mut parts {
                    if part.additional_fields.is_some() {
                        part.additional_fields = patterns.next().expect("one meeting per part's undeclared members");
                    }
                }
                let mut built = record_of(fields, additional, absent, record.name.clone(), parts, enums);
                if quiet == 0 {
                    built = meeting.place(built, sides.0, sides.1, &HashMap::new());
                }
                results.push(Some(built));
            }
            Step::Tuple { positions, rest, sides } => {
                let rest = rest.then(|| results.pop().expect("the rest's meeting"));
                let met = take(&mut results, positions);
                // A position neither side can hold ends the tuple there.
                let prefix: Vec<CelType> = met.into_iter().map_while(|met| met).collect();
                let ended = prefix.len() < positions;
                let mut built = tuple_of(prefix, if ended { None } else { rest.flatten() });
                if quiet == 0 {
                    built = meeting.place(built, sides.0, sides.1, &HashMap::new());
                }
                results.push(Some(built));
            }
            Step::Map(sides) => {
                let met = take(&mut results, 2);
                results.push(match (&met[0], &met[1]) {
                    (Some(key), value) => {
                        // A map whose value admits nothing holds no entry.
                        let mut built = match value {
                            Some(value) => map_of(key.clone(), value.clone()),
                            None => record_of(TypeFields::new(), None, Vec::new(), None, Vec::new(), Vec::new()),
                        };
                        if quiet == 0 {
                            built = meeting.place(built, sides.0, sides.1, &HashMap::new());
                        }
                        Some(built)
                    }
                    _ => None,
                });
            }
            Step::List(sides) => {
                // A list whose element admits nothing holds none.
                let mut built = match results.pop().expect("one meeting") {
                    Some(element) => list_of(element),
                    None => tuple_of(Vec::new(), None),
                };
                if quiet == 0 {
                    built = meeting.place(built, sides.0, sides.1, &HashMap::new());
                }
                results.push(Some(built));
            }
            Step::Optional(sides) => {
                let built = results.pop().expect("one meeting").map(optional_of);
                results.push(match built {
                    Some(built) if quiet == 0 => Some(meeting.place(built, sides.0, sides.1, &HashMap::new())),
                    built => built,
                });
            }
        }
    }
    results.pop().expect("the intersection leaves one answer")
}

// --- field maps ------------------------------------------------------------------

/// A field map, each field a type expression or a nested field map.
///
/// `Clone`, `==`, `Debug` and `Drop` run on heap work lists, so a field map of any depth
/// is copied, compared, printed and released on a small stack.
pub enum FieldDeclaration {
    Type(String),
    Fields(PropertyMap<FieldDeclaration>),
}

impl From<&str> for FieldDeclaration {
    fn from(text: &str) -> Self {
        FieldDeclaration::Type(text.into())
    }
}

impl From<String> for FieldDeclaration {
    fn from(text: String) -> Self {
        FieldDeclaration::Type(text)
    }
}

impl From<PropertyMap<FieldDeclaration>> for FieldDeclaration {
    fn from(fields: PropertyMap<FieldDeclaration>) -> Self {
        FieldDeclaration::Fields(fields)
    }
}

/// Folds a field map bottom-up in its own order: each type expression through `leaf`,
/// each map, once its fields are folded, through `build`.
fn fold_fields<'f, T, E>(
    fields: &'f PropertyMap<FieldDeclaration>,
    mut leaf: impl FnMut(&'f str) -> Result<T, E>,
    mut build: impl FnMut(Vec<(&'f str, T)>) -> T,
) -> Result<T, E> {
    struct Frame<'f, T> {
        entries: Vec<(&'f str, &'f FieldDeclaration)>,
        folded: Vec<(&'f str, T)>,
    }
    let open = |fields: &'f PropertyMap<FieldDeclaration>| Frame { entries: fields.iter().collect(), folded: Vec::new() };
    let mut frames = vec![open(fields)];
    loop {
        let frame = frames.last_mut().expect("a frame is open");
        let Some(&(name, declaration)) = frame.entries.get(frame.folded.len()) else {
            let done = frames.pop().expect("a frame is open");
            let value = build(done.folded);
            match frames.last_mut() {
                None => return Ok(value),
                Some(parent) => {
                    let name = parent.entries[parent.folded.len()].0;
                    parent.folded.push((name, value));
                }
            }
            continue;
        };
        match declaration {
            FieldDeclaration::Type(text) => {
                let value = leaf(text)?;
                frame.folded.push((name, value));
            }
            FieldDeclaration::Fields(nested) => frames.push(open(nested)),
        }
    }
}

impl Clone for FieldDeclaration {
    fn clone(&self) -> Self {
        match self {
            FieldDeclaration::Type(text) => FieldDeclaration::Type(text.clone()),
            FieldDeclaration::Fields(fields) => {
                let copied: Result<_, std::convert::Infallible> = fold_fields(
                    fields,
                    |text| Ok(FieldDeclaration::Type(text.into())),
                    |entries| FieldDeclaration::Fields(entries.into_iter().collect()),
                );
                match copied {
                    Ok(copy) => copy,
                    Err(never) => match never {},
                }
            }
        }
    }
}

impl PartialEq for FieldDeclaration {
    /// The same fields, in any order, declaring the same text.
    fn eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other)];
        while let Some(pair) = pending.pop() {
            match pair {
                (FieldDeclaration::Type(a), FieldDeclaration::Type(b)) if a == b => {}
                (FieldDeclaration::Fields(a), FieldDeclaration::Fields(b)) if a.len() == b.len() => {
                    for (name, declaration) in a.iter() {
                        match b.get(name) {
                            Some(held) => pending.push((declaration, held)),
                            None => return false,
                        }
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

impl fmt::Debug for FieldDeclaration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        enum Piece<'a> {
            Text(&'static str),
            Name(&'a str),
            Declaration(&'a FieldDeclaration),
        }
        let mut pending = vec![Piece::Declaration(self)];
        while let Some(piece) = pending.pop() {
            match piece {
                Piece::Text(text) => f.write_str(text)?,
                Piece::Name(name) => write!(f, "{name:?}: ")?,
                Piece::Declaration(FieldDeclaration::Type(text)) => write!(f, "Type({text:?})")?,
                Piece::Declaration(FieldDeclaration::Fields(fields)) => {
                    pending.push(Piece::Text("})"));
                    let held: Vec<(&str, &FieldDeclaration)> = fields.iter().collect();
                    for (at, (name, declaration)) in held.into_iter().enumerate().rev() {
                        pending.push(Piece::Declaration(declaration));
                        pending.push(Piece::Name(name));
                        if at > 0 {
                            pending.push(Piece::Text(", "));
                        }
                    }
                    pending.push(Piece::Text("Fields({"));
                }
            }
        }
        Ok(())
    }
}

impl Drop for FieldDeclaration {
    /// Unlinks every nested field map onto a list, so releasing a deep one costs no stack.
    fn drop(&mut self) {
        let FieldDeclaration::Fields(fields) = self else { return };
        let mut pending: Vec<FieldDeclaration> = std::mem::take(fields).into_iter().map(|(_, held)| held).collect();
        while let Some(mut held) = pending.pop() {
            if let FieldDeclaration::Fields(fields) = &mut held {
                pending.extend(std::mem::take(fields).into_iter().map(|(_, nested)| nested));
            }
        }
    }
}

/// An object type written as a field map rather than as a schema: a closed record, each
/// field read by `read_type` or folded from its own map, in the map's order.
pub fn field_map_type(
    fields: &PropertyMap<FieldDeclaration>,
    read_type: &dyn Fn(&str) -> Result<CelType, CelTypeTextError>,
) -> Result<CelType, CelTypeTextError> {
    fold_fields(fields, read_type, |entries| record_of(entries.into_iter().collect(), None, Vec::new(), None, Vec::new(), Vec::new()))
}

#[cfg(test)]
mod tests {
    //! The cost of registering an intersection, counted rather than timed — the twin of the
    //! intersection cases of `cel/nodejs/tests/checker-cost.test.ts`, here because the counts are
    //! the crate's own: the holders the containers its meets built keep, the containers built,
    //! the entries of the readings built, and the reading entries listing a read through the
    //! met type steps through. Each grows linearly with depth: doubling the depth at most
    //! multiplies it by 2.5. Beside them, the walk cases: the type visits registering and
    //! checking against a shared type make, linear in its depth under the same bound; and the
    //! printing case: the type nodes a printed type writes, the same at any depth.

    use super::*;
    use crate::json_text_scan::read_json_text;
    use crate::schema_dependencies::SchemaDependencyRecorder;

    fn reading(text: &str) -> SchemaTypeReading {
        let node = read_json_text(text).expect("the schema is JSON");
        read_schema_type(&JsonSchemaDocument { node, root: None }, &SchemaConversion::default()).expect("it reads")
    }

    const LEAF: &str = r#"{"type":"object","properties":{"v":{"type":"string"}}}"#;

    fn half(name: &str, level: usize) -> String {
        format!(r##"{{"properties":{{"a":{{"$ref":"#/$defs/{name}{}"}}}}}}"##, level - 1)
    }

    /// `depth` levels, each an `allOf` of two halves reaching the level below through one
    /// reference.
    fn diamond(depth: usize) -> String {
        let mut defs = vec![format!(r#""d0":{LEAF}"#)];
        for level in 1..=depth {
            defs.push(format!(r#""d{level}":{{"allOf":[{},{}]}}"#, half("d", level), half("d", level)));
        }
        format!(r##"{{"$defs":{{{}}},"$ref":"#/$defs/d{depth}"}}"##, defs.join(","))
    }

    /// Two chains of equal content, each level of either an `allOf` of the two levels below.
    fn two_chains(depth: usize) -> String {
        let mut defs = vec![format!(r#""d0":{LEAF}"#), format!(r#""e0":{LEAF}"#)];
        for level in 1..=depth {
            defs.push(format!(r#""d{level}":{{"allOf":[{},{}]}}"#, half("d", level), half("e", level)));
            defs.push(format!(r#""e{level}":{{"allOf":[{},{}]}}"#, half("e", level), half("d", level)));
        }
        format!(r##"{{"$defs":{{{}}},"$ref":"#/$defs/d{depth}"}}"##, defs.join(","))
    }

    /// As [`diamond`], each half a union of two shapes reaching the level below.
    fn union_diamond(depth: usize) -> String {
        let mut defs = vec![format!(r#""d0":{LEAF}"#)];
        for level in 1..=depth {
            let below = format!(r##"{{"$ref":"#/$defs/d{}"}}"##, level - 1);
            let half = format!(r#"{{"oneOf":[{{"properties":{{"a":{below}}}}},{{"properties":{{"a":{below},"b":{{"type":"string"}}}}}}]}}"#);
            defs.push(format!(r#""d{level}":{{"allOf":[{half},{half}]}}"#));
        }
        format!(r##"{{"$defs":{{{}}},"$ref":"#/$defs/d{depth}"}}"##, defs.join(","))
    }

    /// An `allOf` of `count` parts, each a union of two shapes differing only in a constant.
    fn unions(count: usize) -> String {
        let parts: Vec<String> = (0..count)
            .map(|at| format!(r#"{{"anyOf":[{{"type":"object","properties":{{"k{at}":{{"const":"a"}}}}}},{{"type":"object","properties":{{"k{at}":{{"const":"b"}}}}}}]}}"#))
            .collect();
        format!(r#"{{"allOf":[{}]}}"#, parts.join(","))
    }

    /// The reading entries listing `x.a…a.v` steps through, the chain as deep as the fixture.
    fn listed(text: &str, depth: usize) -> usize {
        let SchemaTypeReading { result, provenance, .. } = reading(text);
        let mut recorder = SchemaDependencyRecorder::default();
        recorder.read_registration(Some(&Arc::new(provenance)));
        let mut ty = result.ty;
        for _ in 0..depth {
            recorder.read_member(&ty, &EdgeKey::member("a"));
            let CelType::Record(record) = &ty else { panic!("each level is a record") };
            ty = record.fields.get("a").expect("each level holds a").clone();
        }
        recorder.read_member(&ty, &EdgeKey::member("v"));
        recorder.visited
    }

    type Counter = fn(&SchemaTypeReading) -> usize;
    const COUNTERS: [(&str, Counter); 3] = [
        ("held holders", |reading| reading.held_holders),
        ("built containers", |reading| reading.built_containers),
        ("reads entries", |reading| reading.reads_entries),
    ];

    fn linear(fixture: fn(usize) -> String) {
        let [eight, sixteen, thirty_two] = [8, 16, 32].map(|depth| reading(&fixture(depth)));
        for (name, count) in COUNTERS {
            let [eight, sixteen, thirty_two] = [&eight, &sixteen, &thirty_two].map(|reading| count(reading) as f64);
            assert!(thirty_two <= 2.5 * sixteen, "{name}: {thirty_two} at 32 against {sixteen} at 16");
            assert!(sixteen <= 2.5 * eight, "{name}: {sixteen} at 16 against {eight} at 8");
        }
    }

    fn listed_linear(fixture: fn(usize) -> String) {
        let [eight, sixteen, thirty_two] = [8, 16, 32].map(|depth| listed(&fixture(depth), depth) as f64);
        assert!(thirty_two <= 2.5 * sixteen, "{thirty_two} steps at 32 against {sixteen} at 16");
        assert!(sixteen <= 2.5 * eight, "{sixteen} steps at 16 against {eight} at 8");
    }

    #[test]
    fn counts_linear_in_depth_where_each_level_meets_the_level_below_with_itself() {
        linear(diamond);
    }

    #[test]
    fn counts_linear_in_depth_where_each_level_meets_two_chains_of_equal_content() {
        linear(two_chains);
    }

    #[test]
    fn counts_linear_in_depth_where_each_level_meets_two_unions_of_the_level_below() {
        linear(union_diamond);
    }

    #[test]
    fn lists_a_read_through_a_level_meeting_the_level_below_with_itself_in_steps_linear_in_its_depth() {
        listed_linear(diamond);
    }

    #[test]
    fn lists_a_read_through_two_chains_of_equal_content_in_steps_linear_in_its_depth() {
        listed_linear(two_chains);
    }

    /// `depth` levels, each a record whose two fields reach the level below through one reference.
    fn binary(depth: usize) -> String {
        let mut defs = vec![format!(r#""d0":{LEAF}"#)];
        for level in 1..=depth {
            let below = format!(r##"{{"$ref":"#/$defs/d{}"}}"##, level - 1);
            defs.push(format!(r#""d{level}":{{"type":"object","properties":{{"a":{below},"b":{below}}}}}"#));
        }
        format!(r##"{{"$defs":{{{}}},"$ref":"#/$defs/d{depth}"}}"##, defs.join(","))
    }

    /// The types registering `binary(depth)` and checking `source` against it visit, the
    /// conversion, the listing and the locating included — `checker-cost.test.ts`'s walk gate.
    fn visits(depth: usize, source: &str) -> f64 {
        let before = crate::type_visits::type_visits();
        let mut environment = crate::CelEnvironment::new(crate::CelEnvironmentOptions::default());
        let node = read_json_text(&binary(depth)).expect("the schema is JSON");
        environment.register_variable("x", crate::TypeDeclaration::Schema(JsonSchemaDocument { node, root: None }), None).expect("it registers");
        let options = crate::CheckOptions { schema_dependencies: true, schema_nodes: true, ..Default::default() };
        assert_eq!(environment.check_with(source, options).expect("it checks").type_name, "map");
        (crate::type_visits::type_visits() - before) as f64
    }

    /// A reference is read once, so the type of `d_i` holds the type of `d_{i-1}` twice: a walk
    /// answering each type object once visits a number of types linear in the depth. The smaller
    /// depth is measured first, so a walk of every path fails at 24 rather than running 48, and
    /// depth 64 is reached only once the bound holds.
    fn walks_each_type_once(source: &str) {
        let (twelve, twenty_four) = (visits(12, source), visits(24, source));
        assert!(twenty_four <= 2.5 * twelve, "{twenty_four} visits at 24 against {twelve} at 12");
        let forty_eight = visits(48, source);
        assert!(forty_eight <= 2.5 * twenty_four, "{forty_eight} visits at 48 against {twenty_four} at 24");
        if source == "x" {
            assert!(visits(64, source) > 0.0);
        }
    }

    #[test]
    fn visits_each_distinct_type_once_checking_the_whole_value() {
        walks_each_type_once("x");
    }

    #[test]
    fn visits_each_distinct_type_once_checking_a_read_into_it() {
        walks_each_type_once("x.a.b.a");
    }

    /// `depth` levels, each a union of an array and an object of the level below.
    fn array_object_diamond(depth: usize) -> String {
        let mut defs = vec![r#""d0":{"type":"string"}"#.to_string()];
        for level in 1..=depth {
            let below = format!(r##"{{"$ref":"#/$defs/d{}"}}"##, level - 1);
            defs.push(format!(r#""d{level}":{{"oneOf":[{{"type":"array","items":{below}}},{{"type":"object","additionalProperties":{below}}}]}}"#));
        }
        format!(r##"{{"$defs":{{{}}},"$ref":"#/$defs/d{depth}"}}"##, defs.join(","))
    }

    /// The type of `d_i` holds `2^i` nodes printed whole, so a printed type is cut at
    /// `TYPE_TEXT_NODE_LIMIT` nodes: its text writes that many type names and `...` however
    /// deep the type goes — `checker-cost.test.ts`'s printing gate. Its length is bounded
    /// rather than equal, since which names the first nodes are depends on the depth. Each
    /// depth is judged before the next is printed, so printing every node fails at 16.
    /// The longest text the cut can write here: every node a `map<string, ` opening, then
    /// `...` and the brackets it closes.
    const PRINTED_LENGTH_BOUND: usize = crate::cel_type::TYPE_TEXT_NODE_LIMIT * "map<string, ".len() + "...".len() + crate::cel_type::TYPE_TEXT_NODE_LIMIT;

    /// The printed text writes exactly the limit's type nodes, then one `...` and only closing brackets.
    fn assert_cut(text: &str, at: &str) {
        let names = ["list", "map", "string"].iter().map(|name| text.matches(name).count()).sum::<usize>();
        assert_eq!(names, crate::cel_type::TYPE_TEXT_NODE_LIMIT, "{at}");
        assert_eq!(text.matches("...").count(), 1, "{at}");
        let after = &text[text.find("...").expect("cut") + "...".len()..];
        assert!(after.chars().all(|character| character == '>'), "{at}: {after}");
        assert!(text.len() <= PRINTED_LENGTH_BOUND, "{at}: {} characters", text.len());
    }

    fn diamond_document(depth: usize) -> JsonSchemaDocument {
        JsonSchemaDocument { node: read_json_text(&array_object_diamond(depth)).expect("the schema is JSON"), root: None }
    }

    /// The type of `d_i` holds `2^i` nodes printed whole, so a printed type is cut at
    /// `TYPE_TEXT_NODE_LIMIT` nodes: its text writes that many type names and `...` however
    /// deep the type goes — `checker-cost.test.ts`'s printing gate. Each depth is judged
    /// before the next is printed, so printing every node fails at 16.
    #[test]
    fn writes_as_many_type_nodes_at_any_depth_then_cuts() {
        for depth in [16, 32, 64] {
            let mut environment = crate::CelEnvironment::new(crate::CelEnvironmentOptions::default());
            environment.register_variable("x", crate::TypeDeclaration::Schema(diamond_document(depth)), None).expect("it registers");
            let options = crate::CheckOptions { schema_dependencies: true, schema_nodes: true, ..Default::default() };
            assert_cut(&environment.check_with("x", options).expect("it checks").type_name, &format!("depth {depth}"));
        }
    }

    /// A namespaced function's result declared as a schema lists in the cut text.
    #[test]
    fn lists_a_result_declared_as_a_schema_in_bounded_text() {
        for depth in [16, 32, 64] {
            let mut environment = crate::CelEnvironment::new(crate::CelEnvironmentOptions::default());
            let declared = crate::NamespaceFunctionDeclaration::withheld("f", crate::WithheldReturns::Schema(diamond_document(depth)));
            environment.register_namespace("Ns", vec![declared], crate::NamespaceOptions::default()).expect("it registers");
            let listed = environment.definitions().namespaces[0].functions[0].clone();
            assert!(listed.result_type.is_some(), "depth {depth}");
            let text = listed.declaration.strip_prefix("f(…): ").expect("listed by its result");
            assert_cut(text, &format!("depth {depth}"));
        }
    }

    #[test]
    fn stops_building_union_members_past_the_expansion_limit() {
        // Six parts build 64 members, the limit; the seventh would build 128, so it and every
        // part after it add no member.
        let held = |count: usize| reading(&unions(count)).held_holders;
        assert_eq!(held(8), held(7));
        assert_eq!(held(7), held(6));
    }
}
