//! The schemas Telo validates values against, as declared — the documents the in-place cycle
//! rule (`schema_in_place_cycle`) is judged over. Mirrors the part of
//! `../../nodejs/src/validated-schemas.ts` this analyzer reads: a kind's `schema:`, `status:`,
//! contracts and signature, and each `variables:` / `secrets:` entry of a module document. A
//! need type's documents and a callable instance's own signature have no reader here.

use serde_json::Value;

use crate::residual_schema::residual_entry_schema;
use crate::schema_in_place_cycle::{in_place_cycle_through, lookup_target, InPlaceGraph, InPlaceHop, InPlaceTarget};
use crate::system_kinds::is_module_document;
use crate::types::kind_of;

/// A schema a declaration validates values against, and the field holding it.
#[derive(Debug, Clone)]
pub struct SchemaDocument {
    pub path: String,
    pub schema: Value,
}

/// An inline type field's schema: raw JSON Schema, or the `schema` of an inline
/// `{ kind, schema }` declaration; a reference holds none.
fn type_field_schema(value: Option<&Value>, path: &str) -> Option<SchemaDocument> {
    let object = value?.as_object()?;
    if object.get("kind").is_some_and(Value::is_string) {
        let schema = object.get("schema").filter(|schema| schema.is_object())?;
        return Some(SchemaDocument { path: format!("{path}.schema"), schema: schema.clone() });
    }
    if object.get("__ref").is_some_and(Value::is_string) || object.get("name").is_some_and(Value::is_string) {
        return None;
    }
    Some(SchemaDocument { path: path.to_string(), schema: value?.clone() })
}

/// Every schema a kind's definition validates values against: its `schema:`, `status:`,
/// contracts and signature.
pub fn definition_schema_documents(definition: &Value) -> Vec<SchemaDocument> {
    let mut out = Vec::new();
    for field in ["schema", "status"] {
        if let Some(schema) = definition.get(field).filter(|schema| schema.is_object()) {
            out.push(SchemaDocument { path: field.to_string(), schema: schema.clone() });
        }
    }
    for field in ["inputType", "outputType"] {
        out.extend(type_field_schema(definition.get(field), field));
    }
    if let Some(params) = definition.get("params").and_then(Value::as_array) {
        for (i, param) in params.iter().enumerate() {
            if let Some(schema) = param.get("schema").filter(|schema| schema.is_object()) {
                out.push(SchemaDocument { path: format!("params[{i}].schema"), schema: schema.clone() });
            }
        }
    }
    if let Some(schema) = definition.get("returns").and_then(|returns| returns.get("schema")).filter(|schema| schema.is_object()) {
        out.push(SchemaDocument { path: "returns.schema".to_string(), schema: schema.clone() });
    }
    out
}

/// The schema each `variables:` / `secrets:` entry of a module document holds its value to,
/// keyed `variables.<name>` / `secrets.<name>`: each entry is a document of its own.
pub fn module_input_schema_documents(module_document: &Value) -> Vec<SchemaDocument> {
    if !kind_of(module_document).is_some_and(is_module_document) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for block in ["variables", "secrets"] {
        let Some(entries) = module_document.get(block).and_then(Value::as_object) else { continue };
        for (name, entry) in entries {
            if entry.is_object() {
                out.push(SchemaDocument { path: format!("{block}.{name}"), schema: residual_entry_schema(entry) });
            }
        }
    }
    out
}

/// A schema document's first in-place cycle, and the field holding it.
#[derive(Debug, Clone)]
pub struct DocumentCycle {
    pub path: String,
    pub cycle: Vec<InPlaceHop>,
}

/// The in-place cycles `documents` close through their own local references alone, each
/// document keyed by its field path — what a declaration nothing else references can recurse
/// through.
pub fn local_in_place_cycles(documents: &[SchemaDocument]) -> Vec<DocumentCycle> {
    struct Local<'d>(&'d SchemaDocument);
    impl InPlaceGraph for Local<'_> {
        fn document_of(&self, document: &str) -> Option<Value> {
            (document == self.0.path).then(|| self.0.schema.clone())
        }
        fn target_of(&self, reference: &str, document: &str) -> Option<InPlaceTarget> {
            lookup_target(reference, document, |_| false)
        }
    }
    documents
        .iter()
        .filter_map(|document| {
            in_place_cycle_through(&document.path, &Local(document))
                .map(|cycle| DocumentCycle { path: document.path.clone(), cycle })
        })
        .collect()
}
