//! **`Telo.HostPath` at creation** — mirrors `../../nodejs/src/host-paths.ts`.
//!
//! Every host path a resource holds must be absolute, must not exist as the
//! other kind of entry than its slot names (`entry: file | directory`), and must
//! not be a file of another media type than its slot declares (`mediaType`). The slot
//! readers are the analyzer's; this file holds only what touches the filesystem.
//! Node's other half — resolving a host-supplied relative value against its
//! `fromHost` anchor — has nothing to do here: this kernel reads no host-supplied
//! value (`variables:` is refused at load).

use std::convert::Infallible;
use std::fs::Metadata;
use std::io::Read;

use serde_json::Value;
use telo_analyzer::host_path_slot::{
    describe_host_entry, host_anchor_for, host_entry_at, host_media_type_at, host_media_type_finding,
    host_media_type_mismatch_at, HeldContent,
};
use telo_analyzer::plain_literal_decoding::walk_text_leaves;
use telo_analyzer::value_type_keyword::host_path_relative_message;
use telorun_sdk_core::value_type::{
    host_anchor_of, host_media_head_length, is_absolute_host_path, value_types, HOST_ENTRY_KINDS,
};

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

/// The leading bytes of the file at an absolute path that exists, as many as
/// decide every media type.
fn head_at_path(text: &str) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(host_media_head_length());
    std::fs::File::open(text)?
        .take(host_media_head_length() as u64)
        .read_to_end(&mut head)?;
    Ok(head)
}

/// One host path in a value that is not what its slot says — the other kind of
/// entry, a file of another media type — or that the filesystem would not tell
/// about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPathMismatch {
    pub pointer: String,
    pub text: String,
    /// What the slot says the path names, when it says.
    pub wanted: Option<&'static str>,
    /// What is there, when it is the other kind of entry.
    pub found: Option<&'static str>,
    /// The media type the slot says the file holds, and what is there instead.
    pub content: Option<(&'static str, HeldContent)>,
    /// Why the path could not be read, when it could not.
    pub unreadable: Option<String>,
}

