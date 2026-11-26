//! CEL's static types — `cel-type.ts`.
//!
//! The domain is richer than what an expression can spell: a record with named fields,
//! a union kept as a union, a named type over a base, and a type parameter have no
//! syntax of their own, and are what a host tells the checker through.
//!
//! A type is immutable and shared: every child and every collection is an `Arc`, so
//! `Clone` is shallow and a type is `Send + Sync`. A union is built only by
//! [`union_of`], so it never nests, never holds one member, a duplicate or `dyn`.
//!
//! Two equalities: [`types_equal`] is Node's, and the only one a rule of the engine
//! uses — a record's fields in any order, a named type by its name and arguments
//! alone. `==` is the type as data — field order, a named type's base and fields
//! included — for tests. [`format_type`]'s text is the dispatch key of a signature.
//!
//! Nothing here recurses with a type's depth: printing, both equalities,
//! `assignable`, `unify`, `without_parameters`, `Debug` and `Drop` each run on a heap
//! work list.
//!
//! Node items with no twin in this file:
//! - `DynType`, `PrimitiveType` — a variant of [`CelType`] that holds no struct.
//! - A union Node's own engine never builds (nested, of one member, with a duplicate,
//!   holding `dyn`): [`UnionType`]'s members are private and only [`union_of`] makes one.
//!
//! Declared here and not in the Node file:
//! - [`TypeFields`] — the fields of a record or a named type, with JavaScript `Map`
//!   semantics, which Node gets from its host.
//! - `PrimitiveName::as_str` — Node holds the name as the string itself.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use crate::regular_expression::{re2_pattern, Re2Flags};
use crate::type_visits::count_type_visit;

/// The ten primitive types.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum PrimitiveName {
    Int,
    Uint,
    Double,
    Bool,
    String,
    Bytes,
    Null,
    Type,
    Timestamp,
    Duration,
}

impl PrimitiveName {
    /// The primitive's own name: `int`, …, `null`, `type`, `timestamp`, `duration`.
    pub fn as_str(self) -> &'static str {
        match self {
            PrimitiveName::Int => "int",
            PrimitiveName::Uint => "uint",
            PrimitiveName::Double => "double",
            PrimitiveName::Bool => "bool",
            PrimitiveName::String => "string",
            PrimitiveName::Bytes => "bytes",
            PrimitiveName::Null => "null",
            PrimitiveName::Type => "type",
            PrimitiveName::Timestamp => "timestamp",
            PrimitiveName::Duration => "duration",
        }
    }

    /// How the type is printed: its name, with the two well-known types under theirs.
    fn printed(self) -> &'static str {
        match self {
            PrimitiveName::Timestamp => "google.protobuf.Timestamp",
            PrimitiveName::Duration => "google.protobuf.Duration",
            other => other.as_str(),
        }
    }
}

/// A static type: one of Node's nine kinds.
#[derive(Clone)]
pub enum CelType {
    Dyn,
    Primitive(PrimitiveName),
    List(ListType),
    Map(MapType),
    Optional(OptionalType),
    Record(RecordType),
    Union(UnionType),
    Nominal(NominalType),
    Parameter(ParameterType),
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<CelType>();
};

/// A list: its element type, and for a tuple its leading positions and the type of every
/// element past them (absent: none). `element` is the join of every position and the
/// rest; a tuple is built only by [`tuple_of`], so the rest is never carried without them.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ListType {
    pub element: Arc<CelType>,
    prefix_elements: Option<Arc<[CelType]>>,
    additional_elements: Option<Arc<CelType>>,
}

impl ListType {
    /// A plain list over a shared element type.
    pub fn new(element: Arc<CelType>) -> Self {
        ListType { element, prefix_elements: None, additional_elements: None }
    }

    /// A tuple's leading positions; nothing for a plain list.
    pub fn prefix_elements(&self) -> Option<&[CelType]> {
        self.prefix_elements.as_deref()
    }

    /// The type of every element past the positions; nothing for a plain list or a closed tuple.
    pub fn additional_elements(&self) -> Option<&CelType> {
        self.additional_elements.as_deref()
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MapType {
    pub key: Arc<CelType>,
    pub value: Arc<CelType>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OptionalType {
    pub value: Arc<CelType>,
}

/// An object with named fields: `additional_fields` types every member it does not declare
/// (absent: closed), `absent_fields` names the members declared to hold no value — never
/// a declared field, absent rather than empty — and the pattern parts type every member
/// no field declares whose name some part's pattern (RE2) matches: the meet over the parts
/// of each part's matching entries, else that part's own undeclared members, a declared
/// field already met with them. Per declared field whose schema admits a finite set of
/// values, that set, in canonical order. Built only by [`record_of`]. An unnamed record
/// prints as `map`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RecordType {
    pub name: Option<Arc<str>>,
    pub fields: TypeFields,
    additional_fields: Option<Arc<CelType>>,
    /// In the order the conversion met them, compared as a set by [`types_equal`].
    absent_fields: Option<Arc<[Arc<str>]>>,
    /// Part by part in written order, compared part by part and by pattern by
    /// [`types_equal`]; absent rather than empty.
    pattern_fields: Option<PatternEntries>,
    /// Per field, in the order the conversion set them, compared by field by
    /// [`types_equal`]; absent rather than empty, never an empty set.
    field_enums: Option<Arc<[(Arc<str>, Arc<[FieldEnumValue]>)]>>,
}

/// A value a field's finite set holds: a string, an int, a double, a bool or null. Ordered
/// canonically — null, then bools, ints, doubles and strings, each by value, a string by
/// code point — and a double's negative zero is built as zero ([`FieldEnumValue::double`]).
#[derive(Clone, Debug)]
pub enum FieldEnumValue {
    Null,
    Bool(bool),
    Int(i64),
    Double(f64),
    String(Arc<str>),
}

impl FieldEnumValue {
    /// A double, its negative zero read as zero.
    pub fn double(value: f64) -> Self {
        FieldEnumValue::Double(if value == 0.0 { 0.0 } else { value })
    }

    fn rank(&self) -> u8 {
        match self {
            FieldEnumValue::Null => 0,
            FieldEnumValue::Bool(_) => 1,
            FieldEnumValue::Int(_) => 2,
            FieldEnumValue::Double(_) => 3,
            FieldEnumValue::String(_) => 4,
        }
    }
}

impl Ord for FieldEnumValue {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (FieldEnumValue::Bool(a), FieldEnumValue::Bool(b)) => a.cmp(b),
            (FieldEnumValue::Int(a), FieldEnumValue::Int(b)) => a.cmp(b),
            (FieldEnumValue::Double(a), FieldEnumValue::Double(b)) => a.total_cmp(b),
            (FieldEnumValue::String(a), FieldEnumValue::String(b)) => a.cmp(b),
            _ => self.rank().cmp(&other.rank()),
        }
    }
}

impl PartialOrd for FieldEnumValue {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for FieldEnumValue {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}

impl Eq for FieldEnumValue {}

/// One `patternProperties` entry: its pattern, and the type it gives — none: no value.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PatternField {
    pub pattern: Arc<str>,
    pub ty: Option<CelType>,
}

/// The patterns one schema part declares, in written order, and the type it gives a member
/// another part's pattern matches and none of its own does — none where the part is closed
/// or open to anything.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PatternPart {
    pub fields: Vec<PatternField>,
    pub additional_fields: Option<CelType>,
}

/// A record's pattern parts as aligned lists, so a release takes their types as it takes
/// any list of types: every part's entries in turn, then each part's undeclared members, in
/// `types` and `given` (a type not given holds `dyn`); `patterns` the entries' texts and
/// `starts` the position of each part's first entry.
#[derive(Clone, PartialEq, Eq, Debug)]
struct PatternEntries {
    patterns: Arc<[Arc<str>]>,
    types: Arc<[CelType]>,
    given: Arc<[bool]>,
    starts: Arc<[usize]>,
}

impl RecordType {
    /// The type of every member the record does not declare; nothing for a closed record.
    pub fn additional_fields(&self) -> Option<&CelType> {
        self.additional_fields.as_deref()
    }

    /// The members declared to hold no value.
    pub fn absent_fields(&self) -> impl Iterator<Item = &str> {
        self.absent_fields.iter().flat_map(|names| names.iter().map(|name| &**name))
    }

    pub fn is_absent(&self, member: &str) -> bool {
        self.absent_fields.as_ref().is_some_and(|names| names.iter().any(|name| &**name == member))
    }

    /// The finite set a declared field's schema admits, where it admits one.
    pub fn field_enum(&self, field: &str) -> Option<&[FieldEnumValue]> {
        self.field_enums.as_ref()?.iter().find(|(name, _)| &**name == field).map(|(_, values)| &**values)
    }

    /// Every field carrying a finite set, with its set, in the order the record was built with.
    pub fn field_enums(&self) -> impl Iterator<Item = (&str, &[FieldEnumValue])> {
        self.field_enums.iter().flat_map(|entries| entries.iter().map(|(name, values)| (&**name, &**values)))
    }

    /// Each pattern entry, part by part in written order: its pattern, and the type it gives.
    pub fn pattern_fields(&self) -> impl Iterator<Item = (&str, Option<&CelType>)> {
        self.pattern_fields.iter().flat_map(|entries| {
            entries
                .patterns
                .iter()
                .zip(entries.types.iter().zip(entries.given.iter()))
                .map(|(pattern, (ty, given))| (&**pattern, given.then_some(ty)))
        })
    }

    pub(crate) fn pattern_count(&self) -> usize {
        self.pattern_fields.as_ref().map_or(0, |entries| entries.patterns.len())
    }

    /// The pattern and type of the entry at a position.
    pub(crate) fn pattern_at(&self, at: usize) -> (&str, Option<&CelType>) {
        let entries = self.pattern_fields.as_ref().expect("a record holding patterns");
        (&entries.patterns[at], entries.given[at].then_some(&entries.types[at]))
    }

    /// How many pattern parts the record carries.
    pub fn pattern_part_count(&self) -> usize {
        self.pattern_fields.as_ref().map_or(0, |entries| entries.starts.len())
    }

