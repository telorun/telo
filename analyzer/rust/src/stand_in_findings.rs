//! What schema validation may say about a value that is not there yet. Mirrors
//! `../../nodejs/src/stand-in-findings.ts`.
//!
//! Before validation every expression is replaced by a STAND-IN. Two classes, by what the
//! tag guarantees:
//!
//! - **computed** — a `!cel` value, or any tag whose produced type the engine leaves to the
//!   slot: every finding at or below it is dropped;
//! - **produced** — a tag whose engine declares a fixed produced type (`!interpolate`, an
//!   embed, a module path): a type, shape or value-type finding stands, a value constraint
//!   is dropped.
//!
//! A finding stands only if it holds for every value the stand-ins could take; a union is
//! decided by the judge (`schema_findings_judge`), and `uniqueItems`, `const` and `enum`
//! raised at a value CONTAINING a stand-in are decided on the parts the author wrote.
//!
//! A value here is a tagged sentinel as the Rust loader writes one; Node's compiled-value
//! form has no counterpart, since no Rust host compiles an expression before validating.

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, HashSet};

use serde_json::Value;
use telo_templating::{
    build_cel_environment, default_registry, produced_type_of, repeatable_source, tagged_sentinel_parts, CelEnvironment, CelHandlers,
    CompileEnv, CompileOutcome, TemplatingError, REF_ENGINE,
};
use telorun_cel_value::{es_number, CelValue};

use crate::ajv_runtime::SchemaError;
use crate::schema_error_report::{json_stringify, value_at};
use crate::schema_opaque_value::opaque_identical;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StandInClass {
    Computed,
    Produced,
}

/// What makes two stand-ins the same expression: the tag, its text, and whether that text
/// is REPEATABLE — means one value wherever it is written twice in one value.
#[derive(Clone, Debug)]
pub struct StandInIdentity {
    pub tag: String,
    pub text: String,
    repeatable: OnceCell<bool>,
}

thread_local! {
    static COMPILE_ENV: CelEnvironment = build_cel_environment(CelHandlers::default());
}

impl StandInIdentity {
    /// An identity whose verdict the tag's engine gives when first asked.
    pub fn new(tag: &str, text: &str) -> Self {
        Self { tag: tag.into(), text: text.into(), repeatable: OnceCell::new() }
    }

    /// An identity whose verdict is already known.
    pub fn with_verdict(tag: &str, text: &str, repeatable: bool) -> Self {
        let identity = Self::new(tag, text);
        identity.repeatable.set(repeatable).expect("a fresh cell");
        identity
    }

    pub fn repeatable(&self) -> bool {
        *self.repeatable.get_or_init(|| COMPILE_ENV.with(|env| repeatable_source(&self.tag, &self.text, env)))
    }
}

/// One stand-in: what its tag guarantees, and which expression it stands for.
#[derive(Clone, Debug)]
pub struct StandIn {
    pub class: StandInClass,
    pub identity: Option<StandInIdentity>,
}

/// Every stand-in substituted into one value, keyed by its JSON Pointer from the root.
pub type StandIns = HashMap<String, StandIn>;

/// What a tagged value is to validation.
#[derive(Clone, Debug)]
pub enum StandInReading {
    /// A stand-in; a produced one carries the type its tag produces.
    StandIn { stand_in: StandIn, produced: Option<Value> },
    /// The plain value its engine resolved it to now.
    Value(Value),
}

