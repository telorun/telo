//! The release commands' work, over any host's adapters: plan, apply, verify,
//! order and tag. The argument wiring is `commands`; what touches the tree is
//! here.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::bump_level::{compare_versions, is_candidate_id, is_release_version, parse_candidate_version};
use crate::changelog::{prepend_changelog_release, render_changelog_release, ChangelogRelease, CHANGELOG_FILE};
use crate::fragment::{ReleaseFragment, UnitKey};
use crate::ledger::{parse_ledger, AnchorDigest, Ledger, LedgerEntry, ParseLedgerOptions, UnitLayers, LEDGER_PATH};
use crate::locale_order::locale_compare;
use crate::release_plan::{
    order_by_imports, plan_release, record_release, Imports, PlanOptions as CorePlanOptions, RecordedReading, ReleaseDiagnostic,
    ReleaseEvidence, ReleasePlan, UnitEvidence,
};
use crate::units::{read_unit_versions, stamp_unit_version, ResolvedUnit};
use crate::ReleaseError;

use super::carried_changes::{carried_by, CarriedQuery};
use super::evidence::{
    collect_evidence, destination_diagnostics, open_sessions, publishes, session_of, unit_evidence, AnchorRef, Argv, CollectOptions,
    ReadBack, SessionOptions, Sessions, UnitProgress,
};
use super::git::{create_tag, file_at, head_commit, tag_commit};
use super::host::ReleaseHost;
use super::ledger_store::{delete_fragment, read_fragments, read_ledger, write_ledger};
use super::workspace::{load_release_workspace, read_workspace_file, LoadOptions, ReleaseWorkspace};

fn ledger_options(host: &ReleaseHost) -> ParseLedgerOptions<'_> {
    ParseLedgerOptions { legacy_layers: host.ledger.as_deref() }
}

pub fn load_workspace_for(host: &ReleaseHost, from: &Path) -> Result<ReleaseWorkspace, ReleaseError> {
    load_release_workspace(
        from,
        &LoadOptions {
            adapters: &host.adapters,
            ecosystem_hosts: &host.ecosystem_hosts,
            read_marker: host.read_marker.as_deref(),
            command: &host.command,
        },
    )
}

/// The pending fragments, less those `reference` carries.
pub fn pending_fragments(root: &Path, reference: Option<&str>) -> Result<Vec<ReleaseFragment>, ReleaseError> {
    let fragments = read_fragments(root)?;
    let Some(reference) = reference.filter(|r| !r.is_empty()) else { return Ok(fragments) };
    let files: Vec<String> = fragments.iter().map(|f| f.source.clone()).collect();
    let carried = carried_by(&CarriedQuery { cwd: root, files: &files, reference, at: None })?;
    Ok(fragments.into_iter().filter(|f| !carried.contains(&f.source)).collect())
}

pub struct PlanRun {
    pub ledger: Ledger,
    pub evidence: Vec<UnitEvidence>,
    pub plan: ReleasePlan,
}

pub struct PlanOptions<'a> {
    pub base_ref: &'a str,
    pub carried_by: Option<&'a str>,
    pub candidate: Option<String>,
    pub on_unit: Option<&'a UnitProgress<'a>>,
}

/// The plan of one workspace. What is decidable before any layer is built is
/// checked first and short-circuits.
pub fn plan_workspace_release(
    host: &ReleaseHost,
    workspace: &ReleaseWorkspace,
    argv: &Argv,
    options: &PlanOptions<'_>,
) -> Result<PlanRun, ReleaseError> {
    let ledger = read_ledger(&workspace.root, &ledger_options(host))?;
    let fragments = pending_fragments(&workspace.root, options.carried_by)?;
    let sessions = open_sessions(workspace, &host.evidence, &SessionOptions { ledger: &ledger, argv })?;
    let upfront = upfront_diagnostics(host, workspace, &sessions);
    if upfront.iter().any(|d| d.severity == crate::marker_reader::Severity::Error) {
        return Ok(PlanRun { ledger, evidence: Vec::new(), plan: ReleasePlan { diagnostics: upfront, ..ReleasePlan::default() } });
    }
    let evidence = collect_evidence(workspace, &sessions, &CollectOptions { base_ref: options.base_ref, on_unit: options.on_unit, only: None })?;
    let mut plan = plan_release(
        &ReleaseEvidence { units: &evidence, ledger: &ledger, fragments: &fragments, groups: &workspace.release.groups },
        &CorePlanOptions { candidate: options.candidate.clone() },
    )?;
    let mut diagnostics = upfront;
    diagnostics.append(&mut plan.diagnostics);
    plan.diagnostics = diagnostics;
    Ok(PlanRun { ledger, evidence, plan })
}

