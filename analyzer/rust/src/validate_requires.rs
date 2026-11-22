//! The strict half of `requires_block` and `restrictions`, mirroring
//! `../../nodejs/src/validate-requires.ts`: the gate judges a module's load range
//! (`runtime_range`) against this runtime and says which way the runtime is off —
//! `MODULE_REQUIRES_NEWER_RUNTIME` below a floor, `MODULE_REQUIRES_OLDER_RUNTIME` above a
//! ceiling, each carrying an entry's reason when an entry refused — and a malformed declaration
//! is `REQUIRES_INVALID` / `RESTRICTIONS_INVALID`: an error on the entry's own modules, a
//! warning on a dependency's. An unknown axis is suppressed while the gate fails, since an older
//! runtime not knowing a newer axis is a consequence of the skew.
//!
//! Where it differs, by what this build reads: a document is handed over with the module and
//! the file Node reads off the loader's `metadata.module` / `metadata.source` stamps, which the
//! Rust loader does not write — a file on disk is named in a message by its `file://` URL, the
//! canonical location Node's file sources stamp; and a module document declaring no `metadata.name` is not judged,
//! since the diagnostic Node writes for it names no resource, which this crate's diagnostic
//! cannot say — an under-report, never a finding Node does not make. A module whose `telo`
//! bound is met while its load range holds a host bound no supplied host version judges is
//! undecided ([`UndecidedModule`]): it gets no gate finding, and `requires_gate` covers its files.

use std::collections::HashSet;
use std::path::Path;

use crate::requires_block::{HostVersions, RequiresIssue};
use crate::restrictions::restriction_covers;
use crate::runtime_range::{
    evaluate_range, floor_of, load_range, range_of, ranges_overlap, read_module_requirements, requirement_keys,
    unjudged_host_constraint, Direction, ModuleRequirements, RangeRefusal, RequirementKey, RequirementSource,
};
use crate::sources::source_failure::file_url;
use crate::system_kinds::is_module_document;
use crate::telo_version::TELO_RUNNING_SURFACE;
use crate::types::{kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticResource, DiagnosticSeverity, ResourceManifest};
use crate::version_range::VersionRange;

/// The gate's codes: a module this runtime is outside the range of. Each suppresses every
/// other analysis diagnostic from that module's files.
pub const RUNTIME_GATE_CODES: [&str; 2] = ["MODULE_REQUIRES_NEWER_RUNTIME", "MODULE_REQUIRES_OLDER_RUNTIME"];

/// Whether `d` is one of the gate's.
pub fn is_runtime_gate(d: &AnalysisDiagnostic) -> bool {
    d.code.as_deref().is_some_and(|code| RUNTIME_GATE_CODES.contains(&code))
}

/// A document as the analysis reads it: the tree, the module it is declared in — Node's
/// `metadata.module` stamp, which a module document does not carry — and its file.
#[derive(Debug, Clone, Copy)]
pub struct SourcedDocument<'g> {
    pub manifest: &'g ResourceManifest,
    pub module: Option<&'g str>,
    pub source: &'g str,
}

#[derive(Debug, Clone, Default)]
pub struct ValidateRequiresOptions<'a> {
    /// Versions the running host can speak for; the Rust hosts supply none.
    pub host_versions: HostVersions,
    /// Module names owned by the entry, when the caller can distinguish them:
    /// `REQUIRES_INVALID` / `RESTRICTIONS_INVALID` are errors only on these.
    pub entry_modules: Option<&'a HashSet<String>>,
}

/// A module the gate cannot decide: its `telo` bound is met, but its enforced load range still
/// holds a host bound no supplied host version judges — `path` and `bound` the first such one, as
/// written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndecidedModule {
    pub kind: String,
    pub name: String,
    pub file: String,
    pub path: String,
    pub bound: String,
}

