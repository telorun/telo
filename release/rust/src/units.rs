//! From `release.units` to the units of one tree.
//!
//! A unit's entry is the LAST one matching its path (a `!` entry excludes);
//! each of its anchors is a literal directory inside it that the anchor's
//! ecosystem recognises as exactly one package. A pattern entry skips a
//! directory whose anchors are not all recognised; a literal one refuses it.
//! This file names no ecosystem.

use std::collections::{BTreeSet, HashMap};

use indexmap::IndexMap;
use serde_json::Value;

use crate::adapter::{AdapterRegistry, AnchorProbe, RecognizedPackage, VersionLocationSpec};
use crate::bump_level::BumpLevel;
use crate::fragment::{normalize_unit_key, UnitKey};
use telorun_glob::{last_match_index, select_by_patterns, SelectOptions};
use crate::marker_reader::{KeyPath, PathSeg, Severity, WorkspaceDiagnostic};
use crate::marker_schema::{KeyType, DEFAULT_RELEASE_IGNORE};
use crate::release_settings::{PayloadSpec, ReleaseSettings, Settings, UnitEntry, VersionFileSpec};
use crate::tag_format::{
    default_tag_format, git_tag_refusal, parse_tag_format, render_tag, tag_collision, tag_pattern_of, TagPattern, SAMPLE_TAG_VERSION,
};
use crate::yaml::json_string;
use crate::version_files::{read_version_at, write_version_at};
use crate::ReleaseError;

/// What a host lets the resolver see of the tree, every path
/// workspace-relative and `/`-separated.
pub trait WorkspaceTree {
    /// Every directory, pruned as the host prunes.
    fn directories(&self) -> &[String];
    /// Every file beneath `dir`, relative to it.
    fn files_under(&self, dir: &str) -> Vec<String>;
    /// A file's text, or `None` when absent.
    fn read_file(&self, path: &str) -> Option<String>;
}

#[derive(Debug, Clone)]
pub struct ResolvedAnchor {
    pub ecosystem: String,
    /// Unit-relative (`.` the unit itself).
    pub anchor: String,
    /// Workspace-relative directory (`""` the workspace root).
    pub dir: String,
    pub package: RecognizedPackage,
    /// Its own settings over `release.ecosystems.<ecosystem>`'s.
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionLocation {
    pub file: String,
    pub pointer: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedUnit {
    pub key: UnitKey,
    pub dir: String,
    pub entry: UnitEntry,
    pub anchors: Vec<ResolvedAnchor>,
    pub version: VersionLocation,
    /// Every location `apply` writes the version to, `version` first.
    pub version_locations: Vec<VersionLocation>,
    pub payload: Option<PayloadSpec>,
    pub metafile: Option<String>,
    pub ignore: Vec<String>,
    pub max_bump: BumpLevel,
    pub group: Option<String>,
    /// The unit's label: its entry's `name`, else the last segment of its
    /// key; the root unit has none unless it names one.
    pub name: Option<String>,
    /// The tag format in force: the entry's, `release.tagFormat`, or the default.
    pub tag_format: String,
    /// That format resolved for this unit — the text around each version.
    pub tag_pattern: TagPattern,
}

pub struct UnitResolution {
    pub units: Vec<ResolvedUnit>,
    pub diagnostics: Vec<WorkspaceDiagnostic>,
}

fn is_pattern(path: &str) -> bool {
    path.contains(['*', '?'])
}

pub fn join_path(dir: &str, relative: &str) -> String {
    if relative == "." || relative.is_empty() {
        return dir.to_string();
    }
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{dir}/{relative}")
    }
}

fn unit_dir(key: &str) -> String {
    if key == "." {
        String::new()
    } else {
        key.to_string()
    }
}

/// The entry deciding `key`, or `None` when none matches or the last match
/// excludes it.
pub fn deciding_entry<'a>(release: &'a ReleaseSettings, key: &str) -> Option<&'a UnitEntry> {
    let mut decided = None;
    for entry in &release.units {
        let negated = entry.path.starts_with('!');
        let path = if negated { &entry.path[1..] } else { entry.path.as_str() };
        let matches = if is_pattern(path) { last_match_index(key, &[path]).is_some() } else { normalize_unit_key(path) == key };
        if matches {
            decided = if negated { None } else { Some(entry) };
        }
    }
    decided
}

