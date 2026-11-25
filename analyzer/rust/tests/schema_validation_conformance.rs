//! `analyzer/schema-validation-conformance/`: every row of every vector file, as this
//! crate's validator answers it — each configuration through the configuration factory,
//! the validator's view of the value and, where the configuration fills defaults, a value
//! type's default decoded first. The twin of
//! `analyzer/nodejs/tests/schema-validation-conformance.test.ts` (the `analysis*` rows)
//! and `kernel/nodejs/tests/schema-validation-conformance.test.ts` (the kernel rows).
//!
//! Every field of a row's `expect` is compared, `issues` through the judge on a verbose
//! twin of the row's instance, with the reporting backstop watched: a row that keeps a
//! union undecided fails. Blind spot: deep equality pins whatever Node answered when the
//! row was recorded; a row is a check against the JSON Schema test suite only where it
//! carries `deviation.suite`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use telo_analyzer::schema_findings_judge::watch_union_backstop;
use telo_analyzer::schema_validation::{
    judged_schema_issues, json_value_of, SchemaValidation, SchemaValidationConfiguration, SCHEMA_VALIDATION_CONFIGURATIONS,
};
use telo_analyzer::stand_in_findings::{StandIn, StandInClass, StandInIdentity, StandIns};
use telorun_cel::{read_json_text, JsonValue};
use telorun_cel_value::{CelList, CelRecord, CelValue};
use telorun_sdk_core::typed_frame::{decode_typed_frame, encode_typed_frame};

/// Every file's row count.
const FILES: [(&str, usize); 3] = [("draft7.json", 1840), ("telo.json", 195), ("unions.json", 31)];

const ROW_KEYS: [&str; 9] = ["id", "description", "configuration", "schema", "documents", "value", "standIns", "expect", "deviation"];
const EXPECT_KEYS: [&str; 5] = ["valid", "errors", "value", "compileError", "issues"];

fn vectors() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../schema-validation-conformance/vectors")
}

/// A JSON value read as JavaScript reads it, as serde holds one: every number a double.
fn serde_of(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Bool(*b),
        JsonValue::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
        JsonValue::String(s) => Value::String(s.clone()),
        JsonValue::Array(items) => Value::Array(items.iter().map(|item| serde_of(item)).collect()),
        JsonValue::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.to_string(), serde_of(v))).collect()),
    }
}

/// A row's value: plain containers as JSON reads them, a `$telo` object a typed frame.
fn decode(value: &JsonValue) -> CelValue {
    match value {
        JsonValue::Null => CelValue::Null,
        JsonValue::Bool(b) => CelValue::Bool(*b),
        JsonValue::Number(n) => CelValue::Double(*n),
        JsonValue::String(s) => CelValue::String(s.as_str().into()),
        JsonValue::Array(items) => CelValue::List(items.iter().map(|item| decode(item)).collect::<CelList>()),
        JsonValue::Object(map) if map.contains_key("$telo") => {
            decode_typed_frame(&serde_json::to_string(&serde_of(value)).unwrap()).expect("a typed frame the row writes")
        }
        JsonValue::Object(map) => {
            let mut record = CelRecord::new();
            for (key, item) in map.iter() {
                record.insert(key, decode(item));
            }
            CelValue::Record(record)
        }
    }
}

/// A value encoded as a row writes one.
fn encode(value: &CelValue) -> Value {
    match value {
        CelValue::List(items) => Value::Array(items.iter().map(encode).collect()),
        CelValue::Record(record) => Value::Object(record.iter().map(|(k, v)| (k.to_string(), encode(v))).collect()),
        other => serde_of(&read_json_text(&encode_typed_frame(other).expect("an encodable value")).unwrap()),
    }
}

/// Deep equality as `toEqual` reads two JSON values: numbers by value, members in any order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(l, r)| same(l, r)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn answer(row: &JsonValue) -> Value {
    let get = |key: &str| match row {
        JsonValue::Object(map) => map.get(key).cloned(),
        _ => None,
    };
    let configuration = match get("configuration").as_deref() {
        Some(JsonValue::String(name)) => SchemaValidationConfiguration::read(name).expect("a named configuration"),
        _ => panic!("a row names its configuration"),
    };
    let mut validation = SchemaValidation::new(configuration);
    if let Some(documents) = get("documents") {
        let JsonValue::Array(documents) = &*documents else { panic!("documents is a list") };
        for document in documents {
            let JsonValue::Object(document) = &**document else { panic!("a document is an object") };
            let Some(JsonValue::String(id)) = document.get("id").map(|i| &**i) else { panic!("a document has an id") };
            validation.add_schema(&serde_of(document.get("schema").expect("a document's schema")), id).expect("a document registers");
        }
    }
    let schema = json_value_of(&serde_of(&get("schema").expect("a row's schema")));
    let compiled = match validation.compile_json(schema.clone()) {
        Ok(compiled) => compiled,
        Err(message) => {
            return serde_json::json!({ "valid": null, "errors": null, "value": null, "compileError": message, "issues": null });
        }
    };
    let value = decode(&get("value").unwrap_or_else(|| Arc::new(JsonValue::Null)));
    let result = compiled.validate(&value).expect("a row nests within the bound");
    let errors: Vec<Value> = result
        .errors
        .iter()
        .map(|error| {
            serde_json::json!({
                "keyword": error.keyword,
                "instancePath": error.instance_path,
                "schemaPath": error.schema_path,
                "params": error.params,
                "message": error.message,
            })
        })
        .collect();
    let issues = match get("standIns") {
        None => Value::Null,
        Some(_) if result.valid => Value::Array(Vec::new()),
        Some(stand_ins) => {
            let issues = judged_schema_issues(&validation, &result.errors, &value, &schema, stand_ins_of(&serde_of(&stand_ins)))
                .expect("a row's judgement finishes");
            Value::Array(issues.into_iter().map(|issue| serde_json::json!({ "path": issue.path, "message": issue.message })).collect())
        }
    };
    serde_json::json!({ "valid": result.valid, "errors": errors, "value": encode(&result.value), "compileError": null, "issues": issues })
}

