//! The tree written back as source — the twin of `cel/nodejs/tests/serializer.test.ts`,
//! case for case.
//!
//! Every row and every literal is the Node build's answer, executed: `@telorun/cel`
//! 0.112.0, this branch's build. Where a Node case asserts only that a tree reads back equal,
//! the row here also holds the text Node wrote for it.
//!
//! One assertion of the Node file has no twin: the refusal of a hand-built int literal
//! of 2^63. A literal here holds an `i64`, so no tree can hold that value. The NaN
//! refusal of the same case is here.
//!
//! Past the twin, each beyond what the Node file asserts: the message of every
//! refusal; the text of every literal form; every name, member and field spelling;
//! where parentheses are placed; more sources read, written and re-read; and which
//! fault is reported for a tree with several.
//!
//! Every source here that reads clean round-trips under the options it was read with.

mod support;

use support::*;
use telorun_cel::{
    parse_expression, parse_syntax, serialize_tree, trees_equal, CelSyntaxCode, CelSyntaxDiagnostic, ParseOptions,
};

/// `(source, the text Node writes for its tree)`. Node re-reads each text with no
/// diagnostic, to an equal tree.
type RoundTrip = (&'static str, &'static str);

fn assert_round_trips_as_node(options: &ParseOptions, rows: &[RoundTrip]) {
    assert!(!rows.is_empty(), "the table holds no row");
    for (source, written) in rows {
        let parsed = parse_syntax(source, options);
        assert_eq!(parsed.diagnostic, None, "{source}");
        assert_eq!(serialize_tree(&parsed.root).as_deref(), Ok(*written), "{source}");
        let reread = parse_syntax(written, options);
        assert_eq!(reread.diagnostic, None, "{written}");
        assert!(trees_equal(&parsed.root, &reread.root), "{source} → {written}");
    }
}

#[test]
fn writes_each_expression_back_to_an_equal_tree() {
    assert_round_trips_as_node(
        &defaults(),
        &[
            ("0", "0"),
            ("-9223372036854775808", "-9223372036854775808"),
            ("9223372036854775807", "9223372036854775807"),
            ("18446744073709551615u", "18446744073709551615u"),
            ("1.0", "1.0"),
            ("-0.0", "-0.0"),
            ("1e-7", "1e-7"),
            ("1e999", "1e999"),
            ("''", "\"\""),
            ("'a\\nb'", "\"a\\nb\""),
            ("\"\\x00\\u270c\"", "\"\\x00\u{270c}\""),
            ("b'\\000\\xff'", "b\"\\x00\\xff\""),
            ("true", "true"),
            ("null", "null"),
            ("[]", "[]"),
            ("[1, 'a', [2]]", "[1, \"a\", [2]]"),
            ("{}", "{}"),
            ("{'a': 1, 2: b}", "{\"a\": 1, 2: b}"),
            ("a.b.c", "a.b.c"),
            ("a.?b", "a.?b"),
            ("a[0]", "a[0]"),
            ("a[?'k']", "a[?\"k\"]"),
            ("size(a)", "size(a)"),
            ("a.startsWith('x')", "a.startsWith(\"x\")"),
            ("xs.map(i, i + 1)", "xs.map(i, i + 1)"),
            ("has(a.b)", "has(a.b)"),
            ("cel.bind(x, 1, x + 1)", "cel.bind(x, 1, x + 1)"),
            ("optional.of(1)", "optional.of(1)"),
            ("!a", "!a"),
            ("-a", "-a"),
            ("-(1)", "-(1)"),
            ("a + b * (c - d)", "a + b * (c - d)"),
            ("a - (b - c)", "a - (b - c)"),
            ("(a || b) && c", "(a || b) && c"),
            ("a in [1, 2]", "a in [1, 2]"),
            ("a == b ? c : d", "a == b ? c : d"),
            ("(a ? b : c) ? d : e", "(a ? b : c) ? d : e"),
            ("a > 1 && b <= 2 || !c", "a > 1 && b <= 2 || !c"),
            (".99", "0.99"),
            ("br'\\n'", "b\"\\\\n\""),
            ("headers.`content-type`", "headers.`content-type`"),
            ("m.`foo.txt`.`a-b`", "m.`foo.txt`.`a-b`"),
            ("m.?`a-b`", "m.?`a-b`"),
            (".y", ".y"),
            (".y.z", ".y.z"),
            ("[1].map(y, .y)", "[1].map(y, .y)"),
        ],
    );
}

