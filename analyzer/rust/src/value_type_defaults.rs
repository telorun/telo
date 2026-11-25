//! A `default:` at a slot whose value type is held as an instance, filled decoded before
//! a validator fills defaults of its own. Mirrors `../../nodejs/src/value-type-defaults.ts`
//! (`valueTypeDefaultFiller`, `decodedSchemaDefault`), the decoding walk of
//! `plain-literal-decoding.ts` it runs a default through (`decodePlainLiterals`), and the
//! members half of that file's `mapTextLeaves`, which the kernel builds a value of a type
//! with members through.
//!
//! A validator writes a `default:` as the JSON it is, which the value type's assertion
//! refuses (a duration's `"5s"` is text). So a default beneath a node that holds an
//! instance is decoded first — through the value type's own encoding, or its integer
//! form, or an object of its members — and written where the value leaves the key out.

use std::collections::HashSet;

use serde_json::{Map, Value};
use telorun_cel_value::{CelHostValue, CelList, CelRecord, CelValue};
use telorun_sdk_core::plain_encoding::{base64url, cel_duration, rfc3339, url_text, PLAIN_ENCODINGS};
use telorun_sdk_core::value_type::{is_instance_slot, value_type_of};

use crate::members_value_slot::{members_slot_of, settles_at, MembersSlot};
use crate::schema_compat::{collect_properties, resolve_ref_in, select_union_branch, ExternalSchemaResolver};
use crate::schema_opaque_value::is_safe_integer;

#[derive(Clone)]
struct Part {
    schema: Value,
    root: Value,
}

fn is_schema_object(node: &Value) -> bool {
    node.is_object()
}

fn resolved(schema: &Value, root: &Value, external: Option<&ExternalSchemaResolver<'_>>) -> Part {
    let (schema, root) = resolve_ref_in(schema, root, external);
    Part { schema: schema.clone(), root: root.clone() }
}

/// `expand`: a node with every `$ref` and `allOf` member it reaches.
fn expand(start: &Part, external: Option<&ExternalSchemaResolver<'_>>) -> Vec<Part> {
    let mut parts: Vec<Part> = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    let mut pending = vec![start.clone()];
    while let Some(part) = pending.pop() {
        if seen.contains(&part.schema) {
            continue;
        }
        seen.push(part.schema.clone());
        let mut next = Vec::new();
        if part.schema.get("$ref").is_some_and(Value::is_string) {
            let target = resolved(&part.schema, &part.root, external);
            if target.schema != part.schema {
                next.push(target);
            }
        }
        for member in part.schema.get("allOf").and_then(Value::as_array).into_iter().flatten() {
            if is_schema_object(member) {
                next.push(Part { schema: member.clone(), root: part.root.clone() });
            }
        }
        parts.push(part);
        // Depth first, in written order, as the Node visit recurses.
        pending.extend(next.into_iter().rev());
    }
    parts
}

/// Whether `step` finds what it looks for anywhere reachable from `start`.
fn reachable(start: &Part, step: &dyn Fn(&Part) -> (bool, Vec<Part>)) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    let mut pending = vec![start.clone()];
    while let Some(part) = pending.pop() {
        if !seen.insert(part.schema.to_string()) {
            continue;
        }
        let (found, next) = step(&part);
        if found {
            return true;
        }
        pending.extend(next);
    }
    false
}

fn holds_instance(part: &Part, external: Option<&ExternalSchemaResolver<'_>>) -> bool {
    reachable(part, &|part| {
        let s = &part.schema;
        let mut children: Vec<&Value> = Vec::new();
        for key in ["properties", "patternProperties"] {
            if let Some(map) = s.get(key).and_then(Value::as_object) {
                children.extend(map.values());
            }
        }
        children.extend(s.get("items"));
        children.extend(s.get("additionalProperties"));
        for key in ["allOf", "anyOf", "oneOf"] {
            children.extend(s.get(key).and_then(Value::as_array).into_iter().flatten());
        }
        let mut next: Vec<Part> = children.into_iter().filter(|c| is_schema_object(c)).map(|c| Part { schema: c.clone(), root: part.root.clone() }).collect();
        if s.get("$ref").is_some_and(Value::is_string) {
            let target = resolved(s, &part.root, external);
            if target.schema != *s {
                next.push(target);
            }
        }
        (is_instance_slot(s), next)
    })
}

