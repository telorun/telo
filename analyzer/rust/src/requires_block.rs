//! The single reader of a module doc's `requires:` block — the version ranges of runtime a
//! module declares itself verified against. Mirrors `../../nodejs/src/requires-block.ts`.
//!
//! Two tiers: `telo` names the manifest surface generation (a floor only on a module's own
//! block: `>=<version>`, or `>=unreleased`), and `host:` holds the host axes, each asserted by
//! the author and compared against the version the running host reports. `telo` is judged
//! before `host`, and before any unknown-axis complaint (`runtime_range::evaluate_range`).
//! Lenient: never fails; a malformed entry yields an issue and is left out of the block, so
//! nothing enforces a requirement its author failed to state.

use serde_json::{Map, Value};

use crate::version_range::{describe, is_unsatisfiable, js_trim, parse_version_range, upper_bound, RangeReading, VersionRange};

/// Host axes this analyzer knows — an axis is in this list only when something checks it.
pub const KNOWN_HOST_AXES: [HostAxis; 1] = [HostAxis::Node];

/// A host axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HostAxis {
    Node,
}

impl HostAxis {
    pub fn name(self) -> &'static str {
        match self {
            Self::Node => "node",
        }
    }
}

/// Top-level keys of the block. `host` is a container, `telo` a range.
const KNOWN_AXES: [&str; 2] = ["telo", "host"];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequiresBlock {
    /// The surface generation range, when declared.
    pub telo: Option<VersionRange>,
    /// Declared host axes, in [`KNOWN_HOST_AXES`]'s set. Empty when `host:` is absent.
    pub host: HostRanges,
}

/// The declared range of each host axis.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostRanges {
    pub node: Option<VersionRange>,
}

impl HostRanges {
    pub fn get(&self, axis: HostAxis) -> Option<&VersionRange> {
        match axis {
            HostAxis::Node => self.node.as_ref(),
        }
    }

    fn set(&mut self, axis: HostAxis, range: VersionRange) {
        match axis {
            HostAxis::Node => self.node = Some(range),
        }
    }