/// What the gate concluded of a set of documents: its findings and the modules it left undecided.
#[derive(Debug, Clone, Default)]
pub struct RequiresJudgement {
    pub diagnostics: Vec<AnalysisDiagnostic>,
    pub undecided: Vec<UndecidedModule>,
}

pub fn validate_requires(documents: &[SourcedDocument], options: &ValidateRequiresOptions) -> Vec<AnalysisDiagnostic> {
    judge_requires(documents, options).diagnostics
}

/// [`validate_requires`]'s findings, with the modules the gate left undecided.
pub fn judge_requires(documents: &[SourcedDocument], options: &ValidateRequiresOptions) -> RequiresJudgement {
    let mut out = Vec::new();
    let mut undecided = Vec::new();
    for document in documents {
        let Some(kind) = kind_of(document.manifest).filter(|kind| is_module_document(kind)) else { continue };
        let module = read_module_requirements(document.manifest, None);
        if !module.requires.declared && !module.restrictions.declared {
            continue;
        }
        let Some(name) = name_of(document.manifest) else { continue };
        let file_path = document.source;
        let label = format!("{kind}/{name}");
        let at = |path: &str| DiagnosticData {
            resource: Some(DiagnosticResource { kind: kind.to_string(), name: name.to_string() }),
            file_path: Some(file_path.to_string()),
            path: Some(path.to_string()),
            ..Default::default()
        };

        let owned = options.entry_modules.is_none_or(|modules| modules.contains(document.module.unwrap_or(name)));

        // A ceiling on the module's own `requires.telo` is refused in source and honoured in a
        // published manifest, as a restriction of that version.
        let own_ceiling = !(owned && module.requires.issues.iter().any(|issue| issue.ceiling));
        let unusable = if owned { unusable_entries(&module, own_ceiling) } else { Vec::new() };
        let mut enforced = module.clone();
        enforced.restrictions.entries.retain(|entry| !unusable.iter().any(|(index, _)| *index == entry.index));

        let range = load_range(&enforced, own_ceiling);
        let verdict = evaluate_range(&range, Some(TELO_RUNNING_SURFACE.as_str()), &options.host_versions);
        if verdict.is_ok() {
            if let Some(unjudged) = unjudged_host_constraint(&range, &options.host_versions) {
                undecided.push(UndecidedModule {
                    kind: kind.to_string(),
                    name: name.to_string(),
                    file: file_path.to_string(),
                    path: constraint_path(&unjudged.source, unjudged.key),
                    bound: unjudged.range.raw.clone(),
                });
            }
        }
        if let Err(refusal) = &verdict {
            let code = match refusal.direction {
                Direction::Newer => RUNTIME_GATE_CODES[0],
                Direction::Older => RUNTIME_GATE_CODES[1],
            };
            let message = gate_message(refusal, name, &canonical_location(file_path));
            out.push(AnalysisDiagnostic::error(code, message, at(&source_path(refusal))));
        }

        let mut report = |code: &str, issue: &RequiresIssue, unenforced: &str| {
            if issue.unknown_axis && verdict.is_err() {
                return;
            }
            let message = if owned {
                match &issue.hint {
                    Some(hint) => format!("{} Write '{hint}' instead.", issue.message),
                    None => issue.message.clone(),
                }
            } else {
                format!("{label}: {} {unenforced} Only the module's publisher can fix it.", issue.message)
            };
            let mut diagnostic = AnalysisDiagnostic::error(code, message, at(&issue.path));
            if !owned {
                diagnostic.severity = Some(DiagnosticSeverity::Warning);
            }
            out.push(diagnostic);
        };

        for issue in &module.requires.issues {
            // A dependency's ceiling is honoured, not refused.
            if issue.ceiling && !owned {
                continue;
            }
            report(
                "REQUIRES_INVALID",
                issue,
                "Its declared requirement cannot be read, so it is not enforced here and `telo upgrade` will not select this version.",
            );
        }
        let mut entry_issues: Vec<&RequiresIssue> = module.restrictions.issues.iter().collect();
        entry_issues.extend(unusable.iter().map(|(_, issue)| issue));
        entry_issues.sort_by_key(|issue| entry_order(&issue.path));
        for issue in entry_issues {
            report(
                "RESTRICTIONS_INVALID",
                issue,
                "The entry cannot be read, so it is not enforced here and `telo upgrade` will not select this version.",
            );
        }
    }
    RequiresJudgement { diagnostics: out, undecided }
}

