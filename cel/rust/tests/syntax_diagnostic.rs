//! Every diagnostic the reader writes: one row or more per code and per message
//! template, each with its code, its message, its range and the tree left behind.
//!
//! No Node test file is the twin of this one. Node's own tests assert a handful of
//! codes and two messages, and the rule that both engines write the same text would
//! otherwise rest on nothing.
//!
//! Every row is the Node build's answer, executed: `@telorun/cel` 0.112.0,
//! this branch's build.

mod support;

use support::*;
use telorun_cel::CelSyntaxCode;

const NODE_CODES: [(CelSyntaxCode, &str); 16] = [
    (CelSyntaxCode::UnexpectedCharacter, "unexpected_character"),
    (CelSyntaxCode::UnexpectedToken, "unexpected_token"),
    (CelSyntaxCode::UnexpectedEnd, "unexpected_end"),
    (CelSyntaxCode::UnterminatedString, "unterminated_string"),
    (CelSyntaxCode::ReservedIdentifier, "reserved_identifier"),
    (CelSyntaxCode::InvalidNumber, "invalid_number"),
    (CelSyntaxCode::InvalidInteger, "invalid_integer"),
    (CelSyntaxCode::InvalidUnsignedInteger, "invalid_unsigned_integer"),
    (CelSyntaxCode::InvalidEscapeSequence, "invalid_escape_sequence"),
    (CelSyntaxCode::InvalidUnicodeEscape, "invalid_unicode_escape"),
    (CelSyntaxCode::InvalidUnicodeSurrogate, "invalid_unicode_surrogate"),
    (CelSyntaxCode::InvalidHexEscape, "invalid_hex_escape"),
    (CelSyntaxCode::InvalidOctalEscape, "invalid_octal_escape"),
    (CelSyntaxCode::OctalEscapeOutOfRange, "octal_escape_out_of_range"),
    (CelSyntaxCode::BytesUnicodeEscape, "bytes_unicode_escape"),
    (CelSyntaxCode::LimitExceeded, "limit_exceeded"),
];

/// The codes a table refuses with, each once, in the order they first appear.
fn codes_of(rows: &[NodeReading]) -> Vec<CelSyntaxCode> {
    let mut codes = Vec::new();
    for row in rows {
        let code = row.diagnostic.as_ref().unwrap_or_else(|| panic!("{:?} is a refusal row", row.source)).code;
        if !codes.contains(&code) {
            codes.push(code);
        }
    }
    codes
}

#[test]
fn writes_each_code_as_every_engine_does() {
    for (code, written) in NODE_CODES {
        assert_eq!(code.as_str(), written);
        assert_eq!(code.to_string(), written);
    }
}

