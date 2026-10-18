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
use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

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

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ListType {
    pub element: Arc<CelType>,
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

/// An object with named fields. A field it does not declare is unjudged when `open`,
/// undeclared when closed. An unnamed record prints as `map`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RecordType {
    pub name: Option<Arc<str>>,
    pub fields: TypeFields,
    pub open: bool,
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
    CelType::List(ListType { element: Arc::new(element) })
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
    let mut pending = vec![(left, right)];
    while let Some((left, right)) = pending.pop() {
        if !equal_at_own_level(left, right, |a, b| pending.push((a, b))) {
            return false;
        }
    }
    true
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
            beneath(&a.element, &b.element);
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
            if a.name != b.name || a.open != b.open || a.fields.len() != b.fields.len() {
                return false;
            }
            for (name, ty) in a.fields.iter() {
                match b.fields.get(name) {
                    Some(held) => beneath(ty, held),
                    None => return false,
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
            CelType::Record(record) => {
                record.name.hash(hasher);
                record.open.hash(hasher);
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

/// How a type is written. `top` collapses a list or map of `dyn` to its bare name, which
/// is how the whole type of an expression is reported.
pub fn format_type(ty: &CelType, top: bool) -> String {
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
    while let Some(piece) = pending.pop() {
        let ty = match piece {
            Piece::Text(text) => {
                out.push_str(text);
                continue;
            }
            Piece::Type(ty) => ty,
        };
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
/// before a type is reported. A part nothing replaced in is shared, not copied.
pub fn without_parameters(ty: &CelType) -> CelType {
    enum Task<'a> {
        Visit(&'a CelType),
        Rebuild(&'a CelType),
    }
    // Each result is the rebuilt type and whether anything in it was replaced.
    let mut results: Vec<(CelType, bool)> = Vec::new();
    let mut tasks = vec![Task::Visit(ty)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(ty) => {
                let children: Vec<&CelType> = match ty {
                    CelType::Parameter(_) => {
                        results.push((DYN, true));
                        continue;
                    }
                    CelType::List(list) => vec![&list.element],
                    CelType::Map(map) => vec![&map.key, &map.value],
                    CelType::Optional(optional) => vec![&optional.value],
                    CelType::Union(union) => union.members.iter().collect(),
                    CelType::Nominal(nominal) => nominal.args.iter().collect(),
                    CelType::Record(record) => record.fields.values().collect(),
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
                    CelType::List(_) | CelType::Optional(_) => 1,
                    CelType::Map(_) => 2,
                    CelType::Union(union) => union.members.len(),
                    CelType::Nominal(nominal) => nominal.args.len(),
                    CelType::Record(record) => record.fields.len(),
                    _ => unreachable!("only a type with children is rebuilt"),
                };
                let children = results.split_off(results.len() - count);
                if !children.iter().any(|(_, moved)| *moved) {
                    results.push((ty.clone(), false));
                    continue;
                }
                let mut children = children.into_iter().map(|(child, _)| child);
                let mut next = || children.next().expect("each child was rebuilt");
                let rebuilt = match ty {
                    CelType::List(_) => list_of(next()),
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
                    CelType::Record(record) => CelType::Record(RecordType {
                        fields: record.fields.keys().map(|name| (name, next())).collect(),
                        ..record.clone()
                    }),
                    _ => unreachable!("only a type with children is rebuilt"),
                };
                results.push((rebuilt, true));
            }
        }
    }
    results.pop().expect("the root is rebuilt last").0
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
            CelType::List(from) => Assignable(&from.element, &to.element),
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
                    let values = if is_dyn(&to.value) {
                        Answer(true)
                    } else if record.open {
                        Answer(false)
                    } else {
                        All(record.fields.values().map(|ty| Assignable(ty, &to.value)).collect())
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
    // Each open frame: whether it is an `Any`, and the parts it has not asked yet.
    let mut frames: Vec<(bool, std::vec::IntoIter<Question<'_>>)> = Vec::new();
    let mut next = Question::Assignable(from, to);
    loop {
        // Descend to the next leaf's answer.
        let value = loop {
            match next {
                Question::Assignable(from, to) => next = assignable_parts(from, to),
                Question::Equal(left, right) => break types_equal(left, right),
                Question::Answer(value) => break value,
                Question::All(parts) => match open(&mut frames, false, parts) {
                    Some(part) => next = part,
                    None => break true,
                },
                Question::Any(parts) => match open(&mut frames, true, parts) {
                    Some(part) => next = part,
                    None => break false,
                },
            }
        };
        // Carry the answer up until a frame has a part left to ask. A frame whose
        // parts are all asked answers what its last part did.
        loop {
            let Some((any, parts)) = frames.last_mut() else { return value };
            if *any == value {
                frames.pop();
                continue;
            }
            match parts.next() {
                Some(part) => {
                    next = part;
                    break;
                }
                None => {
                    frames.pop();
                }
            }
        }
    }
}

/// Opens a frame over its parts and answers the first, or nothing for none.
fn open<'a>(
    frames: &mut Vec<(bool, std::vec::IntoIter<Question<'a>>)>,
    any: bool,
    parts: Vec<Question<'a>>,
) -> Option<Question<'a>> {
    let mut parts = parts.into_iter();
    let first = parts.next()?;
    frames.push((any, parts));
    Some(first)
}

/// The one type both sides can be: symmetric, `dyn` where they have nothing in common.
/// An unresolved parameter yields to the other side.
pub fn unify(left: &CelType, right: &CelType) -> CelType {
    enum Task<'a> {
        Unify(&'a CelType, &'a CelType),
        List,
        Map,
        Optional,
    }
    let mut tasks = vec![Task::Unify(left, right)];
    let mut results: Vec<CelType> = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            Task::Unify(left, right) => {
                if types_equal(left, right) {
                    results.push(left.clone());
                } else if matches!(left, CelType::Parameter(_)) {
                    results.push(right.clone());
                } else if matches!(right, CelType::Parameter(_)) {
                    results.push(left.clone());
                } else if is_dyn(left) || is_dyn(right) {
                    results.push(DYN);
                } else {
                    match (left, right) {
                        (CelType::List(left), CelType::List(right)) => {
                            tasks.push(Task::List);
                            tasks.push(Task::Unify(&left.element, &right.element));
                        }
                        (CelType::Map(left), CelType::Map(right)) => {
                            tasks.push(Task::Map);
                            tasks.push(Task::Unify(&left.value, &right.value));
                            tasks.push(Task::Unify(&left.key, &right.key));
                        }
                        (CelType::Optional(left), CelType::Optional(right)) => {
                            tasks.push(Task::Optional);
                            tasks.push(Task::Unify(&left.value, &right.value));
                        }
                        _ => results.push(DYN),
                    }
                }
            }
            Task::List => {
                let element = results.pop().expect("the element was unified");
                results.push(list_of(element));
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
        }
    }
    results.pop().expect("the root is unified last")
}

// --- data equality, Debug and Drop ----------------------------------------------

impl PartialEq for CelType {
    /// The type as data: field order, a named type's base and fields included.
    fn eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other)];
        while let Some((left, right)) = pending.pop() {
            match (left, right) {
                (CelType::Dyn, CelType::Dyn) => {}
                (CelType::Primitive(a), CelType::Primitive(b)) if a == b => {}
                (CelType::List(a), CelType::List(b)) => pending.push((&a.element, &b.element)),
                (CelType::Map(a), CelType::Map(b)) => {
                    pending.push((&a.key, &b.key));
                    pending.push((&a.value, &b.value));
                }
                (CelType::Optional(a), CelType::Optional(b)) => pending.push((&a.value, &b.value)),
                (CelType::Record(a), CelType::Record(b))
                    if a.name == b.name && a.open == b.open && a.fields.len() == b.fields.len() =>
                {
                    for ((a_name, a_ty), (b_name, b_ty)) in a.fields.iter().zip(b.fields.iter()) {
                        if a_name != b_name {
                            return false;
                        }
                        pending.push((a_ty, b_ty));
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
    Flag(bool),
    Type(&'a CelType),
    Fields(Option<&'a TypeFields>),
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
                Piece::Flag(flag) => write!(f, "{flag}")?,
                Piece::Fields(None) => f.write_str("None")?,
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
                        [Piece::Text("List(ListType { element: "), Piece::Type(&list.element), Piece::Text(" })")],
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
                        pending.push(Piece::Flag(record.open));
                        pending.push(Piece::Text(", open: "));
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

/// A child taken out of its slot: moved out of an `Arc` this release alone held, or
/// the shared `Arc` itself, still holding its count.
enum Unlinked {
    Owned(CelType),
    Type(Arc<CelType>),
    Types(Arc<[CelType]>),
    Fields(Arc<FieldEntries>),
}

/// One release: the children it has taken out, and the placeholders it leaves where it
/// took a shared `Arc` — each made the first time this release needs it and cloned
/// after that.
#[derive(Default)]
struct Release {
    pending: Vec<Unlinked>,
    leaf: Option<Arc<CelType>>,
    no_types: Option<Arc<[CelType]>>,
    no_fields: Option<Arc<FieldEntries>>,
}

impl Release {
    /// Takes every child out of a type onto the list. A leaf or an empty slot stays
    /// where it is, so a type already unlinked unlinks nothing.
    fn unlink(&mut self, ty: &mut CelType) {
        match ty {
            CelType::Dyn | CelType::Primitive(_) | CelType::Parameter(_) => {}
            CelType::List(list) => self.take(&mut list.element),
            CelType::Map(map) => {
                self.take(&mut map.key);
                self.take(&mut map.value);
            }
            CelType::Optional(optional) => self.take(&mut optional.value),
            CelType::Record(record) => self.take_fields(&mut record.fields),
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

    fn take(&mut self, child: &mut Arc<CelType>) {
        if is_leaf(child) {
            return;
        }
        match Arc::get_mut(child) {
            Some(held) => self.take_owned(std::iter::once(held)),
            None => {
                let leaf = self.leaf.get_or_insert_with(|| Arc::new(DYN));
                self.pending.push(Unlinked::Type(std::mem::replace(child, Arc::clone(leaf))));
            }
        }
    }

    fn take_types(&mut self, children: &mut Arc<[CelType]>) {
        if children.is_empty() {
            return;
        }
        match Arc::get_mut(children) {
            Some(held) => self.take_owned(held.iter_mut()),
            None => {
                let none = self.no_types.get_or_insert_with(|| Arc::from(Vec::new()));
                self.pending.push(Unlinked::Types(std::mem::replace(children, Arc::clone(none))));
            }
        }
    }

    fn take_fields(&mut self, fields: &mut TypeFields) {
        if fields.entries.order.is_empty() {
            return;
        }
        match Arc::get_mut(&mut fields.entries) {
            Some(held) => self.take_owned(held.order.iter_mut().map(|(_, ty)| ty)),
            None => {
                let none = self.no_fields.get_or_insert_with(Default::default);
                self.pending.push(Unlinked::Fields(std::mem::replace(&mut fields.entries, Arc::clone(none))));
            }
        }
    }

    /// Releases what is on the list. A shared `Arc` is let go of through
    /// `Arc::into_inner`, which hands its value to exactly one of the holders letting go
    /// at once, so a child shared within a parent or across threads is unlinked here,
    /// never released inside another's `Drop`. A list of types has no `into_inner`: one
    /// held elsewhere is let go of with this release active on the thread, so a member
    /// it releases — the other holder having let go at the same moment — unlinks onto
    /// this list instead.
    fn run(mut self) {
        while let Some(child) = self.pending.pop() {
            match child {
                Unlinked::Owned(mut ty) => self.unlink(&mut ty),
                Unlinked::Type(child) => {
                    if let Some(mut ty) = Arc::into_inner(child) {
                        self.unlink(&mut ty);
                    }
                }
                Unlinked::Fields(entries) => {
                    if let Some(mut entries) = Arc::into_inner(entries) {
                        for (_, ty) in entries.order.iter_mut() {
                            self.unlink(ty);
                        }
                    }
                }
                Unlinked::Types(mut types) => match Arc::get_mut(&mut types) {
                    Some(held) => held.iter_mut().for_each(|ty| self.unlink(ty)),
                    None => match ACTIVE_RELEASE.try_with(|active| active.replace(Some(std::mem::take(&mut self)))) {
                        Ok(_) => {
                            drop(types);
                            self = ACTIVE_RELEASE.with(|active| active.take()).expect("the release stays active");
                        }
                        Err(_) => drop(types),
                    },
                },
            }
        }
    }
}

thread_local! {
    /// The release letting go of a shared list of types on this thread, while it does.
    static ACTIVE_RELEASE: RefCell<Option<Release>> = const { RefCell::new(None) };
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
