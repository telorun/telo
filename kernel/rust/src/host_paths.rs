//! **`Telo.HostPath` at creation** — mirrors `../../nodejs/src/host-paths.ts`.
//!
//! Every host path a resource holds must be absolute, and must not exist as the
//! other kind of entry than its slot names (`entry: file | directory`). The slot
//! readers are the analyzer's; this file holds only what touches the filesystem.
//! Node's other half — resolving a host-supplied relative value against its
//! `fromHost` anchor — has nothing to do here: this kernel reads no host-supplied
//! value (`variables:` is refused at load).

use std::convert::Infallible;
use std::fs::Metadata;

use serde_json::Value;
use telo_analyzer::host_path_slot::{describe_host_entry, host_anchor_for, host_entry_at};
use telo_analyzer::plain_literal_decoding::walk_text_leaves;
use telo_analyzer::value_type_keyword::host_path_relative_message;
use telorun_sdk_core::value_type::{host_anchor_of, is_absolute_host_path, value_types, HOST_ENTRY_KINDS};

use crate::error::KernelError;

/// Each host-entry token mapped to this runtime's filesystem query, links followed.
fn host_entry_query(kind: &str) -> Option<fn(&Metadata) -> bool> {
    match kind {
        "file" => Some(|meta| !meta.is_dir()),
        "directory" => Some(|meta| meta.is_dir()),
        _ => None,
    }
}

/// A token this runtime cannot query would leave its slots unchecked, so it is a
/// startup error, as an unmapped value-type binding is.
pub fn verify_host_entry_queries() {
    for kind in HOST_ENTRY_KINDS {
        assert!(
            host_entry_query(kind).is_some(),
            "Host-entry '{kind}' has no filesystem query in this kernel."
        );
    }
}

/// What is at an absolute path: the token whose query it answers, `None` when
/// nothing is there, or the error the filesystem answered with.
fn host_entry_at_path(text: &str) -> std::io::Result<Option<&'static str>> {
    let meta = match std::fs::metadata(text) {
        Ok(meta) => meta,
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(err) => return Err(err),
    };
    Ok(HOST_ENTRY_KINDS
        .iter()
        .copied()
        .find(|kind| host_entry_query(kind).is_some_and(|query| query(&meta))))
}

/// One host path in a value whose slot says what it names, and that is the other
/// kind of entry — or that the filesystem would not tell about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEntryMismatch {
    pub pointer: String,
    pub text: String,
    pub wanted: &'static str,
    /// What is there, when the path could be read.
    pub found: Option<&'static str>,
    /// Why the path could not be read, when it could not.
    pub unreadable: Option<String>,
}

/// Every absolute host path in `value` whose slot declares what it names and that
/// exists as the other kind, or cannot be read. An absent path is never one: what
/// uses it may create it.
pub fn host_entry_mismatches(value: &Value, schema: &Value) -> Vec<HostEntryMismatch> {
    let mut out = Vec::new();
    let Ok(()) = walk_text_leaves::<Infallible>(
        value,
        schema,
        &mut |slot, text, pointer| {
            if host_anchor_for(slot, text).is_none() || !is_absolute_host_path(text) {
                return Ok(());
            }
            let Some(wanted) = host_entry_at(slot) else {
                return Ok(());
            };
            let (found, unreadable) = match host_entry_at_path(text) {
                Ok(Some(found)) if found != wanted => (Some(found), None),
                Ok(_) => return Ok(()),
                Err(error) => (None, Some(error.kind().to_string())),
            };
            out.push(HostEntryMismatch {
                pointer: pointer.to_string(),
                text: text.to_string(),
                wanted,
                found,
                unreadable,
            });
            Ok(())
        },
        None,
    );
    out
}

/// Whether a schema declares a host path anywhere, so a kind declaring none walks
/// nothing at creation.
pub fn declares_host_path(schema: &Value) -> bool {
    match schema {
        Value::Object(entries) => host_anchor_of(schema).is_some() || entries.values().any(declares_host_path),
        Value::Array(items) => items.iter().any(declares_host_path),
        _ => false,
    }
}

/// How a mismatch reads after its subject.
pub fn host_entry_mismatch_text(mismatch: &HostEntryMismatch) -> String {
    let wanted = describe_host_entry(mismatch.wanted);
    match mismatch.found {
        Some(found) => format!(
            "takes the path of {wanted}, but '{}' is {}",
            mismatch.text,
            describe_host_entry(found)
        ),
        None => format!(
            "takes the path of {wanted}, but what is at '{}' cannot be read ({})",
            mismatch.text,
            mismatch.unreadable.as_deref().unwrap_or("unknown")
        ),
    }
}