#[test]
fn words_every_refusal_of_the_lexer_as_node_does() {
    use CelSyntaxCode::*;
    let rows = vec![
        reading("#", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"#\"", 0, 1))),
        reading("a ~ b", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"~\"", 2, 3))),
        reading("a \u{1}", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\\u0001\"", 2, 3))),
        reading("\u{e9}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\u{e9}\"", 0, 1))),
        reading("a = b", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"=\"", 2, 3))),
        reading("a & b", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"&\"", 2, 3))),
        reading("a | b", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"|\"", 2, 3))),
        reading("\u{2028}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedCharacter, "unexpected character \"\u{2028}\"", 0, 1))),
        reading("a.`b", defaults(), select(ident("a", false, 0, 1), "", (2, 2), false, false, 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "a quoted member name ends at its closing backtick", 2, 4))),
        reading("a.`b\nc`", defaults(), select(ident("a", false, 0, 1), "", (2, 2), false, false, 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "a quoted member name ends at its closing backtick", 2, 6))),
        reading("a.`\u{e9}\u{1f600}", defaults(), select(ident("a", false, 0, 1), "", (2, 2), false, false, 0, 2), Some(diagnostic(CelSyntaxCode::UnterminatedString, "a quoted member name ends at its closing backtick", 2, 6))),
        reading("'abc", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 0, 4))),
        reading("x + \"abc", defaults(), binary("+", ident("x", false, 0, 1), unparsed(4, 4), 0, 4), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 4, 8))),
        reading("'''abc''", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 0, 8))),
        reading("r'abc", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 5))),
        reading("b\"\u{e9}\u{1f600}", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 1, 5))),
        reading("'a\nb'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnterminatedString, "unterminated string", 0, 2))),
        reading("1x", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "1x is not a number", 0, 2))),
        reading("0x", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "0x is not a number", 0, 2))),
        reading("0xg", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "0xg is not a number", 0, 3))),
        reading("1.5u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "1.5u is not a number", 0, 4))),
        reading("1e5u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "1e5u is not a number", 0, 4))),
        reading("12abc_9 + 1", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "12abc_9 is not a number", 0, 7))),
        reading("1u2", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, "1u2 is not a number", 0, 3))),
        reading(".5x", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidNumber, ".5x is not a number", 0, 3))),
        reading("9223372036854775809", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775809 is outside the range of a 64-bit integer", 0, 19))),
        reading("0x8000000000000001", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidInteger, "0x8000000000000001 is outside the range of a 64-bit integer", 0, 18))),
        reading("123456789012345678901234567890", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidInteger, "123456789012345678901234567890 is outside the range of a 64-bit integer", 0, 30))),
        reading("-9223372036854775809", defaults(), unary("-", unparsed(1, 1), 0, 1), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775809 is outside the range of a 64-bit integer", 1, 20))),
        reading("18446744073709551616u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnsignedInteger, "18446744073709551616u is outside the range of an unsigned 64-bit integer", 0, 21))),
        reading("0x10000000000000000u", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnsignedInteger, "0x10000000000000000u is outside the range of an unsigned 64-bit integer", 0, 20))),
        reading("00000000000000000000000000000018446744073709551616U", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnsignedInteger, "00000000000000000000000000000018446744073709551616U is outside the range of an unsigned 64-bit integer", 0, 51))),
        reading("\"\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "the escape has no character", 1, 2))),
        reading("\"abc\\", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "the escape has no character", 4, 5))),
        reading("\"\\q\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\q is not an escape sequence", 1, 3))),
        reading("'\\\u{e9}'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\\u{e9} is not an escape sequence", 1, 3))),
        reading("\"\\8\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\8 is not an escape sequence", 1, 3))),
        reading("\"\\\n\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidEscapeSequence, "\\\n is not an escape sequence", 1, 3))),
        reading("b'\\u0041'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::BytesUnicodeEscape, "\\u names text, which a bytes literal cannot hold \u{2014} write the bytes with \\x", 2, 4))),
        reading("b'\\U00000041'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::BytesUnicodeEscape, "\\U names text, which a bytes literal cannot hold \u{2014} write the bytes with \\x", 2, 4))),
        reading("\"\\x4\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 4))),
        reading("\"\\xZZ\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 3))),
        reading("\"\\X\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 1, 3))),
        reading("b'\\x'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidHexEscape, "a \\x escape takes two hexadecimal digits", 2, 4))),
        reading("\"\\77\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 1, 4))),
        reading("\"\\08\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 1, 3))),
        reading("b'\\1'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidOctalEscape, "an octal escape takes three octal digits", 2, 4))),
        reading("\"\\400\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::OctalEscapeOutOfRange, "\\400 is above 255", 1, 5))),
        reading("b'\\777'", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::OctalEscapeOutOfRange, "\\777 is above 255", 2, 6))),
        reading("\"\\u12\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\u escape takes 4 hexadecimal digits", 1, 5))),
        reading("\"\\u12\u{e9}4\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\u escape takes 4 hexadecimal digits", 1, 5))),
        reading("\"\\U0001\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\U escape takes 8 hexadecimal digits", 1, 7))),
        reading("\"\\U0001f43\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "a \\U escape takes 8 hexadecimal digits", 1, 10))),
        reading("\"\\U00110000\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "U+00110000 is not a code point", 1, 11))),
        reading("\"\\UFFFFFFFF\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeEscape, "U+FFFFFFFF is not a code point", 1, 11))),
        reading("\"\\udc00\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "U+dc00 is a trailing surrogate", 1, 7))),
        reading("\"\\U0000DFFF\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "U+0000DFFF is a trailing surrogate", 1, 11))),
        reading("\"\\ud83d\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "a leading surrogate must be followed by a trailing surrogate escape", 1, 7))),
        reading("\"\\ud83d\\u0041\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "a leading surrogate must be followed by a trailing surrogate escape", 1, 7))),
        reading("\"\\ud83d\\Udc31\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "a leading surrogate must be followed by a trailing surrogate escape", 1, 7))),
        reading("\"\\U0000d83d\\udc3\"", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::InvalidUnicodeSurrogate, "a leading surrogate must be followed by a trailing surrogate escape", 1, 11))),
    ];
    assert_eq!(
        codes_of(&rows),
        [
            UnexpectedCharacter,
            UnterminatedString,
            InvalidNumber,
            InvalidInteger,
            InvalidUnsignedInteger,
            InvalidEscapeSequence,
            BytesUnicodeEscape,
            InvalidHexEscape,
            InvalidOctalEscape,
            OctalEscapeOutOfRange,
            InvalidUnicodeEscape,
            InvalidUnicodeSurrogate,
        ]
    );
    assert_reads_as_node(rows);
}

#[test]
fn reads_the_literals_beside_each_refusal() {
    let rows = vec![
        reading("000000000000000000000000000009223372036854775807", defaults(), literal_int(9223372036854775807, 0, 48), None),
        reading("0x00000000000000000000007fffffffffffffff", defaults(), literal_int(9223372036854775807, 0, 40), None),
        reading("0x0000000000000000000000ffffffffffffffffu", defaults(), literal_uint(18446744073709551615, 0, 41), None),
        reading("-0x8000000000000000", defaults(), literal_int(i64::MIN, 0, 19), None),
        reading("- 9223372036854775808", defaults(), literal_int(i64::MIN, 0, 21), None),
        reading("\"\\U0000d83d\\udc31\"", defaults(), literal_string("\u{1f431}", 0, 18), None),
        reading("'\\xff\\377'", defaults(), literal_string("\u{ff}\u{ff}", 0, 10), None),
    ];
    assert!(rows.iter().all(|row| row.diagnostic.is_none()));
    assert_reads_as_node(rows);
}

#[test]
fn words_an_unfinished_expression_with_and_without_what_it_expected() {
    let rows = vec![
        reading("", defaults(), unparsed(0, 0), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 0, 0))),
        reading("1 +", defaults(), binary("+", literal_int(1, 0, 1), unparsed(3, 3), 0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 3, 3))),
        reading("(1", defaults(), literal_int(1, 1, 2), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \")\"", 2, 2))),
        reading("[1", defaults(), list(vec![element(literal_int(1, 1, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"]\"", 2, 2))),
        reading("[1,", defaults(), list(vec![element(literal_int(1, 1, 2), false), element(unparsed(3, 3), false)], 0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 3, 3))),
        reading("{1", defaults(), map(vec![entry(literal_int(1, 1, 2), unparsed(2, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \":\"", 2, 2))),
        reading("{1: 2", defaults(), map(vec![entry(literal_int(1, 1, 2), literal_int(2, 4, 5), false)], 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"}\"", 5, 5))),
        reading("a.", defaults(), select(ident("a", false, 0, 1), "", (2, 2), false, false, 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"a name\"", 2, 2))),
        reading("a.?", defaults(), select(ident("a", false, 0, 1), "", (3, 3), true, false, 0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"a name\"", 3, 3))),
        reading("f(1", defaults(), call("f", (0, 1), vec![literal_int(1, 2, 3)], 0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \")\"", 3, 3))),
        reading("a.f(1,", defaults(), receiver_call(ident("a", false, 0, 1), "f", (2, 3), vec![literal_int(1, 4, 5), unparsed(6, 6)], 0, 6), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 6, 6))),
        reading("a[1", defaults(), index(ident("a", false, 0, 1), literal_int(1, 2, 3), false, 0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"]\"", 3, 3))),
        reading("a ? b", defaults(), conditional(ident("a", false, 0, 1), ident("b", false, 4, 5), unparsed(5, 5), 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \":\"", 5, 5))),
        reading("a ? b :", defaults(), conditional(ident("a", false, 0, 1), ident("b", false, 4, 5), unparsed(7, 7), 0, 7), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 7, 7))),
        reading(".", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"a name\"", 1, 1))),
        reading("!", defaults(), unary("!", unparsed(1, 1), 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 1, 1))),
        reading("-", defaults(), unary("-", unparsed(1, 1), 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 1, 1))),
    ];
    assert_eq!(codes_of(&rows), [CelSyntaxCode::UnexpectedEnd]);
    assert_reads_as_node(rows);
}

