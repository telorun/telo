//! Kinds the kernel implements itself rather than resolving to a controller.
//! Mirrors `../../nodejs/src/system-kinds.ts`.

/// The document kinds a manifest file may declare directly.
pub const APPLICATION: &str = "Telo.Application";
pub const LIBRARY: &str = "Telo.Library";
pub const DEFINITION: &str = "Telo.Definition";

/// Built-in kinds an author may instantiate without importing anything.
pub const JSON_SCHEMA: &str = "Telo.JsonSchema";

/// Documents that describe the module itself rather than a resource. A file
/// declares exactly one of them, as its first document.
pub fn is_module_document(kind: &str) -> bool {
    matches!(kind, APPLICATION | LIBRARY)
}

/// Kinds whose bodies `resolve_ref_sentinels` must not walk, mirroring the Node
/// pass's `REF_RESOLUTION_SKIP_KINDS`.
///
/// A `Telo.Definition` is a blueprint, not an instance: a `!ref` inside one
/// belongs to whatever the kind is instantiated *as*, and resolving it against
/// the declaring module's resource names would bind it to the wrong thing.
pub fn skips_ref_resolution(kind: &str) -> bool {
    kind == DEFINITION
}