    /// The positions of a part's entries among every entry.
    pub(crate) fn part_entries(&self, part: usize) -> std::ops::Range<usize> {
        let entries = self.pattern_fields.as_ref().expect("a record holding patterns");
        let end = entries.starts.get(part + 1).copied().unwrap_or(entries.patterns.len());
        entries.starts[part]..end
    }

    /// The type a part gives a member another part's pattern matches and none of its own does.
    pub fn part_additional(&self, part: usize) -> Option<&CelType> {
        let entries = self.pattern_fields.as_ref().expect("a record holding patterns");
        let at = entries.patterns.len() + part;
        entries.given[at].then_some(&entries.types[at])
    }

    /// Every pattern part, as built.
    pub fn pattern_parts(&self) -> Vec<PatternPart> {
        (0..self.pattern_part_count())
            .map(|part| PatternPart {
                fields: self
                    .part_entries(part)
                    .map(|at| {
                        let (pattern, ty) = self.pattern_at(at);
                        PatternField { pattern: pattern.into(), ty: ty.cloned() }
                    })
                    .collect(),
                additional_fields: self.part_additional(part).cloned(),
            })
            .collect()
    }

    /// The positions of a part's entries matching a member name, in written order — RE2
    /// search, as `matches` reads a pattern. A record carries only patterns RE2 reads.
    pub fn matching_patterns(&self, part: usize, member: &str) -> Vec<usize> {
        let Some(entries) = &self.pattern_fields else { return Vec::new() };
        self.part_entries(part)
            .filter(|at| re2_pattern(&entries.patterns[*at], Re2Flags::NONE).is_ok_and(|program| program.is_match(member)))
            .collect()
    }

    /// Per part, the entries matching a member name; nothing where no part's pattern matches.
    pub(crate) fn part_matches(&self, member: &str) -> Option<Vec<Vec<usize>>> {
        let matched: Vec<Vec<usize>> = (0..self.pattern_part_count()).map(|part| self.matching_patterns(part, member)).collect();
        matched.iter().any(|entries| !entries.is_empty()).then_some(matched)
    }

    /// Every pattern the record carries, each text once, in written order.
    pub fn patterns(&self) -> Vec<&str> {
        let mut patterns: Vec<&str> = Vec::new();
        for (pattern, _) in self.pattern_fields() {
            if !patterns.contains(&pattern) {
                patterns.push(pattern);
            }
        }
        patterns
    }
}

/// A union of distinct members, none of them `dyn` or a union, at least two.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnionType {
    members: Arc<[CelType]>,
}

impl UnionType {
    pub fn members(&self) -> &[CelType] {
        &self.members
    }
}

/// A union of the same members with an identity of its own.
pub(crate) fn union_copy(union: &UnionType) -> CelType {
    CelType::Union(UnionType { members: union.members.iter().cloned().collect() })
}

/// A named type over a base, with invariant arguments. `fields` is what a value of it
/// carries; absent, it holds no members at all.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NominalType {
    pub name: Arc<str>,
    pub base: Arc<CelType>,
    pub args: Arc<[CelType]>,
    pub fields: Option<TypeFields>,
}

/// A type variable of a signature, unified per call.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ParameterType {
    pub name: Arc<str>,
}

// --- fields --------------------------------------------------------------------

/// Named field types with JavaScript `Map` semantics: insertion order, a name set again
/// keeps its first position and takes the new type, and lookup is by hash. Shared, so a
/// clone is shallow; setting a name on a shared one copies it first.
#[derive(Clone, Default)]
pub struct TypeFields {
    entries: Arc<FieldEntries>,
}

#[derive(Clone, Default)]
struct FieldEntries {
    order: Vec<(Arc<str>, CelType)>,
    positions: HashMap<Arc<str>, usize>,
}

impl TypeFields {
    /// The address of the entries this set shares with its clones: one set's identity.
    pub(crate) fn identity(&self) -> usize {
        Arc::as_ptr(&self.entries) as usize
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a field, answering the type it held. A name already held keeps its position.
    pub fn insert(&mut self, name: impl Into<Arc<str>>, ty: CelType) -> Option<CelType> {
        let name = name.into();
        let entries = Arc::make_mut(&mut self.entries);
        if let Some(at) = entries.positions.get(&name) {
            return Some(std::mem::replace(&mut entries.order[*at].1, ty));
        }
        entries.positions.insert(Arc::clone(&name), entries.order.len());
        entries.order.push((name, ty));
        None
    }

    pub fn get(&self, name: &str) -> Option<&CelType> {
        self.entries.positions.get(name).map(|at| &self.entries.order[*at].1)
    }

    pub fn contains_key(&self, name: &str) -> bool {
        self.entries.positions.contains_key(name)
    }

    pub fn len(&self) -> usize {
        self.entries.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.order.is_empty()
    }

    /// Every field, in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &CelType)> {
        self.entries.order.iter().map(|(name, ty)| (&**name, ty))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.iter().map(|(name, _)| name)
    }

    pub fn values(&self) -> impl Iterator<Item = &CelType> {
        self.iter().map(|(_, ty)| ty)
    }
}

impl<K: Into<Arc<str>>> FromIterator<(K, CelType)> for TypeFields {
    fn from_iter<I: IntoIterator<Item = (K, CelType)>>(fields: I) -> Self {
        let mut held = Self::new();
        for (name, ty) in fields {
            held.insert(name, ty);
        }
        held
    }
}

impl PartialEq for TypeFields {
    /// The same fields with the same types, in the same order.
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len()
            && self.entries.order.iter().zip(other.entries.order.iter()).all(|(a, b)| a.0 == b.0 && a.1 == b.1)
    }
}

impl Eq for TypeFields {}

