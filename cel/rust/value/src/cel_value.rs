//! The CEL value domain, and how a value says what it is — `cel-value.ts`.
//!
//! A value's identity is its variant. The union is closed: a new kind of value is a
//! change here.
//!
//! **Aggregates are shared.** A string, bytes, a list, a map, a record, an optional's
//! held value and a host value's entries are each held by an `Arc`, so a clone is O(1)
//! and a value is immutable once built — what every Node value is, a shared reference.
//! Releasing, comparing and printing a value run on heap work lists, so a value of any
//! depth costs no stack; a shared child is let go of through `Arc::into_inner`, which
//! hands it to exactly one of the holders letting go at the same moment.
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
//! - `CelList`, `CelRecord` and `CelHostValue` as types — Node holds a list as an
//!   array, a record as a plain object and a host value as any object carrying the
//!   host's own key.
//! - `PropertyMap` — the order of a JavaScript object's own keys, which Node gets from
//!   its host; a record is built on it, and so is every engine input Node takes as a
//!   plain object.
//! - `ReservedTypeName` — on Node the refusal of a reserved type name is raised by
//!   the engine's type registration; here the host value's constructor makes it.

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::ops::Deref;
use std::sync::{Arc, OnceLock};

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
    name: Arc<str>,
}

impl CelTypeValue {
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// Moves a shared payload out of its slot, answering it when this holder was the last.
fn take_shared<T>(slot: &mut Option<Arc<T>>) -> Option<T> {
    slot.take().and_then(Arc::into_inner)
}

/// `optional.of(v)` and `optional.none()`.
#[derive(Clone, Default)]
pub struct CelOptional {
    held: Option<Arc<CelValue>>,
}

impl CelOptional {
    pub fn is_present(&self) -> bool {
        self.held.is_some()
    }

    pub fn held(&self) -> Option<&CelValue> {
        self.held.as_deref()
    }

    pub fn into_held(mut self) -> Option<CelValue> {
        self.held.take().map(Arc::unwrap_or_clone)
    }

    fn unlink(&mut self, pending: &mut Vec<CelValue>) {
        pending.extend(take_shared(&mut self.held).filter(holds_values));
    }
}

impl Drop for CelOptional {
    fn drop(&mut self) {
        if self.held.is_some() {
            release(|pending| self.unlink(pending));
        }
    }
}

impl PartialEq for CelOptional {
    fn eq(&self, other: &Self) -> bool {
        let mut pending = Vec::new();
        optional_pairs(self, other, &mut pending) && equal_pairs(pending)
    }
}

impl fmt::Debug for CelOptional {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print(f, Piece::Optional(self))
    }
}

/// What identifies a key inside a map. A string and a bool are themselves; an int, a
/// uint and a whole double are the one integer CEL equality makes them.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum CelMapKey {
    String(Arc<str>),
    Bool(bool),
    Integer(i128),
}

/// A map's entries in insertion order, and where each key identity stands.
#[derive(Clone, Default)]
pub(crate) struct MapEntries {
    entries: Vec<(CelValue, CelValue)>,
    index: HashMap<CelMapKey, usize>,
}

impl MapEntries {
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

/// A map with typed keys: int, uint, bool and string keys in one container, in
/// insertion order, with no two keys CEL equality makes one. Built only by
/// `cel_map_from_entries`.
#[derive(Clone, Default)]
pub struct CelMap {
    inner: Option<Arc<MapEntries>>,
}

impl CelMap {
    pub(crate) fn from_entries(entries: MapEntries) -> Self {
        Self { inner: (!entries.entries.is_empty()).then(|| Arc::new(entries)) }
    }

    fn entries(&self) -> &[(CelValue, CelValue)] {
        self.inner.as_deref().map_or(&[], |inner| &inner.entries)
    }

    pub fn len(&self) -> usize {
        self.entries().len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries().is_empty()
    }

    /// The value held under a key identity.
    pub fn get(&self, identity: &CelMapKey) -> Option<&CelValue> {
        self.entry(identity).map(|(_, value)| value)
    }

    /// The key as it was written and its value, under a key identity.
    pub fn entry(&self, identity: &CelMapKey) -> Option<(&CelValue, &CelValue)> {
        let inner = self.inner.as_deref()?;
        inner.index.get(identity).map(|at| {
            let (key, value) = &inner.entries[*at];
            (key, value)
        })
    }

