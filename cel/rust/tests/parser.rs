//! The expression grammar, error recovery and the input limits — the twin of
//! `cel/nodejs/tests/parser.test.ts`, case for case.
//!
//! Every row and every literal is the Node build's answer, executed: `@telorun/cel`
//! 0.112.0 at `d265cc79`. Where a Node case
//! asserts part of a tree or only a code, the row here holds the whole of what Node
//! answered for that source — the tree with every range, and the diagnostic with its
//! message.
//!
//! Past the twin: the mixed-width source at the end, which no Node case reads.

mod support;

use support::*;
use telorun_cel::{serialize_tree, trees_equal, CelSyntaxCode, CelSyntaxDiagnostic, DEFAULT_PARSE_LIMITS, RESERVED_WORDS};

// --- the expression grammar -----------------------------------------------------

#[test]
fn groups_an_unparenthesized_source_exactly_as_its_parenthesized_twin() {
    /// `(written, parenthesized, whether Node's treesEqual holds them equal)`.
    const NODE_PAIRS: [(&str, &str, bool); 15] = [
        ("a + b * c", "a + (b * c)", true),
        ("a * b + c", "(a * b) + c", true),
        ("a - b - c", "(a - b) - c", true),
        ("a / b % c", "(a / b) % c", true),
        ("a == b && c != d", "(a == b) && (c != d)", true),
        ("a && b || c", "(a && b) || c", true),
        ("a in b == c", "(a in b) == c", true),
        ("a < b + c", "a < (b + c)", true),
        ("!a && b", "(!a) && b", true),
        ("-a * b", "(-a) * b", true),
        ("-a.b", "-(a.b)", true),
        ("a[0].b", "(a[0]).b", true),
        ("a.b.c(1)", "(a.b).c(1)", true),
        ("a ? b : c ? d : e", "a ? b : (c ? d : e)", true),
        ("a || b ? c : d", "(a || b) ? c : d", true),
    ];
    for (written, parenthesized, equal) in NODE_PAIRS {
        assert_eq!(trees_equal(&tree(written), &tree(parenthesized)), equal, "{written} against {parenthesized}");
    }
    assert_reads_as_node(vec![
        reading("a + b * c", defaults(), binary("+", ident("a", false, 0, 1), binary("*", ident("b", false, 4, 5), ident("c", false, 8, 9), 4, 9), 0, 9), None),
        reading("a + (b * c)", defaults(), binary("+", ident("a", false, 0, 1), binary("*", ident("b", false, 5, 6), ident("c", false, 9, 10), 5, 10), 0, 10), None),
        reading("a * b + c", defaults(), binary("+", binary("*", ident("a", false, 0, 1), ident("b", false, 4, 5), 0, 5), ident("c", false, 8, 9), 0, 9), None),
        reading("(a * b) + c", defaults(), binary("+", binary("*", ident("a", false, 1, 2), ident("b", false, 5, 6), 1, 6), ident("c", false, 10, 11), 1, 11), None),
        reading("a - b - c", defaults(), binary("-", binary("-", ident("a", false, 0, 1), ident("b", false, 4, 5), 0, 5), ident("c", false, 8, 9), 0, 9), None),
        reading("(a - b) - c", defaults(), binary("-", binary("-", ident("a", false, 1, 2), ident("b", false, 5, 6), 1, 6), ident("c", false, 10, 11), 1, 11), None),
        reading("a / b % c", defaults(), binary("%", binary("/", ident("a", false, 0, 1), ident("b", false, 4, 5), 0, 5), ident("c", false, 8, 9), 0, 9), None),
        reading("(a / b) % c", defaults(), binary("%", binary("/", ident("a", false, 1, 2), ident("b", false, 5, 6), 1, 6), ident("c", false, 10, 11), 1, 11), None),
        reading("a == b && c != d", defaults(), binary("&&", binary("==", ident("a", false, 0, 1), ident("b", false, 5, 6), 0, 6), binary("!=", ident("c", false, 10, 11), ident("d", false, 15, 16), 10, 16), 0, 16), None),
        reading("(a == b) && (c != d)", defaults(), binary("&&", binary("==", ident("a", false, 1, 2), ident("b", false, 6, 7), 1, 7), binary("!=", ident("c", false, 13, 14), ident("d", false, 18, 19), 13, 19), 1, 19), None),
        reading("a && b || c", defaults(), binary("||", binary("&&", ident("a", false, 0, 1), ident("b", false, 5, 6), 0, 6), ident("c", false, 10, 11), 0, 11), None),
        reading("(a && b) || c", defaults(), binary("||", binary("&&", ident("a", false, 1, 2), ident("b", false, 6, 7), 1, 7), ident("c", false, 12, 13), 1, 13), None),
        reading("a in b == c", defaults(), binary("==", binary("in", ident("a", false, 0, 1), ident("b", false, 5, 6), 0, 6), ident("c", false, 10, 11), 0, 11), None),
        reading("(a in b) == c", defaults(), binary("==", binary("in", ident("a", false, 1, 2), ident("b", false, 6, 7), 1, 7), ident("c", false, 12, 13), 1, 13), None),
        reading("a < b + c", defaults(), binary("<", ident("a", false, 0, 1), binary("+", ident("b", false, 4, 5), ident("c", false, 8, 9), 4, 9), 0, 9), None),
        reading("a < (b + c)", defaults(), binary("<", ident("a", false, 0, 1), binary("+", ident("b", false, 5, 6), ident("c", false, 9, 10), 5, 10), 0, 10), None),
        reading("!a && b", defaults(), binary("&&", unary("!", ident("a", false, 1, 2), 0, 2), ident("b", false, 6, 7), 0, 7), None),
        reading("(!a) && b", defaults(), binary("&&", unary("!", ident("a", false, 2, 3), 1, 3), ident("b", false, 8, 9), 1, 9), None),
        reading("-a * b", defaults(), binary("*", unary("-", ident("a", false, 1, 2), 0, 2), ident("b", false, 5, 6), 0, 6), None),
        reading("(-a) * b", defaults(), binary("*", unary("-", ident("a", false, 2, 3), 1, 3), ident("b", false, 7, 8), 1, 8), None),
        reading("-a.b", defaults(), unary("-", select(ident("a", false, 1, 2), "b", (3, 4), false, false, 1, 4), 0, 4), None),
        reading("-(a.b)", defaults(), unary("-", select(ident("a", false, 2, 3), "b", (4, 5), false, false, 2, 5), 0, 5), None),
        reading("a[0].b", defaults(), select(index(ident("a", false, 0, 1), literal_int(0, 2, 3), false, 0, 4), "b", (5, 6), false, false, 0, 6), None),
        reading("(a[0]).b", defaults(), select(index(ident("a", false, 1, 2), literal_int(0, 3, 4), false, 1, 5), "b", (7, 8), false, false, 1, 8), None),
        reading("a.b.c(1)", defaults(), receiver_call(select(ident("a", false, 0, 1), "b", (2, 3), false, false, 0, 3), "c", (4, 5), vec![literal_int(1, 6, 7)], 0, 8), None),
        reading("(a.b).c(1)", defaults(), receiver_call(select(ident("a", false, 1, 2), "b", (3, 4), false, false, 1, 4), "c", (6, 7), vec![literal_int(1, 8, 9)], 1, 10), None),
        reading("a ? b : c ? d : e", defaults(), conditional(ident("a", false, 0, 1), ident("b", false, 4, 5), conditional(ident("c", false, 8, 9), ident("d", false, 12, 13), ident("e", false, 16, 17), 8, 17), 0, 17), None),
        reading("a ? b : (c ? d : e)", defaults(), conditional(ident("a", false, 0, 1), ident("b", false, 4, 5), conditional(ident("c", false, 9, 10), ident("d", false, 13, 14), ident("e", false, 17, 18), 9, 18), 0, 18), None),
        reading("a || b ? c : d", defaults(), conditional(binary("||", ident("a", false, 0, 1), ident("b", false, 5, 6), 0, 6), ident("c", false, 9, 10), ident("d", false, 13, 14), 0, 14), None),
        reading("(a || b) ? c : d", defaults(), conditional(binary("||", ident("a", false, 1, 2), ident("b", false, 6, 7), 1, 7), ident("c", false, 11, 12), ident("d", false, 15, 16), 1, 16), None),
    ]);
}

