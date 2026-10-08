//! The words no CEL identifier may be: cel-spec's `RESERVED`, all 21 — `reserved-words.ts`.
//!
//! Three of them are refused by being read as something else: `true`, `false` and
//! `null` are literals, `in` is the membership operator. That split is the lexer's
//! whole policy about words, so it is declared here and the lexer holds no list.
//!
//! A reserved word is refused as an identifier, not as a member name.
//!
//! Private, as on Node's entry: the word reading.

/// cel-spec's `RESERVED`, in the order every engine lists it.
pub const RESERVED_WORDS: [&str; 21] = [
    "as",
    "break",
    "const",
    "continue",
    "else",
    "false",
    "for",
    "function",
    "if",
    "import",
    "in",
    "let",
    "loop",
    "namespace",
    "null",
    "package",
    "return",
    "true",
    "var",
    "void",
    "while",
];

/// The reserved words that are a literal where they stand.
pub const LITERAL_WORDS: [&str; 3] = ["true", "false", "null"];

/// The reserved words that are an operator where they stand.
pub const OPERATOR_WORDS: [&str; 1] = ["in"];

/// How a word is read where an expression begins.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WordReading {
    /// An ordinary identifier.
    Name,
    /// A literal value: `true`, `false`, `null`.
    Literal,
    /// An operator written as a word: `in`.
    Operator,
    /// Reserved, with no other reading — refused wherever a name is read.
    Refused,
}

pub(crate) fn word_reading(text: &str) -> WordReading {
    if LITERAL_WORDS.contains(&text) {
        WordReading::Literal
    } else if OPERATOR_WORDS.contains(&text) {
        WordReading::Operator
    } else if RESERVED_WORDS.contains(&text) {
        WordReading::Refused
    } else {
        WordReading::Name
    }
}

/// Whether the word is one cel-spec reserves, however it is read.
pub fn is_reserved_word(name: &str) -> bool {
    RESERVED_WORDS.contains(&name)
}

/// Whether the text is spelled as a CEL identifier, reserved or not.
pub fn is_identifier_spelling(text: &str) -> bool {
    let mut bytes = text.bytes();
    matches!(bytes.next(), Some(first) if first == b'_' || first.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
}