fn fills_beneath(part: &Part, external: Option<&ExternalSchemaResolver<'_>>) -> bool {
    reachable(part, &|part| {
        let mut next = Vec::new();
        let mut found = false;
        for expanded in expand(part, external) {
            for child in expanded.schema.get("properties").and_then(Value::as_object).into_iter().flat_map(Map::values) {
                if !is_schema_object(child) {
                    continue;
                }
                let at = Part { schema: child.clone(), root: expanded.root.clone() };
                if child.get("default").is_some() && holds_instance(&at, external) {
                    found = true;
                }
                next.push(at);
            }
            if let Some(items) = expanded.schema.get("items").filter(|i| is_schema_object(i)) {
                next.push(Part { schema: items.clone(), root: expanded.root.clone() });
            }
        }
        (found, next)
    })
}

/// `value` with every absent key whose slot holds an instance and declares a `default:`
/// filled with that default decoded, or `None` when the schema has no such default.
pub fn fill_value_type_defaults(value: &CelValue, schema: &Value, external: Option<&ExternalSchemaResolver<'_>>) -> Option<CelValue> {
    let top = Part { schema: schema.clone(), root: schema.clone() };
    if !fills_beneath(&top, external) {
        return None;
    }
    Some(fill(value, &top, external))
}

/// `fill`: `value` with each default beneath `part` written in. Node's walk recurses into
/// each list item and record member a default lies beneath; this one keeps a frame per
/// container on the heap, so no depth of value reaches the native stack.
fn fill(value: &CelValue, part: &Part, external: Option<&ExternalSchemaResolver<'_>>) -> CelValue {
    enum Holding {
        List { items: Vec<CelValue>, filled: Vec<CelValue> },
        Record(CelRecord),
    }
    /// A container being filled: the parts its node expands to, the part being applied,
    /// and — while a child is being filled — the child's part.
    struct Frame {
        holding: Holding,
        parts: Vec<Part>,
        part: usize,
        keys: Option<Vec<String>>,
        index: usize,
        child: Option<Part>,
    }
    let open = |value: &CelValue, part: &Part| -> Result<Frame, CelValue> {
        let holding = match value {
            CelValue::List(items) => Holding::List { items: items.iter().cloned().collect(), filled: Vec::new() },
            CelValue::Record(record) => Holding::Record(record.clone()),
            other => return Err(other.clone()),
        };
        Ok(Frame { holding, parts: expand(part, external), part: 0, keys: None, index: 0, child: None })
    };
    let mut frames = match open(value, part) {
        Ok(frame) => vec![frame],
        Err(leaf) => return leaf,
    };
    let mut answer: Option<CelValue> = None;
    loop {
        let Frame { holding, parts, part, keys, index, child } = frames.last_mut().expect("a container being filled");
        // The next child to fill under `child`, or the container filled.
        let next: Result<CelValue, CelValue> = match holding {
            Holding::List { items, filled } => loop {
                if let Some(done) = answer.take() {
                    filled.push(done);
                    *index += 1;
                }
                if child.is_none() {
                    let Some(expanded) = parts.get(*part) else { break Err(CelValue::List(std::mem::take(items).into_iter().collect::<CelList>())) };
                    let at = expanded
                        .schema
                        .get("items")
                        .filter(|i| is_schema_object(i))
                        .map(|schema| Part { schema: schema.clone(), root: expanded.root.clone() })
                        .filter(|at| fills_beneath(at, external));
                    match at {
                        Some(at) => {
                            *child = Some(at);
                            *index = 0;
                            filled.clear();
                        }
                        None => {
                            *part += 1;
                            continue;
                        }
                    }
                }
                match items.get(*index) {
                    Some(item) => break Ok(item.clone()),
                    None => {
                        *items = std::mem::take(filled);
                        *child = None;
                        *part += 1;
                    }
                }
            },
            Holding::Record(record) => loop {
                if let Some(done) = answer.take() {
                    let key = &keys.as_ref().expect("the keys being filled")[*index];
                    record.insert(key.as_str(), done);
                    *child = None;
                    *index += 1;
                }
                let Some(expanded) = parts.get(*part) else { break Err(CelValue::Record(std::mem::take(record))) };
                let Some(properties) = expanded.schema.get("properties").and_then(Value::as_object) else {
                    *part += 1;
                    continue;
                };
                let names = keys.get_or_insert_with(|| properties.keys().cloned().collect());
                let Some(key) = names.get(*index) else {
                    *keys = None;
                    *index = 0;
                    *part += 1;
                    continue;
                };
                let schema = &properties[key.as_str()];
                if !is_schema_object(schema) {
                    *index += 1;
                    continue;
                }
                let at = Part { schema: schema.clone(), root: expanded.root.clone() };
                if record.get(key).is_none() && schema.get("default").is_some() && holds_instance(&at, external) {
                    record.insert(key.as_str(), decoded_schema_default(schema, external, &expanded.root));
                }
                if let Some(held) = record.get(key).cloned() {
                    if fills_beneath(&at, external) {
                        *child = Some(at);
                        break Ok(held);
                    }
                }
                *index += 1;
            },
        };
        match next {
            Ok(value) => {
                let at = frames.last().and_then(|frame| frame.child.as_ref()).expect("the child's part");
                match open(&value, at) {
                    Ok(frame) => frames.push(frame),
                    Err(leaf) => answer = Some(leaf),
                }
            }
            Err(filled) => {
                frames.pop();
                if frames.is_empty() {
                    return filled;
                }
                answer = Some(filled);
            }
        }
    }
}

