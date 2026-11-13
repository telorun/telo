//! The `release:` block — the units, the groups sharing a version, the ignore
//! list and the highest bump allowed — read against the core schema plus the
//! keys each registered adapter's ecosystem reads.
//!
//! What the text alone decides is reported here; what needs the tree is
//! `resolve_units`'.

use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::adapter::{AdapterRegistry, EcosystemAdapter, VersionLocationSpec, RESERVED_ECOSYSTEMS};
use crate::bump_level::BumpLevel;
use crate::fragment::{normalize_unit_key, UnitKey};
use crate::marker_reader::{
    join_path, near_miss, parse_marker, read_known_keys, read_string, read_string_list, report_null_keys, report_unknown_keys,
    with, KeyPath, MarkerReport, PathSeg, Severity, WorkspaceDiagnostic,
};
use crate::marker_schema::{has_key, key_names, KeyType, RELEASE_BLOCK_KEYS, UNIT_ENTRY_KEYS};
use crate::yaml::json_string;
use crate::ReleaseError;

/// A declared payload: unit-relative patterns, or a command printing paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadSpec {
    Patterns(Vec<String>),
    Command(String),
}

/// A `versionFiles` entry: a unit-relative pattern, or one file and a pointer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionFileSpec {
    Pattern(String),
    Path { path: String, pointer: String },
}

pub type Settings = Map<String, Value>;

#[derive(Debug, Clone)]
pub struct UnitEntry {
    pub index: usize,
    pub path: String,
    /// Ecosystem → its anchors, unit-relative and normalized.
    pub ecosystem: Option<IndexMap<String, Vec<String>>>,
    pub version: Option<VersionLocationSpec>,
    pub payload: Option<PayloadSpec>,
    pub metafile: Option<String>,
    pub version_files: Option<Vec<VersionFileSpec>>,
    pub ignore: Option<Vec<String>>,
    pub max_bump: Option<BumpLevel>,
    /// Ecosystem → anchor → the settings written at that anchor.
    pub anchor_settings: IndexMap<String, IndexMap<String, Settings>>,
}

