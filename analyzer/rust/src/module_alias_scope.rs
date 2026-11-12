//! Which definition a kind written in a module names, mirroring the lookup half of
//! `../../nodejs/src/module-alias-scope.ts` (`definitionInScope`) over a loaded graph:
//! `Self.<Kind>` and `<module>.<Kind>` name the module's own definitions, `<Alias>.<Kind>`
//! an imported library's, gated by its `exports.kinds`. A re-exported kind and a built-in
//! `Telo.<Kind>` resolve to nothing here — no pass judging through this lookup reads them
//! yet, and a kind that resolves to nothing is a judgement left unmade, never a wrong one.

use serde_json::Value;

use crate::loaded_types::LoadedFile;
use crate::loaded_types::LoadedGraph;
use crate::system_kinds::DEFINITION;
use crate::types::{kind_of, name_of};

/// The `Telo.Definition` document the kind `kind`, written in the module of the file at
/// `source`, names.
pub fn definition_in_scope<'g>(graph: &'g LoadedGraph, source: &str, kind: &str) -> Option<&'g Value> {
    let (prefix, suffix) = kind.split_once('.')?;
    let file = &graph.modules.get(source)?.owner;
    let own_name = file.module_document().and_then(name_of);
    if prefix == "Self" || Some(prefix) == own_name {
        return definition_named(file, suffix);
    }
    let edge = graph.import_edges.get(source)?.get(prefix)?;
    let target = &graph.modules.get(&edge.target_source)?.owner;
    let exported = target
        .module_document()
        .and_then(|module| module.get("exports"))
        .and_then(|exports| exports.get("kinds"));
    if let Some(exported) = exported {
        let listed = exported.as_array().is_some_and(|kinds| kinds.iter().any(|k| k.as_str() == Some(suffix)));
        if !listed {
            return None;
        }
    }
    definition_named(target, suffix)
}

/// The one definition of `name` the file declares; two of one name decide nothing.
fn definition_named<'g>(file: &'g LoadedFile, name: &str) -> Option<&'g Value> {
    let mut found = file.documents().filter(|document| kind_of(document) == Some(DEFINITION) && name_of(document) == Some(name));
    let first = found.next()?;
    found.next().is_none().then_some(first)
}
