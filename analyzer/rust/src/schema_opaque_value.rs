//! A value as the JSON Schema validator sees it: JavaScript's reading of a CEL value,
//! with every instance value opaque. Twins `@telorun/sdk`'s `schema-opaque-value.ts`
//! (`opaqueSchemaView`, the stand-in's equality) and the Node kernel's BigInt view
//! (`bigint-schema-view.ts`, an int64 or a uint rendered as the double it is, marked
//! when it is not exact). It lives here rather than in `sdk/rust/core` because this
//! crate holds the only JSON Schema validator a Rust process the kernel runs has.
//!
//! - A number is a double, as JavaScript holds one; an int64 or a uint keeps the
//!   integer it was rendered from, so a validation's result gives it back.
//! - An object keeps ECMAScript's own-property order: canonical array indices first,
//!   ascending, then every other key in insertion order.
//! - Bytes, an instant, a duration, a type, an optional and a host's typed value are
//!   opaque: an object to `type`, holding no members, equal only to an equal value
//!   of its own type. `x-telo-type` alone reads the value a stand-in holds.
//! - A member every JavaScript object inherits (`toString`, `constructor`, …) is
//!   present on every object to `required`, `properties` and `dependencies`, as
//!   AJV's `data[key] !== undefined` reads it.

use std::sync::Arc;

use telorun_cel_value::{CelList, CelRecord, CelValue};
use telorun_sdk_core::plain_encoding::host_members;
use telorun_sdk_core::value_type::{cel_type_of_value_type, value_types_in_order};

/// An integer a number was rendered from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExactInteger {
    Int(i64),
    Uint(u64),
}

/// A JavaScript number, and the exact integer it renders when it is one.
#[derive(Clone, Copy, Debug)]
pub struct JsNumber {
    pub value: f64,
    pub exact: Option<ExactInteger>,
}

impl JsNumber {
    pub fn of(value: f64) -> Self {
        Self { value, exact: None }
    }

    /// Whether a view rendered this double from an exact integer it cannot hold —
    /// Node's `markExactRendering`.
    pub fn marked_exact(&self) -> bool {
        self.exact.is_some() && !is_safe_integer(self.value)
    }
}

/// `Number.isSafeInteger`.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value && value.abs() <= 9_007_199_254_740_991.0
}

/// `Number.isInteger`.
pub fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

/// A value as the validator reads and writes it. It is copied and released on work
/// lists, so no depth of nesting reaches the native stack.
#[derive(Debug)]
pub enum JsValue {
    /// An array hole a tuple default leaves.
    Undefined,
    Null,
    Bool(bool),
    Number(JsNumber),
    String(Arc<str>),
    Array(Vec<JsValue>),
    Object(JsObject),
    /// An instance value, presented opaque, with the own members a default fill wrote
    /// onto the stand-in (which the value a validation answers drops).
    Opaque(Box<Opaque>),
    /// A member every object inherits, read through a property access.
    Function(&'static str),
}

impl JsValue {
    /// Whether this value holds values of its own.
    fn is_container(&self) -> bool {
        match self {
            JsValue::Array(items) => !items.is_empty(),
            JsValue::Object(object) => !object.is_empty(),
            JsValue::Opaque(opaque) => !opaque.own.is_empty(),
            _ => false,
        }
    }