pub fn upfront_diagnostics(host: &ReleaseHost, workspace: &ReleaseWorkspace, sessions: &Sessions<'_>) -> Vec<ReleaseDiagnostic> {
    let mut out = workspace.diagnostics.clone();
    for session in sessions.values() {
        out.extend(session.diagnostics());
    }
    out.extend(destination_diagnostics(workspace, &host.evidence, sessions));
    out
}

/// The candidate identifier `--candidate` names, `rc` when it names none.
pub fn candidate_id(value: Option<&str>) -> Result<Option<String>, ReleaseError> {
    let Some(value) = value else { return Ok(None) };
    let id = if value.is_empty() { "rc" } else { value };
    if !is_candidate_id(id) {
        return Err(ReleaseError::new(format!(
            "'{id}' is not a candidate identifier: lowercase letters and digits, starting with a letter (rc, beta)."
        )));
    }
    Ok(Some(id.to_string()))
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

pub struct Applied {
    pub key: UnitKey,
    pub from: String,
    pub to: String,
    /// Workspace-relative paths written for this unit.
    pub files: Vec<String>,
}

fn write_file(root: &Path, file: &str, text: &str) -> Result<(), ReleaseError> {
    let path = root.join(file);
    fs::write(&path, text).map_err(|err| ReleaseError::new(format!("{}: {err}", path.display())))
}

/// The bytes every file an apply may write held before it began, so an apply
/// that fails — a stamp, a host hook, or the reading the ledger is recorded
/// from — leaves the tree as it found it rather than half-versioned.
struct ApplyJournal<'a> {
    root: &'a Path,
    originals: IndexMap<String, Option<String>>,
}

impl ApplyJournal<'_> {
    fn remember(&mut self, file: &str) {
        if self.originals.contains_key(file) {
            return;
        }
        let path = self.root.join(file);
        let text = if path.exists() { fs::read_to_string(&path).ok() } else { None };
        self.originals.insert(file.to_string(), text);
    }

    /// Every file put back as it was; the ones that could not be, with why.
    fn restore(&self) -> Vec<String> {
        let mut failed = Vec::new();
        for (file, text) in &self.originals {
            let path = self.root.join(file);
            let result = match text {
                Some(text) => fs::write(&path, text),
                None if path.exists() => fs::remove_file(&path),
                None => Ok(()),
            };
            if let Err(err) = result {
                failed.push(format!("{file} ({err})"));
            }
        }
        failed
    }
}

/// Write the plan: every version location of each moved unit and the files
/// that move with them, its changelog (a final only), what the host adds, then
/// the ledger — recorded from a second reading taken after the versions are on
/// disk — and the consumed fragments deleted. Any failure restores every file
/// written, so the ledger is never recorded from a failed reading and no
/// version is left stamped without it.
pub fn apply_plan(
    host: &ReleaseHost,
    workspace: &ReleaseWorkspace,
    run: &PlanRun,
    argv: &Argv,
    date: &str,
) -> Result<(Vec<Applied>, Vec<String>), ReleaseError> {
    let mut journal = ApplyJournal { root: &workspace.root, originals: IndexMap::new() };
    // A hook writes the files it names itself, after the fact: every version
    // location in the workspace is what a hook moves, so all are kept up front.
    for unit in &workspace.units {
        for location in &unit.version_locations {
            journal.remember(&location.file);
        }
    }
    journal.remember(LEDGER_PATH);
    for fragment in &run.plan.fragments {
        journal.remember(fragment);
    }
    let mut hook_writes: Vec<String> = Vec::new();
    match apply_journaled(host, workspace, run, argv, date, &mut journal, &mut hook_writes) {
        Ok(done) => Ok(done),
        Err(error) => {
            let failed = journal.restore();
            let mut left: Vec<String> = hook_writes.iter().filter(|f| !journal.originals.contains_key(f.as_str())).cloned().collect();
            left.extend(failed);
            let tail = if left.is_empty() {
                ".".to_string()
            } else {
                format!(", except {}, which could not be restored and must be checked by hand.", left.join(", "))
            };
            Err(ReleaseError::new(format!(
                "{error}\nThe apply was undone: every version, changelog and ledger file it wrote is restored{tail}"
            )))
        }
    }
}