/// Every absolute host path in `value` whose slot declares what it names and that
/// exists as the other kind, whose slot declares a media type its file's leading
/// bytes do not carry, or that cannot be read. An absent path is never one: what
/// uses it may create it.
pub fn host_path_mismatches(value: &Value, schema: &Value) -> Vec<HostPathMismatch> {
    let mut out = Vec::new();
    let Ok(()) = walk_text_leaves::<Infallible>(
        value,
        schema,
        &mut |slot, text, pointer| {
            if host_anchor_for(slot, text).is_none() || !is_absolute_host_path(text) {
                return Ok(());
            }
            let wanted = host_entry_at(slot);
            let media_type = host_media_type_at(slot);
            if wanted.is_none() && media_type.is_none() {
                return Ok(());
            }
            let mismatch = |found, content, unreadable| HostPathMismatch {
                pointer: pointer.to_string(),
                text: text.to_string(),
                wanted,
                found,
                content,
                unreadable,
            };
            let unknown = media_type.map(|declared| (declared, HeldContent::MediaType(None)));
            let found = match host_entry_at_path(text) {
                Ok(Some(found)) => found,
                Ok(None) => return Ok(()),
                Err(error) => {
                    let content = if wanted.is_some() { None } else { unknown };
                    out.push(mismatch(None, content, Some(error.kind().to_string())));
                    return Ok(());
                }
            };
            if wanted.is_some_and(|wanted| wanted != found) {
                out.push(mismatch(Some(found), None, None));
                return Ok(());
            }
            let Some(declared) = media_type else {
                return Ok(());
            };
            if found == "directory" {
                out.push(mismatch(None, Some((declared, HeldContent::Directory)), None));
                return Ok(());
            }
            match head_at_path(text) {
                Err(error) => out.push(mismatch(None, unknown, Some(error.kind().to_string()))),
                Ok(head) => {
                    if let Some(judged) = host_media_type_mismatch_at(slot, &head) {
                        out.push(mismatch(None, Some((declared, HeldContent::MediaType(judged.found))), None));
                    }
                }
            }
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

/// A JSON Pointer in the dotted / bracketed spelling diagnostics use
/// (`roots[1]`), as the Node analyzer's `pointerToPath` writes it.
fn pointer_to_path(pointer: &str) -> String {
    pointer.split('/').skip(1).fold(String::new(), |path, segment| {
        let segment = segment.replace("~1", "/").replace("~0", "~");
        if !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()) {
            format!("{path}[{segment}]")
        } else if path.is_empty() {
            segment
        } else {
            format!("{path}.{segment}")
        }
    })
}

/// The code a mismatch is refused under.
pub fn host_path_mismatch_code(mismatch: &HostPathMismatch) -> &'static str {
    if mismatch.unreadable.is_some() {
        "ERR_HOST_PATH_UNREADABLE"
    } else if mismatch.content.is_some() {
        "ERR_HOST_PATH_CONTENT_MISMATCH"
    } else {
        "ERR_HOST_PATH_ENTRY_MISMATCH"
    }
}

/// How a mismatch reads, naming where it is (`'/root'`, or `it` for the whole value).
pub fn host_path_mismatch_text(mismatch: &HostPathMismatch) -> String {
    let subject = if mismatch.pointer.is_empty() {
        "it".to_string()
    } else {
        format!("'{}'", mismatch.pointer)
    };
    if let (Some((declared, held)), None) = (mismatch.content, &mismatch.unreadable) {
        let at = if mismatch.pointer.is_empty() {
            String::new()
        } else {
            format!("{}: ", pointer_to_path(&mismatch.pointer))
        };
        return host_media_type_finding(&format!("{at}'{}'", mismatch.text), held, declared);
    }
    let wanted = match (mismatch.wanted, mismatch.content) {
        (Some(wanted), _) => format!("takes the path of {}", describe_host_entry(wanted)),
        (None, Some((declared, _))) => format!("takes a file of {declared}"),
        (None, None) => "takes a host path".to_string(),
    };
    match mismatch.found {
        Some(found) => format!("{subject} {wanted}, but '{}' is {}", mismatch.text, describe_host_entry(found)),
        None => format!(
            "{subject} {wanted}, but what is at '{}' cannot be read ({})",
            mismatch.text,
            mismatch.unreadable.as_deref().unwrap_or("unknown")
        ),
    }
}

/// Refuse a host path a resource holds that exists and is the other kind of
/// entry than its slot names (`ERR_HOST_PATH_ENTRY_MISMATCH`), is a file of
/// another media type than its slot declares (`ERR_HOST_PATH_CONTENT_MISMATCH`),
/// or that the filesystem would not tell about (`ERR_HOST_PATH_UNREADABLE`).
pub fn refuse_mismatched_host_paths(resource: &Value, schema: &Value, label: &str) -> Result<(), KernelError> {
    match host_path_mismatches(resource, schema).first() {
        None => Ok(()),
        Some(mismatch) => Err(KernelError::new(
            host_path_mismatch_code(mismatch),
            format!("{label}: {}.", host_path_mismatch_text(mismatch)),
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
        std::fs::write(place("image.png"), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).unwrap();
        std::fs::write(place("image.jpg"), [0xff, 0xd8, 0xff, 0xe0, 0x00]).unwrap();
        let unreadable = place(&"a".repeat(300));
        let placed = |text: &str| {
            text.replace("{file}", &place("file"))
                .replace("{directory}", &place("directory"))
                .replace("{absent}", &place("absent"))
                .replace("{unreadable}", &unreadable)
                .replace("{png}", &place("image.png"))
                .replace("{jpeg}", &place("image.jpg"))
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
                .replace("{png}", &in_json(place("image.png")))
                .replace("{jpeg}", &in_json(place("image.jpg")))
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
            let outcome = refuse_mismatched_host_paths(&value, schema, "App.Store/store")
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
