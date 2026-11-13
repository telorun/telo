//! The evidence half of an ecosystem, and the collection that turns a
//! workspace into the planner's `UnitEvidence`.
//!
//! An adapter's evidence half — registered beside its pure half by the host
//! program — builds the anchor's layer as a file set, finds its import edges,
//! names where it publishes, and reads a published layer back. The collection
//! here asks each anchor's half and adds what no adapter owns: the declared
//! `payload:` layer, `metafile:` inline edges, every version location read, and
//! whether the unit's own files changed.

use std::collections::BTreeSet;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::fragment::UnitKey;
use telorun_glob::last_match_index;
use crate::ledger::{AnchorDigest, Ledger, UnitLayers};
use crate::release_plan::{ReleaseDiagnostic, ReleasePlan, UnitEvidence};
use crate::units::{read_unit_versions, ResolvedAnchor, ResolvedUnit};
use crate::yaml::json_string;
use crate::ReleaseError;

use super::declared_payload::declared_payload;
use super::git::changed_files_since_base;
use super::metafile::metafile_inlines;
use super::workspace::ReleaseWorkspace;

/// A command's parsed options, for a host's own.
pub type Argv = Map<String, Value>;

pub struct SessionOptions<'a> {
    pub ledger: &'a Ledger,
    pub argv: &'a Argv,
}

/// One anchor of one unit.
#[derive(Clone, Copy)]
pub struct AnchorRef<'a> {
    pub unit: &'a ResolvedUnit,
    pub anchor: &'a ResolvedAnchor,
}

