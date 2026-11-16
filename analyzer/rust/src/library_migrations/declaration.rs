//! The one reader of a `Telo.Library`'s `migrations:` block: the map from a migration's
//! diagnostic code to `{ severity?, reason, rules }`, each rule a `rewrite` item. Mirrors
//! `../../../nodejs/src/library-migrations/declaration.ts`.
//!
//! The block's shape is the built-in `Telo.Library` schema's to refuse; this reader reads
//! what is well formed and leaves out a migration or a rule that is not, as Node's does.
//! Node's `handOverRules` and `removedKindNames` have no twin yet: they serve the stage,
//! which this analyzer does not run.

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use super::r#match::{as_migration_map, is_opaque_migration_value, MigrationMatch, MigrationMatchType};
use crate::system_kinds::LIBRARY;

/// The severity a migration reports with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationSeverity {
    Warning,
    Info,
    Hint,
}

/// A `move:` / `copy:` source: a pointer into the matched node, or, with `binding`, into a
/// `resolve` binding (`<binding>#<pointer>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationSource {
    pub binding: Option<String>,
    pub pointer: String,
    /// The key as written.
    pub written: String,
}

/// One positional write of a rule: the node at `from` lands at `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPlacement {
    pub from: MigrationSource,
    pub to: String,
}

/// A `resolve:` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationBinding {
    pub binding: String,
    pub at: String,
    /// The type name `before: Self.<Name>` names, without `Self.`.
    pub before: Option<String>,
}

/// A `rewrite` rule.
#[derive(Debug, Clone, PartialEq)]
pub struct MigrationRule {
    /// The rule's position in its migration's `rules:`.
    pub index: usize,
    /// The rule's dotted path in the module document (`migrations.CODE.rules[0]`).
    pub path: String,
    /// The type name `rewrite: Self.<Name>` names, without `Self.`.
    pub rewrite: String,
    pub r#match: MigrationMatch,
    pub remove: Vec<String>,
    pub r#move: Vec<MigrationPlacement>,
    pub copy: Vec<MigrationPlacement>,
    /// A partial node merged over the matched node; literals only.
    pub set: Option<Map<String, Value>>,
    pub resolve: Vec<MigrationBinding>,
}

/// One migration of a library, named by its diagnostic code.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryMigration {
    pub code: String,
    pub severity: MigrationSeverity,
    pub reason: String,
    /// The migration's dotted path in the module document (`migrations.CODE`).
    pub path: String,
    pub rules: Vec<MigrationRule>,
    /// Every type a rule of the migration names at `rewrite: Self.<Name>`, the rules this
    /// reader leaves out as malformed included.
    pub rewritten_types: IndexSet<String>,
}

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A migration's key: its diagnostic code, `<SUBJECT>_<PROBLEM>`.
pub fn is_migration_code(code: &str) -> bool {
    let mut parts = code.split('_');
    let first = parts.next().unwrap_or_default();
    let upper_or_digit = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    let first_ok = first.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && first.chars().all(upper_or_digit);
    let rest: Vec<&str> = parts.collect();
    first_ok && !rest.is_empty() && rest.iter().all(|part| !part.is_empty() && part.chars().all(upper_or_digit))
}

/// A JSON Pointer: one or more `/`-led segments, every `~` escaping `0` or `1`.
fn is_pointer_body(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.iter().enumerate().all(|(i, b)| *b != b'~' || matches!(bytes.get(i + 1), Some(b'0' | b'1')))
}

fn is_pointer(text: &str) -> bool {
    text.starts_with('/') && is_pointer_body(text)
}

/// The type name of a `Self.<Name>` spelling.
pub fn self_type_name(written: &Value) -> Option<&str> {
    let name = written.as_str()?.strip_prefix("Self.")?;
    let ok = name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some(name)
}

/// A `move:` / `copy:` source key, or `None` when it is neither form.
pub fn parse_migration_source(written: &str) -> Option<MigrationSource> {
    if is_pointer(written) {
        return Some(MigrationSource { binding: None, pointer: written.to_string(), written: written.to_string() });
    }
    let (binding, pointer) = written.split_once('#')?;
    let pointer_ok = pointer.is_empty() || is_pointer(pointer);
    (is_identifier(binding) && pointer_ok).then(|| MigrationSource {
        binding: Some(binding.to_string()),
        pointer: pointer.to_string(),
        written: written.to_string(),
    })
}

