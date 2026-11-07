//! The CEL conformance vectors' tag layer (`templating/cel-conformance/README.md`) — the
//! twin of `templating/nodejs/tests/cel-conformance.test.ts` and of
//! `cel-conformance-dialect.test.ts`.
//!
//! Every `tag: cel` row of `holes.json`, `module-calls.json` and `verdicts.json` is driven
//! through the `!cel` engine and deep-compared with its `expect`; the rows of the tags with
//! holes are driven once their engines exist. Beside them run the vectors' own gates: the
//! directory's files, the keys each file and row may carry, unique ids, no unpaired
//! surrogate, a handler handed a value the typed frame refuses making its row malformed,
//! the verdict vocabulary each code of which some row reports, and the value types some
//! `types.json` row declares.
//!
//! Not run here: Node's catalog-dispatch, literal-guard and RE2-kind gates, which are the
//! engine's replay's to hold.

mod support;

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::Value;
use support::cel_conformance_dialect::{conformance_handlers, run_dialect_row, DIALECT_TAGS};
use telo_templating::{build_cel_environment, CelDiagnosticCode, CEL_VERDICT_CODES};
use telorun_sdk_core::value_type::{cel_type_of_value_type, value_brand_bases, value_types_in_order};

/// The tag layer, driven here.
const DRIVEN_FILES: [&str; 3] = ["holes.json", "module-calls.json", "verdicts.json"];
/// Answered by the engine's own replay; read here only for the coverage gates.
const ENGINE_FILES: [&str; 3] = ["catalog.json", "types.json", "language.json"];
const DIALECT_ROW_KEYS: [&str; 12] = [
    "id",
    "tag",
    "source",
    "declarations",
    "functions",
    "bindings",
    "context",
    "explain",
    "rootsDeclared",
    "couldNameModule",
    "modules",
    "expect",
];
const MODULE_FUNCTION_KEYS: [&str; 6] = ["returns", "deterministic", "hostBacked", "resultSchema", "result", "error"];

/// Codes the vocabulary carries because `analyze` forwards the checker's own, which these
/// engines cannot produce: a module's names are registered open with their parameters
/// withheld, and the brands are nominal.
const UNREACHABLE_DIAGNOSTICS: [CelDiagnosticCode; 4] = [
    CelDiagnosticCode::CelTypeArgumentMismatch,
    CelDiagnosticCode::FunctionArgumentMismatch,
    CelDiagnosticCode::FunctionArityMismatch,
    CelDiagnosticCode::FunctionUnresolved,
];

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../cel-conformance")
}

fn read_file(name: &str) -> Value {
    let path = directory().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn rows(file: &Value) -> &Vec<Value> {
    file["rows"].as_array().expect("a vector file holds rows")
}

#[test]
fn accounts_for_every_file_in_the_directory() {
    let mut files: Vec<String> = std::fs::read_dir(directory())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != "README.md")
        .collect();
    files.sort();
    let mut expected: Vec<&str> = DRIVEN_FILES.iter().chain(ENGINE_FILES.iter()).copied().collect();
    expected.sort();
    assert_eq!(files, expected);
}

/// A string with an unpaired surrogate is outside the value domain. A Rust string holds
/// none, so such a file fails to read: written raw it is not UTF-8, and written as an
/// escape the JSON reader refuses it.
#[test]
fn holds_no_string_with_an_unpaired_surrogate_in_any_file() {
    for name in DRIVEN_FILES.iter().chain(ENGINE_FILES.iter()) {
        read_file(name);
    }
}

