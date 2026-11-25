//! `analyzer/schema-validation-conformance/`: every row of a kernel configuration
//! (`primary`, `filling`, `locating`, `schema-validate`), as this kernel's validator answers
//! it — the analyzer's configuration factory, the view the kernel validates a value through
//! (an int64 rendered as the double it is, an instance value opaque) and, where the
//! configuration fills defaults, a value type's default decoded first. The twin of
//! `kernel/nodejs/tests/schema-validation-conformance.test.ts`; the `analysis*` rows are
//! the analyzers' runners'.
//!
//! Blind spot: deep equality pins whatever Node answered when the row was recorded.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use telo_analyzer::schema_validation::{json_value_of, SchemaValidation, SchemaValidationConfiguration};
use telorun_cel::{read_json_text, JsonValue};
use telorun_cel_value::{CelList, CelRecord, CelValue};
use telorun_sdk_core::typed_frame::{decode_typed_frame, encode_typed_frame};

/// Every file's row count.
const FILES: [(&str, usize); 3] = [("draft7.json", 0), ("telo.json", 54), ("unions.json", 0)];

const KERNEL_CONFIGURATIONS: [&str; 4] = ["primary", "filling", "locating", "schema-validate"];


fn vectors() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../analyzer/schema-validation-conformance/vectors")
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
    serde_json::json!({ "valid": result.valid, "errors": errors, "value": encode(&result.value), "compileError": null, "issues": null })
}

#[test]
fn every_kernel_row_answers_as_node_recorded_it() {
    let mut failures: Vec<String> = Vec::new();
    for (file, count) in FILES {
        let text = std::fs::read_to_string(vectors().join(file)).expect("a vector file");
        let document = read_json_text(&text).expect("a vector file is JSON");
        let JsonValue::Object(top) = &*document else { panic!("{file} is an object") };
        let Some(JsonValue::Array(rows)) = top.get("rows").map(|r| &**r) else { panic!("{file} holds rows") };
        let mine: Vec<_> = rows
            .iter()
            .filter(|row| matches!(&***row, JsonValue::Object(fields) if matches!(fields.get("configuration").map(|c| &**c), Some(JsonValue::String(name)) if KERNEL_CONFIGURATIONS.contains(&name.as_str()))))
            .collect();
        assert_eq!(mine.len(), count, "{file} holds its pinned kernel rows");
        for row in mine {
            let JsonValue::Object(fields) = &**row else { unreachable!("filtered to objects") };
            let id = match fields.get("id").map(|i| &**i) {
                Some(JsonValue::String(id)) => id.clone(),
                _ => panic!("a row has an id"),
            };
            let expect = serde_of(fields.get("expect").expect("a row's expect"));
            let got = answer(row);
            if !same(&got, &expect) {
                failures.push(format!("{file} {id}\n  expected {expect}\n  answered {got}"));
            }
        }
    }
    assert!(failures.is_empty(), "{} rows differ:\n{}", failures.len(), failures.join("\n"));
}
