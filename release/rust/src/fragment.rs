//! A release fragment — one pending change, written by an author.
//!
//! One file, several units, one body, carrying a kind per unit that drives both
//! the level and the changelog section. Units are named by their
//! workspace-relative path; a fragment written before units existed names them
//! under `modules:`, read as the same thing.

use indexmap::IndexMap;
use serde_json::Value;

use crate::bump_level::FragmentKind;
use crate::yaml::{parse_json, stringify_document, Out};
use crate::ReleaseError;

/// A unit's workspace-relative directory path — `modules/sql`, `kernel`.
pub type UnitKey = String;

#[derive(Debug, Clone)]
pub struct ReleaseFragment {
    /// Where it was read from, workspace-relative.
    pub source: String,
    pub units: IndexMap<UnitKey, FragmentKind>,
    pub body: String,
}

const UNITS_FIELD: &str = "units";
const LEGACY_UNITS_FIELD: &str = "modules";

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

pub fn parse_fragment(text: &str, source: &str) -> Result<ReleaseFragment, ReleaseError> {
    let value = parse_json(text).map_err(|err| ReleaseError::new(format!("{source} is not valid YAML: {}", err.message)))?;
    let Value::Object(record) = value else {
        return Err(ReleaseError::new(format!("{source} must be a YAML mapping.")));
    };
    for key in record.keys() {
        if key != UNITS_FIELD && key != LEGACY_UNITS_FIELD && key != "body" {
            return Err(ReleaseError::new(format!(
                "{source}: unknown field '{key}'. A fragment carries 'units:' and 'body:'."
            )));
        }
    }
    if record.contains_key(UNITS_FIELD) && record.contains_key(LEGACY_UNITS_FIELD) {
        return Err(ReleaseError::new(format!(
            "{source} carries both 'units:' and 'modules:'. 'modules:' is the older spelling of 'units:'; move its entries into 'units:'."
        )));
    }
    let field = if record.contains_key(LEGACY_UNITS_FIELD) { LEGACY_UNITS_FIELD } else { UNITS_FIELD };
    let Some(Value::Object(raw_units)) = record.get(field) else {
        return Err(ReleaseError::new(format!(
            "{source}: '{field}' must be a mapping of unit path to kind, e.g. {{ modules/sql: Fixed }}."
        )));
    };
    let mut units = IndexMap::new();
    for (key, kind) in raw_units {
        let parsed = kind.as_str().and_then(FragmentKind::parse);
        let Some(parsed) = parsed else {
            return Err(ReleaseError::new(format!(
                "{source}: '{key}' declares kind '{}', which is not a release kind. Use Added, Changed, Deprecated, Removed, Fixed or Security.",
                js_string(kind)
            )));
        };
        units.insert(normalize_unit_key(key), parsed);
    }
    if units.is_empty() {
        return Err(ReleaseError::new(format!(
            "{source}: '{field}' is empty, so this fragment releases nothing. Name at least one unit by its workspace-relative path."
        )));
    }
    let body = match record.get("body") {
        Some(Value::String(body)) if !body.trim().is_empty() => body.trim().to_string(),
        _ => {
            return Err(ReleaseError::new(format!("{source}: 'body' must be the changelog line for this change.")));
        }
    };
    Ok(ReleaseFragment { source: source.to_string(), units, body })
}

/// Render a fragment, folded the way the YAML writer folds it.
pub fn serialize_fragment(units: &IndexMap<UnitKey, FragmentKind>, body: &str) -> String {
    let units = units.iter().map(|(key, kind)| (key.clone(), Out::Str(kind.as_str().to_string()))).collect();
    stringify_document(&[(UNITS_FIELD.to_string(), Out::Map(units)), ("body".to_string(), Out::Str(body.to_string()))], 88)
}

/// POSIX-separated, no leading `./`, no trailing slash.
pub fn normalize_unit_key(key: &str) -> UnitKey {
    let posix = key.replace('\\', "/");
    let stripped = posix.strip_prefix("./").unwrap_or(&posix);
    stripped.trim_end_matches('/').to_string()
}