/// A row's stand-ins: each `{ class, identity? }` by JSON Pointer.
fn stand_ins_of(rows: &Value) -> StandIns {
    let mut out = StandIns::new();
    for (pointer, stand_in) in rows.as_object().expect("standIns is an object") {
        let class = match stand_in["class"].as_str() {
            Some("computed") => StandInClass::Computed,
            Some("produced") => StandInClass::Produced,
            other => panic!("a stand-in class, not {other:?}"),
        };
        let identity = stand_in.get("identity").map(|identity| {
            StandInIdentity::with_verdict(
                identity["tag"].as_str().expect("a tag"),
                identity["text"].as_str().expect("a text"),
                identity["repeatable"].as_bool().expect("a verdict"),
            )
        });
        out.insert(pointer.clone(), StandIn { class, identity });
    }
    out
}

#[test]
fn every_row_answers_as_node_recorded_it() {
    let mut failures: Vec<String> = Vec::new();
    for (file, count) in FILES {
        let text = std::fs::read_to_string(vectors().join(file)).expect("a vector file");
        let document = read_json_text(&text).expect("a vector file is JSON");
        let JsonValue::Object(top) = &*document else { panic!("{file} is an object") };
        let Some(JsonValue::Array(rows)) = top.get("rows").map(|r| &**r) else { panic!("{file} holds rows") };
        assert_eq!(rows.len(), count, "{file} holds its pinned rows");
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            let JsonValue::Object(fields) = &**row else { panic!("a row is an object") };
            let id = match fields.get("id").map(|i| &**i) {
                Some(JsonValue::String(id)) => id.clone(),
                _ => panic!("a row has an id"),
            };
            assert!(ids.insert(id.clone()), "{file}: {id} is unique");
            let unknown: Vec<&str> = fields.keys().filter(|k| !ROW_KEYS.contains(k)).collect();
            assert!(unknown.is_empty(), "{id}: unknown keys {unknown:?}");
            match fields.get("configuration").map(|c| &**c) {
                Some(JsonValue::String(name)) => assert!(SCHEMA_VALIDATION_CONFIGURATIONS.contains(&name.as_str()), "{id}: {name}"),
                _ => panic!("{id}: no configuration"),
            }
            let expect = serde_of(fields.get("expect").expect("a row's expect"));
            let mut keys: Vec<&str> = expect.as_object().expect("expect is an object").keys().map(String::as_str).collect();
            keys.sort();
            let mut wanted = EXPECT_KEYS.to_vec();
            wanted.sort();
            assert_eq!(keys, wanted, "{id}: expect's keys");
            if let Some(deviation) = fields.get("deviation") {
                let deviation = serde_of(deviation);
                assert_eq!(deviation.as_object().map(|d| d.keys().cloned().collect::<Vec<_>>()), Some(vec!["suite".to_string()]), "{id}");
                assert_ne!(deviation["suite"]["valid"], expect["valid"], "{id}: a deviation that agrees is dropped");
            }
            let wanted: Map<String, Value> = expect.as_object().unwrap().clone();
            let backstops = std::rc::Rc::new(std::cell::Cell::new(0));
            let counted = backstops.clone();
            let watch = watch_union_backstop(move |_| counted.set(counted.get() + 1));
            let got = answer(row);
            drop(watch);
            if backstops.get() > 0 {
                failures.push(format!("{file} {id}: a union was kept undecided {} time(s)", backstops.get()));
            }
            if !same(&got, &Value::Object(wanted.clone())) {
                failures.push(format!("{file} {id}\n  expected {}\n  answered {}", Value::Object(wanted), got));
            }
        }
    }
    assert!(failures.is_empty(), "{} rows differ:\n{}", failures.len(), failures.join("\n"));
}