#[test]
fn words_a_misplaced_token_with_and_without_what_it_expected() {
    let rows = vec![
        reading("1 2", defaults(), literal_int(1, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here", 2, 3))),
        reading(")", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\")\" cannot stand here", 0, 1))),
        reading("a b", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"b\" cannot stand here", 2, 3))),
        reading("* 2", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"*\" cannot stand here", 0, 1))),
        reading("(1 2", defaults(), literal_int(1, 1, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here, expected \")\"", 3, 4))),
        reading("[1 2", defaults(), list(vec![element(literal_int(1, 1, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here, expected \"]\"", 3, 4))),
        reading("{1 2", defaults(), map(vec![entry(literal_int(1, 1, 2), unparsed(2, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here, expected \":\"", 3, 4))),
        reading("{1: 2 3", defaults(), map(vec![entry(literal_int(1, 1, 2), literal_int(2, 4, 5), false)], 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"3\" cannot stand here, expected \"}\"", 6, 7))),
        reading("a.1", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\".1\" cannot stand here", 1, 3))),
        reading("a.(", defaults(), select(ident("a", false, 0, 1), "", (2, 2), false, false, 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here, expected \"a name\"", 2, 3))),
        reading("a.'b'", defaults(), select(ident("a", false, 0, 1), "", (2, 2), false, false, 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"'b'\" cannot stand here, expected \"a name\"", 2, 5))),
        reading("`a`", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a`\" cannot stand here, expected \"a member read, as in a.`b`\"", 0, 3))),
        reading("1 + `a b`", defaults(), binary("+", literal_int(1, 0, 1), unparsed(4, 9), 0, 9), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a b`\" cannot stand here, expected \"a member read, as in a.`b`\"", 4, 9))),
        reading("a.`b`(1)", defaults(), select(ident("a", false, 0, 1), "b", (2, 5), false, true, 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here, expected \"a member read \u{2014} a quoted name is a field, not a call\"", 5, 6))),
        reading("f(1 2", defaults(), call("f", (0, 1), vec![literal_int(1, 2, 3)], 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here, expected \")\"", 4, 5))),
        reading("a.f(1 2", defaults(), receiver_call(ident("a", false, 0, 1), "f", (2, 3), vec![literal_int(1, 4, 5)], 0, 7), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here, expected \")\"", 6, 7))),
        reading("a[1 2", defaults(), index(ident("a", false, 0, 1), literal_int(1, 2, 3), false, 0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"2\" cannot stand here, expected \"]\"", 4, 5))),
        reading("a ? b c", defaults(), conditional(ident("a", false, 0, 1), ident("b", false, 4, 5), unparsed(5, 5), 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"c\" cannot stand here, expected \":\"", 6, 7))),
        reading(".(", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here, expected \"a name\"", 1, 2))),
        reading(".`a`", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a`\" cannot stand here, expected \"a name\"", 1, 4))),
        reading(".1.2", defaults(), literal_double(0x3fb999999999999a, 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\".2\" cannot stand here", 2, 4))),
        reading("a '\u{e9}\u{1f600}'", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"'\u{e9}\u{1f600}'\" cannot stand here", 2, 7))),
    ];
    assert_eq!(codes_of(&rows), [CelSyntaxCode::UnexpectedToken]);
    assert_reads_as_node(rows);
}

#[test]
fn words_a_reserved_word_read_as_a_name() {
    let rows = vec![
        reading("if", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"if\" is a reserved word and cannot be used as a name", 0, 2))),
        reading("a + while", defaults(), binary("+", ident("a", false, 0, 1), unparsed(4, 9), 0, 9), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"while\" is a reserved word and cannot be used as a name", 4, 9))),
        reading(".if", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"if\" is a reserved word and cannot be used as a name", 1, 3))),
        reading("f(let)", defaults(), call("f", (0, 1), vec![unparsed(2, 5)], 0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"let\" is a reserved word and cannot be used as a name", 2, 5))),
        reading("var.x", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"var\" is a reserved word and cannot be used as a name", 0, 3))),
    ];
    assert_eq!(codes_of(&rows), [CelSyntaxCode::ReservedIdentifier]);
    assert_reads_as_node(rows);
}

#[test]
fn words_the_parsers_refusal_of_a_bare_two_to_the_sixty_third() {
    let rows = vec![
        reading("9223372036854775808", defaults(), unparsed(0, 19), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775808 is outside the range of a 64-bit integer", 0, 19))),
        reading("0x8000000000000000", defaults(), unparsed(0, 18), Some(diagnostic(CelSyntaxCode::InvalidInteger, "0x8000000000000000 is outside the range of a 64-bit integer", 0, 18))),
        reading("-(9223372036854775808)", defaults(), unary("-", unparsed(2, 21), 0, 21), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775808 is outside the range of a 64-bit integer", 2, 21))),
        reading("1 - 9223372036854775808", defaults(), binary("-", literal_int(1, 0, 1), unparsed(4, 23), 0, 23), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775808 is outside the range of a 64-bit integer", 4, 23))),
        reading("!9223372036854775808", defaults(), unary("!", unparsed(1, 20), 0, 20), Some(diagnostic(CelSyntaxCode::InvalidInteger, "9223372036854775808 is outside the range of a 64-bit integer", 1, 20))),
    ];
    assert_eq!(codes_of(&rows), [CelSyntaxCode::InvalidInteger]);
    assert_reads_as_node(rows);
}

#[test]
fn words_each_of_the_five_limits_and_reads_a_source_at_each() {
    // Each limit lowered so the source is short: one row at the limit, then one past it.
    let rows = vec![
        reading("1 + 2", limits(3, 250, 1000, 1000, 32), binary("+", literal_int(1, 0, 1), literal_int(2, 4, 5), 0, 5), None),
        reading("1 + 2 + 3", limits(3, 250, 1000, 1000, 32), binary("+", binary("+", literal_int(1, 0, 1), literal_int(2, 4, 5), 0, 5), literal_int(3, 8, 9), 0, 9), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 3", 8, 9))),
        reading("[a.b, c]", limits(2, 250, 1000, 1000, 32), list(vec![element(select(ident("a", false, 1, 2), "b", (3, 4), false, false, 1, 4), false), element(ident("c", false, 6, 7), false)], 0, 7), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 2", 6, 7))),
        reading("(1)", limits(100000, 2, 1000, 1000, 32), literal_int(1, 1, 2), None),
        reading("((1))", limits(100000, 2, 1000, 1000, 32), unparsed(2, 2), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 2", 2, 2))),
        reading("a + (b ? !c : d)", limits(100000, 2, 1000, 1000, 32), binary("+", ident("a", false, 0, 1), conditional(ident("b", false, 5, 6), unparsed(9, 9), unparsed(9, 9), 5, 9), 0, 9), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 2", 9, 9))),
        reading("!!a", limits(100000, 2, 1000, 1000, 32), unary("!", unparsed(1, 1), 0, 1), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 2", 1, 1))),
        reading("[1, 2]", limits(100000, 250, 2, 1000, 32), list(vec![element(literal_int(1, 1, 2), false), element(literal_int(2, 4, 5), false)], 0, 6), None),
        reading("[1, 2, 3, 4]", limits(100000, 250, 2, 1000, 32), list(vec![element(literal_int(1, 1, 2), false), element(literal_int(2, 4, 5), false), element(literal_int(3, 7, 8), false)], 0, 8), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more list elements than the limit of 2", 0, 8))),
        reading("{1: 1}", limits(100000, 250, 1000, 1, 32), map(vec![entry(literal_int(1, 1, 2), literal_int(1, 4, 5), false)], 0, 6), None),
        reading("{1: 1, 2: 2, 3: 3}", limits(100000, 250, 1000, 1, 32), map(vec![entry(literal_int(1, 1, 2), literal_int(1, 4, 5), false), entry(literal_int(2, 7, 8), literal_int(2, 10, 11), false)], 0, 11), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more map entries than the limit of 1", 0, 11))),
        reading("f(1)", limits(100000, 250, 1000, 1000, 1), call("f", (0, 1), vec![literal_int(1, 2, 3)], 0, 4), None),
        reading("a.f(1, 2, 3)", limits(100000, 250, 1000, 1000, 1), receiver_call(ident("a", false, 0, 1), "f", (2, 3), vec![literal_int(1, 4, 5), literal_int(2, 7, 8)], 0, 8), Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more call arguments than the limit of 1", 3, 8))),
        reading("f()", limits(100000, 250, 1000, 1000, 0), call("f", (0, 1), vec![], 0, 3), None),
    ];
    let messages: Vec<&str> =
        rows.iter().filter_map(|row| row.diagnostic.as_ref()).map(|diagnostic| diagnostic.message.as_str()).collect();
    for what in ["nodes", "nesting", "list elements", "map entries", "call arguments"] {
        let wording = format!("the expression has more {what} than the limit of ");
        assert!(messages.iter().any(|message| message.starts_with(&wording)), "{what}");
    }
    assert!(rows.iter().any(|row| row.diagnostic.is_none()));
    assert_reads_as_node(rows);
}
