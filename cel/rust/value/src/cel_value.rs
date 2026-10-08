//! The CEL value domain, and how a value says what it is — `cel-value.ts`.
//!
//! A value's identity is its variant. The union is closed: a new kind of value is a
//! change here.
//!
//! Node exports with no twin in this file:
//! - `CEL_VALUE_TYPE` and the `isCel*` predicates — the variant is the identity, so
//!   there is no brand to read.
//! - `celUint` / `CelUint` — a uint is `CelValue::Uint`.
//! - `CelValueKey`, `CelMapValueEntry` — type aliases of a JavaScript representation; a key is a `&str` of `CEL_VALUE_KEYS` and an entry is a pair.
//! - `isThenable`, `asyncValueRefused` — no Rust value can be awaited. The code stays
//!   in `CelEvaluationCode`, which is one vocabulary across engines.
//! - `literalValue` — reads the syntax tree's literal; it lives in the engine crate's
//!   `cel_value.rs`.
//!
//! Declared here and not in the Node file:
//! - `SourceRange` — Node imports it from the syntax tree, which this crate sits
//!   beneath; the engine's tree re-exports this one.
//! - `CelRecord` and `CelHostValue` as types — Node holds a record as a plain object
//!   and a host value as any object carrying the host's own key.
//! - `ReservedTypeName` — on Node the refusal of a reserved type name is raised by
//!   the engine's type registration; here the host value's constructor makes it.

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;

use crate::cel_map_value::map_key_identity;
use crate::value_text::json_quote;

/// The type keys the domain's own values carry. A host's named type may not reuse one.
pub const CEL_VALUE_KEYS: [&str; 7] = [
    "uint",
    "google.protobuf.Timestamp",
    "google.protobuf.Duration",
    "type",
    "optional",
    "map",
    "error",
];

/// A `[start, end)` span of UTF-16 code units in an expression's source.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct SourceRange {
    pub start: u32,
    pub end: u32,
}

/// An instant between 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999999999Z, to the
/// nanosecond. Always inside that range, by construction.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct CelTimestamp {
    pub(crate) unix_nanos: i128,
}

/// A span, to the nanosecond: a total of nanoseconds whose whole seconds fit an `i64`,
/// so seconds and nanoseconds share a sign. CEL's own range is narrower and is not part
/// of the type — see `duration_value.rs`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct CelDuration {
    pub(crate) total_nanos: i128,
}

/// A type as a value — what `type(x)` answers and what `int` denotes.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct CelTypeValue {
    name: String,
}

impl CelTypeValue {
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// `optional.of(v)` and `optional.none()`.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct CelOptional {
    held: Option<Box<CelValue>>,
}

impl CelOptional {
    pub fn is_present(&self) -> bool {
        self.held.is_some()
    }

    pub fn held(&self) -> Option<&CelValue> {
        self.held.as_deref()
    }

    pub fn into_held(self) -> Option<CelValue> {
        self.held.map(|held| *held)
    }
}

/// What identifies a key inside a map. A string and a bool are themselves; an int, a
/// uint and a whole double are the one integer CEL equality makes them.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum CelMapKey {
    String(String),
    Bool(bool),
    Integer(i128),
}

/// A map with typed keys: int, uint, bool and string keys in one container, in
/// insertion order, with no two keys CEL equality makes one. Built only by
/// `cel_map_from_entries`.
#[derive(Clone, Default)]
pub struct CelMap {
    entries: Vec<(CelValue, CelValue)>,
    index: HashMap<CelMapKey, usize>,
}

impl CelMap {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The value held under a key identity.
    pub fn get(&self, identity: &CelMapKey) -> Option<&CelValue> {
        self.entry(identity).map(|(_, value)| value)
    }

    /// The key as it was written and its value, under a key identity.
    pub fn entry(&self, identity: &CelMapKey) -> Option<(&CelValue, &CelValue)> {
        self.index.get(identity).map(|at| {
            let (key, value) = &self.entries[*at];
            (key, value)
        })
    }

    pub fn contains_key(&self, identity: &CelMapKey) -> bool {
        self.index.contains_key(identity)
    }

