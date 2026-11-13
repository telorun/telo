//! Where author-written JSON Schema lives in a manifest. Mirrors
//! `../../nodejs/src/schema-region.ts`.
//!
//! The keys are the kernel's own schema-valued manifest keys, which no resource kind owns,
//! and a node is in a schema region when some ANCESTOR segment on the path to it is one of
//! them — an inline `inputType:` on any kind, a route's `request.schema.body` and a named
//! shape's `schema` alike.

use crate::migrations::types::PathSegment;

/// The kernel's schema-valued manifest keys.
pub const SCHEMA_REGION_KEYS: [&str; 5] = ["schema", "status", "inputType", "outputType", "itemType"];

/// True when `path` reaches into a schema region: some ancestor segment, the last one
/// excluded, is a schema-valued key.
pub fn is_in_schema_region(path: &[PathSegment]) -> bool {
    let ancestors = path.len().saturating_sub(1);
    path[..ancestors]
        .iter()
        .any(|segment| matches!(segment, PathSegment::Key(key) if SCHEMA_REGION_KEYS.contains(&key.as_str())))
}