#[derive(Debug, Clone, Default)]
pub struct AnchorEvidence {
    /// The anchor's layer; absent when it contributes none.
    pub layer: Option<AnchorDigest>,
    /// Workspace-relative files the layer holds.
    pub files: Vec<String>,
    /// Units whose version this anchor's payload names.
    pub imports: Vec<UnitKey>,
    /// Files of other units this anchor's build inlined, by owner.
    pub inlines: IndexMap<UnitKey, Vec<String>>,
    /// The publish base the layer was built against.
    pub registry: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadBack {
    /// Nothing to read the layer back from.
    Unverifiable { reason: String },
    Absent,
    Published {
        /// What the ledger records for the anchor once reconciled.
        layer: AnchorDigest,
        /// The layers on which the recorded digest disagrees with the registry.
        drift: Vec<String>,
    },
}

/// One workspace's evidence for one ecosystem.
pub trait EvidenceSession {
    /// What is wrong before any layer is built.
    fn diagnostics(&self) -> Vec<ReleaseDiagnostic> {
        Vec::new()
    }
    fn collect(&self, reference: AnchorRef<'_>) -> Result<AnchorEvidence, ReleaseError>;
    /// Import edges alone, cheaply, for `order`.
    fn imports(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError>;
    /// The publish base the anchor's bytes are built against.
    fn registry(&self, reference: AnchorRef<'_>) -> Option<String> {
        let _ = reference;
        None
    }
    /// Where the anchor publishes; `None` when the cascade names nothing.
    fn destination(&self, reference: AnchorRef<'_>) -> Option<String> {
        let _ = reference;
        None
    }
    /// The anchor's layer as published at `version`; `None`: no read-back.
    fn read_back(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Option<Result<ReadBack, ReleaseError>> {
        let _ = (reference, version, recorded);
        None
    }
    /// Every version published; `None` when the ecosystem cannot list them.
    fn published_versions(&self, reference: AnchorRef<'_>) -> Option<Result<Vec<String>, ReleaseError>> {
        let _ = reference;
        None
    }
    /// Writes `apply` makes beside the version locations, workspace-relative.
    fn after_stamp(&self, reference: AnchorRef<'_>, version: &str, plan: &ReleasePlan) -> Result<Vec<String>, ReleaseError> {
        let _ = (reference, version, plan);
        Ok(Vec::new())
    }
}

pub trait EvidenceAdapter: Send + Sync {
    fn ecosystem(&self) -> &'static str;
    /// An anchor of it publishes to a destination its settings must name.
    fn needs_destination(&self) -> bool {
        false
    }
    fn open<'a>(&self, workspace: &'a ReleaseWorkspace, options: &SessionOptions<'_>) -> Result<Box<dyn EvidenceSession + 'a>, ReleaseError>;
}

pub type Sessions<'a> = IndexMap<String, Box<dyn EvidenceSession + 'a>>;

pub fn open_sessions<'a>(
    workspace: &'a ReleaseWorkspace,
    adapters: &[std::sync::Arc<dyn EvidenceAdapter>],
    options: &SessionOptions<'_>,
) -> Result<Sessions<'a>, ReleaseError> {
    let used: BTreeSet<&str> = workspace.units.iter().flat_map(|u| u.anchors.iter().map(|a| a.ecosystem.as_str())).collect();
    let mut sessions = IndexMap::new();
    for adapter in adapters {
        if used.contains(adapter.ecosystem()) {
            sessions.insert(adapter.ecosystem().to_string(), adapter.open(workspace, options)?);
        }
    }
    Ok(sessions)
}

pub fn session_of<'s, 'a>(sessions: &'s Sessions<'a>, ecosystem: &str) -> Result<&'s (dyn EvidenceSession + 'a), ReleaseError> {
    sessions.get(ecosystem).map(|s| s.as_ref()).ok_or_else(|| {
        ReleaseError::new(format!(
            "No evidence is registered for the '{ecosystem}' ecosystem in this host, so its layers cannot be built."
        ))
    })
}

/// Whether an anchor publishes something of its own.
pub fn publishes(anchor: &ResolvedAnchor) -> bool {
    anchor.package.contributes_layer
}

/// `NO_DESTINATION_KNOWN` and destination collisions, across every row.
pub fn destination_diagnostics(
    workspace: &ReleaseWorkspace,
    adapters: &[std::sync::Arc<dyn EvidenceAdapter>],
    sessions: &Sessions<'_>,
) -> Vec<ReleaseDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut claimed: IndexMap<String, String> = IndexMap::new();
    for unit in &workspace.units {
        for anchor in &unit.anchors {
            if !publishes(anchor) {
                continue;
            }
            let destination = sessions.get(&anchor.ecosystem).and_then(|s| s.destination(AnchorRef { unit, anchor }));
            let row = format!("{} ({} at {})", unit.key, anchor.ecosystem, anchor.anchor);
            let Some(destination) = destination else {
                if adapters.iter().find(|a| a.ecosystem() == anchor.ecosystem).is_some_and(|a| a.needs_destination()) {
                    diagnostics.push(ReleaseDiagnostic::error(
                        "NO_DESTINATION_KNOWN",
                        format!(
                            "{row} publishes, but nothing names where: no 'registry' at the anchor (ecosystem: {{ {}: {{ {}: {{ registry: … }} }} }}) or under 'release.ecosystems.{}'.",
                            anchor.ecosystem,
                            json_string(&anchor.anchor),
                            anchor.ecosystem
                        ),
                    ));
                }
                continue;
            };
            if let Some(other) = claimed.get(&destination) {
                diagnostics.push(ReleaseDiagnostic::error(
                    "DESTINATION_COLLISION",
                    format!("{other} and {row} both publish to '{destination}'. Give one of them another name or registry."),
                ));
                continue;
            }
            claimed.insert(destination, row);
        }
    }
    diagnostics
}

/// Shown each unit as its evidence is collected: the unit, its index, the count.
pub type UnitProgress<'a> = dyn Fn(&ResolvedUnit, usize, usize) + 'a;

pub struct CollectOptions<'a> {
    pub base_ref: &'a str,
    pub on_unit: Option<&'a UnitProgress<'a>>,
    /// Collect these units only.
    pub only: Option<&'a BTreeSet<UnitKey>>,
}

pub fn collect_evidence(workspace: &ReleaseWorkspace, sessions: &Sessions<'_>, options: &CollectOptions<'_>) -> Result<Vec<UnitEvidence>, ReleaseError> {
    let changed = changed_units(workspace, options.base_ref);
    let units: Vec<&ResolvedUnit> = workspace.units.iter().filter(|u| options.only.is_none_or(|only| only.contains(&u.key))).collect();
    let mut evidence = Vec::new();
    for (index, unit) in units.iter().enumerate() {
        if let Some(on_unit) = options.on_unit {
            on_unit(unit, index, units.len());
        }
        evidence.push(unit_evidence(workspace, sessions, unit, changed.contains(&unit.key))?);
    }
    Ok(evidence)
}

