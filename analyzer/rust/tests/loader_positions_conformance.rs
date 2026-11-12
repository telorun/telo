//! Runs `templating/tag-conformance/loader-positions.json`, the Rust twin of
//! `../../nodejs/tests/loader-positions-conformance.test.ts`.

use serde_json::{json, Map, Value};
use telo_analyzer::parse_loaded_file::parse_loaded_file;
use telo_analyzer::loaded_types::ParseErrorOrigin;
use telo_analyzer::Range;

fn compact(range: &Range) -> Value {
    json!([range.start.line, range.start.character, range.end.line, range.end.character])
}

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
            .map(|error| {
                let code = match &error.origin {
                    ParseErrorOrigin::Yaml(_) => "MANIFEST_PARSE_FAILED",
                    ParseErrorOrigin::Loader { code, .. } => code,
                    // A row is a refusal both loaders make; this reader's own limits are none.
                    ParseErrorOrigin::Unsupported(construct) => {
                        panic!("{}: refused as unsupported: {}", row["name"], construct.message())
                    }
                };
                let mut refusal = Map::new();
                refusal.insert("documentIndex".into(), json!(error.document_index));
                refusal.insert("code".into(), json!(code));
                refusal.insert("message".into(), json!(error.message()));
                if let Some(range) = &error.range {
                    refusal.insert("range".into(), compact(range));
                }
                Value::Object(refusal)
            })
            .collect();
        assert_eq!(Value::Array(found), row["refusals"], "{}", row["name"]);
        if let Some(documents) = row.get("documents") {
            let found: Vec<Value> = loaded
                .positions
                .iter()
                .map(|document| {
                    let positions: Map<String, Value> = document
                        .position_index
                        .iter()
                        .map(|(path, range)| (path.clone(), compact(range)))
                        .collect();
                    json!({ "sourceLine": document.source_line, "positions": positions })
                })
                .collect();
            // Compared as text, so the order fields are filed in is part of the answer.
            assert_eq!(
                serde_json::to_string(&found).unwrap(),
                serde_json::to_string(documents).unwrap(),
                "{}",
                row["name"]
            );
        }
    }
}
