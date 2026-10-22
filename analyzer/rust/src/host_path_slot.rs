//! What a schema node says of a host path: whether it holds one, what its path
//! names (`entry: file | directory`) and the anchor that applies to a given
//! text. Mirrors the slot readers of `../../nodejs/src/host-path-slot.ts`; the
//! static findings built on them have no Rust counterpart yet.

use serde_json::Value;
use telorun_sdk_core::value_type::{host_anchor_of, host_entry_of};

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
    fn describes_each_entry() {
        assert_eq!(describe_host_entry("directory"), "a directory");
        assert_eq!(describe_host_entry("file"), "a file");
    }
}