/// `decodedSchemaDefault`: a node's `default:` read as its literal is.
pub fn decoded_schema_default(node: &Value, external: Option<&ExternalSchemaResolver<'_>>, root: &Value) -> CelValue {
    let written = node.get("default").cloned().unwrap_or(Value::Null);
    decode_plain_literals(&written, &[Part { schema: node.clone(), root: root.clone() }], external)
}

fn expand_for(node: &Value, raw: &Part, external: Option<&ExternalSchemaResolver<'_>>) -> Vec<Part> {
    let entered = resolved(&raw.schema, &raw.root, external);
    let selected = select_union_branch(&entered.schema, node, &entered.root, external).into_owned();
    let here = resolved(&selected, &entered.root, external);
    conjuncts(&here, node, external).unwrap_or_else(|| vec![here])
}

/// `schemaConjuncts`: a node and each `allOf` member, recursively, every member read in
/// its parent's context through its references and union — or `None` when a member
/// cannot be read.
fn conjuncts(part: &Part, node: &Value, external: Option<&ExternalSchemaResolver<'_>>) -> Option<Vec<Part>> {
    let mut out = vec![part.clone()];
    let Some(all) = part.schema.get("allOf").and_then(Value::as_array) else { return Some(out) };
    for member in all {
        if !member.is_object() {
            return None;
        }
        let read = resolved(member, &part.root, external);
        if read.schema.get("$ref").is_some_and(Value::is_string) {
            return None;
        }
        let branch = select_union_branch(&read.schema, node, &read.root, external).into_owned();
        out.extend(conjuncts(&resolved(&branch, &read.root, external), node, external)?);
    }
    Some(out)
}

