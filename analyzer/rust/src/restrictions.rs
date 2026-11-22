//! The single reader of a module doc's `restrictions:` list — what an author knows about a
//! version's runtime range that measuring its floor cannot see: a ceiling found after publish,
//! a floor no static check reveals, a Node bound. Mirrors `../../nodejs/src/restrictions.ts`.
//!
//! A version speaks for itself and earlier ones, never for a later one: an entry without
//! `versions` covers only the declaring doc; with `versions` it covers the module versions the
//! range admits up to the declaring doc's own `metadata.version`. Lenient like
//! `requires_block`: a malformed entry is reported and left out of `entries`.

use std::cmp::Ordering;

use serde_json::Value;

use crate::module_version_order::{compare_module_versions, parse_module_version};
use crate::requires_block::{object_keys, read_requirement_map, RequirementPlace, RequiresBlock, RequiresIssue};
use crate::version_range::{describe, js_trim, parse_version_range, range_accepts, upper_bound, RangeReading, VersionRange};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restriction {
    /// The entry's position in the list, which names it: `restrictions[<index>]`.
    pub index: usize,
    /// The module versions covered, as written; absent covers only the declaring doc.
    pub versions: Option<VersionRange>,
    pub requires: RequiresBlock,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadRestrictionsResult {
    /// Whether the doc carries a `restrictions:` key, even a malformed one.
    pub declared: bool,
    /// The well-formed entries, in list order.
    pub entries: Vec<Restriction>,
    pub issues: Vec<RequiresIssue>,
}

const ENTRY_KEYS: [&str; 3] = ["versions", "requires", "reason"];

fn issue(path: String, message: String) -> RequiresIssue {
    RequiresIssue { path, message, ..RequiresIssue::default() }
}

fn entry_keys_text() -> String {
    ENTRY_KEYS.iter().map(|key| format!("'{key}'")).collect::<Vec<_>>().join(", ")
}

/// Read the list off a module doc, closing each `versions` range at the doc's own
/// `metadata.version`.
pub fn read_restrictions(doc: &Value) -> ReadRestrictionsResult {
    let Some(raw) = doc.get("restrictions") else { return ReadRestrictionsResult::default() };
    let Value::Array(items) = raw else {
        return ReadRestrictionsResult {
            declared: true,
            entries: Vec::new(),
            issues: vec![issue(
                "restrictions".into(),
                format!("'restrictions' must be a list of entries, got {}.", describe(Some(raw))),
            )],
        };
    };
    let declaring = declaring_version(doc);
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let (restriction, found) = read_entry(item, index, declaring);
        issues.extend(found);
        entries.extend(restriction);
    }
    ReadRestrictionsResult { declared: true, entries, issues }
}

fn read_entry(item: &Value, index: usize, declaring: Option<&str>) -> (Option<Restriction>, Vec<RequiresIssue>) {
    let path = format!("restrictions[{index}]");
    let mut issues = Vec::new();
    let Value::Object(entry) = item else {
        issues.push(issue(
            path.clone(),
            format!("{path} must be a mapping of {}, got {}.", entry_keys_text(), describe(Some(item))),
        ));
        return (None, issues);
    };

    for key in object_keys(entry) {
        if !ENTRY_KEYS.contains(&key) {
            issues.push(issue(
                format!("{path}.{key}"),
                format!("'{path}.{key}' is not a restriction key; an entry holds {}.", entry_keys_text()),
            ));
        }
    }

    let mut versions = None;
    if let Some(raw) = entry.get("versions") {
        let at = format!("{path}.versions");
        match (parse_version_range(Some(raw), RangeReading::Requires), declaring) {
            (Err(error), _) => {
                issues.push(RequiresIssue { hint: error.hint, ..issue(at.clone(), format!("'{at}': {}.", error.message)) })
            }
            (Ok(_), None) => issues.push(issue(
                at.clone(),
                format!(
                    "{at} needs this module's metadata.version as a three-part version, which closes the range at this version."
                ),
            )),
            (Ok(range), Some(declaring)) => {
                let past = upper_bound(&range)
                    .is_some_and(|upper| compare_module_versions(&upper.raw, declaring) == Some(Ordering::Greater));
                if past {
                    issues.push(issue(
                        at.clone(),
                        format!(
                            "{at} '{}' reaches past this module's version {declaring}; an entry covers only this version and earlier ones. Leave the upper bound off to cover through this version.",
                            range.raw
                        ),
                    ));
                } else {
                    versions = Some(range);
                }
            }
        }
    }

    let mut requires = None;
    match entry.get("requires") {
        None => issues.push(issue(
            path.clone(),
            format!("{path} has no requires; name the runtime range the covered versions are restricted to."),
        )),
        Some(raw) => {
            let at = format!("{path}.requires");
            let (block, found) = read_requirement_map(raw, &at, RequirementPlace::Restriction);
            let clean = found.is_empty();
            issues.extend(found);
            if clean {
                if block.telo.is_none() && block.host.is_empty() {
                    issues.push(issue(at.clone(), format!("{at} states no bound.")));
                } else {
                    requires = Some(block);
                }
            }
        }
    }

    let reason = entry.get("reason").and_then(Value::as_str);
    if reason.is_none_or(|reason| js_trim(reason).is_empty()) {
        issues.push(issue(
            path.clone(),
            format!("{path} has no reason; say what breaks, so whoever is held back knows why."),
        ));
    }

    match (requires, reason) {
        (Some(requires), Some(reason)) if issues.is_empty() => {
            (Some(Restriction { index, versions, requires, reason: js_trim(reason).to_string() }), issues)
        }
        _ => (None, issues),
    }
}

