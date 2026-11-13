//! The selector half of a migration: what a rule MATCHES, as data. Mirrors
//! `../../../nodejs/src/migrations/match.ts`.
//!
//! Containment is POSITIVE and required: `inKind` names the document kinds a rule may
//! touch and `under` the top-level keys it may reach, anchored at the document root, and
//! both bound the walk rather than filter its output. `inSchema` is the one region a kind
//! list cannot name; with it, and only for an `x-telo-*` key, `inKind` / `under` may be
//! `"*"`, and a core entry's `scalar` rule may reach `"*"` too. The vocabulary is closed:
//! an unknown token is refused, never ignored.
//!
//! A value pattern is RE2, matched by the engine behind CEL's `matches`, anchored at both
//! ends so an entry never depends on its author anchoring it.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Value};
use telo_templating::{interpolation_shape, is_tagged_sentinel, InterpolationShape};
use telorun_cel::{re2_pattern, Re2Flags, Re2Program};

use crate::schema_region::is_in_schema_region;

use super::types::{MigrationEntryError, MigrationPath, PathSegment};

/// The wildcard `inKind` / `under` value.
pub const MATCH_ANY: &str = "*";

/// What an untagged string scalar holds, read by the one hole grammar every tag with
/// holes shares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarShape {
    LoneHole,
    Interpolated,
}

/// The `scalar` tokens, in the order a refusal lists them.
pub const SCALAR_SHAPES: [&str; 2] = ["lone-hole", "interpolated"];

/// Which entry surface a rule was read from: a module's rules may reach only its own kinds
/// and never a wildcard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationSurface {
    Core,
    Module,
}

/// A value pattern as written, and its program anchored at both ends.
#[derive(Debug, Clone)]
pub struct ValuePattern {
    pub source: String,
    program: Arc<Re2Program>,
}

impl ValuePattern {
    /// Whether `value` matches the pattern as a whole.
    pub fn full_match(&self, value: &str) -> bool {
        self.program.is_match(value)
    }
}

/// `match.ancestor`: a fixed suffix of the matched path, ending at the matched key, whose
/// head sits in a mapping holding `key` with the scalar `value`.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchAncestor {
    pub path: Vec<String>,
    pub key: String,
    pub value: Value,
}

/// A rule's `match` block.
#[derive(Debug, Clone)]
pub struct MigrationMatch {
    /// The mapping key this rule rewrites. Exactly one of `key` / `scalar`.
    pub key: Option<String>,
    /// An untagged string scalar whose text has this shape.
    pub scalar: Option<ScalarShape>,
    pub in_kind: Vec<String>,
    pub under: Vec<String>,
    /// The value must deep-equal this (a written `null` included).
    pub value: Option<Value>,
    pub value_one_of: Option<Vec<Value>>,
    pub value_pattern: Option<ValuePattern>,
    pub value_not_pattern: Option<ValuePattern>,
    pub with_sibling: Option<String>,
    pub not_under: Option<Vec<String>>,
    pub in_schema: bool,
    pub ancestor: Option<MatchAncestor>,
    pub without_key: Option<String>,
}

/// The keys a `match` block may hold, in the order a refusal lists them.
pub const MATCH_KEYS: [&str; 13] = [
    "key",
    "scalar",
    "inKind",
    "under",
    "value",
    "valueOneOf",
    "valuePattern",
    "valueNotPattern",
    "withSibling",
    "notUnder",
    "inSchema",
    "ancestor",
    "withoutKey",
];

/// Structural equality over JSON values, numbers compared by value as JavaScript's `===`
/// compares them — what `value` / `valueOneOf` and the patcher's "already current" ask.
pub fn deep_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| deep_equals(x, y)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| deep_equals(value, other)))
        }
        _ => a == b,
    }
}

