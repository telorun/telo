//! A placeholder name, and a selection's selector, follow the Telo name rule: a letter
//! or `_`, then letters, digits or `_`, and not one of CEL's 21 reserved words.

const RESERVED_WORDS: [&str; 21] = [
    "as", "break", "const", "continue", "else", "false", "for", "function", "if", "import", "in", "let", "loop",
    "namespace", "null", "package", "return", "true", "var", "void", "while",
];

/// Why `name` cannot name a placeholder, or `None` when it can.
pub fn placeholder_name_refusal(name: &str) -> Option<String> {
    let mut chars = name.chars();
    let spelled = matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !spelled {
        return Some(format!(
            "{name} is not a name: a name starts with a letter or _ and continues with letters, digits or _"
        ));
    }
    if RESERVED_WORDS.contains(&name) {
        return Some(format!("{name} is a reserved word and cannot name a placeholder"));
    }
    None
}
