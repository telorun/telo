//! Mirrors `../../nodejs/src/bundle/`: the read side of a layered module
//! artifact — tar, content integrity, the layer entry rules, the owner document,
//! staged files and materialization.

pub mod files_integrity;
pub mod layer_entry_rules;
pub mod module_artifact;
pub mod module_manifest;
pub mod staged_entry;
pub mod tar;