fn require_string_list(describe: &str, raw: &Map<String, Value>, key: &str) -> Result<Vec<String>, MigrationEntryError> {
    let refused = || MigrationEntryError::new(format!("{describe}: 'match.{key}' must be a non-empty sequence of strings"));
    let items = raw.get(key).and_then(Value::as_array).filter(|items| !items.is_empty()).ok_or_else(refused)?;
    items.iter().map(|item| item.as_str().map(str::to_string).ok_or_else(refused)).collect()
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// Read a rule's `match` block, refusing anything the vocabulary does not define.
/// `describe` names the entry and rule so a failure says which.
pub fn read_migration_match(
    describe: &str,
    raw: Option<&Value>,
    surface: MigrationSurface,
) -> Result<MigrationMatch, MigrationEntryError> {
    let refuse = |detail: String| Err(MigrationEntryError::new(format!("{describe}: {detail}")));
    let Some(raw) = raw.and_then(Value::as_object) else {
        return refuse("'match' must be a mapping".into());
    };
    for key in raw.keys() {
        if !MATCH_KEYS.contains(&key.as_str()) {
            return refuse(format!("'match' has no key '{key}'. Known keys: {}.", MATCH_KEYS.join(", ")));
        }
    }
    let has = |key: &str| raw.contains_key(key);
    let by_key = has("key");
    if (!by_key && !has("scalar")) || (by_key && has("scalar")) {
        return refuse("'match' takes exactly one of 'key' or 'scalar'".into());
    }
    if by_key && non_empty_string(raw.get("key")).is_none() {
        return refuse("'match.key' must be a non-empty string".into());
    }
    let mut scalar = None;
    if !by_key {
        scalar = match raw.get("scalar").and_then(Value::as_str) {
            Some("lone-hole") => Some(ScalarShape::LoneHole),
            Some("interpolated") => Some(ScalarShape::Interpolated),
            _ => return refuse(format!("'match.scalar' must be one of {}", SCALAR_SHAPES.join(", "))),
        };
        for key in ["value", "valueOneOf", "valuePattern", "valueNotPattern", "withSibling"] {
            if has(key) {
                return refuse(format!("'match.{key}' does not apply to a 'scalar' rule"));
            }
        }
    }
    if has("value") && has("valueOneOf") {
        return refuse("'match' takes at most one of 'value' or 'valueOneOf'".into());
    }
    if has("valueOneOf") && !raw["valueOneOf"].is_array() {
        return refuse("'match.valueOneOf' must be a sequence".into());
    }
    let mut patterns = [None, None];
    for (slot, key) in ["valuePattern", "valueNotPattern"].into_iter().enumerate() {
        if !has(key) {
            continue;
        }
        if has("value") || has("valueOneOf") {
            return refuse(format!("'match.{key}' does not combine with 'value' / 'valueOneOf'"));
        }
        patterns[slot] = Some(read_value_pattern(&format!("{describe}: 'match.{key}'"), &raw[key])?);
    }
    if has("withSibling") && !raw["withSibling"].is_string() {
        return refuse("'match.withSibling' must be a string".into());
    }
    if has("notUnder") && !raw["notUnder"].as_array().is_some_and(|items| items.iter().all(Value::is_string)) {
        return refuse("'match.notUnder' must be a sequence of strings".into());
    }
    if has("inSchema") && !raw["inSchema"].is_boolean() {
        return refuse("'match.inSchema' must be a boolean".into());
    }
    if has("withoutKey") && non_empty_string(raw.get("withoutKey")).is_none() {
        return refuse("'match.withoutKey' must be a non-empty string".into());
    }
    let key = raw.get("key").and_then(Value::as_str).unwrap_or_default();
    let mut ancestor = None;
    if has("ancestor") {
        if !by_key {
            return refuse("'match.ancestor' applies only to a 'key' rule".into());
        }
        ancestor = Some(read_ancestor(describe, &raw["ancestor"], key)?);
    }

    let in_schema = raw.get("inSchema") == Some(&Value::Bool(true));
    let wildcard = ["inKind", "under"]
        .iter()
        .filter_map(|list| raw.get(*list).and_then(Value::as_array))
        .flatten()
        .any(|value| value.as_str() == Some(MATCH_ANY));
    if wildcard && !by_key {
        if surface != MigrationSurface::Core {
            return refuse(format!("a module's migration may not reach '{MATCH_ANY}' — it names only kinds it owns"));
        }
    } else if wildcard {
        if !in_schema {
            return refuse(format!(
                "'match.inKind' / 'match.under' may only be '{MATCH_ANY}' together with 'inSchema: true' — the schema region is what bounds a walk the wildcard unbounds"
            ));
        }
        if !key.starts_with("x-telo-") {
            return refuse(format!(
                "'{MATCH_ANY}' is legal only for a rule keyed on an 'x-telo-*' annotation, which is Telo vocabulary wherever it appears — '{key}' could mean something else inside a resource's own configuration"
            ));
        }
    }

    let in_kind = require_string_list(describe, raw, "inKind")?;
    let under = require_string_list(describe, raw, "under")?;
    let [value_pattern, value_not_pattern] = patterns;
    Ok(MigrationMatch {
        key: by_key.then(|| key.to_string()),
        scalar,
        in_kind,
        under,
        value: raw.get("value").cloned(),
        value_one_of: raw.get("valueOneOf").and_then(Value::as_array).cloned(),
        value_pattern,
        value_not_pattern,
        with_sibling: raw.get("withSibling").and_then(Value::as_str).map(str::to_string),
        not_under: raw
            .get("notUnder")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()),
        in_schema,
        ancestor,
        without_key: raw.get("withoutKey").and_then(Value::as_str).map(str::to_string),
    })
}

