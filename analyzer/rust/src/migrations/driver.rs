//! The migration driver — one pass, one set of guarantees. Mirrors
//! `../../../nodejs/src/migrations/driver.ts`.
//!
//! The match set is frozen against the pre-migration tree, so no rule matches a node
//! another rule produced; rules within an entry apply in order at each match; entries never
//! see one another's output. Idempotency follows: a rule matches only the legacy spelling.
//! Node's `migrateFileText` — `telo migrate`'s file repair — has no twin here: no Rust
//! reader writes YAML back. Node visits integer-like mapping keys first (`Object.entries`
//! order) where this walk keeps YAML order, so only the order of rewrites and of their
//! diagnostics can differ, in a mapping with such keys.

use std::collections::HashSet;

use crate::types::{kind_of, AnalysisDiagnostic, ResourceManifest};

use super::patch::{apply_effects_to_tree, format_migration_path, plan_patch, MigrationEffect};
use super::r#match::{applicable_rules, build_match_index, select_matches, MigrationMatch};
use super::registry::core_migrations;
use super::report::{to_diagnostic, to_rewrite, AppliedPatch};
use super::types::{MigrationEntry, MigrationOperation, MigrationPath, MigrationRewrite, PathSegment};

/// What one file's migration produced.
#[derive(Debug, Clone, Default)]
pub struct FileMigrations {
    /// One record per applied rewrite, in application order.
    pub rewrites: Vec<MigrationRewrite>,
    /// One diagnostic per rewrite. Whether they are surfaced is the graph's decision: a
    /// migration rewrites always, and reports only for the entry's own module.
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

/// Run `entries` (the core set when none) over one file's parsed documents, mutating
/// `manifests` in place, and return the provenance records and their diagnostics.
pub fn migrate_manifests(
    source: &str,
    manifests: &mut [Option<ResourceManifest>],
    entries: Option<&[MigrationEntry]>,
) -> FileMigrations {
    let entries = entries.unwrap_or_else(|| core_migrations());
    if entries.is_empty() {
        return FileMigrations::default();
    }
    let applied = apply_all(manifests, entries);
    let rewrites: Vec<MigrationRewrite> = applied.iter().map(to_rewrite).collect();
    let diagnostics =
        applied.iter().zip(&rewrites).map(|(patch, rewrite)| to_diagnostic(patch, rewrite, source, manifests)).collect();
    FileMigrations { rewrites, diagnostics }
}

struct FlatRule<'e> {
    entry: &'e MigrationEntry,
    ops: &'e [MigrationOperation],
    matcher: &'e MigrationMatch,
}

struct Candidate<'e> {
    entry: &'e MigrationEntry,
    ops: &'e [MigrationOperation],
    document_index: usize,
    path: MigrationPath,
}

/// One pass: every match collected against the frozen pre-migration tree, then applied in
/// entry order.
fn apply_all<'e>(manifests: &mut [Option<ResourceManifest>], entries: &'e [MigrationEntry]) -> Vec<AppliedPatch<'e>> {
    let flat_rules: Vec<FlatRule<'e>> = entries
        .iter()
        .flat_map(|entry| {
            entry.rules.iter().map(move |rule| FlatRule { entry, ops: &rule.patch, matcher: &rule.r#match })
        })
        .collect();

    // One index per document, shared by every rule that can reach it; the `inKind` gate
    // and the `under` regions bound the walk rather than filter its output.
    let mut candidates = Vec::new();
    for (document_index, manifest) in manifests.iter().enumerate() {
        let Some(manifest) = manifest else { continue };
        let applicable = applicable_rules(&flat_rules, |rule| rule.matcher, kind_of(manifest));
        if applicable.rules.is_empty() {
            continue;
        }
        let index = build_match_index(manifest, &applicable.keys, &applicable.roots, applicable.scalars);
        for rule in applicable.rules {
            for path in select_matches(&index, manifest, rule.matcher) {
                candidates.push(Candidate { entry: rule.entry, ops: rule.ops, document_index, path });
            }
        }
    }

    // Arrays whose length an applied patch changed: a frozen match names a sequence element
    // by index, and an index is not an identity once a sibling patch resized its array.
    let mut shifted_arrays: HashSet<(usize, String)> = HashSet::new();
    let mut applied = Vec::new();
    for candidate in candidates {
        let Some(manifest) = manifests[candidate.document_index].as_mut() else { continue };
        if index_is_stale(candidate.document_index, &candidate.path, &shifted_arrays) {
            continue;
        }
        // A refusal is no error: the node stays as the author wrote it, for the validator.
        let Ok(plan) = plan_patch(manifest, &candidate.path, candidate.ops) else { continue };
        apply_effects_to_tree(manifest, &plan.effects);
        shifted_arrays.extend(resized_arrays(candidate.document_index, &plan.effects));
        applied.push(AppliedPatch {
            entry: candidate.entry,
            document_index: candidate.document_index,
            matched: candidate.path,
            plan,
            ops: candidate.ops,
        });
    }
    applied
}

/// Arrays this patch resized, keyed for `shifted_arrays`.
fn resized_arrays(document_index: usize, effects: &[MigrationEffect]) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for effect in effects {
        match effect {
            MigrationEffect::InsertItem { path, .. } => out.push((document_index, format_migration_path(path))),
            MigrationEffect::RemoveEntry { path } if matches!(path.last(), Some(PathSegment::Index(_))) => {
                out.push((document_index, format_migration_path(&path[..path.len() - 1])));
            }
            _ => {}
        }
    }
    out
}

