//! One version per module location in a loaded import graph, mirroring
//! `../../nodejs/src/reconcile-module-versions.ts`: within a major the highest version wins
//! — a hoist, additive pre-1.0 — and a major mismatch (or a version that does not parse) is
//! a conflict. Every edge pointing at a losing source is repointed at the winner in place,
//! and the overrides map each loser to it.

use indexmap::IndexMap;

use crate::loaded_types::{ImportEdge, LoadedModule};
use crate::module_version_order::{compare_parsed_module_versions, parse_module_version, ParsedModuleVersion};
use crate::sources::source_failure::location_of;
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, AnalysisDiagnostic, DiagnosticData, DiagnosticSeverity};

pub struct VersionReconciliation {
    /// Loser canonical source → winner canonical source.
    pub overrides: IndexMap<String, String>,
    /// One per edge that pointed at a loser and made a decision worth reporting.
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

struct ModuleIdentity {
    source: String,
    identity: String,
    version: String,
    /// `None` for an unparseable version, which forces its group onto the conflict path.
    parsed: Option<ParsedModuleVersion>,
    text: String,
}

/// The location identity of an import ref — the ref with its version stripped — or `None`
/// for a relative or absolute path, which addresses one file and is no cross-import key.
fn ref_identity(reference: &str) -> Option<String> {
    let base = reference.split('#').next().unwrap_or("");
    if base.is_empty() || base.starts_with('.') || base.starts_with('/') || base.starts_with("file:") {
        return None;
    }
    let last_slash = base.rfind('/');
    match base.rfind('@') {
        Some(at) if at > 0 && last_slash.is_none_or(|slash| at > slash) => Some(base[..at].to_string()),
        _ => Some(base.to_string()),
    }
}

fn module_identity_of(module: &LoadedModule, identity: &str) -> Option<ModuleIdentity> {
    let document = module.owner.manifests.iter().flatten().find(|m| kind_of(m).is_some_and(is_module_document))?;
    let metadata = document.get("metadata");
    metadata.and_then(|m| m.get("name")).and_then(|n| n.as_str()).filter(|name| !name.is_empty())?;
    let version = metadata.and_then(|m| m.get("version")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some(ModuleIdentity {
        source: module.owner.source.clone(),
        identity: identity.to_string(),
        parsed: parse_module_version(&version),
        version,
        text: module.owner.text.clone(),
    })
}

/// The winning member — the highest version, ties to the lower source — and whether the
/// group is a conflict.
fn resolve_group<'a>(members: &[&'a ModuleIdentity]) -> (&'a ModuleIdentity, bool) {
    let mut majors: Vec<Option<u64>> = Vec::new();
    for member in members {
        let major = member.parsed.as_ref().map(|p| p.major);
        if !majors.contains(&major) {
            majors.push(major);
        }
    }
    let conflict = majors.contains(&None) || majors.len() > 1;
    let mut winner = members[0];
    for current in &members[1..] {
        let Some(parsed) = &current.parsed else { continue };
        let Some(best) = &winner.parsed else {
            winner = current;
            continue;
        };
        match compare_parsed_module_versions(parsed, best) {
            std::cmp::Ordering::Greater => winner = current,
            std::cmp::Ordering::Equal if current.source.encode_utf16().lt(winner.source.encode_utf16()) => winner = current,
            _ => {}
        }
    }
    (winner, conflict)
}

/// The diagnostic for a redirected edge; `None` for a silent hoist or a dedupe of identical content.
fn hoist_diagnostic(
    importer_source: &str,
    alias: &str,
    loser: &ModuleIdentity,
    winner: &ModuleIdentity,
    conflict: bool,
) -> Option<AnalysisDiagnostic> {
    let identity = &loser.identity;
    let data = || DiagnosticData {
        file_path: Some(importer_source.to_string()),
        path: Some(format!("imports.{alias}")),
        ..Default::default()
    };
    if conflict {
        let loser_version = if loser.version.is_empty() { "<unknown>" } else { &loser.version };
        return Some(AnalysisDiagnostic::error(
            "MODULE_VERSION_CONFLICT",
            format!(
                "Module '{identity}' is imported at incompatible major versions: {loser_version} here and {} elsewhere in the same graph. Major versions can carry breaking changes and cannot be reconciled automatically — align every importer on one major.",
                winner.version
            ),
            data(),
        ));
    }
    if loser.version != winner.version || loser.text == winner.text {
        return None;
    }
    let (loser_at, winner_at) = (location_of(&loser.source), location_of(&winner.source));
    let mut warning = AnalysisDiagnostic::error(
        "MODULE_VERSION_HOISTED",
        format!(
            "Module '{identity}@{}' is imported from two sources whose contents differ ('{loser_at}' and '{winner_at}'). Using '{winner_at}' for every importer — pin a single source to remove the ambiguity.",
            winner.version
        ),
        data(),
    );
    warning.severity = Some(DiagnosticSeverity::Warning);
    Some(warning)
}

