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

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use telorun_cel_value::{es_string_to_number, PropertyMap};

use crate::cel_type::{
    assignable, is_dyn, list_of, map_of, optional_of, types_equal, union_of, CelType, RecordType, TypeFields, BOOL,
    DOUBLE, DYN, INT, NULL, STRING,
};
use crate::json_value::JsonValue;
use crate::type_expression::CelTypeTextError;

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

/// How a named type a resolver answers becomes a type: nothing where no type is
/// registered under the name.
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
    /// A keyword this reader reads, in a form it does not.
    ShapeNotRead,
    /// A reference the host did not answer, or a pointer naming nothing.
    ReferenceUnresolved,
    /// Two things the node says about its own type cannot both hold.
    IntersectionEmpty,
    /// The host's resolver named a type nothing is registered under.
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
pub const TYPE_KEYWORDS_READ: &[&str] =
    &["$ref", "additionalProperties", "allOf", "anyOf", "const", "enum", "items", "oneOf", "properties", "type"];

/// The type a schema declares, read to full depth, beside what it could not judge. It
/// fails only where the named-type lookup does.
pub fn schema_type(
    document: &JsonSchemaDocument,
    conversion: &SchemaConversion<'_>,
) -> Result<SchemaTypeResult, CelTypeTextError> {
    let mut reader = SchemaReader {
        conversion,
        unjudged: Vec::new(),
        recursive: Vec::new(),
        documents: HashMap::new(),
        tasks: Vec::new(),
        values: Vec::new(),
    };
    let root = document.root.clone().unwrap_or_else(|| Arc::clone(&document.node));
    reader.tasks.push(Task::Read(Visit {
        node: Arc::clone(&document.node),
        root,
        pointer: Pointer::default(),
        through: None,
        arrived_by: None,
    }));
    reader.run()?;
    let ty = reader.values.pop().expect("the descent leaves one type");
    Ok(SchemaTypeResult { ty, unjudged: reader.unjudged, recursive: reader.recursive })
}

// --- pointers ------------------------------------------------------------------