    /// A value holding no values of its own, copied; `None` for a container.
    fn leaf_copy(&self) -> Option<JsValue> {
        Some(match self {
            JsValue::Undefined => JsValue::Undefined,
            JsValue::Null => JsValue::Null,
            JsValue::Bool(b) => JsValue::Bool(*b),
            JsValue::Number(n) => JsValue::Number(*n),
            JsValue::String(s) => JsValue::String(s.clone()),
            JsValue::Function(name) => JsValue::Function(name),
            JsValue::Array(_) | JsValue::Object(_) | JsValue::Opaque(_) => return None,
        })
    }
}

impl Clone for JsValue {
    fn clone(&self) -> Self {
        enum Step<'v> {
            Enter(&'v JsValue),
            Array(usize),
            Object(&'v JsObject),
            Opaque(&'v Opaque),
        }
        if let Some(copy) = self.leaf_copy() {
            return copy;
        }
        fn members(object: &JsObject) -> impl Iterator<Item = Step<'_>> {
            object.entries.iter().rev().map(|(_, item)| Step::Enter(item))
        }
        let mut work = vec![Step::Enter(self)];
        let mut done: Vec<JsValue> = Vec::new();
        while let Some(step) = work.pop() {
            match step {
                Step::Enter(JsValue::Array(items)) => {
                    work.push(Step::Array(items.len()));
                    work.extend(items.iter().rev().map(Step::Enter));
                }
                Step::Enter(JsValue::Object(object)) => {
                    work.push(Step::Object(object));
                    work.extend(members(object));
                }
                Step::Enter(JsValue::Opaque(opaque)) => {
                    work.push(Step::Opaque(opaque));
                    work.extend(members(&opaque.own));
                }
                Step::Enter(leaf) => done.push(leaf.leaf_copy().expect("a leaf")),
                Step::Array(len) => {
                    let items = done.split_off(done.len() - len);
                    done.push(JsValue::Array(items));
                }
                Step::Object(object) => {
                    let own = rebuilt(object, &mut done);
                    done.push(JsValue::Object(own));
                }
                Step::Opaque(opaque) => {
                    let own = rebuilt(&opaque.own, &mut done);
                    done.push(JsValue::Opaque(Box::new(Opaque { held: opaque.held.clone(), own })));
                }
            }
        }
        done.pop().expect("one value was copied")
    }
}

/// `object`'s keys over the copies of its values, the last `object.len()` of `done`.
fn rebuilt(object: &JsObject, done: &mut Vec<JsValue>) -> JsObject {
    let values = done.split_off(done.len() - object.len());
    JsObject { entries: object.entries.iter().map(|(key, _)| key.clone()).zip(values).collect() }
}

impl Drop for JsValue {
    fn drop(&mut self) {
        let mut pending: Vec<JsValue> = Vec::new();
        detach(self, &mut pending);
        while let Some(mut value) = pending.pop() {
            detach(&mut value, &mut pending);
        }
    }
}

/// Move the values `value` holds onto `pending` when any of them holds values of its own,
/// so releasing `value` releases only leaves.
fn detach(value: &mut JsValue, pending: &mut Vec<JsValue>) {
    match value {
        JsValue::Array(items) => {
            if items.iter().any(JsValue::is_container) {
                pending.append(items);
            }
        }
        JsValue::Object(object) => object.detach(pending),
        JsValue::Opaque(opaque) => opaque.own.detach(pending),
        _ => {}
    }
}

/// A stand-in: the instance value it holds, and what was written onto it.
#[derive(Clone, Debug)]
pub struct Opaque {
    pub held: CelValue,
    pub own: JsObject,
}

/// The members every plain JavaScript object inherits from `Object.prototype`.
pub const INHERITED_MEMBERS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// The inherited member `key` names, if it names one.
pub fn inherited_member(key: &str) -> Option<&'static str> {
    INHERITED_MEMBERS.iter().copied().find(|name| *name == key)
}

/// Whether `key` is a canonical array index, which ECMAScript orders first.
pub fn is_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    (value < u32::MAX as u64).then_some(value as u32)
}

/// A JavaScript object's own string-keyed properties, in own-property order.
#[derive(Clone, Debug, Default)]
pub struct JsObject {
    entries: Vec<(Arc<str>, JsValue)>,
}

impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.entries.iter().find(|(k, _)| &**k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut JsValue> {
        self.entries.iter_mut().find(|(k, _)| &**k == key).map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Set `key`: a held key keeps its place, a new index key goes among the indices in
    /// order, any other new key goes last.
    pub fn insert(&mut self, key: &str, value: JsValue) {
        if let Some(held) = self.get_mut(key) {
            *held = value;
            return;
        }
        let entry = (Arc::<str>::from(key), value);
        match is_array_index(key) {
            Some(index) => {
                let at = self
                    .entries
                    .iter()
                    .position(|(k, _)| is_array_index(k).is_none_or(|other| other > index))
                    .unwrap_or(self.entries.len());
                self.entries.insert(at, entry);
            }
            None => self.entries.push(entry),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<JsValue> {
        let at = self.entries.iter().position(|(k, _)| &**k == key)?;
        Some(self.entries.remove(at).1)
    }

    pub fn keys(&self) -> Vec<Arc<str>> {
        self.entries.iter().map(|(k, _)| k.clone()).collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &JsValue)> {
        self.entries.iter().map(|(k, v)| (&**k, v))
    }

    fn detach(&mut self, pending: &mut Vec<JsValue>) {
        if self.entries.iter().any(|(_, item)| item.is_container()) {
            pending.extend(self.entries.drain(..).map(|(_, item)| item));
        }
    }
}

impl JsValue {
    pub fn string(text: &str) -> Self {
        JsValue::String(Arc::from(text))
    }

    pub fn number(value: f64) -> Self {
        JsValue::Number(JsNumber::of(value))
    }

    /// Whether this value is an object to JavaScript's `typeof` and not an array —
    /// a plain object or an opaque stand-in.
    pub fn is_object(&self) -> bool {
        matches!(self, JsValue::Object(_) | JsValue::Opaque(_))
    }

    /// What `data[key]` reads, `None` for `undefined`. Only an object answers a
    /// member; a stand-in answers only what it inherits.
    pub fn member(&self, key: &str) -> Option<&JsValue> {
        static INHERITED: [JsValue; 12] = [
            JsValue::Function("constructor"),
            JsValue::Function("__defineGetter__"),
            JsValue::Function("__defineSetter__"),
            JsValue::Function("hasOwnProperty"),
            JsValue::Function("__lookupGetter__"),
            JsValue::Function("__lookupSetter__"),
            JsValue::Function("isPrototypeOf"),
            JsValue::Function("propertyIsEnumerable"),
            JsValue::Function("toString"),
            JsValue::Function("valueOf"),
            JsValue::Function("__proto__"),
            JsValue::Function("toLocaleString"),
        ];
        let inherited = || INHERITED_MEMBERS.iter().position(|name| *name == key).map(|at| &INHERITED[at]);
        match self {
            JsValue::Object(object) => object.get(key).or_else(inherited),
            JsValue::Opaque(opaque) => opaque.own.get(key).or_else(inherited),
            _ => None,
        }
    }

    /// The own members of an object or a stand-in.
    pub fn own_members(&self) -> Option<&JsObject> {
        match self {
            JsValue::Object(object) => Some(object),
            JsValue::Opaque(opaque) => Some(&opaque.own),
            _ => None,
        }
    }

    pub fn own_members_mut(&mut self) -> Option<&mut JsObject> {
        match self {
            JsValue::Object(object) => Some(object),
            JsValue::Opaque(opaque) => Some(&mut opaque.own),
            _ => None,
        }
    }

    /// Whether `data[key] !== undefined`.
    pub fn has_member(&self, key: &str) -> bool {
        !matches!(self.member(key), None | Some(JsValue::Undefined))
    }
}

/// Whether a CEL value is an instance value a view presents opaque.
pub fn is_schema_instance_value(value: &CelValue) -> bool {
    matches!(
        value,
        CelValue::Bytes(_)
            | CelValue::Timestamp(_)
            | CelValue::Duration(_)
            | CelValue::Type(_)
            | CelValue::Optional(_)
            | CelValue::Host(_)
    )
}

/// The view of `value`: plain containers as JavaScript holds them, every int64 and
/// uint rendered as a double, every instance value opaque. Built without recursion, so no
/// depth of nesting exhausts the stack.
pub fn schema_view(value: &CelValue) -> JsValue {
    enum Step<'v> {
        Enter(&'v CelValue),
        List(usize),
        Object(Vec<&'v str>),
    }
    let mut work = vec![Step::Enter(value)];
    let mut done: Vec<JsValue> = Vec::new();
    while let Some(step) = work.pop() {
        match step {
            Step::Enter(CelValue::List(items)) => {
                work.push(Step::List(items.len()));
                work.extend(items.iter().rev().map(Step::Enter));
            }
            Step::Enter(CelValue::Record(record)) => {
                work.push(Step::Object(record.keys().collect()));
                work.extend(record.iter().map(|(_, item)| item).collect::<Vec<_>>().into_iter().rev().map(Step::Enter));
            }
            Step::Enter(CelValue::Map(map)) if map.iter().all(|(key, _)| matches!(key, CelValue::String(_))) => {
                let entries: Vec<(&str, &CelValue)> = map
                    .iter()
                    .filter_map(|(key, item)| match key {
                        CelValue::String(key) => Some((&**key, item)),
                        _ => None,
                    })
                    .collect();
                work.push(Step::Object(entries.iter().map(|(key, _)| *key).collect()));
                work.extend(entries.into_iter().rev().map(|(_, item)| Step::Enter(item)));
            }
            Step::Enter(leaf) => done.push(leaf_view(leaf)),
            Step::List(len) => {
                let items = done.split_off(done.len() - len);
                done.push(JsValue::Array(items));
            }
            Step::Object(keys) => {
                let items = done.split_off(done.len() - keys.len());
                let mut object = JsObject::new();
                for (key, item) in keys.into_iter().zip(items) {
                    object.insert(key, item);
                }
                done.push(JsValue::Object(object));
            }
        }
    }
    done.pop().expect("one view was built")
}

/// The view of a value holding no plain container's members.
fn leaf_view(value: &CelValue) -> JsValue {
    match value {
        CelValue::Null => JsValue::Null,
        CelValue::Bool(b) => JsValue::Bool(*b),
        CelValue::Int(i) => JsValue::Number(JsNumber { value: *i as f64, exact: Some(ExactInteger::Int(*i)) }),
        CelValue::Uint(u) => JsValue::Number(JsNumber { value: *u as f64, exact: Some(ExactInteger::Uint(*u)) }),
        CelValue::Double(d) => JsValue::number(*d),
        CelValue::String(s) => JsValue::String(s.clone()),
        // A map with a key a plain object cannot hold is its carrier, whose one own
        // member holds the entries as a JavaScript `Map` — no own members.
        CelValue::Map(_) => {
            let mut object = JsObject::new();
            object.insert("entries", JsValue::Object(JsObject::new()));
            JsValue::Object(object)
        }
        CelValue::Error(error) => {
            let mut object = JsObject::new();
            object.insert("code", JsValue::string(error.code.as_str()));
            object.insert("message", JsValue::string(&error.message));
            if let Some(range) = error.range {
                let mut span = JsObject::new();
                span.insert("start", JsValue::number(range.start as f64));
                span.insert("end", JsValue::number(range.end as f64));
                object.insert("range", JsValue::Object(span));
            }
            JsValue::Object(object)
        }
        other => JsValue::Opaque(Box::new(Opaque { held: other.clone(), own: JsObject::new() })),
    }
}

/// A view as a CEL value again: a stand-in its instance value, a rendered integer the
/// integer it was rendered from when `keep_exact` (a kernel configuration's answer), or
/// the double it renders (the validator's own view). Built without recursion.
pub fn value_of_view(view: &JsValue, keep_exact: bool) -> CelValue {
    enum Step<'v> {
        Enter(&'v JsValue),
        List(usize),
        Record(&'v JsObject),
    }
    let mut work = vec![Step::Enter(view)];
    let mut done: Vec<CelValue> = Vec::new();
    while let Some(step) = work.pop() {
        match step {
            Step::Enter(JsValue::Array(items)) => {
                work.push(Step::List(items.len()));
                work.extend(items.iter().rev().map(Step::Enter));
            }
            Step::Enter(JsValue::Object(object)) => {
                work.push(Step::Record(object));
                work.extend(object.entries.iter().rev().map(|(_, item)| Step::Enter(item)));
            }
            Step::Enter(leaf) => done.push(match leaf {
                JsValue::Bool(b) => CelValue::Bool(*b),
                JsValue::Number(number) => match (keep_exact, number.exact) {
                    (true, Some(ExactInteger::Int(i))) => CelValue::Int(i),
                    (true, Some(ExactInteger::Uint(u))) => CelValue::Uint(u),
                    _ => CelValue::Double(number.value),
                },
                JsValue::String(s) => CelValue::String(s.clone()),
                JsValue::Opaque(opaque) => opaque.held.clone(),
                _ => CelValue::Null,
            }),
            Step::List(len) => {
                let items = done.split_off(done.len() - len);
                done.push(CelValue::List(items.into_iter().collect::<CelList>()));
            }
            Step::Record(object) => {
                let items = done.split_off(done.len() - object.len());
                let mut record = CelRecord::new();
                for ((key, _), item) in object.entries.iter().zip(items) {
                    record.insert(&**key, item);
                }
                done.push(CelValue::Record(record));
            }
        }
    }
    done.pop().expect("one value was built")
}

/// Whether two instance values are the same value under a stand-in's equality: the
/// same type and the same content (`valueOf`'s identity text on Node).
pub fn opaque_identical(a: &CelValue, b: &CelValue) -> bool {
    match (a, b) {
        (CelValue::Host(x), CelValue::Host(y)) => {
            if x.type_name() != y.type_name() {
                return false;
            }
            if x.entries() != y.entries() {
                return false;
            }
            // A value type with members is identified by them, whatever object holds them.
            let encoding = value_types_in_order()
                .find(|entry| entry.members.is_some() && Some(cel_type_of_value_type(entry)) == x.type_name())
                .and_then(|entry| entry.encoding.clone());
            match encoding.and_then(|encoding| Some((host_members(&encoding, x)?, host_members(&encoding, y)?))) {
                Some((left, right)) => left == right,
                None => std::sync::Arc::ptr_eq(x.payload(), y.payload()),
            }
        }
        _ => a == b,
    }
}
