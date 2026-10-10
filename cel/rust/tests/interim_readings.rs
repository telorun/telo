//! The one Node reading recorded as interim rather than intended, reproduced until Node
//! changes: a second engine that read a source differently would make two kernels
//! disagree about one manifest.
//!
//! A carriage return is content in a single-line string, a bytes literal and a quoted
//! member name; only a line feed ends one. cel-spec's single-line literal excludes it.
//!
//! No Node test file is the twin of this one. Every row is the Node build's answer,
//! executed: `@telorun/cel` 0.112.0, this branch's build.

mod support;

use support::*;
use telorun_cel::{serialize_tree, trees_equal, CelSyntaxCode};

#[test]
fn interim_a_single_line_literal_holds_a_raw_carriage_return() {
    // The quoted name alone is refused for where it stands, not for what it holds.
    assert_reads_as_node(vec![
        reading("'a\rb'", defaults(), literal_string("a\rb", 0, 5), None),
        reading("b'a\rb'", defaults(), literal_bytes(&[97, 13, 98], 0, 6), None),
        reading("`a\rb`", defaults(), unparsed(0, 5), Some(diagnostic(CelSyntaxCode::UnexpectedToken, "\"`a\\rb`\" cannot stand here, expected \"a member read, as in a.`b`\"", 0, 5))),
        reading("a.`b\rc`", defaults(), select(ident("a", false, 0, 1), "b\rc", (2, 7), false, true, 0, 7), None),
    ]);
}

#[test]
fn interim_writes_back_what_holds_a_carriage_return() {
    /// `(source, the text Node writes for its tree)`. Node re-reads each to an equal tree.
    const NODE_WRITTEN: [(&str, &str); 3] = [
        ("'a\rb'", "\"a\\rb\""),
        ("b'a\rb'", "b\"a\\x0db\""),
        ("a.`b\rc`", "a.`b\rc`"),
    ];
    for (source, written) in NODE_WRITTEN {
        let first = tree(source);
        assert_eq!(serialize_tree(&first).as_deref(), Ok(written), "{source}");
        assert!(trees_equal(&first, &tree(written)), "{source}");
    }
}
