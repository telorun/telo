//! The CEL conformance vectors' tag layer (`templating/cel-conformance/README.md`) — the
//! twin of `templating/nodejs/tests/cel-conformance.test.ts` and of
//! `cel-conformance-dialect.test.ts`.
//!
//! **Every dialect file is the tag engines' whole answer.** `catalog.json`, `types.json`,
//! `holes.json`, `module-calls.json` and `verdicts.json` are driven here, every row through the
//! engine of the tag it names (`cel`, `interpolate`, `sql`) and deep-compared with its `expect`,
//! each file's row count pinned and every row executed — no list of rows answered otherwise.
//! `language.json` is the engine's, read here only for the file-set, surrogate and `celCode`
//! gates. Beside the rows run the vectors' own gates, each a function over rows with a negative
//! control showing it fires: the directory's files, the keys each file and row may carry, unique
//! ids, no unpaired surrogate, a handler handed a value the typed frame refuses making its row
//! malformed, every value in canonical order, the input gate over `catalog.json` and
//! `types.json`, the `celCode` gate over all six files, the verdict vocabulary each code of
//! which some row reports (and none of the exempt ones does), the nominal brands and value
//! types with members some `types.json` row declares, and the coverage gates over
//! `catalog.json` (every overload dispatched, every literal guard fired, every RE2 error kind
//! pinned).
//!
//! Its blind spot: deep equality pins whatever the engines answered.

mod support;

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use support::cel_conformance_dialect::{
    catalog_overloads, conformance_environment, conformance_handlers, dispatch_tracing_environment,
    evaluate_dialect_row, run_dialect_row, with_conformance_conversions, DIALECT_TAGS,
};
use support::cel_conformance_value::decode;
use telo_templating::{CelDiagnosticCode, CEL_VERDICT_CODES};
use telorun_cel::{
    catalog_guarded_names, CelEngineErrorCode, CelEnvironment, FunctionMetadata, CEL_CHECK_CODES,
    RE2_PATTERN_ERROR_KINDS,
};
use telorun_cel_value::CEL_EVALUATION_CODES;
use telorun_sdk_core::value_type::{cel_type_of_value_type, value_brand_bases, value_types_in_order};

/// The dialect files: every row of each is answered here, with the rows each holds.
const DRIVEN_FILES: [(&str, usize); 5] =
    [("catalog.json", 195), ("types.json", 74), ("holes.json", 97), ("module-calls.json", 53), ("verdicts.json", 112)];
/// The engine's own file; read here only for the file-set, surrogate and `celCode` gates.
const LANGUAGE_FILE: &str = "language.json";
/// The two files the engine's projection also answers, which hold no tag-only site input.
const ENGINE_PROJECTED_FILES: [&str; 2] = ["catalog.json", "types.json"];
/// What a `catalog.json` or `types.json` row may not carry: an input only a tag site has.
const TAG_SITE_INPUTS: [&str; 6] = ["context", "explain", "rootsDeclared", "couldNameModule", "modules", "functions"];
const ERROR_KEYS: [&str; 3] = ["code", "celCode", "message"];
/// An evaluation code no row can reach: evaluation is synchronous, so no thenable reaches it.
const UNREACHABLE_EVALUATION_CODES: [&str; 1] = ["async_value_unsupported"];
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

fn driven_names() -> Vec<&'static str> {
    DRIVEN_FILES.iter().map(|(name, _)| *name).collect()
}

fn rows(file: &Value) -> &Vec<Value> {
    file["rows"].as_array().expect("a vector file holds rows")
}

/// The names in `files` that the directory should not hold, and those it lacks.
fn file_set_defects(files: &[String]) -> Vec<String> {
    let expected: HashSet<&str> = DRIVEN_FILES.iter().map(|(name, _)| *name).chain([LANGUAGE_FILE]).collect();
    let held: HashSet<&str> = files.iter().map(String::as_str).collect();
    let mut defects: Vec<String> = held.difference(&expected).map(|name| format!("unexpected file {name}")).collect();
    defects.extend(expected.difference(&held).map(|name| format!("missing file {name}")));
    defects.sort();
    defects
}

#[test]
fn accounts_for_every_file_in_the_directory() {
    let files: Vec<String> = std::fs::read_dir(directory())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != "README.md")
        .collect();
    assert_eq!(file_set_defects(&files), Vec::<String>::new());
}