    /// Every entry, in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&CelValue, &CelValue)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// Adds an entry, answering `false` and adding nothing when the identity is held.
    pub(crate) fn insert_new(&mut self, identity: CelMapKey, key: CelValue, value: CelValue) -> bool {
        if self.index.contains_key(&identity) {
            return false;
        }
        self.index.insert(identity, self.entries.len());
        self.entries.push((key, value));
        true
    }
}

impl IntoIterator for CelMap {
    type Item = (CelValue, CelValue);
    type IntoIter = std::vec::IntoIter<(CelValue, CelValue)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl fmt::Debug for CelMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl PartialEq for CelMap {
    /// The same key/value pairs, in any order. A key is compared as the value it is,
    /// so an int key is not the uint key of the same number.
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len()
            && self.iter().all(|(key, value)| {
                map_key_identity(key)
                    .and_then(|identity| other.entry(&identity))
                    .is_some_and(|(held_key, held)| held_key == key && held == value)
            })
    }
}

/// A map whose keys are all strings, as a host hands one over. It ranges in
/// ECMAScript's own-property order: keys that are array indices (`0` … `4294967294`,
/// written canonically) ascending, then every other key in insertion order.
#[derive(Clone, Default)]
pub struct CelRecord {
    indexed: BTreeMap<u32, (String, CelValue)>,
    named: Vec<(String, CelValue)>,
    positions: HashMap<String, usize>,
}

fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

impl CelRecord {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a key, answering the value it held. A key already held keeps its position.
    pub fn insert(&mut self, key: impl Into<String>, value: CelValue) -> Option<CelValue> {
        let key = key.into();
        if let Some(index) = array_index(&key) {
            return self.indexed.insert(index, (key, value)).map(|(_, held)| held);
        }
        if let Some(at) = self.positions.get(&key) {
            return Some(std::mem::replace(&mut self.named[*at].1, value));
        }
        self.positions.insert(key.clone(), self.named.len());
        self.named.push((key, value));
        None
    }

    pub fn get(&self, key: &str) -> Option<&CelValue> {
        match array_index(key) {
            Some(index) => self.indexed.get(&index).map(|(_, value)| value),
            None => self.positions.get(key).map(|at| &self.named[*at].1),
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every entry, in the order a comprehension ranges over them.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &CelValue)> {
        self.indexed
            .values()
            .chain(self.named.iter())
            .map(|(key, value)| (key.as_str(), value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.iter().map(|(key, _)| key)
    }
}

impl<K: Into<String>> FromIterator<(K, CelValue)> for CelRecord {
    fn from_iter<I: IntoIterator<Item = (K, CelValue)>>(entries: I) -> Self {
        let mut record = Self::new();
        for (key, value) in entries {
            record.insert(key, value);
        }
        record
    }
}

impl IntoIterator for CelRecord {
    type Item = (String, CelValue);
    type IntoIter = std::vec::IntoIter<(String, CelValue)>;

    fn into_iter(self) -> Self::IntoIter {
        self.indexed.into_values().chain(self.named).collect::<Vec<_>>().into_iter()
    }
}

impl fmt::Debug for CelRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl PartialEq for CelRecord {
    /// The same key/value pairs, in any order.
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().all(|(key, value)| other.get(key) == Some(value))
    }
}

/// Every evaluation failure the domain names. A code is never derived from a message.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelEvaluationCode {
    /// A map or a record does not hold the key read.
    NoSuchKey,
    /// A name nothing in the activation holds, at any prefix.
    NoSuchVariable,
    /// A list index below zero or past the last element.
    IndexOutOfRange,
    /// No registered overload takes the values a call was handed.
    NoMatchingOverload,
    /// A select, an index or an iteration over a value that holds no members.
    UnsupportedContainer,
    /// A map key, or an index, of a type no map is keyed by.
    UnsupportedKeyType,
    /// A map literal or a comprehension building two entries with one key.
    DuplicateMapKey,
    /// An int or uint result outside its own range.
    NumericOverflow,
    DivisionByZero,
    ModuloByZero,
    /// A conversion the value cannot make.
    InvalidConversion,
    /// An argument a function refuses.
    InvalidArgument,
    /// A pattern RE2 cannot parse.
    InvalidRegularExpression,
    /// `value()` on an optional that holds nothing.
    OptionalValueMissing,
    /// A namespaced call nothing bound an implementation for.
    UnboundFunction,
    /// A value that must be awaited reached evaluation. No Rust value raises it.
    AsyncValueUnsupported,
}

/// Every code, in the order every engine lists them.
pub const CEL_EVALUATION_CODES: [CelEvaluationCode; 16] = [
    CelEvaluationCode::NoSuchKey,
    CelEvaluationCode::NoSuchVariable,
    CelEvaluationCode::IndexOutOfRange,
    CelEvaluationCode::NoMatchingOverload,
    CelEvaluationCode::UnsupportedContainer,
    CelEvaluationCode::UnsupportedKeyType,
    CelEvaluationCode::DuplicateMapKey,
    CelEvaluationCode::NumericOverflow,
    CelEvaluationCode::DivisionByZero,
    CelEvaluationCode::ModuloByZero,
    CelEvaluationCode::InvalidConversion,
    CelEvaluationCode::InvalidArgument,
    CelEvaluationCode::InvalidRegularExpression,
    CelEvaluationCode::OptionalValueMissing,
    CelEvaluationCode::UnboundFunction,
    CelEvaluationCode::AsyncValueUnsupported,
];

impl CelEvaluationCode {
    /// The code as every engine writes it.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NoSuchKey => "no_such_key",
            Self::NoSuchVariable => "no_such_variable",
            Self::IndexOutOfRange => "index_out_of_range",
            Self::NoMatchingOverload => "no_matching_overload",
            Self::UnsupportedContainer => "unsupported_container",
            Self::UnsupportedKeyType => "unsupported_key_type",
            Self::DuplicateMapKey => "duplicate_map_key",
            Self::NumericOverflow => "numeric_overflow",
            Self::DivisionByZero => "division_by_zero",
            Self::ModuloByZero => "modulo_by_zero",
            Self::InvalidConversion => "invalid_conversion",
            Self::InvalidArgument => "invalid_argument",
            Self::InvalidRegularExpression => "invalid_regular_expression",
            Self::OptionalValueMissing => "optional_value_missing",
            Self::UnboundFunction => "unbound_function",
            Self::AsyncValueUnsupported => "async_value_unsupported",
        }
    }
}

