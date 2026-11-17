//! Why a unit moves, worded for a person: one phrase per reason, and a unit's
//! reasons in one line — what the text output and the markdown document show.

use crate::release_plan::BumpReason;

const MAX_NAMED_FILES: usize = 2;

pub fn describe_reason(reason: &BumpReason) -> String {
    describe_reason_with(reason, &|operand| operand.to_string())
}

/// `operand` writes a unit key, group or file name into the phrase.
pub fn describe_reason_with(reason: &BumpReason, operand: &dyn Fn(&str) -> String) -> String {
    match reason {
        BumpReason::Declared { .. } => "declared".into(),
        BumpReason::Imports { unit } => format!("imports {}", operand(unit)),
        BumpReason::VersionLocation { unit, .. } => format!("holds the version of {}", operand(unit)),
        BumpReason::Group { group } => format!("group {}", operand(group)),
        BumpReason::Inlines { files, .. } => {
            let shown = files.iter().take(MAX_NAMED_FILES).map(|file| operand(file)).collect::<Vec<_>>().join(", ");
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

/// A unit's reasons by kind, each phrase once, joined with `; `.
pub fn describe_reasons(reasons: &[BumpReason]) -> String {
    describe_reasons_with(reasons, &|operand| operand.to_string())
}

pub fn describe_reasons_with(reasons: &[BumpReason], operand: &dyn Fn(&str) -> String) -> String {
    let mut sorted: Vec<&BumpReason> = reasons.iter().collect();
    sorted.sort_by_key(|reason| ORDER.iter().position(|kind| *kind == reason.kind()));
    let mut seen: Vec<String> = Vec::new();
    for reason in sorted {
        let text = describe_reason_with(reason, operand);
        if !seen.contains(&text) {
            seen.push(text);
        }
    }
    seen.join("; ")
}
