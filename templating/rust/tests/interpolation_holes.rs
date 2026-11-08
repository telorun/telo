//! The hole reader — the twin of the reader half of `templating/nodejs/tests/interpolate.test.ts`.
//!
//! Every answer in the tables below is the Node build's, executed: `@telorun/templating`
//! at `bc6d1172` + slice 10 card 1, Node v24.21.0, read through `readInterpolationHoles`
//! and `interpolationShape`. `ROWS` holds one answer per row of `holes.json`,
//! `module-calls.json` and `verdicts.json` tagged `interpolate` or `sql` (the sources are
//! read from those files, so a row added there without an answer here fails the count);
//! `CASES` holds the reader's own cases — Node's reader tests and the edges no row has.
//! A hole is `(start, end, expr_start, expr)` in UTF-16 code units; a failure is the
//! offset and the message.

use serde_json::Value;
use telo_templating::{
    interpolation_shape, literal_fragments, read_interpolation_holes, HoleReading, InterpolationShape,
};

enum Node {
    Holes(&'static [(usize, usize, usize, &'static str)]),
    Failed(usize, &'static str),
}

// BEGIN NODE TABLE
const ROWS: &[(&str, &str, Node)] = &[
    ("holes/shape/none", "none", Node::Holes(&[])),
    ("holes/shape/lone_hole", "lone-hole", Node::Holes(&[(0, 8, 4, "x")])),
    ("holes/shape/lone_hole_padded", "lone-hole", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/shape/interpolated", "interpolated", Node::Holes(&[(6, 17, 10, "name")])),
    ("holes/shape/malformed", "malformed", Node::Failed(6, "the hole opened at offset 6 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/shape/sql_none", "none", Node::Holes(&[])),
    ("holes/shape/sql_lone_hole", "lone-hole", Node::Holes(&[(0, 8, 4, "x")])),
    ("holes/shape/sql_interpolated", "interpolated", Node::Holes(&[(27, 36, 31, "id"), (48, 59, 52, "name")])),
    ("holes/shape/sql_malformed", "malformed", Node::Failed(7, "the hole opened at offset 7 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/single_quoted_closer", "lone-hole", Node::Holes(&[(0, 13, 4, "'a}}b'")])),
    ("holes/grammar/double_quoted_closer", "lone-hole", Node::Holes(&[(0, 11, 4, "\"}}\"")])),
    ("holes/grammar/escaped_quote", "lone-hole", Node::Holes(&[(0, 17, 4, "'it\\'s }}'")])),
    ("holes/grammar/map_literal", "lone-hole", Node::Holes(&[(0, 20, 4, "{'a': 1}['a']")])),
    ("holes/grammar/nested_map_literal", "lone-hole", Node::Holes(&[(0, 26, 4, "{'a': {'b': 2}}.a.b")])),
    ("holes/grammar/map_literal_then_brace", "interpolated", Node::Holes(&[(0, 17, 4, "{'a': 1}.a")])),
    ("holes/grammar/triple_single_quoted", "lone-hole", Node::Holes(&[(0, 25, 4, "'''it's }} here'''")])),
    ("holes/grammar/triple_double_quoted", "lone-hole", Node::Holes(&[(0, 21, 4, "\"\"\"a \"}}\" b\"\"\"")])),
    ("holes/grammar/triple_quoted_newline", "lone-hole", Node::Holes(&[(0, 17, 4, "'''a\n}}'''")])),
    ("holes/grammar/single_quoted_newline", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/escaped_line_feed", "lone-hole", Node::Holes(&[(0, 13, 4, "'a\\\nb'")])),
    ("holes/grammar/single_quoted_carriage_return", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/triple_quoted_carriage_return", "lone-hole", Node::Holes(&[(0, 17, 4, "'''a\r}}'''")])),
    ("holes/grammar/escaped_carriage_return", "lone-hole", Node::Holes(&[(0, 13, 4, "'a\\\rb'")])),
    ("holes/grammar/raw_carriage_return", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/quoted_member_carriage_return", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/single_quoted_line_separator", "lone-hole", Node::Holes(&[(0, 12, 4, "'a\u{2028}b'")])),
    ("holes/grammar/raw_string", "lone-hole", Node::Holes(&[(0, 15, 4, "r'a\\n}}'")])),
    ("holes/grammar/upper_raw_string", "lone-hole", Node::Holes(&[(0, 15, 4, "R'a\\n}}'")])),
    ("holes/grammar/upper_bytes_string", "lone-hole", Node::Holes(&[(0, 12, 4, "B'}}'")])),
    ("holes/grammar/bytes_string", "lone-hole", Node::Holes(&[(0, 12, 4, "b'}}'")])),
    ("holes/grammar/literal_opener", "lone-hole", Node::Holes(&[(0, 12, 4, "'${{'")])),
    ("holes/grammar/literal_opener_in_text", "interpolated", Node::Holes(&[(6, 18, 10, "'${{'")])),
    ("holes/grammar/nothing_else_special", "none", Node::Holes(&[])),
    ("holes/grammar/unterminated", "malformed", Node::Failed(2, "the hole opened at offset 2 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/unterminated_second_hole", "malformed", Node::Failed(13, "the hole opened at offset 13 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/unterminated_string", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/single_closing_brace", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/unbalanced_map_brace", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/adjacent_holes", "interpolated", Node::Holes(&[(0, 8, 4, "a"), (8, 16, 12, "b")])),
    ("holes/grammar/multiple_holes", "interpolated", Node::Holes(&[(0, 8, 4, "a"), (9, 17, 13, "b"), (18, 26, 22, "a")])),
    ("holes/grammar/no_padding", "lone-hole", Node::Holes(&[(0, 6, 3, "x")])),
    ("holes/grammar/trimmed_padding", "interpolated", Node::Holes(&[(0, 11, 6, "x"), (12, 22, 18, "x")])),
    ("holes/grammar/every_trimmed_character", "lone-hole", Node::Holes(&[(0, 56, 28, "x")])),
    ("holes/grammar/padding_not_trimmed", "lone-hole", Node::Holes(&[(0, 8, 3, "\u{85}x")])),
    ("holes/grammar/empty_hole", "interpolated", Node::Holes(&[(2, 8, 6, "")])),
    ("holes/grammar/utf16_offsets", "interpolated", Node::Holes(&[(3, 20, 7, "upper('\u{e9}')")])),
    ("holes/grammar/raw_backslash_before_quote", "lone-hole", Node::Holes(&[(0, 12, 4, "r'\\''")])),
    ("holes/grammar/raw_trailing_backslash", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("holes/grammar/raw_two_trailing_backslashes", "lone-hole", Node::Holes(&[(0, 13, 4, "r'a\\\\'")])),
    ("holes/grammar/prefix_rb", "lone-hole", Node::Holes(&[(0, 13, 4, "rb'\\''")])),
    ("holes/grammar/prefix_br", "lone-hole", Node::Holes(&[(0, 13, 4, "br'\\''")])),
    ("holes/grammar/quoted_member_name", "lone-hole", Node::Holes(&[(0, 17, 4, "m.`it's}}`")])),
    ("holes/grammar/comment_text", "lone-hole", Node::Holes(&[(0, 16, 4, "x // note")])),
    ("holes/interpolate/string", "lone-hole", Node::Holes(&[(0, 13, 4, "'text'")])),
    ("holes/interpolate/int", "lone-hole", Node::Holes(&[(0, 9, 4, "42")])),
    ("holes/interpolate/uint", "lone-hole", Node::Holes(&[(0, 10, 4, "42u")])),
    ("holes/interpolate/double", "lone-hole", Node::Holes(&[(0, 10, 4, "2.5")])),
    ("holes/interpolate/double_integral", "lone-hole", Node::Holes(&[(0, 10, 4, "1.0")])),
    ("holes/interpolate/bool", "lone-hole", Node::Holes(&[(0, 12, 4, "1 < 2")])),
    ("holes/interpolate/bytes", "lone-hole", Node::Holes(&[(0, 19, 4, "b'h\\xc3\\xa9'")])),
    ("holes/interpolate/timestamp", "lone-hole", Node::Holes(&[(0, 40, 4, "timestamp('2026-03-15T10:30:00Z')")])),
    ("holes/interpolate/duration", "lone-hole", Node::Holes(&[(0, 24, 4, "duration('1h30m')")])),
    ("holes/interpolate/dyn_values", "interpolated", Node::Holes(&[(0, 8, 4, "a"), (9, 17, 13, "b"), (18, 26, 22, "c"), (27, 35, 31, "d"), (36, 44, 40, "e"), (45, 53, 49, "f"), (54, 62, 58, "g"), (63, 71, 67, "h")])),
    ("holes/interpolate/brand", "interpolated", Node::Holes(&[(5, 13, 9, "p"), (20, 28, 24, "d")])),
    ("holes/interpolate/list_static", "lone-hole", Node::Holes(&[(0, 13, 4, "[1, 2]")])),
    ("holes/interpolate/map_static", "lone-hole", Node::Holes(&[(0, 15, 4, "{'a': 1}")])),
    ("holes/interpolate/optional_static", "lone-hole", Node::Holes(&[(0, 21, 4, "optional.of(1)")])),
    ("holes/interpolate/type_static", "lone-hole", Node::Holes(&[(0, 10, 4, "int")])),
    ("holes/interpolate/null_static", "lone-hole", Node::Holes(&[(0, 11, 4, "null")])),
    ("holes/interpolate/declared_list_static", "interpolated", Node::Holes(&[(6, 17, 10, "tags")])),
    ("holes/interpolate/dyn_null", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/interpolate/dyn_list", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/interpolate/dyn_map", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/interpolate/dyn_optional", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/interpolate/dyn_type", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/interpolate/unbound", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("holes/interpolate/nullable_chain", "interpolated", Node::Holes(&[(6, 17, 10, "note")])),
    ("holes/interpolate/nullable_chain_guarded", "interpolated", Node::Holes(&[(6, 37, 10, "note != null ? note : ''")])),
    ("holes/interpolate/refs_and_volatility", "interpolated", Node::Holes(&[(0, 10, 4, "b.c"), (11, 32, 15, "size(uuidv4())"), (33, 41, 37, "a")])),
    ("holes/anchoring/wrong_call_form_fix", "interpolated", Node::Holes(&[(6, 25, 10, "name.lower()")])),
    ("holes/anchoring/rename_fix", "interpolated", Node::Holes(&[(6, 23, 10, "uppe(name)")])),
    ("holes/anchoring/fix_in_second_hole", "interpolated", Node::Holes(&[(0, 15, 4, "upper(a)"), (20, 45, 24, "startsWith(b, 'x')")])),
    ("holes/anchoring/diagnostics_in_hole_order", "interpolated", Node::Holes(&[(0, 14, 4, "1 + 'a'"), (15, 36, 19, "fixed(1.0, 11)"), (37, 47, 41, "[1]")])),
    ("holes/anchoring/call_offsets", "interpolated", Node::Holes(&[(2, 19, 6, "upper('x')"), (22, 53, 26, "lower('Y') + trim(' z ')")])),
    ("holes/anchoring/site_inputs_reach_each_hole", "interpolated", Node::Holes(&[(3, 13, 7, "nme"), (17, 41, 21, "request.query.nme")])),
    ("holes/anchoring/sql_fix", "interpolated", Node::Holes(&[(29, 48, 33, "name.lower()")])),
    ("holes/sql/typed_values", "interpolated", Node::Holes(&[(22, 31, 26, "at"), (33, 45, 37, "n + 1"), (47, 58, 51, "flag")])),
    ("holes/sql/null_list_and_map", "interpolated", Node::Holes(&[(7, 15, 11, "x"), (17, 30, 21, "[1, 2]"), (32, 47, 36, "{'a': 1}")])),
    ("holes/sql/nullable_chain", "interpolated", Node::Holes(&[(7, 18, 11, "note")])),
    ("holes/sql/quoted_text_is_not_cel", "interpolated", Node::Holes(&[(8, 19, 12, "name"), (24, 35, 28, "name")])),
    ("holes/sql/refs_and_volatility", "interpolated", Node::Holes(&[(7, 17, 11, "b.c"), (19, 40, 23, "size(uuidv4())"), (42, 50, 46, "a")])),
    ("holes/sql/hole_error", "interpolated", Node::Holes(&[(7, 15, 11, "a"), (17, 31, 21, "missing")])),
    ("module-calls/holes/interpolate", "interpolated", Node::Holes(&[(7, 33, 11, "Billing.total(2, 3)"), (35, 59, 39, "Billing.format(2)")])),
    ("module-calls/holes/interpolate_not_convertible", "interpolated", Node::Holes(&[(6, 27, 10, "Billing.tags()")])),
    ("module-calls/holes/interpolate_stops_at_first_failure", "interpolated", Node::Holes(&[(0, 24, 4, "Billing.nothing()"), (25, 48, 29, "Billing.total(1)")])),
    ("module-calls/holes/sql", "interpolated", Node::Holes(&[(7, 31, 11, "Billing.total(id)"), (33, 55, 37, "Self.double(id)")])),
    ("verdicts/CEL_SYNTAX_ERROR/hole_never_closes", "malformed", Node::Failed(14, "the hole opened at offset 14 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("verdicts/CEL_SYNTAX_ERROR/hole_never_closes_sql", "malformed", Node::Failed(31, "the hole opened at offset 31 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("verdicts/CEL_SYNTAX_ERROR/hole_expression", "interpolated", Node::Holes(&[(6, 16, 10, "1 +")])),
    ("verdicts/CEL_SYNTAX_ERROR/hole_expression_sql", "interpolated", Node::Holes(&[(7, 17, 11, "1 +"), (19, 27, 23, ")")])),
    ("verdicts/CEL_NULLABLE_ACCESS/hole_is_nullable", "interpolated", Node::Holes(&[(6, 17, 10, "note"), (25, 37, 29, "codes")])),
    ("verdicts/CEL_NULLABLE_ACCESS/hole_guarded", "interpolated", Node::Holes(&[(6, 38, 10, "note == null ? '-' : note")])),
    ("verdicts/CEL_NULLABLE_ACCESS/hole_dereference", "interpolated", Node::Holes(&[(6, 23, 10, "error.code")])),
    ("verdicts/INTERPOLATION_HOLE_NOT_CONVERTIBLE/list", "interpolated", Node::Holes(&[(7, 27, 11, "request.items")])),
    ("verdicts/INTERPOLATION_HOLE_NOT_CONVERTIBLE/after_a_clean_hole", "interpolated", Node::Holes(&[(0, 11, 4, "'ok'"), (17, 34, 21, "{'a': [1]}"), (40, 53, 44, "[true]")])),
    ("verdicts/INTERPOLATION_HOLE_NOT_CONVERTIBLE/yields_to_the_holes_own_diagnostic", "lone-hole", Node::Holes(&[(0, 16, 4, "[1 + 'a']")])),
    ("verdicts/INTERPOLATION_HOLE_NOT_CONVERTIBLE/not_under_sql", "interpolated", Node::Holes(&[(7, 20, 11, "[1, 2]")])),
    ("verdicts/ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE/null", "interpolated", Node::Holes(&[(6, 17, 10, "name")])),
    ("verdicts/ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE/list_in_second_hole", "interpolated", Node::Holes(&[(0, 8, 4, "a"), (10, 20, 14, "b.c")])),
    ("verdicts/ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE/source_written_as_json", "interpolated", Node::Holes(&[(8, 16, 12, "x")])),
    ("verdicts/ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE/map", "lone-hole", Node::Holes(&[(0, 8, 4, "m")])),
    ("verdicts/ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE/module_call_result", "lone-hole", Node::Holes(&[(0, 24, 4, "Billing.nothing()")])),
    ("verdicts/ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE/string_passes", "lone-hole", Node::Holes(&[(0, 8, 4, "s")])),
];

const CASES: &[(&str, &str, Node)] = &[
    ("${{ {'type': 'image', 'n': 1} }}", "lone-hole", Node::Holes(&[(0, 32, 4, "{'type': 'image', 'n': 1}")])),
    ("a ${{ '}}' + x }} b ${{ \"{\" }}", "interpolated", Node::Holes(&[(2, 17, 6, "'}}' + x"), (20, 30, 24, "\"{\"")])),
    ("${{ '${{' }}", "lone-hole", Node::Holes(&[(0, 12, 4, "'${{'")])),
    ("${{ r'\\'' }} x", "interpolated", Node::Holes(&[(0, 12, 4, "r'\\''")])),
    ("${{ r'\\' }} x", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("port ${{  ports.http }}!", "interpolated", Node::Holes(&[(5, 23, 10, "ports.http")])),
    ("a ${{ foo", "malformed", Node::Failed(2, "the hole opened at offset 2 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("plain", "none", Node::Holes(&[])),
    ("  ${{ x }} ", "lone-hole", Node::Holes(&[(2, 10, 6, "x")])),
    ("${{ x }}${{ y }}", "interpolated", Node::Holes(&[(0, 8, 4, "x"), (8, 16, 12, "y")])),
    ("a ${{ x }}", "interpolated", Node::Holes(&[(2, 10, 6, "x")])),
    ("${{ x", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("\u{1f600} ${{ \u{1f600} }} \u{e9}${{\u{85}x\u{85}}}${{\u{feff}y\u{feff}}}", "interpolated", Node::Holes(&[(3, 12, 7, "\u{1f600}"), (14, 22, 17, "\u{85}x\u{85}"), (22, 30, 26, "y")])),
    ("\u{1f600}${{ '\u{1f600}", "malformed", Node::Failed(2, "the hole opened at offset 2 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("${{ a // don't }}", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("${{ `a`b` }}", "malformed", Node::Failed(0, "the hole opened at offset 0 never closes \u{2014} a hole ends at the first '}}' outside a string literal and outside any braces it opened")),
    ("${{ x }}\u{85}", "interpolated", Node::Holes(&[(0, 8, 4, "x")])),
    ("\u{feff}${{ x }}\u{feff}", "lone-hole", Node::Holes(&[(1, 9, 5, "x")])),
];
// END NODE TABLE

fn shape_name(shape: InterpolationShape) -> &'static str {
    match shape {
        InterpolationShape::None => "none",
        InterpolationShape::LoneHole => "lone-hole",
        InterpolationShape::Interpolated => "interpolated",
        InterpolationShape::Malformed => "malformed",
    }
}

fn utf16_offset(source: &str, byte: usize) -> usize {
    source[..byte].encode_utf16().count()
}

/// Holds one source to Node's answer: every hole's offsets (units and bytes), its
/// expression, the failure's offset and message, and the shape.
fn assert_reads_as_node(what: &str, source: &str, shape: &str, node: &Node) {
    assert_eq!(shape_name(interpolation_shape(source)), shape, "{what}: shape");
    match (read_interpolation_holes(source), node) {
        (HoleReading::Holes(holes), Node::Holes(expected)) => {
            let read: Vec<(usize, usize, usize, &str)> =
                holes.iter().map(|hole| (hole.start, hole.end, hole.expr_start, hole.expr.as_str())).collect();
            assert_eq!(read, *expected, "{what}: holes");
            for hole in &holes {
                assert_eq!(hole.start, utf16_offset(source, hole.byte_start), "{what}: start in bytes");
                assert_eq!(hole.end, utf16_offset(source, hole.byte_end), "{what}: end in bytes");
                assert_eq!(hole.expr_start, utf16_offset(source, hole.expr_byte_start), "{what}: expr start in bytes");
                assert!(source[hole.byte_start..].starts_with("${{") && source[..hole.byte_end].ends_with("}}"), "{what}");
                assert!(source[hole.expr_byte_start..].starts_with(&hole.expr), "{what}: expr at its offset");
            }
            assert_eq!(literal_fragments(source, &holes).len(), holes.len() + 1, "{what}: fragments");
        }
        (HoleReading::Failed { offset, byte_offset, message }, Node::Failed(expected, text)) => {
            assert_eq!((offset, message.as_str()), (*expected, *text), "{what}: failure");
            assert_eq!(offset, utf16_offset(source, byte_offset), "{what}: failure byte offset");
        }
        (reading, _) => panic!("{what}: Rust read {reading:?}, Node the other way"),
    }
}

#[test]
fn reads_every_hole_tag_row_of_the_vectors_as_node_does() {
    let mut sources = std::collections::HashMap::new();
    let mut count = 0;
    for file in ["holes.json", "module-calls.json", "verdicts.json"] {
        let path = format!("{}/../cel-conformance/{file}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{path}: {err}"));
        let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|err| panic!("{path}: {err}"));
        for row in parsed["rows"].as_array().expect("rows") {
            if matches!(row["tag"].as_str(), Some("interpolate" | "sql")) {
                count += 1;
                let id = row["id"].as_str().expect("id").to_string();
                assert!(sources.insert(id.clone(), row["source"].as_str().expect("source").to_string()).is_none(), "{id}");
            }
        }
    }
    assert_eq!(count, ROWS.len(), "the hole-tag rows of the vectors and the recorded answers");
    for (id, shape, node) in ROWS {
        let source = sources.get(*id).unwrap_or_else(|| panic!("no row {id}"));
        assert_reads_as_node(id, source, shape, node);
    }
}

#[test]
fn reads_the_readers_own_cases_as_node_does() {
    for (source, shape, node) in CASES {
        assert_reads_as_node(&format!("{source:?}"), source, shape, node);
    }
}