#[test]
fn reads_member_and_index_access_in_both_their_forms() {
    assert_reads_as_node(vec![
        reading("a.?b[?0]", defaults(), index(select(ident("a", false, 0, 1), "b", (3, 4), true, false, 0, 4), literal_int(0, 6, 7), true, 0, 8), None),
    ]);
}

#[test]
fn reads_a_global_call_and_a_receiver_call_each_node_ranged() {
    assert_reads_as_node(vec![
        reading("size(xs.filter(i, i > 0))", defaults(), call("size", (0, 4), vec![receiver_call(ident("xs", false, 5, 7), "filter", (8, 14), vec![ident("i", false, 15, 16), binary(">", ident("i", false, 18, 19), literal_int(0, 22, 23), 18, 23)], 5, 24)], 0, 25), None),
    ]);
}

#[test]
fn reads_list_and_map_literals_nested() {
    assert_reads_as_node(vec![
        reading("[{'a': [1]}]", defaults(), list(vec![element(map(vec![entry(literal_string("a", 2, 5), list(vec![element(literal_int(1, 8, 9), false)], 7, 10), false)], 1, 11), false)], 0, 12), None),
    ]);
}

#[test]
fn leaves_a_macro_call_as_an_ordinary_call() {
    assert_reads_as_node(vec![
        reading("has(a.b)", defaults(), call("has", (0, 3), vec![select(ident("a", false, 4, 5), "b", (6, 7), false, false, 4, 7)], 0, 8), None),
        reading("[1].all(i, i > 0)", defaults(), receiver_call(list(vec![element(literal_int(1, 1, 2), false)], 0, 3), "all", (4, 7), vec![ident("i", false, 8, 9), binary(">", ident("i", false, 11, 12), literal_int(0, 15, 16), 11, 16)], 0, 17), None),
        reading("cel.bind(x, 1, x)", defaults(), receiver_call(ident("cel", false, 0, 3), "bind", (4, 8), vec![ident("x", false, 9, 10), literal_int(1, 12, 13), ident("x", false, 15, 16)], 0, 17), None),
    ]);
}