/// Whether any index along `path` steps into an array a prior patch resized.
fn index_is_stale(document_index: usize, path: &[PathSegment], shifted_arrays: &HashSet<(usize, String)>) -> bool {
    if shifted_arrays.is_empty() {
        return false;
    }
    path.iter().enumerate().any(|(position, segment)| {
        matches!(segment, PathSegment::Index(_))
            && shifted_arrays.contains(&(document_index, format_migration_path(&path[..position])))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::migrations::entry_data::parse_migration_entry;
    use crate::migrations::r#match::MigrationSurface;

    fn entry(id: &str, key: &str, patch: Value) -> MigrationEntry {
        let data = json!({
            "id": id, "code": "TEST", "severity": "warning", "reason": "r",
            "rules": [{ "match": { "key": key, "inKind": ["Telo.Application"], "under": ["schema", "targets"] }, "patch": patch }],
        });
        parse_migration_entry("test.json", &data, MigrationSurface::Core).expect("entry reads")
    }

    fn run(document: Value, entries: &[MigrationEntry]) -> (Value, Vec<String>) {
        let mut manifests = vec![Some(document)];
        let migrations = migrate_manifests("/ws/telo.yaml", &mut manifests, Some(entries));
        let ids = migrations.rewrites.iter().map(|rewrite| rewrite.entry_id.clone()).collect();
        (manifests.remove(0).expect("a document"), ids)
    }

    #[test]
    fn refuses_a_match_under_an_array_a_sibling_patch_resized() {
        let inserter = entry("insert-first", "targets", json!([{ "op": "insert-item", "value": "inserted", "at": 0 }]));
        let indexed = entry("indexed", "label", json!([{ "op": "set-value", "value": "REWRITTEN" }]));
        let document = json!({ "kind": "Telo.Application", "targets": [{ "label": "a" }, { "label": "b" }] });
        let (migrated, ids) = run(document, &[inserter, indexed]);
        assert_eq!(migrated["targets"], json!(["inserted", { "label": "a" }, { "label": "b" }]));
        assert_eq!(ids, ["insert-first"]);
    }

    #[test]
    fn freezes_the_match_set_and_keeps_a_renamed_key_in_place() {
        let rename = entry(
            "rename",
            "x-old-flag",
            json!([{ "op": "rename-key", "to": "x-new-type" }, { "op": "set-value", "value": "Telo.Stream" }]),
        );
        let follow_on = entry("follow-on", "x-new-type", json!([{ "op": "set-value", "value": "SEEN" }]));
        let document = json!({ "kind": "Telo.Application", "schema": { "a": 1, "x-old-flag": true, "z": 2 } });
        let (migrated, ids) = run(document, &[rename, follow_on]);
        assert_eq!(
            serde_json::to_string(&migrated["schema"]).unwrap(),
            r#"{"a":1,"x-new-type":"Telo.Stream","z":2}"#
        );
        assert_eq!(ids, ["rename"]);
    }
}