/// Refuse a host path a resource holds that exists and is the other kind of
/// entry than its slot names (`ERR_HOST_PATH_ENTRY_MISMATCH`), or that the
/// filesystem would not tell about (`ERR_HOST_PATH_UNREADABLE`).
pub fn refuse_misplaced_host_entries(resource: &Value, schema: &Value, label: &str) -> Result<(), KernelError> {
    match host_entry_mismatches(resource, schema).first() {
        None => Ok(()),
        Some(mismatch) => Err(KernelError::new(
            if mismatch.found.is_some() {
                "ERR_HOST_PATH_ENTRY_MISMATCH"
            } else {
                "ERR_HOST_PATH_UNREADABLE"
            },
            format!("{label}: '{}' {}.", mismatch.pointer, host_entry_mismatch_text(mismatch)),
        )),
    }
}

/// Refuse a relative host path a resource holds (`ERR_HOST_PATH_RELATIVE`). This
/// kernel runs no analysis and its schema validator does not read `x-telo-type`,
/// so a relative literal is refused here, where the Node kernel's load-time
/// analysis refuses it first.
pub fn refuse_relative_host_paths(resource: &Value, schema: &Value, label: &str) -> Result<(), KernelError> {
    let host_path = &value_types()["Telo.HostPath"];
    walk_text_leaves(
        resource,
        schema,
        &mut |slot, text, _| {
            if host_anchor_for(slot, text).is_none() || is_absolute_host_path(text) {
                return Ok(());
            }
            Err(KernelError::new(
                "ERR_HOST_PATH_RELATIVE",
                format!("{label}: '{text}' {}.", host_path_relative_message(host_path)),
            ))
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const VECTORS: &str = include_str!("../../../analyzer/host-path-conformance/vectors.json");

    #[test]
    fn answers_every_host_path_conformance_vector() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let place = |name: &str| scratch.path().join(name).to_string_lossy().into_owned();
        std::fs::write(place("file"), "x").unwrap();
        std::fs::create_dir(place("directory")).unwrap();
        let unreadable = place(&"a".repeat(300));
        let placed = |text: &str| {
            text.replace("{file}", &place("file"))
                .replace("{directory}", &place("directory"))
                .replace("{absent}", &place("absent"))
                .replace("{unreadable}", &unreadable)
        };
        // Inside JSON text a Windows path's backslashes must be escaped.
        let in_json = |path: String| {
            let quoted = serde_json::to_string(&path).unwrap();
            quoted[1..quoted.len() - 1].to_string()
        };
        let placed_in_json = |text: &str| {
            text.replace("{file}", &in_json(place("file")))
                .replace("{directory}", &in_json(place("directory")))
                .replace("{absent}", &in_json(place("absent")))
                .replace("{unreadable}", &in_json(unreadable.clone()))
        };
        let schema = &vectors["schema"];
        for row in vectors["rows"].as_array().unwrap() {
            let id = row["id"].as_str().unwrap();
            // Windows reports an over-long name as absent, so it has no `{unreadable}` path to give.
            if cfg!(windows) && row["value"].to_string().contains("{unreadable}") {
                continue;
            }
            let value: Value = serde_json::from_str(&placed_in_json(&row["value"].to_string())).unwrap();
            // The order a resource is checked in at creation.
            let outcome = refuse_misplaced_host_entries(&value, schema, "App.Store/store")
                .and_then(|()| refuse_relative_host_paths(&value, schema, "App.Store/store"));
            match row["code"].as_str() {
                None => assert!(outcome.is_ok(), "{id}: {:?}", outcome.err()),
                Some(code) => {
                    let err = outcome.expect_err(id);
                    assert_eq!(err.code, code, "{id}");
                    let message = format!("App.Store/store: {}", placed(row["message"].as_str().unwrap()));
                    // `{reason}` is the operating system's own words, which each runtime reports its own way.
                    match message.split_once("{reason}") {
                        None => assert_eq!(err.message, message, "{id}"),
                        Some((before, after)) => assert!(
                            err.message.len() > before.len() + after.len()
                                && err.message.starts_with(before)
                                && err.message.ends_with(after),
                            "{id}: {}",
                            err.message
                        ),
                    }
                }
            }
        }
    }

    #[test]
    fn every_host_entry_kind_has_a_query() {
        verify_host_entry_queries();
    }

    #[test]
    fn finds_a_host_path_anywhere_in_a_schema() {
        assert!(declares_host_path(&json!({
            "properties": { "file": { "anyOf": [{ "const": ":memory:" }, { "x-telo-type": "Telo.HostPath" }] } }
        })));
        assert!(!declares_host_path(&json!({ "properties": { "url": { "x-telo-type": "Telo.Url" } } })));
    }
}