impl fmt::Debug for TypeFields {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

// --- constants and builders ----------------------------------------------------

pub const DYN: CelType = CelType::Dyn;
pub const INT: CelType = CelType::Primitive(PrimitiveName::Int);
pub const UINT: CelType = CelType::Primitive(PrimitiveName::Uint);
pub const DOUBLE: CelType = CelType::Primitive(PrimitiveName::Double);
pub const BOOL: CelType = CelType::Primitive(PrimitiveName::Bool);
pub const STRING: CelType = CelType::Primitive(PrimitiveName::String);
pub const BYTES: CelType = CelType::Primitive(PrimitiveName::Bytes);
pub const NULL: CelType = CelType::Primitive(PrimitiveName::Null);
pub const TYPE: CelType = CelType::Primitive(PrimitiveName::Type);
pub const TIMESTAMP: CelType = CelType::Primitive(PrimitiveName::Timestamp);
pub const DURATION: CelType = CelType::Primitive(PrimitiveName::Duration);

static STRING_TYPE: CelType = STRING;

/// The names the timestamp and duration types are written and printed under.
pub const WELL_KNOWN_TYPE_NAMES: [(&str, PrimitiveName); 2] = [
    ("google.protobuf.Timestamp", PrimitiveName::Timestamp),
    ("google.protobuf.Duration", PrimitiveName::Duration),
];

pub fn list_of(element: CelType) -> CelType {
    CelType::List(ListType::new(Arc::new(element)))
}

/// The one tuple constructor: its positions, the type of every element past them (absent:
/// none), and the element type their join is.
pub fn tuple_of(prefix_elements: Vec<CelType>, additional_elements: Option<CelType>) -> CelType {
    let element = union_of(prefix_elements.iter().cloned().chain(additional_elements.iter().cloned()));
    CelType::List(ListType {
        element: Arc::new(element),
        prefix_elements: Some(prefix_elements.into()),
        additional_elements: additional_elements.map(Arc::new),
    })
}

/// The one record constructor: an empty `absent_fields`, `pattern_parts` or `field_enums`
/// is dropped, each set is put in canonical order with its duplicates dropped, and naming a
/// declared field absent, one pattern twice within a part, a set for an undeclared field or
/// an empty set is an engine defect.
pub fn record_of(
    fields: TypeFields,
    additional_fields: Option<CelType>,
    absent_fields: Vec<Arc<str>>,
    name: Option<Arc<str>>,
    pattern_parts: Vec<PatternPart>,
    field_enums: Vec<(Arc<str>, Vec<FieldEnumValue>)>,
) -> CelType {
    assert!(
        field_enums.iter().all(|(field, values)| fields.contains_key(field) && !values.is_empty()),
        "record type: a set of values for an undeclared field, or an empty one"
    );
    let field_enums: Vec<(Arc<str>, Arc<[FieldEnumValue]>)> = field_enums
        .into_iter()
        .map(|(field, mut values)| {
            values.sort();
            values.dedup();
            (field, Arc::from(values))
        })
        .collect();
    assert!(
        absent_fields.iter().all(|absent| !fields.contains_key(absent)),
        "record type: a declared field is also absent"
    );
    assert!(
        pattern_parts.iter().all(|part| part
            .fields
            .iter()
            .enumerate()
            .all(|(at, entry)| part.fields[..at].iter().all(|held| held.pattern != entry.pattern))),
        "record type: a pattern is written twice in one part"
    );
    let mut distinct: Vec<Arc<str>> = Vec::with_capacity(absent_fields.len());
    for name in absent_fields {
        if !distinct.contains(&name) {
            distinct.push(name);
        }
    }
    let absent_fields = distinct;
    CelType::Record(RecordType {
        name,
        fields,
        additional_fields: additional_fields.map(Arc::new),
        absent_fields: (!absent_fields.is_empty()).then(|| Arc::from(absent_fields)),
        pattern_fields: (!pattern_parts.is_empty()).then(|| pattern_entries(pattern_parts)),
        field_enums: (!field_enums.is_empty()).then(|| Arc::from(field_enums)),
    })
}

fn pattern_entries(parts: Vec<PatternPart>) -> PatternEntries {
    let mut starts = Vec::with_capacity(parts.len());
    let (mut patterns, mut types, mut given) = (Vec::new(), Vec::new(), Vec::new());
    let mut additional = Vec::with_capacity(parts.len());
    for part in parts {
        starts.push(patterns.len());
        for entry in part.fields {
            patterns.push(entry.pattern);
            given.push(entry.ty.is_some());
            types.push(entry.ty.unwrap_or(DYN));
        }
        additional.push(part.additional_fields);
    }
    for held in additional {
        given.push(held.is_some());
        types.push(held.unwrap_or(DYN));
    }
    PatternEntries { patterns: patterns.into(), types: types.into(), given: given.into(), starts: starts.into() }
}

pub fn map_of(key: CelType, value: CelType) -> CelType {
    CelType::Map(MapType { key: Arc::new(key), value: Arc::new(value) })
}

pub fn optional_of(value: CelType) -> CelType {
    CelType::Optional(OptionalType { value: Arc::new(value) })
}

pub fn parameter_of(name: &str) -> CelType {
    CelType::Parameter(ParameterType { name: name.into() })
}

/// A union of its distinct members, in first-seen order: a union member is flattened
/// into its members, one member is that member, and none — or any `dyn` — is `dyn`.
/// Distinctness is [`types_equal`], found through a hash that agrees with it, so the
/// work grows with the members rather than with their square wherever their hashes
/// differ — which a member's own level decides.
pub fn union_of<I: IntoIterator<Item = CelType>>(members: I) -> CelType {
    let mut flat: Vec<CelType> = Vec::new();
    let mut buckets: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut add = |part: CelType, flat: &mut Vec<CelType>| {
        let bucket = buckets.entry(equality_hash(&part)).or_default();
        if bucket.iter().any(|at| types_equal(&flat[*at], &part)) {
            return;
        }
        bucket.push(flat.len());
        flat.push(part);
    };
    for member in members {
        match &member {
            CelType::Union(union) => {
                for part in union.members.iter() {
                    add(part.clone(), &mut flat);
                }
            }
            _ => add(member, &mut flat),
        }
    }
    match flat.len() {
        0 => DYN,
        1 => flat.pop().expect("one member is held"),
        _ if flat.iter().any(is_dyn) => DYN,
        _ => CelType::Union(UnionType { members: flat.into() }),
    }
}

pub fn is_dyn(ty: &CelType) -> bool {
    matches!(ty, CelType::Dyn)
}

pub fn is_numeric(ty: &CelType) -> bool {
    matches!(ty, CelType::Primitive(PrimitiveName::Int | PrimitiveName::Uint | PrimitiveName::Double))
}

/// Whether a type admits a null value — a null, or a union holding one.
pub fn admits_null(ty: &CelType) -> bool {
    match ty {
        CelType::Primitive(name) => *name == PrimitiveName::Null,
        CelType::Union(union) => union.members.iter().any(|member| matches!(member, CelType::Primitive(PrimitiveName::Null))),
        _ => false,
    }
}

/// The type with every null taken out of it; `dyn` and a bare null are unchanged.
pub fn without_null(ty: &CelType) -> CelType {
    let CelType::Union(union) = ty else { return ty.clone() };
    let members: Vec<CelType> = union.members.iter().filter(|member| !admits_null(member)).cloned().collect();
    if members.is_empty() {
        ty.clone()
    } else {
        union_of(members)
    }
}

// --- the equality the rules use ------------------------------------------------

/// Node's equality: a record's fields compared in any order, with its name and
/// openness; a union's members in order; a named type by its name and arguments only;
/// a parameter by its name.
pub fn types_equal(left: &CelType, right: &CelType) -> bool {
    TypePairs::default().equal(left, right)
}

/// A container's identity to a walk: its kind and the addresses of what it shares, which no
/// other type holds; nothing for any other type.
pub(crate) type WalkKey = (u8, usize, usize);

pub(crate) fn walk_key(ty: &CelType) -> Option<WalkKey> {
    match ty {
        CelType::Record(record) => Some((0, record.fields.identity(), 0)),
        CelType::List(list) => Some((1, Arc::as_ptr(&list.element) as usize, list.prefix_elements.as_ref().map_or(0, |prefix| prefix.as_ptr() as usize))),
        CelType::Map(map) => Some((2, Arc::as_ptr(&map.key) as usize, Arc::as_ptr(&map.value) as usize)),
        CelType::Optional(optional) => Some((3, Arc::as_ptr(&optional.value) as usize, 0)),
        CelType::Union(union) => Some((4, union.members.as_ptr() as usize, 0)),
        // A named type shares its name and arguments with the one it was registered from, so
        // those say nothing of its base and fields: it is compared, never keyed.
        _ => None,
    }
}

fn pair_key(left: &CelType, right: &CelType) -> Option<(WalkKey, WalkKey)> {
    Some((walk_key(left)?, walk_key(right)?))
}

/// One two-type walk — equality, assignability or the join — for the duration of the call:
/// types are shared graphs, so each identity pair is answered once, and a type compared with
/// itself at once. Types hold no cycle, so an answer is a result, never an assumption.
#[derive(Default)]
struct TypePairs {
    equal: HashMap<(WalkKey, WalkKey), bool>,
    assignable: HashMap<(WalkKey, WalkKey), bool>,
    joins: HashMap<(WalkKey, WalkKey), CelType>,
    /// Whether the walk outlives the types it is handed, as the join's does: it then holds
    /// every type a key names, so no address it keys by is reused while it lasts.
    holds: bool,
    held: Vec<CelType>,
}

impl TypePairs {
    fn hold(&mut self, types: [&CelType; 2]) {
        if self.holds {
            self.held.extend(types.into_iter().cloned());
        }
    }

    /// [`types_equal`]: a pair whose children all agree is equal, and every pair still open
    /// when one differs is not.
    fn equal(&mut self, left: &CelType, right: &CelType) -> bool {
        enum Visit<'t> {
            Enter(&'t CelType, &'t CelType),
            Leave,
        }
        let mut pending = vec![Visit::Enter(left, right)];
        let mut open: Vec<(WalkKey, WalkKey)> = Vec::new();
        let answer = loop {
            let Some(visit) = pending.pop() else { break true };
            let (at_left, at_right) = match visit {
                Visit::Enter(left, right) => (left, right),
                Visit::Leave => {
                    let pair = open.pop().expect("a pair is open");
                    self.equal.insert(pair, true);
                    continue;
                }
            };
            count_type_visit();
            // A type is itself: a shape shared at many places is compared once, not once per path to it.
            if shares_identity(at_left, at_right) {
                continue;
            }
            let pair = pair_key(at_left, at_right);
            match pair.and_then(|pair| self.equal.get(&pair).copied()) {
                Some(true) => continue,
                Some(false) => break false,
                None => {}
            }
            let mut beneath = Vec::new();
            if !equal_at_own_level(at_left, at_right, |a, b| beneath.push(Visit::Enter(a, b))) {
                if let Some(pair) = pair {
                    self.equal.insert(pair, false);
                }
                break false;
            }
            if let Some(pair) = pair {
                open.push(pair);
                pending.push(Visit::Leave);
            }
            pending.extend(beneath);
        };
        if !answer {
            self.equal.extend(open.into_iter().map(|pair| (pair, false)));
        }
        self.hold([left, right]);
        answer
    }
}

/// Whether two types are one value: the same shared contents, which no other type holds.
fn shares_identity(left: &CelType, right: &CelType) -> bool {
    match (left, right) {
        (CelType::Record(a), CelType::Record(b)) => a.fields.identity() == b.fields.identity(),
        (CelType::List(a), CelType::List(b)) => Arc::ptr_eq(&a.element, &b.element),
        (CelType::Map(a), CelType::Map(b)) => Arc::ptr_eq(&a.key, &b.key) && Arc::ptr_eq(&a.value, &b.value),
        (CelType::Optional(a), CelType::Optional(b)) => Arc::ptr_eq(&a.value, &b.value),
        (CelType::Union(a), CelType::Union(b)) => Arc::ptr_eq(&a.members, &b.members),
        _ => false,
    }
}

/// [`types_equal`] at one level: whether the two agree there, each pair of children
/// left to compare handed to `beneath`, in the order the equality pushes them.
pub(crate) fn equal_at_own_level<'t>(
    left: &'t CelType,
    right: &'t CelType,
    mut beneath: impl FnMut(&'t CelType, &'t CelType),
) -> bool {
    match (left, right) {
        (CelType::Dyn, CelType::Dyn) => true,
        (CelType::Primitive(a), CelType::Primitive(b)) => a == b,
        (CelType::List(a), CelType::List(b)) => {
            let positions = match (&a.prefix_elements, &b.prefix_elements) {
                (None, None) => true,
                (Some(a), Some(b)) => a.len() == b.len(),
                _ => false,
            };
            if !positions || a.additional_elements.is_some() != b.additional_elements.is_some() {
                return false;
            }
            // A tuple's element is derived from its positions and rest, so two tuples compare those alone.
            match (&a.prefix_elements, &b.prefix_elements) {
                (Some(prefix), Some(other)) => {
                    prefix.iter().zip(other.iter()).for_each(|(a, b)| beneath(a, b));
                    if let (Some(a), Some(b)) = (&a.additional_elements, &b.additional_elements) {
                        beneath(a, b);
                    }
                }
                _ => beneath(&a.element, &b.element),
            }
            true
        }
        (CelType::Map(a), CelType::Map(b)) => {
            beneath(&a.value, &b.value);
            beneath(&a.key, &b.key);
            true
        }
        (CelType::Optional(a), CelType::Optional(b)) => {
            beneath(&a.value, &b.value);
            true
        }
        (CelType::Record(a), CelType::Record(b)) => {
            if a.name != b.name
                || a.fields.len() != b.fields.len()
                || a.additional_fields.is_some() != b.additional_fields.is_some()
                || !same_names(a.absent_fields.as_deref(), b.absent_fields.as_deref())
                || !same_enums(a, b)
                || a.pattern_count() != b.pattern_count()
                || a.pattern_part_count() != b.pattern_part_count()
            {
                return false;
            }
            // The same parts in any order, each with the same patterns in any order, each
            // giving the same type, and the same undeclared members.
            let mut patterns = Vec::with_capacity(a.pattern_count() + a.pattern_part_count());
            let mut unmatched: Vec<usize> = (0..b.pattern_part_count()).collect();
            for part in 0..a.pattern_part_count() {
                let pairs = unmatched.iter().enumerate().find_map(|(index, other)| part_pairs(a, part, b, *other).map(|pairs| (index, pairs)));
                match pairs {
                    Some((index, pairs)) => {
                        unmatched.remove(index);
                        patterns.extend(pairs);
                    }
                    None => return false,
                }
            }
            for (name, ty) in a.fields.iter() {
                match b.fields.get(name) {
                    Some(held) => beneath(ty, held),
                    None => return false,
                }
            }
            if let (Some(a), Some(b)) = (&a.additional_fields, &b.additional_fields) {
                beneath(a, b);
            }
            for (ty, held) in patterns {
                if let (Some(ty), Some(held)) = (ty, held) {
                    beneath(ty, held);
                }
            }
            true
        }
        (CelType::Union(a), CelType::Union(b)) => {
            if a.members.len() != b.members.len() {
                return false;
            }
            a.members.iter().zip(b.members.iter()).for_each(|(a, b)| beneath(a, b));
            true
        }
        (CelType::Nominal(a), CelType::Nominal(b)) => {
            if a.name != b.name || a.args.len() != b.args.len() {
                return false;
            }
            a.args.iter().zip(b.args.iter()).for_each(|(a, b)| beneath(a, b));
            true
        }
        (CelType::Parameter(a), CelType::Parameter(b)) => a.name == b.name,
        _ => false,
    }
}

