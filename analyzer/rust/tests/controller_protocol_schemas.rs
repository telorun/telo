//! The controller protocol's message schemas (`sdk/controller-protocol/`), judged by this
//! crate's validator: every valid body in `vectors/messages.json` satisfies its schema,
//! every invalid one is refused at exactly the pointer its row pins, and every request
//! and `ok` response of every exchange in `vectors/sequences.json` satisfies its message's
//! schema. The schema half of `sdk/rust/core`'s protocol vector tests, held here because
//! this crate holds the only JSON Schema validator a Rust process the kernel runs has; the
//! framing and exchange rules stay with the codec in `telorun-sdk-core`. A body is the
//! JSON the frame carries, read as JavaScript reads it, as the Node SDK's test validates it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use telo_analyzer::schema_validation::{json_value_of, CompiledSchema, SchemaValidation, SchemaValidationConfiguration};
use telorun_cel::{read_json_text, JsonValue};
use telorun_cel_value::{CelList, CelRecord, CelValue};

fn protocol() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdk/controller-protocol")
}

fn read(path: &Path) -> Arc<JsonValue> {
    read_json_text(&std::fs::read_to_string(path).expect("a protocol file")).expect("a protocol file is JSON")
}

fn get<'a>(value: &'a JsonValue, key: &str) -> Option<&'a Arc<JsonValue>> {
    match value {
        JsonValue::Object(map) => map.get(key),
        _ => None,
    }
}

fn text<'a>(value: &'a JsonValue, key: &str) -> &'a str {
    match get(value, key).map(|v| &**v) {
        Some(JsonValue::String(text)) => text,
        _ => panic!("'{key}' is text"),
    }
}

fn rows<'a>(file: &'a JsonValue, table: &str) -> &'a Vec<Arc<JsonValue>> {
    match get(file, table).map(|v| &**v) {
        Some(JsonValue::Array(rows)) if !rows.is_empty() => rows,
        _ => panic!("'{table}' is a vector table with rows"),
    }
}

/// A body as JavaScript reads parsed JSON: every number a double.
fn value_of(value: &JsonValue) -> CelValue {
    match value {
        JsonValue::Null => CelValue::Null,
        JsonValue::Bool(b) => CelValue::Bool(*b),
        JsonValue::Number(n) => CelValue::Double(*n),
        JsonValue::String(s) => CelValue::String(s.as_str().into()),
        JsonValue::Array(items) => CelValue::List(items.iter().map(|item| value_of(item)).collect::<CelList>()),
        JsonValue::Object(map) => {
            let mut record = CelRecord::new();
            for (key, item) in map.iter() {
                record.insert(key, value_of(item));
            }
            CelValue::Record(record)
        }
    }
}

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

/// Every message's schemas, compiled once each on an instance of its own.
struct Messages {
    entries: BTreeMap<String, Arc<JsonValue>>,
    compiled: BTreeMap<String, CompiledSchema>,
}

impl Messages {
    fn read() -> Self {
        let mut entries = BTreeMap::new();
        for file in std::fs::read_dir(protocol().join("messages")).expect("the message directory") {
            let entry = read(&file.expect("a message file").path());
            entries.insert(text(&entry, "name").to_string(), entry);
        }
        Self { entries, compiled: BTreeMap::new() }
    }

    /// The distinct instance pointers a refusal of `body` names, sorted.
    fn refusals(&mut self, message: &str, part: &str, body: &JsonValue) -> Vec<String> {
        let key = format!("{message}#{part}");
        if !self.compiled.contains_key(&key) {
            let entry = self.entries.get(message).unwrap_or_else(|| panic!("No message named '{message}'"));
            let schema = get(entry, part).filter(|s| !matches!(&***s, JsonValue::Null)).unwrap_or_else(|| panic!("'{message}' has no {part} schema"));
            let compiled = SchemaValidation::new(SchemaValidationConfiguration::Analysis)
                .compile_json(json_value_of(&serde_of(schema)))
                .unwrap_or_else(|err| panic!("{key} is not a usable schema: {err}"));
            self.compiled.insert(key.clone(), compiled);
        }
        let result = self.compiled[&key].validate(&value_of(body)).expect("a body nests within the bound");
        let pointers: BTreeSet<String> = result.errors.into_iter().map(|error| error.instance_path).collect();
        pointers.into_iter().collect()
    }
}

#[test]
fn every_valid_message_body_satisfies_its_schema() {
    let file = read(&protocol().join("vectors/messages.json"));
    let mut messages = Messages::read();
    for row in rows(&file, "valid") {
        let (message, part) = (text(row, "message"), text(row, "part"));
        let refusals = messages.refusals(message, part, get(row, "body").expect("a body"));
        assert!(refusals.is_empty(), "{message} {part} was refused at {refusals:?}");
    }
}

#[test]
fn refuses_every_invalid_message_body_at_its_pointer() {
    let file = read(&protocol().join("vectors/messages.json"));
    let mut messages = Messages::read();
    for row in rows(&file, "invalid") {
        let (name, message, part) = (text(row, "name"), text(row, "message"), text(row, "part"));
        let refusals = messages.refusals(message, part, get(row, "body").expect("a body"));
        assert_eq!(refusals, vec![text(row, "pointer").to_string()], "{name} names a place other than the pointer its row pins");
    }
}

#[test]
fn every_exchanged_body_satisfies_its_message_schema() {
    let file = read(&protocol().join("vectors/sequences.json"));
    let mut messages = Messages::read();
    for row in rows(&file, "sequences") {
        let name = text(row, "name");
        let mut requests: BTreeMap<u64, String> = BTreeMap::new();
        for (index, frame) in rows(row, "frames").iter().enumerate() {
            let at = format!("{name}: frame {index}");
            let envelope = read_json_text(text(frame, "meta")).unwrap_or_else(|err| panic!("{at}: {err:?}"));
            let message = text(&envelope, "type").to_string();
            let id = match get(&envelope, "id").map(|i| &**i) {
                Some(JsonValue::Number(id)) => *id as u64,
                _ => panic!("{at}: an id"),
            };
            let payload = get(&envelope, "payload").expect("a payload");
            // §3.2: the kernel end mints even ids and the controller end odd ones.
            let is_request = id % 2 == if text(frame, "from") == "kernel" { 0 } else { 1 };
            if is_request {
                let refusals = messages.refusals(&message, "request", payload);
                assert!(refusals.is_empty(), "{at}: {message} request refused at {refusals:?}");
                requests.insert(id, message);
            } else if let Some(ok) = get(payload, "ok") {
                assert_eq!(requests.get(&id), Some(&message), "{at} answers a request it was sent");
                let refusals = messages.refusals(&message, "response", ok);
                assert!(refusals.is_empty(), "{at}: {message} response refused at {refusals:?}");
            }
        }
    }
}