/// Whether `entry`, declared by the doc at `declaring`, covers `version`. Without `versions` it
/// covers only the declaring doc itself; with `versions`, every version the range admits that
/// is not later than the declaring one.
pub fn restriction_covers(entry: &Restriction, declaring: Option<&str>, version: Option<&str>) -> bool {
    let Some(range) = &entry.versions else {
        if version == declaring {
            return true;
        }
        return matches!((version, declaring), (Some(v), Some(d)) if compare_module_versions(v, d) == Some(Ordering::Equal));
    };
    let (Some(version), Some(declaring)) = (version, declaring) else { return false };
    compare_module_versions(version, declaring).is_some_and(|order| order != Ordering::Greater) && range_accepts(range, version)
}

/// The doc's own `metadata.version`, when it is one a range can be closed at.
pub fn declaring_version(doc: &Value) -> Option<&str> {
    doc.get("metadata")?.get("version")?.as_str().filter(|version| parse_module_version(version).is_some())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn geocode(restrictions: Value, version: &str) -> Value {
        json!({
            "kind": "Telo.Library",
            "metadata": { "name": "Geocode", "version": version },
            "requires": { "telo": ">=0.121.0" },
            "restrictions": restrictions,
        })
    }

    fn entry(versions: Option<&str>) -> Restriction {
        let mut item = json!({ "requires": { "telo": "<0.122.0" }, "reason": "r" });
        if let Some(versions) = versions {
            item["versions"] = json!(versions);
        }
        read_restrictions(&geocode(json!([item]), "1.2.1")).entries.remove(0)
    }

    #[test]
    fn closes_a_range_without_an_upper_bound_at_the_declaring_version() {
        let open = entry(Some(">=1.2.0"));
        let covered: Vec<bool> =
            ["1.1.0", "1.2.0", "1.2.1", "1.3.0"].iter().map(|v| restriction_covers(&open, Some("1.2.1"), Some(v))).collect();
        assert_eq!(covered, [false, true, true, false]);
    }

    #[test]
    fn covers_no_later_version_than_an_explicit_upper_bound() {
        let closed = entry(Some("<=1.2.0"));
        assert!(restriction_covers(&closed, Some("1.2.1"), Some("1.2.0")));
        assert!(!restriction_covers(&closed, Some("1.2.1"), Some("1.2.1")));
    }

    #[test]
    fn covers_only_the_declaring_doc_without_versions() {
        let own = entry(None);
        assert!(restriction_covers(&own, Some("1.2.1"), Some("1.2.1")));
        assert!(!restriction_covers(&own, Some("1.2.1"), Some("1.2.0")));
        assert!(restriction_covers(&own, None, None));
    }

    #[test]
    fn reads_the_well_formed_entries_and_reports_the_rest() {
        let read = read_restrictions(&geocode(
            json!([
                { "versions": "<=1.3.0", "requires": { "telo": "<0.122.0" }, "reason": "Reaches past." },
                { "versions": ">=1.0.0", "requires": { "telo": "<0.122.0" }, "reason": "  Kept.  " },
                { "requires": { "telo": "<0.122.0" }, "reason": "Extra.", "since": "1.0.0" },
                "a string",
            ]),
            "1.2.1",
        ));
        assert_eq!(read.entries.iter().map(|e| (e.index, e.reason.as_str())).collect::<Vec<_>>(), [(1, "Kept.")]);
        assert_eq!(
            read.issues.iter().map(|i| (i.path.as_str(), i.message.as_str())).collect::<Vec<_>>(),
            [
                (
                    "restrictions[0].versions",
                    "restrictions[0].versions '<=1.3.0' reaches past this module's version 1.2.1; an entry covers only this version and earlier ones. Leave the upper bound off to cover through this version."
                ),
                (
                    "restrictions[2].since",
                    "'restrictions[2].since' is not a restriction key; an entry holds 'versions', 'requires', 'reason'."
                ),
                ("restrictions[3]", "restrictions[3] must be a mapping of 'versions', 'requires', 'reason', got string."),
            ]
        );
    }

    #[test]
    fn needs_a_declaring_version_to_close_a_versions_range_at() {
        let doc = json!({ "kind": "Telo.Library", "metadata": { "name": "Geocode" }, "restrictions": [
            { "versions": ">=1.0.0", "requires": { "telo": "<0.122.0" }, "reason": "r" },
            { "requires": { "telo": "<0.122.0" } },
        ] });
        let messages: Vec<String> = read_restrictions(&doc).issues.into_iter().map(|i| i.message).collect();
        assert_eq!(
            messages,
            [
                "restrictions[0].versions needs this module's metadata.version as a three-part version, which closes the range at this version.",
                "restrictions[1] has no reason; say what breaks, so whoever is held back knows why.",
            ]
        );
        assert_eq!(
            read_restrictions(&json!({ "restrictions": { "a": 1 } })).issues[0].message,
            "'restrictions' must be a list of entries, got object."
        );
    }
}