#[test]
fn writes_each_optional_entry_back_to_an_equal_tree() {
    assert_round_trips_as_node(
        &optional_syntax(),
        &[
            ("[?a]", "[?a]"),
            ("[?a, b]", "[?a, b]"),
            ("{?'k': v}", "{?\"k\": v}"),
            ("{?'k': v, 'j': w}", "{?\"k\": v, \"j\": w}"),
        ],
    );
}

#[test]
fn quotes_a_member_name_that_has_no_other_spelling_and_refuses_one_with_none_at_all() {
    // Written without backticks, it is still quoted: that is the name's only spelling.
    assert_writes_as_node(vec![
        (select(ident("m", false, 0, 0), "content-type", (0, 0), false, false, 0, 0), Ok("m.`content-type`")),
        (select(ident("m", false, 0, 0), "a`b", (0, 0), false, false, 0, 0), Err("\"a`b\" cannot be written as a member name")),
    ]);
}

#[test]
fn writes_a_qualified_call_back_as_the_text_it_was_read_from() {
    const NODE_WRITTEN: [(&str, &[&str], &str); 1] = [
        ("Billing.total(x, 1)", &["Billing"], "Billing.total(x, 1)"),
    ];
    for (source, namespaces, written) in NODE_WRITTEN {
        let expression = parse_expression(source, &expression_options(namespaces, false)).expect(source);
        assert_eq!(serialize_tree(&expression.root).as_deref(), Ok(written), "{source}");
    }
}

#[test]
fn refuses_a_tree_that_has_no_source() {
    /// `(a source left incomplete, the message of the refusal to write its tree)`.
    const NODE_REFUSALS: [(&str, &str); 2] = [
        ("1 +", "an unparsed expression has no source to write"),
        ("a.", "\"\" cannot be written as a member name"),
    ];
    for (source, message) in NODE_REFUSALS {
        let refused = serialize_tree(&read(source).root).expect_err(source);
        assert_eq!(refused.message, message, "{source}");
        let as_error: &dyn std::error::Error = &refused;
        assert_eq!(as_error.to_string(), message, "{source}");
    }
    // A double that is not a number. An int outside its range cannot be built here.
    assert_writes_as_node(vec![
        (literal_double(0x7ff8000000000000, 0, 0), Err("a double that is not a number cannot be written as a literal")),
    ]);
}

#[test]
fn writes_a_hand_built_negation_of_a_literal_without_folding_it_away() {
    let node_negation = [
        (unary("-", literal_int(1, 0, 0), 0, 0), "-(1)", true),
    ];
    for (negated, written, equal) in node_negation {
        assert_eq!(serialize_tree(&negated).as_deref(), Ok(written));
        assert_eq!(trees_equal(&read(written).root, &negated), equal);
        assert!(equal);
    }
}

#[test]
fn parenthesizes_the_number_a_negated_chain_begins_with_which_would_read_back_folded() {
    // The minus reaches only what the operand's text begins with; a uint and a negative
    // number are never folded, so neither is parenthesized for it.
    assert_round_trips_as_node(
        &defaults(),
        &[
            ("-(1).a", "-(1).a"),
            ("-(1)[0]", "-(1)[0]"),
            ("-(1).f()", "-(1).f()"),
            ("-(1.5).a", "-(1.5).a"),
            ("-(0).a", "-(0).a"),
            ("-(0.0).a", "-(0.0).a"),
            ("-(1e999).a", "-(1e999).a"),
            ("-(1).a[0].f().b", "-(1).a[0].f().b"),
            ("-(-1).a", "-(-1).a"),
            ("-(-0.0).a", "-(-0.0).a"),
            ("-1u.a", "-1u.a"),
            ("-a[1].b(2)", "-a[1].b(2)"),
            ("-[1].a", "-[1].a"),
            ("-(1 + 2).a", "-(1 + 2).a"),
            ("-!1", "-!1"),
            ("!1.a", "!1.a"),
        ],
    );
}

