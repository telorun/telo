//! Navigating a schema by JSON Pointer. Mirrors the pointer half of
//! `../../nodejs/src/manifest-navigation.ts`.

use serde_json::Value;

/// The node a local `#/…` reference names inside `root`, or `None` when the
/// reference is not local or names nothing.
pub fn resolve_schema_pointer<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    let mut node = root;
    for segment in pointer.split('/') {
        if segment.is_empty() {
            continue;
        }
        let key = segment.replace("~1", "/").replace("~0", "~");
        node = node.as_object()?.get(&key)?;
    }
    Some(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn follows_a_local_pointer_unescaping_each_segment() {
        let root = json!({ "$defs": { "a/b": { "type": "string" } } });
        assert_eq!(resolve_schema_pointer(&root, "#/$defs/a~1b"), Some(&json!({ "type": "string" })));
        assert_eq!(resolve_schema_pointer(&root, "#"), Some(&root));
        assert_eq!(resolve_schema_pointer(&root, "#/$defs/none"), None);
        assert_eq!(resolve_schema_pointer(&root, "telo://x"), None);
    }
}
