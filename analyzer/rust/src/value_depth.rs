//! How deeply a value nests, and the limit a validation holds it to. Mirrors
//! `../../nodejs/src/value-depth.ts`: every list and record — and a map whose keys are all
//! strings, which the validator's view reads as an object — is one level, anything else a leaf.
//! The limit is `maxValueDepth` of `analyzer/validation-limits.json`, the file the Node half
//! copies, so both refuse the same values. The walk keeps its own stack.

use std::sync::OnceLock;

use telorun_cel_value::CelValue;

const VALIDATION_LIMITS: &str = include_str!("../../validation-limits.json");

/// The deepest a value may nest and still be validated.
pub fn max_value_depth() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        let limits: serde_json::Value = serde_json::from_str(VALIDATION_LIMITS).expect("validation-limits.json is JSON");
        limits
            .get("maxValueDepth")
            .and_then(serde_json::Value::as_u64)
            .filter(|limit| *limit >= 1)
            .expect("validation-limits.json holds a positive 'maxValueDepth'") as usize
    })
}

/// The values one level holds, or `None` for a leaf.
fn level_items(value: &CelValue) -> Option<Vec<&CelValue>> {
    match value {
        CelValue::List(items) => Some(items.iter().collect()),
        CelValue::Record(record) => Some(record.iter().map(|(_, item)| item).collect()),
        CelValue::Map(map) if map.iter().all(|(key, _)| matches!(key, CelValue::String(_))) => {
            Some(map.iter().map(|(_, item)| item).collect())
        }
        _ => None,
    }
}

/// Whether `value` nests deeper than [`max_value_depth`].
pub fn nests_past_value_depth(value: &CelValue) -> bool {
    let limit = max_value_depth();
    let mut pending: Vec<(&CelValue, usize)> = vec![(value, 1)];
    while let Some((node, depth)) = pending.pop() {
        let Some(items) = level_items(node) else { continue };
        if depth > limit {
            return true;
        }
        pending.extend(items.into_iter().map(|item| (item, depth + 1)));
    }
    false
}

