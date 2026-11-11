//! Runs the conformance language rows, whole — the twin of
//! `cel/nodejs/conformance/language-replay.test.ts`.
//!
//! The vectors are read where they are, `templating/cel-conformance/` beside this crate's
//! workspace, located from the crate's manifest directory: plain `cargo test` needs no
//! outside input, and a missing file fails. Node takes the directory as a parameter
//! because its package must pass with no sibling tree on disk; a Rust crate's tests run
//! only inside this workspace.
//!
//! Past the Node twin, negative controls show the gates bite: a row recording a wrong
//! value, a file one row short, and bindings that are not the canonical writing of their
//! value, each failing naming its row. And the codec's forms no language row writes — a
//! tagged map, a host value, the null type — are read and written back here.

mod conformance;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{json, Value};

use conformance::conformance_value::{encode_conformance_value, json_text, read_canonical_conformance_value};
use conformance::language_replay::{
    replay_language_rows, row_count_problem, LanguageReplayReport, ReplayFailure, DRIVEN_FILE, LANGUAGE_ROWS,
};

/// Files of the vectors this driver deliberately leaves alone, and why.
const NOT_DRIVEN: [(&str, &str); 6] = [
    ("README.md", "the format's own documentation"),
    ("catalog.json", "the function catalog, driven through the projection"),
    ("types.json", "a host's own types, driven through the projection"),
    ("holes.json", "the `${{ … }}` hole grammar, which is a tag's reading of a scalar and not CEL"),
    ("module-calls.json", "a tag engine's resolution and dispatch, through its own seams"),
    ("verdicts.json", "a tag engine's diagnostic and error vocabulary"),
];

fn vectors() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../templating/cel-conformance")
}

fn language_file() -> &'static Value {
    static FILE: OnceLock<Value> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = vectors().join(DRIVEN_FILE);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    })
}

fn rows() -> &'static [Value] {
    language_file()["rows"].as_array().expect("the language file holds a list of rows")
}

fn report() -> &'static LanguageReplayReport {
    static REPORT: OnceLock<LanguageReplayReport> = OnceLock::new();
    REPORT.get_or_init(|| replay_language_rows(rows()))
}

fn ids(failures: &[ReplayFailure]) -> Vec<&str> {
    failures.iter().map(|failure| failure.id.as_str()).collect()
}

#[test]
fn knows_every_file_in_the_vectors_directory() {
    let mut held: Vec<String> = std::fs::read_dir(vectors())
        .expect("the vectors directory reads")
        .map(|entry| entry.expect("an entry reads").file_name().into_string().expect("a file name is text"))
        .collect();
    held.sort();
    let mut known: Vec<String> = NOT_DRIVEN.iter().map(|(name, _)| name.to_string()).collect();
    known.push(DRIVEN_FILE.into());
    known.sort();
    assert_eq!(held, known);
}

#[test]
fn reads_a_well_formed_language_file() {
    let file = language_file().as_object().expect("the language file is an object");
    let mut keys: Vec<&str> = file.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["celSpec", "rows"]);
    let cel_spec = file["celSpec"].as_object().expect("celSpec is an object");
    assert_eq!(cel_spec.keys().collect::<Vec<_>>(), ["commit"]);
    let commit = cel_spec["commit"].as_str().expect("the commit is text");
    assert!(commit.len() == 40 && commit.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')), "{commit}");
}

#[test]
fn holds_every_row_to_the_format() {
    assert_eq!(report().malformed, []);
}

#[test]
fn executes_every_row_of_the_file_and_the_file_holds_the_pinned_number_of_rows() {
    assert_eq!(row_count_problem(rows()), None);
    assert_eq!(report().rows, LANGUAGE_ROWS);
    assert_eq!(report().driven, report().rows);
}

#[test]
fn records_the_engines_whole_answer_on_every_row() {
    assert_eq!(report().answers, []);
}

#[test]
fn states_a_deviation_only_where_the_answer_differs_from_cel_spec_with_one_of_the_four_reasons() {
    assert_eq!(report().deviations, []);
}

#[test]
fn records_only_the_engines_own_codes_as_an_errors_cel_code() {
    assert_eq!(report().cel_codes, []);
}