#[test]
fn refuses_an_unpaired_surrogate_escape_when_a_file_is_read() {
    for text in [r#"{"x":"\ud800"}"#, r#"{"x":"\udc00"}"#, r#"{"\ud83d":1}"#] {
        assert!(serde_json::from_str::<Value>(text).is_err(), "{text}");
    }
    assert!(serde_json::from_str::<Value>(r#"{"x":"😀"}"#).is_ok());
}

#[test]
fn reads_well_formed_dialect_files() {
    for name in DRIVEN_FILES {
        let file = read_file(name);
        let keys: Vec<&String> = file.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["rows"], "{name}");
        let mut ids = HashSet::new();
        for row in rows(&file) {
            let id = row["id"].as_str().unwrap_or("?");
            let object = row.as_object().unwrap();
            let unknown: Vec<&String> = object.keys().filter(|key| !DIALECT_ROW_KEYS.contains(&key.as_str())).collect();
            assert!(unknown.is_empty(), "row {id} carries unknown keys {unknown:?}");
            for key in ["id", "tag", "source", "expect"] {
                assert!(object.contains_key(key), "row {id} has no {key}");
            }
            assert!(DIALECT_TAGS.contains(&row["tag"].as_str().unwrap_or("")), "{id}");
            assert!(ids.insert(id.to_owned()), "row id {id} repeats");
            let Some(modules) = row.get("modules") else { continue };
            let modules = modules.as_object().unwrap();
            assert!(modules.keys().all(|key| key == "names" || key == "functions"), "{id}");
            assert!(modules["names"].as_array().is_some_and(|names| !names.is_empty()), "row {id} names no module");
            for (qualified, function) in modules.get("functions").and_then(Value::as_object).into_iter().flatten() {
                let at = format!("{id}: {qualified}");
                let function = function.as_object().unwrap();
                assert!(function.keys().all(|key| MODULE_FUNCTION_KEYS.contains(&key.as_str())), "{at}");
                for key in ["returns", "deterministic", "hostBacked"] {
                    assert!(function.contains_key(key), "{at} has no {key}");
                }
                assert!(
                    function.contains_key("result") != function.contains_key("error"),
                    "{at} scripts exactly one of a result and an error"
                );
            }
        }
    }
}

/// Every `tag: cel` row of a file deep-equals its `expect`; answers every row before failing.
fn drive_cel_rows(name: &str, count: usize) {
    let env = build_cel_environment(conformance_handlers());
    let file = read_file(name);
    let mut executed = 0;
    let mut failures = Vec::new();
    for row in rows(&file).iter().filter(|row| row["tag"] == "cel") {
        executed += 1;
        let id = row["id"].as_str().unwrap();
        match run_dialect_row(&env, row) {
            Ok(answer) if answer == row["expect"] => {}
            Ok(answer) => failures.push(format!("{id}\n  expected {}\n  answered {answer}", row["expect"])),
            Err(malformed) => failures.push(format!("{id}: {malformed}")),
        }
    }
    assert!(failures.is_empty(), "{} of {executed} rows differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(executed, count, "{name}");
}

#[test]
fn answers_every_cel_row_of_holes_json() {
    drive_cel_rows("holes.json", 5);
}

#[test]
fn answers_every_cel_row_of_module_calls_json() {
    drive_cel_rows("module-calls.json", 49);
}

#[test]
fn answers_every_cel_row_of_verdicts_json() {
    drive_cel_rows("verdicts.json", 94);
}

fn row(source: &str) -> Value {
    serde_json::json!({
        "id": "scratch/json/unwritable",
        "tag": "cel",
        "source": source,
        "expect": { "check": { "diagnostics": [], "calls": [], "regions": [] } },
    })
}

#[test]
fn fails_a_row_handing_a_handler_a_value_the_typed_frame_cannot_write_as_malformed() {
    let env = build_cel_environment(conformance_handlers());
    let refused = run_dialect_row(&env, &row("json(optional.of(1))")).unwrap_err();
    assert!(
        refused.starts_with(
            "The row 'scratch/json/unwritable' is malformed: the handler 'json' was handed a value the typed frame cannot write"
        ),
        "{refused}"
    );
    // An operator absorbing the refusal does not hide it.
    let absorbed = run_dialect_row(&env, &row("json(optional.of(1)) == 'x' || true")).unwrap_err();
    assert!(absorbed.starts_with("The row 'scratch/json/unwritable' is malformed"), "{absorbed}");
    // The record is kept to the evaluation it happened in.
    let sound = run_dialect_row(&env, &row("json('x')")).unwrap();
    assert_eq!(sound["value"], "json(\"x\")");
    let threads: Vec<_> = ["json(optional.of(1))", "json('x')"]
        .into_iter()
        .map(|source| {
            std::thread::spawn(move || run_dialect_row(&build_cel_environment(conformance_handlers()), &row(source)).is_ok())
        })
        .collect();
    let settled: Vec<bool> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
    assert_eq!(settled, [false, true]);
}

/// Every type a declaration names, record fields included.
fn declared_types(declaration: &Value, out: &mut HashSet<String>) {
    match declaration {
        Value::String(text) => {
            out.insert(text.clone());
        }
        Value::Object(object) => {
            for field in object["fields"].as_object().into_iter().flat_map(|fields| fields.values()) {
                declared_types(field, out);
            }
        }
        _ => {}
    }
}

#[test]
fn declares_a_variable_of_every_nominal_brand_and_every_type_with_members_in_some_types_json_row() {
    let mut declared = HashSet::new();
    for row in rows(&read_file("types.json")) {
        for declaration in row.get("declarations").and_then(Value::as_object).into_iter().flat_map(|held| held.values()) {
            declared_types(declaration, &mut declared);
        }
    }
    let registered: Vec<String> = value_brand_bases()
        .into_iter()
        .map(|(brand, _)| brand.to_owned())
        .chain(value_types_in_order().filter(|entry| entry.members.is_some()).map(|entry| cel_type_of_value_type(entry).to_owned()))
        .collect();
    let missing: Vec<&String> = registered.iter().filter(|name| !declared.contains(*name)).collect();
    assert!(missing.is_empty(), "{missing:?}");
}

fn reported_codes() -> (HashSet<String>, HashSet<String>) {
    let file = read_file("verdicts.json");
    let mut diagnosed = HashSet::new();
    let mut thrown = HashSet::new();
    for row in rows(&file) {
        for diagnostic in row["expect"]["check"]["diagnostics"].as_array().into_iter().flatten() {
            if let Some(code) = diagnostic["code"].as_str() {
                diagnosed.insert(code.to_owned());
            }
        }
        if let Some(code) = row["expect"].get("error").and_then(|error| error["code"].as_str()) {
            thrown.insert(code.to_owned());
        }
    }
    (diagnosed, thrown)
}

#[test]
fn reports_every_code_of_the_engines_verdict_vocabulary_in_some_verdicts_json_row() {
    let (diagnosed, thrown) = reported_codes();
    let diagnostics: Vec<&str> = CEL_VERDICT_CODES
        .diagnostics
        .iter()
        .filter(|code| !UNREACHABLE_DIAGNOSTICS.contains(code))
        .map(|code| code.as_str())
        .filter(|code| !diagnosed.contains(*code))
        .collect();
    let errors: Vec<&str> =
        CEL_VERDICT_CODES.errors.iter().map(|code| code.as_str()).filter(|code| !thrown.contains(*code)).collect();
    assert_eq!((diagnostics, errors), (Vec::<&str>::new(), Vec::<&str>::new()));
}

/// The exemption earns its place only while it is true, and names only declared codes.
#[test]
fn exempts_only_declared_codes_no_verdicts_json_row_reports() {
    let (diagnosed, _) = reported_codes();
    for code in UNREACHABLE_DIAGNOSTICS {
        assert!(!diagnosed.contains(code.as_str()), "{} is reported, so it is reachable", code.as_str());
        assert!(CEL_VERDICT_CODES.diagnostics.contains(&code), "{} is not in the vocabulary", code.as_str());
    }
}