    pub fn contains_key(&self, identity: &CelMapKey) -> bool {
        self.inner.as_deref().is_some_and(|inner| inner.index.contains_key(identity))
    }

    /// Every entry, in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&CelValue, &CelValue)> {
        self.entries().iter().map(|(key, value)| (key, value))
    }

    fn unlink(&mut self, pending: &mut Vec<CelValue>) {
        if let Some(inner) = take_shared(&mut self.inner) {
            pending.extend(inner.entries.into_iter().map(|(_, value)| value).filter(holds_values));
        }
    }
}

impl Drop for CelMap {
    fn drop(&mut self) {
        if self.inner.is_some() {
            release(|pending| self.unlink(pending));
        }
    }
}

impl IntoIterator for CelMap {
    type Item = (CelValue, CelValue);
    type IntoIter = std::vec::IntoIter<(CelValue, CelValue)>;

    fn into_iter(mut self) -> Self::IntoIter {
        self.inner.take().map(Arc::unwrap_or_clone).map(|inner| inner.entries).unwrap_or_default().into_iter()
    }
}

impl fmt::Debug for CelMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print(f, Piece::Map(self))
    }
}

impl PartialEq for CelMap {
    /// The same key/value pairs, in any order. A key is compared as the value it is,
    /// so an int key is not the uint key of the same number.
    fn eq(&self, other: &Self) -> bool {
        let mut pending = Vec::new();
        map_pairs(self, other, &mut pending) && equal_pairs(pending)
    }
}

/// A string-keyed map in ECMAScript's own-property order: keys that are array indices
/// (`0` … `4294967294`, written canonically) ascending, then every other key in
/// insertion order. Setting a key that is already held replaces its value and keeps its
/// position. It is the one home of that order: a record, a JSON object and every input
/// a JavaScript host would hand over as a plain object range in it.
#[derive(Clone)]
pub struct PropertyMap<V> {
    indexed: BTreeMap<u32, (String, V)>,
    named: Vec<(String, V)>,
    positions: HashMap<String, usize>,
}

impl<V> Default for PropertyMap<V> {
    fn default() -> Self {
        Self { indexed: BTreeMap::new(), named: Vec::new(), positions: HashMap::new() }
    }
}

fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

impl<V> PropertyMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a key, answering the value it held. A key already held keeps its position.
    pub fn insert(&mut self, key: impl Into<String>, value: V) -> Option<V> {
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

    pub fn get(&self, key: &str) -> Option<&V> {
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

    /// Every entry, in ECMAScript's own-property order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.indexed
            .values()
            .chain(self.named.iter())
            .map(|(key, value)| (key.as_str(), value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.iter().map(|(key, _)| key)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.iter().map(|(_, value)| value)
    }
}

impl<K: Into<String>, V> FromIterator<(K, V)> for PropertyMap<V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(entries: I) -> Self {
        let mut map = Self::new();
        for (key, value) in entries {
            map.insert(key, value);
        }
        map
    }
}

impl<V> IntoIterator for PropertyMap<V> {
    type Item = (String, V);
    type IntoIter = std::vec::IntoIter<(String, V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.indexed.into_values().chain(self.named).collect::<Vec<_>>().into_iter()
    }
}

impl<V: fmt::Debug> fmt::Debug for PropertyMap<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl<V: PartialEq> PartialEq for PropertyMap<V> {
    /// The same key/value pairs, in any order.
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().all(|(key, value)| other.get(key) == Some(value))
    }
}

/// A list of values, in order.
#[derive(Clone, Default)]
pub struct CelList {
    items: Option<Arc<Vec<CelValue>>>,
}

impl CelList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn as_slice(&self) -> &[CelValue] {
        self.items.as_deref().map_or(&[], Vec::as_slice)
    }

    fn unlink(&mut self, pending: &mut Vec<CelValue>) {
        if let Some(items) = take_shared(&mut self.items) {
            pending.extend(items.into_iter().filter(holds_values));
        }
    }
}

impl Deref for CelList {
    type Target = [CelValue];

    fn deref(&self) -> &[CelValue] {
        self.as_slice()
    }
}

impl From<Vec<CelValue>> for CelList {
    fn from(items: Vec<CelValue>) -> Self {
        Self { items: (!items.is_empty()).then(|| Arc::new(items)) }
    }
}

impl FromIterator<CelValue> for CelList {
    fn from_iter<I: IntoIterator<Item = CelValue>>(items: I) -> Self {
        items.into_iter().collect::<Vec<_>>().into()
    }
}