/// A JSON Pointer shared with the pointer it extends, written out only when reported,
/// so a descent of any depth builds no text proportional to it at each level.
#[derive(Clone, Default)]
struct Pointer(Option<Arc<PointerLink>>);

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

    fn text(&self) -> String {
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
fn node_at_pointer(root: &Arc<JsonValue>, pointer: &str) -> Option<Arc<JsonValue>> {
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
        "properties" => !matches!(&**value, JsonValue::Object(_)),
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

// --- the reader ------------------------------------------------------------------

/// A node to read, where it was reached from.
#[derive(Clone)]
struct Visit {
    node: Arc<JsonValue>,
    root: Arc<JsonValue>,
    pointer: Pointer,
    through: Option<Pointer>,
    arrived_by: Option<String>,
}

/// One step of the descent. A step that answers a type leaves it on the value stack; a
/// combining step takes the types its parts left.
enum Task {
    Read(Visit),
    /// The read of `node` under `root` is done: the type on top is memoized.
    Finish { root: usize, node: Arc<JsonValue> },
    Reference { reference: String, at: Visit },
    OfType { name: Option<String>, at: Visit },
    Record(Visit),
    Array(Visit),
    /// Builds a record or a map from the property types and the additional type left.
    BuildRecord { names: Option<Vec<String>>, additional_read: bool, additional: Option<bool> },
    List,
    Type(CelType),
    Union(usize),
    Meet { keywords: Vec<&'static str>, at: Visit },
}

/// What has been read of one document: its memo, and what is being read right now.
#[derive(Default)]
struct DocumentState {
    done: HashMap<usize, (Arc<JsonValue>, CelType)>,
    active: HashSet<usize>,
}

struct SchemaReader<'c, 'a> {
    conversion: &'c SchemaConversion<'a>,
    unjudged: Vec<UnjudgedSchemaNode>,
    recursive: Vec<RecursiveSchemaReference>,
    /// Keyed by the document's root, held so its address is never reused.
    documents: HashMap<usize, (Arc<JsonValue>, DocumentState)>,
    tasks: Vec<Task>,
    values: Vec<CelType>,
}

fn identity(value: &Arc<JsonValue>) -> usize {
    Arc::as_ptr(value) as usize
}

impl SchemaReader<'_, '_> {
    fn run(&mut self) -> Result<(), CelTypeTextError> {
        while let Some(task) = self.tasks.pop() {
            match task {
                Task::Read(visit) => self.read(visit)?,
                Task::Finish { root, node } => {
                    let ty = self.values.last().expect("a read leaves its type").clone();
                    let (_, state) = self.documents.get_mut(&root).expect("a document being read has a state");
                    state.active.remove(&identity(&node));
                    state.done.insert(identity(&node), (node, ty));
                }
                Task::Reference { reference, at } => self.reference(reference, at),
                Task::OfType { name, at } => self.of_type(name.as_deref(), at),
                Task::Record(at) => self.record(at),
                Task::Array(at) => self.array(at),
                Task::BuildRecord { names, additional_read, additional } => {
                    let fields = names.as_ref().map(|names| self.values.split_off(self.values.len() - names.len()));
                    let additional_type = additional_read.then(|| self.values.pop().expect("the additional type"));
                    let ty = match (names, fields) {
                        (Some(names), Some(fields)) => CelType::Record(RecordType {
                            name: None,
                            fields: names.into_iter().zip(fields).collect::<TypeFields>(),
                            open: additional == Some(true),
                        }),
                        _ => match additional_type {
                            Some(value) => map_of(STRING, value),
                            None if additional == Some(false) => {
                                CelType::Record(RecordType { name: None, fields: TypeFields::new(), open: false })
                            }
                            None => map_of(STRING, DYN),
                        },
                    };
                    self.values.push(ty);
                }
                Task::List => {
                    let element = self.values.pop().expect("the element type");
                    self.values.push(list_of(element));
                }
                Task::Type(ty) => self.values.push(ty),
                Task::Union(count) => {
                    let members = self.values.split_off(self.values.len() - count);
                    self.values.push(union_of(members));
                }
                Task::Meet { keywords, at } => {
                    let parts = self.values.split_off(self.values.len() - keywords.len());
                    let ty = self.meet(&keywords, parts, &at);
                    self.values.push(ty);
                }
            }
        }
        Ok(())
    }

    fn read(&mut self, visit: Visit) -> Result<(), CelTypeTextError> {
        // Not an object: nothing a node said, so nothing to judge.
        if !is_node(&visit.node) {
            self.values.push(DYN);
            return Ok(());
        }
        let root = identity(&visit.root);
        let node = identity(&visit.node);
        let (_, state) =
            self.documents.entry(root).or_insert_with(|| (Arc::clone(&visit.root), DocumentState::default()));
        if let Some((_, held)) = state.done.get(&node) {
            self.values.push(held.clone());
            return Ok(());
        }
        if state.active.contains(&node) {
            self.recursive.push(RecursiveSchemaReference {
                pointer: visit.pointer.text(),
                through_reference: visit.through.as_ref().map(Pointer::text),
                reference: visit.arrived_by,
            });
            self.values.push(DYN);
            return Ok(());
        }
        state.active.insert(node);
        self.tasks.push(Task::Finish { root, node: Arc::clone(&visit.node) });
        let answer = self.conversion.resolve_schema_type.as_ref().and_then(|resolve| {
            resolve(&JsonSchemaDocument { node: Arc::clone(&visit.node), root: Some(Arc::clone(&visit.root)) })
        });
        match answer {
            Some(SchemaTypeAnswer::Document(crossed)) => {
                // The descent crosses into the document; the first crossing is kept.
                let root = crossed.root.unwrap_or_else(|| Arc::clone(&crossed.node));
                self.tasks.push(Task::Read(Visit {
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
                        self.values.push(ty);
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
                program.push(Task::Union(branches.len()));
                keywords.push(name);
            }
        }
        if let Some((name, tasks)) = self.structure(&at) {
            program.extend(tasks);
            keywords.push(name);
        }
        program.push(Task::Meet { keywords, at });
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
                    tasks.push(Task::Union(count));
                    tasks
                }
            };
            return Some(("type", tasks));
        }
        if object_keyword(node, "properties").is_some() || keyword(node, "additionalProperties").is_some() {
            return Some(("properties", vec![Task::Record(at.clone())]));
        }
        if keyword(node, "items").is_some() {
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
            self.values.push(ty);
        } else if name == Some("object") {
            self.tasks.push(Task::Record(at));
        } else if name == Some("array") {
            self.tasks.push(Task::Array(at));
        } else {
            self.report(&at, vec!["type"], UnjudgedReason::ShapeNotRead, None);
            self.values.push(DYN);
        }
    }

    fn record(&mut self, at: Visit) {
        let node = Arc::clone(&at.node);
        let additional = keyword(&node, "additionalProperties");
        let additional_bool = match additional.map(|value| &**value) {
            Some(JsonValue::Bool(value)) => Some(*value),
            _ => None,
        };
        let mut program = Vec::new();
        let additional_read = additional.is_some() && additional_bool.is_none();
        if let (true, Some(value)) = (additional_read, additional) {
            program.push(Task::Read(Visit {
                node: Arc::clone(value),
                root: Arc::clone(&at.root),
                pointer: at.pointer.extended("/additionalProperties".into()),
                through: at.through.clone(),
                arrived_by: None,
            }));
        }
        let names = object_keyword(&node, "properties").map(|properties| {
            properties
                .iter()
                .map(|(name, property)| {
                    program.push(Task::Read(Visit {
                        node: Arc::clone(property),
                        root: Arc::clone(&at.root),
                        pointer: at.pointer.extended(format!("/properties/{}", escape_segment(name))),
                        through: at.through.clone(),
                        arrived_by: None,
                    }));
                    name.to_string()
                })
                .collect::<Vec<_>>()
        });
        program.push(Task::BuildRecord { names, additional_read, additional: additional_bool });
        self.tasks.extend(program.into_iter().rev());
    }

    fn array(&mut self, at: Visit) {
        match keyword(&at.node, "items").map(Arc::clone) {
            Some(items) if matches!(&*items, JsonValue::Array(_)) => {
                // A tuple: each position has its own type, which a CEL list type cannot hold.
                self.report(&at, vec!["items"], UnjudgedReason::ShapeNotRead, None);
                self.values.push(list_of(DYN));
            }
            Some(items) if matches!(&*items, JsonValue::Object(_)) => {
                self.tasks.push(Task::List);
                self.tasks.push(Task::Read(Visit {
                    node: items,
                    root: Arc::clone(&at.root),
                    pointer: at.pointer.extended("/items".into()),
                    through: at.through,
                    arrived_by: None,
                }));
            }
            // Absent, or a value that is not a node: nothing said about the elements.
            _ => self.values.push(list_of(DYN)),
        }
    }

    /// A document-local reference, resolved here; anything else was the host's to answer.
    fn reference(&mut self, reference: String, at: Visit) {
        let Some(pointer) = reference.strip_prefix('#') else {
            self.report(&at, vec!["$ref"], UnjudgedReason::ReferenceUnresolved, None);
            self.values.push(DYN);
            return;
        };
        let Some(target) = node_at_pointer(&at.root, pointer) else {
            self.report(&at, vec!["$ref"], UnjudgedReason::ReferenceUnresolved, None);
            self.values.push(DYN);
            return;
        };
        self.tasks.push(Task::Read(Visit {
            node: target,
            root: at.root,
            pointer: Pointer::written(pointer),
            through: at.through,
            arrived_by: Some(reference),
        }));
    }

    /// The one type every part admits; two parts that cannot both hold are reported.
    fn meet(&mut self, keywords: &[&'static str], parts: Vec<CelType>, at: &Visit) -> CelType {
        let mut parts = keywords.iter().copied().zip(parts);
        let Some((mut met_keyword, mut met)) = parts.next() else { return DYN };
        for (keyword, ty) in parts {
            match intersect_types(&met, &ty) {
                Some(both) => {
                    met = both;
                    met_keyword = keyword;
                }
                None => {
                    self.report(at, vec![met_keyword, keyword], UnjudgedReason::IntersectionEmpty, None);
                    return DYN;
                }
            }
        }
        met
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

// --- intersection ----------------------------------------------------------------

enum Step<'t> {
    Meet(&'t CelType, &'t CelType),
    Union(usize),
    Records(&'t RecordType, &'t RecordType),
    RecordWithMap(&'t RecordType),
    Map,
    List,
    Optional,
}

/// Hashes of the types one intersection reaches, each agreeing with [`types_equal`] and
/// computed once per type it is handed, so asking whether two parts are equal at every
/// level of a descent costs the depth once rather than at each level.
#[derive(Default)]
struct EqualityHashes {
    held: HashMap<usize, u64>,
}

fn address(ty: &CelType) -> usize {
    ty as *const CelType as usize
}

impl EqualityHashes {
    /// Whether two types are equal, [`types_equal`] asked only where their hashes agree.
    fn equal(&mut self, left: &CelType, right: &CelType) -> bool {
        self.of(left) == self.of(right) && types_equal(left, right)
    }

    fn of(&mut self, ty: &CelType) -> u64 {
        if let Some(hash) = self.held.get(&address(ty)) {
            return *hash;
        }
        let mut pending: Vec<(&CelType, bool)> = vec![(ty, false)];
        while let Some((at, children_held)) = pending.pop() {
            if self.held.contains_key(&address(at)) {
                continue;
            }
            if !children_held {
                pending.push((at, true));
                pending.extend(children(at).filter(|child| !self.held.contains_key(&address(child))).map(|child| (child, false)));
                continue;
            }
            let hash = self.own(at);
            self.held.insert(address(at), hash);
        }
        self.held[&address(ty)]
    }

    /// A type's hash from its children's: a record's fields in any order, a named type
    /// by its name and arguments alone, as `types_equal` compares them.
    fn own(&self, ty: &CelType) -> u64 {
        let child = |ty: &CelType| self.held[&address(ty)];
        let mut hasher = DefaultHasher::new();
        std::mem::discriminant(ty).hash(&mut hasher);
        match ty {
            CelType::Dyn => {}
            CelType::Primitive(name) => name.hash(&mut hasher),
            CelType::List(list) => child(&list.element).hash(&mut hasher),
            CelType::Map(map) => {
                child(&map.key).hash(&mut hasher);
                child(&map.value).hash(&mut hasher);
            }
            CelType::Optional(optional) => child(&optional.value).hash(&mut hasher),
            CelType::Record(record) => {
                record.name.hash(&mut hasher);
                record.open.hash(&mut hasher);
                record.fields.len().hash(&mut hasher);
                let mut fields: u64 = 0;
                for (name, ty) in record.fields.iter() {
                    let mut field = DefaultHasher::new();
                    name.hash(&mut field);
                    child(ty).hash(&mut field);
                    fields = fields.wrapping_add(field.finish());
                }
                fields.hash(&mut hasher);
            }
            CelType::Union(union) => union.members().iter().for_each(|member| child(member).hash(&mut hasher)),
            CelType::Nominal(nominal) => {
                nominal.name.hash(&mut hasher);
                nominal.args.iter().for_each(|argument| child(argument).hash(&mut hasher));
            }
            CelType::Parameter(parameter) => parameter.name.hash(&mut hasher),
        }
        hasher.finish()
    }
}

/// The types `types_equal` compares beneath a type.
fn children(ty: &CelType) -> Box<dyn Iterator<Item = &CelType> + '_> {
    match ty {
        CelType::List(list) => Box::new(std::iter::once(&*list.element)),
        CelType::Map(map) => Box::new([&*map.key, &*map.value].into_iter()),
        CelType::Optional(optional) => Box::new(std::iter::once(&*optional.value)),
        CelType::Record(record) => Box::new(record.fields.values()),
        CelType::Union(union) => Box::new(union.members().iter()),
        CelType::Nominal(nominal) => Box::new(nominal.args.iter()),
        CelType::Dyn | CelType::Primitive(_) | CelType::Parameter(_) => Box::new(std::iter::empty()),
    }
}

/// The one type both admit, or nothing when they cannot both hold: records merge
/// field-wise — the left's fields first, closed beating open — a record meets a map's
/// value type field by field, and otherwise the narrower of the two wins.
fn intersect_types(left: &CelType, right: &CelType) -> Option<CelType> {
    let mut hashes = EqualityHashes::default();
    let mut steps = vec![Step::Meet(left, right)];
    let mut results: Vec<Option<CelType>> = Vec::new();
    let take = |results: &mut Vec<Option<CelType>>, count: usize| results.split_off(results.len() - count);
    while let Some(step) = steps.pop() {
        match step {
            Step::Meet(left, right) => {
                if is_dyn(left) {
                    results.push(Some(right.clone()));
                    continue;
                }
                if is_dyn(right) || hashes.equal(left, right) {
                    results.push(Some(left.clone()));
                    continue;
                }
                let mut parts: Vec<Step<'_>> = Vec::new();
                match (left, right) {
                    // A union on the left is the one ranged over.
                    (CelType::Union(union), other) | (other, CelType::Union(union)) => {
                        steps.push(Step::Union(union.members().len()));
                        parts.extend(union.members().iter().map(|member| Step::Meet(member, other)));
                    }
                    (CelType::Record(a), CelType::Record(b)) => {
                        steps.push(Step::Records(a, b));
                        parts.extend(
                            b.fields.iter().filter_map(|(name, ty)| a.fields.get(name).map(|held| Step::Meet(held, ty))),
                        );
                    }
                    (CelType::Record(record), CelType::Map(map)) | (CelType::Map(map), CelType::Record(record)) => {
                        steps.push(Step::RecordWithMap(record));
                        parts.extend(record.fields.values().map(|ty| Step::Meet(ty, &map.value)));
                    }
                    (CelType::Map(a), CelType::Map(b)) => {
                        steps.push(Step::Map);
                        parts.push(Step::Meet(&a.key, &b.key));
                        parts.push(Step::Meet(&a.value, &b.value));
                    }
                    (CelType::List(a), CelType::List(b)) => {
                        steps.push(Step::List);
                        parts.push(Step::Meet(&a.element, &b.element));
                    }
                    (CelType::Optional(a), CelType::Optional(b)) => {
                        steps.push(Step::Optional);
                        parts.push(Step::Meet(&a.value, &b.value));
                    }
                    _ => {
                        results.push(if assignable(left, right) {
                            Some(left.clone())
                        } else if assignable(right, left) {
                            Some(right.clone())
                        } else {
                            None
                        });
                        continue;
                    }
                }
                steps.extend(parts.into_iter().rev());
            }
            Step::Union(count) => {
                let met: Vec<CelType> = take(&mut results, count).into_iter().flatten().collect();
                results.push(if met.is_empty() { None } else { Some(union_of(met)) });
            }
            Step::Records(a, b) => {
                let shared = b.fields.keys().filter(|name| a.fields.contains_key(name)).count();
                let met = take(&mut results, shared).into_iter().collect::<Option<Vec<_>>>();
                results.push(met.map(|met| {
                    let mut fields = a.fields.clone();
                    let mut met = met.into_iter();
                    for (name, ty) in b.fields.iter() {
                        let both = if a.fields.contains_key(name) {
                            met.next().expect("one meeting per shared field")
                        } else {
                            ty.clone()
                        };
                        fields.insert(name, both);
                    }
                    CelType::Record(RecordType { name: a.name.clone(), fields, open: a.open && b.open })
                }));
            }
            Step::RecordWithMap(record) => {
                let met = take(&mut results, record.fields.len()).into_iter().collect::<Option<Vec<_>>>();
                results.push(met.map(|met| {
                    CelType::Record(RecordType {
                        name: record.name.clone(),
                        fields: record.fields.keys().zip(met).collect(),
                        open: record.open,
                    })
                }));
            }
            Step::Map => {
                let met = take(&mut results, 2);
                results.push(match (&met[0], &met[1]) {
                    (Some(key), Some(value)) => Some(map_of(key.clone(), value.clone())),
                    _ => None,
                });
            }
            Step::List => {
                let element = results.pop().expect("one meeting");
                results.push(element.map(list_of));
            }
            Step::Optional => {
                let value = results.pop().expect("one meeting");
                results.push(value.map(optional_of));
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
    fold_fields(fields, read_type, |entries| {
        CelType::Record(RecordType { name: None, fields: entries.into_iter().collect(), open: false })
    })
}