impl UnitEntry {
    fn bare(index: usize, path: String) -> UnitEntry {
        UnitEntry {
            index,
            path,
            ecosystem: None,
            version: None,
            payload: None,
            metafile: None,
            version_files: None,
            ignore: None,
            max_bump: None,
            anchor_settings: IndexMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReleaseSettings {
    pub units: Vec<UnitEntry>,
    /// `release.ecosystems`: per ecosystem, the settings every anchor takes.
    pub ecosystems: IndexMap<String, Settings>,
    pub groups: IndexMap<String, Vec<UnitKey>>,
    pub ignore: Option<Vec<String>>,
    pub max_bump: Option<BumpLevel>,
}

#[derive(Debug, Clone, Default)]
pub struct ReadReleaseOptions {
    /// Per ecosystem no adapter here serves, the host that does.
    pub ecosystem_hosts: IndexMap<String, String>,
}

fn moved_release_key(key: &str) -> Option<&'static str> {
    match key {
        "modules" => Some(
            "'release.modules' became 'release.units': list each unit with the ecosystem it ships through, e.g. { path: modules/*, ecosystem: telo }.",
        ),
        "registry" => Some(
            "'release.registry' moved under 'release.ecosystems', keyed by the ecosystem reading it, e.g. ecosystems: { telo: { registry: oci://ghcr.io/acme } }.",
        ),
        _ => None,
    }
}

fn invalid(report: &mut MarkerReport<'_>, message: String, at: KeyPath) {
    report("WORKSPACE_INVALID_VALUE", message, at, Severity::Error);
}

pub fn read_release_block(
    raw: Option<&Value>,
    at_file: &str,
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
    options: &ReadReleaseOptions,
) -> Option<ReleaseSettings> {
    let raw = raw.filter(|v| !v.is_null())?;
    let at: KeyPath = vec!["release".into()];
    let Value::Object(block) = raw else {
        invalid(report, format!("{at_file}: 'release' must be a mapping."), at);
        return None;
    };
    let known = key_names(&RELEASE_BLOCK_KEYS);
    for (key, value) in block {
        if has_key(&RELEASE_BLOCK_KEYS, key) {
            continue;
        }
        if let Some(moved) = moved_release_key(key) {
            report("WORKSPACE_MODULES_MOVED", format!("{at_file}: {moved}"), with(&at, key.as_str()), Severity::Error);
            continue;
        }
        let mut single = Map::new();
        single.insert(key.clone(), value.clone());
        report_unknown_keys(&single, &known, at_file, &at, report);
    }
    let ignore = read_string_list(block.get("ignore"), at_file, &with(&at, "ignore"), report);
    let max_bump = read_bump_level(block.get("maxBump"), at_file, &with(&at, "maxBump"), report);
    let groups = read_groups(block.get("groups"), at_file, &with(&at, "groups"), report);
    let ecosystems = read_ecosystem_defaults(block.get("ecosystems"), at_file, &with(&at, "ecosystems"), report, adapters, options);
    let units = read_units(block.get("units"), at_file, &with(&at, "units"), report, adapters, options);
    Some(ReleaseSettings { units, ecosystems, groups, ignore, max_bump })
}

fn read_units(
    raw: Option<&Value>,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
    options: &ReadReleaseOptions,
) -> Vec<UnitEntry> {
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return Vec::new();
    };
    let Value::Array(items) = raw else {
        invalid(
            report,
            format!("{at_file}: 'release.units' must be a list, each entry a path or a mapping carrying 'path:'."),
            at.to_vec(),
        );
        return Vec::new();
    };
    if items.is_empty() {
        invalid(
            report,
            format!(
                "{at_file}: 'release.units' is empty, so nothing is released. List the units, e.g. [{{ path: packages/*, ecosystem: npm }}]."
            ),
            at.to_vec(),
        );
    }
    let entry_schema = RELEASE_BLOCK_KEYS[0].1.entry.clone().expect("units is an entry list");
    let mut entries = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let item_at = with(at, index);
        let fields = match item {
            Value::String(path) => {
                if path.is_empty() {
                    invalid(report, format!("{at_file}: '{}' is empty.", join_path(&item_at)), item_at);
                    continue;
                }
                let entry = UnitEntry::bare(index, path.clone());
                check_resolvable(&entry, at_file, &item_at, report, adapters);
                entries.push(entry);
                continue;
            }
            Value::Object(fields) => fields,
            _ => {
                invalid(
                    report,
                    format!("{at_file}: 'release.units' entry {index} must be a path, or a mapping carrying 'path:' plus the keys it adds."),
                    item_at,
                );
                continue;
            }
        };
        report_null_keys(fields, &entry_schema, at_file, &item_at, report);
        let Some(path) = read_string(fields.get("path"), at_file, &with(&item_at, "path"), report) else {
            if !fields.contains_key("path") {
                invalid(
                    report,
                    format!("{at_file}: 'release.units' entry {index} declares no 'path:', so it names nothing."),
                    item_at,
                );
            }
            continue;
        };
        let read = read_ecosystem(fields.get("ecosystem"), at_file, &with(&item_at, "ecosystem"), report, adapters, options);
        let listed: Vec<String> = read.as_ref().map(|(anchors, _)| anchors.keys().cloned().collect()).unwrap_or_default();
        report_entry_keys(fields, &listed, at_file, &item_at, report, adapters);
        let version = read_version_location(fields.get("version"), at_file, &with(&item_at, "version"), report);
        let payload = read_payload(fields.get("payload"), at_file, &with(&item_at, "payload"), report);
        let metafile = read_relative_file(fields.get("metafile"), at_file, &with(&item_at, "metafile"), report);
        let version_files = read_version_files(fields.get("versionFiles"), at_file, &with(&item_at, "versionFiles"), report);
        let ignore = read_string_list(fields.get("ignore"), at_file, &with(&item_at, "ignore"), report);
        let max_bump = read_bump_level(fields.get("maxBump"), at_file, &with(&item_at, "maxBump"), report);
        let (ecosystem, anchor_settings) = match read {
            Some((anchors, settings)) => (Some(anchors), settings),
            None => (None, IndexMap::new()),
        };
        let entry = UnitEntry { index, path, ecosystem, version, payload, metafile, version_files, ignore, max_bump, anchor_settings };
        check_resolvable(&entry, at_file, &item_at, report, adapters);
        entries.push(entry);
    }
    entries
}

