//! Runs the tag vectors (`templating/tag-conformance/`), the Rust twin of
//! `../../nodejs/tests/tag-conformance.test.ts`.

use serde_json::Value;
use telo_templating::{compose_yaml, document_to_json, expansion_tag_misuse, parse_ref_source};

fn vectors(file: &str) -> Vec<Value> {
    let path = format!("{}/../tag-conformance/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{path}: {err}"));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{path}: {err}"))
}

#[test]
fn ref_grammar() {
    for row in vectors("ref.json") {
        let source = row["source"].as_str().unwrap();
        let (key, verdict) = parse_ref_source(source).to_json_entry();
        let expected = row
            .get(key)
            .unwrap_or_else(|| panic!("{}: answered {key}, the row holds the other", row["name"]));
        assert_eq!(
            serde_json::to_string(&verdict).unwrap(),
            serde_json::to_string(expected).unwrap(),
            "{}",
            row["name"]
        );
    }
}

#[test]
fn sentinels() {
    for row in vectors("sentinels.json") {
        let stream = compose_yaml(row["yaml"].as_str().unwrap());
        assert_eq!(stream.errors, vec![], "{}", row["name"]);
        let misuse: Vec<&str> = expansion_tag_misuse(&stream.documents[0]).iter().map(|m| m.code).collect();
        match row.get("refusal") {
            Some(refusal) => assert_eq!(misuse, vec![refusal["code"].as_str().unwrap()], "{}", row["name"]),
            None => {
                assert_eq!(misuse, Vec::<&str>::new(), "{}", row["name"]);
                let json = document_to_json(&stream.documents[0])
                    .unwrap_or_else(|err| panic!("{}: {err:?}", row["name"]))
                    .unwrap_or(Value::Null);
                // Compared as text, so key order is part of the answer.
                assert_eq!(
                    serde_json::to_string(&json).unwrap(),
                    serde_json::to_string(&row["json"]).unwrap(),
                    "{}",
                    row["name"]
                );
            }
        }
    }
}