pub fn resolve_units(release: &ReleaseSettings, tree: &dyn WorkspaceTree, adapters: &AdapterRegistry) -> UnitResolution {
    let mut diagnostics = Vec::new();
    let mut report = |message: String, code: &'static str, path: KeyPath| {
        diagnostics.push(WorkspaceDiagnostic { code, severity: Severity::Error, message, path });
    };

    let mut candidates: BTreeSet<String> = tree.directories().iter().map(|d| normalize_unit_key(d)).collect();
    for entry in &release.units {
        if !entry.path.starts_with('!') && !is_pattern(&entry.path) {
            let key = normalize_unit_key(&entry.path);
            candidates.insert(if key.is_empty() { ".".into() } else { key });
        }
    }

    let mut group_of: IndexMap<UnitKey, String> = IndexMap::new();
    for (name, members) in &release.groups {
        for member in members {
            group_of.insert(member.clone(), name.clone());
        }
    }

    let directories: BTreeSet<String> = tree.directories().iter().map(|d| normalize_unit_key(d)).collect();
    let mut units: Vec<ResolvedUnit> = Vec::new();
    let mut claims: IndexMap<String, UnitKey> = IndexMap::new();
    for key in &candidates {
        let Some(entry) = deciding_entry(release, key) else { continue };
        let literal = !is_pattern(&entry.path);
        let at: KeyPath = vec!["release".into(), "units".into(), PathSeg::Index(entry.index)];
        let dir = unit_dir(key);

        let mut anchors: Vec<ResolvedAnchor> = Vec::new();
        let mut skipped = false;
        let mut unavailable = false;
        let mut ecosystems: Vec<&String> = entry.ecosystem.iter().flat_map(|map| map.keys()).collect();
        ecosystems.sort();
        for ecosystem in ecosystems {
            let Some(adapter) = adapters.get(ecosystem) else {
                unavailable = true;
                continue;
            };
            for anchor in &entry.ecosystem.as_ref().expect("listed")[ecosystem] {
                let anchor_dir = join_path(&dir, anchor);
                let read = |relative: &str| tree.read_file(&join_path(&anchor_dir, relative));
                let probe = AnchorProbe { unit: key, anchor, dir: &anchor_dir, read: &read };
                let Some(recognized) = adapter.recognize(&probe) else {
                    skipped = true;
                    if literal {
                        report(
                            format!(
                                "'{}' is anchored as {ecosystem} by unit '{key}', but it is not {}.",
                                if anchor_dir.is_empty() { "." } else { &anchor_dir },
                                adapter.anchor_description()
                            ),
                            "WORKSPACE_ANCHOR_INVALID",
                            with_key(&at, "ecosystem"),
                        );
                    }
                    continue;
                };
                let mut settings = release.ecosystems.get(ecosystem).cloned().unwrap_or_default();
                if let Some(own) = entry.anchor_settings.get(ecosystem).and_then(|by| by.get(anchor)) {
                    for (k, v) in own {
                        settings.insert(k.clone(), v.clone());
                    }
                }
                let mut missing = false;
                for (name, schema) in adapter.keys() {
                    let Some(Value::String(value)) = settings.get(name) else { continue };
                    if schema.ty != KeyType::Directory || value == "." || directories.contains(value) {
                        continue;
                    }
                    missing = true;
                    report(
                        format!(
                            "{ecosystem} anchor '{}' of unit '{key}' names {name} '{value}', which is not a directory of this workspace.",
                            if anchor_dir.is_empty() { "." } else { &anchor_dir }
                        ),
                        "WORKSPACE_ANCHOR_INVALID",
                        with_key(&at, "ecosystem"),
                    );
                }
                if missing {
                    skipped = true;
                    continue;
                }
                anchors.push(ResolvedAnchor {
                    ecosystem: ecosystem.clone(),
                    anchor: anchor.clone(),
                    dir: anchor_dir.clone(),
                    package: recognized,
                    settings,
                });
            }
        }
        if skipped || unavailable {
            continue;
        }

        let Some(version) = primary_version(entry, &dir, &anchors, adapters) else {
            // Zero or several defaulting anchors is reported where the entry is read;
            // an anchor that keeps no static version is known only here.
            let unversioned: Vec<&str> = anchors.iter().filter_map(|a| a.package.no_static_version.as_deref()).collect();
            if !unversioned.is_empty() {
                report(
                    format!(
                        "Unit '{key}' declares no 'version:' and {}. Declare 'version: <file>' or 'version: {{ file, pointer }}', naming the file that holds the unit's version.",
                        unversioned.join("; ")
                    ),
                    "WORKSPACE_UNIT_VERSION_UNRESOLVED",
                    at.clone(),
                );
            }
            continue;
        };

        let layers = anchors.iter().filter(|a| a.package.contributes_layer).count() + usize::from(entry.payload.is_some());
        if layers == 0 {
            let message = if anchors.is_empty() {
                format!(
                    "Unit '{key}' ships no layer: it lists no ecosystem. List the ecosystem it ships through, declare 'payload:' (for example payload: [\"**\"]), or exclude the unit with '!{key}'."
                )
            } else {
                let reasons: Vec<String> = anchors
                    .iter()
                    .map(|a| a.package.no_layer_reason.clone().unwrap_or_else(|| format!("{} at `{}` publishes nothing", a.ecosystem, a.anchor)))
                    .collect();
                format!(
                    "Unit '{key}' ships no layer: {}. Declare 'payload:' on the same entry beside 'ecosystem:' (its packages still supply version and edges), or exclude the unit with '!{key}'.",
                    reasons.join("; ")
                )
            };
            report(
                message,
                "WORKSPACE_UNIT_PAYLOAD_EMPTY",
                at.clone(),
            );
            continue;
        }

        let name = entry.name.clone().or_else(|| (key != ".").then(|| key.rsplit('/').next().unwrap_or(key).to_string()));
        let tag_format = entry
            .tag_format
            .clone()
            .or_else(|| release.tag_format.clone())
            .unwrap_or_else(|| default_tag_format(key).to_string());
        let Some(tag_pattern) = unit_tag_pattern(key, name.as_deref(), &tag_format, tag_at(entry), &mut report) else {
            continue;
        };

        for anchor in &anchors {
            let claim = format!("{}\0{}", anchor.ecosystem, anchor.dir);
            if let Some(owner) = claims.get(&claim) {
                report(
                    format!(
                        "The {} package at '{}' is claimed by units '{owner}' and '{key}'. A package belongs to one unit; anchor it in only one of them.",
                        anchor.ecosystem,
                        if anchor.dir.is_empty() { "." } else { &anchor.dir }
                    ),
                    "WORKSPACE_ANCHOR_CLAIMED",
                    with_key(&at, "ecosystem"),
                );
                continue;
            }
            claims.insert(claim, key.clone());
        }

        let version_locations = version_locations(entry, &dir, &version, &anchors, tree, adapters);
        units.push(ResolvedUnit {
            key: key.clone(),
            dir: dir.clone(),
            entry: entry.clone(),
            anchors,
            version,
            version_locations,
            payload: entry.payload.clone(),
            metafile: entry.metafile.as_ref().map(|m| join_path(&dir, m)),
            ignore: entry
                .ignore
                .clone()
                .or_else(|| release.ignore.clone())
                .unwrap_or_else(|| DEFAULT_RELEASE_IGNORE.iter().map(|s| s.to_string()).collect()),
            max_bump: entry.max_bump.or(release.max_bump).unwrap_or(BumpLevel::Major),
            group: group_of.get(key).cloned(),
            name,
            tag_format,
            tag_pattern,
        });
    }

    // Identical patterns collide by construction: one diagnostic per such group, the
    // automaton walk only across distinct patterns.
    let mut pattern_groups: Vec<Vec<&ResolvedUnit>> = Vec::new();
    let mut group_of_pattern: HashMap<&TagPattern, usize> = HashMap::new();
    for unit in &units {
        match group_of_pattern.get(&unit.tag_pattern) {
            Some(&index) => pattern_groups[index].push(unit),
            None => {
                group_of_pattern.insert(&unit.tag_pattern, pattern_groups.len());
                pattern_groups.push(vec![unit]);
            }
        }
    }
    let mut report_collision = |members: &[&ResolvedUnit], tag: &str| {
        report(tag_collision_message(members, tag), "WORKSPACE_TAG_COLLISION", tag_at(&members[members.len() - 1].entry));
    };
    for (i, a) in pattern_groups.iter().enumerate() {
        if a.len() > 1 {
            if let Some(tag) = tag_collision(&a[0].tag_pattern, &a[0].tag_pattern) {
                report_collision(a, &tag);
            }
        }
        for b in &pattern_groups[i + 1..] {
            if let Some(tag) = tag_collision(&a[0].tag_pattern, &b[0].tag_pattern) {
                let members: Vec<&ResolvedUnit> = a.iter().chain(b.iter()).copied().collect();
                report_collision(&members, &tag);
            }
        }
    }

    let resolved: BTreeSet<&str> = units.iter().map(|u| u.key.as_str()).collect();
    for (name, members) in &release.groups {
        for (index, member) in members.iter().enumerate() {
            if resolved.contains(member.as_str()) {
                continue;
            }
            report(
                format!("Group '{name}' names '{member}', which is not a unit of this workspace."),
                "WORKSPACE_INVALID_VALUE",
                vec!["release".into(), "groups".into(), name.as_str().into(), PathSeg::Index(index)],
            );
        }
    }
    UnitResolution { units, diagnostics }
}

