//! What a union's branches say about WHICH of them a value is: its candidates, its tags
//! and its selectors, read from the schema and the value's JSON type at the union's node
//! alone. Mirrors `../../nodejs/src/union-tags.ts`.
//!
//! A branch is a CANDIDATE when its own schema does not refuse the value's JSON type at
//! the node. A TAG is a place below the node every candidate constrains by `const` /
//! `enum` in its own schema — reached through `$ref`, `allOf` and `properties` — read only
//! with at least two candidates. A SELECTOR is a member one step below the node that is
//! required at the node and constrained by `const` / `enum` in a candidate's own schema
//! without being a tag.

use std::collections::HashSet;
use std::sync::Arc;

use telorun_cel::JsonValue;
use telorun_cel_value::CelValue;

/// What a `$ref` written in a node names: the node it resolves to, through the reader the
/// validator compiles with, or `None`.
pub type ReferenceReader<'a> = dyn Fn(&Arc<JsonValue>, &str) -> Option<Arc<JsonValue>> + 'a;

/// A `$ref` the reader could not follow: the union cannot be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnreadableReference(pub String);

/// The JSON type of a value: an integral number is `integer`, which also satisfies
/// `number`, and an instance value is an object.
pub fn json_type_of(value: Option<&CelValue>) -> &'static str {
    match value {
        None | Some(CelValue::Null) => "null",
        Some(CelValue::List(_)) => "array",
        Some(CelValue::Int(_)) | Some(CelValue::Uint(_)) => "integer",
        Some(CelValue::Double(d)) => {
            if d.is_finite() && d.trunc() == *d {
                "integer"
            } else {
                "number"
            }
        }
        Some(CelValue::String(_)) => "string",
        Some(CelValue::Bool(_)) => "boolean",
        Some(_) => "object",
    }
}

fn id(node: &Arc<JsonValue>) -> usize {
    Arc::as_ptr(node) as usize
}

fn object(node: &JsonValue) -> Option<&telorun_cel_value::PropertyMap<Arc<JsonValue>>> {
    match node {
        JsonValue::Object(map) => Some(map),
        _ => None,
    }
}

fn admits(declared: &JsonValue, json_type: &str) -> bool {
    let names: Vec<&JsonValue> = match declared {
        JsonValue::Array(items) => items.iter().map(|item| &**item).collect(),
        other => vec![other],
    };
    names.iter().any(|name| matches!(name, JsonValue::String(n) if n == json_type || (n == "number" && json_type == "integer")))
}

fn followed(node: &Arc<JsonValue>, read: &ReferenceReader<'_>) -> Result<Option<Arc<JsonValue>>, UnreadableReference> {
    let Some(JsonValue::String(reference)) = object(node).and_then(|map| map.get("$ref")).map(|r| &**r) else { return Ok(None) };
    match read(node, reference) {
        Some(target) if object(&target).is_some() => Ok(Some(target)),
        _ => Err(UnreadableReference(reference.clone())),
    }
}

fn list<'n>(node: &'n Arc<JsonValue>, keyword: &str) -> Option<&'n Vec<Arc<JsonValue>>> {
    match object(node)?.get(keyword).map(|v| &**v) {
        Some(JsonValue::Array(items)) => Some(items),
        _ => None,
    }
}

