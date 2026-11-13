//! How a rewrite is REPORTED — the provenance record and the diagnostic. Mirrors
//! `../../../nodejs/src/migrations/report.ts`.
//!
//! A diagnostic composes in three parts and the entry writes only one: what changed and how
//! to apply it are generated identically for every entry; the entry supplies `reason`.
//! Nothing here can change what a migration does.

use serde_json::Value;
use telo_templating::tagged_sentinel_parts;
use telorun_cel_value::{es_number, json_quote};

use crate::types::{
    kind_of, name_of, AnalysisDiagnostic, DiagnosticData, DiagnosticFix, DiagnosticMigration, DiagnosticResource,
    DiagnosticTag, ResourceManifest, ANALYZER_SOURCE,
};

use super::patch::{format_migration_path, MigrationEffect, PatchPlan};
use super::types::{MigrationEntry, MigrationOperation, MigrationPath, MigrationRewrite, PathSegment};

/// One patch that applied, as the reporting side needs to see it.
pub struct AppliedPatch<'e> {
    pub entry: &'e MigrationEntry,
    pub document_index: usize,
    pub matched: MigrationPath,
    pub plan: PatchPlan,
    pub ops: &'e [MigrationOperation],
}

pub fn to_rewrite(applied: &AppliedPatch) -> MigrationRewrite {
    MigrationRewrite {
        entry_id: applied.entry.id.clone(),
        code: applied.entry.code.clone(),
        severity: applied.entry.severity,
        document_index: applied.document_index,
        legacy_path: format_migration_path(&applied.matched),
        migrated_path: format_migration_path(&applied.plan.final_path),
        summary: describe_change(applied),
    }
}

pub fn to_diagnostic(
    applied: &AppliedPatch,
    rewrite: &MigrationRewrite,
    source: &str,
    manifests: &[Option<ResourceManifest>],
) -> AnalysisDiagnostic {
    let fix = derive_fix(applied);
    let closing = match &fix {
        Some(_) => "Run `telo migrate` to apply it.".to_string(),
        None => format!("no quick fix ({}) — run `telo migrate`", refusal_phrase(applied.ops)),
    };
    let manifest = manifests.get(applied.document_index).and_then(Option::as_ref);
    let resource = manifest.and_then(|manifest| {
        Some(DiagnosticResource { kind: kind_of(manifest)?.to_string(), name: name_of(manifest)?.to_string() })
    });
    AnalysisDiagnostic {
        range: None,
        severity: Some(applied.entry.severity),
        code: Some(applied.entry.code.clone()),
        source: Some(ANALYZER_SOURCE.to_string()),
        // A migration IS a deprecation, whatever severity the entry chose for itself.
        tags: Some(vec![DiagnosticTag::Deprecated]),
        message: format!("{}\n{}\n{closing}", rewrite.summary, applied.entry.reason),
        data: Some(DiagnosticData {
            resource,
            file_path: Some(source.to_string()),
            // The author's path: the position index is built from the raw file.
            path: Some(rewrite.legacy_path.clone()),
            fix,
            migration: Some(DiagnosticMigration {
                id: applied.entry.id.clone(),
                legacy_path: rewrite.legacy_path.clone(),
                migrated_path: rewrite.migrated_path.clone(),
            }),
            ..Default::default()
        }),
    }
}

/// A quick fix exists exactly for a lone `set-value` producing a scalar — derived from the
/// operations, never declared.
fn derive_fix(applied: &AppliedPatch) -> Option<DiagnosticFix> {
    let [MigrationOperation::SetValue(_)] = applied.ops else { return None };
    let replacement = match applied.plan.after.as_ref()? {
        Value::String(text) => text.clone(),
        Value::Number(number) => es_number(number.as_f64()?),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_string(),
        _ => return None,
    };
    Some(DiagnosticFix { replacement, tag: None })
}

fn refusal_phrase(ops: &[MigrationOperation]) -> &'static str {
    for op in ops {
        match op {
            MigrationOperation::RenameKey { .. } => return "renames a key",
            MigrationOperation::SetTag { .. } => return "adds a tag",
            MigrationOperation::InsertItem { .. } => return "inserts an item",
            MigrationOperation::AddKey { .. } => return "adds a key",
            MigrationOperation::RemoveEntry => return "removes an entry",
            MigrationOperation::SetValue(_) => {}
        }
    }
    "writes a structured value"
}

/// The generated "what changed" sentence — the half no entry writes.
fn describe_change(applied: &AppliedPatch) -> String {
    let legacy_key = last_segment(&applied.matched);
    let migrated_key = last_segment(&applied.plan.final_path);
    let PatchPlan { before, after, effects, .. } = &applied.plan;

    // Only a removal leaves no value behind.
    let Some(after) = after else {
        return format!("`{legacy_key}` is no longer used.");
    };
    let added: Vec<String> = effects
        .iter()
        .filter_map(|effect| match effect {
            MigrationEffect::AddKey { key, value, .. } => Some(if value.is_object() || value.is_array() {
                key.clone()
            } else {
                format!("{key}: {}", render_value(value))
            }),
            _ => None,
        })
        .collect();
    if !added.is_empty() && added.len() == effects.len() {
        return format!("`{legacy_key}` gains `{}`.", added.join("`, `"));
    }
    let inserted: Option<Vec<String>> = effects
        .iter()
        .map(|effect| match effect {
            MigrationEffect::InsertItem { value, .. } => Some(render_value(value)),
            _ => None,
        })
        .collect();
    if let Some(inserted) = inserted.filter(|items| !items.is_empty()) {
        return format!("`{}` gains `{}`.", format_migration_path(&applied.matched), inserted.join("`, `"));
    }
    format!(
        "`{legacy_key}: {}` is now written `{migrated_key}: {}`.",
        render_value(before),
        render_value(after)
    )
}

fn last_segment(path: &[PathSegment]) -> String {
    match path.last() {
        Some(PathSegment::Index(index)) => format!("[{index}]"),
        Some(PathSegment::Key(key)) => key.clone(),
        None => String::new(),
    }
}

/// A value as the sentence prints it: a scalar's text, a tagged scalar as written, and
/// anything else as `JSON.stringify` writes it.
fn render_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        Value::Number(number) => number.as_f64().map(es_number).unwrap_or_default(),
        Value::Bool(flag) => flag.to_string(),
        _ => match tagged_sentinel_parts(value) {
            Some((engine, source)) => format!("!{engine} {source}"),
            None => json_text(value),
        },
    }
}

/// `JSON.stringify` of a JSON value.
fn json_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.as_f64().map(es_number).unwrap_or_default(),
        Value::String(text) => json_quote(text),
        Value::Array(items) => format!("[{}]", items.iter().map(json_text).collect::<Vec<_>>().join(",")),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter().map(|(key, item)| format!("{}:{}", json_quote(key), json_text(item))).collect::<Vec<_>>().join(",")
        ),
    }
}
