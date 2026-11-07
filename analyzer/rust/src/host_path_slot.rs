//! What a schema node says of a host path: whether it holds one, what its path
//! names (`entry: file | directory`), the media type its file holds
//! (`mediaType`) and the anchor that applies to a given text. Mirrors the slot readers of `../../nodejs/src/host-path-slot.ts`; the
//! static findings built on them have no Rust counterpart yet.

use serde_json::Value;
use telorun_sdk_core::value_type::{
    host_anchor_of, host_entry_of, host_media_type_mismatch, host_media_type_of, HostMediaTypeMismatch,
};

use crate::schema_compat::union_branches;

/// Whether a schema node holds a `Telo.HostPath` — declared on the node itself,
/// or as a branch of a union beside non-path readings (`anyOf: [{ const:
/// ":memory:" }, { x-telo-type: Telo.HostPath }]`).
pub fn holds_host_path(schema: &Value) -> bool {
    host_anchor_of(schema).is_some()
        || union_branches(schema)
            .unwrap_or_default()
            .into_iter()
            .any(|branch| host_anchor_of(branch).is_some())
}

/// What a host-path node says its path names — the node's own, or a union's
/// host-path branch's — or `None` when it says nothing, which matches either.
pub fn host_entry_at(schema: &Value) -> Option<&'static str> {
    if host_anchor_of(schema).is_some() {
        return host_entry_of(schema);
    }
    union_branches(schema)?
        .into_iter()
        .find(|branch| host_anchor_of(branch).is_some())
        .and_then(host_entry_of)
}

/// The node declaring a host path — the node itself, or a union's host-path branch.
fn host_path_node(schema: &Value) -> Option<&Value> {
    if host_anchor_of(schema).is_some() {
        return Some(schema);
    }
    union_branches(schema)?
        .into_iter()
        .find(|branch| host_anchor_of(branch).is_some())
}

/// The media type a host-path node says its file holds — the node's own, or a
/// union's host-path branch's — or `None` when it says nothing, which matches any.
pub fn host_media_type_at(schema: &Value) -> Option<&'static str> {
    host_path_node(schema).and_then(host_media_type_of)
}

/// A file's leading bytes judged against the media type its host-path node
/// declares, or `None` when it declares none or the head carries it.
pub fn host_media_type_mismatch_at(schema: &Value, head: &[u8]) -> Option<HostMediaTypeMismatch> {
    host_path_node(schema).and_then(|node| host_media_type_mismatch(node, head))
}

/// What a file the content refusal names holds: a media type (`None` when its
/// head carries no known one), or a directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldContent {
    MediaType(Option<&'static str>),
    Directory,
}

/// How a file's content refusal reads after its subject (`'tray.jpg'`), and the
/// media type the slot takes.
pub fn host_media_type_finding(subject: &str, found: HeldContent, declared: &str) -> String {
    let held = match found {
        HeldContent::Directory => "is a directory".to_string(),
        HeldContent::MediaType(Some(media_type)) => format!("is {media_type}"),
        HeldContent::MediaType(None) => "carries no known media type's signature".to_string(),
    };
    format!("{subject} {held}; this slot takes {declared}")
}

/// How a host entry reads in a message.
pub fn describe_host_entry(entry: &str) -> &'static str {
    if entry == "directory" {
        "a directory"
    } else {
        "a file"
    }
}

/// The `fromHost` anchor that applies to `text` at this node, or `None` when the
/// text is not a host path here: the node's own anchor, or — at a union — the
/// host-path branch's, unless the text is exactly what a constant branch names
/// (`":memory:"` is not a path beside one).
pub fn host_anchor_for(schema: &Value, text: &str) -> Option<&'static str> {
    if let Some(own) = host_anchor_of(schema) {
        return Some(own);
    }
    let branches = union_branches(schema).unwrap_or_default();
    if branches
        .iter()
        .any(|branch| branch.get("const").and_then(Value::as_str) == Some(text))
    {
        return None;
    }
    branches.into_iter().find_map(host_anchor_of)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sqlite_file() -> Value {
        json!({
            "anyOf": [
                { "const": ":memory:" },
                { "type": "string", "x-telo-type": { "name": "Telo.HostPath", "entry": "file" } }
            ]
        })
    }

    #[test]
    fn reads_a_node_and_a_union_branch_alike() {
        let root = json!({ "type": "string", "x-telo-type": { "name": "Telo.HostPath", "entry": "directory" } });
        assert!(holds_host_path(&root));
        assert_eq!(host_entry_at(&root), Some("directory"));
        assert!(holds_host_path(&sqlite_file()));
        assert_eq!(host_entry_at(&sqlite_file()), Some("file"));
        assert_eq!(host_entry_at(&json!({ "x-telo-type": "Telo.HostPath" })), None);
        assert!(!holds_host_path(&json!({ "type": "string" })));
    }

    #[test]
    fn a_constant_beside_the_path_is_not_a_path() {
        assert_eq!(host_anchor_for(&sqlite_file(), ":memory:"), None);
        assert_eq!(host_anchor_for(&sqlite_file(), "/srv/app.db"), Some("working-directory"));
        assert_eq!(host_anchor_for(&json!({ "type": "string" }), "/srv"), None);
    }

    #[test]
    fn reads_a_media_type_through_a_union_branch() {
        let icon = json!({
            "anyOf": [
                { "const": "none" },
                { "type": "string", "x-telo-type": { "name": "Telo.HostPath", "entry": "file", "mediaType": "image/png" } }
            ]
        });
        assert_eq!(host_media_type_at(&icon), Some("image/png"));
        assert_eq!(host_media_type_at(&sqlite_file()), None);
        assert_eq!(
            host_media_type_mismatch_at(&icon, &[0xff, 0xd8, 0xff]).map(|m| m.found),
            Some(Some("image/jpeg"))
        );
        assert_eq!(
            host_media_type_finding("icon: 'tray.jpg'", HeldContent::MediaType(Some("image/jpeg")), "image/png"),
            "icon: 'tray.jpg' is image/jpeg; this slot takes image/png"
        );
    }

    #[test]
    fn describes_each_entry() {
        assert_eq!(describe_host_entry("directory"), "a directory");
        assert_eq!(describe_host_entry("file"), "a file");
    }
}