fn decode_text(schema: &Value, text: &str) -> CelValue {
    let decoded = value_type_of(schema).filter(|entry| !entry.live).and_then(|entry| {
        let encoding = PLAIN_ENCODINGS.iter().find(|e| Some(e.name) == entry.encoding.as_deref())?;
        Some(match encoding.name {
            "base64url" => CelValue::Bytes(base64url::decode(text)?.into()),
            "rfc3339" => CelValue::Timestamp(rfc3339::decode(text)?.into()),
            "cel-duration" => CelValue::Duration(cel_duration::decode(text)?.into()),
            "url-text" => CelValue::Host(CelHostValue::named(url_text::URL_TYPE_KEY, std::sync::Arc::new(url_text::read(text).ok()?)).ok()?),
            _ => return None,
        })
    });
    decoded.unwrap_or_else(|| CelValue::String(text.into()))
}

fn decode_integer(schema: &Value, value: f64) -> CelValue {
    let decoded = value_type_of(schema).filter(|entry| entry.integer_unit.is_some() && is_safe_integer(value)).and_then(|entry| {
        let text = format!("{}{}", telorun_cel_value::es_number(value), entry.integer_unit.as_deref()?);
        match decode_text(schema, &text) {
            CelValue::String(_) => None,
            decoded => Some(decoded),
        }
    });
    decoded.unwrap_or(CelValue::Double(value))
}

/// `composeLiteralMembers`: an object of a members type's members, built.
fn compose_members(schema: &Value, record: &Map<String, Value>) -> Option<CelValue> {
    let entry = value_type_of(schema)?;
    entry.members.as_ref()?;
    if entry.encoding.as_deref() != Some("url-text") || entry.binding.is_none() {
        return None;
    }
    let url = url_text::compose(record).ok()?;
    Some(CelValue::Host(CelHostValue::named(url_text::URL_TYPE_KEY, std::sync::Arc::new(url)).ok()?))
}

/// `decodePlainLiterals(value, schema)`: a written literal with every leaf at an instance
/// slot decoded, read against `schema` as its own root.
pub fn decode_plain_literal(value: &Value, schema: &Value) -> CelValue {
    decode_plain_literals(value, &[Part { schema: schema.clone(), root: schema.clone() }], None)
}

/// `decodePlainLiterals`: a written literal with every leaf at an instance slot decoded.
fn decode_plain_literals(node: &Value, raw: &[Part], external: Option<&ExternalSchemaResolver<'_>>) -> CelValue {
    let parts: Vec<Part> = raw.iter().flat_map(|part| expand_for(node, part, external)).collect();
    let slot = parts.iter().find(|part| value_type_of(&part.schema).is_some()).or(parts.first()).cloned().unwrap_or(Part { schema: Value::Object(Map::new()), root: Value::Null });
    match node {
        Value::String(text) => return decode_text(&slot.schema, text),
        Value::Number(n) => return decode_integer(&slot.schema, n.as_f64().unwrap_or(f64::NAN)),
        Value::Null => return CelValue::Null,
        Value::Bool(b) => return CelValue::Bool(*b),
        _ => {}
    }
    if parts.iter().any(|part| part.schema.get("x-telo-ref").is_some()) {
        return plain(node);
    }
    match node {
        Value::Array(items) => {
            let mut each: Vec<Part> = parts
                .iter()
                .filter(|part| part.schema.get("items").is_some_and(Value::is_object))
                .map(|part| Part { schema: part.schema["items"].clone(), root: part.root.clone() })
                .collect();
            if each.is_empty() {
                each.push(Part { schema: Value::Object(Map::new()), root: slot.root.clone() });
            }
            CelValue::List(items.iter().map(|item| decode_plain_literals(item, &each, external)).collect::<CelList>())
        }
        Value::Object(entries) => {
            if let Some(built) = compose_members(&slot.schema, entries) {
                return built;
            }
            let mut record = CelRecord::new();
            for (key, item) in entries {
                let children: Vec<Part> = parts
                    .iter()
                    .filter_map(|part| {
                        let additional = part.schema.get("additionalProperties").filter(|a| a.is_object()).cloned();
                        let child = collect_properties(&part.schema).get(key).cloned().or(additional)?;
                        Some(Part { schema: child, root: part.root.clone() })
                    })
                    .collect();
                let value = if children.is_empty() { plain(item) } else { decode_plain_literals(item, &children, external) };
                record.insert(key.as_str(), value);
            }
            CelValue::Record(record)
        }
        _ => plain(node),
    }
}

