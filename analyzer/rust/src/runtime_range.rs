//! The runtime range of one module version, over the readers of `requires:` (`requires_block`)
//! and `restrictions:` (`restrictions`). Mirrors the load half of
//! `../../nodejs/src/runtime-range.ts`: at load a version's range is its own `requires` narrowed
//! by its own entries that cover it, so a pinned run stays deterministic and offline.
//!
//! Node's `selectionRange` — a candidate's range narrowed by what the newest speaking newer
//! version says about it — has no twin: only `telo upgrade` and the editors select versions, and
//! no Rust host does. Every constraint carries where it came from, so a refusal names the entry
//! and its reason.

use crate::module_version_order::parse_module_version;
use crate::requires_block::{
    read_requires, HostAxis, HostVersions, ReadRequiresResult, RequiresBlock, KNOWN_HOST_AXES,
};
use crate::restrictions::{declaring_version, read_restrictions, restriction_covers, ReadRestrictionsResult, Restriction};
use crate::version_range::{is_unsatisfiable, range_accepts, split_build_metadata, VersionComparator, VersionRange};

/// A requirement key: the telo surface, or a host axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequirementKey {
    Telo,
    Host(HostAxis),
}

/// Every key, in the order a range is judged: `telo` first.
pub fn requirement_keys() -> impl Iterator<Item = RequirementKey> {
    std::iter::once(RequirementKey::Telo).chain(KNOWN_HOST_AXES.into_iter().map(RequirementKey::Host))
}

/// Where a constraint was stated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequirementSource {
    /// The version's own `requires:` block.
    Requires,
    /// A `restrictions:` entry of the version `version`.
    Restriction { version: Option<String>, index: usize, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeConstraint {
    pub key: RequirementKey,
    pub range: VersionRange,
    pub source: RequirementSource,
}

/// One module version's runtime requirements, as its own doc states them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleRequirements {
    /// The doc's `metadata.version`, else the version its caller addressed it by.
    pub version: Option<String>,
    pub requires: ReadRequiresResult,
    pub restrictions: ReadRestrictionsResult,
}

/// Read the requirements off a module doc. `addressed_as` names the version when the doc
/// carries no `metadata.version` of its own.
pub fn read_module_requirements(doc: &serde_json::Value, addressed_as: Option<&str>) -> ModuleRequirements {
    ModuleRequirements {
        version: declaring_version(doc).or(addressed_as).map(str::to_string),
        requires: read_requires(doc),
        restrictions: read_restrictions(doc),
    }
}

/// The version's load range: its own `requires` and its own covering entries. `own_ceiling`
/// false leaves out the upper bound of its own `requires.telo` — refused in a module's own
/// source, so not enforced beside its refusal.
pub fn load_range(module: &ModuleRequirements, own_ceiling: bool) -> Vec<RangeConstraint> {
    let mut out = block_constraints(&module.requires.block, &RequirementSource::Requires, own_ceiling);
    let version = module.version.as_deref();
    for entry in &module.restrictions.entries {
        if restriction_covers(entry, version, version) {
            out.extend(entry_constraints(entry, version));
        }
    }
    out
}

/// What a runtime concluded about a range it is outside of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeRefusal {
    /// The runtime is below a floor (`Newer`) or above a ceiling (`Older`).
    pub direction: Direction,
    pub key: RequirementKey,
    /// The bound it failed, as written: `>=0.121.0`, `<0.122.0`, `>=unreleased`.
    pub bound: String,
    /// The failed comparator; absent for `>=unreleased`.
    pub comparator: Option<VersionComparator>,
    pub running: String,
    pub source: RequirementSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Newer,
    Older,
}

/// Judge a range against a runtime: `telo` first, then each host axis; on each, every floor
/// before any ceiling. A key whose running version is not supplied, or cannot be parsed, is not
/// judged. `Ok(())` when satisfied.
pub fn evaluate_range(
    constraints: &[RangeConstraint],
    telo_version: Option<&str>,
    host: &HostVersions,
) -> Result<(), RangeRefusal> {
    for key in requirement_keys() {
        let running = match key {
            RequirementKey::Telo => telo_version,
            RequirementKey::Host(axis) => host.get(axis),
        };
        let Some(running) = running.filter(|running| !running.is_empty()) else { continue };
        let (core, unreleased) = split_build_metadata(running);
        if parse_module_version(core).is_none() {
            continue;
        }
        let on_key: Vec<&RangeConstraint> = constraints.iter().filter(|c| c.key == key).collect();
        for c in &on_key {
            if c.range.unreleased && !unreleased {
                return Err(RangeRefusal {
                    direction: Direction::Newer,
                    key,
                    bound: c.range.raw.clone(),
                    comparator: None,
                    running: running.to_string(),
                    source: c.source.clone(),
                });
            }
            if let Some(floor) = c.range.comparators.iter().find(|cmp| cmp.operator.is_lower() && !holds(cmp, core)) {
                return Err(failed(Direction::Newer, key, floor, running, &c.source));
            }
        }
        for c in &on_key {
            if let Some(ceiling) = c.range.comparators.iter().find(|cmp| cmp.operator.is_upper() && !holds(cmp, core)) {
                return Err(failed(Direction::Older, key, ceiling, running, &c.source));
            }
        }
    }
    Ok(())
}