#[test]
fn the_file_set_gate_fires_on_a_stray_and_on_a_missing_file() {
    let mut files: Vec<String> = DRIVEN_FILES.iter().map(|(name, _)| name.to_string()).chain([LANGUAGE_FILE.to_string()]).collect();
    assert!(file_set_defects(&files).is_empty());
    files.retain(|name| name != "types.json");
    files.push("extra.json".into());
    assert_eq!(file_set_defects(&files), ["missing file types.json", "unexpected file extra.json"]);
}

/// A string with an unpaired surrogate is outside the value domain. A Rust string holds
/// none, so such a file fails to read: written raw it is not UTF-8, and written as an
/// escape the JSON reader refuses it.
#[test]
fn holds_no_string_with_an_unpaired_surrogate_in_any_file() {
    for name in driven_names().into_iter().chain([LANGUAGE_FILE]) {
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

/// What makes a dialect file ill-formed: its keys, its rows' keys and required members, tags,
/// repeated ids and module tables.
fn file_defects(file: &Value) -> Vec<String> {
    let mut defects = Vec::new();
    let keys: Vec<&String> = file.as_object().unwrap().keys().collect();
    if keys != ["rows"] {
        defects.push(format!("the file carries {keys:?}, not just rows"));
    }
    let mut ids = HashSet::new();
    for row in rows(file) {
        let id = row["id"].as_str().unwrap_or("?");
        let object = row.as_object().unwrap();
        for key in object.keys().filter(|key| !DIALECT_ROW_KEYS.contains(&key.as_str())) {
            defects.push(format!("row {id} carries unknown key {key}"));
        }
        for key in ["id", "tag", "source", "expect"] {
            if !object.contains_key(key) {
                defects.push(format!("row {id} has no {key}"));
            }
        }
        if !DIALECT_TAGS.contains(&row["tag"].as_str().unwrap_or("")) {
            defects.push(format!("row {id} names the tag {}", row["tag"]));
        }
        if !ids.insert(id.to_owned()) {
            defects.push(format!("row id {id} repeats"));
        }
        let Some(modules) = row.get("modules").and_then(Value::as_object) else { continue };
        if !modules.keys().all(|key| key == "names" || key == "functions") {
            defects.push(format!("row {id} has a modules key besides names and functions"));
        }
        if !modules.get("names").and_then(Value::as_array).is_some_and(|names| !names.is_empty()) {
            defects.push(format!("row {id} names no module"));
        }
        for (qualified, function) in modules.get("functions").and_then(Value::as_object).into_iter().flatten() {
            let at = format!("{id}: {qualified}");
            let function = function.as_object().unwrap();
            for key in function.keys().filter(|key| !MODULE_FUNCTION_KEYS.contains(&key.as_str())) {
                defects.push(format!("{at} carries unknown key {key}"));
            }
            for key in ["returns", "deterministic", "hostBacked"] {
                if !function.contains_key(key) {
                    defects.push(format!("{at} has no {key}"));
                }
            }
            if function.contains_key("result") == function.contains_key("error") {
                defects.push(format!("{at} scripts exactly one of a result and an error"));
            }
        }
    }
    defects
}

#[test]
fn reads_well_formed_dialect_files() {
    for name in driven_names() {
        assert_eq!(file_defects(&read_file(name)), Vec::<String>::new(), "{name}");
    }
}

#[test]
fn the_well_formedness_gate_fires_on_each_defect() {
    let file = serde_json::json!({
        "rows": [
            { "id": "a", "tag": "cel", "source": "1", "expect": {}, "extra": 1 },
            { "id": "a", "tag": "sql", "source": "1" },
            { "id": "b", "tag": "regex", "source": "1", "expect": {}, "modules": { "names": [], "functions": { "M.f": { "returns": "int" } } } },
        ],
        "other": 1,
    });
    let defects = file_defects(&file);
    for expected in [
        "the file carries",
        "row a carries unknown key extra",
        "row a has no expect",
        "row id a repeats",
        "row b names the tag \"regex\"",
        "row b names no module",
        "b: M.f has no deterministic",
        "b: M.f has no hostBacked",
        "b: M.f scripts exactly one of a result and an error",
    ] {
        assert!(defects.iter().any(|defect| defect.starts_with(expected)), "{expected}: {defects:?}");
    }
}

/// Every row of a file deep-equals its `expect`; answers every row before failing, and
/// asserts the file holds exactly `count` rows, all executed.
fn drive_rows(name: &str, count: usize) {
    let env = conformance_environment();
    let file = read_file(name);
    let mut executed = 0;
    let mut failures = Vec::new();
    for row in rows(&file) {
        executed += 1;
        let id = row["id"].as_str().unwrap();
        match run_dialect_row(&env, row) {
            Ok(answer) if answer == row["expect"] => {}
            Ok(answer) => failures.push(format!("{id}\n  expected {}\n  answered {answer}", row["expect"])),
            Err(malformed) => failures.push(format!("{id}: {malformed}")),
        }
    }
    assert!(failures.is_empty(), "{} of {executed} rows differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(count_defects(rows(&file).len(), executed, count), Vec::<String>::new(), "{name}");
}

/// A file holding another number of rows than pinned, or a row left unexecuted.
fn count_defects(held: usize, executed: usize, pinned: usize) -> Vec<String> {
    let mut defects = Vec::new();
    if held != pinned {
        defects.push(format!("holds {held} rows, not the {pinned} pinned"));
    }
    if executed != held {
        defects.push(format!("executed {executed} of {held} rows"));
    }
    defects
}

#[test]
fn the_row_count_gate_fires_on_a_dropped_row_and_on_an_unexecuted_one() {
    assert!(count_defects(97, 97, 97).is_empty());
    assert_eq!(count_defects(96, 96, 97), ["holds 96 rows, not the 97 pinned"]);
    assert_eq!(count_defects(97, 96, 97), ["executed 96 of 97 rows"]);
}

#[test]
fn answers_every_row_of_every_dialect_file() {
    for (name, count) in DRIVEN_FILES {
        drive_rows(name, count);
    }
}

#[test]
fn drives_each_tag_through_its_own_engine() {
    let env = conformance_environment();
    let tag = |tag: &str, source: &str| {
        let row = serde_json::json!({ "id": "scratch/engine", "tag": tag, "source": source, "bindings": { "x": "v" }, "expect": {} });
        run_dialect_row(&env, &row).unwrap()
    };
    assert_eq!(tag("cel", "x")["value"], "v");
    assert_eq!(tag("interpolate", "a ${{ x }}")["value"], "a v");
    assert_eq!(tag("sql", "a ${{ x }}")["value"]["__teloParameterized"], true);
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
    let env = conformance_environment();
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
            std::thread::spawn(move || run_dialect_row(&conformance_environment(), &row(source)).is_ok())
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

/// The registered types no row declares a variable of.
fn undeclared<'r>(registered: &'r [String], rows: &[Value]) -> Vec<&'r String> {
    let mut declared = HashSet::new();
    for row in rows {
        for declaration in row.get("declarations").and_then(Value::as_object).into_iter().flat_map(|held| held.values()) {
            declared_types(declaration, &mut declared);
        }
    }
    registered.iter().filter(|name| !declared.contains(*name)).collect()
}

/// Every nominal brand, and every value type declaring members.
fn registered_types() -> Vec<String> {
    value_brand_bases()
        .into_iter()
        .map(|(brand, _)| brand.to_owned())
        .chain(value_types_in_order().filter(|entry| entry.members.is_some()).map(|entry| cel_type_of_value_type(entry).to_owned()))
        .collect()
}

#[test]
fn declares_a_variable_of_every_nominal_brand_and_every_type_with_members_in_some_types_json_row() {
    let file = read_file("types.json");
    let registered = registered_types();
    assert!(undeclared(&registered, rows(&file)).is_empty(), "{:?}", undeclared(&registered, rows(&file)));
}

#[test]
fn the_brand_gate_fires_for_a_type_no_row_declares() {
    let registered = registered_types();
    assert!(registered.iter().any(|name| name == "Telo.HostPath") && registered.iter().any(|name| name == "Telo.Url"));
    let row = serde_json::json!({ "declarations": { "path": "Telo.HostPath", "link": { "fields": { "target": "Telo.Url" } } } });
    let missing = undeclared(&registered, std::slice::from_ref(&row));
    assert!(!missing.iter().any(|name| *name == "Telo.HostPath" || *name == "Telo.Url"));
    assert!(!missing.is_empty());
    assert_eq!(undeclared(&registered, &[]).len(), registered.len());
}

/// The codes `rows` report: a diagnostic's `code`, and an error's.
fn reported_codes(rows: &[Value]) -> (HashSet<String>, HashSet<String>) {
    let mut diagnosed = HashSet::new();
    let mut thrown = HashSet::new();
    for row in rows {
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

/// The vocabulary's codes no row reports, the exempt ones excepted.
fn unreported_codes(rows: &[Value]) -> (Vec<&'static str>, Vec<&'static str>) {
    let (diagnosed, thrown) = reported_codes(rows);
    let diagnostics = CEL_VERDICT_CODES
        .diagnostics
        .iter()
        .filter(|code| !UNREACHABLE_DIAGNOSTICS.contains(code))
        .map(|code| code.as_str())
        .filter(|code| !diagnosed.contains(*code))
        .collect();
    let errors = CEL_VERDICT_CODES.errors.iter().map(|code| code.as_str()).filter(|code| !thrown.contains(*code)).collect();
    (diagnostics, errors)
}

/// The exempt codes some row reports, and the exempt codes the vocabulary does not hold.
fn misplaced_exemptions(rows: &[Value]) -> Vec<String> {
    let (diagnosed, _) = reported_codes(rows);
    let mut misplaced = Vec::new();
    for code in UNREACHABLE_DIAGNOSTICS {
        if diagnosed.contains(code.as_str()) {
            misplaced.push(format!("{} is reported, so it is reachable", code.as_str()));
        }
        if !CEL_VERDICT_CODES.diagnostics.contains(&code) {
            misplaced.push(format!("{} is not in the vocabulary", code.as_str()));
        }
    }
    misplaced
}

#[test]
fn reports_every_code_of_the_engines_verdict_vocabulary_in_some_verdicts_json_row() {
    let file = read_file("verdicts.json");
    assert_eq!(unreported_codes(rows(&file)), (Vec::<&str>::new(), Vec::<&str>::new()));
}

/// The exemption earns its place only while it is true, and names only declared codes.
#[test]
fn exempts_only_declared_codes_no_verdicts_json_row_reports() {
    let file = read_file("verdicts.json");
    assert_eq!(misplaced_exemptions(rows(&file)), Vec::<String>::new());
}

#[test]
fn the_verdict_gates_fire() {
    // No rows: every code that is not exempt is unreported.
    let (diagnostics, errors) = unreported_codes(&[]);
    assert_eq!(diagnostics.len(), CEL_VERDICT_CODES.diagnostics.len() - UNREACHABLE_DIAGNOSTICS.len());
    assert_eq!(errors, ["ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE"]);
    // A row reporting one code removes only that code from the list.
    let reporting = serde_json::json!({ "expect": { "check": { "diagnostics": [{ "code": "CEL_SYNTAX_ERROR" }] }, "error": { "code": "ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE" } } });
    let (diagnostics, errors) = unreported_codes(std::slice::from_ref(&reporting));
    assert!(!diagnostics.contains(&"CEL_SYNTAX_ERROR") && diagnostics.contains(&"CEL_TYPE_ERROR"));
    assert!(errors.is_empty());
    // A row reporting an exempt code is refused.
    let exempt = serde_json::json!({ "expect": { "check": { "diagnostics": [{ "code": "FUNCTION_UNRESOLVED" }] } } });
    assert_eq!(misplaced_exemptions(std::slice::from_ref(&exempt)), ["FUNCTION_UNRESOLVED is reported, so it is reachable"]);
}

/// Every value position of a row — its bindings, its module functions' results, the value it
/// expects and the arguments it expects a function to be dispatched with — that is not the
/// canonical writing of the value it reads. `expect` is compared without key order, so this is
/// what holds the file to one writing.
fn non_canonical_values(row: &Value) -> Vec<String> {
    let id = row["id"].as_str().unwrap_or("?");
    let mut positions: Vec<(String, &Value)> = Vec::new();
    for (name, value) in row.get("bindings").and_then(Value::as_object).into_iter().flatten() {
        positions.push((format!("bindings.{name}"), value));
    }
    for (name, function) in row["modules"].get("functions").and_then(Value::as_object).into_iter().flatten() {
        if let Some(result) = function.get("result") {
            positions.push((format!("modules.functions.{name}.result"), result));
        }
    }
    if let Some(value) = row["expect"].get("value") {
        positions.push(("expect.value".into(), value));
    }
    for (index, call) in row["expect"].get("dispatched").and_then(Value::as_array).into_iter().flatten().enumerate() {
        for (at, argument) in call["arguments"].as_array().into_iter().flatten().enumerate() {
            positions.push((format!("expect.dispatched[{index}].arguments[{at}]"), argument));
        }
    }
    positions
        .into_iter()
        .filter_map(|(at, node)| decode(node).err().map(|refusal| format!("{id}: {at}: {refusal}")))
        .collect()
}

#[test]
fn writes_every_value_of_every_row_in_canonical_order() {
    let mut refused = Vec::new();
    for name in driven_names() {
        for row in rows(&read_file(name)) {
            refused.extend(non_canonical_values(row));
        }
    }
    assert!(refused.is_empty(), "{}", refused.join("\n"));
}

#[test]
fn the_canonical_order_gate_fires_on_a_misordered_value() {
    let row = |value: Value| serde_json::json!({ "id": "scratch/order", "expect": { "value": value } });
    assert!(non_canonical_values(&row(serde_json::json!({ "a": "x", "b": "y" }))).is_empty());
    let refused = non_canonical_values(&row(serde_json::json!({ "b": "y", "a": "x" })));
    assert_eq!(refused.len(), 1);
    assert!(refused[0].starts_with("scratch/order: expect.value: Cannot read a conformance value"), "{refused:?}");
    let dispatched = serde_json::json!({ "id": "scratch/order", "expect": { "dispatched": [{ "name": "M.f", "arguments": [{ "b": "y", "a": "x" }] }] } });
    assert_eq!(non_canonical_values(&dispatched).len(), 1);
}

/// Rows whose recorded error is not exactly `{ code, celCode, message }`.
fn malformed_errors(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter_map(|row| {
            let error = row["expect"].get("error")?.as_object()?;
            let held: Vec<&str> = error.keys().map(String::as_str).collect();
            (held.len() != ERROR_KEYS.len() || ERROR_KEYS.iter().any(|key| !held.contains(key)))
                .then(|| row["id"].as_str().unwrap_or("?").to_owned())
        })
        .collect()
}

#[test]
fn records_every_error_of_every_dialect_file_as_code_celcode_and_message() {
    for name in driven_names() {
        assert_eq!(malformed_errors(rows(&read_file(name))), Vec::<String>::new(), "{name}");
    }
    let bad = serde_json::json!([{ "id": "scratch/error", "expect": { "error": { "code": null, "message": "x" } } }]);
    assert_eq!(malformed_errors(bad.as_array().unwrap()), ["scratch/error"]);
}

/// Why a `catalog.json` or `types.json` row is not an engine's question; nothing when it is.
fn engine_input_problems(env: &CelEnvironment, row: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    if row["tag"].as_str() != Some("cel") {
        problems.push(format!("names the tag {}; these files ask the cel engine alone", row["tag"]));
    }
    for key in TAG_SITE_INPUTS {
        if row.get(key).is_some() {
            problems.push(format!("carries `{key}`"));
        }
    }
    if let Some(diagnostic) = env.parse(row["source"].as_str().unwrap_or("")).diagnostic {
        problems.push(format!("does not read: {}", diagnostic.message));
    }
    if let Some(error) = row["expect"].get("error") {
        if !error["code"].is_null() || !error["celCode"].is_string() {
            problems.push(format!("records an error that is not the engine's: {error}"));
        }
    }
    problems
}

#[test]
fn holds_catalog_and_types_to_questions_the_engine_alone_answers() {
    let env = conformance_environment();
    for name in ENGINE_PROJECTED_FILES {
        let refused: Vec<String> = rows(&read_file(name))
            .iter()
            .flat_map(|row| {
                engine_input_problems(&env, row).into_iter().map(|problem| format!("{}: {problem}", row["id"]))
            })
            .collect();
        assert_eq!(refused, Vec::<String>::new(), "{name}");
    }
}

#[test]
fn the_input_gate_refuses_another_tag_a_tag_site_input_an_unreadable_source_and_a_foreign_error() {
    let row = serde_json::json!({
        "id": "scratch/input",
        "tag": "interpolate",
        "source": "s.text +",
        "context": {},
        "expect": { "check": { "diagnostics": [] }, "error": { "code": "ERR_X", "celCode": null, "message": "x" } },
    });
    let problems = engine_input_problems(&conformance_environment(), &row);
    assert_eq!(problems.len(), 4, "{problems:?}");
    assert_eq!(problems[0], "names the tag \"interpolate\"; these files ask the cel engine alone");
    assert_eq!(problems[1], "carries `context`");
    assert!(problems[2].starts_with("does not read: "), "{problems:?}");
    assert!(problems[3].starts_with("records an error that is not the engine's: "), "{problems:?}");
}

fn function_listing(env: &CelEnvironment) -> Vec<String> {
    env.definitions().functions.iter().map(|definition| format!("{definition:?}")).collect()
}

/// What differs between two listings, each registration named by its signature.
fn listing_defects(left: &[String], right: &[String]) -> Vec<String> {
    let mut defects = Vec::new();
    for entry in left.iter().filter(|entry| !right.contains(entry)) {
        defects.push(format!("only in the first: {entry}"));
    }
    for entry in right.iter().filter(|entry| !left.contains(entry)) {
        defects.push(format!("only in the second: {entry}"));
    }
    if defects.is_empty() && left != right {
        defects.push("the same registrations in another order".into());
    }
    defects
}

fn tracing_environment(dispatched: Arc<Mutex<Vec<String>>>) -> CelEnvironment {
    with_conformance_conversions(dispatch_tracing_environment(&conformance_handlers(), dispatched))
}

#[test]
fn drives_the_dispatch_tracing_environment_exactly_as_the_dialect_environment_registers() {
    let tracing = tracing_environment(Arc::default());
    assert_eq!(listing_defects(&function_listing(&tracing), &function_listing(&conformance_environment())), Vec::<String>::new());
}

#[test]
fn the_listing_gate_fires_on_an_extra_registered_signature() {
    let mut tracing = tracing_environment(Arc::default());
    tracing.register_function("scratchExtra(int): int", FunctionMetadata::default()).unwrap();
    let defects = listing_defects(&function_listing(&tracing), &function_listing(&conformance_environment()));
    assert_eq!(defects.len(), 1, "{defects:?}");
    assert!(defects[0].starts_with("only in the first: ") && defects[0].contains("scratchExtra(int): int"), "{defects:?}");
}

/// The overloads each row that evaluates to a value dispatches, by row id.
fn dispatch_by_row(rows: &[Value]) -> Vec<(String, Vec<String>)> {
    let dispatched: Arc<Mutex<Vec<String>>> = Arc::default();
    let env = tracing_environment(Arc::clone(&dispatched));
    let mut out = Vec::new();
    for row in rows {
        if row["expect"].get("value").is_none() {
            continue;
        }
        dispatched.lock().unwrap().clear();
        evaluate_dialect_row(&env, row).unwrap_or_else(|refusal| panic!("{refusal}"));
        out.push((row["id"].as_str().unwrap().to_owned(), dispatched.lock().unwrap().clone()));
    }
    out
}

/// The catalog overloads no row evaluating to a value dispatches.
fn undispatched(by_row: &[(String, Vec<String>)]) -> Vec<String> {
    let seen: HashSet<&String> = by_row.iter().flat_map(|(_, signatures)| signatures).collect();
    catalog_overloads().into_iter().map(|(_, signature)| signature).filter(|signature| !seen.contains(signature)).collect()
}

#[test]
fn evaluates_every_catalog_overload_in_some_catalog_json_row() {
    let by_row = dispatch_by_row(rows(&read_file("catalog.json")));
    assert_eq!(undispatched(&by_row), Vec::<String>::new());
}

#[test]
fn the_dispatch_gate_fires_for_an_overload_whose_only_row_is_removed() {
    let by_row = dispatch_by_row(rows(&read_file("catalog.json")));
    let sole = by_row
        .iter()
        .flat_map(|(_, signatures)| signatures.iter().collect::<BTreeSet<_>>())
        .find(|signature| by_row.iter().filter(|(_, held)| held.contains(signature)).count() == 1)
        .expect("some overload has exactly one row")
        .clone();
    let without: Vec<(String, Vec<String>)> = by_row.into_iter().filter(|(_, held)| !held.contains(&sole)).collect();
    assert!(undispatched(&without).contains(&sole), "{sole}");
    assert_eq!(undispatched(&[]).len(), catalog_overloads().len());
}

/// The names a diagnostic of `CEL_INVALID_ARGUMENT` refuses a literal of, as its message says them.
fn fired_guards(rows: &[Value]) -> HashSet<String> {
    let mut fired = HashSet::new();
    for row in rows {
        for diagnostic in row["expect"]["check"]["diagnostics"].as_array().into_iter().flatten() {
            if diagnostic["code"].as_str() != Some("CEL_INVALID_ARGUMENT") {
                continue;
            }
            let message = diagnostic["message"].as_str().unwrap_or("");
            for (at, _) in message.match_indices(" (in `") {
                let rest = &message[at + " (in `".len()..];
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
                if valid && rest[name.len()..].starts_with('(') {
                    fired.insert(name);
                    break;
                }
            }
        }
    }
    fired
}

fn unfired_guards(rows: &[Value]) -> Vec<&'static str> {
    let fired = fired_guards(rows);
    catalog_guarded_names().into_iter().filter(|name| !fired.contains(*name)).collect()
}

#[test]
fn fires_every_catalog_literal_guard_statically_in_some_catalog_json_row() {
    assert_eq!(unfired_guards(rows(&read_file("catalog.json"))), Vec::<&str>::new());
}

#[test]
fn the_guard_gate_fires_for_a_guarded_name_no_row_fires() {
    let all = catalog_guarded_names();
    assert!(!all.is_empty());
    assert_eq!(unfired_guards(&[]), all);
    let file = read_file("catalog.json");
    let name = fired_guards(rows(&file)).into_iter().next().expect("some row fires a guard");
    let without: Vec<Value> = rows(&file)
        .iter()
        .filter(|row| !fired_guards(std::slice::from_ref(row)).contains(&name))
        .cloned()
        .collect();
    assert_eq!(unfired_guards(&without), [all.iter().copied().find(|held| *held == name).unwrap()]);
}

/// The RE2 parse-error kind a row's refusal ends with, when its message is one.
fn re2_kind_of(message: &str) -> Option<&str> {
    let rest = message.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    let rest = rest.strip_prefix(": invalid RE2 pattern \"")?;
    let at = rest.rfind("\": ")?;
    let kind = &rest[at + 3..];
    (!kind.is_empty() && !kind.contains(['"', ':'])).then_some(kind)
}

fn unpinned_kinds(rows: &[Value]) -> Vec<&'static str> {
    let pinned: HashSet<&str> =
        rows.iter().filter_map(|row| re2_kind_of(row["expect"].get("error")?["message"].as_str()?)).collect();
    RE2_PATTERN_ERROR_KINDS.iter().map(|kind| kind.as_str()).filter(|kind| !pinned.contains(kind)).collect()
}

#[test]
fn pins_every_re2_parse_error_kind_in_some_catalog_json_row() {
    assert_eq!(unpinned_kinds(rows(&read_file("catalog.json"))), Vec::<&str>::new());
}

#[test]
fn the_kind_gate_fires_for_a_kind_no_row_pins() {
    assert_eq!(unpinned_kinds(&[]).len(), RE2_PATTERN_ERROR_KINDS.len());
    let row = serde_json::json!({ "expect": { "error": { "message": "regexMatch: invalid RE2 pattern \"(\": missing closing )" } } });
    let missing = unpinned_kinds(std::slice::from_ref(&row));
    assert_eq!(missing.len(), RE2_PATTERN_ERROR_KINDS.len() - 1);
    assert!(!missing.contains(&"missing closing )"));
}

/// Every engine-error code, held complete by its type.
fn engine_error_codes() -> Vec<&'static str> {
    fn exhaustive(code: CelEngineErrorCode) -> usize {
        match code {
            CelEngineErrorCode::NamespacesMismatch => 0,
            CelEngineErrorCode::UnreadableExpression => 1,
            CelEngineErrorCode::EmittedModuleRejected => 2,
            CelEngineErrorCode::SignatureTooWide => 3,
        }
    }
    let all = [
        CelEngineErrorCode::NamespacesMismatch,
        CelEngineErrorCode::UnreadableExpression,
        CelEngineErrorCode::EmittedModuleRejected,
        CelEngineErrorCode::SignatureTooWide,
    ];
    assert!(all.iter().enumerate().all(|(at, code)| exhaustive(*code) == at));
    all.iter().map(|code| code.as_str()).collect()
}

struct CelCodeFile {
    name: String,
    language: bool,
    rows: Vec<Value>,
}

/// Why the errors of a set of rows break the `celCode` rule, and the codes they record.
fn cel_code_problems(files: &[CelCodeFile]) -> (Vec<String>, HashSet<String>) {
    let mut allowed: HashSet<String> = CEL_EVALUATION_CODES.iter().map(|code| code.as_str().to_owned()).collect();
    allowed.extend(engine_error_codes().into_iter().map(str::to_owned));
    let check_codes: HashSet<&str> =
        CEL_CHECK_CODES.iter().map(|code| code.as_str()).filter(|code| code.starts_with("CEL_")).collect();
    let mut problems = Vec::new();
    let mut recorded = HashSet::new();
    for file in files {
        for row in &file.rows {
            let Some(error) = row["expect"].get("error") else { continue };
            let at = format!("{} {}", file.name, row["id"].as_str().unwrap_or("?"));
            let code = error.get("code").filter(|code| !code.is_null());
            let cel_code = error.get("celCode").and_then(Value::as_str);
            if code.is_some() && cel_code.is_some() {
                problems.push(format!("{at}: records both a code and a celCode"));
            }
            let Some(cel_code) = cel_code else { continue };
            recorded.insert(cel_code.to_owned());
            if !allowed.contains(cel_code) && !(file.language && check_codes.contains(cel_code)) {
                problems.push(format!("{at}: records the celCode {cel_code:?}, outside the vocabulary"));
            }
            if UNREACHABLE_EVALUATION_CODES.contains(&cel_code) {
                problems.push(format!("{at}: records {cel_code}, which is held unreachable"));
            }
        }
    }
    for code in CEL_EVALUATION_CODES.iter().map(|code| code.as_str()) {
        if !UNREACHABLE_EVALUATION_CODES.contains(&code) && !recorded.contains(code) {
            problems.push(format!("no row records the evaluation code {code}"));
        }
    }
    (problems, recorded)
}

fn cel_code_files() -> Vec<CelCodeFile> {
    driven_names()
        .into_iter()
        .map(|name| CelCodeFile { name: name.into(), language: false, rows: rows(&read_file(name)).clone() })
        .chain([CelCodeFile { name: LANGUAGE_FILE.into(), language: true, rows: rows(&read_file(LANGUAGE_FILE)).clone() }])
        .collect()
}

#[test]
fn records_every_evaluation_code_as_some_rows_celcode_and_only_codes_of_the_vocabulary() {
    assert_eq!(cel_code_problems(&cel_code_files()).0, Vec::<String>::new());
}

#[test]
fn fails_the_celcode_gate_on_a_code_no_row_records_an_unreachable_one_a_stray_one_and_both_codes() {
    let files = cel_code_files();
    let (_, recorded) = cel_code_problems(&files);
    assert!(recorded.contains("unbound_function"));
    let without: Vec<CelCodeFile> = files
        .iter()
        .map(|file| CelCodeFile {
            name: file.name.clone(),
            language: file.language,
            rows: file.rows.iter().filter(|row| row["expect"]["error"]["celCode"] != "unbound_function").cloned().collect(),
        })
        .collect();
    assert_eq!(cel_code_problems(&without).0, ["no row records the evaluation code unbound_function"]);
    let row = |id: &str, code: Value, cel_code: Value| {
        serde_json::json!({ "id": id, "expect": { "error": { "code": code, "celCode": cel_code, "message": "x" } } })
    };
    let mut added = cel_code_files();
    added.push(CelCodeFile {
        name: "scratch.json".into(),
        language: false,
        rows: vec![
            row("scratch/async", Value::Null, "async_value_unsupported".into()),
            row("scratch/stray", Value::Null, "CEL_TYPE_ERROR".into()),
            row("scratch/both", "ERR_X".into(), "no_such_key".into()),
        ],
    });
    assert_eq!(
        cel_code_problems(&added).0,
        [
            "scratch.json scratch/async: records async_value_unsupported, which is held unreachable",
            "scratch.json scratch/stray: records the celCode \"CEL_TYPE_ERROR\", outside the vocabulary",
            "scratch.json scratch/both: records both a code and a celCode",
        ]
    );
}

#[test]
fn a_wrong_expected_value_fails_naming_the_row() {
    let env = conformance_environment();
    let mut row = rows(&read_file("catalog.json")).iter().find(|row| row["expect"]["value"] == true).expect("a row evaluates to true").clone();
    assert_eq!(run_dialect_row(&env, &row).unwrap(), row["expect"]);
    let id = row["id"].as_str().unwrap().to_owned();
    row["expect"]["value"] = Value::Bool(false);
    assert_ne!(run_dialect_row(&env, &row).unwrap(), row["expect"], "{id}");
}