#[test]
fn lets_no_reserved_word_be_read_as_a_name() {
    // cel-spec's RESERVED, excluded from IDENT. Three of the 21 are refused by being
    // read as something else, which is the only reason they are reserved at all.
    let refused = [
        "as", "break", "const", "continue", "else", "for", "function", "if", "import", "let", "loop", "package",
        "namespace", "return", "var", "void", "while",
    ];
    let mut every = [&refused[..], &["in", "true", "false", "null"][..]].concat();
    every.sort();
    let mut reserved = RESERVED_WORDS;
    reserved.sort();
    assert_eq!(every, reserved);
    // Each refused word alone, then as a call: 34 rows.
    let rows = vec![
        reading("as", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"as\" is a reserved word and cannot be used as a name", 0, 2))),
        reading("as(1)", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"as\" is a reserved word and cannot be used as a name", 0, 2))),
        reading("break", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"break\" is a reserved word and cannot be used as a name", 0, 5))),
        reading("break(1)", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"break\" is a reserved word and cannot be used as a name", 0, 5))),
        reading("const", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"const\" is a reserved word and cannot be used as a name", 0, 5))),
        reading("const(1)", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"const\" is a reserved word and cannot be used as a name", 0, 5))),
        reading("continue", defaults(), unparsed(0, 8), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"continue\" is a reserved word and cannot be used as a name", 0, 8))),
        reading("continue(1)", defaults(), unparsed(0, 8), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"continue\" is a reserved word and cannot be used as a name", 0, 8))),
        reading("else", defaults(), unparsed(0, 4), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"else\" is a reserved word and cannot be used as a name", 0, 4))),
        reading("else(1)", defaults(), unparsed(0, 4), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"else\" is a reserved word and cannot be used as a name", 0, 4))),
        reading("for", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"for\" is a reserved word and cannot be used as a name", 0, 3))),
        reading("for(1)", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"for\" is a reserved word and cannot be used as a name", 0, 3))),
        reading("function", defaults(), unparsed(0, 8), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"function\" is a reserved word and cannot be used as a name", 0, 8))),
        reading("function(1)", defaults(), unparsed(0, 8), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"function\" is a reserved word and cannot be used as a name", 0, 8))),
        reading("if", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"if\" is a reserved word and cannot be used as a name", 0, 2))),
        reading("if(1)", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"if\" is a reserved word and cannot be used as a name", 0, 2))),
        reading("import", defaults(), unparsed(0, 6), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"import\" is a reserved word and cannot be used as a name", 0, 6))),
        reading("import(1)", defaults(), unparsed(0, 6), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"import\" is a reserved word and cannot be used as a name", 0, 6))),
        reading("let", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"let\" is a reserved word and cannot be used as a name", 0, 3))),
        reading("let(1)", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"let\" is a reserved word and cannot be used as a name", 0, 3))),
        reading("loop", defaults(), unparsed(0, 4), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"loop\" is a reserved word and cannot be used as a name", 0, 4))),
        reading("loop(1)", defaults(), unparsed(0, 4), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"loop\" is a reserved word and cannot be used as a name", 0, 4))),
        reading("package", defaults(), unparsed(0, 7), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"package\" is a reserved word and cannot be used as a name", 0, 7))),
        reading("package(1)", defaults(), unparsed(0, 7), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"package\" is a reserved word and cannot be used as a name", 0, 7))),
        reading("namespace", defaults(), unparsed(0, 9), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"namespace\" is a reserved word and cannot be used as a name", 0, 9))),
        reading("namespace(1)", defaults(), unparsed(0, 9), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"namespace\" is a reserved word and cannot be used as a name", 0, 9))),
        reading("return", defaults(), unparsed(0, 6), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"return\" is a reserved word and cannot be used as a name", 0, 6))),
        reading("return(1)", defaults(), unparsed(0, 6), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"return\" is a reserved word and cannot be used as a name", 0, 6))),
        reading("var", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"var\" is a reserved word and cannot be used as a name", 0, 3))),
        reading("var(1)", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"var\" is a reserved word and cannot be used as a name", 0, 3))),
        reading("void", defaults(), unparsed(0, 4), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"void\" is a reserved word and cannot be used as a name", 0, 4))),
        reading("void(1)", defaults(), unparsed(0, 4), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"void\" is a reserved word and cannot be used as a name", 0, 4))),
        reading("while", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"while\" is a reserved word and cannot be used as a name", 0, 5))),
        reading("while(1)", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"while\" is a reserved word and cannot be used as a name", 0, 5))),
    ];
    assert_eq!(rows.len(), 2 * refused.len());
    for (row, word) in rows.iter().step_by(2).zip(refused) {
        assert_eq!(row.source, word);
        assert_eq!(row.diagnostic.as_ref().map(|diagnostic| diagnostic.code), Some(CelSyntaxCode::ReservedIdentifier));
    }
    assert_reads_as_node(rows);
    assert_reads_as_node(vec![
        reading("cel", defaults(), ident("cel", false, 0, 3), None),
        reading("optional", defaults(), ident("optional", false, 0, 8), None),
        reading("has", defaults(), ident("has", false, 0, 3), None),
        reading("self", defaults(), ident("self", false, 0, 4), None),
        reading("x", defaults(), ident("x", false, 0, 1), None),
    ]);
}