/// `readStandIn`: classify a tagged sentinel, or `None` for anything else (a `!ref` is an
/// identity marker, never a stand-in). Read off the engine's compile contract, never off a
/// tag name: an engine whose scalar holds CEL defers to evaluation by construction, any
/// other is asked to compile — a plain result is a value resolved now, anything else exists
/// only after load — and the class is whether the engine declares a produced type. Such an
/// engine's compile failure is raised as it is, as Node's compile throws.
pub fn read_stand_in(value: &Value) -> Result<Option<StandInReading>, TemplatingError> {
    let Some((engine_name, text)) = tagged_sentinel_parts(value) else { return Ok(None) };
    if engine_name == REF_ENGINE {
        return Ok(None);
    }
    if let Some(engine) = default_registry().get(engine_name).filter(|engine| !engine.holds_expressions()) {
        let compiled = COMPILE_ENV.with(|env| engine.compile(text, &CompileEnv { cel_env: env, module_names: None }))?;
        if let CompileOutcome::Resolved(resolved) = compiled {
            return Ok(Some(StandInReading::Value(resolved)));
        }
    }
    let produced = produced_type_of(engine_name);
    let identity = Some(StandInIdentity::new(engine_name, text));
    let class = if produced.is_some() { StandInClass::Produced } else { StandInClass::Computed };
    Ok(Some(StandInReading::StandIn { stand_in: StandIn { class, identity }, produced }))
}

/// Findings judged on a value's CONTENT, which a produced stand-in does not have yet.
const VALUE_CONSTRAINT_KEYWORDS: [&str; 17] = [
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "propertyNames",
];

/// Keywords comparing a value's parts with each other or with a constant.
const CONTENT_KEYWORDS: [&str; 3] = ["uniqueItems", "const", "enum"];

/// A `oneOf` that failed because SEVERAL branches matched.
pub fn is_ambiguous_one_of(error: &SchemaError) -> bool {
    error.keyword == "oneOf" && error.params.get("passingSchemas").is_some_and(Value::is_array)
}

fn excused(error: &SchemaError, stand_ins: &StandIns) -> bool {
    let value_level = VALUE_CONSTRAINT_KEYWORDS.contains(&error.keyword.as_str()) || is_ambiguous_one_of(error);
    let mut path = Some(error.instance_path.as_str());
    while let Some(at) = path {
        match stand_ins.get(at).map(|s| s.class) {
            Some(StandInClass::Computed) => return true,
            Some(StandInClass::Produced) if value_level => return true,
            _ => {}
        }
        path = if at.is_empty() { None } else { Some(&at[..at.rfind('/').unwrap_or(0)]) };
    }
    false
}

fn escape_segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// A plain object's members, as a JSON value holds them.
fn members(value: &CelValue) -> Option<Vec<(String, &CelValue)>> {
    match value {
        CelValue::Record(record) => Some(record.iter().map(|(k, v)| (k.to_string(), v)).collect()),
        CelValue::Map(map) if map.iter().all(|(k, _)| matches!(k, CelValue::String(_))) => Some(
            map.iter()
                .map(|(k, v)| match k {
                    CelValue::String(k) => (k.to_string(), v),
                    _ => unreachable!("every key is text"),
                })
                .collect(),
        ),
        _ => None,
    }
}

fn is_primitive(value: &CelValue) -> bool {
    matches!(value, CelValue::Null | CelValue::Bool(_) | CelValue::Int(_) | CelValue::Uint(_) | CelValue::Double(_) | CelValue::String(_))
}

/// `===` over two values.
fn strictly_equal(a: &CelValue, b: &CelValue) -> bool {
    match (a, b) {
        (CelValue::Double(x), CelValue::Double(y)) => x == y,
        _ if is_primitive(a) && is_primitive(b) => a == b,
        _ => false,
    }
}

