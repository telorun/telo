//! Runs `templating/tag-conformance/loader-positions.json`, the Rust twin of
//! `../../nodejs/tests/loader-positions-conformance.test.ts`.

use serde_json::Value;
use telo_analyzer::parse_loaded_file::parse_loaded_file;

#[test]
fn loader_positions() {
    let path = format!(
        "{}/../../templating/tag-conformance/loader-positions.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let rows: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for row in rows {
        let loaded = parse_loaded_file("/row.yaml", "/row.yaml", row["yaml"].as_str().unwrap());
        let found: Vec<Value> = loaded
            .parse_errors
            .iter()
            .map(|error| serde_json::json!({ "documentIndex": error.document_index, "code": error.code }))
            .collect();
        assert_eq!(Value::Array(found), row["refusals"], "{}", row["name"]);
    }
}