#[test]
fn writes_an_optional_entry_wherever_the_tree_holds_one() {
    // The round trip holds under the options the tree was read with, and the writer
    // takes none. `(source, the text Node writes, whether it reads back equal with the
    // optional syntax on, Node's diagnostic for that text with it off)`.
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
        assert!(equal_when_on, "{written}");
        assert!(refusal_when_off.is_some(), "{written}");
        assert_eq!(read(written).diagnostic, refusal_when_off, "{written}");
    }
}

// --- past the twin -------------------------------------------------------------------

#[test]
fn writes_more_sources_back_to_an_equal_tree() {
    assert_round_trips_as_node(
        &defaults(),
        &[
            ("1e21", "1e+21"),
            ("123456789012345680000.0", "123456789012345680000.0"),
            ("1e-6", "0.000001"),
            ("0.000001234", "0.000001234"),
            ("5e-324", "5e-324"),
            ("1.7976931348623157e308", "1.7976931348623157e+308"),
            ("-1e999", "-1e999"),
            ("- 1", "-1"),
            ("--1", "--1"),
            ("-(-1)", "--1"),
            ("-(1.5)", "-(1.5)"),
            ("-1u", "-1u"),
            ("!-a", "!-a"),
            ("(-1).x", "(-1).x"),
            ("(-a).b", "(-a).b"),
            ("a.b(1)", "a.b(1)"),
            ("'\\x7f\\x1f\\\\\\\"\\'\\r\\t'", "\"\\x7f\\x1f\\\\\\\"'\\r\\t\""),
            ("'\u{e9}\u{1f600}'", "\"\u{e9}\u{1f600}\""),
            ("b'\\\\\\\"~ \\x7f\\x80'", "b\"\\\\\\\"~ \\x7f\\x80\""),
            ("b'\u{e9}'", "b\"\\xc3\\xa9\""),
            ("a ? b : c ? d : e", "a ? b : c ? d : e"),
            ("a ? (b ? c : d) : e", "a ? b ? c : d : e"),
            ("(a ? b : c) + 1", "(a ? b : c) + 1"),
            ("[a ? b : c, d]", "[a ? b : c, d]"),
            ("f(a ? b : c)", "f(a ? b : c)"),
            ("{a ? b : c: d ? e : f}", "{a ? b : c: d ? e : f}"),
            ("a[b ? c : d]", "a[b ? c : d]"),
            ("a == (b == c)", "a == (b == c)"),
            ("a == b == c", "a == b == c"),
            ("(a + b).c", "(a + b).c"),
            ("(a + b)[0]", "(a + b)[0]"),
            ("(a + b).f()", "(a + b).f()"),
            ("a.b[c].d(e)[f]", "a.b[c].d(e)[f]"),
            ("a.in + a.true.null", "a.in + a.true.null"),
            ("a.`in`", "a.`in`"),
            ("a.`x y`.z", "a.`x y`.z"),
            ("1 // c\n + 2", "1 + 2"),
        ],
    );
}