impl fmt::Display for CelEvaluationCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A failure as a value: `false && <error>` is `false`, so an error flows through
/// evaluation as an operand and only the top of an evaluation raises a surviving one.
/// Outside evaluation it is the `Err` of every constructor and parser here.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelError {
    pub code: CelEvaluationCode,
    pub message: String,
    pub range: Option<SourceRange>,
}

impl CelError {
    /// The same error, about `range`.
    pub fn with_range(self, range: SourceRange) -> Self {
        Self { range: Some(range), ..self }
    }
}

impl fmt::Display for CelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelError {}

/// The refusal of a host type named as one of `CEL_VALUE_KEYS`. It is raised where a
/// host declares a type, never during evaluation, so it is not a `CelError`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReservedTypeName {
    name: String,
}

impl ReservedTypeName {
    /// The name that was refused.
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl fmt::Display for ReservedTypeName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is a type key the CEL value domain's own values carry, so no host type may be named it", json_quote(&self.name))
    }
}

impl std::error::Error for ReservedTypeName {}

/// A value of no CEL type of the domain's own: a host's named type, or — with no name
/// — a host object of no CEL type at all, such as a live handle. Two host values are
/// one value only when they are the same object.
#[derive(Clone)]
pub struct CelHostValue {
    type_name: Option<String>,
    payload: Arc<dyn Any + Send + Sync>,
}

impl CelHostValue {
    /// A value of the host's type `type_name`, refused when the name is one of
    /// `CEL_VALUE_KEYS`.
    pub fn named(
        type_name: impl Into<String>,
        payload: Arc<dyn Any + Send + Sync>,
    ) -> Result<Self, ReservedTypeName> {
        let type_name = type_name.into();
        if CEL_VALUE_KEYS.contains(&type_name.as_str()) {
            return Err(ReservedTypeName { name: type_name });
        }
        Ok(Self { type_name: Some(type_name), payload })
    }

    /// A host object of no CEL type.
    pub fn unnamed(payload: Arc<dyn Any + Send + Sync>) -> Self {
        Self { type_name: None, payload }
    }

    pub fn type_name(&self) -> Option<&str> {
        self.type_name.as_deref()
    }

