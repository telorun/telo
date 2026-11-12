//! The expansion tags — `!if`, `!switch`, `!for-each` — mirroring
//! `../../nodejs/src/expansion-tags.ts`.
//!
//! Each sits on a mapping and loads as that same mapping, the marker
//! [`EXPANSION_MARKER`] naming the tag FIRST and the written keys after it in
//! written order — the identical value the Node loader produces. `...` is a plain
//! key to both loaders.

use serde_json::Value;

use crate::yaml_composer::{ScalarValue, YamlDocument, YamlNodeKind, YamlTag};

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

/// An expansion tag the YAML itself refuses: one written on a scalar or a sequence, or a
/// tagged mapping writing the marker key itself.
#[derive(Debug, Clone, PartialEq)]
pub struct ExpansionTagMisuse {
    pub tag: String,
    pub code: &'static str,
    pub message: String,
    /// The node's `[start, valueEnd]`, in UTF-16 code units.
    pub range: [usize; 2],
}

/// Every misuse of an expansion tag in one composed document, in the document's order —
/// what no loaded tree can show, since a tag on a scalar or a sequence loads as the bare
/// value. Reported at load by every loader.
pub fn expansion_tag_misuse(document: &YamlDocument) -> Vec<ExpansionTagMisuse> {
    let mut found = Vec::new();
    let mut stack: Vec<usize> = document.root.into_iter().collect();
    while let Some(id) = stack.pop() {
        let node = &document.nodes[id];
        let name = match &node.tag {
            Some(YamlTag::Local(name)) if is_expansion_tag(name) => Some(name.as_str()),
            _ => None,
        };
        let written = match &node.kind {
            YamlNodeKind::Scalar(_) => Some("a scalar"),
            YamlNodeKind::Sequence { .. } => Some("a sequence"),
            _ => None,
        };
        if let Some(tag) = name {
            let message = match &node.kind {
                YamlNodeKind::Mapping { entries, .. } => entries
                    .iter()
                    .any(|entry| {
                        matches!(&document.nodes[entry.key].kind,
                            YamlNodeKind::Scalar(key) if key.value == ScalarValue::String && key.text == EXPANSION_MARKER)
                    })
                    .then(|| format!("'!{tag}' holds a key '{EXPANSION_MARKER}', which is reserved for the tag's own marker. Remove it.")),
                _ => written.map(|written| {
                    format!("'!{tag}' is written on {written}; it takes a mapping ({}).", expansion_tag_keys(tag))
                }),
            };
            if let Some(message) = message {
                found.push(ExpansionTagMisuse { tag: tag.to_string(), code: expansion_shape_code(tag), message, range: node.range });
            }
        }
        match &node.kind {
            YamlNodeKind::Sequence { items, .. } => stack.extend(items.iter().rev()),
            YamlNodeKind::Mapping { entries, .. } => {
                for entry in entries.iter().rev() {
                    stack.extend(entry.value);
                    stack.push(entry.key);
                }
            }
            _ => {}
        }
    }
    found
}
