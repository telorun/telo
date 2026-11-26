//! A module document's inline `imports:` map as synthetic `Telo.Import` documents, mirroring
//! `../../nodejs/src/inline-imports.ts`. Each entry is a bare source string (shorthand for
//! `{ source }`) or the object form; an entry with no string `source` is skipped, since the
//! module document's own schema reports it at `imports.<Alias>.source`.
//!
//! The synthetic documents are appended after the written ones, each with a position index
//! re-rooted from the module document's `imports.<Alias>` subtree, so a diagnostic on one
//! lands on the `imports:` entry the author wrote. No `ast_documents` entry backs them.

use serde_json::{Map, Value};
use telo_templating::{expansion_tag_of, SPLICE_KEY};

use crate::loaded_types::LoadedFile;
use crate::position_metadata::DocumentPosition;
use crate::sources::integrity::fold_integrity;
use crate::system_kinds::is_module_document;
use crate::types::{kind_of, PositionIndex, ResourceManifest};

/// The import kind every desugared entry is written as.
pub const IMPORT: &str = "Telo.Import";

/// A synthetic `Telo.Import` and the position metadata pinning it to its `imports:` entry.
pub struct SyntheticImport {
    pub manifest: ResourceManifest,
    pub position: DocumentPosition,
}

/// The fields of an object-form entry an import carries over, in Node's order.
const CARRIED: [&str; 6] = ["variables", "secrets", "resources", "needs", "runtime", "logging"];

/// The synthetic imports `module_manifest`'s `imports:` map declares.
pub fn inline_import_manifests(
    module_manifest: &ResourceManifest,
    module_position: Option<&DocumentPosition>,
) -> Vec<SyntheticImport> {
    let Some(raw) = module_manifest.get("imports").and_then(Value::as_object) else { return Vec::new() };
    let mut out = Vec::new();
    for (alias, value) in raw {
        let Some(entry) = desugared_entry(value) else { continue };
        let scalar = value.is_string();
        let source = entry.get("source").and_then(Value::as_str).unwrap_or_default();
        let mut manifest = Map::new();
        manifest.insert("kind".to_string(), Value::String(IMPORT.to_string()));
        manifest.insert("metadata".to_string(), Value::Object(Map::from_iter([("name".to_string(), Value::String(alias.clone()))])));
        manifest.insert("source".to_string(), Value::String(fold_integrity(source, entry.get("integrity"))));
        for field in CARRIED {
            if let Some(carried) = entry.get(field) {
                manifest.insert(field.to_string(), carried.clone());
            }
        }
        out.push(SyntheticImport {
            manifest: Value::Object(manifest),
            position: synth_position(module_position, alias, scalar),
        });
    }
    out
}

/// An `imports:` entry as the desugarer reads it, or `None` for one it skips: no string `source`,
/// a tagged integrity, or a splice.
fn desugared_entry(value: &Value) -> Option<Map<String, Value>> {
    let entry = match value {
        Value::String(source) => Map::from_iter([("source".to_string(), Value::String(source.clone()))]),
        Value::Object(map) => map.clone(),
        _ => return None,
    };
    entry.get("source").and_then(Value::as_str)?;
    // A tagged integrity, or a splice, is refused by the parse; the entry is read no further.
    if entry.get("integrity").and_then(expansion_tag_of).is_some() || entry.contains_key(SPLICE_KEY) {
        return None;
    }
    Some(entry)
}

/// The `imports.<alias>.<field>` positions of a module document that its desugared imports
/// carry, so each is judged at its `Telo.Import`; every other field of an entry (`source`,
/// `integrity`) is read by the desugarer alone.
pub fn carried_import_paths(module_manifest: &ResourceManifest) -> Vec<String> {
    let Some(raw) = module_manifest.get("imports").and_then(Value::as_object) else { return Vec::new() };
    let mut out = Vec::new();
    for (alias, value) in raw {
        let Some(entry) = desugared_entry(value) else { continue };
        out.extend(CARRIED.iter().filter(|field| entry.contains_key(**field)).map(|field| format!("imports.{alias}.{field}")));
    }
    out
}

/// `file` with its module document's inline imports appended to `manifests` and
/// `positions`; unchanged when it has no module document or that declares none.
pub fn desugar_loaded_file(mut file: LoadedFile) -> LoadedFile {
    let Some(index) = file.manifests.iter().position(|m| m.as_ref().and_then(kind_of).is_some_and(is_module_document))
    else {
        return file;
    };
    let module = file.manifests[index].as_ref().expect("a module document is present");
    let synthetic = inline_import_manifests(module, file.positions.get(index));
    for import in synthetic {
        file.manifests.push(Some(import.manifest));
        file.positions.push(import.position);
    }
    file
}

/// The module document's `imports.<alias>` position subtree, re-rooted at the import's own
/// paths (`source`, `variables.*`, `metadata.name`).
fn synth_position(module_position: Option<&DocumentPosition>, alias: &str, scalar: bool) -> DocumentPosition {
    let Some(module_position) = module_position else {
        return DocumentPosition { source_line: 0, position_index: PositionIndex::new() };
    };
    let base = &module_position.position_index;
    let mut index = PositionIndex::new();
    let key_range = base.get(&format!("@key:imports.{alias}")).copied();
    let value_range = base.get(&format!("imports.{alias}")).copied();
    if let Some(key) = key_range {
        index.insert("metadata.name".to_string(), key);
        index.insert("@key:metadata.name".to_string(), key);
    }
    if scalar {
        if let Some(value) = value_range {
            index.insert("source".to_string(), value);
        }
    } else {
        let value_prefix = format!("imports.{alias}.");
        let key_prefix = format!("@key:imports.{alias}.");
        for (path, range) in base {
            if let Some(rest) = path.strip_prefix(&value_prefix) {
                index.insert(rest.to_string(), *range);
            } else if let Some(rest) = path.strip_prefix(&key_prefix) {
                index.insert(format!("@key:{rest}"), *range);
            }
        }
    }
    if let Some(value) = value_range {
        index.insert(String::new(), value);
    }
    let source_line = key_range.or(value_range).map_or(module_position.source_line, |range| range.start.line);
    DocumentPosition { source_line, position_index: index }
}