/// The entries covering the declaring version that leave it usable by no runtime, each judged
/// against the module's own `requires` and the covering entries before it.
fn unusable_entries(module: &ModuleRequirements, own_ceiling: bool) -> Vec<(usize, RequiresIssue)> {
    let mut applying: Vec<(RequirementKey, Vec<(String, VersionRange)>)> = requirement_keys()
        .map(|key| {
            let own = range_of(&module.requires.block, key).and_then(|range| {
                if key == RequirementKey::Telo && !own_ceiling {
                    floor_of(range)
                } else {
                    Some(range.clone())
                }
            });
            (key, own.map(|range| vec![(format!("{} ", key_path("requires", key)), range)]).unwrap_or_default())
        })
        .collect();
    let applying_on = |applying: &[(RequirementKey, Vec<(String, VersionRange)>)], key| {
        applying.iter().find(|(k, _)| *k == key).map(|(_, list)| list.clone()).unwrap_or_default()
    };

    let version = module.version.as_deref();
    let mut out = Vec::new();
    for entry in &module.restrictions.entries {
        if !restriction_covers(entry, version, version) {
            continue;
        }
        let path = format!("restrictions[{}]", entry.index);
        let conflict = requirement_keys().find(|key| {
            range_of(&entry.requires, *key).is_some_and(|range| {
                let on_key = applying_on(&applying, *key);
                let mut ranges: Vec<&VersionRange> = on_key.iter().map(|(_, range)| range).collect();
                ranges.push(range);
                !ranges_overlap(&ranges)
            })
        });
        if let Some(conflict) = conflict {
            let range = range_of(&entry.requires, conflict).expect("the conflicting key's range");
            let mut parts: Vec<String> =
                applying_on(&applying, conflict).iter().map(|(label, range)| format!("{label}'{}'", range.raw)).collect();
            parts.push(format!("'{}'", range.raw));
            out.push((
                entry.index,
                RequiresIssue {
                    path: path.clone(),
                    message: format!(
                        "{path} leaves {} usable by no {}: {} do not overlap. Deprecate the module instead.",
                        version.unwrap_or("this version"),
                        runtime_name(conflict),
                        join_and(&parts)
                    ),
                    ..RequiresIssue::default()
                },
            ));
            continue;
        }
        for (key, list) in &mut applying {
            if let Some(range) = range_of(&entry.requires, *key) {
                list.push((format!("{path} "), range.clone()));
            }
        }
    }
    out
}

/// Where Node's loader says a file was read from: a file on disk as its `file://` URL, any
/// other location as it is.
fn canonical_location(source: &str) -> String {
    if Path::new(source).is_absolute() {
        file_url(Path::new(source))
    } else {
        source.to_string()
    }
}

fn gate_message(refusal: &RangeRefusal, name: &str, source: &str) -> String {
    let reason = match &refusal.source {
        RequirementSource::Restriction { reason, .. } => format!("Reason: {} ", sentence(reason)),
        RequirementSource::Requires => String::new(),
    };
    let axis = match refusal.key {
        RequirementKey::Telo => "telo".to_string(),
        RequirementKey::Host(axis) => format!("host.{}", axis.name()),
    };
    match refusal.direction {
        Direction::Newer => format!(
            "{name} requires {axis} '{}'; this runtime reports {}. {reason}Upgrade {}.",
            refusal.bound,
            refusal.running,
            runtime_name(refusal.key)
        ),
        Direction::Older => {
            let limit = refusal.comparator.as_ref().expect("a ceiling names its comparator");
            let side = if limit.operator.text() == "<=" { "at or below" } else { "below" };
            format!(
                "{source} is restricted to {axis} '{}'; this runtime reports {}. {reason}Use {} {side} {}, or another version of {name}.",
                refusal.bound,
                refusal.running,
                runtime_name(refusal.key),
                limit.raw
            )
        }
    }
}

