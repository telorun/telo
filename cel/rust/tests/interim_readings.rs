//! Node readings of doubtful intent, reproduced until Node changes: a second engine
//! that read a source differently would make two kernels disagree about one manifest.
//!
//! No Node test file is the twin of this one, and no Node test pins any of these.
//! Every row is the Node build's answer, executed: `@telorun/cel` 0.112.0 at
//! `d265cc79`.
//!
//! Two of them are about the writer: an optional entry is written wherever a tree
//! holds one, whether or not the reader that takes the text will accept it; and a
//! literal word after a dot, and an empty quoted member, read clean and cannot be
//! written back; and a negation of a chain that starts at a number is written as text
//! that reads back as another expression.
//!
//! One answer here is this crate's own and not Node's: the message of an escape
//! before a character outside the basic plane, which Node writes with an unpaired
//! surrogate that no `String` can hold. Its tree, code and range are Node's.

mod support;

use support::*;
use telorun_cel::{parse_syntax, serialize_tree, trees_equal, CelSyntaxCode, CelSyntaxDiagnostic};

#[test]
fn interim_a_lexer_error_anywhere_beats_an_earlier_parser_error() {
    // The tree is what the parser builds already stopped: the first primary alone, an
    // open call with no arguments, an open aggregate with no elements.
    assert_reads_as_node(vec![
        reading("1 + 2 + 'abc", defaults(), literal_int(1, 0, 1), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 8, 12))),
        reading("f(1, 'abc", defaults(), call("f", (0, 1), vec![], 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 5, 9))),
        reading("[1, 'abc", defaults(), list(vec![], 0, 1), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 4, 8))),
        reading("{1: 2, 'abc", defaults(), map(vec![], 0, 1), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 7, 11))),
        reading(") + 'abc", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 4, 8))),
        reading("-1 + 'abc", defaults(), literal_int(-1, 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 5, 9))),
        reading("- 'abc", defaults(), unary("-", unparsed(2, 2), 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 2, 6))),
        reading("!x 'abc", defaults(), unary("!", ident("x", false, 1, 2), 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 3, 7))),
        reading("(((a 'abc", defaults(), ident("a", false, 3, 4), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 5, 9))),
        reading(".y 'abc", defaults(), ident("y", true, 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 3, 7))),
        reading(". 'abc", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 2, 6))),
        reading("a.b #", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"#\"", 4, 5))),
        reading("9223372036854775808 #", defaults(), unparsed(0, 19), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"#\"", 20, 21))),
        reading("true #", defaults(), literal_bool(true, 0, 4), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"#\"", 5, 6))),
        reading("'abc", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 0, 4))),
    ]);
}