/// Where a part of one record carries the same patterns, each giving a type or none alike, and
/// gives undeclared members alike, as a part of another: the pairs of types to compare.
#[allow(clippy::type_complexity)]
fn part_pairs<'t>(
    a: &'t RecordType,
    part: usize,
    b: &'t RecordType,
    other: usize,
) -> Option<Vec<(Option<&'t CelType>, Option<&'t CelType>)>> {
    let (entries, held) = (a.part_entries(part), b.part_entries(other));
    if entries.len() != held.len() || a.part_additional(part).is_some() != b.part_additional(other).is_some() {
        return None;
    }
    let mut pairs = Vec::with_capacity(entries.len() + 1);
    for at in entries {
        let (pattern, ty) = a.pattern_at(at);
        let found = held.clone().find(|at| b.pattern_at(*at).0 == pattern)?;
        let other_ty = b.pattern_at(found).1;
        if other_ty.is_some() != ty.is_some() {
            return None;
        }
        pairs.push((ty, other_ty));
    }
    pairs.push((a.part_additional(part), b.part_additional(other)));
    Some(pairs)
}

/// Whether two records carry a set for the same fields, each the same set.
fn same_enums(a: &RecordType, b: &RecordType) -> bool {
    a.field_enums().count() == b.field_enums().count()
        && a.field_enums().all(|(field, values)| b.field_enum(field) == Some(values))
}

/// Whether two name lists hold the same names, in any order.
fn same_names(left: Option<&[Arc<str>]>, right: Option<&[Arc<str>]>) -> bool {
    let (left, right) = (left.unwrap_or(&[]), right.unwrap_or(&[]));
    left.len() == right.len() && left.iter().all(|name| right.contains(name))
}

/// A hash two types equal by [`types_equal`] share, read from the type's own level and
/// the kinds of its children only — so hashing a member costs its width, never its
/// depth. A record's field names are combined in an order-independent way; a named
/// type's base and fields are left out, as the equality leaves them.
fn equality_hash(ty: &CelType) -> u64 {
    fn own(ty: &CelType, hasher: &mut DefaultHasher) {
        std::mem::discriminant(ty).hash(hasher);
        match ty {
            CelType::Primitive(name) => name.hash(hasher),
            CelType::Parameter(parameter) => parameter.name.hash(hasher),
            CelType::Nominal(nominal) => {
                nominal.name.hash(hasher);
                nominal.args.len().hash(hasher);
            }
            CelType::List(list) => {
                list.prefix_elements.as_ref().map(|prefix| prefix.len()).hash(hasher);
                list.additional_elements.is_some().hash(hasher);
            }
            CelType::Record(record) => {
                record.name.hash(hasher);
                record.additional_fields.is_some().hash(hasher);
                let mut absent: u64 = 0;
                for name in record.absent_fields() {
                    let mut member = DefaultHasher::new();
                    name.hash(&mut member);
                    absent = absent.wrapping_add(member.finish());
                }
                absent.hash(hasher);
                let mut patterns: u64 = 0;
                for part in 0..record.pattern_part_count() {
                    let mut entries: u64 = 0;
                    for at in record.part_entries(part) {
                        let (pattern, ty) = record.pattern_at(at);
                        let mut entry = DefaultHasher::new();
                        pattern.hash(&mut entry);
                        ty.is_some().hash(&mut entry);
                        entries = entries.wrapping_add(entry.finish());
                    }
                    let mut held = DefaultHasher::new();
                    entries.hash(&mut held);
                    record.part_additional(part).is_some().hash(&mut held);
                    patterns = patterns.wrapping_add(held.finish());
                }
                patterns.hash(hasher);
                let mut names: u64 = 0;
                for name in record.fields.keys() {
                    let mut field = DefaultHasher::new();
                    name.hash(&mut field);
                    names = names.wrapping_add(field.finish());
                }
                names.hash(hasher);
            }
            CelType::Union(union) => union.members.len().hash(hasher),
            _ => {}
        }
    }
    let mut hasher = DefaultHasher::new();
    own(ty, &mut hasher);
    match ty {
        CelType::List(list) => own(&list.element, &mut hasher),
        CelType::Map(map) => {
            own(&map.key, &mut hasher);
            own(&map.value, &mut hasher);
        }
        CelType::Optional(optional) => own(&optional.value, &mut hasher),
        CelType::Union(union) => union.members.iter().for_each(|member| own(member, &mut hasher)),
        CelType::Nominal(nominal) => nominal.args.iter().for_each(|argument| own(argument, &mut hasher)),
        _ => {}
    }
    hasher.finish()
}

// --- printing ------------------------------------------------------------------

/// How many type nodes a printed type writes before it is cut — read from the data Node's
/// engine reads, so both cut a type alike.
pub const TYPE_TEXT_NODE_LIMIT: usize = crate::function_registry::first_number(include_str!("../../nodejs/src/type-text.json").as_bytes());

/// How a type is written. `top` collapses a list or map of `dyn` to its bare name, which
/// is how the whole type of an expression is reported. Written whole up to
/// [`TYPE_TEXT_NODE_LIMIT`] type nodes, then cut: printing walks the type in pre-order — a
/// union's members in order, a container's arguments in order, a record as its one name —
/// each type node written counting one (a union writes only its members); the node that
/// would exceed the limit is written `...` and printing stops there, every open bracket
/// closed. The one writer of a type a check reports and a message names.
pub fn format_type(ty: &CelType, top: bool) -> String {
    write_type(ty, top, TYPE_TEXT_NODE_LIMIT)
}

/// A type written whole, however large — the text a signature and the environment's listing
/// are identified by, which a cut would let two different types share.
pub(crate) fn exact_type_text(ty: &CelType, top: bool) -> String {
    write_type(ty, top, usize::MAX)
}