    pub fn is_empty(&self) -> bool {
        KNOWN_HOST_AXES.iter().all(|axis| self.get(*axis).is_none())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequiresIssue {
    /// Dotted path within the doc, e.g. `requires.telo` or `requires.host.node`.
    pub path: String,
    pub message: String,
    /// The spelling to use instead, when there is an unambiguous one.
    pub hint: Option<String>,
    /// An unrecognized axis, which consumers suppress while the `telo` requirement is unmet.
    pub unknown_axis: bool,
    /// An upper bound on a module's own `requires.telo`: kept in the block, since a published
    /// manifest's ceiling is honoured as a restriction of that version.
    pub ceiling: bool,
}

impl RequiresIssue {
    fn new(path: String, message: String) -> Self {
        Self { path, message, ..Self::default() }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadRequiresResult {
    /// Whether the doc carries a `requires:` key at all, even a malformed one.
    pub declared: bool,
    pub block: RequiresBlock,
    pub issues: Vec<RequiresIssue>,
}

/// Where a requirement map is written: the module doc's own `requires:`, whose `telo` is a
/// floor only, or a `restrictions:` entry's, which may also bound it from above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequirementPlace {
    Module,
    Restriction,
}

/// The `>=unreleased` floor: the telo release that will carry it, met only by a build of it.
pub const UNRELEASED_FLOOR: &str = ">=unreleased";

/// Read and parse the block off a module doc.
pub fn read_requires(doc: &Value) -> ReadRequiresResult {
    let Some(raw) = doc.get("requires") else { return ReadRequiresResult::default() };
    let (block, issues) = read_requirement_map(raw, "requires", RequirementPlace::Module);
    ReadRequiresResult { declared: true, block, issues }
}

/// One requirement map — the module's `requires:` or an entry's — at `path`.
pub fn read_requirement_map(raw: &Value, path: &str, place: RequirementPlace) -> (RequiresBlock, Vec<RequiresIssue>) {
    let mut issues = Vec::new();
    let mut block = RequiresBlock::default();

    let Value::Object(entries) = raw else {
        issues.push(RequiresIssue::new(
            path.to_string(),
            format!("'{path}' must be a mapping of axes, got {}.", describe(Some(raw))),
        ));
        return (block, issues);
    };

    for key in object_keys(entries) {
        if !KNOWN_AXES.contains(&key) {
            issues.push(RequiresIssue {
                unknown_axis: true,
                ..RequiresIssue::new(
                    format!("{path}.{key}"),
                    format!(
                        "'{path}.{key}' is not a known axis. This runtime knows {}; host requirements go under 'host'.",
                        KNOWN_AXES.iter().map(|axis| format!("'{axis}'")).collect::<Vec<_>>().join(" and ")
                    ),
                )
            });
        }
    }

    if let Some(telo) = entries.get("telo") {
        block.telo = parse_telo_at(telo, &format!("{path}.telo"), place, &mut issues);
    }

    if let Some(host) = entries.get("host") {
        match host {
            Value::Object(host) => {
                for axis_name in object_keys(host) {
                    let value = &host[axis_name];
                    let at = format!("{path}.host.{axis_name}");
                    let Some(axis) = KNOWN_HOST_AXES.into_iter().find(|axis| axis.name() == axis_name) else {
                        issues.push(RequiresIssue {
                            unknown_axis: true,
                            ..RequiresIssue::new(
                                at.clone(),
                                format!(
                                    "'{at}' is not a known host axis. This runtime knows {}.",
                                    KNOWN_HOST_AXES.iter().map(|axis| format!("'{}'", axis.name())).collect::<Vec<_>>().join(", ")
                                ),
                            )
                        });
                        continue;
                    };
                    if let Some(text) = names_unreleased(value) {
                        issues.push(RequiresIssue::new(
                            at.clone(),
                            format!(
                                "{at} '{}': unreleased names a telo release and is allowed only as a telo floor.",
                                js_trim(text)
                            ),
                        ));
                        continue;
                    }
                    if let Some(range) = parse_range_at(value, &at, &mut issues) {
                        block.host.set(axis, range);
                    }
                }
            }
            other => issues.push(RequiresIssue::new(
                format!("{path}.host"),
                format!("'{path}.host' must be a mapping of host axes, got {}.", describe(Some(other))),
            )),
        }
    }

    (block, issues)
}

/// A map's keys in ECMAScript's `Object.keys` order: integer-like keys first, ascending, then
/// the rest as written.
pub(crate) fn object_keys(map: &Map<String, Value>) -> Vec<&str> {
    let is_index = |key: &str| key.parse::<u32>().is_ok_and(|n| n != u32::MAX && n.to_string() == key);
    let mut indices: Vec<&str> = map.keys().map(String::as_str).filter(|key| is_index(key)).collect();
    indices.sort_by_key(|key| key.parse::<u32>().unwrap_or_default());
    indices.extend(map.keys().map(String::as_str).filter(|key| !is_index(key)));
    indices
}

/// The text of a string naming `unreleased` as a word (`/\bunreleased\b/`).
fn names_unreleased(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    let word = |byte: Option<&u8>| byte.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    let bytes = text.as_bytes();
    text.match_indices("unreleased")
        .any(|(at, found)| !word(at.checked_sub(1).and_then(|i| bytes.get(i))) && !word(bytes.get(at + found.len())))
        .then_some(text)
}

fn parse_telo_at(value: &Value, path: &str, place: RequirementPlace, issues: &mut Vec<RequiresIssue>) -> Option<VersionRange> {
    if let Some(text) = names_unreleased(value) {
        let text = js_trim(text);
        if text == UNRELEASED_FLOOR {
            return Some(VersionRange { raw: text.to_string(), comparators: Vec::new(), unreleased: true });
        }
        issues.push(RequiresIssue::new(
            path.to_string(),
            format!("{path} '{text}': unreleased is allowed only as the whole range '{UNRELEASED_FLOOR}'."),
        ));
        return None;
    }
    let range = parse_range_at(value, path, issues)?;
    if place == RequirementPlace::Module && upper_bound(&range).is_some() {
        issues.push(RequiresIssue {
            ceiling: true,
            ..RequiresIssue::new(
                path.to_string(),
                format!(
                    "{path} '{}' declares an upper bound; requires.telo is a floor only. Write the ceiling as a restrictions: entry without versions, which covers this version.",
                    range.raw
                ),
            )
        });
    }
    Some(range)
}

fn parse_range_at(value: &Value, path: &str, issues: &mut Vec<RequiresIssue>) -> Option<VersionRange> {
    match parse_version_range(Some(value), RangeReading::Requires) {
        Err(error) => {
            issues.push(RequiresIssue { hint: error.hint, ..RequiresIssue::new(path.to_string(), format!("'{path}': {}.", error.message)) });
            None
        }
        Ok(range) if is_unsatisfiable(&range) => {
            issues.push(RequiresIssue::new(
                path.to_string(),
                format!("'{path}': '{}' admits no version — its bounds exclude each other.", range.raw),
            ));
            None
        }
        Ok(range) => Some(range),
    }
}

/// The versions a host can speak for; an absent entry is not checked. The Rust hosts supply
/// none, so the gate judges the `telo` axis alone, as Node's does with no host to report.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostVersions {
    pub node: Option<String>,
}

impl HostVersions {
    pub fn get(&self, axis: HostAxis) -> Option<&str> {
        match axis {
            HostAxis::Node => self.node.as_deref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn read(requires: Value) -> ReadRequiresResult {
        read_requires(&json!({ "requires": requires }))
    }

    #[test]
    fn distinguishes_an_absent_block_from_an_empty_one() {
        assert!(!read_requires(&json!({})).declared);
        assert!(read(json!({})).declared);
    }

    #[test]
    fn parses_the_telo_axis_and_nested_host_axes() {
        let ReadRequiresResult { block, issues, .. } = read(json!({ "telo": ">=0.80.0", "host": { "node": ">=20.0.0" } }));
        assert_eq!(issues, []);
        assert_eq!(block.telo.map(|r| r.raw).as_deref(), Some(">=0.80.0"));
        assert_eq!(block.host.node.map(|r| r.raw).as_deref(), Some(">=20.0.0"));
    }

    #[test]
    fn rejects_a_host_axis_nothing_enforces_yet() {
        let ReadRequiresResult { block, issues, .. } = read(json!({ "host": { "rustc": ">=1.75.0" } }));
        assert!(block.host.is_empty());
        assert_eq!((issues[0].path.as_str(), issues[0].unknown_axis), ("requires.host.rustc", true));
        assert_eq!(issues[0].message, "'requires.host.rustc' is not a known host axis. This runtime knows 'node'.");
    }

    #[test]
    fn reports_an_unknown_axis_at_either_tier_and_flags_it_as_such() {
        let issues = read(json!({ "tello": ">=0.1.0", "host": { "pytohn": ">=3.0.0" } })).issues;
        assert_eq!(issues.iter().map(|i| i.path.as_str()).collect::<Vec<_>>(), ["requires.tello", "requires.host.pytohn"]);
        assert!(issues.iter().all(|i| i.unknown_axis));
        assert_eq!(
            issues[0].message,
            "'requires.tello' is not a known axis. This runtime knows 'telo' and 'host'; host requirements go under 'host'."
        );
    }

    #[test]
    fn omits_a_malformed_range_from_the_block_while_reporting_it() {
        let ReadRequiresResult { block, issues, .. } = read(json!({ "telo": "^0.80.0" }));
        assert!(block.telo.is_none());
        assert_eq!(issues[0].hint.as_deref(), Some(">=0.80.0"));
    }

    #[test]
    fn rejects_non_mapping_shapes_at_both_tiers() {
        let top = read(json!(">=0.1.0")).issues;
        assert_eq!((top[0].path.as_str(), top[0].message.as_str()), ("requires", "'requires' must be a mapping of axes, got string."));
        let host = read(json!({ "host": "node" })).issues;
        assert_eq!(
            (host[0].path.as_str(), host[0].message.as_str()),
            ("requires.host", "'requires.host' must be a mapping of host axes, got string.")
        );
        assert_eq!(read(json!(null)).issues[0].message, "'requires' must be a mapping of axes, got null.");
        assert_eq!(read(json!([])).issues[0].message, "'requires' must be a mapping of axes, got an array.");
    }

    #[test]
    fn reports_a_range_whose_bounds_exclude_each_other() {
        let ReadRequiresResult { block, issues, .. } = read(json!({ "telo": ">=0.90.0 <0.80.0" }));
        assert!(block.telo.is_none());
        assert_eq!(issues[0].message, "'requires.telo': '>=0.90.0 <0.80.0' admits no version — its bounds exclude each other.");
    }

    #[test]
    fn flags_an_upper_bound_on_requires_telo_as_a_ceiling_and_keeps_the_range() {
        let ReadRequiresResult { block, issues, .. } = read(json!({ "telo": ">=0.119.0 <0.121.0" }));
        assert_eq!(block.telo.map(|r| r.raw).as_deref(), Some(">=0.119.0 <0.121.0"));
        assert_eq!(
            issues,
            [RequiresIssue {
                path: "requires.telo".into(),
                ceiling: true,
                message: "requires.telo '>=0.119.0 <0.121.0' declares an upper bound; requires.telo is a floor only. Write the ceiling as a restrictions: entry without versions, which covers this version.".into(),
                ..RequiresIssue::default()
            }]
        );
    }

    #[test]
    fn keeps_both_bounds_on_host_node_and_on_a_restriction_s_telo() {
        let ReadRequiresResult { block, issues, .. } = read(json!({ "host": { "node": ">=20.0.0 <24.0.0" } }));
        assert_eq!(issues, []);
        assert_eq!(block.host.node.map(|r| r.raw).as_deref(), Some(">=20.0.0 <24.0.0"));
        let (block, issues) = read_requirement_map(&json!({ "telo": "<0.122.0" }), "restrictions[0].requires", RequirementPlace::Restriction);
        assert_eq!((issues, block.telo.map(|r| r.raw)), (Vec::new(), Some("<0.122.0".to_string())));
    }

    #[test]
    fn reads_the_unreleased_floor_of_the_pending_release_and_only_alone() {
        let floor = read(json!({ "telo": ">=unreleased" }));
        assert_eq!(floor.issues, []);
        assert_eq!(
            floor.block.telo,
            Some(VersionRange { raw: ">=unreleased".into(), comparators: Vec::new(), unreleased: true })
        );
        let combined = read(json!({ "telo": ">=unreleased <0.200.0" }));
        assert!(combined.block.telo.is_none());
        assert_eq!(
            combined.issues[0].message,
            "requires.telo '>=unreleased <0.200.0': unreleased is allowed only as the whole range '>=unreleased'."
        );
        let host = read(json!({ "host": { "node": ">=unreleased" } }));
        assert!(host.block.host.is_empty());
        assert_eq!(
            host.issues[0].message,
            "requires.host.node '>=unreleased': unreleased names a telo release and is allowed only as a telo floor."
        );
        // Not the word: `>=unreleasedX` is an ordinary malformed range.
        assert_eq!(
            read(json!({ "telo": ">=unreleasedX" })).issues[0].message,
            "'requires.telo': 'unreleasedX' in '>=unreleasedX' is not a three-part version (X.Y.Z, optionally -prerelease)."
        );
    }

    #[test]
    fn lists_keys_in_ecmascript_order() {
        let map = json!({ "b": 1, "10": 2, "a": 3, "2": 4 });
        assert_eq!(object_keys(map.as_object().unwrap()), ["2", "10", "b", "a"]);
    }
}
