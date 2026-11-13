//! Turning evidence into a release plan: which units bump, to what, and why.
//!
//! - **Whether** a unit bumps is decided by the digests of its layers at its
//!   recorded version against the ledger.
//! - **At what level** is decided by the edge graph: a fragment is a root, a
//!   dependent mirrors its dependency's level, and a group releases every
//!   member at the highest level any member needs.
//! - **Whether a changelog line is requested** is decided by whether a unit's
//!   own files changed; a unit that drifted with no fragment ships as an
//!   unattributed patch.
//!
//! Pure data in, plan out: this file reads no package format and names no
//! ecosystem.

use std::collections::{BTreeSet, HashSet};

use indexmap::IndexMap;

use crate::bump_level::{
    apply_bump, candidate_version, compare_versions, is_release_version, level_exceeds, max_level, parse_candidate_version, BumpLevel,
    FragmentKind,
};
use crate::fragment::{ReleaseFragment, UnitKey};
use crate::ledger::{diff_layers, CandidateRecord, LayerChange, Ledger, LedgerEntry, UnitLayers};
use crate::marker_reader::Severity;
use crate::units::VersionReading;
use crate::ReleaseError;

#[derive(Debug, Clone, Default)]
pub struct UnitEvidence {
    pub key: UnitKey,
    /// For display only.
    pub name: Option<String>,
    /// The version the working copy carries.
    pub version: String,
    /// Per-layer integrity of the payload built from the working copy.
    pub layers: UnitLayers,
    /// The publish base these layers were built against.
    pub registry: Option<String>,
    /// Units whose version this unit's payload names.
    pub imports: Vec<UnitKey>,
    /// Files of other units this unit's build inlined, by owner.
    pub inlines: IndexMap<UnitKey, Vec<String>>,
    /// Workspace-relative files of this unit's payload.
    pub payload_files: Vec<String>,
    /// Workspace-relative files carrying this unit's version.
    pub version_files: Vec<String>,
    /// Every version location as read.
    pub version_readings: Vec<VersionReading>,
    /// Whether a release-relevant file under the unit's own directory changed.
    pub own_files_changed: bool,
    /// The highest bump allowed (`major` when absent).
    pub max_bump: Option<BumpLevel>,
}

pub struct ReleaseEvidence<'a> {
    pub units: &'a [UnitEvidence],
    pub ledger: &'a Ledger,
    pub fragments: &'a [ReleaseFragment],
    pub groups: &'a IndexMap<String, Vec<UnitKey>>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanOptions {
    /// Plan a candidate with this identifier (`rc`).
    pub candidate: Option<String>,
}

/// Why a unit is in the plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BumpReason {
    Declared { fragment: String, kind: FragmentKind },
    Inlines { unit: UnitKey, files: Vec<String> },
    Imports { unit: UnitKey },
    VersionLocation { unit: UnitKey, files: Vec<String> },
    Group { group: String },
    Unattributed,
}