#[test]
fn writes_every_literal_form_as_node_does() {
    assert_writes_as_node(vec![
        (literal_int(0, 0, 0), Ok("0")),
        (literal_int(-1, 0, 0), Ok("-1")),
        (literal_int(9223372036854775807, 0, 0), Ok("9223372036854775807")),
        (literal_int(i64::MIN, 0, 0), Ok("-9223372036854775808")),
        (literal_uint(0, 0, 0), Ok("0u")),
        (literal_uint(18446744073709551615, 0, 0), Ok("18446744073709551615u")),
        (literal_double(0x3ff0000000000000, 0, 0), Ok("1.0")),
        (literal_double(0x0000000000000000, 0, 0), Ok("0.0")),
        (literal_double(0x8000000000000000, 0, 0), Ok("-0.0")),
        (literal_double(0x3fb999999999999a, 0, 0), Ok("0.1")),
        (literal_double(0xc004000000000000, 0, 0), Ok("-2.5")),
        (literal_double(0x4059000000000000, 0, 0), Ok("100.0")),
        (literal_double(0x444b1ae4d6e2ef50, 0, 0), Ok("1e+21")),
        (literal_double(0x441ac53a7e04bcda, 0, 0), Ok("123456789012345680000.0")),
        (literal_double(0x3e7ad7f29abcaf48, 0, 0), Ok("1e-7")),
        (literal_double(0x3eb0c6f7a0b5ed8d, 0, 0), Ok("0.000001")),
        (literal_double(0x0000000000000001, 0, 0), Ok("5e-324")),
        (literal_double(0x7fefffffffffffff, 0, 0), Ok("1.7976931348623157e+308")),
        (literal_double(0x7e37e43c8800759c, 0, 0), Ok("1e+300")),
        (literal_double(0x81a56e1fc2f8f359, 0, 0), Ok("-1e-300")),
        (literal_double(0x7ff0000000000000, 0, 0), Ok("1e999")),
        (literal_double(0xfff0000000000000, 0, 0), Ok("-1e999")),
        (literal_double(0x7ff8000000000000, 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (literal_double(0xfff8000000000000, 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (literal_string("", 0, 0), Ok("\"\"")),
        (literal_string("a\"b\\c'd`", 0, 0), Ok("\"a\\\"b\\\\c'd`\"")),
        (literal_string("\n\r\t", 0, 0), Ok("\"\\n\\r\\t\"")),
        (literal_string("\u{0}\u{1}\u{8}\u{b}\u{c}\u{1f}\u{7f}", 0, 0), Ok("\"\\x00\\x01\\x08\\x0b\\x0c\\x1f\\x7f\"")),
        (literal_string("\u{80}\u{e9}\u{1f600}\u{2028}\u{feff}", 0, 0), Ok("\"\u{80}\u{e9}\u{1f600}\u{2028}\u{feff}\"")),
        (literal_bytes(&[], 0, 0), Ok("b\"\"")),
        (literal_bytes(&[0, 9, 10, 13, 31, 32, 34, 39, 92, 96, 126, 127, 128, 255], 0, 0), Ok("b\"\\x00\\x09\\x0a\\x0d\\x1f \\\"'\\\\`~\\x7f\\x80\\xff\"")),
        (literal_bool(true, 0, 0), Ok("true")),
        (literal_bool(false, 0, 0), Ok("false")),
        (literal_null(0, 0), Ok("null")),
    ]);
}

#[test]
fn writes_or_refuses_every_name_member_and_field_as_node_does() {
    assert_writes_as_node(vec![
        (ident("a", false, 0, 0), Ok("a")),
        (ident("a", true, 0, 0), Ok(".a")),
        (ident("_a1", false, 0, 0), Ok("_a1")),
        (ident("if", false, 0, 0), Err("\"if\" is not a name, so it cannot be written as a name")),
        (ident("in", false, 0, 0), Err("\"in\" is not a name, so it cannot be written as a name")),
        (ident("true", true, 0, 0), Err("\"true\" is not a name, so it cannot be written as a name")),
        (ident("a-b", false, 0, 0), Err("\"a-b\" is not a name, so it cannot be written as a name")),
        (ident("", false, 0, 0), Err("\"\" is not a name, so it cannot be written as a name")),
        (ident("a\"b\n", false, 0, 0), Err("\"a\\\"b\\n\" is not a name, so it cannot be written as a name")),
        (call("f", (0, 0), vec![], 0, 0), Ok("f()")),
        (call("has", (0, 0), vec![select(ident("a", false, 0, 0), "b", (0, 0), false, false, 0, 0)], 0, 0), Ok("has(a.b)")),
        (call("in", (0, 0), vec![ident("a", false, 0, 0)], 0, 0), Err("\"in\" is not a name, so it cannot be written as a function name")),
        (call("f g", (0, 0), vec![ident("a", false, 0, 0)], 0, 0), Err("\"f g\" is not a name, so it cannot be written as a function name")),
        (receiver_call(ident("a", false, 0, 0), "in", (0, 0), vec![], 0, 0), Ok("a.in()")),
        (receiver_call(ident("a", false, 0, 0), "while", (0, 0), vec![ident("b", false, 0, 0), ident("c", false, 0, 0)], 0, 0), Ok("a.while(b, c)")),
        (receiver_call(ident("a", false, 0, 0), "a b", (0, 0), vec![], 0, 0), Err("\"a b\" is not a name, so it cannot be written as a function name")),
        (receiver_call(ident("a", false, 0, 0), "", (0, 0), vec![], 0, 0), Err("\"\" is not a name, so it cannot be written as a function name")),
        (qualified_call("M", (0, 0), "while", (0, 0), vec![ident("a", false, 0, 0)], 0, 0), Ok("M.while(a)")),
        (qualified_call("M", (0, 0), "f", (0, 0), vec![ident("a", false, 0, 0), ident("b", false, 0, 0)], 0, 0), Ok("M.f(a, b)")),
        (qualified_call("if", (0, 0), "f", (0, 0), vec![], 0, 0), Err("\"if\" is not a name, so it cannot be written as a namespace")),
        (qualified_call("M.N", (0, 0), "f", (0, 0), vec![], 0, 0), Err("\"M.N\" is not a name, so it cannot be written as a namespace")),
        (qualified_call("M", (0, 0), "a.b", (0, 0), vec![], 0, 0), Err("\"a.b\" is not a name, so it cannot be written as a function name")),
        (qualified_call("cel", (0, 0), "bind", (0, 0), vec![ident("a", false, 0, 0), literal_int(1, 0, 0), ident("a", false, 0, 0)], 0, 0), Ok("cel.bind(a, 1, a)")),
        (select(ident("a", false, 0, 0), "b", (0, 0), false, false, 0, 0), Ok("a.b")),
        (select(ident("a", false, 0, 0), "if", (0, 0), false, false, 0, 0), Ok("a.if")),
        (select(ident("a", false, 0, 0), "b", (0, 0), false, true, 0, 0), Ok("a.`b`")),
        (select(ident("a", false, 0, 0), "a-b", (0, 0), false, false, 0, 0), Ok("a.`a-b`")),
        (select(ident("a", false, 0, 0), "a b", (0, 0), true, false, 0, 0), Ok("a.?`a b`")),
        (select(ident("a", false, 0, 0), "b", (0, 0), true, false, 0, 0), Ok("a.?b")),
        (select(ident("a", false, 0, 0), "\u{e9}", (0, 0), false, false, 0, 0), Ok("a.`\u{e9}`")),
        (select(ident("a", false, 0, 0), "a`b", (0, 0), false, false, 0, 0), Err("\"a`b\" cannot be written as a member name")),
        (select(ident("a", false, 0, 0), "a`b", (0, 0), false, true, 0, 0), Err("\"a`b\" cannot be written as a member name")),
        (select(ident("a", false, 0, 0), "a\nb", (0, 0), false, false, 0, 0), Err("\"a\\nb\" cannot be written as a member name")),
        (select(ident("a", false, 0, 0), "a\rb", (0, 0), false, false, 0, 0), Ok("a.`a\rb`")),
        (select(ident("a", false, 0, 0), "", (0, 0), false, true, 0, 0), Err("\"\" cannot be written as a member name")),
        (select(ident("a", false, 0, 0), "", (0, 0), false, false, 0, 0), Err("\"\" cannot be written as a member name")),
    ]);
}

#[test]
fn places_parentheses_from_precedence_alone() {
    assert_writes_as_node(vec![
        (binary("+", binary("+", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a + b + c")),
        (binary("+", ident("a", false, 0, 0), binary("+", ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a + (b + c)")),
        (binary("-", ident("a", false, 0, 0), binary("+", ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a - (b + c)")),
        (binary("*", binary("+", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("(a + b) * c")),
        (binary("+", binary("*", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a * b + c")),
        (binary("+", ident("a", false, 0, 0), binary("*", ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a + b * c")),
        (binary("==", binary("==", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a == b == c")),
        (binary("==", ident("a", false, 0, 0), binary("==", ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a == (b == c)")),
        (binary("in", ident("a", false, 0, 0), binary("in", ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a in (b in c)")),
        (binary("&&", binary("||", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("(a || b) && c")),
        (binary("||", binary("&&", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a && b || c")),
        (binary("||", ident("a", false, 0, 0), binary("||", ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a || (b || c)")),
        (binary("%", binary("/", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a / b % c")),
        (unary("!", binary("&&", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), 0, 0), Ok("!(a && b)")),
        (unary("-", binary("*", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), 0, 0), Ok("-(a * b)")),
        (unary("-", unary("-", ident("a", false, 0, 0), 0, 0), 0, 0), Ok("--a")),
        (unary("!", unary("-", ident("a", false, 0, 0), 0, 0), 0, 0), Ok("!-a")),
        (unary("-", unary("!", ident("a", false, 0, 0), 0, 0), 0, 0), Ok("-!a")),
        (unary("-", literal_int(1, 0, 0), 0, 0), Ok("-(1)")),
        (unary("-", literal_int(-1, 0, 0), 0, 0), Ok("--1")),
        (unary("-", literal_double(0x3ff8000000000000, 0, 0), 0, 0), Ok("-(1.5)")),
        (unary("-", literal_double(0x8000000000000000, 0, 0), 0, 0), Ok("--0.0")),
        (unary("-", literal_double(0x0000000000000000, 0, 0), 0, 0), Ok("-(0.0)")),
        (unary("-", literal_double(0x7ff0000000000000, 0, 0), 0, 0), Ok("-(1e999)")),
        (unary("-", literal_double(0xfff0000000000000, 0, 0), 0, 0), Ok("--1e999")),
        (unary("-", literal_uint(1, 0, 0), 0, 0), Ok("-1u")),
        (unary("-", literal_string("a", 0, 0), 0, 0), Ok("-\"a\"")),
        (unary("!", literal_int(1, 0, 0), 0, 0), Ok("!1")),
        (unary("!", literal_int(-1, 0, 0), 0, 0), Ok("!-1")),
        (binary("-", ident("a", false, 0, 0), literal_int(-1, 0, 0), 0, 0), Ok("a - -1")),
        (binary("-", literal_int(-1, 0, 0), ident("a", false, 0, 0), 0, 0), Ok("-1 - a")),
        (binary("*", literal_int(-1, 0, 0), literal_int(-2, 0, 0), 0, 0), Ok("-1 * -2")),
        (select(literal_int(-1, 0, 0), "x", (0, 0), false, false, 0, 0), Ok("(-1).x")),
        (select(literal_int(1, 0, 0), "x", (0, 0), false, false, 0, 0), Ok("1.x")),
        (select(literal_double(0x3ff0000000000000, 0, 0), "x", (0, 0), false, false, 0, 0), Ok("1.0.x")),
        (select(literal_double(0x8000000000000000, 0, 0), "x", (0, 0), false, false, 0, 0), Ok("(-0.0).x")),
        (index(literal_int(-1, 0, 0), literal_int(-1, 0, 0), false, 0, 0), Ok("(-1)[-1]")),
        (receiver_call(literal_double(0xbff8000000000000, 0, 0), "f", (0, 0), vec![literal_int(-1, 0, 0)], 0, 0), Ok("(-1.5).f(-1)")),
        (select(unary("-", ident("a", false, 0, 0), 0, 0), "b", (0, 0), false, false, 0, 0), Ok("(-a).b")),
        (select(binary("+", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), "c", (0, 0), false, false, 0, 0), Ok("(a + b).c")),
        (index(binary("+", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), binary("+", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), true, 0, 0), Ok("(a + b)[?a + b]")),
        (receiver_call(conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), "f", (0, 0), vec![conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0)], 0, 0), Ok("(a ? b : c).f(a ? b : c)")),
        (select(select(index(ident("a", false, 0, 0), ident("b", false, 0, 0), false, 0, 0), "c", (0, 0), false, false, 0, 0), "d", (0, 0), false, false, 0, 0), Ok("a[b].c.d")),
        (conditional(conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), Ok("(a ? b : c) ? b : c")),
        (conditional(ident("a", false, 0, 0), conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("a ? a ? b : c : a ? b : c")),
        (conditional(binary("||", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a || b ? b : c")),
        (conditional(binary("&&", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), Ok("a && b ? b : c")),
        (binary("||", conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), Ok("(a ? b : c) || (a ? b : c)")),
        (binary("+", conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), unary("!", conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), 0, 0), 0, 0), Ok("(a ? b : c) + !(a ? b : c)")),
        (list(vec![element(conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), false), element(binary("+", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0), true), element(list(vec![], 0, 0), false)], 0, 0), Ok("[a ? b : c, ?a + b, []]")),
        (map(vec![entry(conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), false), entry(ident("a", false, 0, 0), ident("b", false, 0, 0), true), entry(map(vec![], 0, 0), list(vec![], 0, 0), false)], 0, 0), Ok("{a ? b : c: a ? b : c, ?a: b, {}: []}")),
        (call("f", (0, 0), vec![conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0), binary("||", ident("a", false, 0, 0), ident("b", false, 0, 0), 0, 0)], 0, 0), Ok("f(a ? b : c, a || b)")),
        (qualified_call("M", (0, 0), "f", (0, 0), vec![conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), ident("c", false, 0, 0), 0, 0)], 0, 0), Ok("M.f(a ? b : c)")),
    ]);
}

#[test]
fn reports_the_first_fault_in_the_order_the_text_is_written() {
    assert_writes_as_node(vec![
        (unparsed(0, 0), Err("an unparsed expression has no source to write")),
        (binary("+", ident("a", false, 0, 0), unparsed(0, 0), 0, 0), Err("an unparsed expression has no source to write")),
        (binary("+", ident("if", false, 0, 0), unparsed(0, 0), 0, 0), Err("\"if\" is not a name, so it cannot be written as a name")),
        (binary("+", unparsed(0, 0), ident("if", false, 0, 0), 0, 0), Err("an unparsed expression has no source to write")),
        (call("in", (0, 0), vec![unparsed(0, 0)], 0, 0), Err("\"in\" is not a name, so it cannot be written as a function name")),
        (call("f", (0, 0), vec![unparsed(0, 0), ident("if", false, 0, 0)], 0, 0), Err("an unparsed expression has no source to write")),
        (receiver_call(unparsed(0, 0), "a b", (0, 0), vec![], 0, 0), Err("an unparsed expression has no source to write")),
        (receiver_call(ident("if", false, 0, 0), "a b", (0, 0), vec![unparsed(0, 0)], 0, 0), Err("\"if\" is not a name, so it cannot be written as a name")),
        (receiver_call(ident("a", false, 0, 0), "a b", (0, 0), vec![unparsed(0, 0)], 0, 0), Err("\"a b\" is not a name, so it cannot be written as a function name")),
        (select(unparsed(0, 0), "a`b", (0, 0), false, false, 0, 0), Err("an unparsed expression has no source to write")),
        (select(ident("if", false, 0, 0), "a`b", (0, 0), false, false, 0, 0), Err("\"if\" is not a name, so it cannot be written as a name")),
        (qualified_call("if", (0, 0), "a b", (0, 0), vec![unparsed(0, 0)], 0, 0), Err("\"if\" is not a name, so it cannot be written as a namespace")),
        (qualified_call("M", (0, 0), "a b", (0, 0), vec![unparsed(0, 0)], 0, 0), Err("\"a b\" is not a name, so it cannot be written as a function name")),
        (qualified_call("M", (0, 0), "f", (0, 0), vec![unparsed(0, 0), ident("if", false, 0, 0)], 0, 0), Err("an unparsed expression has no source to write")),
        (list(vec![element(unparsed(0, 0), false), element(ident("if", false, 0, 0), false)], 0, 0), Err("an unparsed expression has no source to write")),
        (list(vec![element(ident("if", false, 0, 0), false), element(unparsed(0, 0), false)], 0, 0), Err("\"if\" is not a name, so it cannot be written as a name")),
        (map(vec![entry(literal_double(0x7ff8000000000000, 0, 0), unparsed(0, 0), false)], 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (map(vec![entry(ident("a", false, 0, 0), literal_double(0x7ff8000000000000, 0, 0), false), entry(unparsed(0, 0), ident("a", false, 0, 0), false)], 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (index(literal_double(0x7ff8000000000000, 0, 0), unparsed(0, 0), false, 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (index(ident("a", false, 0, 0), unparsed(0, 0), false, 0, 0), Err("an unparsed expression has no source to write")),
        (unary("-", unparsed(0, 0), 0, 0), Err("an unparsed expression has no source to write")),
        (unary("-", literal_double(0x7ff8000000000000, 0, 0), 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (unary("!", literal_double(0x7ff8000000000000, 0, 0), 0, 0), Err("a double that is not a number cannot be written as a literal")),
        (conditional(ident("a", false, 0, 0), unparsed(0, 0), ident("if", false, 0, 0), 0, 0), Err("an unparsed expression has no source to write")),
        (conditional(ident("if", false, 0, 0), unparsed(0, 0), ident("a", false, 0, 0), 0, 0), Err("\"if\" is not a name, so it cannot be written as a name")),
        (conditional(ident("a", false, 0, 0), ident("b", false, 0, 0), literal_double(0x7ff8000000000000, 0, 0), 0, 0), Err("a double that is not a number cannot be written as a literal")),
    ]);
}