const ANCESTOR_KEYS: [&str; 3] = ["path", "key", "value"];

/// Read `match.ancestor`: a non-empty suffix of mapping keys ending at the matched key, and
/// the scalar sibling its head's mapping must hold.
fn read_ancestor(describe: &str, raw: &Value, matched_key: &str) -> Result<MatchAncestor, MigrationEntryError> {
    let refuse = |detail: String| Err(MigrationEntryError::new(format!("{describe}: {detail}")));
    let Some(raw) = raw.as_object() else {
        return refuse("'match.ancestor' must be a mapping".into());
    };
    for key in raw.keys() {
        if !ANCESTOR_KEYS.contains(&key.as_str()) {
            return refuse(format!("'match.ancestor' has no key '{key}'. Known keys: {}.", ANCESTOR_KEYS.join(", ")));
        }
    }
    let path: Option<Vec<String>> = raw
        .get("path")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .and_then(|items| items.iter().map(|item| non_empty_string(Some(item)).map(str::to_string)).collect());
    let Some(path) = path else {
        return refuse("'match.ancestor.path' must be a non-empty sequence of keys".into());
    };
    if path.last().map(String::as_str) != Some(matched_key) {
        return refuse(format!("'match.ancestor.path' must end at the matched key '{matched_key}'"));
    }
    let Some(key) = non_empty_string(raw.get("key")) else {
        return refuse("'match.ancestor.key' must be a non-empty string".into());
    };
    let value = raw.get("value").cloned();
    let Some(value) = value.filter(|value| !value.is_array() && !value.is_object()) else {
        return refuse("'match.ancestor.value' must be a scalar".into());
    };
    Ok(MatchAncestor { path, key: key.to_string(), value })
}

/// Whether `site` ends in the ancestor's path suffix and its head sits in a mapping holding
/// the ancestor's key and value.
fn ancestor_matches(document: &Value, site: &[PathSegment], ancestor: &MatchAncestor) -> bool {
    let Some(offset) = site.len().checked_sub(ancestor.path.len()) else {
        return false;
    };
    let suffix = site[offset..].iter().zip(&ancestor.path);
    if !suffix.into_iter().all(|(segment, key)| matches!(segment, PathSegment::Key(s) if s == key)) {
        return false;
    }
    let mut holder = Some(document);
    for segment in &site[..offset] {
        holder = holder.and_then(|node| match segment {
            PathSegment::Index(index) => node.as_array().and_then(|items| items.get(*index)),
            PathSegment::Key(key) => node.as_object().and_then(|map| map.get(key)),
        });
    }
    holder
        .and_then(Value::as_object)
        .and_then(|map| map.get(&ancestor.key))
        .is_some_and(|value| deep_equals(value, &ancestor.value))
}