/// One unit's layers, as `apply` records them and `collect_evidence` reads them.
pub fn unit_evidence(
    workspace: &ReleaseWorkspace,
    sessions: &Sessions<'_>,
    unit: &ResolvedUnit,
    own_files_changed: bool,
) -> Result<UnitEvidence, ReleaseError> {
    let mut layers = UnitLayers::default();
    let mut payload_files: BTreeSet<String> = BTreeSet::new();
    let mut imports: BTreeSet<UnitKey> = BTreeSet::new();
    let mut inlines: IndexMap<UnitKey, BTreeSet<String>> = IndexMap::new();
    let mut registry: Option<String> = None;
    for anchor in &unit.anchors {
        let found = session_of(sessions, &anchor.ecosystem)?.collect(AnchorRef { unit, anchor })?;
        if let Some(layer) = found.layer {
            layers.ecosystems.entry(anchor.ecosystem.clone()).or_default().insert(anchor.anchor.clone(), layer);
        }
        payload_files.extend(found.files);
        imports.extend(found.imports.into_iter().filter(|key| *key != unit.key));
        for (key, files) in found.inlines {
            inlines.entry(key).or_default().extend(files);
        }
        if registry.is_none() {
            registry = found.registry;
        }
    }
    if unit.payload.is_some() {
        let declared = declared_payload(&workspace.root, unit)?;
        layers.payload = Some(declared.digest);
        payload_files.extend(declared.files);
    }
    if unit.metafile.is_some() {
        for (key, files) in metafile_inlines(workspace, unit)? {
            inlines.entry(key).or_default().extend(files);
        }
    }
    let read = |relative: &str| workspace.tree_read(relative);
    let readings = read_unit_versions(unit, &read, &workspace.adapters);
    let mut version_files: Vec<String> = Vec::new();
    for location in &unit.version_locations {
        if !version_files.contains(&location.file) {
            version_files.push(location.file.clone());
        }
    }
    Ok(UnitEvidence {
        key: unit.key.clone(),
        name: unit.anchors.first().and_then(|a| a.package.name.clone()).filter(|n| !n.is_empty()),
        version: readings.first().and_then(|r| r.value.clone()).unwrap_or_default(),
        layers,
        registry: registry.filter(|r| !r.is_empty()),
        imports: imports.into_iter().collect(),
        inlines: inlines.into_iter().map(|(key, files)| (key, files.into_iter().collect())).collect(),
        payload_files: payload_files.into_iter().collect(),
        version_files,
        version_readings: readings,
        own_files_changed,
        max_bump: Some(unit.max_bump),
    })
}

/// The unit owning a workspace-relative path: the nearest enclosing unit.
pub fn owning_unit<'a>(units: &'a [ResolvedUnit], file: &str) -> Option<&'a ResolvedUnit> {
    let mut best: Option<&ResolvedUnit> = None;
    for unit in units {
        let inside = unit.dir.is_empty() || file == unit.dir || file.starts_with(&format!("{}/", unit.dir));
        if inside && best.is_none_or(|b| unit.dir.len() > b.dir.len()) {
            best = Some(unit);
        }
    }
    best
}

/// Units with a change of their own since the base, less what each unit's
/// `ignore` list leaves out. With no merge base nothing is requested.
fn changed_units(workspace: &ReleaseWorkspace, base_ref: &str) -> BTreeSet<UnitKey> {
    let Ok(files) = changed_files_since_base(&workspace.root, base_ref) else {
        return BTreeSet::new();
    };
    let mut changed = BTreeSet::new();
    for file in files {
        let Some(unit) = owning_unit(&workspace.units, &file) else { continue };
        let rest = if unit.dir.is_empty() { file.as_str() } else { file.get(unit.dir.len() + 1..).unwrap_or("") };
        if let Some(ignored) = last_match_index(rest, &unit.ignore) {
            if !unit.ignore[ignored].starts_with('!') {
                continue;
            }
        }
        changed.insert(unit.key.clone());
    }
    changed
}

impl ReleaseWorkspace {
    /// A workspace-relative file as the tree holds it.
    pub fn tree_read(&self, relative: &str) -> Option<String> {
        use crate::units::WorkspaceTree;
        self.tree.read_file(relative)
    }
}