/// Structural equality over JSON data; an instance equals only an identical one.
fn same_value(a: &CelValue, b: &CelValue) -> bool {
    if strictly_equal(a, b) {
        return true;
    }
    if let (CelValue::List(x), CelValue::List(y)) = (a, b) {
        return x.len() == y.len() && x.iter().zip(y.iter()).all(|(l, r)| same_value(l, r));
    }
    match (members(a), members(b)) {
        (Some(x), Some(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.iter().any(|(m, w)| m == k && same_value(v, w))),
        (None, None) if !is_primitive(a) && !matches!(a, CelValue::List(_)) => opaque_identical(a, b),
        _ => false,
    }
}

/// What kind a value is, as `typeof` and its prototype tell.
fn kind_of(value: &CelValue) -> String {
    match value {
        CelValue::Null => "null".into(),
        CelValue::Bool(_) => "boolean".into(),
        CelValue::Int(_) | CelValue::Uint(_) => "bigint".into(),
        CelValue::Double(_) => "number".into(),
        CelValue::String(_) => "string".into(),
        CelValue::List(_) => "array".into(),
        other if members(other).is_some() => "object".into(),
        CelValue::Host(host) => format!("instance:{}", host.type_name().unwrap_or("")),
        CelValue::Bytes(_) => "instance:bytes".into(),
        CelValue::Timestamp(_) => "instance:timestamp".into(),
        CelValue::Duration(_) => "instance:duration".into(),
        _ => "instance".into(),
    }
}

/// The literal a JSON value is, as a value.
fn json_value(value: &Value) -> CelValue {
    match value {
        Value::Null => CelValue::Null,
        Value::Bool(b) => CelValue::Bool(*b),
        Value::Number(n) => CelValue::Double(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => CelValue::String(s.as_str().into()),
        Value::Array(items) => CelValue::List(items.iter().map(json_value).collect()),
        Value::Object(map) => {
            let mut record = telorun_cel_value::CelRecord::new();
            for (k, v) in map {
                record.insert(k, json_value(v));
            }
            CelValue::Record(record)
        }
    }
}

/// What the stand-ins in one validated value excuse, finding by finding.
pub struct StandInRule {
    stand_ins: StandIns,
    holders: RefCell<Option<HashSet<String>>>,
    next_instance: Cell<usize>,
}

impl StandInRule {
    /// `standInRule`: the rule the stand-ins impose on a finding raised where it sits.
    pub fn new(stand_ins: StandIns) -> Self {
        Self { stand_ins, holders: RefCell::new(None), next_instance: Cell::new(0) }
    }

    /// True when a stand-in excuses `finding` wherever it was raised.
    pub fn excused(&self, finding: &SchemaError) -> bool {
        excused(finding, &self.stand_ins)
    }

    /// The finding as it stands once the stand-ins in `value` are accounted for, or `None`
    /// when they excuse it.
    pub fn standing(&self, finding: &SchemaError, value: &CelValue) -> Option<SchemaError> {
        if self.stand_ins.is_empty() {
            return Some(finding.clone());
        }
        if self.excused(finding) {
            return None;
        }
        let keyword = finding.keyword.as_str();
        let path = finding.instance_path.as_str();
        if !CONTENT_KEYWORDS.contains(&keyword) || !self.holds_stand_in(path) {
            return Some(finding.clone());
        }
        let written = value_at(value, path);
        if keyword != "uniqueItems" {
            let allowed: Vec<Value> = if keyword == "const" {
                vec![finding.params.get("allowedValue").cloned().unwrap_or(Value::Null)]
            } else {
                match finding.params.get("allowedValues") {
                    Some(Value::Array(items)) => items.clone(),
                    _ => return Some(finding.clone()),
                }
            };
            let agrees = allowed.iter().any(|allowed| match written {
                Some(written) => self.agrees(written, &json_value(allowed), path),
                None => false,
            });
            return if agrees { None } else { Some(finding.clone()) };
        }
        let Some(CelValue::List(items)) = written else { return Some(finding.clone()) };
        let items: Vec<CelValue> = items.iter().cloned().collect();
        let (j, i) = self.written_duplicate(&items, path)?;
        let mut kept = finding.clone();
        kept.params = serde_json::json!({ "i": i, "j": j });
        kept.message = format!("must NOT have duplicate items (items ## {j} and {i} are identical)");
        Some(kept)
    }

    fn holds_stand_in(&self, path: &str) -> bool {
        let mut holders = self.holders.borrow_mut();
        let holders = holders.get_or_insert_with(|| {
            let mut out = HashSet::new();
            for pointer in self.stand_ins.keys() {
                let mut end = pointer.rfind('/');
                while let Some(cut) = end {
                    let parent = &pointer[..cut];
                    if !out.insert(parent.to_string()) {
                        break;
                    }
                    end = parent.rfind('/');
                }
            }
            out
        });
        holders.contains(path)
    }

    /// A canonical rendering of a value as written, or `None` when it has none.
    fn written_key(&self, value: &CelValue, path: &str) -> Option<String> {
        if let Some(stand_in) = self.stand_ins.get(path) {
            let identity = stand_in.identity.as_ref()?;
            return identity
                .repeatable()
                .then(|| format!("!{}{}", json_stringify(Some(&Value::String(identity.tag.clone()))), json_stringify(Some(&Value::String(identity.text.clone())))));
        }
        if let CelValue::List(items) = value {
            let mut parts = Vec::new();
            for (i, item) in items.iter().enumerate() {
                parts.push(self.written_key(item, &format!("{path}/{i}"))?);
            }
            return Some(format!("[{}]", parts.join(",")));
        }
        if let Some(mut entries) = members(value) {
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let mut parts = Vec::new();
            for (name, member) in entries {
                let key = self.written_key(member, &format!("{path}/{}", escape_segment(&name)))?;
                parts.push(format!("{}:{key}", json_stringify(Some(&Value::String(name)))));
            }
            return Some(format!("{{{}}}", parts.join(",")));
        }
        Some(match value {
            CelValue::String(text) => json_stringify(Some(&Value::String(text.to_string()))),
            CelValue::Null => "object:null".into(),
            CelValue::Bool(b) => format!("boolean:{b}"),
            CelValue::Double(d) => format!("number:{}", es_number(*d)),
            CelValue::Int(i) => format!("bigint:{i}"),
            CelValue::Uint(u) => format!("bigint:{u}"),
            _ => {
                // An instance is equal only to itself.
                let id = self.next_instance.get();
                self.next_instance.set(id + 1);
                format!("@{id}")
            }
        })
    }

    /// The last two items of `written` equal as written.
    fn written_duplicate(&self, written: &[CelValue], path: &str) -> Option<(usize, usize)> {
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut pair = None;
        for (i, item) in written.iter().enumerate() {
            let Some(key) = self.written_key(item, &format!("{path}/{i}")) else { continue };
            if let Some(earlier) = seen.get(&key) {
                pair = Some((*earlier, i));
            }
            seen.insert(key, i);
        }
        pair
    }

    /// Whether `allowed` is what `written` could become.
    fn agrees(&self, written: &CelValue, allowed: &CelValue, path: &str) -> bool {
        match self.stand_ins.get(path).map(|s| s.class) {
            Some(StandInClass::Computed) => return true,
            Some(StandInClass::Produced) => return kind_of(written) == kind_of(allowed),
            None => {}
        }
        if let CelValue::List(items) = written {
            let CelValue::List(other) = allowed else { return false };
            return items.len() == other.len()
                && items.iter().zip(other.iter()).enumerate().all(|(i, (w, a))| self.agrees(w, a, &format!("{path}/{i}")));
        }
        match (members(written), members(allowed)) {
            (Some(x), Some(y)) => {
                x.len() == y.len()
                    && x.iter().all(|(key, w)| {
                        y.iter().find(|(k, _)| k == key).is_some_and(|(_, a)| self.agrees(w, a, &format!("{path}/{}", escape_segment(key))))
                    })
            }
            _ => same_value(written, allowed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentinel(engine: &str, source: &str) -> Value {
        telo_templating::make_tagged_sentinel(engine, source)
    }

    #[test]
    fn a_tag_is_read_by_its_engine_s_compile_contract() {
        let class = |value: &Value| match read_stand_in(value).expect("the tag compiles") {
            Some(StandInReading::StandIn { stand_in, .. }) => Some(stand_in.class),
            _ => None,
        };
        assert_eq!(class(&sentinel("cel", "variables.port")), Some(StandInClass::Computed));
        assert_eq!(class(&sentinel("interpolate", "port ${{ variables.port }}")), Some(StandInClass::Produced));
        assert!(matches!(read_stand_in(&sentinel("literal", "${{")), Ok(Some(StandInReading::Value(_)))));
        assert!(matches!(read_stand_in(&sentinel("ref", "server")), Ok(None)));
        assert!(matches!(read_stand_in(&serde_json::json!("plain")), Ok(None)));
    }
}
