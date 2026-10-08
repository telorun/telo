//! Every conformance-vector source that reads writes back and re-reads to an equal tree.
//!
//! No Node test file is the twin of this one: it is the front end's half of what the
//! vector runners will hold when they land. The vectors are read where they are, from
//! `templating/cel-conformance/` beside this crate's workspace; a missing file fails.
//!
//! **The selection.** Every row of `language.json`, `catalog.json` and `types.json`,
//! and every row tagged `cel` of `holes.json`, `module-calls.json` and
//! `verdicts.json`. A row tagged `interpolate` or `sql` is excluded: its source is text
//! with holes, not an expression. Of a row only `id`, `source`, `tag` and
//! `modules.names` are read — never what it expects.
//!
//! **The proof.** Each selected source is read as an expression with the optional
//! syntax on, under the row's module names or none. A set the reader refuses fails the
//! test. A source reads when it has no diagnostic; one that reads must hold no hole,
//! write, read back under the same options with no diagnostic, and be the same
//! expression.
//!
//! **What is Node's answer, executed** on the same selection under the same options
//! (`@telorun/cel` 0.112.0 at `d265cc79`): each file's row, selected and excluded
//! counts, every id that does not read with its syntax code, and — for `language.json`
//! — the number Node's own replay of that file reports as written back and re-read.
//! Everything not listed as refused must round-trip.
//!
//! What this cannot see: a source both engines read, to different trees that each
//! round-trip. The twins and the diagnostic tables hold that until the vector runners
//! compare answers.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use telorun_cel::{
    has_unparsed, parse_expression, serialize_tree, trees_equal, CelSyntaxCode, ParseExpressionOptions, ParseOptions,
};

/// `(file, its rows, the rows selected, the rows excluded, the selected rows that do not read)`.
const NODE_COUNTS: [(&str, usize, usize, usize, usize); 6] = [
    ("language.json", 1814, 1814, 0, 0),
    ("catalog.json", 178, 178, 0, 0),
    ("types.json", 64, 64, 0, 0),
    ("holes.json", 82, 5, 77, 2),
    ("module-calls.json", 53, 49, 4, 0),
    ("verdicts.json", 109, 92, 17, 2),
];

/// Every selected row that does not read, with the code of its diagnostic.
const NODE_REFUSED: [(&str, CelSyntaxCode); 4] = [
    ("holes/language/raw_trailing_backslash", CelSyntaxCode::UnterminatedString),
    ("holes/language/prefix_rb", CelSyntaxCode::UnexpectedToken),
    ("verdicts/CEL_SYNTAX_ERROR/expression", CelSyntaxCode::UnexpectedEnd),
    ("verdicts/CEL_SYNTAX_ERROR/unterminated_string", CelSyntaxCode::UnterminatedString),
];

const NODE_LANGUAGE_ROUND_TRIPPED: usize = 1814;

/// The files every row of which is an expression.
const WHOLE_FILES: [&str; 3] = ["language.json", "catalog.json", "types.json"];

fn text<'a>(row: &'a Value, key: &str, file: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("a row of {file} has no text under {key:?}: {row}"))
}

/// Whether the row's source is one expression.
fn selected(row: &Value, file: &str) -> bool {
    if WHOLE_FILES.contains(&file) {
        return true;
    }
    match text(row, "tag", file) {
        "cel" => true,
        "interpolate" | "sql" => false,
        other => panic!("{} of {file} names the tag {other:?}", text(row, "id", file)),
    }
}

fn module_names(row: &Value, file: &str) -> Vec<String> {
    let Some(modules) = row.get("modules") else { return Vec::new() };
    let names = modules.get("names").and_then(Value::as_array);
    let names = names.unwrap_or_else(|| panic!("{} of {file} has modules with no names", text(row, "id", file)));
    names
        .iter()
        .map(|name| name.as_str().unwrap_or_else(|| panic!("{} of {file} has a name that is not text", text(row, "id", file))))
        .map(str::to_string)
        .collect()
}

#[test]
fn every_vector_source_that_reads_writes_back_to_an_equal_tree() {
    let vectors = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templating/cel-conformance");
    // One options value for each namespace set the vectors name.
    let mut options: BTreeMap<Vec<String>, ParseExpressionOptions> = BTreeMap::new();
    let mut refused: Vec<(String, CelSyntaxCode)> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let mut language_round_tripped = None;

    for (file, row_count, selected_count, excluded_count, refused_count) in NODE_COUNTS {
        let path = vectors.join(file);
        let read = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let parsed: Value = serde_json::from_str(&read).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let rows = parsed.get("rows").and_then(Value::as_array).unwrap_or_else(|| panic!("{file} holds no rows"));

        let mut read_here = 0;
        let mut refused_here = 0;
        let mut round_tripped = 0;
        for row in rows.iter().filter(|row| selected(row, file)) {
            read_here += 1;
            let id = text(row, "id", file);
            let source = text(row, "source", file);
            let names = module_names(row, file);
            let under = options.entry(names).or_insert_with_key(|names| ParseExpressionOptions {
                parse: ParseOptions { optional_syntax: true, ..ParseOptions::default() },
                namespaces: names.clone(),
            });
            let expression = parse_expression(source, under).unwrap_or_else(|refusal| panic!("{id}: {refusal}"));
            if let Some(diagnostic) = &expression.diagnostic {
                refused_here += 1;
                refused.push((id.to_string(), diagnostic.code));
                continue;
            }
            if has_unparsed(&expression.root) {
                failures.push(format!("{id}: read with no diagnostic but left a hole in the tree"));
                continue;
            }
            let written = match serialize_tree(&expression.root) {
                Ok(written) => written,
                Err(refusal) => {
                    failures.push(format!("{id}: {source:?} reads and cannot be written: {refusal}"));
                    continue;
                }
            };
            let reread = parse_expression(&written, under).unwrap_or_else(|refusal| panic!("{id}: {refusal}"));
            if let Some(diagnostic) = &reread.diagnostic {
                failures.push(format!("{id}: wrote {written:?}, which does not read back: {}", diagnostic.message));
            } else if !trees_equal(&expression.root, &reread.root) {
                failures.push(format!("{id}: wrote {written:?}, which reads back as a different expression"));
            } else {
                round_tripped += 1;
            }
        }

        assert_eq!(rows.len(), row_count, "the rows of {file}");
        assert_eq!(read_here, selected_count, "the selected rows of {file}");
        assert_eq!(rows.len() - read_here, excluded_count, "the excluded rows of {file}");
        assert_eq!(refused_here, refused_count, "the selected rows of {file} that do not read");
        assert_eq!(round_tripped, selected_count - refused_count, "the rows of {file} that round-trip: {failures:#?}");
        if file == "language.json" {
            language_round_tripped = Some(round_tripped);
        }
    }

    assert!(failures.is_empty(), "{failures:#?}");
    let expected: Vec<(String, CelSyntaxCode)> = NODE_REFUSED.iter().map(|(id, code)| (id.to_string(), *code)).collect();
    assert_eq!(refused, expected);
    assert_eq!(language_round_tripped, Some(NODE_LANGUAGE_ROUND_TRIPPED));
}
