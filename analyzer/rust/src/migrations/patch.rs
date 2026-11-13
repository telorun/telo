//! Planning and applying a migration patch. Mirrors
//! `../../../nodejs/src/migrations/patch.ts`.
//!
//! A patch is ALL-OR-NOTHING at each match: [`plan_patch`] resolves every operation against
//! the tree first and returns either a concrete effect list or one refusal, and only then
//! does [`apply_effects_to_tree`] run. Node's plan also drives `telo migrate`'s YAML
//! applier, which this crate does not have: no Rust reader writes YAML back.

use serde_json::Value;
use telo_templating::{is_tagged_sentinel, make_tagged_sentinel, read_interpolation_holes, HoleReading};
use telorun_cel_value::es_number;

use super::r#match::deep_equals;
use super::types::{MigrationOperation, MigrationPath, MigrationRefusal, PathSegment, SetValue, TagSource};

/// A resolved, unconditionally applicable edit.
#[derive(Debug, Clone, PartialEq)]
pub enum MigrationEffect {
    RenameKey { parent: MigrationPath, from: String, to: String },
    SetValue { path: MigrationPath, value: Value },
    /// `replaces`: the scalar's text is replaced by `source` rather than kept.
    SetTag { path: MigrationPath, tag: String, source: String, replaces: bool },
    InsertItem { path: MigrationPath, index: usize, value: Value },
    AddKey { path: MigrationPath, key: String, value: Value },
    RemoveEntry { path: MigrationPath },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PatchPlan {
    pub effects: Vec<MigrationEffect>,
    /// Where the matched node lives after the patch.
    pub final_path: MigrationPath,
    /// The value at the match before anything was applied.
    pub before: Value,
    /// The value at the match after the patch; `None` for a removal.
    pub after: Option<Value>,
}

/// The value one step below `node`.
fn step<'v>(node: &'v Value, segment: &PathSegment) -> Option<&'v Value> {
    match segment {
        PathSegment::Index(index) => node.as_array()?.get(*index),
        PathSegment::Key(key) => node.as_object()?.get(key),
    }
}

/// The value at `path`, the document root for an empty path.
fn read_at<'v>(root: &'v Value, path: &[PathSegment]) -> Option<&'v Value> {
    path.iter().try_fold(root, |node, segment| step(node, segment))
}

fn read_at_mut<'v>(root: &'v mut Value, path: &[PathSegment]) -> Option<&'v mut Value> {
    let mut node = root;
    for segment in path {
        node = match segment {
            PathSegment::Index(index) => node.as_array_mut()?.get_mut(*index)?,
            PathSegment::Key(key) => node.as_object_mut()?.get_mut(key)?,
        };
    }
    Some(node)
}

/// The container a path's last segment indexes into, and that segment; none for the
/// document root, which is no mapping entry.
fn container_of<'v>(root: &'v Value, path: &'v [PathSegment]) -> Option<(Option<&'v Value>, &'v PathSegment)> {
    let (last, parents) = path.split_last()?;
    Some((read_at(root, parents), last))
}

