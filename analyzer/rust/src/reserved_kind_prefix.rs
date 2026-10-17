//! The two names no module and no import may take: `Telo.<Kind>` names a
//! built-in kind and `Self.<Kind>` the declaring module's own, so a module named
//! after one, or an import aliased one, would replace them.
//! Mirrors `../../nodejs/src/reserved-kind-prefix.ts`, messages included.

pub const RESERVED_KIND_PREFIXES: [&str; 2] = ["Telo", "Self"];

pub fn is_reserved_kind_prefix(name: &str) -> bool {
    RESERVED_KIND_PREFIXES.contains(&name)
}

const WHY: &str =
    "`Telo.<Kind>` names a built-in kind and `Self.<Kind>` the declaring module's own";

/// A module doc's own `metadata.name`.
pub fn reserved_module_name_message(name: &str) -> String {
    format!("A module may not be named '{name}': {WHY}, so its kinds would replace them. Rename the module.")
}

/// An `imports:` key.
pub fn reserved_import_alias_message(alias: &str) -> String {
    format!("An import may not be aliased '{alias}': {WHY}, so this import would replace them. Choose another alias.")
}

/// An import whose target library is named with a reserved prefix.
pub fn reserved_library_name_message(source: &str, name: &str) -> String {
    format!(
        "'{source}' is a Telo.Library named '{name}': {WHY}, so its kinds would replace them. It cannot be imported until it is renamed."
    )
}