    pub fn payload(&self) -> &Arc<dyn Any + Send + Sync> {
        &self.payload
    }
}

impl PartialEq for CelHostValue {
    fn eq(&self, other: &Self) -> bool {
        self.type_name == other.type_name
            && std::ptr::eq(Arc::as_ptr(&self.payload) as *const (), Arc::as_ptr(&other.payload) as *const ())
    }
}

impl fmt::Debug for CelHostValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CelHostValue").field("type_name", &self.type_name).finish_non_exhaustive()
    }
}

/// A value in the CEL value domain.
#[derive(Clone, Debug)]
pub enum CelValue {
    Null,
    Bool(bool),
    Int(i64),
    Uint(u64),
    Double(f64),
    String(String),
    Bytes(Vec<u8>),
    List(Vec<CelValue>),
    /// A map with typed keys.
    Map(CelMap),
    /// A map whose keys are all strings, as a host hands one over.
    Record(CelRecord),
    Timestamp(CelTimestamp),
    Duration(CelDuration),
    Type(CelTypeValue),
    Optional(CelOptional),
    Error(CelError),
    Host(CelHostValue),
}

impl PartialEq for CelValue {
    /// Identity in the domain, never CEL's `==`: the same variant holding the same
    /// thing. A double compares by its bits, so a negative zero is not a zero and NaN
    /// is itself; `Int(1)` is not `Uint(1)`. The one crossing is a map whose keys are
    /// all strings and a record holding the same pairs, which are one value written
    /// two ways.
    fn eq(&self, other: &Self) -> bool {
        use CelValue::*;
        match (self, other) {
            (Null, Null) => true,
            (Bool(a), Bool(b)) => a == b,
            (Int(a), Int(b)) => a == b,
            (Uint(a), Uint(b)) => a == b,
            (Double(a), Double(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            (String(a), String(b)) => a == b,
            (Bytes(a), Bytes(b)) => a == b,
            (List(a), List(b)) => a == b,
            (Map(a), Map(b)) => a == b,
            (Record(a), Record(b)) => a == b,
            (Map(map), Record(record)) | (Record(record), Map(map)) => {
                map.len() == record.len()
                    && map.iter().all(|(key, value)| matches!(key, String(key) if record.get(key) == Some(value)))
            }
            (Timestamp(a), Timestamp(b)) => a == b,
            (Duration(a), Duration(b)) => a == b,
            (Type(a), Type(b)) => a == b,
            (Optional(a), Optional(b)) => a == b,
            (Error(a), Error(b)) => a == b,
            (Host(a), Host(b)) => a == b,
            _ => false,
        }
    }
}

impl From<CelError> for CelValue {
    fn from(error: CelError) -> Self {
        CelValue::Error(error)
    }
}

// --- constructors ----------------------------------------------------------

pub fn cel_type_value(name: impl Into<String>) -> CelTypeValue {
    CelTypeValue { name: name.into() }
}

pub fn cel_none() -> CelOptional {
    CelOptional { held: None }
}

pub fn cel_some(held: CelValue) -> CelOptional {
    CelOptional { held: Some(Box::new(held)) }
}

pub fn cel_error(code: CelEvaluationCode, message: impl Into<String>, range: Option<SourceRange>) -> CelError {
    CelError { code, message: message.into(), range }
}

// --- reading what a value is ----------------------------------------------

/// The name of a value's CEL type — what `type()` answers and what an overload is
/// dispatched on — or nothing for an error and for a host object of no CEL type.
pub fn cel_type_name_of(value: &CelValue) -> Option<&str> {
    Some(match value {
        CelValue::Null => "null_type",
        CelValue::Bool(_) => "bool",
        CelValue::Int(_) => "int",
        CelValue::Uint(_) => "uint",
        CelValue::Double(_) => "double",
        CelValue::String(_) => "string",
        CelValue::Bytes(_) => "bytes",
        CelValue::List(_) => "list",
        CelValue::Map(_) | CelValue::Record(_) => "map",
        CelValue::Timestamp(_) => "google.protobuf.Timestamp",
        CelValue::Duration(_) => "google.protobuf.Duration",
        CelValue::Type(_) => "type",
        CelValue::Optional(_) => "optional",
        CelValue::Error(_) => return None,
        CelValue::Host(host) => return host.type_name(),
    })
}
