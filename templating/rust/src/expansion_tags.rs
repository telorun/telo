//! The expansion tags — `!if`, `!switch`, `!for-each` — mirroring
//! `../../nodejs/src/expansion-tags.ts`.
//!
//! Each sits on a mapping and loads as that same mapping, the marker
//! [`EXPANSION_MARKER`] naming the tag FIRST and the written keys after it in
//! written order — the identical value the Node loader produces. `...` is a plain
//! key to both loaders.

use serde_json::Value;

/// The three tag names.
pub const EXPANSION_TAGS: &[&str] = &["if", "switch", "for-each"];

/// The key a loaded expansion mapping carries its tag under.
pub const EXPANSION_MARKER: &str = "__expand";

/// The mapping key that splices a `!for-each`'s entries into its mapping.
pub const SPLICE_KEY: &str = "...";

/// True when `name` is one of the expansion tags.
pub fn is_expansion_tag(name: &str) -> bool {
    EXPANSION_TAGS.contains(&name)
}

/// The tag a loaded value was written behind, or `None`.
pub fn expansion_tag_of(value: &Value) -> Option<&str> {
    value
        .as_object()?
        .get(EXPANSION_MARKER)?
        .as_str()
        .filter(|tag| is_expansion_tag(tag))
}

/// The code a shape refusal of `tag` is reported under.
pub fn expansion_shape_code(tag: &str) -> &'static str {
    if tag == "for-each" {
        "REPEAT_SHAPE_INVALID"
    } else {
        "BRANCH_SHAPE_INVALID"
    }
}

/// The keys a tag takes, for a refusal's wording.
pub fn expansion_tag_keys(tag: &str) -> &'static str {
    match tag {
        "if" => "'{ if, then, else? }'",
        "switch" => "'{ switch, cases, default? }'",
        _ => "'{ in, as?, emit }'",
    }
}
