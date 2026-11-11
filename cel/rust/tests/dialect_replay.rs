//! Runs the conformance dialect files the engine alone answers — the function catalog and
//! the host's types — through the projection driver. The twin of
//! `cel/nodejs/conformance/dialect-replay.test.ts`, and of the host-type derivation in
//! `scripts/check-cel-conformance.mjs`.
//!
//! The vectors and the value types are read where they are, located from the crate's
//! manifest directory: plain `cargo test` needs no outside input, and a missing file fails.
//!
//! **The host types are derived here, from `sdk/value-types/*.json` read as data, by rule and
//! naming no type** but `Stream`: the driver takes them as a parameter and the engine knows
//! none. A `members`-bearing entry, a `fromHost` entry or a brand added to that directory
//! therefore reaches the rows that declare it with no edit here.
//!
//! Past the Node twin, negative controls built from rows held in memory show the gates fail
//! naming the row: a wrong expected value, an input-gate violation, a row declaring a type
//! the host types lack, and a file one row short of its pin.

mod conformance;

use std::path::PathBuf;

use serde_json::{json, Value};
use telorun_cel::{NominalTypeDefinition, PropertyMap};

use conformance::dialect_replay::{
    input_problems, dialect_environment, replay_dialect_rows, row_count_problem, unknown_declared_types, CATALOG_FILE,
    CATALOG_ROWS, TYPES_FILE, TYPES_ROWS,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_json(path: &PathBuf) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A JSON Schema type name as the CEL type a value of it is.
fn scalar_cel_type(name: &str) -> Option<&'static str> {
    match name {
        "string" => Some("string"),
        "integer" => Some("int"),
        "number" => Some("double"),
        "boolean" => Some("bool"),
        _ => None,
    }
}

/// A member's schema as the CEL type its field reads as: a scalar, a list's element, a map's value.
fn cel_type_of_schema(schema: &Value, at: &str) -> Result<String, String> {
    let kind = schema.get("type").and_then(Value::as_str);
    if kind == Some("array") {
        if let Some(items) = schema.get("items") {
            return Ok(format!("list<{}>", cel_type_of_schema(items, &format!("{at}/items"))?));
        }
    }
    if kind == Some("object") {
        if let Some(values) = schema.get("additionalProperties").filter(|values| values.is_object()) {
            return Ok(format!("map<string, {}>", cel_type_of_schema(values, &format!("{at}/additionalProperties"))?));
        }
    }
    kind.and_then(scalar_cel_type)
        .map(String::from)
        .ok_or_else(|| format!("{at}: no CEL type is derived for the schema {}", schema))
}

fn host_type_of(entry: &Value, file: &str) -> Result<Option<NominalTypeDefinition>, String> {
    let name = entry.get("name").and_then(Value::as_str).ok_or_else(|| format!("{file}: has no `name`"))?.to_string();
    if let Some(members) = entry.get("members").and_then(Value::as_object) {
        let mut fields = PropertyMap::new();
        for (member, schema) in members {
            fields.insert(member.clone(), cel_type_of_schema(schema, &format!("{file}#/members/{member}"))?);
        }
        return Ok(Some(NominalTypeDefinition {
            name,
            base: "dyn".into(),
            fields: Some(fields),
            conversions: vec!["string(Self): string".into()],
            ..NominalTypeDefinition::default()
        }));
    }
    if entry.get("representation").and_then(Value::as_str) != Some("json") || entry.get("celType").is_some() {
        return Ok(None);
    }
    let declared = entry.get("base");
    let base = declared
        .and_then(Value::as_str)
        .and_then(scalar_cel_type)
        .ok_or_else(|| format!("{file}#/base: no CEL type is derived for the base {}", declared.map(Value::to_string).unwrap_or_default()))?;
    let conversions = if base == "string" {
        vec!["string(Self): string".to_string()]
    } else {
        vec![format!("{base}(Self): {base}"), "string(Self): string".to_string()]
    };
    let members = if entry.get("fromHost").is_some() { vec!["Self.joinPath(string): Self".to_string()] } else { Vec::new() };
    Ok(Some(NominalTypeDefinition { name, base: base.into(), conversions, members, ..NominalTypeDefinition::default() }))
}