fn apply_journaled(
    host: &ReleaseHost,
    workspace: &ReleaseWorkspace,
    run: &PlanRun,
    argv: &Argv,
    date: &str,
    journal: &mut ApplyJournal<'_>,
    hook_writes: &mut Vec<String>,
) -> Result<(Vec<Applied>, Vec<String>), ReleaseError> {
    let plan = &run.plan;
    let read = |relative: &str| read_workspace_file(workspace, relative);
    let sessions = open_sessions(workspace, &host.evidence, &SessionOptions { ledger: &run.ledger, argv })?;
    let mut applied = Vec::new();
    for planned in &plan.units {
        let Some(unit) = workspace.units.iter().find(|u| u.key == planned.key) else { continue };
        let mut files: Vec<String> = Vec::new();
        let mut write = |file: &str, text: &str, files: &mut Vec<String>| -> Result<(), ReleaseError> {
            journal.remember(file);
            write_file(&workspace.root, file, text)?;
            if !files.iter().any(|f| f == file) {
                files.push(file.to_string());
            }
            Ok(())
        };
        for (file, text) in stamp_unit_version(unit, &planned.to, &read, &workspace.adapters)? {
            write(&file, &text, &mut files)?;
        }
        for location in &unit.version_locations {
            let base = location.file.rsplit('/').next().unwrap_or(&location.file);
            if let Some(handler) = workspace.adapters.handler_for(base) {
                for companion in handler.companions(&location.file, &planned.to, &read)? {
                    write(&companion.file, &companion.text, &mut files)?;
                }
            }
        }
        for anchor in &unit.anchors {
            let session = session_of(&sessions, &anchor.ecosystem)?;
            for file in session.after_stamp(AnchorRef { unit, anchor }, &planned.to, plan)? {
                hook_writes.push(file.clone());
                if !files.contains(&file) {
                    files.push(file);
                }
            }
        }
        if plan.candidate.is_none() && !planned.entries.is_empty() {
            let changelog = if unit.dir.is_empty() { CHANGELOG_FILE.to_string() } else { format!("{}/{CHANGELOG_FILE}", unit.dir) };
            let release = ChangelogRelease {
                version: &planned.to,
                date,
                entries: planned.entries.iter().map(|e| (e.kind, e.body.as_str())).collect(),
            };
            let text = prepend_changelog_release(read(&changelog).as_deref(), &render_changelog_release(&release));
            write(&changelog, &text, &mut files)?;
        }
        applied.push(Applied { key: planned.key.clone(), from: planned.from.clone(), to: planned.to.clone(), files });
    }
    let extra = match &host.after_apply {
        Some(after) => after(workspace, plan, argv)?,
        None => Vec::new(),
    };
    hook_writes.extend(extra.iter().cloned());
    drop(sessions);

    let after = load_workspace_for(host, &workspace.root)?;
    let recorded = recorded_ledger(host, &after, &run.ledger, plan, argv)?;
    write_ledger(&workspace.root, &recorded)?;
    for fragment in &plan.fragments {
        delete_fragment(&workspace.root, fragment)?;
    }
    let mut written: Vec<String> = Vec::new();
    for file in applied.iter().flat_map(|u| u.files.iter()).chain(&extra).cloned().chain([LEDGER_PATH.to_string()]).chain(plan.fragments.iter().cloned()) {
        if !written.contains(&file) {
            written.push(file);
        }
    }
    Ok((applied, written))
}