/// A scalar YAML can carry behind a tag, as its text.
fn scalar_source(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => number.as_f64().map(es_number),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// Resolve `ops` at `path` against `root`, or refuse — the node is then left as the author
/// wrote it, for the ordinary validator to report.
pub fn plan_patch(root: &Value, path: &[PathSegment], ops: &[MigrationOperation]) -> Result<PatchPlan, MigrationRefusal> {
    if path.is_empty() {
        return Err(MigrationRefusal::PathNotFound);
    }
    let initial = read_at(root, path).ok_or(MigrationRefusal::PathNotFound)?.clone();

    let mut effects = Vec::new();
    let mut current_path: MigrationPath = path.to_vec();
    let mut current_value = Some(initial.clone());

    for op in ops {
        let Some(value) = current_value.clone() else {
            return Err(MigrationRefusal::PathNotFound);
        };
        match op {
            MigrationOperation::RenameKey { to } => {
                let Some((Some(Value::Object(container)), PathSegment::Key(key))) = container_of(root, &current_path)
                else {
                    return Err(MigrationRefusal::NotAMappingEntry);
                };
                if to != key && container.contains_key(to) {
                    return Err(MigrationRefusal::DestinationOccupied);
                }
                let from = key.clone();
                let parent = current_path[..current_path.len() - 1].to_vec();
                effects.push(MigrationEffect::RenameKey { parent: parent.clone(), from, to: to.clone() });
                current_path = parent;
                current_path.push(PathSegment::Key(to.clone()));
            }
            MigrationOperation::SetValue(set) => {
                let next = match set {
                    SetValue::Qualify(prefix) => {
                        let Value::String(text) = &value else {
                            return Err(MigrationRefusal::MalformedValue);
                        };
                        if text.starts_with(prefix.as_str()) {
                            return Err(MigrationRefusal::NothingToRewrite);
                        }
                        Value::String(format!("{prefix}{text}"))
                    }
                    SetValue::Value(written) => {
                        if deep_equals(written, &value) {
                            return Err(MigrationRefusal::NothingToRewrite);
                        }
                        written.clone()
                    }
                };
                effects.push(MigrationEffect::SetValue { path: current_path.clone(), value: next.clone() });
                current_value = Some(next);
            }
            MigrationOperation::SetTag { tag, source } => {
                let text = scalar_source(&value).ok_or(MigrationRefusal::NotAScalar)?;
                if *source == TagSource::Hole {
                    let HoleReading::Holes(holes) = read_interpolation_holes(&text) else {
                        return Err(MigrationRefusal::MalformedValue);
                    };
                    let [hole] = holes.as_slice() else {
                        return Err(MigrationRefusal::MalformedValue);
                    };
                    if !value.is_string() {
                        return Err(MigrationRefusal::MalformedValue);
                    }
                    let expression = hole.expr.clone();
                    effects.push(MigrationEffect::SetTag {
                        path: current_path.clone(),
                        tag: tag.clone(),
                        source: expression.clone(),
                        replaces: true,
                    });
                    current_value = Some(make_tagged_sentinel(tag, &expression));
                } else {
                    effects.push(MigrationEffect::SetTag {
                        path: current_path.clone(),
                        tag: tag.clone(),
                        source: text.clone(),
                        replaces: false,
                    });
                    current_value = Some(make_tagged_sentinel(tag, &text));
                }
            }
            MigrationOperation::InsertItem { value: item, at } => {
                let Value::Array(items) = &value else {
                    return Err(MigrationRefusal::NotASequence);
                };
                let index = at.map_or(items.len(), |at| at.min(items.len()));
                effects.push(MigrationEffect::InsertItem { path: current_path.clone(), index, value: item.clone() });
                let mut next = items.clone();
                next.insert(index, item.clone());
                current_value = Some(Value::Array(next));
            }
            MigrationOperation::AddKey { key, value: added } => {
                let Value::Object(map) = &value else {
                    return Err(MigrationRefusal::NotAMapping);
                };
                if is_tagged_sentinel(&value) {
                    return Err(MigrationRefusal::NotAMapping);
                }
                if map.contains_key(key) {
                    return Err(MigrationRefusal::DestinationOccupied);
                }
                effects.push(MigrationEffect::AddKey { path: current_path.clone(), key: key.clone(), value: added.clone() });
                let mut next = map.clone();
                next.insert(key.clone(), added.clone());
                current_value = Some(Value::Object(next));
            }
            MigrationOperation::RemoveEntry => {
                effects.push(MigrationEffect::RemoveEntry { path: current_path.clone() });
                current_value = None;
            }
        }
    }

    Ok(PatchPlan { effects, final_path: current_path, before: initial, after: current_value })
}

/// Apply a plan to the in-memory manifest tree, in place — the loader's own projection of
/// the document, never the author's file.
pub fn apply_effects_to_tree(root: &mut Value, effects: &[MigrationEffect]) {
    for effect in effects {
        match effect {
            MigrationEffect::RenameKey { parent, from, to } => {
                let Some(Value::Object(map)) = read_at_mut(root, parent) else { continue };
                // Rebuilt in place so the renamed key keeps its position.
                let entries = std::mem::take(map);
                for (key, value) in entries {
                    map.insert(if key == *from { to.clone() } else { key }, value);
                }
            }
            MigrationEffect::SetValue { path, value } => write_at(root, path, value.clone()),
            MigrationEffect::SetTag { path, tag, source, .. } => write_at(root, path, make_tagged_sentinel(tag, source)),
            MigrationEffect::InsertItem { path, index, value } => {
                if let Some(Value::Array(items)) = read_at_mut(root, path) {
                    items.insert((*index).min(items.len()), value.clone());
                }
            }
            MigrationEffect::AddKey { path, key, value } => {
                if let Some(Value::Object(map)) = read_at_mut(root, path) {
                    map.insert(key.clone(), value.clone());
                }
            }
            MigrationEffect::RemoveEntry { path } => {
                let Some((last, parents)) = path.split_last() else { continue };
                match (read_at_mut(root, parents), last) {
                    (Some(Value::Array(items)), PathSegment::Index(index)) if *index < items.len() => {
                        items.remove(*index);
                    }
                    (Some(Value::Object(map)), PathSegment::Key(key)) => {
                        map.shift_remove(key);
                    }
                    _ => {}
                }
            }
        }
    }
}

fn write_at(root: &mut Value, path: &[PathSegment], value: Value) {
    let Some((last, parents)) = path.split_last() else { return };
    match (read_at_mut(root, parents), last) {
        (Some(Value::Array(items)), PathSegment::Index(index)) => {
            if let Some(slot) = items.get_mut(*index) {
                *slot = value;
            }
        }
        (Some(Value::Object(map)), PathSegment::Key(key)) => {
            map.insert(key.clone(), value);
        }
        _ => {}
    }
}

/// Dotted rendering of a path, as the position index and every diagnostic's `data.path`
/// use it: `routes[0].handler`.
pub fn format_migration_path(path: &[PathSegment]) -> String {
    let mut out = String::new();
    for segment in path {
        match segment {
            PathSegment::Index(index) => out.push_str(&format!("[{index}]")),
            PathSegment::Key(key) => {
                if !out.is_empty() {
                    out.push('.');
                }
                out.push_str(key);
            }
        }
    }
    out
}