fn write_type(ty: &CelType, top: bool, limit: usize) -> String {
    enum Piece<'a> {
        Text(&'a str),
        Type(&'a CelType),
    }
    if top {
        match ty {
            CelType::List(list) if is_dyn(&list.element) => return "list".into(),
            CelType::Map(map) if is_dyn(&map.key) && is_dyn(&map.value) => return "map".into(),
            _ => {}
        }
    }
    let mut out = String::new();
    let mut pending = vec![Piece::Type(ty)];
    let (mut written, mut stopped) = (0usize, false);
    while let Some(piece) = pending.pop() {
        let ty = match piece {
            // Once cut, only the brackets still open are written.
            Piece::Text(text) => {
                if !stopped || text == ">" {
                    out.push_str(text);
                }
                continue;
            }
            Piece::Type(ty) => ty,
        };
        if stopped {
            continue;
        }
        if !matches!(ty, CelType::Union(_)) {
            if written == limit {
                out.push_str("...");
                stopped = true;
                continue;
            }
            written += 1;
        }
        match ty {
            CelType::Dyn => out.push_str("dyn"),
            CelType::Primitive(name) => out.push_str(name.printed()),
            CelType::List(list) => {
                out.push_str("list<");
                pending.push(Piece::Text(">"));
                pending.push(Piece::Type(&list.element));
            }
            CelType::Map(map) => {
                out.push_str("map<");
                pending.push(Piece::Text(">"));
                pending.push(Piece::Type(&map.value));
                pending.push(Piece::Text(", "));
                pending.push(Piece::Type(&map.key));
            }
            CelType::Optional(optional) => {
                out.push_str("optional<");
                pending.push(Piece::Text(">"));
                pending.push(Piece::Type(&optional.value));
            }
            CelType::Record(record) => out.push_str(record.name.as_deref().unwrap_or("map")),
            CelType::Union(union) => {
                for (at, member) in union.members.iter().enumerate().rev() {
                    pending.push(Piece::Type(member));
                    if at > 0 {
                        pending.push(Piece::Text("|"));
                    }
                }
            }
            CelType::Nominal(nominal) => {
                out.push_str(&nominal.name);
                if !nominal.args.is_empty() {
                    out.push('<');
                    pending.push(Piece::Text(">"));
                    for (at, argument) in nominal.args.iter().enumerate().rev() {
                        pending.push(Piece::Type(argument));
                        if at > 0 {
                            pending.push(Piece::Text(", "));
                        }
                    }
                }
            }
            CelType::Parameter(parameter) => out.push_str(&parameter.name),
        }
    }
    out
}

// --- reporting -----------------------------------------------------------------

/// The type with every unresolved type parameter replaced by `dyn` — the last step
/// before a type is reported. A part nothing replaced in is shared, not copied, and each
/// type object is answered once per call, so a shared part is replaced once and stays shared.
pub fn without_parameters(ty: &CelType) -> CelType {
    enum Task<'a> {
        Visit(&'a CelType),
        Rebuild(&'a CelType),
    }
    // Each result is the rebuilt type and whether anything in it was replaced.
    let mut results: Vec<(CelType, bool)> = Vec::new();
    let mut answered: HashMap<WalkKey, (CelType, bool)> = HashMap::new();
    let mut tasks = vec![Task::Visit(ty)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(ty) => {
                count_type_visit();
                if let Some(held) = walk_key(ty).and_then(|key| answered.get(&key)) {
                    results.push(held.clone());
                    continue;
                }
                let children: Vec<&CelType> = match ty {
                    CelType::Parameter(_) => {
                        results.push((DYN, true));
                        continue;
                    }
                    CelType::List(list) => list_children(list),
                    CelType::Map(map) => vec![&map.key, &map.value],
                    CelType::Optional(optional) => vec![&optional.value],
                    CelType::Union(union) => union.members.iter().collect(),
                    CelType::Nominal(nominal) => nominal.args.iter().collect(),
                    CelType::Record(record) => record_children(record),
                    _ => {
                        results.push((ty.clone(), false));
                        continue;
                    }
                };
                tasks.push(Task::Rebuild(ty));
                tasks.extend(children.into_iter().rev().map(Task::Visit));
            }
            Task::Rebuild(ty) => {
                let count = match ty {
                    CelType::List(list) => list_children(list).len(),
                    CelType::Optional(_) => 1,
                    CelType::Map(_) => 2,
                    CelType::Union(union) => union.members.len(),
                    CelType::Nominal(nominal) => nominal.args.len(),
                    CelType::Record(record) => record_children(record).len(),
                    _ => unreachable!("only a type with children is rebuilt"),
                };
                let children = results.split_off(results.len() - count);
                if !children.iter().any(|(_, moved)| *moved) {
                    remember_replaced(&mut answered, ty, (ty.clone(), false));
                    results.push((ty.clone(), false));
                    continue;
                }
                let mut children = children.into_iter().map(|(child, _)| child);
                let mut next = || children.next().expect("each child was rebuilt");
                let rebuilt = match ty {
                    CelType::List(list) => match &list.prefix_elements {
                        None => list_of(next()),
                        Some(prefix) => {
                            let positions: Vec<CelType> = prefix.iter().map(|_| next()).collect();
                            let rest = list.additional_elements.as_ref().map(|_| next());
                            tuple_of(positions, rest)
                        }
                    },
                    CelType::Map(_) => {
                        let key = next();
                        map_of(key, next())
                    }
                    CelType::Optional(_) => optional_of(next()),
                    CelType::Union(union) => union_of((0..union.members.len()).map(|_| next()).collect::<Vec<_>>()),
                    CelType::Nominal(nominal) => CelType::Nominal(NominalType {
                        args: (0..nominal.args.len()).map(|_| next()).collect::<Vec<_>>().into(),
                        ..nominal.clone()
                    }),
                    CelType::Record(record) => {
                        let fields: TypeFields = record.fields.keys().map(|name| (name, next())).collect();
                        let patterns: Vec<PatternPart> = record
                            .pattern_parts()
                            .into_iter()
                            .map(|part| PatternPart {
                                fields: part
                                    .fields
                                    .into_iter()
                                    .map(|entry| PatternField { pattern: entry.pattern, ty: entry.ty.map(|_| next()) })
                                    .collect(),
                                additional_fields: part.additional_fields.map(|_| next()),
                            })
                            .collect();
                        let additional = record.additional_fields.as_ref().map(|_| next());
                        record_of(
                            fields,
                            additional,
                            record.absent_fields().map(Arc::from).collect(),
                            record.name.clone(),
                            patterns,
                            record.field_enums().map(|(field, values)| (Arc::from(field), values.to_vec())).collect(),
                        )
                    }
                    _ => unreachable!("only a type with children is rebuilt"),
                };
                remember_replaced(&mut answered, ty, (rebuilt.clone(), true));
                results.push((rebuilt, true));
            }
        }
    }
    results.pop().expect("the root is rebuilt last").0
}

fn remember_replaced(answered: &mut HashMap<WalkKey, (CelType, bool)>, ty: &CelType, answer: (CelType, bool)) {
    if let Some(key) = walk_key(ty) {
        answered.insert(key, answer);
    }
}

/// What [`without_parameters`] rebuilds a list from: a tuple's positions and rest, a plain
/// list's element (a tuple's element is their join, rebuilt with them).
fn list_children(list: &ListType) -> Vec<&CelType> {
    match &list.prefix_elements {
        None => vec![&list.element],
        Some(prefix) => prefix.iter().chain(list.additional_elements.as_deref()).collect(),
    }
}

/// The type of every member a record may hold, in the order [`without_parameters`] rebuilds a
/// record from: each field, each part's entries and undeclared members, then its own
/// undeclared members'.
pub(crate) fn record_children(record: &RecordType) -> Vec<&CelType> {
    let mut children: Vec<&CelType> = record.fields.values().collect();
    for part in 0..record.pattern_part_count() {
        children.extend(record.part_entries(part).filter_map(|at| record.pattern_at(at).1));
        children.extend(record.part_additional(part));
    }
    children.extend(record.additional_fields.as_deref());
    children
}

// --- assignability and unification ---------------------------------------------

/// A boolean question over types, kept on the heap: a leaf, or all / any of its parts.
enum Question<'a> {
    Assignable(&'a CelType, &'a CelType),
    Equal(&'a CelType, &'a CelType),
    Answer(bool),
    All(Vec<Question<'a>>),
    Any(Vec<Question<'a>>),
}

/// What deciding `assignable(from, to)` asks next.
fn assignable_parts<'a>(from: &'a CelType, to: &'a CelType) -> Question<'a> {
    use Question::*;
    if is_dyn(from) || is_dyn(to) {
        return Answer(true);
    }
    if matches!(to, CelType::Parameter(_)) || matches!(from, CelType::Parameter(_)) {
        return Answer(true);
    }
    if let CelType::Union(union) = from {
        return All(union.members.iter().map(|member| Assignable(member, to)).collect());
    }
    if let CelType::Union(union) = to {
        return Any(union.members.iter().map(|member| Assignable(from, member)).collect());
    }
    if matches!(from, CelType::Nominal(_)) || matches!(to, CelType::Nominal(_)) {
        return Equal(from, to);
    }
    match to {
        CelType::List(to) => match from {
            // Element by element, and position by position where both declare one. A position
            // standing where its counterpart does stands where the wanted element does, so each
            // is asked once: the shared positions pairwise, then the rest of `from`'s members
            // against the wanted element — unless `from`'s element is `dyn`, which stands anywhere.
            CelType::List(from) => match (&from.prefix_elements, &to.prefix_elements) {
                (Some(held), Some(wanted)) => {
                    let mut parts: Vec<Question<'_>> = held.iter().zip(wanted.iter()).map(|(from, to)| Assignable(from, to)).collect();
                    if !is_dyn(&from.element) {
                        parts.extend(held.iter().skip(wanted.len()).map(|from| Assignable(from, &to.element)));
                        parts.extend(from.additional_elements.iter().map(|rest| Assignable(rest, &to.element)));
                    }
                    All(parts)
                }
                _ => Assignable(&from.element, &to.element),
            },
            _ => Answer(false),
        },
        CelType::Map(to) => {
            let as_map = match from {
                CelType::Map(from) => All(vec![Assignable(&from.key, &to.key), Assignable(&from.value, &to.value)]),
                _ => Answer(false),
            };
            // A record is a map with named keys, so it stands where a string-keyed map does.
            let as_record = match from {
                CelType::Record(record) => {
                    // Every field, and every member it does not declare, against the value type.
                    let values = if is_dyn(&to.value) {
                        Answer(true)
                    } else {
                        All(record_children(record).into_iter().map(|ty| Assignable(ty, &to.value)).collect())
                    };
                    All(vec![Assignable(&STRING_TYPE, &to.key), values])
                }
                _ => Answer(false),
            };
            Any(vec![as_map, as_record])
        }
        CelType::Optional(to) => match from {
            CelType::Optional(from) => Assignable(&from.value, &to.value),
            _ => Answer(false),
        },
        CelType::Record(_) => match from {
            CelType::Record(_) => Equal(from, to),
            _ => Answer(false),
        },
        _ => Equal(from, to),
    }
}

/// Whether a value of `from` may stand where `to` is wanted. `dyn` and an unresolved
/// parameter pass both ways; a named type accepts only itself; a union passes where
/// every member does and accepts what any member accepts. Numeric types never convert.
pub fn assignable(from: &CelType, to: &CelType) -> bool {
    TypePairs::default().assignable(from, to)
}

/// One open `All` or `Any` of [`TypePairs::assignable`]: the parts it has not asked yet, and the
/// pair whose answer it is, kept once it answers.
struct Frame<'a> {
    any: bool,
    parts: std::vec::IntoIter<Question<'a>>,
    pair: Option<(WalkKey, WalkKey)>,
}

impl TypePairs {
    /// [`assignable`], each pair answered once: a pair's answer is kept when the question it
    /// opened answers.
    fn assignable(&mut self, from: &CelType, to: &CelType) -> bool {
        let mut frames: Vec<Frame<'_>> = Vec::new();
        let mut next = Question::Assignable(from, to);
        let answer = 'walk: loop {
            // Descend to the next leaf's answer.
            let value = loop {
                match next {
                    Question::Assignable(from, to) => {
                        count_type_visit();
                        let pair = pair_key(from, to);
                        // Every type stands where it is itself wanted.
                        if let Some((held, wanted)) = pair {
                            if held == wanted {
                                break true;
                            }
                            if let Some(answer) = self.assignable.get(&(held, wanted)) {
                                break *answer;
                            }
                        }
                        match assignable_parts(from, to) {
                            Question::Answer(value) => {
                                self.keep_assignable(pair, value);
                                break value;
                            }
                            Question::Equal(left, right) => {
                                let value = self.equal(left, right);
                                self.keep_assignable(pair, value);
                                break value;
                            }
                            // One part answers for the pair: a frame holding none answers what it does.
                            part @ Question::Assignable(..) => {
                                frames.push(Frame { any: false, parts: Vec::new().into_iter(), pair });
                                next = part;
                            }
                            Question::All(parts) => match open(&mut frames, false, parts, pair) {
                                Some(part) => next = part,
                                None => {
                                    self.keep_assignable(pair, true);
                                    break true;
                                }
                            },
                            Question::Any(parts) => match open(&mut frames, true, parts, pair) {
                                Some(part) => next = part,
                                None => {
                                    self.keep_assignable(pair, false);
                                    break false;
                                }
                            },
                        }
                    }
                    Question::Equal(left, right) => break self.equal(left, right),
                    Question::Answer(value) => break value,
                    Question::All(parts) => match open(&mut frames, false, parts, None) {
                        Some(part) => next = part,
                        None => break true,
                    },
                    Question::Any(parts) => match open(&mut frames, true, parts, None) {
                        Some(part) => next = part,
                        None => break false,
                    },
                }
            };
            // Carry the answer up until a frame has a part left to ask. A frame whose
            // parts are all asked answers what its last part did.
            loop {
                let Some(frame) = frames.last_mut() else { break 'walk value };
                if frame.any == value {
                    let pair = frames.pop().expect("a frame is open").pair;
                    self.keep_assignable(pair, value);
                    continue;
                }
                match frame.parts.next() {
                    Some(part) => {
                        next = part;
                        break;
                    }
                    None => {
                        let pair = frames.pop().expect("a frame is open").pair;
                        self.keep_assignable(pair, value);
                    }
                }
            }
        };
        self.hold([from, to]);
        answer
    }

    fn keep_assignable(&mut self, pair: Option<(WalkKey, WalkKey)>, value: bool) {
        if let Some(pair) = pair {
            self.assignable.insert(pair, value);
        }
    }
}

/// Opens a frame over its parts and answers the first, or nothing for none.
fn open<'a>(frames: &mut Vec<Frame<'a>>, any: bool, parts: Vec<Question<'a>>, pair: Option<(WalkKey, WalkKey)>) -> Option<Question<'a>> {
    let mut parts = parts.into_iter();
    let first = parts.next()?;
    frames.push(Frame { any, parts, pair });
    Some(first)
}

/// The one type both sides can be: symmetric, `dyn` where they have nothing in common.
/// An unresolved parameter yields to the other side. A record is a map with named keys
/// (see [`assignable`]), so against a map, or a record of another shape, it joins as
/// that map: its key `string` joined with the map's, its value every field folded from
/// an unresolved parameter, then its undeclared members' type. Two tuples of as many
/// positions join position by position, their rest the join of the rests they have. Null is joined apart — the sides
/// joined without it and null added back where either admitted it, a side that is only
/// null joining as the other plus null — and a union joined with a type it includes is
/// that union. A union joined with a type it does not include widens by kin: against the
/// other side — the right one where both are unions — one member at a time, a member that
/// stands where some member of the union does is absorbed, one whose join with some member
/// of the union is one type is kept as a member of its own, and one with nothing in common
/// with any makes the join `dyn`; the members stay in written order, the union's all kept.
pub fn unify(left: &CelType, right: &CelType) -> CelType {
    TypePairs { holds: true, ..TypePairs::default() }.unify(left, right)
}

impl TypePairs {
    /// [`unify`], each pair joined once.
    fn unify(&mut self, left: &CelType, right: &CelType) -> CelType {
        /// A side borrowed from the caller, or a part of one reached through its `Arc`s.
        enum Side<'a> {
            Borrowed(&'a CelType),
            Shared(Arc<CelType>),
        }
        impl Side<'_> {
            fn get(&self) -> &CelType {
                match self {
                    Side::Borrowed(ty) => ty,
                    Side::Shared(ty) => ty,
                }
            }
        }
        enum Task<'a> {
            Unify(Side<'a>, Side<'a>),
            /// Answers a type already known.
            Known(CelType),
            /// Joins the last answer with a record's field.
            Fold(CelType),
            /// Joins the last two answers.
            Join,
            List,
            /// A tuple of the last `positions` answers, then the rest when there is one.
            Tuple { positions: usize, rest: bool },
            Map,
            Optional,
            /// Adds null back to the last answer, unless it is `dyn`.
            Nullable,
            /// Judges the other side's member `at` of a join by kin, the ones before it judged.
            KinNext(Kin),
            /// Takes the join of the other side's member `at` with the union's member `tried`.
            KinAnswer(Kin, usize),
            /// Keeps the last answer as the join of a pair, holding the pair's two types.
            Remember((WalkKey, WalkKey), CelType, CelType),
        }
        /// A union joined by kin with the members of the other side, those kept so far.
        struct Kin {
            union: Vec<CelType>,
            other: Vec<CelType>,
            union_left: bool,
            at: usize,
            kept: Vec<CelType>,
        }
        /// Queues the value type of the map a record is, to be answered once.
        fn record_value(tasks: &mut Vec<Task<'_>>, record: &RecordType) {
            // A record with no fields says nothing about its values, as an empty map does not.
            for ty in record_children(record).into_iter().rev() {
                tasks.push(Task::Fold(ty.clone()));
            }
            tasks.push(Task::Known(parameter_of("V")));
        }
        /// What a record joins as a map against.
        enum Against<'b> {
            Map(&'b MapType),
            Record(&'b RecordType),
        }
        /// Queues the map a record joins as against a map, or a record of another shape.
        fn record_as_map(tasks: &mut Vec<Task<'_>>, record: &RecordType, other: Against<'_>) {
            tasks.push(Task::Map);
            tasks.push(Task::Join);
            match other {
                Against::Map(map) => tasks.push(Task::Known((*map.value).clone())),
                Against::Record(other) => record_value(tasks, other),
            }
            record_value(tasks, record);
            tasks.push(match other {
                Against::Map(map) => Task::Unify(Side::Borrowed(&STRING_TYPE), Side::Shared(Arc::clone(&map.key))),
                Against::Record(_) => Task::Known(STRING),
            });
        }
        let mut tasks = vec![Task::Unify(Side::Borrowed(left), Side::Borrowed(right))];
        let mut results: Vec<CelType> = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Unify(left_side, right_side) => {
                    let (left, right) = (left_side.get(), right_side.get());
                    count_type_visit();
                    if let Some(pair) = pair_key(left, right) {
                        if let Some(joined) = self.joins.get(&pair) {
                            results.push(joined.clone());
                            continue;
                        }
                        tasks.push(Task::Remember(pair, left.clone(), right.clone()));
                    }
                    if self.equal(left, right) {
                        results.push(left.clone());
                    } else if matches!(left, CelType::Parameter(_)) {
                        results.push(right.clone());
                    } else if matches!(right, CelType::Parameter(_)) {
                        results.push(left.clone());
                    } else if is_dyn(left) || is_dyn(right) {
                        results.push(DYN);
                    } else if admits_null(left) || admits_null(right) {
                        // Null joins apart: the rest is joined, and null added back.
                        let held = |ty: &CelType| (!matches!(ty, CelType::Primitive(PrimitiveName::Null))).then(|| without_null(ty));
                        match (held(left), held(right)) {
                            (Some(left), Some(right)) => {
                                tasks.push(Task::Nullable);
                                tasks.push(Task::Unify(Side::Shared(Arc::new(left)), Side::Shared(Arc::new(right))));
                            }
                            (Some(only), None) | (None, Some(only)) => results.push(union_of([only, NULL])),
                            (None, None) => results.push(NULL),
                        }
                    } else if self.includes(left, right) {
                        // A union joined with a type it includes is that union.
                        results.push(left.clone());
                    } else if self.includes(right, left) {
                        results.push(right.clone());
                    } else if matches!(left, CelType::Union(_)) || matches!(right, CelType::Union(_)) {
                        let (union, other, union_left) = match (left, right) {
                            (CelType::Union(union), other) => (union, other, true),
                            (other, CelType::Union(union)) => (union, other, false),
                            _ => unreachable!("one side is a union"),
                        };
                        let other = match other {
                            CelType::Union(other) => other.members().to_vec(),
                            single => vec![single.clone()],
                        };
                        tasks.push(Task::KinNext(Kin { union: union.members().to_vec(), other, union_left, at: 0, kept: Vec::new() }));
                    } else {
                        match (left, right) {
                            (CelType::List(left), CelType::List(right)) => match (&left.prefix_elements, &right.prefix_elements) {
                                (Some(prefix), Some(other)) if prefix.len() == other.len() => {
                                    let rests: Vec<&Arc<CelType>> =
                                        left.additional_elements.iter().chain(right.additional_elements.iter()).collect();
                                    tasks.push(Task::Tuple { positions: prefix.len(), rest: !rests.is_empty() });
                                    match rests.as_slice() {
                                        [one] => tasks.push(Task::Known((***one).clone())),
                                        [a, b] => tasks.push(Task::Unify(Side::Shared(Arc::clone(a)), Side::Shared(Arc::clone(b)))),
                                        _ => {}
                                    }
                                    for (a, b) in prefix.iter().zip(other.iter()).rev() {
                                        tasks.push(Task::Unify(Side::Shared(Arc::new(a.clone())), Side::Shared(Arc::new(b.clone()))));
                                    }
                                }
                                _ => {
                                    tasks.push(Task::List);
                                    tasks.push(Task::Unify(
                                        Side::Shared(Arc::clone(&left.element)),
                                        Side::Shared(Arc::clone(&right.element)),
                                    ));
                                }
                            },
                            (CelType::Map(left), CelType::Map(right)) => {
                                tasks.push(Task::Map);
                                tasks.push(Task::Unify(
                                    Side::Shared(Arc::clone(&left.value)),
                                    Side::Shared(Arc::clone(&right.value)),
                                ));
                                tasks.push(Task::Unify(
                                    Side::Shared(Arc::clone(&left.key)),
                                    Side::Shared(Arc::clone(&right.key)),
                                ));
                            }
                            (CelType::Optional(left), CelType::Optional(right)) => {
                                tasks.push(Task::Optional);
                                tasks.push(Task::Unify(
                                    Side::Shared(Arc::clone(&left.value)),
                                    Side::Shared(Arc::clone(&right.value)),
                                ));
                            }
                            (CelType::Record(record), CelType::Record(other)) => {
                                record_as_map(&mut tasks, record, Against::Record(other))
                            }
                            (CelType::Record(record), CelType::Map(map)) | (CelType::Map(map), CelType::Record(record)) => {
                                record_as_map(&mut tasks, record, Against::Map(map))
                            }
                            _ => results.push(DYN),
                        }
                    }
                }
                Task::Known(ty) => results.push(ty),
                Task::Remember(pair, left, right) => {
                    let joined = results.last().expect("the pair was joined").clone();
                    self.joins.insert(pair, joined);
                    self.held.extend([left, right]);
                }
                Task::Fold(field) => {
                    let joined = results.pop().expect("the fold so far was answered");
                    tasks.push(Task::Unify(Side::Shared(Arc::new(joined)), Side::Shared(Arc::new(field))));
                }
                Task::Join => {
                    let right = results.pop().expect("the right side was answered");
                    let left = results.pop().expect("the left side was answered");
                    tasks.push(Task::Unify(Side::Shared(Arc::new(left)), Side::Shared(Arc::new(right))));
                }
                Task::List => {
                    let element = results.pop().expect("the element was unified");
                    results.push(list_of(element));
                }
                Task::Tuple { positions, rest } => {
                    let rest = rest.then(|| results.pop().expect("the rest was unified"));
                    let prefix = results.split_off(results.len() - positions);
                    results.push(tuple_of(prefix, rest));
                }
                Task::Map => {
                    let value = results.pop().expect("the value was unified");
                    let key = results.pop().expect("the key was unified");
                    results.push(map_of(key, value));
                }
                Task::Optional => {
                    let value = results.pop().expect("the value was unified");
                    results.push(optional_of(value));
                }
                Task::Nullable => {
                    let joined = results.pop().expect("the parts besides null were unified");
                    results.push(if is_dyn(&joined) { DYN } else { union_of([joined, NULL]) });
                }
                Task::KinNext(mut kin) => {
                    let Some(member) = kin.other.get(kin.at).cloned() else {
                        let members: Vec<CelType> = if kin.union_left {
                            kin.union.into_iter().chain(kin.kept).collect()
                        } else {
                            kin.kept.into_iter().chain(kin.union).collect()
                        };
                        results.push(union_of(members));
                        continue;
                    };
                    if kin.union.iter().any(|held| self.assignable(&member, held)) {
                        kin.at += 1;
                        tasks.push(Task::KinNext(kin));
                        continue;
                    }
                    let first = Arc::new(kin.union[0].clone());
                    tasks.push(Task::KinAnswer(kin, 0));
                    tasks.push(Task::Unify(Side::Shared(Arc::new(member)), Side::Shared(first)));
                }
                Task::KinAnswer(mut kin, tried) => {
                    let joined = results.pop().expect("the member and the union's member were unified");
                    let member = kin.other[kin.at].clone();
                    if !is_dyn(&joined) {
                        kin.kept.push(member);
                        kin.at += 1;
                        tasks.push(Task::KinNext(kin));
                    } else if let Some(next) = kin.union.get(tried + 1).cloned() {
                        tasks.push(Task::KinAnswer(kin, tried + 1));
                        tasks.push(Task::Unify(Side::Shared(Arc::new(member)), Side::Shared(Arc::new(next))));
                    } else {
                        results.push(DYN);
                    }
                }
            }
        }
        results.pop().expect("the root is unified last")
    }
}

