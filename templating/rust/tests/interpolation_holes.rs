//! The hole reader — the twin of the reader half of `templating/nodejs/tests/interpolate.test.ts`.
//!
//! Every answer in the tables below is the Node build's, executed: `@telorun/templating`
//! at `bc6d1172` + slice 10 card 1, Node v24.21.0, read through `readInterpolationHoles`
//! and `interpolationShape`. `CASES` holds the reader's own cases — Node's reader tests and
//! the edges no row has; the vectors' rows are `cel_conformance.rs`'s alone.
//! A hole is `(start, end, expr_start, expr)` in UTF-16 code units; a failure is the
//! offset and the message.

use telo_templating::{
    interpolation_shape, literal_fragments, read_interpolation_holes, HoleReading, InterpolationShape,
};

enum Node {
    Holes(&'static [(usize, usize, usize, &'static str)]),
    Failed(usize, &'static str),
}

// BEGIN NODE TABLE
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
fn reads_the_readers_own_cases_as_node_does() {
    for (source, shape, node) in CASES {
        assert_reads_as_node(&format!("{source:?}"), source, shape, node);
    }
}