/// The ledger once this plan is published, read from the tree as it now is.
pub fn recorded_ledger(host: &ReleaseHost, workspace: &ReleaseWorkspace, ledger: &Ledger, plan: &ReleasePlan, argv: &Argv) -> Result<Ledger, ReleaseError> {
    let sessions = open_sessions(workspace, &host.evidence, &SessionOptions { ledger, argv })?;
    let planned: BTreeSet<&str> = plan.units.iter().map(|u| u.key.as_str()).collect();
    let mut readings = IndexMap::new();
    for unit in &workspace.units {
        if !planned.contains(unit.key.as_str()) {
            continue;
        }
        let evidence = unit_evidence(workspace, &sessions, unit, false)?;
        readings.insert(unit.key.clone(), RecordedReading { layers: evidence.layers, registry: evidence.registry });
    }
    Ok(record_release(ledger, plan, &readings))
}

// ---------------------------------------------------------------------------
// order
// ---------------------------------------------------------------------------

pub struct OrderRow {
    pub key: UnitKey,
    pub ecosystem: Option<String>,
    /// The workspace-relative directory to publish from.
    pub path: String,
    pub version: String,
    pub destination: Option<String>,
    pub group: Option<String>,
    /// The units this one's payload names, which publish first.
    pub imports: Vec<UnitKey>,
}

impl OrderRow {
    /// The row as the Node twin writes it, key order included.
    pub fn to_json(&self) -> Value {
        let mut row = Map::new();
        row.insert("key".into(), Value::String(self.key.clone()));
        row.insert("version".into(), Value::String(self.version.clone()));
        if let Some(group) = &self.group {
            row.insert("group".into(), Value::String(group.clone()));
        }
        row.insert("imports".into(), Value::Array(self.imports.iter().cloned().map(Value::String).collect()));
        if let Some(ecosystem) = &self.ecosystem {
            row.insert("ecosystem".into(), Value::String(ecosystem.clone()));
        }
        row.insert("path".into(), Value::String(self.path.clone()));
        if let Some(destination) = &self.destination {
            row.insert("destination".into(), Value::String(destination.clone()));
        }
        Value::Object(row)
    }
}

struct OrderUnit<'a> {
    key: UnitKey,
    unit: &'a ResolvedUnit,
    imports: Vec<UnitKey>,
}

impl Imports for OrderUnit<'_> {
    fn key(&self) -> &str {
        &self.key
    }

    fn imports(&self) -> &[UnitKey] {
        &self.imports
    }
}