/// True when some version meets every range at once. `>=unreleased` lies above every published
/// release, so it meets no ceiling, which must name one.
pub fn ranges_overlap(ranges: &[&VersionRange]) -> bool {
    let comparators: Vec<VersionComparator> = ranges.iter().flat_map(|r| r.comparators.iter().cloned()).collect();
    if ranges.iter().any(|r| r.unreleased) && comparators.iter().any(|c| c.operator.is_upper()) {
        return false;
    }
    if comparators.is_empty() {
        return true;
    }
    !is_unsatisfiable(&VersionRange { raw: String::new(), comparators, unreleased: false })
}

/// The range of `block` on `key`.
pub fn range_of(block: &RequiresBlock, key: RequirementKey) -> Option<&VersionRange> {
    match key {
        RequirementKey::Telo => block.telo.as_ref(),
        RequirementKey::Host(axis) => block.host.get(axis),
    }
}

/// `range` without its upper bounds, or `None` when nothing is left.
pub fn floor_of(range: &VersionRange) -> Option<VersionRange> {
    if range.unreleased {
        return Some(range.clone());
    }
    let comparators: Vec<VersionComparator> = range.comparators.iter().filter(|c| c.operator.is_lower()).cloned().collect();
    if comparators.is_empty() {
        return None;
    }
    let raw = comparators.iter().map(|c| format!("{}{}", c.operator.text(), c.raw)).collect::<Vec<_>>().join(" ");
    Some(VersionRange { raw, comparators, unreleased: false })
}

fn block_constraints(block: &RequiresBlock, source: &RequirementSource, own_ceiling: bool) -> Vec<RangeConstraint> {
    requirement_keys()
        .filter_map(|key| {
            let range = range_of(block, key)?;
            let range = if key == RequirementKey::Telo && !own_ceiling { floor_of(range)? } else { range.clone() };
            Some(RangeConstraint { key, range, source: source.clone() })
        })
        .collect()
}

fn entry_constraints(entry: &Restriction, version: Option<&str>) -> Vec<RangeConstraint> {
    let source = restriction_source(entry, version);
    requirement_keys()
        .filter_map(|key| range_of(&entry.requires, key).map(|range| RangeConstraint { key, range: range.clone(), source: source.clone() }))
        .collect()
}

fn restriction_source(entry: &Restriction, version: Option<&str>) -> RequirementSource {
    RequirementSource::Restriction { version: version.map(str::to_string), index: entry.index, reason: entry.reason.clone() }
}

fn holds(cmp: &VersionComparator, core: &str) -> bool {
    range_accepts(&VersionRange { raw: cmp.raw.clone(), comparators: vec![cmp.clone()], unreleased: false }, core)
}