/// The members half of `mapTextLeaves`, as `buildMembersValues` walks a value: `settle` is
/// handed each value a slot whose value type declares members holds — text, a record of
/// members or a value of the type — with the slot's schema node and the value's JSON
/// Pointer, and answers what stands there instead. `written` is the value as plain JSON,
/// which chooses each union's branch; the walk stops at a reference slot.
pub fn map_members_slots(
    written: &Value,
    value: &CelValue,
    schema: &Value,
    settle: &mut dyn FnMut(&Value, &MembersSlot, &CelValue, &str) -> CelValue,
) -> CelValue {
    walk_members(written, value, &[Part { schema: schema.clone(), root: schema.clone() }], "", settle)
}

fn walk_members(
    written: &Value,
    value: &CelValue,
    raw: &[Part],
    pointer: &str,
    settle: &mut dyn FnMut(&Value, &MembersSlot, &CelValue, &str) -> CelValue,
) -> CelValue {
    let parts: Vec<Part> = raw.iter().flat_map(|part| expand_for(written, part, None)).collect();
    let Some(slot) = parts.iter().find(|part| value_type_of(&part.schema).is_some()).or(parts.first()) else { return value.clone() };
    if let Some(members) = members_slot_of(&slot.schema).filter(|members| settles_at(members, value)) {
        return settle(&slot.schema, &members, value, pointer);
    }
    if parts.iter().any(|part| part.schema.get("x-telo-ref").is_some()) {
        return value.clone();
    }
    match value {
        CelValue::List(items) => {
            let mut each: Vec<Part> = parts
                .iter()
                .filter(|part| part.schema.get("items").is_some_and(Value::is_object))
                .map(|part| Part { schema: part.schema["items"].clone(), root: part.root.clone() })
                .collect();
            if each.is_empty() {
                each.push(Part { schema: Value::Object(Map::new()), root: slot.root.clone() });
            }
            let held = written.as_array();
            CelValue::List(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| {
                        let written = held.and_then(|held| held.get(i)).unwrap_or(&Value::Null);
                        walk_members(written, item, &each, &format!("{pointer}/{i}"), settle)
                    })
                    .collect::<CelList>(),
            )
        }
        CelValue::Record(record) => {
            let mut out = record.clone();
            for (key, item) in record.iter() {
                let children: Vec<Part> = parts
                    .iter()
                    .filter_map(|part| {
                        let additional = part.schema.get("additionalProperties").filter(|a| a.is_object()).cloned();
                        let child = collect_properties(&part.schema).get(key).cloned().or(additional)?;
                        Some(Part { schema: child, root: part.root.clone() })
                    })
                    .collect();
                if children.is_empty() {
                    continue;
                }
                let written = written.get(key).unwrap_or(&Value::Null);
                let escaped = key.replace('~', "~0").replace('/', "~1");
                out.insert(key, walk_members(written, item, &children, &format!("{pointer}/{escaped}"), settle));
            }
            CelValue::Record(out)
        }
        other => other.clone(),
    }
}

/// A JSON literal as the plain value JavaScript holds: every number a double.
fn plain(node: &Value) -> CelValue {
    match node {
        Value::Null => CelValue::Null,
        Value::Bool(b) => CelValue::Bool(*b),
        Value::Number(n) => CelValue::Double(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => CelValue::String(s.as_str().into()),
        Value::Array(items) => CelValue::List(items.iter().map(plain).collect::<CelList>()),
        Value::Object(map) => {
            let mut record = CelRecord::new();
            for (k, v) in map {
                record.insert(k.as_str(), plain(v));
            }
            CelValue::Record(record)
        }
    }
}