#[test]
fn reads_in_as_the_membership_operator_never_as_a_name() {
    assert_reads_as_node(vec![
        reading("in", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"in\" cannot stand here", 0, 2))),
        reading("in(1)", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"in\" cannot stand here", 0, 2))),
        reading("in + 1", defaults(), unparsed(0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"in\" cannot stand here", 0, 2))),
        reading("a in b", defaults(), binary("in", ident("a", false, 0, 1), ident("b", false, 5, 6), 0, 6), None),
    ]);
}

#[test]
fn reads_true_false_and_null_as_literals_never_as_names() {
    assert_reads_as_node(vec![
        reading("true", defaults(), literal_bool(true, 0, 4), None),
        reading("true(1)", defaults(), literal_bool(true, 0, 4), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here", 4, 5))),
        reading("false", defaults(), literal_bool(false, 0, 5), None),
        reading("false(1)", defaults(), literal_bool(false, 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here", 5, 6))),
        reading("null", defaults(), literal_null(0, 4), None),
        reading("null(1)", defaults(), literal_null(0, 4), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here", 4, 5))),
    ]);
}

#[test]
fn reads_a_member_name_between_backticks_and_only_where_a_member_is_read() {
    assert_reads_as_node(vec![
        reading("headers.`content-type`", defaults(), select(ident("headers", false, 0, 7), "content-type", (8, 22), false, true, 0, 22), None),
        reading("m.`foo.txt`", defaults(), select(ident("m", false, 0, 1), "foo.txt", (2, 11), false, true, 0, 11), None),
        reading("m.?`a-b`", defaults(), select(ident("m", false, 0, 1), "a-b", (3, 8), true, true, 0, 8), None),
        reading("`a`", defaults(), unparsed(0, 3), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a`\" cannot stand here, expected \"a member read, as in a.`b`\"", 0, 3))),
        reading("a + `b`", defaults(), binary("+", ident("a", false, 0, 1), unparsed(4, 7), 0, 7), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`b`\" cannot stand here, expected \"a member read, as in a.`b`\"", 4, 7))),
        reading("a.`b`(1)", defaults(), select(ident("a", false, 0, 1), "b", (2, 5), false, true, 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"(\" cannot stand here, expected \"a member read \u{2014} a quoted name is a field, not a call\"", 5, 6))),
        reading("a.`b", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnterminatedString, "a quoted member name ends at its closing backtick", 2, 4))),
    ]);
}

#[test]
fn reads_an_optional_entry_only_where_the_optional_syntax_is_enabled() {
    assert_reads_as_node(vec![
        reading("[?a, b]", optional_syntax(), list(vec![element(ident("a", false, 2, 3), true), element(ident("b", false, 5, 6), false)], 0, 7), None),
        reading("{?'k': v, 'j': w}", optional_syntax(), map(vec![entry(literal_string("k", 2, 5), ident("v", false, 7, 8), true), entry(literal_string("j", 10, 13), ident("w", false, 15, 16), false)], 0, 17), None),
        reading("[?a]", defaults(), list(vec![element(unparsed(1, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
        reading("{?'k': v}", defaults(), map(vec![entry(unparsed(1, 2), unparsed(2, 2), false)], 0, 2), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"?\" cannot stand here", 1, 2))),
    ]);
}

#[test]
fn reads_a_name_a_dot_opens_as_an_absolute_one() {
    assert_reads_as_node(vec![
        reading(".y", defaults(), ident("y", true, 0, 2), None),
        reading(".y.z", defaults(), select(ident("y", true, 0, 2), "z", (3, 4), false, false, 0, 4), None),
        reading("y", defaults(), ident("y", false, 0, 1), None),
        reading(".1 + 2", defaults(), binary("+", literal_double(0x3fb999999999999a, 0, 2), literal_int(2, 5, 6), 0, 6), None),
        reading(". y", defaults(), ident("y", true, 0, 3), None),
        reading(".+", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"+\" cannot stand here, expected \"a name\"", 1, 2))),
        reading(".if", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::ReservedIdentifier, "\"if\" is a reserved word and cannot be used as a name", 1, 3))),
        reading(".`a-b`", defaults(), unparsed(0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a-b`\" cannot stand here, expected \"a name\"", 1, 6))),
    ]);
}

#[test]
fn reads_any_word_as_a_member_name() {
    let rows = vec![
        reading("{'let': 1}.let", defaults(), select(map(vec![entry(literal_string("let", 1, 6), literal_int(1, 8, 9), false)], 0, 10), "let", (11, 14), false, false, 0, 14), None),
        reading("a.while()", defaults(), receiver_call(ident("a", false, 0, 1), "while", (2, 7), vec![], 0, 9), None),
        reading("a.in", defaults(), select(ident("a", false, 0, 1), "in", (2, 4), false, false, 0, 4), None),
        reading("{'in': 1}.in", defaults(), select(map(vec![entry(literal_string("in", 1, 5), literal_int(1, 7, 8), false)], 0, 9), "in", (10, 12), false, false, 0, 12), None),
        reading("a.true", defaults(), select(ident("a", false, 0, 1), "true", (2, 6), false, false, 0, 6), None),
        reading("a.null()", defaults(), receiver_call(ident("a", false, 0, 1), "null", (2, 6), vec![], 0, 8), None),
        reading("a.__proto__", defaults(), select(ident("a", false, 0, 1), "__proto__", (2, 11), false, false, 0, 11), None),
        reading("a.prototype()", defaults(), receiver_call(ident("a", false, 0, 1), "prototype", (2, 11), vec![], 0, 13), None),
        reading("a.constructor", defaults(), select(ident("a", false, 0, 1), "constructor", (2, 13), false, false, 0, 13), None),
    ];
    assert!(rows.iter().all(|row| row.diagnostic.is_none()));
    for row in &rows {
        let written = serialize_tree(&row.root).expect(row.source);
        assert!(trees_equal(&row.root, &read(&written).root), "{} → {written}", row.source);
    }
    assert_reads_as_node(rows);
}

// --- error recovery ---------------------------------------------------------------

#[test]
fn keeps_the_longest_prefix_it_read_and_says_where_it_stopped() {
    assert_reads_as_node(vec![
        reading("1 + ", defaults(), binary("+", literal_int(1, 0, 1), unparsed(4, 4), 0, 4), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete", 4, 4))),
    ]);
}

#[test]
fn leaves_a_member_read_with_no_name_as_a_select_an_editor_can_complete() {
    assert_reads_as_node(vec![
        reading("request.query.", defaults(), select(select(ident("request", false, 0, 7), "query", (8, 13), false, false, 0, 13), "", (14, 14), false, false, 0, 14), Some(diagnostic(CelSyntaxCode::UnexpectedEnd, "the expression ends before it is complete, expected \"a name\"", 14, 14))),
    ]);
}

#[test]
fn reports_one_diagnostic_for_the_first_thing_it_could_not_read() {
    let rows = vec![
        reading("a ` b ` c", defaults(), ident("a", false, 0, 1), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"` b `\" cannot stand here", 2, 7))),
        reading("[1, , 2] + +", defaults(), list(vec![element(literal_int(1, 1, 2), false), element(unparsed(4, 5), false)], 0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\",\" cannot stand here", 4, 5))),
    ];
    for row in &rows {
        assert!(read(row.source).diagnostic.is_some(), "{}", row.source);
    }
    assert_reads_as_node(rows);
}

// --- the input limits ---------------------------------------------------------------

fn ones(count: usize) -> String {
    vec!["1"; count].join(",")
}

fn numbered_entries(count: usize) -> String {
    (0..count).map(|at| format!("{at}: 1")).collect::<Vec<_>>().join(",")
}

fn nested_parentheses(depth: usize) -> String {
    format!("{}1{}", "(".repeat(depth), ")".repeat(depth))
}

#[test]
fn refuses_more_nodes_depth_elements_entries_or_arguments_than_the_limit_allows() {
    let default_limits =
        limits(100000, 250, 1000, 1000, 32)
        ;
    assert_eq!(default_limits.limits, DEFAULT_PARSE_LIMITS);
    let wide_lists = limits(100000, 250, 200000, 1000, 32);
    let sources = [
        (format!("[{}]", ones(100001)), wide_lists),
        (nested_parentheses(300), defaults()),
        (format!("[{}]", ones(1001)), defaults()),
        (format!("{{{}}}", numbered_entries(1001)), defaults()),
        (format!("f({})", ones(33)), defaults()),
    ];
    let node_refusals: [(&str, Option<CelSyntaxDiagnostic>); 5] = [
        ("nodes", Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nodes than the limit of 100000", 200001, 200002))),
        ("nesting", Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more nesting than the limit of 250", 250, 250))),
        ("list elements", Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more list elements than the limit of 1000", 0, 2002))),
        ("map entries", Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more map entries than the limit of 1000", 0, 6898))),
        ("call arguments", Some(diagnostic(CelSyntaxCode::LimitExceeded, "the expression has more call arguments than the limit of 32", 1, 67))),
    ];
    for ((source, options), (limit, refusal)) in sources.iter().zip(node_refusals) {
        assert_eq!(telorun_cel::parse_syntax(source, options).diagnostic, refusal, "{limit}");
    }
}

#[test]
fn reads_an_expression_at_every_limit() {
    let sources = [
        format!("[{}]", ones(1000)),
        format!("f({})", ones(32)),
        nested_parentheses(124),
        format!("{{{}}}", numbered_entries(1000)),
    ];
    let node_answers: [(&str, Option<CelSyntaxDiagnostic>); 4] = [
        ("list elements", None),
        ("call arguments", None),
        ("nesting", None),
        ("map entries", None),
    ];
    for (source, (limit, answer)) in sources.iter().zip(node_answers) {
        assert_eq!(read(source).diagnostic, answer, "{limit}");
    }
}

// --- past the twin ------------------------------------------------------------------

#[test]
fn ranges_every_node_of_a_mixed_width_source_in_utf16_code_units() {
    // ASCII, the basic plane and beyond it in names, strings, bytes and a comment.
    assert_reads_as_node(vec![
        reading("x.`\u{43a}\u{43b}\u{44e}\u{447}\u{1f600}`.f('\u{e9}\u{1f600}', b'\u{1f600}\u{e9}') + [\"\u{1f600}\", r'\u{44f}'][0] // \u{1f600} \u{e9}\n  ? {'\u{1f600}': .y}.`\u{1f600}` : q.`\u{44f}`", defaults(), conditional(binary("+", receiver_call(select(ident("x", false, 0, 1), "\u{43a}\u{43b}\u{44e}\u{447}\u{1f600}", (2, 10), false, true, 0, 10), "f", (11, 12), vec![literal_string("\u{e9}\u{1f600}", 13, 18), literal_bytes(&[240, 159, 152, 128, 195, 169], 20, 26)], 0, 27), index(list(vec![element(literal_string("\u{1f600}", 31, 35), false), element(literal_string("\u{44f}", 37, 41), false)], 30, 42), literal_int(0, 43, 44), false, 30, 45), 0, 45), select(map(vec![entry(literal_string("\u{1f600}", 59, 63), ident("y", true, 65, 67), false)], 58, 68), "\u{1f600}", (69, 73), false, true, 58, 73), select(ident("q", false, 76, 77), "\u{44f}", (78, 81), false, true, 76, 81), 0, 81), None),
        reading("'\u{1f600}' + y.`\u{e9}` )", defaults(), binary("+", literal_string("\u{1f600}", 0, 4), select(ident("y", false, 7, 8), "\u{e9}", (9, 12), false, true, 7, 12), 0, 12), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\")\" cannot stand here", 13, 14))),
    ]);
}