#[test]
fn writes_back_and_rereads_every_source_that_reads_to_an_equal_tree() {
    assert_eq!(report().round_trip, []);
    assert_eq!(report().round_tripped + report().unreadable, report().driven);
    println!(
        "rows {}: {} answered whole, {} written back equal, {} not read whole.",
        report().rows,
        report().driven,
        report().round_tripped,
        report().unreadable
    );
}

#[test]
fn a_file_one_row_short_fails_the_pin() {
    assert!(row_count_problem(&rows()[1..]).is_some());
}

#[test]
fn a_row_recording_a_wrong_value_fails_naming_the_row() {
    let mut row = rows()
        .iter()
        .find(|row| row["expect"].get("value") == Some(&Value::Bool(true)))
        .expect("some row evaluates to true")
        .clone();
    row["expect"]["value"] = Value::Bool(false);
    let report = replay_language_rows(&[row.clone()]);
    assert_eq!(ids(&report.answers), [row["id"].as_str().unwrap()]);
    assert_eq!(report.malformed, []);
}

#[test]
fn a_binding_that_is_not_the_canonical_writing_of_its_value_fails_naming_the_row() {
    let scratch = |id: &str, binding: Value| {
        json!({
            "id": id,
            "source": "x",
            "bindings": { "x": binding },
            "expect": { "check": { "diagnostics": [], "type": "dyn", "calls": [] }, "value": null },
        })
    };
    let rows = [
        scratch("telo/scratch/int_with_a_leading_zero", json!({ "$telo": "int", "value": "01" })),
        scratch("telo/scratch/map_keys_out_of_order", json!({ "b": 1, "a": 2 })),
    ];
    let report = replay_language_rows(&rows);
    assert_eq!(ids(&report.malformed), ["telo/scratch/int_with_a_leading_zero", "telo/scratch/map_keys_out_of_order"]);
    assert_eq!(report.driven, 0);
}

#[test]
fn reads_and_writes_back_every_form_of_the_encoding() {
    let canonical = [
        r#"[100,1e+21,0.1,1e-7,{"$telo":"double","value":"-0"},{"$telo":"double","value":"NaN"}]"#,
        r#"{"2":1,"10":2,"a":3}"#,
        r#"{"$telo":"map","value":[[true,"b"],[{"$telo":"int","value":"1"},"a"],[{"$telo":"uint","value":"2"},"c"]]}"#,
        r#"{"$telo":"map","value":[["$cel",1]]}"#,
        r#"{"$cel":"host","type":"Telo.Url","value":{"host":"a","port":{"$telo":"int","value":"1"}}}"#,
        r#"{"$cel":"type","value":"null"}"#,
        r#"[{"$cel":"optional"},{"$cel":"optional","value":{"$telo":"bytes","value":"_-8"}}]"#,
        r#"[{"$telo":"google.protobuf.Timestamp","value":"2026-03-15T10:30:00.5Z"},{"$telo":"google.protobuf.Duration","value":"-5400.000000001s"}]"#,
    ];
    for text in canonical {
        let node: Value = serde_json::from_str(text).unwrap();
        let value = read_canonical_conformance_value(&node).unwrap_or_else(|refusal| panic!("{text}: {refusal}"));
        assert_eq!(json_text(&encode_conformance_value(&value).unwrap()), text);
    }
    let null_type: Value = serde_json::from_str(r#"{"$cel":"type","value":"null"}"#).unwrap();
    let telorun_cel::CelValue::Type(held) = read_canonical_conformance_value(&null_type).unwrap() else { panic!("a type value") };
    assert_eq!(held.name(), "null_type");
    for refused in [
        r#"{"$cel":"host","type":"map","value":{}}"#,
        r#"{"$telo":"map","value":[[true,"b"],[{"$telo":"int","value":"1"},"a"],[{"$telo":"int","value":"1"},"c"]]}"#,
        r#"{"$telo":"map","value":[[{"$telo":"int","value":"1"},"a"],[true,"b"]]}"#,
        r#"{"10":2,"2":1}"#,
    ] {
        let node: Value = serde_json::from_str(refused).unwrap();
        assert!(read_canonical_conformance_value(&node).is_err(), "{refused}");
    }
}