pub fn reconcile_module_versions(
    modules: &IndexMap<String, LoadedModule>,
    import_edges: &mut IndexMap<String, IndexMap<String, ImportEdge>>,
) -> VersionReconciliation {
    let mut overrides = IndexMap::new();
    let mut diagnostics = Vec::new();

    // One identity per source, from the first edge reaching it.
    let mut identity_by_source: IndexMap<&str, String> = IndexMap::new();
    for aliases in import_edges.values() {
        for edge in aliases.values() {
            if identity_by_source.contains_key(edge.target_source.as_str()) {
                continue;
            }
            if let Some(identity) = ref_identity(&edge.target_ref) {
                identity_by_source.insert(edge.target_source.as_str(), identity);
            }
        }
    }

    let infos: Vec<ModuleIdentity> = modules
        .iter()
        .filter_map(|(source, module)| module_identity_of(module, identity_by_source.get(source.as_str())?))
        .collect();
    let mut groups: IndexMap<&str, Vec<&ModuleIdentity>> = IndexMap::new();
    for info in &infos {
        groups.entry(info.identity.as_str()).or_default().push(info);
    }
    let mut conflict_by_identity: IndexMap<&str, bool> = IndexMap::new();
    for (identity, members) in &groups {
        if members.len() < 2 {
            continue;
        }
        let (winner, conflict) = resolve_group(members);
        conflict_by_identity.insert(identity, conflict);
        for member in members {
            if member.source != winner.source {
                overrides.insert(member.source.clone(), winner.source.clone());
            }
        }
    }
    if overrides.is_empty() {
        return VersionReconciliation { overrides, diagnostics };
    }

    let info_of = |source: &str| infos.iter().find(|info| info.source == source);
    for (importer, aliases) in import_edges.iter_mut() {
        for (alias, edge) in aliases.iter_mut() {
            let Some(winner_source) = overrides.get(&edge.target_source) else { continue };
            if let (Some(loser), Some(winner)) = (info_of(&edge.target_source), info_of(winner_source)) {
                let conflict = conflict_by_identity.get(loser.identity.as_str()).copied().unwrap_or(false);
                diagnostics.extend(hoist_diagnostic(importer, alias, loser, winner, conflict));
            }
            edge.target_source = winner_source.clone();
        }
    }
    VersionReconciliation { overrides, diagnostics }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_loaded_file::parse_loaded_file;

    fn module(source: &str, version: &str, extra: &str) -> LoadedModule {
        let text = format!("kind: Telo.Library\nmetadata: {{ name: Acme, version: \"{version}\" }}\n{extra}");
        LoadedModule { owner: parse_loaded_file(source, source, &text), partials: Vec::new() }
    }

    fn edge(target: &str, reference: &str) -> ImportEdge {
        ImportEdge { target_source: target.into(), target_ref: reference.into(), target_module_name: "Acme".into() }
    }

    fn reconcile(versions: [(&str, &str, &str); 2]) -> (VersionReconciliation, IndexMap<String, IndexMap<String, ImportEdge>>) {
        let modules: IndexMap<String, LoadedModule> =
            versions.iter().map(|(source, version, extra)| (source.to_string(), module(source, version, extra))).collect();
        let mut edges = IndexMap::new();
        edges.insert(
            "/app/telo.yaml".to_string(),
            IndexMap::from([
                ("A".to_string(), edge(versions[0].0, &format!("oci://r.test/acme@{}", versions[0].1))),
                ("B".to_string(), edge(versions[1].0, &format!("oci://r.test/acme@{}", versions[1].1))),
            ]),
        );
        (reconcile_module_versions(&modules, &mut edges), edges)
    }

    #[test]
    fn hoists_within_a_major_silently_and_repoints_the_loser() {
        let (result, edges) = reconcile([("oci://r.test/acme@1.2.0", "1.2.0", ""), ("oci://r.test/acme@1.3.0", "1.3.0", "")]);
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.overrides["oci://r.test/acme@1.2.0"], "oci://r.test/acme@1.3.0");
        assert_eq!(edges["/app/telo.yaml"]["A"].target_source, "oci://r.test/acme@1.3.0");
    }

    #[test]
    fn reports_a_major_conflict_at_the_losing_import() {
        let (result, _) = reconcile([("oci://r.test/acme@1.0.0", "1.0.0", ""), ("oci://r.test/acme@2.0.0", "2.0.0", "")]);
        let [conflict] = result.diagnostics.as_slice() else { panic!("{:?}", result.diagnostics) };
        assert_eq!(conflict.code.as_deref(), Some("MODULE_VERSION_CONFLICT"));
        assert_eq!(conflict.data.as_ref().and_then(|d| d.path.as_deref()), Some("imports.A"));
        assert_eq!(
            conflict.message,
            "Module 'oci://r.test/acme' is imported at incompatible major versions: 1.0.0 here and 2.0.0 elsewhere in the same graph. Major versions can carry breaking changes and cannot be reconciled automatically — align every importer on one major."
        );
    }

    #[test]
    fn warns_when_one_version_is_served_with_two_contents() {
        let modules: IndexMap<String, LoadedModule> = [
            ("/cache/a/telo.yaml", ""),
            ("/cache/b/telo.yaml", "description: other\n"),
        ]
        .iter()
        .map(|(source, extra)| (source.to_string(), module(source, "1.0.0", extra)))
        .collect();
        let mut edges = IndexMap::from([(
            "/app/telo.yaml".to_string(),
            IndexMap::from([
                ("A".to_string(), edge("/cache/a/telo.yaml", "oci://r.test/acme@1.0.0")),
                ("B".to_string(), edge("/cache/b/telo.yaml", "oci://r.test/acme@v1.0.0")),
            ]),
        )]);
        let result = reconcile_module_versions(&modules, &mut edges);
        let [hoisted] = result.diagnostics.as_slice() else { panic!("{:?}", result.diagnostics) };
        assert_eq!(hoisted.code.as_deref(), Some("MODULE_VERSION_HOISTED"));
        assert_eq!(hoisted.severity, Some(DiagnosticSeverity::Warning));
        assert_eq!(
            hoisted.message,
            "Module 'oci://r.test/acme@1.0.0' is imported from two sources whose contents differ ('file:///cache/b/telo.yaml' and 'file:///cache/a/telo.yaml'). Using 'file:///cache/a/telo.yaml' for every importer — pin a single source to remove the ambiguity."
        );
    }
}
