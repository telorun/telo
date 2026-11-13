//! A release plan for a person: per unit, the move, the level, the cause and
//! the group — because "why is this unit in the list" is the question to
//! answer.

use serde_json::{Map, Value};

use crate::marker_reader::Severity;
use crate::release_plan::{BumpReason, PlannedUnit, ReleaseDiagnostic, ReleasePlan};

use super::host::Style;

const MAX_NAMED_FILES: usize = 2;

pub fn describe_reason(reason: &BumpReason) -> String {
    match reason {
        BumpReason::Declared { .. } => "declared".into(),
        BumpReason::Imports { unit } => format!("imports {unit}"),
        BumpReason::VersionLocation { unit, .. } => format!("holds the version of {unit}"),
        BumpReason::Group { group } => format!("group {group}"),
        BumpReason::Inlines { files, .. } => {
            let shown = files.iter().take(MAX_NAMED_FILES).cloned().collect::<Vec<_>>().join(", ");
            let rest = files.len().saturating_sub(MAX_NAMED_FILES);
            if rest > 0 {
                format!("inlines {shown} and {rest} more")
            } else {
                format!("inlines {shown}")
            }
        }
        BumpReason::Unattributed => "payload changed, unattributed".into(),
    }
}

const ORDER: [&str; 6] = ["declared", "inlines", "imports", "version-location", "group", "unattributed"];

fn describe_reasons(unit: &PlannedUnit) -> String {
    let mut sorted: Vec<&BumpReason> = unit.reasons.iter().collect();
    sorted.sort_by_key(|reason| ORDER.iter().position(|kind| *kind == reason.kind()));
    let mut seen: Vec<String> = Vec::new();
    for reason in sorted {
        let text = describe_reason(reason);
        if !seen.contains(&text) {
            seen.push(text);
        }
    }
    seen.join("; ")
}

fn width(text: &str) -> usize {
    text.encode_utf16().count()
}

fn pad_end(text: &str, to: usize) -> String {
    format!("{text}{}", " ".repeat(to.saturating_sub(width(text))))
}

pub fn render_plan(plan: &ReleasePlan, style: Style) -> Vec<String> {
    if plan.units.is_empty() {
        return vec!["Nothing to release — every unit matches the ledger.".into()];
    }
    let key_width = plan.units.iter().map(|u| width(&u.key)).max().unwrap_or(0);
    let move_width = plan.units.iter().map(|u| width(&format!("{} → {}", u.from, u.to))).max().unwrap_or(0);
    plan.units
        .iter()
        .map(|unit| {
            let movement = format!("{} → {}", unit.from, unit.to);
            let group = unit.group.as_ref().map(|g| format!("  [{g}]")).unwrap_or_default();
            format!(
                "{}  {}  {}{group}",
                pad_end(&unit.key, key_width),
                pad_end(&movement, move_width),
                style.dim(&format!("{} — {}", unit.level.as_str(), describe_reasons(unit)))
            )
        })
        .collect()
}

pub fn render_diagnostics(diagnostics: &[ReleaseDiagnostic], style: Style) -> Vec<String> {
    diagnostics
        .iter()
        .map(|d| {
            let code = if d.severity == Severity::Error { style.error(&d.code) } else { style.warn(&d.code) };
            format!("{code}  {}", d.message)
        })
        .collect()
}

pub fn diagnostic_json(diagnostic: &ReleaseDiagnostic) -> Value {
    let mut out = Map::new();
    out.insert("severity".into(), Value::String(diagnostic.severity.as_str().into()));
    out.insert("code".into(), Value::String(diagnostic.code.clone()));
    out.insert("message".into(), Value::String(diagnostic.message.clone()));
    Value::Object(out)
}

pub fn diagnostics_json(diagnostics: &[ReleaseDiagnostic]) -> Value {
    Value::Array(diagnostics.iter().map(diagnostic_json).collect())
}

fn strings(items: impl IntoIterator<Item = String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

/// The machine surface: the same plan, without the alignment.
pub fn plan_payload(plan: &ReleasePlan) -> Map<String, Value> {
    let units = plan
        .units
        .iter()
        .map(|unit| {
            let mut out = Map::new();
            out.insert("key".into(), Value::String(unit.key.clone()));
            out.insert("name".into(), Value::String(unit.name.clone()));
            out.insert("from".into(), Value::String(unit.from.clone()));
            out.insert("to".into(), Value::String(unit.to.clone()));
            out.insert("level".into(), Value::String(unit.level.as_str().into()));
            if let Some(group) = &unit.group {
                out.insert("group".into(), Value::String(group.clone()));
            }
            out.insert("reasons".into(), strings(unit.reasons.iter().map(describe_reason)));
            out.insert("changedLayers".into(), strings(unit.changed.iter().map(|c| c.path.join("/"))));
            let entries = unit
                .entries
                .iter()
                .map(|entry| {
                    let mut e = Map::new();
                    e.insert("kind".into(), Value::String(entry.kind.as_str().into()));
                    e.insert("body".into(), Value::String(entry.body.clone()));
                    Value::Object(e)
                })
                .collect();
            out.insert("entries".into(), Value::Array(entries));
            Value::Object(out)
        })
        .collect();
    let mut payload = Map::new();
    payload.insert("units".into(), Value::Array(units));
    payload.insert("fragments".into(), strings(plan.fragments.iter().cloned()));
    if let Some(candidate) = &plan.candidate {
        payload.insert("candidate".into(), Value::String(candidate.clone()));
    }
    payload.insert("diagnostics".into(), diagnostics_json(&plan.diagnostics));
    payload
}