/// Only a string holding the hole opener can have a hole shape.
fn is_hole_candidate(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.contains("${{"))
}

/// The container a site's value sits in.
#[derive(Clone, Copy)]
enum SiteParent<'d> {
    Mapping(&'d Map<String, Value>),
    Sequence,
}

/// One candidate site: a mapping entry whose key some rule is interested in, or an
/// untagged string scalar a `scalar` rule may select.
pub struct MatchSite<'d> {
    pub path: MigrationPath,
    pub value: &'d Value,
    parent: SiteParent<'d>,
}

/// Every candidate site in one document, keyed by mapping key — built once per document and
/// shared by every rule that can apply to it.
pub struct MatchIndex<'d> {
    pub by_key: HashMap<String, Vec<MatchSite<'d>>>,
    /// Every string holding `${{` — collected only when some `scalar` rule applies.
    pub scalars: Vec<MatchSite<'d>>,
}

struct IndexWalk<'k, 'd> {
    keys: &'k HashSet<String>,
    scalars: bool,
    stack: MigrationPath,
    index: MatchIndex<'d>,
}

impl<'d> IndexWalk<'_, 'd> {
    fn entry(&mut self, key: &str, value: &'d Value, parent: &'d Map<String, Value>) {
        self.stack.push(PathSegment::Key(key.to_string()));
        if self.keys.contains(key) {
            let site = MatchSite { path: self.stack.clone(), value, parent: SiteParent::Mapping(parent) };
            self.index.by_key.entry(key.to_string()).or_default().push(site);
        }
        if self.scalars && is_hole_candidate(value) {
            self.index.scalars.push(MatchSite { path: self.stack.clone(), value, parent: SiteParent::Mapping(parent) });
        }
        self.walk(value);
        self.stack.pop();
    }

    fn walk(&mut self, node: &'d Value) {
        match node {
            Value::Array(items) => {
                for (position, item) in items.iter().enumerate() {
                    self.stack.push(PathSegment::Index(position));
                    if self.scalars && is_hole_candidate(item) {
                        self.index.scalars.push(MatchSite { path: self.stack.clone(), value: item, parent: SiteParent::Sequence });
                    }
                    self.walk(item);
                    self.stack.pop();
                }
            }
            // A tagged scalar is one value the author wrote, never a mapping to reach into.
            Value::Object(map) if !is_tagged_sentinel(node) => {
                for (key, value) in map {
                    self.entry(key, value, map);
                }
            }
            _ => {}
        }
    }
}

/// Index `document`'s candidate sites for `keys`, descending only into the top-level
/// regions named by `roots`.
pub fn build_match_index<'d>(
    document: &'d Value,
    keys: &HashSet<String>,
    roots: &HashSet<String>,
    scalars: bool,
) -> MatchIndex<'d> {
    let mut walk = IndexWalk {
        keys,
        scalars,
        stack: Vec::new(),
        index: MatchIndex { by_key: HashMap::new(), scalars: Vec::new() },
    };
    let Some(map) = document.as_object() else { return walk.index };
    if (keys.is_empty() && !scalars) || roots.is_empty() {
        return walk.index;
    }
    let everywhere = roots.contains(MATCH_ANY);
    for (key, value) in map {
        if everywhere || roots.contains(key) {
            walk.entry(key, value, map);
        }
    }
    walk.index
}

/// The rules that may match a document of `kind`, with the key and root sets their shared
/// index needs, and whether a `scalar` rule is among them.
pub struct ApplicableRules<'r, T> {
    pub rules: Vec<&'r T>,
    pub keys: HashSet<String>,
    pub roots: HashSet<String>,
    pub scalars: bool,
}