/// The segments of a JSON Pointer, unescaped.
pub fn migration_pointer_segments(pointer: &str) -> Vec<String> {
    if pointer.is_empty() {
        return Vec::new();
    }
    pointer[1..].split('/').map(|segment| segment.replace("~1", "/").replace("~0", "~")).collect()
}

fn holds_opaque(value: &Value) -> bool {
    if is_opaque_migration_value(value) {
        return true;
    }
    match value {
        Value::Array(items) => items.iter().any(holds_opaque),
        Value::Object(map) => map.values().any(holds_opaque),
        _ => false,
    }
}

const MATCH_KEYS: &[&str] = &["type", "required", "const", "enum", "properties", "items"];

/// `value` as a well-formed match, or `None`.
pub fn read_migration_match(value: &Value) -> Option<MigrationMatch> {
    let map = as_migration_map(value)?;
    if map.keys().any(|key| !MATCH_KEYS.contains(&key.as_str())) {
        return None;
    }
    let mut read = MigrationMatch::default();
    if let Some(written) = map.get("type") {
        let names: Vec<&Value> = match written {
            Value::Array(list) => list.iter().collect(),
            other => vec![other],
        };
        let types: Option<Vec<MigrationMatchType>> =
            names.iter().map(|name| name.as_str().and_then(MigrationMatchType::parse)).collect();
        read.r#type = Some(types.filter(|types| !types.is_empty())?);
    }
    if let Some(required) = map.get("required") {
        let keys: Option<Vec<String>> = required.as_array()?.iter().map(|key| key.as_str().map(str::to_string)).collect();
        read.required = Some(keys?);
    }
    if let Some(values) = map.get("enum") {
        let list = values.as_array().filter(|list| !list.is_empty())?;
        if holds_opaque(values) {
            return None;
        }
        read.r#enum = Some(list.clone());
    }
    if let Some(expected) = map.get("const") {
        if holds_opaque(expected) {
            return None;
        }
        read.r#const = Some(expected.clone());
    }
    if let Some(properties) = map.get("properties") {
        let mut members = IndexMap::new();
        for (key, member) in as_migration_map(properties)? {
            let read_member = match member {
                Value::Bool(false) => None,
                other => Some(read_migration_match(other)?),
            };
            members.insert(key.clone(), read_member);
        }
        read.properties = Some(members);
    }
    if let Some(items) = map.get("items") {
        read.items = Some(Box::new(read_migration_match(items)?));
    }
    Some(read)
}

fn read_placements(value: Option<&Value>) -> Option<Vec<MigrationPlacement>> {
    let Some(value) = value else { return Some(Vec::new()) };
    let mut placements = Vec::new();
    for (key, to) in as_migration_map(value)? {
        let from = parse_migration_source(key)?;
        let to = to.as_str().filter(|to| is_pointer(to))?;
        placements.push(MigrationPlacement { from, to: to.to_string() });
    }
    Some(placements)
}

fn read_bindings(value: Option<&Value>) -> Option<Vec<MigrationBinding>> {
    let Some(value) = value else { return Some(Vec::new()) };
    let mut bindings = Vec::new();
    for (binding, entry) in as_migration_map(value)? {
        let entry = as_migration_map(entry).filter(|_| is_identifier(binding))?;
        let at = entry.get("at").and_then(Value::as_str).filter(|at| is_pointer(at))?;
        if entry.keys().any(|key| key != "at" && key != "before") {
            return None;
        }
        let before = match entry.get("before") {
            None => None,
            Some(before) => Some(self_type_name(before)?.to_string()),
        };
        bindings.push(MigrationBinding { binding: binding.clone(), at: at.to_string(), before });
    }
    Some(bindings)
}

const RULE_KEYS: &[&str] = &["rewrite", "match", "remove", "move", "copy", "set", "resolve"];