/// Whether `branch`'s own schema refuses a value of JSON type `json_type` at its node.
pub fn refuses_json_type(branch: &Arc<JsonValue>, json_type: &str, read: &ReferenceReader<'_>) -> Result<bool, UnreadableReference> {
    fn visit(node: &Arc<JsonValue>, json_type: &str, read: &ReferenceReader<'_>, seen: &mut HashSet<usize>) -> Result<bool, UnreadableReference> {
        if matches!(**node, JsonValue::Bool(false)) {
            return Ok(true);
        }
        let Some(map) = object(node) else { return Ok(false) };
        if !seen.insert(id(node)) {
            return Ok(false);
        }
        if let Some(declared) = map.get("type") {
            if !admits(declared, json_type) {
                return Ok(true);
            }
        }
        if let Some(target) = followed(node, read)? {
            if visit(&target, json_type, read, seen)? {
                return Ok(true);
            }
        }
        if let Some(all) = list(node, "allOf") {
            for member in all {
                if visit(member, json_type, read, seen)? {
                    return Ok(true);
                }
            }
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(alternatives) = list(node, keyword).filter(|a| !a.is_empty()) {
                let mut every = true;
                for member in alternatives {
                    if !visit(member, json_type, read, &mut seen.clone())? {
                        every = false;
                        break;
                    }
                }
                if every {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    visit(branch, json_type, read, &mut HashSet::new())
}

fn escape_segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// The places below its node that `branch`'s own schema constrains by `const` / `enum`, as
/// JSON Pointers relative to the node, in the order first met.
pub fn constrained_places(branch: &Arc<JsonValue>, read: &ReferenceReader<'_>) -> Result<Vec<String>, UnreadableReference> {
    fn visit(node: &Arc<JsonValue>, at: &str, read: &ReferenceReader<'_>, seen: &mut HashSet<usize>, places: &mut Vec<String>) -> Result<(), UnreadableReference> {
        let Some(map) = object(node) else { return Ok(()) };
        if !seen.insert(id(node)) {
            return Ok(());
        }
        let enumerated = matches!(map.get("enum").map(|e| &**e), Some(JsonValue::Array(_)));
        if !at.is_empty() && (map.contains_key("const") || enumerated) && !places.iter().any(|p| p == at) {
            places.push(at.to_string());
        }
        if let Some(target) = followed(node, read)? {
            visit(&target, at, read, seen, places)?;
        }
        if let Some(all) = list(node, "allOf") {
            for member in all {
                visit(member, at, read, seen, places)?;
            }
        }
        if let Some(properties) = map.get("properties").and_then(|p| object(p).map(|m| m.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<Vec<_>>())) {
            for (key, child) in properties {
                visit(&child, &format!("{at}/{}", escape_segment(&key)), read, &mut seen.clone(), places)?;
            }
        }
        Ok(())
    }
    let mut places = Vec::new();
    visit(branch, "", read, &mut HashSet::new(), &mut places)?;
    Ok(places)
}

/// The members one step below its node that `branch`'s own schema constrains by `const` /
/// `enum` AND requires, with `holder`'s own `required` counted as the branch's.
fn selected_members(branch: &Arc<JsonValue>, holder: Option<&Arc<JsonValue>>, read: &ReferenceReader<'_>) -> Result<Vec<String>, UnreadableReference> {
    fn collect(node: &Arc<JsonValue>, read: &ReferenceReader<'_>, seen: &mut HashSet<usize>, required: &mut HashSet<String>) -> Result<(), UnreadableReference> {
        if object(node).is_none() || !seen.insert(id(node)) {
            return Ok(());
        }
        for name in list(node, "required").into_iter().flatten() {
            if let JsonValue::String(name) = &**name {
                required.insert(name.clone());
            }
        }
        if let Some(target) = followed(node, read)? {
            collect(&target, read, seen, required)?;
        }
        if let Some(all) = list(node, "allOf") {
            for member in all {
                collect(member, read, seen, required)?;
            }
        }
        Ok(())
    }
    let mut required = HashSet::new();
    collect(branch, read, &mut HashSet::new(), &mut required)?;
    if let Some(holder) = holder {
        for name in list(holder, "required").into_iter().flatten() {
            if let JsonValue::String(name) = &**name {
                required.insert(name.clone());
            }
        }
    }
    let mut members = Vec::new();
    for place in constrained_places(branch, read)? {
        let segments: Vec<&str> = place.split('/').collect();
        if segments.len() != 2 {
            continue;
        }
        let name = segments[1].replace("~1", "/").replace("~0", "~");
        if required.contains(&name) && !members.contains(&place) {
            members.push(place);
        }
    }
    Ok(members)
}

/// What a union's branches say of a value of one JSON type.
#[derive(Clone, Debug, Default)]
pub struct UnionReading {
    /// Per branch, whether it is a candidate.
    pub candidate: Vec<bool>,
    /// The tags, relative to the union's node, in the first candidate's order.
    pub tags: Vec<String>,
    /// The selectors, relative to the union's node: never a tag.
    pub selectors: Vec<String>,
}

/// The candidates, tags and selectors of the union `branches`, held by `holder`, for a
/// value of JSON type `json_type`.
pub fn read_union(
    branches: &[Arc<JsonValue>],
    json_type: &str,
    read: &ReferenceReader<'_>,
    holder: Option<&Arc<JsonValue>>,
) -> Result<UnionReading, UnreadableReference> {
    let candidate = branches.iter().map(|branch| refuses_json_type(branch, json_type, read).map(|r| !r)).collect::<Result<Vec<_>, _>>()?;
    let open: Vec<&Arc<JsonValue>> = branches.iter().zip(&candidate).filter(|(_, c)| **c).map(|(b, _)| b).collect();
    if open.len() < 2 {
        return Ok(UnionReading { candidate, tags: Vec::new(), selectors: Vec::new() });
    }
    let places = open.iter().map(|branch| constrained_places(branch, read)).collect::<Result<Vec<_>, _>>()?;
    let tags: Vec<String> = places[0].iter().filter(|place| places[1..].iter().all(|other| other.contains(place))).cloned().collect();
    let mut selectors = Vec::new();
    for branch in open {
        for place in selected_members(branch, holder, read)? {
            if !tags.contains(&place) && !selectors.contains(&place) {
                selectors.push(place);
            }
        }
    }
    Ok(UnionReading { candidate, tags, selectors })
}
