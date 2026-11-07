//! The CEL conformance vectors' tag layer (`templating/cel-conformance/README.md`) — the
//! twin of `templating/nodejs/tests/cel-conformance.test.ts` and of
//! `cel-conformance-dialect.test.ts`.
//!
//! Every row of `holes.json`, `module-calls.json` and `verdicts.json` is driven through the
//! engine of the tag it names (`cel`, `interpolate`, `sql`) and deep-compared with its
//! `expect`, the file's row count pinned and every row executed. Beside them run the vectors'
//! own gates: the directory's files, the keys each file and row may carry, unique ids, no
//! unpaired surrogate, a handler handed a value the typed frame refuses making its row
//! malformed, every value in canonical order, the verdict vocabulary each code of which some
//! row reports (and none of the exempt ones does), and the nominal brands and value types with
//! members some `types.json` row declares. Each gate is a function over rows, and each has a
//! negative control showing it fires.
//!
//! Not run here: Node's catalog-dispatch, literal-guard and RE2-kind gates, which are the
//! engine's replay's to hold.

mod support;

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::Value;
use support::cel_conformance_dialect::{conformance_handlers, run_dialect_row, DIALECT_TAGS};
use support::cel_conformance_value::decode;
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

/// The names in `files` that the directory should not hold, and those it lacks.
fn file_set_defects(files: &[String]) -> Vec<String> {
    let expected: HashSet<&str> = DRIVEN_FILES.iter().chain(ENGINE_FILES.iter()).copied().collect();
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
    let mut files: Vec<String> = DRIVEN_FILES.iter().chain(ENGINE_FILES.iter()).map(|name| name.to_string()).collect();
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
    for name in DRIVEN_FILES {
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
    let env = build_cel_environment(conformance_handlers());
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
fn answers_every_row_of_holes_json() {
    drive_rows("holes.json", 97);
}

#[test]
fn answers_every_row_of_module_calls_json() {
    drive_rows("module-calls.json", 53);
}

#[test]
fn answers_every_row_of_verdicts_json() {
    drive_rows("verdicts.json", 111);
}

#[test]
fn drives_each_tag_through_its_own_engine() {
    let env = build_cel_environment(conformance_handlers());
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
    for name in DRIVEN_FILES {
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
