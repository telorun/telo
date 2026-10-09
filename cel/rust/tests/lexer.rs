//! The literal grammar — the twin of `cel/nodejs/tests/lexer.test.ts`, case for case,
//! through `parse_syntax` as the Node file goes through `parseSyntax`.
//!
//! Every row is the Node build's answer, executed: `@telorun/cel` 0.112.0,
//! this branch's build. The Node cases assert a literal or
//! a code and a range; each row here holds the whole of what Node answered for that
//! source — the tree with every range, and the diagnostic with its message.

mod support;

use support::*;
use telorun_cel::CelSyntaxCode;

#[test]
fn reads_every_numeric_form_with_its_own_type() {
    assert_reads_as_node(vec![
        reading("0", defaults(), literal_int(0, 0, 1), None),
        reading("9223372036854775807", defaults(), literal_int(9223372036854775807, 0, 19), None),
        reading("-9223372036854775808", defaults(), literal_int(i64::MIN, 0, 20), None),
        reading("0xFF", defaults(), literal_int(255, 0, 4), None),
        reading("42u", defaults(), literal_uint(42, 0, 3), None),
        reading("0xFFU", defaults(), literal_uint(255, 0, 5), None),
        reading("18446744073709551615u", defaults(), literal_uint(18446744073709551615, 0, 21), None),
        reading("1.0", defaults(), literal_double(0x3ff0000000000000, 0, 3), None),
        reading("1e3", defaults(), literal_double(0x408f400000000000, 0, 3), None),
        reading("1.5e-3", defaults(), literal_double(0x3f589374bc6a7efa, 0, 6), None),
        reading(".99", defaults(), literal_double(0x3fefae147ae147ae, 0, 3), None),
        reading("-0.0", defaults(), literal_double(0x8000000000000000, 0, 4), None),
    ]);
}

#[test]
fn refuses_a_number_outside_its_types_range() {
    assert_reads_as_node(vec![
        reading("9223372036854775808", defaults(), unparsed(0, 19), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775808 is outside the range of a 64-bit integer", 0, 19))),
        reading("18446744073709551616u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnsignedInteger, "18446744073709551616u is outside the range of an unsigned 64-bit integer", 0, 21))),
    ]);
}

#[test]
fn reads_every_quoting_every_prefix_and_every_escape_form() {
    assert_reads_as_node(vec![
        reading("''", defaults(), literal_string("", 0, 2), None),
        reading("\"a\"", defaults(), literal_string("a", 0, 3), None),
        reading("'''a\nb'''", defaults(), literal_string("a\nb", 0, 9), None),
        reading("\"\"\"a\"b\"\"\"", defaults(), literal_string("a\"b", 0, 9), None),
        reading("r\"\\n\"", defaults(), literal_string("\\n", 0, 5), None),
        reading("R'a\\'b'", defaults(), literal_string("a\\'b", 0, 7), None),
        reading("r''''''", defaults(), literal_string("", 0, 7), None),
        reading("\"\\\\ \\? \\\" \\' \\` \\a \\b \\f \\n \\r \\t \\v\"", defaults(), literal_string("\\ ? \" ' ` \u{7} \u{8} \u{c} \n \r \t \u{b}", 0, 37), None),
        reading("\"\\x41 \\X41 \\101\"", defaults(), literal_string("A A A", 0, 16), None),
        reading("\"\\u270c \\U0001f431 \\ud83d\\udc31\"", defaults(), literal_string("\u{270c} \u{1f431} \u{1f431}", 0, 32), None),
        reading("true", defaults(), literal_bool(true, 0, 4), None),
        reading("false", defaults(), literal_bool(false, 0, 5), None),
        reading("null", defaults(), literal_null(0, 4), None),
    ]);
}

#[test]
fn reads_a_bytes_literal_as_the_utf8_of_its_text_an_escape_as_the_byte_it_names() {
    assert_reads_as_node(vec![
        reading("b\"\"", defaults(), literal_bytes(&[], 0, 3), None),
        reading("b'\\000\\xff'", defaults(), literal_bytes(&[0, 255], 0, 11), None),
        reading("b'\u{ff}'", defaults(), literal_bytes(&[195, 191], 0, 4), None),
        reading("b'\u{1f431}'", defaults(), literal_bytes(&[240, 159, 144, 177], 0, 5), None),
        reading("B'ab'", defaults(), literal_bytes(&[97, 98], 0, 5), None),
        reading("br'\\n'", defaults(), literal_bytes(&[92, 110], 0, 6), None),
        reading("bR\"\\n\"", defaults(), literal_bytes(&[92, 110], 0, 6), None),
    ]);
}

#[test]
fn refuses_an_unreadable_literal_where_it_goes_wrong() {
    assert_reads_as_node(vec![
        reading("'abc", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 0, 4))),
        reading("'a\nb'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 0, 2))),
        reading("\"\\q\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\q is not an escape sequence", 1, 3))),
        reading("\"\\x4\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 4))),
        reading("\"\\77\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 1, 4))),
        reading("\"\\400\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::OctalEscapeOutOfRange, "\\400 is above 255", 1, 5))),
        reading("\"\\ud83d\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "a leading surrogate must be followed by a trailing surrogate escape", 1, 7))),
        reading("\"\\U00110000\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "U+00110000 is not a code point", 1, 11))),
        reading("b'\\u0041'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::BytesUnicodeEscape, "\\u names text, which a bytes literal cannot hold \u{2014} write the bytes with \\x", 2, 4))),
        reading("`a`", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a`\" cannot stand here, expected \"a member read, as in a.`b`\"", 0, 3))),
        reading("rb'x'", defaults(), ident("rb", false, 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"'x'\" cannot stand here", 2, 5))),
        reading("`a", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "a quoted member name ends at its closing backtick", 0, 2))),
    ]);
}

#[test]
fn ranges_an_escape_as_it_is_written_not_by_the_width_it_should_have_had() {
    let rows = vec![
        reading("\"\\x", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 3))),
        reading("\"\\0", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 1, 3))),
        reading("\"\\u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\u escape takes 4 hexadecimal digits", 1, 3))),
        reading("\"\\U", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\U escape takes 8 hexadecimal digits", 1, 3))),
        reading("'abc\\x4", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 4, 7))),
        reading("b'\\7", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 2, 4))),
        reading("'\\x4'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 4))),
        reading("'\\xZZ'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 3))),
        reading("'\\x4\u{1f600}'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 4))),
        reading("'\\u12G4'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\u escape takes 4 hexadecimal digits", 1, 5))),
    ];
    for row in &rows {
        let end = row.diagnostic.as_ref().expect(row.source).range.end;
        assert!(end as usize <= row.source.encode_utf16().count(), "{}", row.source);
    }
    assert_reads_as_node(rows);
}

