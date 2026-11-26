//! The engine's verdicts as a site reports them — `cel/verdict-wording.ts`: one finding per
//! member read, worded from the read as written and from the schema node the verdict names.
//!
//! The engine judges every member read, operand and nullable read; this only phrases them.
//! A read the engine refuses in several branches of a union is one finding listing what
//! every branch declares. A refused member is named by its whole chain with the members the
//! node declares, unless it is declared absent; a nullable read by the value and the member read off it; a member read
//! off a stream by the stream and how to read one. Any other
//! verdict, and one whose read or node cannot be named, keeps the engine's own words.

use std::collections::{HashMap, HashSet};

use serde_json::json;
use telorun_cel::{walk_tree, CelCheckCode, CelCheckDiagnostic, CelNode, JsonValue, SchemaDependency, SourceRange};
use telorun_sdk_core::value_type::members_of;

use crate::cel::analyze::member_read_path;

pub fn worded_verdicts(source: &str, ast: &CelNode, diagnostics: &[CelCheckDiagnostic]) -> Vec<CelCheckDiagnostic> {
    let mut order: Vec<(CelCheckCode, SourceRange)> = Vec::new();
    let mut groups: HashMap<(CelCheckCode, SourceRange), Vec<&CelCheckDiagnostic>> = HashMap::new();
    for diagnostic in diagnostics {
        let key = (diagnostic.code, diagnostic.range);
        groups.entry(key).or_insert_with(|| {
            order.push(key);
            Vec::new()
        });
        groups.get_mut(&key).expect("held").push(diagnostic);
    }
    let mut selects: HashMap<SourceRange, &CelNode> = HashMap::new();
    let mut indexes: HashMap<SourceRange, &CelNode> = HashMap::new();
    for node in walk_tree(ast) {
        match node {
            CelNode::Select(select) => {
                selects.insert(select.field_range, node);
            }
            CelNode::Index(index) => {
                indexes.insert(index.range, node);
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for key in order {
        let group = &groups[&key];
        let first = group[0];
        let select = if first.code == CelCheckCode::TypeError { None } else { selects.get(&first.range).copied() };
        let index = if first.code == CelCheckCode::NullableAccess && select.is_none() {
            indexes.get(&first.range).copied()
        } else {
            None
        };
        let stream_read = if first.code == CelCheckCode::TypeError && is_stream(first.schema_node.as_ref()) {
            selects.get(&first.range).copied()
        } else {
            None
        };
        let message = match (first.code, select.or(index)) {
            (CelCheckCode::UnknownField, Some(read)) if select.is_some() => unknown_member_message(read, group),
            (CelCheckCode::NullableAccess, Some(read)) => Some(nullable_read_message(source, read)),
            _ => stream_read.map(|read| stream_read_message(source, read)),
        };
        if let Some(message) = message {
            out.push(CelCheckDiagnostic { message, ..first.clone() });
            continue;
        }
        let mut seen: HashSet<&str> = HashSet::new();
        for diagnostic in group {
            if seen.insert(diagnostic.message.as_str()) {
                out.push((*diagnostic).clone());
            }
        }
    }
    out
}

fn unknown_member_message(read: &CelNode, group: &[&CelCheckDiagnostic]) -> Option<String> {
    let path = member_read_path(read)?;
    // A member whose schema admits no value is declared, not missing: the engine's words say
    // so and name the presence read that reads it.
    if group.iter().any(|diagnostic| diagnostic.absent) {
        return None;
    }
    let mut available: Vec<String> = Vec::new();
    for diagnostic in group {
        for name in declared_names(diagnostic.schema_node.as_ref())? {
            if !available.contains(&name) {
                available.push(name);
            }
        }
    }
    // A member some branch declares is read through a union: the engine's words name `.?`.
    if let CelNode::Select(select) = read {
        if available.iter().any(|name| *name == *select.field) {
            return None;
        }
    }
    let listed = if available.is_empty() { "none".to_string() } else { available.join(", ") };
    Some(format!("'{path}' is not defined (available: {listed})"))
}

/// The member names the node a verdict was judged at declares: a value type's members,
/// else its own `properties`.
fn declared_names(located: Option<&SchemaDependency>) -> Option<Vec<String>> {
    let JsonValue::Object(node) = node_at(located?)? else { return None };
    // A member only some shapes of a union declare keeps the engine's words, and so does one
    // read through an intersection, whose parts declare its members.
    if ["anyOf", "oneOf", "allOf"]
        .iter()
        .any(|keyword| matches!(node.get(*keyword).map(|held| &**held), Some(JsonValue::Array(_))))
    {
        return None;
    }
    let value_type = match node.get("x-telo-type").map(|held| &**held) {
        Some(JsonValue::String(name)) => Some(name.clone()),
        Some(JsonValue::Object(form)) => match form.get("name").map(|held| &**held) {
            Some(JsonValue::String(name)) => Some(name.clone()),
            _ => None,
        },
        _ => None,
    };
    if let Some(members) = value_type.and_then(|name| members_of(&json!({ "x-telo-type": name }))) {
        return Some(members.keys().cloned().collect());
    }
    Some(match node.get("properties").map(|held| &**held) {
        Some(JsonValue::Object(properties)) => properties.iter().map(|(name, _)| name.to_string()).collect(),
        _ => Vec::new(),
    })
}

fn nullable_read_message(source: &str, read: &CelNode) -> String {
    let (operand, access) = match read {
        CelNode::Select(select) => (&select.operand, format!(".{}", select.field)),
        CelNode::Index(index) => (&index.operand, "[index]".to_string()),
        _ => unreachable!("a nullable read is a select or an index"),
    };
    let value = utf16_slice(source, operand.range()).trim().to_string();
    format!(
        "'{value}' may be null — guard it (e.g. '{value} != null && …' or '{value} == null ? … : {value}{access}') before accessing '{access}'"
    )
}

/// Whether the node a verdict names declares a stream.
fn is_stream(located: Option<&SchemaDependency>) -> bool {
    let Some(JsonValue::Object(node)) = located.and_then(node_at) else { return false };
    let name = match node.get("x-telo-type").map(|held| &**held) {
        Some(JsonValue::String(name)) => Some(name.as_str()),
        Some(JsonValue::Object(form)) => match form.get("name").map(|held| &**held) {
            Some(JsonValue::String(name)) => Some(name.as_str()),
            _ => None,
        },
        _ => None,
    };
    name == Some("Telo.Stream")
}

fn stream_read_message(source: &str, read: &CelNode) -> String {
    let CelNode::Select(select) = read else { unreachable!("a stream read is a select") };
    let value = utf16_slice(source, select.operand.range()).trim().to_string();
    format!("'{value}' is a Telo.Stream, which holds no members: hand it to a step that consumes a stream and read that step's result")
}

/// The node `pointer` names in the document the engine read it from.
fn node_at(located: &SchemaDependency) -> Option<&JsonValue> {
    let mut current: &JsonValue = &located.document;
    if !located.pointer.is_empty() {
        for raw in located.pointer.strip_prefix('/')?.split('/') {
            let segment = raw.replace("~1", "/").replace("~0", "~");
            current = match current {
                JsonValue::Object(entries) => entries.get(segment.as_str())?,
                JsonValue::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
                _ => return None,
            };
        }
    }
    Some(current)
}

/// The text a range of UTF-16 code units spans.
fn utf16_slice(source: &str, range: SourceRange) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let start = (range.start as usize).min(units.len());
    let end = (range.end as usize).clamp(start, units.len());
    String::from_utf16_lossy(&units[start..end])
}
