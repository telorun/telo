//! Runs the tag vectors (`templating/tag-conformance/`), the Rust twin of
//! `../../nodejs/tests/tag-conformance.test.ts`.

use serde_json::Value;
use serde_yaml::Value as Yaml;
use telo_templating::{parse_ref_source, yaml_to_json};

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
        let yaml: Yaml = serde_yaml::from_str(row["yaml"].as_str().unwrap()).unwrap();
        let loaded = yaml_to_json(yaml);
        match row.get("refusal") {
            Some(refusal) => {
                let err = loaded.expect_err(row["name"].as_str().unwrap());
                assert_eq!(err.code, refusal["code"].as_str(), "{}", row["name"]);
            }
            None => {
                let json = loaded.unwrap_or_else(|err| panic!("{}: {err}", row["name"]));
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