impl<'a> IntoIterator for &'a CelList {
    type Item = &'a CelValue;
    type IntoIter = std::slice::Iter<'a, CelValue>;

    fn into_iter(self) -> Self::IntoIter {
        self.as_slice().iter()
    }
}

impl IntoIterator for CelList {
    type Item = CelValue;
    type IntoIter = std::vec::IntoIter<CelValue>;

    fn into_iter(mut self) -> Self::IntoIter {
        self.items.take().map(Arc::unwrap_or_clone).unwrap_or_default().into_iter()
    }
}

impl Drop for CelList {
    fn drop(&mut self) {
        if self.items.is_some() {
            release(|pending| self.unlink(pending));
        }
    }
}

impl PartialEq for CelList {
    fn eq(&self, other: &Self) -> bool {
        let mut pending = Vec::new();
        list_pairs(self, other, &mut pending) && equal_pairs(pending)
    }
}

impl fmt::Debug for CelList {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print(f, Piece::List(self))
    }
}

/// A map whose keys are all strings, as a host hands one over. It ranges in
/// ECMAScript's own-property order — it is a [`PropertyMap`] of values. Setting a key
/// on a record whose entries another value shares copies them first, so no value ever
/// sees another change.
#[derive(Clone, Default)]
pub struct CelRecord {
    entries: Option<Arc<PropertyMap<CelValue>>>,
}

fn no_entries() -> &'static PropertyMap<CelValue> {
    static EMPTY: OnceLock<PropertyMap<CelValue>> = OnceLock::new();
    EMPTY.get_or_init(PropertyMap::new)
}

impl CelRecord {
    pub fn new() -> Self {
        Self::default()
    }

    fn properties(&self) -> &PropertyMap<CelValue> {
        match self.entries.as_deref() {
            Some(entries) => entries,
            None => no_entries(),
        }
    }

    /// Sets a key, answering the value it held. A key already held keeps its position.
    pub fn insert(&mut self, key: impl Into<String>, value: CelValue) -> Option<CelValue> {
        Arc::make_mut(self.entries.get_or_insert_with(Default::default)).insert(key, value)
    }

    pub fn get(&self, key: &str) -> Option<&CelValue> {
        self.properties().get(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.properties().contains_key(key)
    }

    pub fn len(&self) -> usize {
        self.properties().len()
    }

    pub fn is_empty(&self) -> bool {
        self.properties().is_empty()
    }

    /// Every entry, in the order a comprehension ranges over them.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &CelValue)> {
        self.properties().iter()
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.properties().keys()
    }

    fn unlink(&mut self, pending: &mut Vec<CelValue>) {
        if let Some(entries) = take_shared(&mut self.entries) {
            pending.extend(entries.into_iter().map(|(_, value)| value).filter(holds_values));
        }
    }
}

impl<K: Into<String>> FromIterator<(K, CelValue)> for CelRecord {
    fn from_iter<I: IntoIterator<Item = (K, CelValue)>>(entries: I) -> Self {
        let entries: PropertyMap<CelValue> = entries.into_iter().collect();
        Self { entries: (!entries.is_empty()).then(|| Arc::new(entries)) }
    }
}

impl IntoIterator for CelRecord {
    type Item = (String, CelValue);
    type IntoIter = std::vec::IntoIter<(String, CelValue)>;

    fn into_iter(mut self) -> Self::IntoIter {
        match self.entries.take() {
            Some(entries) => Arc::unwrap_or_clone(entries).into_iter(),
            None => Vec::new().into_iter(),
        }
    }
}

impl Drop for CelRecord {
    fn drop(&mut self) {
        if self.entries.is_some() {
            release(|pending| self.unlink(pending));
        }
    }
}

impl PartialEq for CelRecord {
    fn eq(&self, other: &Self) -> bool {
        let mut pending = Vec::new();
        record_pairs(self, other, &mut pending) && equal_pairs(pending)
    }
}

impl fmt::Debug for CelRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print(f, Piece::Record(self))
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
/// one value only when they are the same object: the same name, payload and entries.
///
/// A named value may carry its own **entries**, a [`PropertyMap`] of values. They are
/// what a member read answers of it, and only for a field the type the host registered
/// declares: anything else the value holds, its payload included, is unreachable
/// through CEL.
#[derive(Clone)]
pub struct CelHostValue {
    type_name: Option<Arc<str>>,
    payload: Arc<dyn Any + Send + Sync>,
    entries: Option<Arc<PropertyMap<CelValue>>>,
}