#[test]
fn interim_reads_a_literal_word_after_a_dot_as_an_absolute_name() {
    assert_reads_as_node(vec![
        reading(".true", defaults(), ident("true", true, 0, 5), None),
        reading(".false", defaults(), ident("false", true, 0, 6), None),
        reading(".null", defaults(), ident("null", true, 0, 5), None),
        reading(".true.x", defaults(), select(ident("true", true, 0, 5), "x", (6, 7), false, false, 0, 7), None),
        reading(".null(1)", defaults(), ident("null", true, 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here", 5, 6))),
    ]);
}

#[test]
fn interim_reads_an_empty_quoted_member_as_a_select_with_an_empty_field() {
    let rows = vec![
        reading("a.``", defaults(), select(ident("a", false, 0, 1), "", (2, 4), false, true, 0, 4), None),
        reading("a.``.b", defaults(), select(select(ident("a", false, 0, 1), "", (2, 4), false, true, 0, 4), "b", (5, 6), false, false, 0, 6), None),
        reading("a.?``", defaults(), select(ident("a", false, 0, 1), "", (3, 5), true, true, 0, 5), None),
    ];
    assert!(rows.iter().all(|row| row.diagnostic.is_none()));
    assert_reads_as_node(rows);
}

#[test]
fn interim_a_raw_single_line_literal_continues_across_a_backslash_and_a_line_feed() {
    // And a backslash that ends the source is kept as content, so the literal is
    // unterminated to the very end.
    assert_reads_as_node(vec![
        reading("r'a\\\nb'", defaults(), literal_string("a\\\nb", 0, 7), None),
        reading("r'abc\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 6))),
        reading("r'abc\\\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 7))),
        reading("br'a\\\nb'", defaults(), literal_bytes(&[97, 92, 10, 98], 0, 8), None),
        reading("r'''a\\'''b'''", defaults(), literal_string("a\\'''b", 0, 13), None),
        reading("r'\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 3))),
    ]);
}

#[test]
fn interim_a_single_line_literal_holds_a_raw_carriage_return() {
    assert_reads_as_node(vec![
        reading("'a\rb'", defaults(), literal_string("a\rb", 0, 5), None),
        reading("b'a\rb'", defaults(), literal_bytes(&[97, 13, 98], 0, 6), None),
        reading("`a\rb`", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a\\rb`\" cannot stand here, expected \"a member read, as in a.`b`\"", 0, 5))),
        reading("a.`b\rc`", defaults(), select(ident("a", false, 0, 1), "b\rc", (2, 7), false, true, 0, 7), None),
    ]);
}

#[test]
fn interim_reports_a_character_outside_the_basic_plane_as_its_leading_surrogate() {
    // One code unit of two, in the message and in the range.
    assert_reads_as_node(vec![
        reading("\u{1f600}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\\ud83d\"", 0, 1))),
        reading("a + \u{1f600}", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\\ud83d\"", 4, 5))),
        reading("\u{1f600}\u{1f600}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\\ud83d\"", 0, 1))),
    ]);
}

#[test]
fn interim_ranges_an_escape_by_its_nominal_width_past_the_end_of_the_source() {
    let rows = vec![
        reading("\"\\x", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 5))),
        reading("\"\\0", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 1, 5))),
        reading("\"\\u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\u escape takes 4 hexadecimal digits", 1, 7))),
        reading("\"\\U", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\U escape takes 8 hexadecimal digits", 1, 11))),
        reading("'abc\\x4", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 4, 8))),
        reading("b'\\7", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 2, 6))),
    ];
    for row in &rows {
        let end = row.diagnostic.as_ref().expect(row.source).range.end;
        assert!(end as usize > row.source.encode_utf16().count(), "{}", row.source);
    }
    assert_reads_as_node(rows);
}

#[test]
fn interim_writes_an_optional_entry_whatever_the_reader_of_the_text_accepts() {
    // `(source, the text Node writes, whether it reads back equal with the optional
    // syntax on, Node's diagnostic for that text with it off)`.
    let node_written: [(&str, &str, bool, Option<CelSyntaxDiagnostic>); 4] = [
        ("[?x]", "[?x]", true, Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
        ("{?k: v}", "{?k: v}", true, Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
        ("[?a, b]", "[?a, b]", true, Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
        ("{?'k': v, 'j': w}", "{?\"k\": v, \"j\": w}", true, Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
    ];
    for (source, written, equal_when_on, refusal_when_off) in node_written {
        let parsed = parse_syntax(source, &optional_syntax());
        assert_eq!(parsed.diagnostic, None, "{source}");
        assert_eq!(serialize_tree(&parsed.root).as_deref(), Ok(written), "{source}");
        let on = parse_syntax(written, &optional_syntax());
        assert_eq!(on.diagnostic, None, "{written}");
        assert_eq!(trees_equal(&parsed.root, &on.root), equal_when_on, "{written}");
        assert!(refusal_when_off.is_some(), "{written}");
        assert_eq!(read(written).diagnostic, refusal_when_off, "{written}");
    }
}

#[test]
fn interim_writes_a_negated_chain_on_a_number_as_a_chain_on_the_negative_number() {
    // `-(1).a` negates a member of 1; its text `-1.a` is a member of -1.
    // `(source, the text Node writes, the tree Node re-reads)`; Node re-reads each with
    // no diagnostic and holds the two trees unequal.
    let node_written = [
        ("-(1).a", "-1.a", select(literal_int(-1, 0, 2), "a", (3, 4), false, false, 0, 4)),
        ("-(1)[0]", "-1[0]", index(literal_int(-1, 0, 2), literal_int(0, 3, 4), false, 0, 5)),
        ("-(1).f()", "-1.f()", receiver_call(literal_int(-1, 0, 2), "f", (3, 4), vec![], 0, 6)),
        ("-(1.5).a", "-1.5.a", select(literal_double(0xbff8000000000000, 0, 4), "a", (5, 6), false, false, 0, 6)),
        ("-(0).a", "-0.a", select(literal_int(0, 0, 2), "a", (3, 4), false, false, 0, 4)),
    ];
    for (source, written, reread_tree) in node_written {
        let first = tree(source);
        assert_eq!(serialize_tree(&first).as_deref(), Ok(written), "{source}");
        let reread = read(written);
        assert_eq!(reread.diagnostic, None, "{written}");
        assert_eq!(reread.root, reread_tree, "{written}");
        assert!(!trees_equal(&first, &reread.root), "{source} → {written}");
    }
}

#[test]
fn interim_reads_clean_what_the_writer_then_refuses() {
    /// `(a source Node reads with no diagnostic, Node's refusal to write its tree)`.
    const NODE_UNWRITABLE: [(&str, &str); 7] = [
        (".true", "\"true\" is not a name, so it cannot be written as a name"),
        (".false", "\"false\" is not a name, so it cannot be written as a name"),
        (".null", "\"null\" is not a name, so it cannot be written as a name"),
        (".true.x", "\"true\" is not a name, so it cannot be written as a name"),
        ("a.``", "\"\" cannot be written as a member name"),
        ("a.``.b", "\"\" cannot be written as a member name"),
        ("a.?``", "\"\" cannot be written as a member name"),
    ];
    for (source, message) in NODE_UNWRITABLE {
        let refused = serialize_tree(&tree(source)).expect_err(source);
        assert_eq!(refused.message, message, "{source}");
    }
}

#[test]
fn names_the_whole_character_where_node_names_half_of_it() {
    // This crate's own message. The tree, the code and the range — which covers the
    // backslash and the first code unit of the character — are Node's.
    const OWN_MESSAGE: &str = "\\\u{1f600} is not an escape sequence";
    let node_rows = [
        ("\"\\\u{1f600}\"", unparsed(0, 0), CelSyntaxCode::InvalidEscapeSequence, 1, 3), // Node: "\\\ud83d is not an escape sequence"
        ("'a\\\u{1f600}b'", unparsed(0, 0), CelSyntaxCode::InvalidEscapeSequence, 2, 4), // Node: "\\\ud83d is not an escape sequence"
        ("b'\\\u{1f600}'", unparsed(0, 0), CelSyntaxCode::InvalidEscapeSequence, 2, 4), // Node: "\\\ud83d is not an escape sequence"
    ];
    for (source, root, code, start, end) in node_rows {
        let parsed = read(source);
        assert_eq!(parsed.diagnostic, Some(diagnostic(code, OWN_MESSAGE, start, end)), "{source}");
        assert_eq!(parsed.root, root, "{source}");
    }
}