impl BumpReason {
    pub fn kind(&self) -> &'static str {
        match self {
            BumpReason::Declared { .. } => "declared",
            BumpReason::Inlines { .. } => "inlines",
            BumpReason::Imports { .. } => "imports",
            BumpReason::VersionLocation { .. } => "version-location",
            BumpReason::Group { .. } => "group",
            BumpReason::Unattributed => "unattributed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangelogEntry {
    pub kind: FragmentKind,
    pub body: String,
    /// The fragment this line came from.
    pub fragment: String,
}

#[derive(Debug, Clone)]
pub struct PlannedUnit {
    pub key: UnitKey,
    pub name: String,
    pub from: String,
    pub to: String,
    pub level: BumpLevel,
    pub reasons: Vec<BumpReason>,
    /// Layers whose digest differs from the final entry's.
    pub changed: Vec<LayerChange>,
    pub entries: Vec<ChangelogEntry>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseDiagnostic {
    pub severity: Severity,
    pub code: String,
    pub message: String,
}

impl ReleaseDiagnostic {
    pub fn error(code: &str, message: String) -> ReleaseDiagnostic {
        ReleaseDiagnostic { severity: Severity::Error, code: code.to_string(), message }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReleasePlan {
    /// Moving units in edge order.
    pub units: Vec<PlannedUnit>,
    /// Fragments this plan consumes. None for a candidate.
    pub fragments: Vec<String>,
    pub diagnostics: Vec<ReleaseDiagnostic>,
    pub candidate: Option<String>,
}

/// An edge `from` → `to`: `from` must move when `to` does.
struct Edge {
    to: UnitKey,
    reason: BumpReason,
    /// An import edge bumps unconditionally; an inline edge only explains drift.
    explains_drift_only: bool,
}

struct Reasons {
    by_unit: IndexMap<UnitKey, Vec<BumpReason>>,
    credited: HashSet<String>,
}

impl Reasons {
    fn add(&mut self, key: &str, reason: BumpReason, id: String) {
        if !self.credited.insert(id) {
            return;
        }
        self.by_unit.entry(key.to_string()).or_default().push(reason);
    }
}

pub fn plan_release(evidence: &ReleaseEvidence<'_>, options: &PlanOptions) -> Result<ReleasePlan, ReleaseError> {
    let mut diagnostics = Vec::new();
    let by_key: IndexMap<&str, &UnitEvidence> = evidence.units.iter().map(|u| (u.key.as_str(), u)).collect();
    let groups = evidence.groups;
    let mut group_of: IndexMap<&str, &str> = IndexMap::new();
    for (name, members) in groups {
        for member in members {
            group_of.insert(member, name);
        }
    }

    let mut drift: IndexMap<UnitKey, Vec<LayerChange>> = IndexMap::new();
    for unit in evidence.units {
        if let Some(mismatch) = judge_unit_versions(&unit.key, &unit.version_readings) {
            diagnostics.push(mismatch);
        }
        let Some(recorded) = evidence.ledger.units.get(&unit.key) else { continue };
        let recorded_registry = recorded.registry.as_deref().filter(|r| !r.is_empty());
        let unit_registry = unit.registry.as_deref().filter(|r| !r.is_empty());
        if let (Some(recorded_registry), Some(unit_registry)) = (recorded_registry, unit_registry) {
            if recorded_registry != unit_registry {
                diagnostics.push(ReleaseDiagnostic::error(
                    "LEDGER_REGISTRY_MISMATCH",
                    format!(
                        "{}: its ledger digests were taken against '{recorded_registry}', but this run built against '{unit_registry}', so the two are digests of different bytes. Publish to the recorded base, or re-record with `release verify --write`.",
                        unit.key
                    ),
                ));
                continue;
            }
        }
        let candidate_version = recorded.candidate.as_ref().map(|c| c.version.as_str());
        if recorded.version.as_deref() != Some(unit.version.as_str()) && candidate_version != Some(unit.version.as_str()) {
            diagnostics.push(ReleaseDiagnostic::error(
                "LEDGER_VERSION_MISMATCH",
                format!(
                    "{} carries version {} but the ledger records {}{}. The digests beside it were taken at that version, so nothing here can be compared. Reconcile with `release verify` — or, if the version was moved by hand, restore it and let `release apply` move it.",
                    unit.key,
                    unit.version,
                    recorded.version.as_deref().unwrap_or("no final version"),
                    candidate_version.map(|v| format!(" and candidate {v}")).unwrap_or_default()
                ),
            ));
            continue;
        }
        if recorded.version.is_none() {
            continue;
        }
        let changes = diff_layers(&recorded.layers, &unit.layers);
        if !changes.is_empty() {
            drift.insert(unit.key.clone(), changes);
        }
    }

    let edges = edges_of(evidence.units);
    let mut levels: IndexMap<UnitKey, BumpLevel> = IndexMap::new();
    let mut reasons = Reasons { by_unit: IndexMap::new(), credited: HashSet::new() };

    let mut consumed: BTreeSet<String> = BTreeSet::new();
    for fragment in evidence.fragments {
        for (key, kind) in &fragment.units {
            if !by_key.contains_key(key.as_str()) {
                diagnostics.push(ReleaseDiagnostic::error(
                    "FRAGMENT_UNKNOWN_UNIT",
                    format!(
                        "{} names '{key}', which is not a unit in this workspace. A fragment names a unit by its workspace-relative directory path.",
                        fragment.source
                    ),
                ));
                continue;
            }
            let level = kind.level();
            consumed.insert(fragment.source.clone());
            let joined = levels.get(key).map_or(level, |current| max_level(*current, level));
            levels.insert(key.clone(), joined);
            reasons.add(
                key,
                BumpReason::Declared { fragment: fragment.source.clone(), kind: *kind },
                format!("{key}\0declared\0{}", fragment.source),
            );
        }
    }

    propagate(evidence.units, &edges, &drift, &mut levels, groups, &mut reasons);
    loop {
        let mut seeded = false;
        for unit in evidence.units {
            if levels.contains_key(&unit.key) || !drift.contains_key(&unit.key) {
                continue;
            }
            levels.insert(unit.key.clone(), BumpLevel::Patch);
            reasons.add(&unit.key, BumpReason::Unattributed, format!("{}\0unattributed", unit.key));
            seeded = true;
        }
        if !seeded {
            break;
        }
        propagate(evidence.units, &edges, &drift, &mut levels, groups, &mut reasons);
    }

    for unit in evidence.units {
        let ceiling = unit.max_bump.unwrap_or(BumpLevel::Major);
        let Some(level) = levels.get(&unit.key).copied() else { continue };
        if !level_exceeds(level, ceiling) {
            continue;
        }
        let because = reasons.by_unit.get(&unit.key).map(|list| list.iter().map(describe_reason).collect::<Vec<_>>().join("; ")).unwrap_or_default();
        diagnostics.push(ReleaseDiagnostic::error(
            "MAX_BUMP_EXCEEDED",
            format!(
                "{} needs a {} bump, above its maxBump of {}. Because: {because}. Describe the change with a kind within {}, or raise 'maxBump' in telo-workspace.yaml.",
                unit.key,
                level.as_str(),
                ceiling.as_str(),
                ceiling.as_str()
            ),
        ));
    }

    let versions = plan_versions(evidence, &levels, groups, options)?;
    let entries_by_unit = collect_changelog_entries(evidence.fragments, &by_key);
    request_missing_changelog_entries(evidence.units, &entries_by_unit, &mut diagnostics);

    let mut planned = Vec::new();
    for unit in order_by_edges(evidence.units, &edges) {
        let Some(level) = levels.get(&unit.key).copied() else { continue };
        let Some(to) = versions.get(&unit.key) else { continue };
        if *to == unit.version {
            continue;
        }
        planned.push(PlannedUnit {
            key: unit.key.clone(),
            name: unit.name.clone().unwrap_or_else(|| unit.key.clone()),
            from: unit.version.clone(),
            to: to.clone(),
            level,
            reasons: reasons.by_unit.get(&unit.key).cloned().unwrap_or_default(),
            changed: drift.get(&unit.key).cloned().unwrap_or_default(),
            entries: entries_by_unit.get(&unit.key).cloned().unwrap_or_default(),
            group: group_of.get(unit.key.as_str()).map(|g| g.to_string()),
        });
    }

    Ok(ReleasePlan {
        units: planned,
        fragments: if options.candidate.is_some() { Vec::new() } else { consumed.into_iter().collect() },
        diagnostics,
        candidate: options.candidate.clone(),
    })
}

fn edges_of(units: &[UnitEvidence]) -> IndexMap<UnitKey, Vec<Edge>> {
    let mut edges = IndexMap::new();
    let mut owners: IndexMap<&str, &str> = IndexMap::new();
    for unit in units {
        for file in &unit.version_files {
            owners.insert(file, &unit.key);
        }
    }
    for unit in units {
        let mut list = Vec::new();
        for to in &unit.imports {
            if *to != unit.key {
                list.push(Edge { to: to.clone(), reason: BumpReason::Imports { unit: to.clone() }, explains_drift_only: false });
            }
        }
        for (to, files) in &unit.inlines {
            if *to != unit.key {
                list.push(Edge {
                    to: to.clone(),
                    reason: BumpReason::Inlines { unit: to.clone(), files: files.clone() },
                    explains_drift_only: true,
                });
            }
        }
        let mut located: IndexMap<&str, Vec<String>> = IndexMap::new();
        for file in &unit.payload_files {
            let Some(owner) = owners.get(file.as_str()).copied() else { continue };
            if owner == unit.key {
                continue;
            }
            located.entry(owner).or_default().push(file.clone());
        }
        for (to, mut files) in located {
            files.sort();
            list.push(Edge {
                to: to.to_string(),
                reason: BumpReason::VersionLocation { unit: to.to_string(), files },
                explains_drift_only: false,
            });
        }
        edges.insert(unit.key.clone(), list);
    }
    edges
}

fn raise(levels: &mut IndexMap<UnitKey, BumpLevel>, key: &str, level: BumpLevel) -> bool {
    let current = levels.get(key).copied();
    let next = current.map_or(level, |c| max_level(c, level));
    if current == Some(next) {
        return false;
    }
    levels.insert(key.to_string(), next);
    true
}

/// Raise levels along edges and across groups until nothing moves.
fn propagate(
    units: &[UnitEvidence],
    edges: &IndexMap<UnitKey, Vec<Edge>>,
    drift: &IndexMap<UnitKey, Vec<LayerChange>>,
    levels: &mut IndexMap<UnitKey, BumpLevel>,
    groups: &IndexMap<String, Vec<UnitKey>>,
    reasons: &mut Reasons,
) {
    let mut moved = true;
    while moved {
        moved = false;
        for unit in units {
            for edge in edges.get(&unit.key).into_iter().flatten() {
                if edge.explains_drift_only && !drift.contains_key(&unit.key) {
                    continue;
                }
                let Some(from) = levels.get(&edge.to).copied() else { continue };
                reasons.add(&unit.key, edge.reason.clone(), format!("{}\0{}\0{}", unit.key, edge.to, edge.reason.kind()));
                moved = raise(levels, &unit.key, from) || moved;
            }
        }
        for (name, members) in groups {
            let level = members.iter().filter_map(|m| levels.get(m).copied()).reduce(max_level);
            let Some(level) = level else { continue };
            for member in members {
                if !units.iter().any(|u| u.key == *member) {
                    continue;
                }
                if raise(levels, member, level) {
                    reasons.add(member, BumpReason::Group { group: name.clone() }, format!("{member}\0group"));
                    moved = true;
                }
            }
        }
    }
}

fn plan_versions(
    evidence: &ReleaseEvidence<'_>,
    levels: &IndexMap<UnitKey, BumpLevel>,
    groups: &IndexMap<String, Vec<UnitKey>>,
    options: &PlanOptions,
) -> Result<IndexMap<UnitKey, String>, ReleaseError> {
    let mut finals: IndexMap<UnitKey, String> = IndexMap::new();
    for unit in evidence.units {
        let Some(level) = levels.get(&unit.key).copied() else { continue };
        if let Some(final_version) = final_of(unit, evidence.ledger.units.get(&unit.key), level)? {
            finals.insert(unit.key.clone(), final_version);
        }
    }
    for members in groups.values() {
        let mut shared: Vec<String> = members.iter().filter_map(|m| finals.get(m).cloned()).collect();
        shared.sort_by(|a, b| compare_versions(a, b));
        let Some(shared) = shared.pop() else { continue };
        for member in members {
            if finals.contains_key(member) {
                finals.insert(member.clone(), shared.clone());
            }
        }
    }
    let Some(id) = &options.candidate else {
        return Ok(finals);
    };
    let mut ks: IndexMap<UnitKey, u64> = IndexMap::new();
    for unit in evidence.units {
        let Some(final_version) = finals.get(&unit.key) else { continue };
        let record: Option<&CandidateRecord> = evidence.ledger.units.get(&unit.key).and_then(|e| e.candidate.as_ref());
        let previous = record.and_then(|r| parse_candidate_version(&r.version));
        let k = match (record, previous) {
            (Some(record), Some(previous)) if previous.final_version == *final_version && previous.id == *id => {
                if diff_layers(&record.layers, &unit.layers).is_empty() {
                    previous.k
                } else {
                    previous.k + 1
                }
            }
            _ => 1,
        };
        ks.insert(unit.key.clone(), k);
    }
    for members in groups.values() {
        let shared = members.iter().filter_map(|m| ks.get(m).copied()).max().unwrap_or(0);
        for member in members {
            if ks.contains_key(member) {
                ks.insert(member.clone(), shared);
            }
        }
    }
    Ok(finals.into_iter().map(|(key, final_version)| {
        let k = ks[&key];
        let version = candidate_version(&final_version, id, k);
        (key, version)
    }).collect())
}

fn final_of(unit: &UnitEvidence, recorded: Option<&LedgerEntry>, level: BumpLevel) -> Result<Option<String>, ReleaseError> {
    if let Some(version) = recorded.and_then(|r| r.version.as_deref()) {
        return apply_bump(version, level).map(Some);
    }
    if let Some(candidate) = parse_candidate_version(&unit.version) {
        return Ok(Some(candidate.final_version));
    }
    if is_release_version(&unit.version) {
        return apply_bump(&unit.version, level).map(Some);
    }
    Ok(None)
}

/// `UNIT_VERSION_MISMATCH` when a unit's version locations disagree or one
/// holds no version.
pub fn judge_unit_versions(key: &str, readings: &[VersionReading]) -> Option<ReleaseDiagnostic> {
    let values: HashSet<Option<&str>> = readings.iter().map(|r| r.value.as_deref()).collect();
    if readings.is_empty() || (values.len() == 1 && !values.contains(&None)) {
        return None;
    }
    let described: Vec<String> = readings
        .iter()
        .map(|reading| {
            let location = match reading.pointer.as_deref().filter(|p| !p.is_empty()) {
                Some(pointer) => format!("{}#{pointer}", reading.file),
                None => reading.file.clone(),
            };
            match &reading.value {
                Some(value) => format!("{location} holds {value}"),
                None => format!(
                    "{location} holds no version{}",
                    reading.error.as_ref().filter(|e| !e.is_empty()).map(|e| format!(" ({e})")).unwrap_or_default()
                ),
            }
        })
        .collect();
    Some(ReleaseDiagnostic::error(
        "UNIT_VERSION_MISMATCH",
        format!(
            "{key}: its version locations disagree — {}. A unit has one version; restore the moved one and let `release apply` move them together.",
            described.join(", ")
        ),
    ))
}

fn describe_reason(reason: &BumpReason) -> String {
    match reason {
        BumpReason::Declared { fragment, kind } => format!("{fragment} declares {}", kind.as_str()),
        BumpReason::Imports { unit } => format!("it imports {unit}"),
        BumpReason::Inlines { unit, .. } => format!("it inlines {unit}"),
        BumpReason::VersionLocation { unit, .. } => format!("its payload holds {unit}'s version"),
        BumpReason::Group { group } => format!("it shares group '{group}'"),
        BumpReason::Unattributed => "its payload moved".to_string(),
    }
}

fn collect_changelog_entries(fragments: &[ReleaseFragment], by_key: &IndexMap<&str, &UnitEvidence>) -> IndexMap<UnitKey, Vec<ChangelogEntry>> {
    let mut entries: IndexMap<UnitKey, Vec<ChangelogEntry>> = IndexMap::new();
    for fragment in fragments {
        for (key, kind) in &fragment.units {
            if !by_key.contains_key(key.as_str()) {
                continue;
            }
            entries.entry(key.clone()).or_default().push(ChangelogEntry {
                kind: *kind,
                body: fragment.body.clone(),
                fragment: fragment.source.clone(),
            });
        }
    }
    entries
}

/// One warning naming every unit whose own files changed with no fragment.
fn request_missing_changelog_entries(
    units: &[UnitEvidence],
    entries: &IndexMap<UnitKey, Vec<ChangelogEntry>>,
    diagnostics: &mut Vec<ReleaseDiagnostic>,
) {
    let missing: Vec<&str> = units.iter().filter(|u| u.own_files_changed && !entries.contains_key(&u.key)).map(|u| u.key.as_str()).collect();
    if missing.is_empty() {
        return;
    }
    diagnostics.push(ReleaseDiagnostic {
        severity: Severity::Warning,
        code: "CHANGELOG_ENTRY_REQUESTED".into(),
        message: format!(
            "{} unit(s) have their own changes but no fragment describes them, so their changelogs will not mention this release: {}. One `release add` can name them all.",
            missing.len(),
            missing.join(", ")
        ),
    });
}

/// Edge order — a dependency before its dependents. A cycle keeps key order.
fn order_by_edges<'a>(units: &'a [UnitEvidence], edges: &IndexMap<UnitKey, Vec<Edge>>) -> Vec<&'a UnitEvidence> {
    let by_key: IndexMap<&str, &UnitEvidence> = units.iter().map(|u| (u.key.as_str(), u)).collect();
    let mut ordered = Vec::new();
    let mut state: HashSet<String> = HashSet::new();
    fn visit<'a>(
        key: &str,
        by_key: &IndexMap<&str, &'a UnitEvidence>,
        edges: &IndexMap<UnitKey, Vec<Edge>>,
        state: &mut HashSet<String>,
        ordered: &mut Vec<&'a UnitEvidence>,
    ) {
        let Some(unit) = by_key.get(key).copied() else { return };
        if !state.insert(key.to_string()) {
            return;
        }
        let targets: BTreeSet<&str> = edges.get(key).into_iter().flatten().map(|e| e.to.as_str()).collect();
        for to in targets {
            visit(to, by_key, edges, state, ordered);
        }
        ordered.push(unit);
    }
    let mut keys: Vec<&str> = by_key.keys().copied().collect();
    keys.sort();
    for key in keys {
        visit(key, &by_key, edges, &mut state, &mut ordered);
    }
    ordered
}

/// Anything `order_by_imports` orders: a key and the keys it imports.
pub trait Imports {
    fn key(&self) -> &str;
    fn imports(&self) -> &[UnitKey];
}

/// Units in import order — a dependency before its dependents.
pub fn order_by_imports<T: Imports>(units: Vec<T>) -> Vec<T> {
    let mut by_key: IndexMap<String, T> = IndexMap::new();
    for unit in units {
        by_key.insert(unit.key().to_string(), unit);
    }
    let mut order: Vec<String> = Vec::new();
    let mut state: HashSet<String> = HashSet::new();
    fn visit<T: Imports>(key: &str, by_key: &IndexMap<String, T>, state: &mut HashSet<String>, order: &mut Vec<String>) {
        let Some(unit) = by_key.get(key) else { return };
        if !state.insert(key.to_string()) {
            return;
        }
        let mut imports: Vec<&UnitKey> = unit.imports().iter().collect();
        imports.sort();
        for to in imports {
            visit(to, by_key, state, order);
        }
        order.push(key.to_string());
    }
    let mut keys: Vec<String> = by_key.keys().cloned().collect();
    keys.sort();
    for key in &keys {
        visit(key, &by_key, &mut state, &mut order);
    }
    order.into_iter().map(|key| by_key.shift_remove(&key).expect("ordered key")).collect()
}

/// What a unit's layers read after `apply` wrote its version.
#[derive(Debug, Clone)]
pub struct RecordedReading {
    pub layers: UnitLayers,
    pub registry: Option<String>,
}

/// The ledger after `apply`.
pub fn record_release(ledger: &Ledger, plan: &ReleasePlan, readings: &IndexMap<UnitKey, RecordedReading>) -> Ledger {
    let mut units: IndexMap<UnitKey, LedgerEntry> = IndexMap::new();
    for (key, entry) in &ledger.units {
        if plan.candidate.is_some() {
            units.insert(key.clone(), entry.clone());
        } else if entry.version.is_some() {
            units.insert(
                key.clone(),
                LedgerEntry {
                    version: entry.version.clone(),
                    registry: entry.registry.clone().filter(|r| !r.is_empty()),
                    layers: entry.layers.clone(),
                    candidate: None,
                },
            );
        }
    }
    for unit in &plan.units {
        let Some(reading) = readings.get(&unit.key) else { continue };
        let reading_registry = reading.registry.clone().filter(|r| !r.is_empty());
        if plan.candidate.is_some() {
            let mut entry = units.get(&unit.key).cloned().unwrap_or_default();
            if reading_registry.is_some() && entry.registry.as_deref().filter(|r| !r.is_empty()).is_none() {
                entry.registry = reading_registry;
            }
            entry.candidate = Some(CandidateRecord { version: unit.to.clone(), layers: reading.layers.clone() });
            units.insert(unit.key.clone(), entry);
        } else {
            units.insert(
                unit.key.clone(),
                LedgerEntry { version: Some(unit.to.clone()), registry: reading_registry, layers: reading.layers.clone(), candidate: None },
            );
        }
    }
    Ledger { units }
}