fn reserved(type_name: &str) -> Result<(), ReservedTypeName> {
    match CEL_VALUE_KEYS.contains(&type_name) {
        true => Err(ReservedTypeName { name: type_name.to_string() }),
        false => Ok(()),
    }
}

impl CelHostValue {
    /// A value of the host's type `type_name`, refused when the name is one of
    /// `CEL_VALUE_KEYS`.
    pub fn named(
        type_name: impl Into<String>,
        payload: Arc<dyn Any + Send + Sync>,
    ) -> Result<Self, ReservedTypeName> {
        Self::with_entries(type_name, payload, PropertyMap::new())
    }

    /// A value of the host's type `type_name` holding its own entries, refused when the
    /// name is one of `CEL_VALUE_KEYS`.
    pub fn with_entries(
        type_name: impl Into<String>,
        payload: Arc<dyn Any + Send + Sync>,
        entries: PropertyMap<CelValue>,
    ) -> Result<Self, ReservedTypeName> {
        let type_name = type_name.into();
        reserved(&type_name)?;
        Ok(Self {
            type_name: Some(type_name.into()),
            payload,
            entries: (!entries.is_empty()).then(|| Arc::new(entries)),
        })
    }

    /// A host object of no CEL type.
    pub fn unnamed(payload: Arc<dyn Any + Send + Sync>) -> Self {
        Self { type_name: None, payload, entries: None }
    }

    pub fn type_name(&self) -> Option<&str> {
        self.type_name.as_deref()
    }

    pub fn payload(&self) -> &Arc<dyn Any + Send + Sync> {
        &self.payload
    }

    /// The value's own entries; none for a value built without them.
    pub fn entries(&self) -> &PropertyMap<CelValue> {
        match self.entries.as_deref() {
            Some(entries) => entries,
            None => no_entries(),
        }
    }

    fn unlink(&mut self, pending: &mut Vec<CelValue>) {
        if let Some(entries) = take_shared(&mut self.entries) {
            pending.extend(entries.into_iter().map(|(_, value)| value).filter(holds_values));
        }
    }
}

impl Drop for CelHostValue {
    fn drop(&mut self) {
        if self.entries.is_some() {
            release(|pending| self.unlink(pending));
        }
    }
}

impl PartialEq for CelHostValue {
    fn eq(&self, other: &Self) -> bool {
        let same_entries = match (&self.entries, &other.entries) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        };
        self.type_name == other.type_name
            && std::ptr::eq(Arc::as_ptr(&self.payload) as *const (), Arc::as_ptr(&other.payload) as *const ())
            && same_entries
    }
}

impl fmt::Debug for CelHostValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print(f, Piece::Host(self))
    }
}

/// A value in the CEL value domain.
#[derive(Clone)]
pub enum CelValue {
    Null,
    Bool(bool),
    Int(i64),
    Uint(u64),
    Double(f64),
    String(Arc<str>),
    Bytes(Arc<[u8]>),
    List(CelList),
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
        equal_pairs(vec![(self, other)])
    }
}

impl fmt::Debug for CelValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        print(f, Piece::Value(self))
    }
}

impl From<CelError> for CelValue {
    fn from(error: CelError) -> Self {
        CelValue::Error(error)
    }
}

// --- release ---------------------------------------------------------------

/// Whether a value can hold other values, and so has children to let go of.
fn holds_values(value: &CelValue) -> bool {
    matches!(
        value,
        CelValue::List(_) | CelValue::Map(_) | CelValue::Record(_) | CelValue::Optional(_) | CelValue::Host(_)
    )
}

/// Moves every child a value alone holds onto `pending`, leaving it empty.
fn unlink(value: &mut CelValue, pending: &mut Vec<CelValue>) {
    match value {
        CelValue::List(list) => list.unlink(pending),
        CelValue::Map(map) => map.unlink(pending),
        CelValue::Record(record) => record.unlink(pending),
        CelValue::Optional(optional) => optional.unlink(pending),
        CelValue::Host(host) => host.unlink(pending),
        _ => {}
    }
}