#[test]
fn reports_a_character_outside_the_basic_plane_whole() {
    assert_reads_as_node(vec![
        reading("\u{1f600}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\u{1f600}\"", 0, 2))),
        reading("a + \u{1f600}", defaults(), binary("+", ident("a", false, 0, 1), unparsed(4, 4), 0, 4), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\u{1f600}\"", 4, 6))),
        reading("\u{1f600}\u{1f600}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\u{1f600}\"", 0, 2))),
    ]);
}

#[test]
fn names_and_ranges_the_whole_character_an_escape_stands_before() {
    assert_reads_as_node(vec![
        reading("\"\\\u{1f600}\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\\u{1f600} is not an escape sequence", 1, 4))),
        reading("'a\\\u{1f600}b'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\\u{1f600} is not an escape sequence", 2, 5))),
        reading("b'\\\u{1f600}'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\\u{1f600} is not an escape sequence", 2, 5))),
    ]);
}

#[test]
fn ends_a_single_line_raw_literal_at_a_line_feed_a_backslash_before_it_or_not() {
    assert_reads_as_node(vec![
        reading("r'a\\\nb'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 4))),
        reading("br'a\\\nb'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 2, 5))),
        reading("r'abc\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 6))),
        reading("r'abc\\\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 7))),
        reading("r'\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 3))),
    ]);
    // Any other character still goes with the backslash, and a triple-quoted one takes the line feed.
    let read = vec![
        reading("r'\\''", defaults(), literal_string("\\'", 0, 5), None),
        reading("r'''a\\'''b'''", defaults(), literal_string("a\\'''b", 0, 13), None),
        reading("r'''a\\\nb'''", defaults(), literal_string("a\\\nb", 0, 11), None),
    ];
    assert!(read.iter().all(|row| row.diagnostic.is_none()));
    assert_reads_as_node(read);
}