fn read_rule(value: &Value, index: usize, path: String) -> Option<MigrationRule> {
    let rule = as_migration_map(value)?;
    if rule.keys().any(|key| !RULE_KEYS.contains(&key.as_str())) {
        return None;
    }
    let rewrite = self_type_name(rule.get("rewrite")?)?.to_string();
    let r#match = read_migration_match(rule.get("match")?)?;
    let remove: Option<Vec<String>> = match rule.get("remove") {
        None => Some(Vec::new()),
        Some(remove) => remove
            .as_array()?
            .iter()
            .map(|pointer| pointer.as_str().filter(|p| is_pointer(p)).map(str::to_string))
            .collect(),
    };
    let r#move = read_placements(rule.get("move"))?;
    let copy = read_placements(rule.get("copy"))?;
    let resolve = read_bindings(rule.get("resolve"))?;
    let set = match rule.get("set") {
        None => None,
        Some(set) => Some(as_migration_map(set).filter(|_| !holds_opaque(set))?.clone()),
    };
    Some(MigrationRule { index, path, rewrite, r#match, remove: remove?, r#move, copy, set, resolve })
}

/// The well-formed migrations a module document declares, in key order.
pub fn read_library_migrations(module_doc: &Value) -> Vec<LibraryMigration> {
    let Some(doc) = as_migration_map(module_doc) else { return Vec::new() };
    if doc.get("kind").and_then(Value::as_str) != Some(LIBRARY) {
        return Vec::new();
    }
    let Some(block) = doc.get("migrations").and_then(as_migration_map) else { return Vec::new() };
    let mut migrations = Vec::new();
    for (code, entry) in block {
        let Some(entry) = as_migration_map(entry).filter(|_| is_migration_code(code)) else { continue };
        let severity = match entry.get("severity") {
            None => MigrationSeverity::Warning,
            Some(Value::String(severity)) if severity == "warning" => MigrationSeverity::Warning,
            Some(Value::String(severity)) if severity == "info" => MigrationSeverity::Info,
            Some(Value::String(severity)) if severity == "hint" => MigrationSeverity::Hint,
            Some(_) => continue,
        };
        let Some(reason) = entry.get("reason").and_then(Value::as_str).filter(|reason| !reason.is_empty()) else {
            continue;
        };
        let Some(rules) = entry.get("rules").and_then(Value::as_array) else { continue };
        let path = format!("migrations.{code}");
        let mut read = Vec::new();
        let mut rewritten_types = IndexSet::new();
        for (index, rule) in rules.iter().enumerate() {
            if let Some(rewrite) = as_migration_map(rule).and_then(|rule| rule.get("rewrite")).and_then(self_type_name) {
                rewritten_types.insert(rewrite.to_string());
            }
            if let Some(parsed) = read_rule(rule, index, format!("{path}.rules[{index}]")) {
                read.push(parsed);
            }
        }
        migrations.push(LibraryMigration {
            code: code.clone(),
            severity,
            reason: reason.to_string(),
            path,
            rules: read,
            rewritten_types,
        });
    }
    migrations
}

/// The kind a rule writes at the root of the node it rewrites (`set: { kind: … }`), as
/// written.
pub fn root_kind_written(rule: &MigrationRule) -> Option<&str> {
    rule.set.as_ref()?.get("kind")?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_code_is_subject_and_problem_in_upper_case() {
        assert!(is_migration_code("UI_LINK_HREF_MOVED"));
        assert!(is_migration_code("A1_B2"));
        assert!(!is_migration_code("UI"));
        assert!(!is_migration_code("ui_link"));
        assert!(!is_migration_code("UI__LINK"));
        assert!(!is_migration_code("1UI_LINK"));
    }

    #[test]
    fn a_malformed_rule_is_left_out_and_its_type_still_counted() {
        let doc = json!({
            "kind": "Telo.Library",
            "migrations": {
                "UI_LINK_MOVED": {
                    "reason": "Moved.",
                    "rules": [
                        { "rewrite": "Self.Node", "match": { "required": ["href"] }, "move": { "/href": "/to/href" } },
                        { "rewrite": "Self.Box", "match": { "anyOf": [] } }
                    ]
                },
                "lowercase": { "reason": "No.", "rules": [] }
            }
        });
        let migrations = read_library_migrations(&doc);
        assert_eq!(migrations.len(), 1);
        assert_eq!(migrations[0].rules.len(), 1);
        assert_eq!(migrations[0].rules[0].path, "migrations.UI_LINK_MOVED.rules[0]");
        assert_eq!(migrations[0].rewritten_types.iter().collect::<Vec<_>>(), vec!["Node", "Box"]);
    }
}
