//! `kernel/contract-refusal-conformance/`: every row, as this kernel's invocation contract
//! refuses it — the code, the whole message and the whole `data`. The twin of
//! `kernel/nodejs/tests/contract-refusal-conformance.test.ts`. A value crosses this kernel's
//! dispatch as plain JSON, so a typed frame is written in its type's plain encoding first.

use std::path::Path;

use serde_json::{json, Value};
use telo_kernel::invocation_contract_binding::InvocationContract;
use telo_kernel::schema_validator::json_of_cel;
use telorun_sdk_core::typed_frame::decode_typed_frame;

const ROWS: usize = 7;

fn plain(value: &Value) -> Value {
    match value {
        Value::Object(map) if map.contains_key("$telo") => {
            json_of_cel(&decode_typed_frame(&value.to_string()).expect("a row's typed frame decodes"))
        }
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), plain(item))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(plain).collect()),
        other => other.clone(),
    }
}

#[test]
fn every_row_is_refused_as_node_refuses_it() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../contract-refusal-conformance/vectors.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors are readable")).expect("the vectors parse");
    let target = vectors["target"].as_str().expect("a target");
    let rows = vectors["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), ROWS, "the pinned row count");
    for row in rows {
        let mut keys: Vec<&str> = row.as_object().expect("a row").keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["direction", "expect", "id", "schema", "value"], "{}", row["id"]);
        let id = row["id"].as_str().expect("an id");
        let direction = row["direction"].as_str().expect("a direction");
        let manifest = json!({ direction: { "kind": "Telo.JsonSchema", "schema": row["schema"] } });
        let contract = InvocationContract::resolve(&json!({}), &manifest).unwrap_or_else(|err| panic!("{id}: {err}"));
        let value = plain(&row["value"]);
        let refused = match direction {
            "inputType" => contract.prepare_inputs(&value, target).map(|_| ()),
            "outputType" => contract.check_output(&value, target),
            other => panic!("{id}: no direction '{other}'"),
        }
        .expect_err(id);
        let answered = json!({ "code": refused.code, "message": refused.message, "data": refused.data.clone().unwrap_or(Value::Null) });
        assert_eq!(answered, row["expect"], "{id}");
    }
}