impl TypePairs {
    /// Whether a union holds every member of `part` (or `part` itself).
    fn includes(&mut self, union: &CelType, part: &CelType) -> bool {
        let CelType::Union(union) = union else { return false };
        let parts = match part {
            CelType::Union(part) => part.members(),
            other => std::slice::from_ref(other),
        };
        parts.iter().all(|held| union.members().iter().any(|member| self.equal(member, held)))
    }
}

// --- data equality, Debug and Drop ----------------------------------------------

impl PartialEq for CelType {
    /// The type as data: field order, a named type's base and fields included. A pair of
    /// shared parts is compared once, and a part with itself not at all.
    fn eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other)];
        let mut compared: HashSet<(WalkKey, WalkKey)> = HashSet::new();
        while let Some((left, right)) = pending.pop() {
            if let Some((held, other)) = pair_key(left, right) {
                if held == other || !compared.insert((held, other)) {
                    continue;
                }
            }
            match (left, right) {
                (CelType::Dyn, CelType::Dyn) => {}
                (CelType::Primitive(a), CelType::Primitive(b)) if a == b => {}
                (CelType::List(a), CelType::List(b))
                    if a.prefix_elements.as_ref().map(|prefix| prefix.len())
                        == b.prefix_elements.as_ref().map(|prefix| prefix.len())
                        && a.additional_elements.is_some() == b.additional_elements.is_some() =>
                {
                    pending.push((&a.element, &b.element));
                    if let (Some(a), Some(b)) = (&a.prefix_elements, &b.prefix_elements) {
                        pending.extend(a.iter().zip(b.iter()));
                    }
                    if let (Some(a), Some(b)) = (&a.additional_elements, &b.additional_elements) {
                        pending.push((a, b));
                    }
                }
                (CelType::Map(a), CelType::Map(b)) => {
                    pending.push((&a.key, &b.key));
                    pending.push((&a.value, &b.value));
                }
                (CelType::Optional(a), CelType::Optional(b)) => pending.push((&a.value, &b.value)),
                (CelType::Record(a), CelType::Record(b))
                    if a.name == b.name
                        && a.fields.len() == b.fields.len()
                        && a.additional_fields.is_some() == b.additional_fields.is_some()
                        && a.absent_fields == b.absent_fields
                        && a.field_enums == b.field_enums
                        && a.pattern_fields.as_ref().map(|entries| (&entries.patterns, &entries.given, &entries.starts))
                            == b.pattern_fields.as_ref().map(|entries| (&entries.patterns, &entries.given, &entries.starts)) =>
                {
                    for ((a_name, a_ty), (b_name, b_ty)) in a.fields.iter().zip(b.fields.iter()) {
                        if a_name != b_name {
                            return false;
                        }
                        pending.push((a_ty, b_ty));
                    }
                    if let (Some(a), Some(b)) = (&a.additional_fields, &b.additional_fields) {
                        pending.push((a, b));
                    }
                    if let (Some(a), Some(b)) = (&a.pattern_fields, &b.pattern_fields) {
                        pending.extend(a.types.iter().zip(b.types.iter()));
                    }
                }
                (CelType::Union(a), CelType::Union(b)) if a.members.len() == b.members.len() => {
                    pending.extend(a.members.iter().zip(b.members.iter()));
                }
                (CelType::Nominal(a), CelType::Nominal(b))
                    if a.name == b.name
                        && a.args.len() == b.args.len()
                        && a.fields.as_ref().map(TypeFields::len) == b.fields.as_ref().map(TypeFields::len) =>
                {
                    pending.push((&a.base, &b.base));
                    pending.extend(a.args.iter().zip(b.args.iter()));
                    if let (Some(a), Some(b)) = (&a.fields, &b.fields) {
                        for ((a_name, a_ty), (b_name, b_ty)) in a.iter().zip(b.iter()) {
                            if a_name != b_name {
                                return false;
                            }
                            pending.push((a_ty, b_ty));
                        }
                    }
                }
                (CelType::Parameter(a), CelType::Parameter(b)) if a.name == b.name => {}
                _ => return false,
            }
        }
        true
    }
}

