//! The reserved set and the two questions asked of a word.
//!
//! No Node test file is the twin of this one; Node's parser test holds the set to a
//! list of its own, as `tests/parser.rs` does here.
//!
//! Every word and every verdict is the Node build's answer, executed: `@telorun/cel`
//! 0.112.0, this branch's build.

use telorun_cel::{is_identifier_spelling, is_reserved_word, LITERAL_WORDS, OPERATOR_WORDS, RESERVED_WORDS};

const NODE_RESERVED_WORDS: [&str; 21] = ["as", "break", "const", "continue", "else", "false", "for", "function", "if", "import", "in", "let", "loop", "namespace", "null", "package", "return", "true", "var", "void", "while"];
const NODE_LITERAL_WORDS: [&str; 3] = ["true", "false", "null"];
const NODE_OPERATOR_WORDS: [&str; 1] = ["in"];

#[test]
fn lists_the_reserved_words_and_how_four_of_them_are_read() {
    assert_eq!(RESERVED_WORDS, NODE_RESERVED_WORDS);
    assert_eq!(LITERAL_WORDS, NODE_LITERAL_WORDS);
    assert_eq!(OPERATOR_WORDS, NODE_OPERATOR_WORDS);
}

#[test]
fn tells_an_identifier_spelling_and_a_reserved_word() {
    /// `(text, whether it is spelled as an identifier, whether it is reserved)`.
    const NODE_VERDICTS: [(&str, bool, bool); 15] = [
        ("a", true, false),
        ("_", true, false),
        ("_a1", true, false),
        ("A_b", true, false),
        ("if", true, true),
        ("in", true, true),
        ("true", true, true),
        ("1a", false, false),
        ("", false, false),
        ("a-b", false, false),
        ("a b", false, false),
        ("\u{e9}", false, false),
        ("a\n", false, false),
        ("a.b", false, false),
        (" a", false, false),
    ];
    for (text, spelled, reserved) in NODE_VERDICTS {
        assert_eq!(is_identifier_spelling(text), spelled, "{text:?}");
        assert_eq!(is_reserved_word(text), reserved, "{text:?}");
    }
}