/// Lets go of a value's descendants on a heap list, so releasing a value of any depth
/// costs no stack. Each value taken off the list is emptied before it is dropped, so
/// its own release finds nothing to do.
fn release(start: impl FnOnce(&mut Vec<CelValue>)) {
    let mut pending = Vec::new();
    start(&mut pending);
    while let Some(mut value) = pending.pop() {
        unlink(&mut value, &mut pending);
    }
}

// --- identity --------------------------------------------------------------

type Pairs<'a> = Vec<(&'a CelValue, &'a CelValue)>;

fn shared<T>(left: &Option<Arc<T>>, right: &Option<Arc<T>>) -> bool {
    matches!((left, right), (Some(a), Some(b)) if Arc::ptr_eq(a, b))
}

fn list_pairs<'a>(left: &'a CelList, right: &'a CelList, pending: &mut Pairs<'a>) -> bool {
    if shared(&left.items, &right.items) {
        return true;
    }
    if left.len() != right.len() {
        return false;
    }
    pending.extend(left.iter().zip(right.iter()));
    true
}

fn map_pairs<'a>(left: &'a CelMap, right: &'a CelMap, pending: &mut Pairs<'a>) -> bool {
    if shared(&left.inner, &right.inner) {
        return true;
    }
    if left.len() != right.len() {
        return false;
    }
    for (key, value) in left.iter() {
        let held = map_key_identity(key).and_then(|identity| right.entry(&identity));
        match held {
            // A key is an int, a uint, a bool or a string, so comparing two holds no value.
            Some((held_key, held)) if scalar_identical(held_key, key) => pending.push((value, held)),
            _ => return false,
        }
    }
    true
}

fn record_pairs<'a>(left: &'a CelRecord, right: &'a CelRecord, pending: &mut Pairs<'a>) -> bool {
    if shared(&left.entries, &right.entries) {
        return true;
    }
    if left.len() != right.len() {
        return false;
    }
    for (key, value) in left.iter() {
        match right.get(key) {
            Some(held) => pending.push((value, held)),
            None => return false,
        }
    }
    true
}

fn crossing_pairs<'a>(map: &'a CelMap, record: &'a CelRecord, pending: &mut Pairs<'a>) -> bool {
    if map.len() != record.len() {
        return false;
    }
    for (key, value) in map.iter() {
        match key {
            CelValue::String(key) => match record.get(key) {
                Some(held) => pending.push((value, held)),
                None => return false,
            },
            _ => return false,
        }
    }
    true
}

fn optional_pairs<'a>(left: &'a CelOptional, right: &'a CelOptional, pending: &mut Pairs<'a>) -> bool {
    match (left.held(), right.held()) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            pending.push((a, b));
            true
        }
        _ => false,
    }
}