/// One row per unit and publishing anchor, units in edge order, one unit's
/// rows together and sorted by ecosystem. Reads edges only.
pub fn order_rows(host: &ReleaseHost, workspace: &ReleaseWorkspace, argv: &Argv) -> Result<(Vec<OrderRow>, Vec<ReleaseDiagnostic>), ReleaseError> {
    let ledger = read_ledger(&workspace.root, &ledger_options(host))?;
    let sessions = open_sessions(workspace, &host.evidence, &SessionOptions { ledger: &ledger, argv })?;
    let diagnostics = upfront_diagnostics(host, workspace, &sessions);
    if diagnostics.iter().any(|d| d.severity == crate::marker_reader::Severity::Error) {
        return Ok((Vec::new(), diagnostics));
    }
    let mut units = Vec::new();
    for unit in &workspace.units {
        let mut imports = BTreeSet::new();
        for anchor in &unit.anchors {
            for key in session_of(&sessions, &anchor.ecosystem)?.imports(AnchorRef { unit, anchor })? {
                if key != unit.key {
                    imports.insert(key);
                }
            }
        }
        units.push(OrderUnit { key: unit.key.clone(), unit, imports: imports.into_iter().collect() });
    }
    let read = |relative: &str| workspace.tree_read(relative);
    let mut rows = Vec::new();
    for OrderUnit { unit, imports, .. } in order_by_imports(units) {
        let version = read_unit_versions(unit, &read, &workspace.adapters).first().and_then(|r| r.value.clone()).unwrap_or_default();
        if unit.anchors.is_empty() {
            rows.push(OrderRow {
                key: unit.key.clone(),
                ecosystem: None,
                path: if unit.dir.is_empty() { ".".into() } else { unit.dir.clone() },
                version,
                destination: None,
                group: unit.group.clone(),
                imports,
            });
            continue;
        }
        let mut anchors: Vec<_> = unit.anchors.iter().collect();
        anchors.sort_by(|a, b| {
            if a.ecosystem == b.ecosystem {
                locale_compare(&a.anchor, &b.anchor)
            } else {
                locale_compare(&a.ecosystem, &b.ecosystem)
            }
        });
        for anchor in anchors {
            if !publishes(anchor) {
                continue;
            }
            let destination = session_of(&sessions, &anchor.ecosystem)?.destination(AnchorRef { unit, anchor });
            rows.push(OrderRow {
                key: unit.key.clone(),
                ecosystem: Some(anchor.ecosystem.clone()),
                path: if anchor.dir.is_empty() { ".".into() } else { anchor.dir.clone() },
                version: version.clone(),
                destination,
                group: unit.group.clone(),
                imports: imports.clone(),
            });
        }
    }
    Ok((rows, diagnostics))
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct VerifyFinding {
    pub key: UnitKey,
    pub layer: String,
    /// `drift` or `unverifiable`.
    pub kind: &'static str,
    pub detail: String,
}

impl VerifyFinding {
    pub fn to_json(&self) -> Value {
        let mut finding = Map::new();
        finding.insert("key".into(), Value::String(self.key.clone()));
        finding.insert("layer".into(), Value::String(self.layer.clone()));
        finding.insert("kind".into(), Value::String(self.kind.into()));
        finding.insert("detail".into(), Value::String(self.detail.clone()));
        Value::Object(finding)
    }
}

pub struct Verified {
    pub findings: Vec<VerifyFinding>,
    pub ledger: Ledger,
    pub diagnostics: Vec<ReleaseDiagnostic>,
}

/// Reconcile the ledger against the registries, per layer. A layer with no
/// read-back keeps its recorded digest and is reported unverifiable. A unit
/// carrying a candidate version is reconciled as a candidate record beside the
/// newest final published below it.
pub fn verify_ledger(host: &ReleaseHost, workspace: &ReleaseWorkspace, argv: &Argv, progress: &dyn Fn(&str)) -> Result<Verified, ReleaseError> {
    let ledger = read_ledger(&workspace.root, &ledger_options(host))?;
    let sessions = open_sessions(workspace, &host.evidence, &SessionOptions { ledger: &ledger, argv })?;
    let diagnostics = upfront_diagnostics(host, workspace, &sessions);
    if diagnostics.iter().any(|d| d.severity == crate::marker_reader::Severity::Error) {
        return Ok(Verified { findings: Vec::new(), ledger, diagnostics });
    }
    let mut findings = Vec::new();
    let mut units: IndexMap<UnitKey, LedgerEntry> = ledger.units.clone();
    let read = |relative: &str| workspace.tree_read(relative);
    for (index, unit) in workspace.units.iter().enumerate() {
        progress(&format!("  [{}/{}] {}", index + 1, workspace.units.len(), unit.key));
        let Some(version) = read_unit_versions(unit, &read, &workspace.adapters).first().and_then(|r| r.value.clone()).filter(|v| !v.is_empty()) else {
            continue;
        };
        let recorded = ledger.units.get(&unit.key);
        let registry = registry_of(unit, &sessions);
        if let Some(candidate) = parse_candidate_version(&version) {
            let final_version = match recorded.and_then(|r| r.version.clone()) {
                Some(version) => Some(version),
                None => newest_final_below(unit, &sessions, &candidate.final_version)?,
            };
            let final_reading = match &final_version {
                Some(final_version) => Some(reconcile(unit, &sessions, final_version, recorded.map(|r| &r.layers), &mut findings)?),
                None => None,
            };
            let record = reconcile(unit, &sessions, &version, recorded.and_then(|r| r.candidate.as_ref()).map(|c| &c.layers), &mut findings)?;
            let final_published = final_reading.as_ref().is_some_and(|f| f.0);
            let entry = LedgerEntry {
                version: if final_published { final_version.clone() } else { None },
                registry: registry.clone(),
                layers: if final_published { final_reading.as_ref().map(|f| f.1.clone()).unwrap_or_default() } else { UnitLayers::default() },
                candidate: record.0.then(|| crate::ledger::CandidateRecord { version: version.clone(), layers: record.1.clone() }),
            };
            if !final_published && !record.0 {
                units.shift_remove(&unit.key);
            } else {
                units.insert(unit.key.clone(), entry);
            }
            continue;
        }
        if !is_release_version(&version) {
            continue;
        }
        let was = recorded.filter(|r| r.version.as_deref() == Some(version.as_str())).map(|r| &r.layers);
        let (published, layers) = reconcile(unit, &sessions, &version, was, &mut findings)?;
        if !published {
            if let Some(recorded_version) = recorded.and_then(|r| r.version.clone()) {
                findings.push(VerifyFinding {
                    key: unit.key.clone(),
                    layer: "*".into(),
                    kind: "drift",
                    detail: format!("the ledger records {recorded_version}, which is not published"),
                });
                units.shift_remove(&unit.key);
            }
            continue;
        }
        if recorded.is_none() {
            findings.push(VerifyFinding {
                key: unit.key.clone(),
                layer: "*".into(),
                kind: "drift",
                detail: format!("published at {version}, but the ledger has no entry"),
            });
        }
        units.insert(unit.key.clone(), LedgerEntry { version: Some(version), registry, layers, candidate: None });
    }
    Ok(Verified { findings, ledger: Ledger { units }, diagnostics })
}

fn registry_of(unit: &ResolvedUnit, sessions: &Sessions<'_>) -> Option<String> {
    unit.anchors
        .iter()
        .find_map(|anchor| sessions.get(&anchor.ecosystem)?.registry(AnchorRef { unit, anchor }).filter(|r| !r.is_empty()))
}

fn newest_final_below(unit: &ResolvedUnit, sessions: &Sessions<'_>, final_version: &str) -> Result<Option<String>, ReleaseError> {
    for anchor in &unit.anchors {
        let Some(session) = sessions.get(&anchor.ecosystem) else { continue };
        if !publishes(anchor) {
            continue;
        }
        let Some(listed) = session.published_versions(AnchorRef { unit, anchor }) else { continue };
        let mut versions: Vec<String> = listed?
            .into_iter()
            .filter(|v| is_release_version(v) && compare_versions(v, final_version) == std::cmp::Ordering::Less)
            .collect();
        versions.sort_by(|a, b| compare_versions(a, b));
        return Ok(versions.pop());
    }
    Ok(None)
}

/// Every layer of `unit` at `version`, read back where it can be; `true` when
/// it counts as published.
fn reconcile(
    unit: &ResolvedUnit,
    sessions: &Sessions<'_>,
    version: &str,
    recorded: Option<&UnitLayers>,
    findings: &mut Vec<VerifyFinding>,
) -> Result<(bool, UnitLayers), ReleaseError> {
    let mut ecosystems: IndexMap<String, IndexMap<String, AnchorDigest>> = IndexMap::new();
    let mut published = false;
    let mut verifiable = false;
    let mut kept = false;
    for anchor in &unit.anchors {
        if !publishes(anchor) {
            continue;
        }
        let reference = AnchorRef { unit, anchor };
        let was = recorded.and_then(|r| r.ecosystems.get(&anchor.ecosystem)).and_then(|a| a.get(&anchor.anchor));
        let layer = format!("{}/{}", anchor.ecosystem, anchor.anchor);
        let session = session_of(sessions, &anchor.ecosystem)?;
        let answer = match session.read_back(reference, version, was) {
            Some(answer) => answer?,
            None => ReadBack::Unverifiable { reason: format!("the {} ecosystem has no registry to read it back from", anchor.ecosystem) },
        };
        match answer {
            ReadBack::Unverifiable { reason } => {
                findings.push(VerifyFinding {
                    key: unit.key.clone(),
                    layer,
                    kind: "unverifiable",
                    detail: format!("{reason}; its recorded digest is kept"),
                });
                if let Some(was) = was {
                    ecosystems.entry(anchor.ecosystem.clone()).or_default().insert(anchor.anchor.clone(), was.clone());
                    kept = true;
                }
            }
            ReadBack::Absent => {
                verifiable = true;
                if was.is_some() {
                    findings.push(VerifyFinding {
                        key: unit.key.clone(),
                        layer,
                        kind: "drift",
                        detail: format!("recorded at {version}, which its registry does not serve"),
                    });
                }
            }
            ReadBack::Published { layer: digest, drift } => {
                verifiable = true;
                published = true;
                for drifted in drift {
                    findings.push(VerifyFinding {
                        key: unit.key.clone(),
                        layer: drifted,
                        kind: "drift",
                        detail: format!("the ledger disagrees with what is published at {version}"),
                    });
                }
                ecosystems.entry(anchor.ecosystem.clone()).or_default().insert(anchor.anchor.clone(), digest);
            }
        }
    }
    if kept || (!verifiable && recorded.is_some()) {
        published = true;
    }
    let payload = recorded.and_then(|r| r.payload.clone());
    if unit.payload.is_some() && payload.is_some() {
        findings.push(VerifyFinding {
            key: unit.key.clone(),
            layer: "payload".into(),
            kind: "unverifiable",
            detail: "a declared payload has no read-back; its recorded digest is kept".into(),
        });
    }
    Ok((published, UnitLayers { ecosystems, payload: if unit.payload.is_some() { payload } else { None } }))
}

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

pub struct TagToCreate {
    pub tag: String,
    pub exists: bool,
}

/// The tags `<unit key>@<version>` of what the last apply moved: every unit
/// whose final or candidate version in HEAD's ledger differs from its first
/// parent's. The apply must be committed.
pub fn tags_to_create(host: &ReleaseHost, workspace: &ReleaseWorkspace) -> Result<Vec<TagToCreate>, ReleaseError> {
    let at = |rev: &str| -> Result<Ledger, ReleaseError> {
        match file_at(&workspace.root, rev, LEDGER_PATH)? {
            None => Ok(Ledger::default()),
            Some(text) => parse_ledger(&text, &format!("{rev}:{LEDGER_PATH}"), &ledger_options(host)),
        }
    };
    let working = read_workspace_file(workspace, LEDGER_PATH);
    if working != file_at(&workspace.root, "HEAD", LEDGER_PATH)? {
        return Err(ReleaseError::new(format!(
            "{LEDGER_PATH} differs from HEAD's, so the apply it records is not committed. Commit it, then tag: a tag must point at the commit holding the versions."
        )));
    }
    let head = at("HEAD")?;
    let parent = at("HEAD^")?;
    let head_sha = head_commit(&workspace.root)?;
    let mut entries: Vec<(&UnitKey, &LedgerEntry)> = head.units.iter().collect();
    entries.sort_by(|a, b| locale_compare(a.0, b.0));
    let mut tags = Vec::new();
    for (key, entry) in entries {
        let before = parent.units.get(key);
        let mut moved = Vec::new();
        if let Some(version) = &entry.version {
            if Some(version) != before.and_then(|b| b.version.as_ref()) {
                moved.push(version.clone());
            }
        }
        if let Some(candidate) = &entry.candidate {
            if Some(&candidate.version) != before.and_then(|b| b.candidate.as_ref()).map(|c| &c.version) {
                moved.push(candidate.version.clone());
            }
        }
        for version in moved {
            let tag = format!("{key}@{version}");
            let existing = tag_commit(&workspace.root, &tag);
            if let Some(existing) = &existing {
                if *existing != head_sha {
                    return Err(ReleaseError::new(format!(
                        "Tag '{tag}' already exists on {}, not on HEAD. A version is tagged once.",
                        &existing[..existing.len().min(12)]
                    )));
                }
            }
            tags.push(TagToCreate { tag, exists: existing.is_some() });
        }
    }
    Ok(tags)
}

pub fn create_tags(workspace: &ReleaseWorkspace, tags: &[TagToCreate]) -> Result<(), ReleaseError> {
    for tag in tags {
        if !tag.exists {
            create_tag(&workspace.root, &tag.tag)?;
        }
    }
    Ok(())
}