/// The pattern `format` resolves to for one unit, or `None` with the reason
/// reported: `{name}` on a unit with none, or a tag git refuses.
fn unit_tag_pattern(
    key: &str,
    name: Option<&str>,
    format: &str,
    at: KeyPath,
    report: &mut impl FnMut(String, &'static str, KeyPath),
) -> Option<TagPattern> {
    let parts = match parse_tag_format(format) {
        Ok(parts) => parts,
        Err(problem) => {
            report(format!("Unit '{key}' has the tag format {}, {problem}.", json_string(format)), "WORKSPACE_TAG_INVALID", at);
            return None;
        }
    };
    let Some(pattern) = tag_pattern_of(&parts, key, name) else {
        report(
            format!(
                "Unit '{key}' has no name, so its tag format '{format}' cannot render {{name}}. Give its entry a 'name:', or a 'tagFormat' without {{name}}."
            ),
            "WORKSPACE_TAG_INVALID",
            at,
        );
        return None;
    };
    let sample = render_tag(&pattern, SAMPLE_TAG_VERSION);
    if let Some(refusal) = git_tag_refusal(&sample) {
        report(
            format!(
                "Unit '{key}' renders its tag format '{format}' as '{sample}' for version {SAMPLE_TAG_VERSION}, which git refuses as a tag: {refusal}. Give it a 'tagFormat' that renders a legal tag."
            ),
            "WORKSPACE_TAG_INVALID",
            at,
        );
        return None;
    }
    Some(pattern)
}

/// Where a unit's tag is fixed: its entry's `tagFormat`, else the entry.
fn quoted_list(items: &[String]) -> String {
    let quoted: Vec<String> = items.iter().map(|item| format!("'{item}'")).collect();
    match quoted.len() {
        0 | 1 => quoted.join(""),
        n => format!("{} and {}", quoted[..n - 1].join(", "), quoted[n - 1]),
    }
}

fn tag_collision_message(members: &[&ResolvedUnit], tag: &str) -> String {
    if let [a, b] = members {
        return format!(
            "Units '{}' and '{}' can be tagged alike: '{tag}' renders from both tag formats ('{}' and '{}'). Give one of them a 'tagFormat' no version of the other can render.",
            a.key, b.key, a.tag_format, b.tag_format
        );
    }
    let mut formats: Vec<String> = Vec::new();
    for unit in members {
        if !formats.contains(&unit.tag_format) {
            formats.push(unit.tag_format.clone());
        }
    }
    let keys: Vec<String> = members.iter().map(|unit| unit.key.clone()).collect();
    format!(
        "Units {} can be tagged alike: '{tag}' renders from all their tag formats ({}). Give all but one of them a 'tagFormat' no version of the others can render.",
        quoted_list(&keys),
        quoted_list(&formats)
    )
}

fn tag_at(entry: &UnitEntry) -> KeyPath {
    let at: KeyPath = vec!["release".into(), "units".into(), PathSeg::Index(entry.index)];
    if entry.tag_format.is_some() {
        with_key(&at, "tagFormat")
    } else {
        at
    }
}

fn with_key(at: &KeyPath, key: &str) -> KeyPath {
    let mut out = at.clone();
    out.push(key.into());
    out
}

fn located(dir: &str, spec: &VersionLocationSpec) -> VersionLocation {
    VersionLocation { file: join_path(dir, &spec.file), pointer: spec.pointer.clone() }
}

fn primary_version(entry: &UnitEntry, dir: &str, anchors: &[ResolvedAnchor], adapters: &AdapterRegistry) -> Option<VersionLocation> {
    if let Some(version) = &entry.version {
        return Some(located(dir, version));
    }
    let defaulting: Vec<VersionLocation> = anchors
        .iter()
        .filter(|anchor| anchor.package.no_static_version.is_none())
        .filter_map(|anchor| adapters.get(&anchor.ecosystem)?.version_file().map(|spec| located(&anchor.dir, &spec)))
        .collect();
    if defaulting.len() == 1 {
        defaulting.into_iter().next()
    } else {
        None
    }
}

fn version_locations(
    entry: &UnitEntry,
    dir: &str,
    primary: &VersionLocation,
    anchors: &[ResolvedAnchor],
    tree: &dyn WorkspaceTree,
    adapters: &AdapterRegistry,
) -> Vec<VersionLocation> {
    let mut found = vec![primary.clone()];
    let mut add = |location: VersionLocation| {
        if !found.contains(&location) {
            found.push(location);
        }
    };
    for anchor in anchors {
        if let Some(spec) = adapters.get(&anchor.ecosystem).and_then(|a| a.version_file()).filter(|_| anchor.package.no_static_version.is_none()) {
            add(located(&anchor.dir, &spec));
        }
        for file in &anchor.package.version_files {
            add(VersionLocation { file: join_path(&anchor.dir, file), pointer: None });
        }
    }
    let specs = entry.version_files.clone().unwrap_or_default();
    let patterns: Vec<String> = specs
        .iter()
        .filter_map(|spec| match spec {
            VersionFileSpec::Pattern(pattern) => Some(pattern.clone()),
            VersionFileSpec::Path { .. } => None,
        })
        .collect();
    if !patterns.is_empty() {
        let options = SelectOptions { apply_default_ignore: Some(false), exclude: Vec::new() };
        for file in select_by_patterns(&tree.files_under(dir), &patterns, &options) {
            add(VersionLocation { file: join_path(dir, &file), pointer: None });
        }
    }
    for spec in &specs {
        if let VersionFileSpec::Path { path, pointer } = spec {
            add(VersionLocation { file: join_path(dir, path), pointer: Some(pointer.clone()) });
        }
    }
    found
}

/// One version location as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionReading {
    pub file: String,
    pub pointer: Option<String>,
    pub value: Option<String>,
    pub error: Option<String>,
}

