//! A unit's `metafile:` — a bundler metafile (esbuild's `inputs`) — read as
//! inline edges: every input another unit owns. Input paths are read relative
//! to the unit's directory, where its build runs.

use std::fs;

use indexmap::IndexMap;
use serde_json::Value;

use crate::fragment::UnitKey;
use crate::units::ResolvedUnit;
use crate::ReleaseError;

use super::declared_payload::relative_text;
use super::evidence::owning_unit;
use super::workspace::{absolute, ReleaseWorkspace};

pub fn metafile_inlines(workspace: &ReleaseWorkspace, unit: &ResolvedUnit) -> Result<IndexMap<UnitKey, Vec<String>>, ReleaseError> {
    let metafile = unit.metafile.as_deref().expect("a declared metafile");
    let file = workspace.root.join(metafile);
    let refuse = |reason: String| {
        ReleaseError::new(format!(
            "{metafile}, the metafile unit '{}' declares, cannot be read ({reason}). Build the unit first, or remove 'metafile:'.",
            unit.key
        ))
    };
    let text = fs::read_to_string(&file).map_err(|err| refuse(err.to_string()))?;
    let meta: Value = serde_json::from_str(&text).map_err(|err| refuse(err.to_string()))?;
    let root = absolute(&workspace.root);
    let mut owners: IndexMap<UnitKey, Vec<String>> = IndexMap::new();
    let inputs = meta.get("inputs").and_then(Value::as_object);
    for input in inputs.into_iter().flat_map(|map| map.keys()) {
        if input.contains(':') {
            continue;
        }
        let abs = absolute(&root.join(&unit.dir).join(input));
        let relative = relative_text(&root, &abs);
        if relative.starts_with("..") {
            continue;
        }
        let Some(owner) = owning_unit(&workspace.units, &relative) else { continue };
        if owner.key == unit.key {
            continue;
        }
        owners.entry(owner.key.clone()).or_default().push(relative);
    }
    Ok(owners)
}