pub fn applicable_rules<'r, T>(
    rules: &'r [T],
    match_of: impl Fn(&T) -> &MigrationMatch,
    kind: Option<&str>,
) -> ApplicableRules<'r, T> {
    let mut out = ApplicableRules { rules: Vec::new(), keys: HashSet::new(), roots: HashSet::new(), scalars: false };
    let Some(kind) = kind else { return out };
    for rule in rules {
        let matcher = match_of(rule);
        if !matcher.in_kind.iter().any(|name| name == kind || name == MATCH_ANY) {
            continue;
        }
        out.rules.push(rule);
        match &matcher.key {
            Some(key) => {
                out.keys.insert(key.clone());
            }
            None => out.scalars = true,
        }
        out.roots.extend(matcher.under.iter().cloned());
    }
    out
}

fn value_matches(matcher: &MigrationMatch, value: &Value) -> bool {
    if let Some(expected) = &matcher.value {
        return deep_equals(expected, value);
    }
    if let Some(candidates) = &matcher.value_one_of {
        return candidates.iter().any(|candidate| deep_equals(candidate, value));
    }
    if matcher.value_pattern.is_some() || matcher.value_not_pattern.is_some() {
        let Some(text) = value.as_str() else { return false };
        if matcher.value_pattern.as_ref().is_some_and(|pattern| !pattern.full_match(text)) {
            return false;
        }
        if matcher.value_not_pattern.as_ref().is_some_and(|pattern| pattern.full_match(text)) {
            return false;
        }
    }
    true
}

/// Read a `valuePattern` / `valueNotPattern`, refusing anything outside the RE2 subset —
/// lookaround and backreferences by name, and whatever else RE2 cannot parse in RE2's words.
fn read_value_pattern(describe: &str, raw: &Value) -> Result<ValuePattern, MigrationEntryError> {
    let Some(source) = non_empty_string(Some(raw)) else {
        return Err(MigrationEntryError::new(format!("{describe} must be a non-empty string")));
    };
    if let Some(refusal) = outside_re2_subset(source) {
        return Err(MigrationEntryError::new(format!(
            "{describe} uses {refusal}, which is outside the RE2 subset every runtime's migration reader accepts — no lookaround, no backreferences"
        )));
    }
    let program = re2_pattern(&format!("^(?:{source})$"), Re2Flags::NONE)
        .map_err(|refused| MigrationEntryError::new(format!("{describe} is not a valid pattern: {}", refused.message)))?;
    Ok(ValuePattern { source: source.to_string(), program })
}

/// The first construct in `pattern` RE2 does not support, named, or none.
fn outside_re2_subset(pattern: &str) -> Option<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let at = |index: usize| chars.get(index).copied();
    let mut in_class = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            if let Some(next) = at(i + 1) {
                if ('1'..='9').contains(&next) {
                    return Some(format!("a backreference ('\\{next}')"));
                }
                if next == 'k' && at(i + 2) == Some('<') {
                    return Some("a named backreference ('\\k<…>')".to_string());
                }
            }
            i += 2;
            continue;
        }
        if in_class {
            if c == ']' {
                in_class = false;
            }
            i += 1;
            continue;
        }
        if c == '[' {
            in_class = true;
            if at(i + 1) == Some('^') {
                i += 1;
            }
            if at(i + 1) == Some(']') {
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == '(' && at(i + 1) == Some('?') {
            let rest: String = chars[(i + 2).min(chars.len())..(i + 4).min(chars.len())].iter().collect();
            if rest.starts_with('=') || rest.starts_with('!') {
                return Some(format!("a lookahead ('(?{}')", &rest[..1]));
            }
            if rest == "<=" || rest == "<!" {
                return Some(format!("a lookbehind ('(?{rest}')"));
            }
        }
        i += 1;
    }
    None
}