/// The host's types, by the rule `templating/cel-conformance/README.md` states.
fn derive_host_types(directory: &PathBuf) -> Result<Vec<NominalTypeDefinition>, String> {
    let mut files: Vec<String> = std::fs::read_dir(directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?
        .map(|entry| entry.expect("an entry reads").file_name().into_string().expect("a file name is text"))
        .filter(|name| name.ends_with(".json"))
        .collect();
    files.sort();
    let mut types = Vec::new();
    for file in files {
        types.extend(host_type_of(&read_json(&directory.join(&file)), &file)?);
    }
    types.push(NominalTypeDefinition { name: "Stream".into(), base: "dyn".into(), ..NominalTypeDefinition::default() });
    Ok(types)
}

fn host_types() -> Vec<NominalTypeDefinition> {
    derive_host_types(&root().join("sdk/value-types")).unwrap_or_else(|reason| panic!("{reason}"))
}

fn rows_of(file: &str) -> Vec<Value> {
    let held = read_json(&root().join("templating/cel-conformance").join(file));
    let object = held.as_object().expect("the file is an object");
    assert_eq!(object.keys().collect::<Vec<_>>(), ["rows"], "{file} carries only its rows");
    held["rows"].as_array().expect("rows is a list").clone()
}

#[test]
fn drives_every_row_of_each_file_through_the_projection() {
    let host = host_types();
    for (file, pinned) in [(CATALOG_FILE, CATALOG_ROWS), (TYPES_FILE, TYPES_ROWS)] {
        let rows = rows_of(file);
        assert_eq!(unknown_declared_types(&rows, &host), Vec::<String>::new(), "{file}: a type no host type accounts for");
        assert_eq!(row_count_problem(file, &rows), None);
        assert_eq!(rows.len(), pinned);
        let report = replay_dialect_rows(file, &rows, &host);
        assert_eq!(report.malformed, []);
        assert_eq!(report.inputs, []);
        assert_eq!(report.answers, []);
        assert_eq!(report.driven, rows.len());
        println!("{file}: rows {}, {} answered through the projection", report.rows, report.driven);
    }
}

#[test]
fn derives_the_host_types_from_the_value_type_entries() {
    let host = host_types();
    let named = |name: &str| host.iter().find(|definition| definition.name == name).unwrap_or_else(|| panic!("{name} is derived"));
    let port = named("Telo.TcpPort");
    assert_eq!((port.base.as_str(), port.conversions.as_slice()), ("int", ["int(Self): int".to_string(), "string(Self): string".to_string()].as_slice()));
    assert_eq!(named("Telo.HostPath").members, ["Self.joinPath(string): Self"]);
    assert!(named("Telo.Url").fields.as_ref().is_some_and(|fields| !fields.is_empty()));
    assert_eq!(named("Stream").base, "dyn");
    assert!(host.iter().all(|definition| definition.name != "Telo.Uint64"), "a celType entry is not a brand");
}

#[test]
fn a_schema_or_base_that_derives_no_cel_type_fails_naming_the_file_and_pointer() {
    let schema = json!({ "name": "Telo.X", "members": { "a": { "type": "null" } } });
    let refusal = host_type_of(&schema, "telo-x.json").unwrap_err();
    assert!(refusal.starts_with("telo-x.json#/members/a: "), "{refusal}");
    let nested = json!({ "name": "Telo.X", "members": { "a": { "type": "array", "items": { "type": "object" } } } });
    assert!(host_type_of(&nested, "telo-x.json").unwrap_err().starts_with("telo-x.json#/members/a/items: "));
    let brand = json!({ "name": "Telo.X", "representation": "json", "base": "object" });
    assert!(host_type_of(&brand, "telo-x.json").unwrap_err().starts_with("telo-x.json#/base: "));
}

#[test]
fn a_file_one_row_short_fails_the_pin() {
    for file in [CATALOG_FILE, TYPES_FILE] {
        assert!(row_count_problem(file, &rows_of(file)[1..]).is_some());
    }
}

#[test]
fn a_row_recording_a_wrong_value_fails_naming_the_row() {
    let host = host_types();
    let mut row = rows_of(CATALOG_FILE)
        .into_iter()
        .find(|row| row["expect"].get("value") == Some(&Value::Bool(true)))
        .expect("some row evaluates to true");
    row["expect"]["value"] = Value::Bool(false);
    let report = replay_dialect_rows(CATALOG_FILE, &[row.clone()], &host);
    assert_eq!(report.answers.iter().map(|failure| failure.id.as_str()).collect::<Vec<_>>(), [row["id"].as_str().unwrap()]);
    assert_eq!(report.malformed, []);
}

fn scratch(extra: Value, source: &str) -> Value {
    let mut row = json!({
        "id": "scratch/input",
        "tag": "cel",
        "source": source,
        "expect": { "check": { "diagnostics": [] }, "value": { "$telo": "int", "value": "1" } },
    });
    for (key, value) in extra.as_object().unwrap() {
        row[key] = value.clone();
    }
    row
}

#[test]
fn the_input_gate_refuses_a_row_naming_it() {
    let base = dialect_environment();
    assert_eq!(input_problems(&base, &scratch(json!({ "tag": "interpolate" }), "1")), ["names the tag \"interpolate\"; these files ask the cel engine alone"]);
    assert_eq!(input_problems(&base, &scratch(json!({ "context": {} }), "1")), ["carries `context`, an input only a tag site has"]);
    let unread = input_problems(&base, &scratch(json!({}), "1 +"));
    assert!(unread.len() == 1 && unread[0].starts_with("does not read: "), "{unread:?}");
    let coded = scratch(json!({ "expect": { "check": { "diagnostics": [] }, "error": { "code": "ERR_X", "celCode": null, "message": "x" } } }), "1");
    assert_eq!(input_problems(&base, &coded), ["records an error that is not the engine's own: {\"code\":\"ERR_X\",\"celCode\":null,\"message\":\"x\"}"]);
    assert_eq!(input_problems(&base, &scratch(json!({}), "1")), Vec::<String>::new());

    let report = replay_dialect_rows(CATALOG_FILE, &[scratch(json!({ "functions": [] }), "1")], &host_types());
    assert_eq!(report.inputs.iter().map(|failure| failure.id.as_str()).collect::<Vec<_>>(), ["scratch/input"]);
    assert_eq!(report.driven, 0);
}

#[test]
fn a_row_declaring_a_type_the_host_types_lack_is_named() {
    let host = host_types();
    let row = scratch(json!({ "declarations": { "a": "list<Telo.Nowhere>", "b": { "fields": { "c": "Telo.TcpPort" } } } }), "a");
    assert_eq!(unknown_declared_types(&[row], &host), ["Telo.Nowhere"]);
}