fn failed(direction: Direction, key: RequirementKey, comparator: &VersionComparator, running: &str, source: &RequirementSource) -> RangeRefusal {
    RangeRefusal {
        direction,
        key,
        bound: format!("{}{}", comparator.operator.text(), comparator.raw),
        comparator: Some(comparator.clone()),
        running: running.to_string(),
        source: source.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn module(doc: Value) -> ModuleRequirements {
        let mut full = json!({ "kind": "Telo.Library", "metadata": { "name": "Geocode", "version": "1.2.1" } });
        for (key, value) in doc.as_object().unwrap() {
            full[key] = value.clone();
        }
        read_module_requirements(&full, None)
    }

    fn load(doc: Value) -> Vec<RangeConstraint> {
        load_range(&module(doc), true)
    }

    fn telo(raw: &str) -> Vec<RangeConstraint> {
        load(json!({ "requires": { "telo": raw } }))
    }

    fn no_host() -> HostVersions {
        HostVersions::default()
    }

    fn node(version: &str) -> HostVersions {
        HostVersions { node: Some(version.to_string()) }
    }

    #[test]
    fn passes_inside_the_range_and_fails_outside_it() {
        assert!(evaluate_range(&telo(">=0.80.0"), Some("0.80.0"), &no_host()).is_ok());
        let refusal = evaluate_range(&telo(">=0.80.0"), Some("0.76.0"), &no_host()).unwrap_err();
        assert_eq!((refusal.direction, refusal.bound.as_str()), (Direction::Newer, ">=0.80.0"));
    }

    #[test]
    fn treats_an_absent_declaration_as_no_requirement() {
        assert!(evaluate_range(&load(json!({})), Some("0.1.0"), &no_host()).is_ok());
    }

    #[test]
    fn treats_a_running_version_it_cannot_parse_as_satisfied() {
        for running in [None, Some("0.76"), Some("2024.1"), Some("dev"), Some("v"), Some("")] {
            assert!(evaluate_range(&telo(">=0.80.0"), running, &no_host()).is_ok(), "{running:?}");
        }
    }

    #[test]
    fn meets_the_unreleased_floor_only_with_a_build_of_the_pending_release() {
        let refusal = evaluate_range(&telo(">=unreleased"), Some("0.120.3"), &no_host()).unwrap_err();
        assert_eq!(
            (refusal.direction, refusal.bound.as_str(), refusal.running.as_str()),
            (Direction::Newer, ">=unreleased", "0.120.3")
        );
        assert!(evaluate_range(&telo(">=unreleased"), Some("0.121.0+unreleased"), &no_host()).is_ok());
    }

    #[test]
    fn compares_an_unreleased_build_by_its_version() {
        assert!(evaluate_range(&telo(">=0.122.0"), Some("0.121.0+unreleased"), &no_host()).is_err());
        assert!(evaluate_range(&telo(">=0.121.0"), Some("0.121.0+unreleased"), &no_host()).is_ok());
    }

    #[test]
    fn judges_a_host_axis_only_against_a_supplied_version() {
        let range = load(json!({ "requires": { "host": { "node": ">=20.0.0" } } }));
        assert!(evaluate_range(&range, Some("0.1.0"), &no_host()).is_ok());
        let refusal = evaluate_range(&range, Some("0.1.0"), &node("18.19.0")).unwrap_err();
        assert_eq!((refusal.key, refusal.running.as_str()), (RequirementKey::Host(HostAxis::Node), "18.19.0"));
    }

    #[test]
    fn reports_the_telo_skew_before_any_host_axis() {
        let range = load(json!({ "requires": { "telo": ">=0.90.0", "host": { "node": ">=99.0.0" } } }));
        assert_eq!(evaluate_range(&range, Some("0.76.0"), &node("20.0.0")).unwrap_err().key, RequirementKey::Telo);
    }

    #[test]
    fn reports_a_runtime_above_a_ceiling_as_needing_an_older_one() {
        let refusal = evaluate_range(&telo(">=0.121.0 <0.122.0"), Some("0.122.0"), &no_host()).unwrap_err();
        assert_eq!(
            (refusal.direction, refusal.bound.as_str(), refusal.source),
            (Direction::Older, "<0.122.0", RequirementSource::Requires)
        );
        // Without its own ceiling, the floor alone is enforced.
        let floor = load_range(&module(json!({ "requires": { "telo": ">=0.121.0 <0.122.0" } })), false);
        assert!(evaluate_range(&floor, Some("0.122.0"), &no_host()).is_ok());
    }

    #[test]
    fn narrows_the_version_s_own_requires_by_its_own_covering_entries() {
        let range = load(json!({
            "requires": { "telo": ">=0.121.0" },
            "restrictions": [
                { "versions": ">=1.2.0", "requires": { "telo": "<0.122.0" }, "reason": "Lookup never returns." },
                { "versions": "<=1.2.0", "requires": { "host": { "node": "<24.0.0" } }, "reason": "Crashes on Node 24." },
            ],
        }));
        let refusal = evaluate_range(&range, Some("0.122.0"), &no_host()).unwrap_err();
        assert_eq!(refusal.direction, Direction::Older);
        assert_eq!(
            refusal.source,
            RequirementSource::Restriction { version: Some("1.2.1".into()), index: 0, reason: "Lookup never returns.".into() }
        );
        assert!(evaluate_range(&range, Some("0.121.0"), &node("24.0.0")).is_ok());
    }

    #[test]
    fn applies_an_entry_without_versions_to_the_declaring_doc() {
        let range = load(json!({
            "requires": { "telo": ">=0.121.0" },
            "restrictions": [{ "requires": { "telo": ">=unreleased" }, "reason": "Needs the next kernel." }],
        }));
        let refusal = evaluate_range(&range, Some("0.121.0"), &no_host()).unwrap_err();
        assert_eq!((refusal.direction, refusal.bound.as_str()), (Direction::Newer, ">=unreleased"));
        assert!(matches!(refusal.source, RequirementSource::Restriction { index: 0, .. }));
    }

    #[test]
    fn finds_no_overlap_between_an_unreleased_floor_and_a_ceiling() {
        let read = |raw: &str| read_requires(&json!({ "requires": { "telo": raw } })).block.telo.unwrap();
        let (unreleased, ceiling, floor) = (read(">=unreleased"), read("<0.4.0"), read(">=0.5.0"));
        assert!(!ranges_overlap(&[&unreleased, &ceiling]));
        assert!(!ranges_overlap(&[&floor, &ceiling]));
        assert!(ranges_overlap(&[&unreleased, &floor]));
        assert_eq!(floor_of(&read(">=0.1.0 <0.4.0")).map(|r| r.raw).as_deref(), Some(">=0.1.0"));
        assert_eq!(floor_of(&ceiling), None);
    }
}