/// The sites in `index` this match selects, in document order.
pub fn select_matches(index: &MatchIndex, document: &Value, matcher: &MigrationMatch) -> Vec<MigrationPath> {
    let Some(kind) = document.get("kind").and_then(Value::as_str) else { return Vec::new() };
    if !matcher.in_kind.iter().any(|name| name == kind || name == MATCH_ANY) {
        return Vec::new();
    }
    let sites = match &matcher.key {
        Some(key) => match index.by_key.get(key) {
            Some(sites) => sites.as_slice(),
            None => return Vec::new(),
        },
        None => index.scalars.as_slice(),
    };
    let any_root = matcher.under.iter().any(|root| root == MATCH_ANY);
    let mut out = Vec::new();
    for site in sites {
        let anchored = matches!(site.path.first(), Some(PathSegment::Key(root)) if matcher.under.contains(root));
        if !any_root && !anchored {
            continue;
        }
        if matcher.in_schema && !is_in_schema_region(&site.path) {
            continue;
        }
        if let Some(not_under) = &matcher.not_under {
            let excluded = site
                .path
                .iter()
                .any(|segment| matches!(segment, PathSegment::Key(key) if not_under.contains(key)));
            if excluded {
                continue;
            }
        }
        if let Some(shape) = matcher.scalar {
            let wanted = match shape {
                ScalarShape::LoneHole => InterpolationShape::LoneHole,
                ScalarShape::Interpolated => InterpolationShape::Interpolated,
            };
            if site.value.as_str().map(interpolation_shape) == Some(wanted) {
                out.push(site.path.clone());
            }
            continue;
        }
        if !value_matches(matcher, site.value) {
            continue;
        }
        if let Some(sibling) = &matcher.with_sibling {
            let present = match site.parent {
                SiteParent::Mapping(map) => map.contains_key(sibling),
                SiteParent::Sequence => false,
            };
            if !present {
                continue;
            }
        }
        if let Some(without) = &matcher.without_key {
            let lacks = site.value.as_object().is_some_and(|map| !is_tagged_sentinel(site.value) && !map.contains_key(without));
            if !lacks {
                continue;
            }
        }
        if matcher.ancestor.as_ref().is_some_and(|ancestor| !ancestor_matches(document, &site.path, ancestor)) {
            continue;
        }
        out.push(site.path.clone());
    }
    out
}

/// A single match against a document, through a one-rule index.
pub fn find_matches(document: &Value, matcher: &MigrationMatch) -> Vec<MigrationPath> {
    let keys: HashSet<String> = matcher.key.iter().cloned().collect();
    let roots: HashSet<String> = matcher.under.iter().cloned().collect();
    let index = build_match_index(document, &keys, &roots, matcher.scalar.is_some());
    select_matches(&index, document, matcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pattern(source: &str) -> ValuePattern {
        read_value_pattern("p", &json!(source)).expect("pattern reads")
    }

    /// The rows `manifest-migrations.test.ts` holds too: both halves match a value pattern
    /// as RE2 does, whole, where `.` stops only at `\n`.
    #[test]
    fn matches_a_value_pattern_as_re2_does_against_the_whole_value() {
        let rows: [(&str, &str, bool); 8] = [
            ("Telo\\..*", "Telo.Invocable", true),
            ("Telo\\..*", "Telo.Invocable\rx", true),
            ("Telo\\..*", "Telo.Invocable\nx", false),
            ("Telo\\..*", "Lib.Telo.X", false),
            ("[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*", "Lib.Store", true),
            ("[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*", "Lib.Store.x", false),
            ("[^/~]+", "rows", true),
            ("a|b", "ab", false),
        ];
        for (source, value, expected) in rows {
            assert_eq!(pattern(source).full_match(value), expected, "{source} against {value:?}");
        }
    }

    #[test]
    fn refuses_a_pattern_outside_the_re2_subset() {
        for (source, construct) in [
            ("(?!Telo\\.).*", "a lookahead ('(?!')"),
            ("(?<=a)b", "a lookbehind ('(?<=')"),
            ("(a)\\1", "a backreference ('\\1')"),
            ("(?<n>a)\\k<n>", "a named backreference ('\\k<…>')"),
        ] {
            let err = read_value_pattern("p", &json!(source)).expect_err(source);
            assert_eq!(
                err.message,
                format!("p uses {construct}, which is outside the RE2 subset every runtime's migration reader accepts — no lookaround, no backreferences")
            );
        }
        assert!(read_value_pattern("p", &json!("[(?=]x")).is_ok());
        let err = read_value_pattern("p", &json!("(a")).expect_err("unclosed");
        assert_eq!(err.message, "p is not a valid pattern: error parsing regexp: missing closing ): `^(?:(a)$`");
    }
}
