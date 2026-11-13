//! Reading `telo-workspace.yaml` leniently: everything it could read plus
//! everything it found wrong, each anchored at a key path. Which findings are
//! fatal is the caller's policy. These primitives read any block against its
//! declared shape.

use serde_json::{Map, Value};

use crate::marker_schema::{KeyType, WorkspaceEntrySchema, WorkspaceKeySchema};
use crate::yaml::parse_json;

pub const WORKSPACE_FILENAME: &str = "telo-workspace.yaml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSeg {
    Key(String),
    Index(usize),
}

impl From<&str> for PathSeg {
    fn from(key: &str) -> Self {
        PathSeg::Key(key.to_string())
    }
}

impl From<String> for PathSeg {
    fn from(key: String) -> Self {
        PathSeg::Key(key)
    }
}

impl From<usize> for PathSeg {
    fn from(index: usize) -> Self {
        PathSeg::Index(index)
    }
}

pub type KeyPath = Vec<PathSeg>;

/// `at.join(".")`.
pub fn join_path(at: &[PathSeg]) -> String {
    at.iter()
        .map(|seg| match seg {
            PathSeg::Key(key) => key.clone(),
            PathSeg::Index(index) => index.to_string(),
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// `[...at, seg]`.
pub fn with(at: &[PathSeg], seg: impl Into<PathSeg>) -> KeyPath {
    let mut out = at.to_vec();
    out.push(seg.into());
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceDiagnostic {
    pub code: &'static str,
    pub severity: Severity,
    pub message: String,
    /// Key path from the document root.
    pub path: KeyPath,
}

pub type MarkerReport<'a> = dyn FnMut(&'static str, String, KeyPath, Severity) + 'a;

/// The marker's root mapping, or `None` with the reason reported. A marker
/// whose whole content is comments reads as an empty mapping.
pub fn parse_marker(text: &str, at: &str, report: &mut MarkerReport<'_>) -> Option<Map<String, Value>> {
    let value = match parse_json(text) {
        Ok(value) => value,
        Err(err) => {
            report("WORKSPACE_INVALID_VALUE", format!("{at} is not valid YAML: {}", err.message), Vec::new(), Severity::Error);
            return None;
        }
    };
    match value {
        Value::Null => Some(Map::new()),
        Value::Object(map) => Some(map),
        _ => {
            report("WORKSPACE_INVALID_VALUE", format!("{at} must be a YAML mapping."), Vec::new(), Severity::Error);
            None
        }
    }
}

/// One entry of an `entry[]` list as read.
#[derive(Debug, Clone)]
pub struct ReadEntry {
    pub index: usize,
    pub bare: bool,
    pub fields: Map<String, Value>,
}

/// Read one block against its declared shape — the plain types only.
pub fn read_schema_block(
    block: &Map<String, Value>,
    properties: &[(&'static str, WorkspaceKeySchema)],
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
) -> Map<String, Value> {
    let names: Vec<&str> = properties.iter().map(|(name, _)| *name).collect();
    report_unknown_keys(block, &names, at_file, at, report);
    read_known_keys(block, properties, at_file, at, report)
}

/// The plain-typed keys of `properties` read out of `block`.
pub fn read_known_keys(
    block: &Map<String, Value>,
    properties: &[(&'static str, WorkspaceKeySchema)],
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, schema) in properties {
        if let Some(value) = read_plain_value(block.get(*name), schema, at_file, &with(at, *name), report) {
            out.insert(name.to_string(), value);
        }
    }
    out
}

fn read_plain_value(
    raw: Option<&Value>,
    schema: &WorkspaceKeySchema,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
) -> Option<Value> {
    match schema.ty {
        KeyType::String => read_string(raw, at_file, at, report).map(Value::String),
        KeyType::Boolean => read_boolean(raw, at_file, at, report).map(Value::Bool),
        KeyType::StringList => {
            read_string_list(raw, at_file, at, report).map(|list| Value::Array(list.into_iter().map(Value::String).collect()))
        }
        KeyType::EntryList => read_entries(raw, schema, at_file, at, report).map(|entries| {
            Value::Array(entries.into_iter().map(|entry| Value::Object(entry.fields)).collect())
        }),
        _ => None,
    }
}

fn present(raw: Option<&Value>) -> Option<&Value> {
    raw.filter(|value| !value.is_null())
}

/// A list whose entries are a bare string or a mapping carrying the entry's key.
pub fn read_entries(
    raw: Option<&Value>,
    schema: &WorkspaceKeySchema,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
) -> Option<Vec<ReadEntry>> {
    let raw = present(raw)?;
    let entry = schema.entry.as_ref()?;
    let name = join_path(at);
    let example = if schema.examples.is_empty() { String::new() } else { format!(", e.g. [{}]", schema.examples.join(", ")) };
    let Value::Array(items) = raw else {
        report(
            "WORKSPACE_INVALID_VALUE",
            format!("{at_file}: '{name}' must be a list, each entry a string or a mapping carrying '{}:'{example}.", entry.key),
            at.to_vec(),
            Severity::Error,
        );
        return None;
    };
    let mut entries = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let item_at = with(at, index);
        match item {
            Value::String(text) => {
                let mut fields = Map::new();
                fields.insert(entry.key.to_string(), Value::String(text.clone()));
                entries.push(ReadEntry { index, bare: true, fields });
            }
            Value::Object(fields) => {
                report_null_keys(fields, entry, at_file, &item_at, report);
                let read = read_schema_block(fields, &entry.properties, at_file, &item_at, report);
                if !read.contains_key(entry.key) {
                    if !fields.contains_key(entry.key) {
                        report(
                            "WORKSPACE_INVALID_VALUE",
                            format!("{at_file}: '{name}' entry {index} declares no '{}:', so it names nothing.", entry.key),
                            item_at,
                            Severity::Error,
                        );
                    }
                    continue;
                }
                entries.push(ReadEntry { index, bare: false, fields: read });
            }
            _ => report(
                "WORKSPACE_INVALID_VALUE",
                format!(
                    "{at_file}: '{name}' entry {index} must be a string, or a mapping carrying '{}:' plus the keys it adds.",
                    entry.key
                ),
                item_at,
                Severity::Error,
            ),
        }
    }
    Some(entries)
}

/// A key written with no value is not an absence.
pub fn report_null_keys(
    item: &Map<String, Value>,
    entry: &WorkspaceEntrySchema,
    at_file: &str,
    item_at: &[PathSeg],
    report: &mut MarkerReport<'_>,
) {
    for (key, schema) in &entry.properties {
        if !matches!(item.get(*key), Some(Value::Null)) {
            continue;
        }
        let key_name = join_path(&with(item_at, *key));
        let message = if *key == entry.key {
            format!("{at_file}: '{key_name}' has no value, so the entry names nothing.")
        } else {
            match schema.ty {
                KeyType::Boolean => format!("{at_file}: '{key_name}' must be true or false."),
                KeyType::StringList => format!("{at_file}: '{key_name}' must be a list of strings."),
                KeyType::String => format!("{at_file}: '{key_name}' must be a string."),
                _ => format!("{at_file}: '{key_name}' has no value."),
            }
        };
        report("WORKSPACE_INVALID_VALUE", message, with(item_at, *key), Severity::Error);
    }
}

pub fn report_unknown_keys(
    block: &Map<String, Value>,
    names: &[&str],
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
) {
    for key in block.keys() {
        if names.contains(&key.as_str()) {
            continue;
        }
        let near = near_miss(key, names);
        let hint = match near {
            Some(near) => format!(" Did you mean '{near}'?"),
            None => format!(" Known keys: {}.", names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ")),
        };
        report(
            "WORKSPACE_UNKNOWN_KEY",
            format!("{at_file}: unknown key '{}'.{hint}", join_path(&with(at, key.as_str()))),
            with(at, key.as_str()),
            Severity::Error,
        );
    }
}

pub fn read_string(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<String> {
    let raw = present(raw)?;
    let Value::String(text) = raw else {
        report("WORKSPACE_INVALID_VALUE", format!("{at_file}: '{}' must be a string.", join_path(at)), at.to_vec(), Severity::Error);
        return None;
    };
    if text.is_empty() {
        report("WORKSPACE_INVALID_VALUE", format!("{at_file}: '{}' is empty.", join_path(at)), at.to_vec(), Severity::Error);
        return None;
    }
    Some(text.clone())
}

pub fn read_boolean(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<bool> {
    let raw = present(raw)?;
    match raw {
        Value::Bool(flag) => Some(*flag),
        _ => {
            report("WORKSPACE_INVALID_VALUE", format!("{at_file}: '{}' must be true or false.", join_path(at)), at.to_vec(), Severity::Error);
            None
        }
    }
}

pub fn read_string_list(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<Vec<String>> {
    let raw = present(raw)?;
    let Value::Array(items) = raw else {
        report("WORKSPACE_INVALID_VALUE", format!("{at_file}: '{}' must be a list of strings.", join_path(at)), at.to_vec(), Severity::Error);
        return None;
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match item {
            Value::String(text) => out.push(text.clone()),
            _ => report(
                "WORKSPACE_INVALID_VALUE",
                format!("{at_file}: '{}' entry {index} must be a string.", join_path(at)),
                with(at, index),
                Severity::Error,
            ),
        }
    }
    Some(out)
}

/// One edit apart, case-insensitively.
pub fn near_miss<'a>(key: &str, known: &[&'a str]) -> Option<&'a str> {
    let lower: Vec<u16> = key.to_lowercase().encode_utf16().collect();
    known
        .iter()
        .copied()
        .find(|name| *name != key && edit_distance_at_most_one(&lower, &name.to_lowercase().encode_utf16().collect::<Vec<_>>()))
}

fn edit_distance_at_most_one(a: &[u16], b: &[u16]) -> bool {
    if a == b {
        return true;
    }
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut edits) = (0usize, 0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        if a.len() > b.len() {
            i += 1;
        } else if a.len() < b.len() {
            j += 1;
        } else {
            i += 1;
            j += 1;
        }
    }
    edits + (a.len() - i) + (b.len() - j) <= 1
}

/// The diagnostics anchored inside one top-level block, plus those at the root.
pub fn diagnostics_for<'a>(diagnostics: &'a [WorkspaceDiagnostic], block: &str) -> Vec<&'a WorkspaceDiagnostic> {
    diagnostics
        .iter()
        .filter(|d| d.path.is_empty() || d.path[0] == PathSeg::Key(block.to_string()))
        .collect()
}

pub fn has_error(diagnostics: &[WorkspaceDiagnostic]) -> bool {
    diagnostics.iter().any(|d| d.severity == Severity::Error)
}