/// A key the core does not read; an ecosystem's own key is named with where
/// it goes instead.
fn report_entry_keys(
    fields: &Map<String, Value>,
    listed: &[String],
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
) {
    for key in fields.keys() {
        if has_key(&UNIT_ENTRY_KEYS, key) {
            continue;
        }
        let readers: Vec<&str> = adapters.all().filter(|a| has_key(&a.keys(), key)).map(|a| a.ecosystem()).collect();
        if !readers.is_empty() {
            let eco = readers.iter().find(|name| listed.iter().any(|l| l == *name)).copied().unwrap_or(readers[0]);
            report(
                "WORKSPACE_UNKNOWN_KEY",
                format!(
                    "{at_file}: '{}' is a setting of the {} ecosystem, which is never written flat on an entry. Write it at the anchor (ecosystem: {{ {eco}: {{ \".\": {{ {key}: … }} }} }}) or for every {eco} anchor under 'release.ecosystems.{eco}'.",
                    join_path(&with(at, key.as_str())),
                    readers.join(" / ")
                ),
                with(at, key.as_str()),
                Severity::Error,
            );
            continue;
        }
        let names = key_names(&UNIT_ENTRY_KEYS);
        let hint = match near_miss(key, &names) {
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

/// Settings read against one ecosystem's keys.
fn read_ecosystem_settings(
    raw: Option<&Value>,
    ecosystem: &str,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
) -> Option<Settings> {
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return Some(Map::new());
    };
    let Value::Object(fields) = raw else {
        invalid(report, format!("{at_file}: '{}' must be a mapping of the {ecosystem} ecosystem's settings.", join_path(at)), at.to_vec());
        return None;
    };
    // An ecosystem no adapter serves is reported once, where it is named.
    let Some(adapter) = adapters.get(ecosystem) else {
        return Some(Map::new());
    };
    let keys = adapter.keys();
    let names = key_names(&keys);
    for key in fields.keys() {
        if has_key(&keys, key) {
            continue;
        }
        let hint = match near_miss(key, &names) {
            Some(near) => format!(" Did you mean '{near}'?"),
            None if !names.is_empty() => format!(" It reads {}.", names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ")),
            None => " It reads no settings.".to_string(),
        };
        report(
            "WORKSPACE_UNKNOWN_KEY",
            format!("{at_file}: '{}' is not read by the {ecosystem} ecosystem.{hint}", join_path(&with(at, key.as_str()))),
            with(at, key.as_str()),
            Severity::Error,
        );
    }
    let mut out = Map::new();
    for (key, schema) in &keys {
        if matches!(fields.get(*key), Some(Value::Null)) {
            invalid(report, format!("{at_file}: '{}' has no value.", join_path(&with(at, *key))), with(at, *key));
            continue;
        }
        if schema.ty == KeyType::Directory {
            if let Some(value) = read_workspace_directory(fields.get(*key), at_file, &with(at, *key), report) {
                out.insert(key.to_string(), Value::String(value));
            }
            continue;
        }
        let mut single = Map::new();
        if let Some(value) = fields.get(*key) {
            single.insert(key.to_string(), value.clone());
        }
        for (k, v) in read_known_keys(&single, &[(*key, schema.clone())], at_file, at, report) {
            out.insert(k, v);
        }
    }
    Some(out)
}

/// A literal workspace-relative directory, normalized.
fn read_workspace_directory(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<String> {
    let value = read_string(raw, at_file, at, report)?;
    let normalized = normalize_anchor(&value);
    if normalized.is_none() {
        report(
            "WORKSPACE_ANCHOR_INVALID",
            format!(
                "{at_file}: '{}' is {}, which is not a literal directory inside the workspace. Write a workspace-relative path with no pattern and no '..' ('.' for the workspace root).",
                join_path(at),
                json_string(&value)
            ),
            at.to_vec(),
            Severity::Error,
        );
    }
    normalized
}

fn read_ecosystem_defaults(
    raw: Option<&Value>,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
    options: &ReadReleaseOptions,
) -> IndexMap<String, Settings> {
    let mut out = IndexMap::new();
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return out;
    };
    let Value::Object(map) = raw else {
        invalid(
            report,
            format!(
                "{at_file}: '{}' must be a map of ecosystem to its settings, e.g. {{ telo: {{ registry: oci://ghcr.io/acme }} }}.",
                join_path(at)
            ),
            at.to_vec(),
        );
        return out;
    };
    for (name, settings) in map {
        let name_at = with(at, name.as_str());
        if !adapters.has(name) {
            report_unavailable(name, at_file, &name_at, report, adapters, options);
            continue;
        }
        if let Some(read) = read_ecosystem_settings(Some(settings), name, at_file, &name_at, report, adapters) {
            out.insert(name.clone(), read);
        }
    }
    out
}

fn report_unavailable(
    name: &str,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
    options: &ReadReleaseOptions,
) {
    let tail = match options.ecosystem_hosts.get(name) {
        Some(host) => format!("Run the release through {host}."),
        None => format!(
            "Run the release through a host that serves '{name}'. Served here: {}.",
            adapters.all().map(|a| a.ecosystem()).collect::<Vec<_>>().join(", ")
        ),
    };
    report(
        "WORKSPACE_ECOSYSTEM_UNAVAILABLE",
        format!(
            "{at_file}: the '{name}' ecosystem is not served here — no adapter for it is registered in this host, so it cannot be planned. {tail}"
        ),
        at.to_vec(),
        Severity::Error,
    );
}

/// What the text alone decides about a unit: where its version is, and — with
/// no ecosystem — whether it declares a payload.
fn check_resolvable(entry: &UnitEntry, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>, adapters: &AdapterRegistry) {
    if entry.path.starts_with('!') {
        return;
    }
    let listed: Vec<(&String, &Vec<String>)> = entry.ecosystem.iter().flatten().collect();
    if listed.iter().any(|(name, _)| !adapters.has(name)) {
        return;
    }
    let name = format!("'{}' ({})", join_path(at), entry.path);
    if entry.ecosystem.is_none() && entry.payload.is_none() {
        report(
            "WORKSPACE_UNIT_PAYLOAD_EMPTY",
            format!(
                "{at_file}: {name} lists no ecosystem and declares no 'payload:', so nothing it ships can be digested. List the ecosystem it ships through, declare 'payload:', or exclude it with '!'."
            ),
            at.to_vec(),
            Severity::Error,
        );
    }
    if entry.version.is_some() {
        return;
    }
    let defaulting: Vec<String> = listed
        .iter()
        .flat_map(|(ecosystem, anchors)| {
            let keeps = adapters.get(ecosystem).is_some_and(|a| a.version_file().is_some());
            anchors.iter().filter(move |_| keeps).map(move |anchor| format!("{ecosystem} at {anchor}"))
        })
        .collect();
    if defaulting.len() == 1 {
        return;
    }
    let message = if defaulting.is_empty() {
        let why = if listed.is_empty() {
            "lists no ecosystem".to_string()
        } else {
            format!(
                "none of its ecosystems ({}) keeps a version",
                listed.iter().map(|(e, _)| e.as_str()).collect::<Vec<_>>().join(", ")
            )
        };
        format!("{at_file}: {name} declares no 'version:' and {why}. Declare 'version:', naming the file that holds it.")
    } else {
        format!(
            "{at_file}: {name} declares no 'version:' and {} anchors keep one ({}). Declare 'version:', naming the one that holds the unit's version.",
            defaulting.len(),
            defaulting.join(", ")
        )
    };
    report("WORKSPACE_UNIT_VERSION_UNRESOLVED", message, at.to_vec(), Severity::Error);
}

type EcosystemRead = (IndexMap<String, Vec<String>>, IndexMap<String, IndexMap<String, Settings>>);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    Single,
    List,
    Map,
}

/// A JSON value as JavaScript's `JSON.stringify` writes it, for an anchor in a
/// refusal.
fn js_json(value: &Value) -> String {
    match value {
        Value::String(text) => json_string(text),
        other => other.to_string(),
    }
}

/// A value as JavaScript's `String()` writes a map key.
fn js_key(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn read_ecosystem(
    raw: Option<&Value>,
    at_file: &str,
    at: &[PathSeg],
    report: &mut MarkerReport<'_>,
    adapters: &AdapterRegistry,
    options: &ReadReleaseOptions,
) -> Option<EcosystemRead> {
    let raw = raw.filter(|v| !v.is_null())?;
    let mut out: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut settings: IndexMap<String, IndexMap<String, Settings>> = IndexMap::new();
    let mut add = |name: &Value,
                   anchors: Vec<Value>,
                   name_at: KeyPath,
                   form: Form,
                   anchor_settings: Option<&Map<String, Value>>,
                   report: &mut MarkerReport<'_>| {
        let name = match name {
            Value::String(name) if !name.is_empty() => name.clone(),
            _ => {
                invalid(report, format!("{at_file}: '{}' must name an ecosystem.", join_path(&name_at)), name_at);
                return;
            }
        };
        if RESERVED_ECOSYSTEMS.contains(&name.as_str()) {
            invalid(
                report,
                format!(
                    "{at_file}: '{name}' is reserved for a declared payload and names no ecosystem. Declare a payload with the entry's 'payload:' key."
                ),
                name_at,
            );
            return;
        }
        if out.contains_key(&name) {
            invalid(report, format!("{at_file}: '{name}' is listed twice."), name_at);
            return;
        }
        if !adapters.has(&name) {
            report_unavailable(&name, at_file, &name_at, report, adapters, options);
        }
        let mut normalized: Vec<String> = Vec::new();
        let mut by_setting: IndexMap<String, Settings> = IndexMap::new();
        for (i, anchor) in anchors.iter().enumerate() {
            let anchor_at = match form {
                Form::List => with(&name_at, i),
                Form::Map => with(&name_at, js_key(anchor)),
                Form::Single => name_at.clone(),
            };
            let Some(valid) = anchor.as_str().and_then(normalize_anchor) else {
                report(
                    "WORKSPACE_ANCHOR_INVALID",
                    format!(
                        "{at_file}: anchor {} of '{name}' is not a literal directory inside the unit. An anchor is a unit-relative path with no pattern and no '..' (or '.' for the unit itself).",
                        js_json(anchor)
                    ),
                    anchor_at,
                    Severity::Error,
                );
                continue;
            };
            if normalized.contains(&valid) {
                invalid(report, format!("{at_file}: anchor '{valid}' of '{name}' is listed twice."), anchor_at);
                continue;
            }
            normalized.push(valid.clone());
            if form == Form::Map {
                let written = anchor_settings.and_then(|map| map.get(&js_key(anchor)));
                if let Some(read) = read_ecosystem_settings(written, &name, at_file, &anchor_at, report, adapters) {
                    if !read.is_empty() {
                        by_setting.insert(valid, read);
                    }
                }
            }
        }
        out.insert(name.clone(), normalized);
        if !by_setting.is_empty() {
            settings.insert(name, by_setting);
        }
    };

    match raw {
        Value::String(_) => add(raw, vec![Value::String(".".into())], at.to_vec(), Form::Single, None, report),
        Value::Array(items) => {
            for (i, name) in items.iter().enumerate() {
                add(name, vec![Value::String(".".into())], with(at, i), Form::Single, None, report);
            }
        }
        Value::Object(map) => {
            for (name, anchors) in map {
                let name_at = with(at, name.as_str());
                let name_value = Value::String(name.clone());
                match anchors {
                    Value::String(_) => add(&name_value, vec![anchors.clone()], name_at, Form::Single, None, report),
                    Value::Array(list) if !list.is_empty() => add(&name_value, list.clone(), name_at, Form::List, None, report),
                    Value::Object(by_anchor) if !by_anchor.is_empty() => {
                        let keys = by_anchor.keys().map(|k| Value::String(k.clone())).collect();
                        add(&name_value, keys, name_at, Form::Map, Some(by_anchor), report)
                    }
                    _ => invalid(
                        report,
                        format!(
                            "{at_file}: '{}' must be an anchor directory, a list of them, or a map of anchor directory to its settings.",
                            join_path(&name_at)
                        ),
                        name_at,
                    ),
                }
            }
        }
        _ => invalid(
            report,
            format!(
                "{at_file}: '{}' must be an ecosystem name, a list of them, or a map of ecosystem to anchor directory.",
                join_path(at)
            ),
            at.to_vec(),
        ),
    }
    if out.is_empty() {
        None
    } else {
        Some((out, settings))
    }
}

/// A literal unit-relative directory, normalized; `None` for a pattern, a path
/// leaving the unit, or an absolute one.
pub fn normalize_anchor(anchor: &str) -> Option<String> {
    if anchor.trim().is_empty() {
        return None;
    }
    let posix = anchor.replace('\\', "/");
    let bytes = posix.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if posix.starts_with('/') || drive || posix.contains(['*', '?', '!']) {
        return None;
    }
    let segments: Vec<&str> = posix.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if segments.contains(&"..") {
        return None;
    }
    Some(if segments.is_empty() { ".".to_string() } else { segments.join("/") })
}

fn read_relative_file(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<String> {
    let value = read_string(raw, at_file, at, report)?;
    match normalize_anchor(&value) {
        Some(normalized) if normalized != "." => Some(normalized),
        _ => {
            invalid(report, format!("{at_file}: '{}' must be a file inside the unit, with no pattern and no '..'.", join_path(at)), at.to_vec());
            None
        }
    }
}

fn read_pointer(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<String> {
    let value = read_string(raw, at_file, at, report)?;
    if !value.starts_with('/') {
        invalid(
            report,
            format!("{at_file}: '{}' must be a JSON pointer (RFC 6901) starting with '/', e.g. /version.", join_path(at)),
            at.to_vec(),
        );
        return None;
    }
    Some(value)
}

fn read_version_location(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<VersionLocationSpec> {
    let raw = raw.filter(|v| !v.is_null())?;
    match raw {
        Value::String(_) => read_relative_file(Some(raw), at_file, at, report).map(|file| VersionLocationSpec { file, pointer: None }),
        Value::Object(fields) => {
            report_unknown_keys(fields, &["file", "pointer"], at_file, at, report);
            let file = read_relative_file(fields.get("file"), at_file, &with(at, "file"), report);
            let pointer = read_pointer(fields.get("pointer"), at_file, &with(at, "pointer"), report);
            match (file, pointer) {
                (Some(file), Some(pointer)) => Some(VersionLocationSpec { file, pointer: Some(pointer) }),
                _ => {
                    if !fields.contains_key("file") || !fields.contains_key("pointer") {
                        invalid(report, format!("{at_file}: '{}' needs both 'file:' and 'pointer:'.", join_path(at)), at.to_vec());
                    }
                    None
                }
            }
        }
        _ => {
            invalid(report, format!("{at_file}: '{}' must be a unit-relative file, or {{ file, pointer }}.", join_path(at)), at.to_vec());
            None
        }
    }
}

fn read_payload(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<PayloadSpec> {
    let raw = raw.filter(|v| !v.is_null())?;
    match raw {
        Value::Array(_) => {
            let patterns = read_string_list(Some(raw), at_file, at, report)?;
            if patterns.is_empty() {
                invalid(report, format!("{at_file}: '{}' is empty, so it selects no file.", join_path(at)), at.to_vec());
                return None;
            }
            Some(PayloadSpec::Patterns(patterns))
        }
        Value::Object(fields) => {
            report_unknown_keys(fields, &["command"], at_file, at, report);
            let command = read_string(fields.get("command"), at_file, &with(at, "command"), report);
            if command.is_none() && !fields.contains_key("command") {
                invalid(report, format!("{at_file}: '{}' needs 'command:'.", join_path(at)), at.to_vec());
            }
            command.map(PayloadSpec::Command)
        }
        _ => {
            invalid(
                report,
                format!("{at_file}: '{}' must be a list of unit-relative patterns, or {{ command }}.", join_path(at)),
                at.to_vec(),
            );
            None
        }
    }
}

fn read_version_files(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<Vec<VersionFileSpec>> {
    let raw = raw.filter(|v| !v.is_null())?;
    let Value::Array(items) = raw else {
        invalid(
            report,
            format!("{at_file}: '{}' must be a list of unit-relative patterns or {{ path, pointer }}.", join_path(at)),
            at.to_vec(),
        );
        return None;
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let item_at = with(at, index);
        match item {
            Value::String(_) => {
                if let Some(pattern) = read_string(Some(item), at_file, &item_at, report) {
                    out.push(VersionFileSpec::Pattern(pattern));
                }
            }
            Value::Object(fields) => {
                report_unknown_keys(fields, &["path", "pointer"], at_file, &item_at, report);
                let path = read_relative_file(fields.get("path"), at_file, &with(&item_at, "path"), report);
                let pointer = read_pointer(fields.get("pointer"), at_file, &with(&item_at, "pointer"), report);
                match (path, pointer) {
                    (Some(path), Some(pointer)) => out.push(VersionFileSpec::Path { path, pointer }),
                    _ => {
                        if !fields.contains_key("path") || !fields.contains_key("pointer") {
                            invalid(report, format!("{at_file}: '{}' needs both 'path:' and 'pointer:'.", join_path(&item_at)), item_at);
                        }
                    }
                }
            }
            _ => invalid(
                report,
                format!("{at_file}: '{}' must be a unit-relative pattern, or {{ path, pointer }}.", join_path(&item_at)),
                item_at,
            ),
        }
    }
    Some(out)
}

fn read_bump_level(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> Option<BumpLevel> {
    let raw = raw.filter(|v| !v.is_null())?;
    match raw.as_str().and_then(BumpLevel::parse) {
        Some(level) => Some(level),
        None => {
            invalid(report, format!("{at_file}: '{}' must be patch, minor or major.", join_path(at)), at.to_vec());
            None
        }
    }
}

fn read_groups(raw: Option<&Value>, at_file: &str, at: &[PathSeg], report: &mut MarkerReport<'_>) -> IndexMap<String, Vec<UnitKey>> {
    let mut groups = IndexMap::new();
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return groups;
    };
    let Value::Object(map) = raw else {
        invalid(report, format!("{at_file}: '{}' must be a map of group name to a list of unit keys.", join_path(at)), at.to_vec());
        return groups;
    };
    let mut owner: IndexMap<UnitKey, String> = IndexMap::new();
    for (name, members) in map {
        let name_at = with(at, name.as_str());
        let Some(list) = read_string_list(Some(members), at_file, &name_at, report) else {
            if members.is_null() {
                invalid(report, format!("{at_file}: '{}' must be a list of unit keys.", join_path(&name_at)), name_at);
            }
            continue;
        };
        let mut keys = Vec::new();
        for (index, member) in list.iter().enumerate() {
            let key = normalize_unit_key(member);
            if let Some(other) = owner.get(&key) {
                invalid(
                    report,
                    format!(
                        "{at_file}: '{key}' is in groups '{other}' and '{name}'. A unit shares one version, so it belongs to at most one group."
                    ),
                    with(&name_at, index),
                );
                continue;
            }
            owner.insert(key.clone(), name.clone());
            keys.push(key);
        }
        groups.insert(name.clone(), keys);
    }
    groups
}

pub struct ReleaseMarkerRead {
    pub release: Option<ReleaseSettings>,
    pub diagnostics: Vec<WorkspaceDiagnostic>,
}

/// Read a marker's `release:` block alone; other blocks are left unread.
pub fn read_release_marker(
    text: &str,
    at_file: &str,
    adapters: &[Arc<dyn EcosystemAdapter>],
    options: &ReadReleaseOptions,
) -> Result<ReleaseMarkerRead, ReleaseError> {
    let registry = AdapterRegistry::new(adapters)?;
    let mut diagnostics = Vec::new();
    let release = {
        let mut report = |code: &'static str, message: String, path: KeyPath, severity: Severity| {
            diagnostics.push(WorkspaceDiagnostic { code, severity, message, path });
        };
        let record = parse_marker(text, at_file, &mut report);
        record.and_then(|record| read_release_block(record.get("release"), at_file, &mut report, &registry, options))
    };
    Ok(ReleaseMarkerRead { release, diagnostics })
}

/// The release settings, or a refusal naming what is missing.
pub fn require_release_settings(read: &ReleaseMarkerRead, at_file: &str) -> Result<ReleaseSettings, ReleaseError> {
    if let Some(first) = read.diagnostics.iter().find(|d| d.severity == Severity::Error) {
        return Err(ReleaseError::new(first.message.clone()));
    }
    match &read.release {
        Some(release) if !release.units.is_empty() => Ok(release.clone()),
        _ => Err(ReleaseError::new(format!(
            "{at_file} declares no 'release.units', so nothing is released. List the units:\n\n  release:\n    units:\n      - {{ path: packages/*, ecosystem: npm }}\n"
        ))),
    }
}