fn source_path(refusal: &RangeRefusal) -> String {
    constraint_path(&refusal.source, refusal.key)
}

fn constraint_path(source: &RequirementSource, key: RequirementKey) -> String {
    match source {
        RequirementSource::Restriction { index, .. } => key_path(&format!("restrictions[{index}].requires"), key),
        RequirementSource::Requires => key_path("requires", key),
    }
}

/// The list position an issue's path names, so entries report in list order.
fn entry_order(path: &str) -> i64 {
    path.strip_prefix("restrictions[")
        .and_then(|rest| rest.split_once(']'))
        .filter(|(digits, _)| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|(digits, _)| digits.parse().ok())
        .unwrap_or(-1)
}

fn key_path(prefix: &str, key: RequirementKey) -> String {
    match key {
        RequirementKey::Telo => format!("{prefix}.telo"),
        RequirementKey::Host(axis) => format!("{prefix}.host.{}", axis.name()),
    }
}

fn runtime_name(key: RequirementKey) -> &'static str {
    match key {
        RequirementKey::Telo => "telo",
        RequirementKey::Host(_) => "Node.js",
    }
}

fn sentence(text: &str) -> String {
    if text.ends_with(['.', '!', '?']) {
        text.to_string()
    } else {
        format!("{text}.")
    }
}