/// Two values that hold no other value, compared as themselves.
fn scalar_identical(left: &CelValue, right: &CelValue) -> bool {
    use CelValue::*;
    match (left, right) {
        (Null, Null) => true,
        (Bool(a), Bool(b)) => a == b,
        (Int(a), Int(b)) => a == b,
        (Uint(a), Uint(b)) => a == b,
        (Double(a), Double(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
        (String(a), String(b)) => a == b,
        (Bytes(a), Bytes(b)) => a == b,
        (Timestamp(a), Timestamp(b)) => a == b,
        (Duration(a), Duration(b)) => a == b,
        (Type(a), Type(b)) => a == b,
        (Error(a), Error(b)) => a == b,
        (Host(a), Host(b)) => a == b,
        _ => false,
    }
}

/// Whether every pair is one value, comparing on a heap list.
fn equal_pairs(mut pending: Pairs<'_>) -> bool {
    use CelValue::*;
    while let Some((left, right)) = pending.pop() {
        let same = match (left, right) {
            (List(a), List(b)) => list_pairs(a, b, &mut pending),
            (Map(a), Map(b)) => map_pairs(a, b, &mut pending),
            (Record(a), Record(b)) => record_pairs(a, b, &mut pending),
            (Map(map), Record(record)) | (Record(record), Map(map)) => crossing_pairs(map, record, &mut pending),
            (Optional(a), Optional(b)) => optional_pairs(a, b, &mut pending),
            _ => scalar_identical(left, right),
        };
        if !same {
            return false;
        }
    }
    true
}

// --- printing --------------------------------------------------------------

/// One step of printing: text, or a value or aggregate still to be written.
enum Piece<'a> {
    Text(&'static str),
    Key(&'a str),
    Value(&'a CelValue),
    List(&'a CelList),
    Map(&'a CelMap),
    Record(&'a CelRecord),
    Optional(&'a CelOptional),
    Host(&'a CelHostValue),
}

/// Pushes `[a, b, …]`-shaped pieces so they print in order: `open`, each item with
/// `", "` between, `close`.
fn push_items<'a>(
    pending: &mut Vec<Piece<'a>>,
    open: &'static str,
    close: &'static str,
    items: Vec<Vec<Piece<'a>>>,
) {
    pending.push(Piece::Text(close));
    for (at, item) in items.into_iter().enumerate().rev() {
        pending.extend(item.into_iter().rev());
        if at > 0 {
            pending.push(Piece::Text(", "));
        }
    }
    pending.push(Piece::Text(open));
}

/// Writes a value as `#[derive(Debug)]` would, on a heap list.
fn print(f: &mut fmt::Formatter<'_>, first: Piece<'_>) -> fmt::Result {
    let mut pending = vec![first];
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Text(text) => f.write_str(text)?,
            Piece::Key(key) => write!(f, "{key:?}")?,
            Piece::List(list) => {
                push_items(&mut pending, "[", "]", list.iter().map(|item| vec![Piece::Value(item)]).collect());
            }
            Piece::Map(map) => push_items(
                &mut pending,
                "{",
                "}",
                map.iter().map(|(key, value)| vec![Piece::Value(key), Piece::Text(": "), Piece::Value(value)]).collect(),
            ),
            Piece::Record(record) => push_items(
                &mut pending,
                "{",
                "}",
                record.iter().map(|(key, value)| vec![Piece::Key(key), Piece::Text(": "), Piece::Value(value)]).collect(),
            ),
            Piece::Optional(optional) => {
                pending.push(Piece::Text(" }"));
                match optional.held() {
                    Some(held) => pending.extend([Piece::Text(")"), Piece::Value(held), Piece::Text("Some(")]),
                    None => pending.push(Piece::Text("None")),
                }
                pending.push(Piece::Text("CelOptional { held: "));
            }
            Piece::Host(host) => {
                write!(f, "CelHostValue {{ type_name: {:?}, entries: ", host.type_name())?;
                pending.push(Piece::Text(", .. }"));
                push_items(
                    &mut pending,
                    "{",
                    "}",
                    host.entries()
                        .iter()
                        .map(|(key, value)| vec![Piece::Key(key), Piece::Text(": "), Piece::Value(value)])
                        .collect(),
                );
            }
            Piece::Value(value) => match value {
                CelValue::Null => f.write_str("Null")?,
                CelValue::Bool(held) => write!(f, "Bool({held:?})")?,
                CelValue::Int(held) => write!(f, "Int({held:?})")?,
                CelValue::Uint(held) => write!(f, "Uint({held:?})")?,
                CelValue::Double(held) => write!(f, "Double({held:?})")?,
                CelValue::String(held) => write!(f, "String({:?})", &**held)?,
                CelValue::Bytes(held) => write!(f, "Bytes({:?})", &**held)?,
                CelValue::Timestamp(held) => write!(f, "Timestamp({held:?})")?,
                CelValue::Duration(held) => write!(f, "Duration({held:?})")?,
                CelValue::Type(held) => write!(f, "Type({held:?})")?,
                CelValue::Error(held) => write!(f, "Error({held:?})")?,
                CelValue::List(list) => pending.extend([Piece::Text(")"), Piece::List(list), Piece::Text("List(")]),
                CelValue::Map(map) => pending.extend([Piece::Text(")"), Piece::Map(map), Piece::Text("Map(")]),
                CelValue::Record(record) => {
                    pending.extend([Piece::Text(")"), Piece::Record(record), Piece::Text("Record(")])
                }
                CelValue::Optional(optional) => {
                    pending.extend([Piece::Text(")"), Piece::Optional(optional), Piece::Text("Optional(")])
                }
                CelValue::Host(host) => pending.extend([Piece::Text(")"), Piece::Host(host), Piece::Text("Host(")]),
            },
        }
    }
    Ok(())
}

// --- constructors ----------------------------------------------------------

pub fn cel_type_value(name: impl Into<String>) -> CelTypeValue {
    CelTypeValue { name: name.into().into() }
}

pub fn cel_none() -> CelOptional {
    CelOptional { held: None }
}

pub fn cel_some(held: CelValue) -> CelOptional {
    CelOptional { held: Some(Arc::new(held)) }
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