impl Eq for CelType {}

enum Piece<'a> {
    Text(&'static str),
    Quoted(&'a str),
    Type(&'a CelType),
    /// An optional type: `None`, or `Some(<type>)`.
    Maybe(Option<&'a CelType>),
    Fields(Option<&'a TypeFields>),
    /// An optional list of types: `None`, or `Some([…])`.
    Types(Option<&'a [CelType]>),
    Names(Option<&'a [Arc<str>]>),
    Indices(Option<&'a [usize]>),
    Enums(Option<&'a [(Arc<str>, Arc<[FieldEnumValue]>)]>),
}

fn push_sequence<'a>(pending: &mut Vec<Piece<'a>>, items: &'a [CelType]) {
    pending.push(Piece::Text("]"));
    for (at, item) in items.iter().enumerate().rev() {
        pending.push(Piece::Type(item));
        if at > 0 {
            pending.push(Piece::Text(", "));
        }
    }
    pending.push(Piece::Text("["));
}

fn push_reversed<'a, const N: usize>(pending: &mut Vec<Piece<'a>>, pieces: [Piece<'a>; N]) {
    pending.extend(pieces.into_iter().rev());
}

impl fmt::Debug for CelType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut pending = vec![Piece::Type(self)];
        while let Some(piece) = pending.pop() {
            match piece {
                Piece::Text(text) => f.write_str(text)?,
                Piece::Quoted(text) => write!(f, "{text:?}")?,
                Piece::Maybe(None)
                | Piece::Types(None)
                | Piece::Names(None)
                | Piece::Indices(None)
                | Piece::Fields(None)
                | Piece::Enums(None) => f.write_str("None")?,
                Piece::Enums(Some(enums)) => write!(f, "Some({enums:?})")?,
                Piece::Maybe(Some(ty)) => push_reversed(&mut pending, [Piece::Text("Some("), Piece::Type(ty), Piece::Text(")")]),
                Piece::Types(Some(types)) => {
                    pending.push(Piece::Text(")"));
                    push_sequence(&mut pending, types);
                    pending.push(Piece::Text("Some("));
                }
                Piece::Names(Some(names)) => write!(f, "Some({names:?})")?,
                Piece::Indices(Some(indices)) => write!(f, "Some({indices:?})")?,
                Piece::Fields(Some(fields)) => {
                    pending.push(Piece::Text("}"));
                    let entries: Vec<(&str, &CelType)> = fields.iter().collect();
                    for (at, (name, ty)) in entries.into_iter().enumerate().rev() {
                        push_reversed(&mut pending, [Piece::Quoted(name), Piece::Text(": "), Piece::Type(ty)]);
                        if at > 0 {
                            pending.push(Piece::Text(", "));
                        }
                    }
                    pending.push(Piece::Text("{"));
                }
                Piece::Type(ty) => match ty {
                    CelType::Dyn => f.write_str("Dyn")?,
                    CelType::Primitive(name) => write!(f, "Primitive({name:?})")?,
                    CelType::List(list) => push_reversed(
                        &mut pending,
                        [
                            Piece::Text("List(ListType { element: "),
                            Piece::Type(&list.element),
                            Piece::Text(", prefix_elements: "),
                            Piece::Types(list.prefix_elements.as_deref()),
                            Piece::Text(", additional_elements: "),
                            Piece::Maybe(list.additional_elements.as_deref()),
                            Piece::Text(" })"),
                        ],
                    ),
                    CelType::Map(map) => push_reversed(
                        &mut pending,
                        [
                            Piece::Text("Map(MapType { key: "),
                            Piece::Type(&map.key),
                            Piece::Text(", value: "),
                            Piece::Type(&map.value),
                            Piece::Text(" })"),
                        ],
                    ),
                    CelType::Optional(optional) => push_reversed(
                        &mut pending,
                        [Piece::Text("Optional(OptionalType { value: "), Piece::Type(&optional.value), Piece::Text(" })")],
                    ),
                    CelType::Record(record) => {
                        pending.push(Piece::Text(" })"));
                        pending.push(Piece::Enums(record.field_enums.as_deref()));
                        pending.push(Piece::Text(", field_enums: "));
                        pending.push(Piece::Indices(record.pattern_fields.as_ref().map(|entries| &*entries.starts)));
                        pending.push(Piece::Text(", pattern_starts: "));
                        pending.push(Piece::Types(record.pattern_fields.as_ref().map(|entries| &*entries.types)));
                        pending.push(Piece::Text(", pattern_types: "));
                        pending.push(Piece::Names(record.pattern_fields.as_ref().map(|entries| &*entries.patterns)));
                        pending.push(Piece::Text(", pattern_fields: "));
                        pending.push(Piece::Names(record.absent_fields.as_deref()));
                        pending.push(Piece::Text(", absent_fields: "));
                        pending.push(Piece::Maybe(record.additional_fields.as_deref()));
                        pending.push(Piece::Text(", additional_fields: "));
                        pending.push(Piece::Fields(Some(&record.fields)));
                        pending.push(Piece::Text(", fields: "));
                        match &record.name {
                            Some(name) => push_reversed(&mut pending, [Piece::Text("Some("), Piece::Quoted(name), Piece::Text(")")]),
                            None => pending.push(Piece::Text("None")),
                        }
                        pending.push(Piece::Text("Record(RecordType { name: "));
                    }
                    CelType::Union(union) => {
                        pending.push(Piece::Text(" })"));
                        push_sequence(&mut pending, &union.members);
                        pending.push(Piece::Text("Union(UnionType { members: "));
                    }
                    CelType::Nominal(nominal) => {
                        pending.push(Piece::Text(" })"));
                        pending.push(Piece::Fields(nominal.fields.as_ref()));
                        pending.push(Piece::Text(", fields: "));
                        push_sequence(&mut pending, &nominal.args);
                        push_reversed(
                            &mut pending,
                            [
                                Piece::Text("Nominal(NominalType { name: "),
                                Piece::Quoted(&nominal.name),
                                Piece::Text(", base: "),
                                Piece::Type(&nominal.base),
                                Piece::Text(", args: "),
                            ],
                        );
                    }
                    CelType::Parameter(parameter) => {
                        push_reversed(
                            &mut pending,
                            [Piece::Text("Parameter(ParameterType { name: "), Piece::Quoted(&parameter.name), Piece::Text(" })")],
                        );
                    }
                },
            }
        }
        Ok(())
    }
}

fn is_leaf(ty: &CelType) -> bool {
    matches!(ty, CelType::Dyn | CelType::Primitive(_) | CelType::Parameter(_))
}

/// A child taken out of its slot: moved out of an `Arc` this release alone held, or a
/// shared list of types still holding its count.
enum Unlinked {
    Owned(CelType),
    Types(Arc<[CelType]>),
}

/// One release: the children it has taken out, and whether it is the thread's active
/// release, which a shared list of types waits on the list for.
#[derive(Default)]
struct Release {
    pending: Vec<Unlinked>,
    active: bool,
}

/// What a release leaves where it takes out a shared `Arc`, made once per thread.
struct Placeholders {
    leaf: Arc<CelType>,
    no_types: Arc<[CelType]>,
    no_fields: Arc<FieldEntries>,
}

fn placeholder<T: ?Sized>(pick: fn(&Placeholders) -> &Arc<T>, make: fn() -> Arc<T>) -> Arc<T> {
    PLACEHOLDERS.try_with(|made| Arc::clone(pick(made))).unwrap_or_else(|_| make())
}

impl Release {
    /// Takes every child out of a type onto the list. A leaf or an empty slot stays
    /// where it is, so a type already unlinked unlinks nothing.
    fn unlink(&mut self, ty: &mut CelType) {
        match ty {
            CelType::Dyn | CelType::Primitive(_) | CelType::Parameter(_) => {}
            CelType::List(list) => {
                self.take(&mut list.element);
                if let Some(prefix) = &mut list.prefix_elements {
                    self.take_types(prefix);
                }
                if let Some(rest) = &mut list.additional_elements {
                    self.take(rest);
                }
            }
            CelType::Map(map) => {
                self.take(&mut map.key);
                self.take(&mut map.value);
            }
            CelType::Optional(optional) => self.take(&mut optional.value),
            CelType::Record(record) => {
                self.take_fields(&mut record.fields);
                if let Some(additional) = &mut record.additional_fields {
                    self.take(additional);
                }
                if let Some(entries) = &mut record.pattern_fields {
                    self.take_types(&mut entries.types);
                }
            }
            CelType::Union(union) => self.take_types(&mut union.members),
            CelType::Nominal(nominal) => {
                self.take(&mut nominal.base);
                self.take_types(&mut nominal.args);
                if let Some(fields) = &mut nominal.fields {
                    self.take_fields(fields);
                }
            }
        }
    }

    fn take_owned<'t>(&mut self, types: impl Iterator<Item = &'t mut CelType>) {
        self.pending.extend(types.filter(|ty| !is_leaf(ty)).map(|ty| Unlinked::Owned(std::mem::replace(ty, DYN))));
    }

    /// A shared child is let go of at once through `Arc::into_inner`, which hands its
    /// value to exactly one of the holders letting go at the same moment.
    fn take(&mut self, child: &mut Arc<CelType>) {
        if is_leaf(child) {
            return;
        }
        match Arc::get_mut(child) {
            Some(held) => self.take_owned(std::iter::once(held)),
            None => {
                let shared = std::mem::replace(child, placeholder(|made| &made.leaf, || Arc::new(DYN)));
                self.pending.extend(Arc::into_inner(shared).map(Unlinked::Owned));
            }
        }
    }

    fn take_types(&mut self, children: &mut Arc<[CelType]>) {
        if children.is_empty() {
            return;
        }
        if let Some(held) = Arc::get_mut(children) {
            self.take_owned(held.iter_mut());
            return;
        }
        let shared = std::mem::replace(children, placeholder(|made| &made.no_types, || Arc::from(Vec::new())));
        if self.active {
            self.pending.push(Unlinked::Types(shared));
        } else {
            self.release_types(shared);
        }
    }

    fn take_fields(&mut self, fields: &mut TypeFields) {
        if fields.entries.order.is_empty() {
            return;
        }
        match Arc::get_mut(&mut fields.entries) {
            Some(held) => self.take_owned(held.order.iter_mut().map(|(_, ty)| ty)),
            None => {
                let shared = std::mem::replace(&mut fields.entries, placeholder(|made| &made.no_fields, Default::default));
                if let Some(mut entries) = Arc::into_inner(shared) {
                    self.take_owned(entries.order.iter_mut().map(|(_, ty)| ty));
                }
            }
        }
    }

    /// A list of types has no `into_inner`: one held elsewhere is let go of with this
    /// release active on the thread, so a member it releases — the other holder having
    /// let go at the same moment — unlinks onto this list instead of nesting.
    fn release_types(&mut self, mut types: Arc<[CelType]>) {
        if let Some(held) = Arc::get_mut(&mut types) {
            self.take_owned(held.iter_mut());
            return;
        }
        let entered = ACTIVE_RELEASE.try_with(|active| {
            let mut release = std::mem::take(self);
            release.active = true;
            active.replace(Some(release));
        });
        drop(types);
        if entered.is_ok() {
            *self = ACTIVE_RELEASE.with(|active| active.take()).expect("the release stays active");
            self.active = false;
        }
    }

    fn run(mut self) {
        while let Some(child) = self.pending.pop() {
            match child {
                Unlinked::Owned(mut ty) => self.unlink(&mut ty),
                Unlinked::Types(types) => self.release_types(types),
            }
        }
    }
}

thread_local! {
    /// The release letting go of a shared list of types on this thread, while it does.
    static ACTIVE_RELEASE: RefCell<Option<Release>> = const { RefCell::new(None) };
    static PLACEHOLDERS: Placeholders = Placeholders {
        leaf: Arc::new(DYN),
        no_types: Arc::from(Vec::new()),
        no_fields: Default::default(),
    };
}

impl Drop for CelType {
    /// Unlinks every descendant onto a heap list, so releasing a deep type costs no
    /// stack. A type taken off the list holds only placeholders where its children
    /// were by the time it is released itself.
    fn drop(&mut self) {
        if is_leaf(self) {
            return;
        }
        let joined = ACTIVE_RELEASE.try_with(|active| match active.borrow_mut().as_mut() {
            Some(release) => {
                release.unlink(self);
                true
            }
            None => false,
        });
        if joined == Ok(true) {
            return;
        }
        let mut release = Release::default();
        release.unlink(self);
        release.run();
    }
}
