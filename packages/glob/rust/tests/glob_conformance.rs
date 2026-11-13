//! The language-neutral conformance suite (`packages/glob/conformance/glob.json`),
//! answered here as `packages/glob/nodejs/tests/glob-conformance.test.ts`
//! answers it in Node.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use telorun_glob::{select_by_patterns, SelectOptions};

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("a list, not {value}"))
        .iter()
        .map(|item| item.as_str().unwrap_or_else(|| panic!("a string, not {item}")).to_string())
        .collect()
}

#[test]
fn the_glob_vectors_select_as_recorded() {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../conformance/glob.json");
    let suite: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap_or_else(|err| panic!("{}: {err}", file.display())))
        .unwrap_or_else(|err| panic!("{}: {err}", file.display()));
    let cases = suite["cases"].as_array().expect("a list of cases");
    assert!(!cases.is_empty(), "{} holds no cases", file.display());
    let mut misses = Vec::new();
    for case in cases {
        let options = case.get("options");
        let options = SelectOptions {
            apply_default_ignore: options.and_then(|o| o.get("applyDefaultIgnore")).and_then(Value::as_bool),
            exclude: options.and_then(|o| o.get("exclude")).map(strings).unwrap_or_default(),
        };
        let selected = select_by_patterns(&strings(&case["paths"]), &strings(&case["patterns"]), &options);
        if selected != strings(&case["selected"]) {
            misses.push(format!("{}: expected {:?}, selected {selected:?}", case["name"], strings(&case["selected"])));
        }
    }
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}