fn describe_location(location: &VersionLocation) -> String {
    match &location.pointer {
        Some(pointer) if !pointer.is_empty() => format!("{}#{pointer}", location.file),
        _ => location.file.clone(),
    }
}

fn as_spec(location: &VersionLocation) -> VersionLocationSpec {
    VersionLocationSpec { file: location.file.clone(), pointer: location.pointer.clone() }
}

/// Read every version location of a unit.
pub fn read_unit_versions(unit: &ResolvedUnit, read_file: &dyn Fn(&str) -> Option<String>, adapters: &AdapterRegistry) -> Vec<VersionReading> {
    unit.version_locations
        .iter()
        .map(|location| {
            let base = VersionReading { file: location.file.clone(), pointer: location.pointer.clone(), value: None, error: None };
            let Some(text) = read_file(&location.file) else {
                return VersionReading { error: Some(format!("{} does not exist", location.file)), ..base };
            };
            match read_version_at(&as_spec(location), &text, &describe_location(location), adapters) {
                Ok(value) => VersionReading { value, ..base },
                Err(err) => VersionReading { error: Some(err.message), ..base },
            }
        })
        .collect()
}

/// The files of a unit rewritten to carry `version`.
pub fn stamp_unit_version(
    unit: &ResolvedUnit,
    version: &str,
    read_file: &dyn Fn(&str) -> Option<String>,
    adapters: &AdapterRegistry,
) -> Result<Vec<(String, String)>, ReleaseError> {
    let mut texts: IndexMap<String, String> = IndexMap::new();
    for location in &unit.version_locations {
        let before = match texts.get(&location.file) {
            Some(text) => text.clone(),
            None => read_file(&location.file).ok_or_else(|| {
                ReleaseError::new(format!("{} does not exist, so '{}' cannot be versioned.", describe_location(location), unit.key))
            })?,
        };
        let written = write_version_at(&as_spec(location), &before, version, &describe_location(location), adapters)?;
        texts.insert(location.file.clone(), written);
    }
    Ok(texts.into_iter().filter(|(file, text)| read_file(file).as_deref() != Some(text.as_str())).collect())
}