fn join_and(parts: &[String]) -> String {
    match parts.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => parts.join(""),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn doc(requires: Value, name: &str) -> Value {
        json!({ "kind": "Telo.Library", "metadata": { "name": name }, "requires": requires })
    }

    fn judged(manifests: &[(Value, &str)], entry_modules: Option<&[&str]>) -> Vec<AnalysisDiagnostic> {
        let owned: Option<HashSet<String>> = entry_modules.map(|names| names.iter().map(|n| n.to_string()).collect());
        let documents: Vec<SourcedDocument> =
            manifests.iter().map(|(manifest, source)| SourcedDocument { manifest, module: None, source }).collect();
        validate_requires(&documents, &ValidateRequiresOptions { entry_modules: owned.as_ref(), ..Default::default() })
    }

    fn codes(diagnostics: &[AnalysisDiagnostic]) -> Vec<&str> {
        diagnostics.iter().map(|d| d.code.as_deref().unwrap_or_default()).collect()
    }

    #[test]
    fn gates_a_module_the_runtime_is_too_old_for() {
        let diagnostics = judged(&[(doc(json!({ "telo": ">=999.0.0" }), "SQL"), "/SQL/telo.yaml")], None);
        assert_eq!(codes(&diagnostics), ["MODULE_REQUIRES_NEWER_RUNTIME"]);
        assert_eq!(diagnostics[0].severity, Some(DiagnosticSeverity::Error));
        assert_eq!(
            diagnostics[0].message,
            format!("SQL requires telo '>=999.0.0'; this runtime reports {}. Upgrade telo.", *TELO_RUNNING_SURFACE)
        );
        assert_eq!(diagnostics[0].data.as_ref().and_then(|d| d.path.as_deref()), Some("requires.telo"));
    }

    #[test]
    fn refuses_an_upper_bound_on_the_entry_s_own_requires_telo_without_gating_on_it() {
        let diagnostics = judged(&[(doc(json!({ "telo": ">=0.1.0 <0.2.0" }), "Mine"), "/Mine/telo.yaml")], Some(&["Mine"]));
        assert_eq!(codes(&diagnostics), ["REQUIRES_INVALID"]);
        assert_eq!(diagnostics[0].severity, Some(DiagnosticSeverity::Error));
    }

    #[test]
    fn honours_a_dependency_s_upper_bound_as_a_ceiling() {
        let diagnostics =
            judged(&[(doc(json!({ "telo": ">=0.1.0 <0.2.0" }), "Theirs"), "/Theirs/telo.yaml")], Some(&["Mine"]));
        assert_eq!(codes(&diagnostics), ["MODULE_REQUIRES_OLDER_RUNTIME"]);
        assert_eq!(
            diagnostics[0].message,
            format!(
                "file:///Theirs/telo.yaml is restricted to telo '<0.2.0'; this runtime reports {}. Use telo below 0.2.0, or another version of Theirs.",
                *TELO_RUNNING_SURFACE
            )
        );
    }

    #[test]
    fn meets_the_unreleased_floor_exactly_when_this_build_is_of_the_pending_release() {
        let diagnostics = judged(&[(doc(json!({ "telo": ">=unreleased" }), "SQL"), "/SQL/telo.yaml")], None);
        let expected: &[&str] =
            if TELO_RUNNING_SURFACE.ends_with("+unreleased") { &[] } else { &["MODULE_REQUIRES_NEWER_RUNTIME"] };
        assert_eq!(codes(&diagnostics), expected);
    }

    #[test]
    fn says_nothing_when_the_requirement_is_met() {
        assert!(judged(&[(doc(json!({ "telo": ">=0.1.0" }), "SQL"), "/SQL/telo.yaml")], None).is_empty());
    }

    #[test]
    fn errors_on_the_entry_s_own_malformed_block_and_warns_on_a_dependency_s() {
        let diagnostics = judged(
            &[(doc(json!({ "telo": "^0.80.0" }), "Mine"), "/Mine/telo.yaml"), (doc(json!({ "telo": "^0.80.0" }), "Theirs"), "/Theirs/telo.yaml")],
            Some(&["Mine"]),
        );
        let severities: Vec<_> = diagnostics.iter().map(|d| d.severity).collect();
        assert_eq!(severities, [Some(DiagnosticSeverity::Error), Some(DiagnosticSeverity::Warning)]);
        assert!(diagnostics[0].message.ends_with(" Write '>=0.80.0' instead."), "{}", diagnostics[0].message);
        assert!(diagnostics[1].message.starts_with("Telo.Library/Theirs: 'requires.telo': "), "{}", diagnostics[1].message);
        assert!(diagnostics[1].message.ends_with(
            " Its declared requirement cannot be read, so it is not enforced here and `telo upgrade` will not select this version. Only the module's publisher can fix it."
        ));
    }

    #[test]
    fn suppresses_unknown_axis_complaints_while_the_telo_gate_is_failing() {
        let manifest = doc(json!({ "telo": ">=999.0.0", "host": { "futureAxis": ">=1.0.0" }, "other": "x" }), "SQL");
        assert_eq!(codes(&judged(&[(manifest, "/SQL/telo.yaml")], None)), ["MODULE_REQUIRES_NEWER_RUNTIME"]);
        let manifest = doc(json!({ "telo": ">=0.10.0", "futureAxis": "x" }), "SQL");
        assert_eq!(codes(&judged(&[(manifest, "/SQL/telo.yaml")], None)), ["REQUIRES_INVALID"]);
    }

    #[test]
    fn ignores_non_module_docs() {
        let definition = json!({ "kind": "Telo.Definition", "metadata": { "name": "Query" }, "requires": 5 });
        assert!(judged(&[(definition, "/SQL/telo.yaml")], None).is_empty());
    }

    fn geocode(restrictions: Value) -> Value {
        json!({
            "kind": "Telo.Library",
            "metadata": { "name": "Geocode", "version": "1.2.1" },
            "requires": { "telo": ">=0.121.0" },
            "restrictions": restrictions,
        })
    }

    #[test]
    fn refuses_each_malformed_or_unusable_entry_and_enforces_none_of_them() {
        let diagnostics = judged(
            &[(
                geocode(json!([
                    { "versions": "<=1.3.0", "requires": { "telo": "<0.122.0" }, "reason": "Lookup never returns on telo 0.122.0 and later." },
                    { "versions": "<=1.2.1", "requires": { "telo": "<0.121.0" }, "reason": "Broken everywhere." },
                    { "versions": "<=1.2.0", "requires": { "telo": "<0.122.0" } },
                    { "requires": {}, "reason": "Held back." },
                    { "requires": { "host": { "node": ">=unreleased" } }, "reason": "Needs the next Node." },
                ])),
                "/geocode/telo.yaml",
            )],
            None,
        );
        let found: Vec<(&str, Option<DiagnosticSeverity>, &str, &str)> = diagnostics
            .iter()
            .map(|d| (d.code.as_deref().unwrap(), d.severity, d.data.as_ref().unwrap().path.as_deref().unwrap(), d.message.as_str()))
            .collect();
        let error = Some(DiagnosticSeverity::Error);
        assert_eq!(
            found,
            [
                (
                    "RESTRICTIONS_INVALID",
                    error,
                    "restrictions[0].versions",
                    "restrictions[0].versions '<=1.3.0' reaches past this module's version 1.2.1; an entry covers only this version and earlier ones. Leave the upper bound off to cover through this version."
                ),
                (
                    "RESTRICTIONS_INVALID",
                    error,
                    "restrictions[1]",
                    "restrictions[1] leaves 1.2.1 usable by no telo: requires.telo '>=0.121.0' and '<0.121.0' do not overlap. Deprecate the module instead."
                ),
                (
                    "RESTRICTIONS_INVALID",
                    error,
                    "restrictions[2]",
                    "restrictions[2] has no reason; say what breaks, so whoever is held back knows why."
                ),
                ("RESTRICTIONS_INVALID", error, "restrictions[3].requires", "restrictions[3].requires states no bound."),
                (
                    "RESTRICTIONS_INVALID",
                    error,
                    "restrictions[4].requires.host.node",
                    "restrictions[4].requires.host.node '>=unreleased': unreleased names a telo release and is allowed only as a telo floor."
                ),
            ]
        );
    }

    #[test]
    fn warns_on_a_dependency_s_malformed_entry() {
        let diagnostics = judged(&[(geocode(json!([{ "requires": { "telo": "<0.1.0" } }])), "/geocode/telo.yaml")], Some(&["App"]));
        assert_eq!(codes(&diagnostics), ["RESTRICTIONS_INVALID"]);
        assert_eq!(diagnostics[0].severity, Some(DiagnosticSeverity::Warning));
        assert!(diagnostics[0].message.contains("not enforced here"));
    }

    #[test]
    fn carries_a_restriction_s_reason_and_its_entry_path_on_the_gate() {
        let manifest = json!({
            "kind": "Telo.Application",
            "metadata": { "name": "OlderApp", "version": "1.0.0" },
            "restrictions": [{ "requires": { "telo": "<=0.1.0" }, "reason": "Greeting never returns" }],
        });
        let diagnostics = judged(&[(manifest, "/app/telo.yaml")], None);
        assert_eq!(codes(&diagnostics), ["MODULE_REQUIRES_OLDER_RUNTIME"]);
        assert_eq!(diagnostics[0].data.as_ref().and_then(|d| d.path.as_deref()), Some("restrictions[0].requires.telo"));
        assert_eq!(
            diagnostics[0].message,
            format!(
                "file:///app/telo.yaml is restricted to telo '<=0.1.0'; this runtime reports {}. Reason: Greeting never returns. Use telo at or below 0.1.0, or another version of OlderApp.",
                *TELO_RUNNING_SURFACE
            )
        );
    }
}
