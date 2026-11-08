//! The CEL face of every value type, registered from the entries alone — `value-types.ts`.
//!
//! One registration, made where the dialect environment is built, so the runtime
//! environment and every analysis clone carry the same types and no type is named here.
//!
//! - **A nominal brand** (a `json` entry with no `celType`) is a type of its own over its
//!   base: it converts to its base, renders as text, and — for a host path — is extended
//!   with `.joinPath(relative)` and stays one. Declared, not implemented: at runtime a
//!   branded value is its base, so the standard library's own overloads evaluate.
//! - **An instance declaring `members`** is a type whose members are its fields, and
//!   `string(value)` is its plain encoding's text, registered with that encoder as its
//!   implementation.
//!
//! Types register in entry-file order, the order Node's `VALUE_TYPES` iterates in.

use std::sync::Arc;

use serde_json::Value;
use telorun_cel::{CelCallContext, CelEnvironment, FunctionMetadata, NominalTypeDefinition, PropertyMap};
use telorun_cel_value::{cel_error, CelEvaluationCode, CelValue};
use telorun_sdk_core::plain_encoding::host_text;
use telorun_sdk_core::value_type::{
    cel_type_of_value_type, value_brand_bases, value_type_of, value_types, value_types_in_order, ValueType,
};

/// Registers every value type's CEL face. A refusal is a defect in the entries or the
/// engine, and panics naming the type.
pub fn register_value_types(environment: &mut CelEnvironment) {
    for (brand, base) in value_brand_bases() {
        let mut conversions = vec![format!("{base}(Self): {base}")];
        // Every base CEL renders as text renders its brand too: the runtime value is the base.
        if base != "string" {
            conversions.push("string(Self): string".into());
        }
        let from_host = value_types().get(brand).is_some_and(|entry| entry.from_host.is_some());
        let members = if from_host { vec!["Self.joinPath(string): Self".into()] } else { Vec::new() };
        environment
            .register_type(NominalTypeDefinition {
                name: brand.into(),
                base: base.into(),
                conversions,
                members,
                ..Default::default()
            })
            .unwrap_or_else(|refusal| panic!("the value type {brand} does not register: {refusal}"));
    }
    for entry in value_types_in_order() {
        if entry.members.is_none() {
            continue;
        }
        let name = cel_type_of_value_type(entry).to_owned();
        let encoding = entry.encoding.clone().unwrap_or_else(|| panic!("{name} declares members and no encoding"));
        environment
            .register_type(NominalTypeDefinition {
                name: name.clone(),
                base: "dyn".into(),
                fields: Some(field_types(entry)),
                description: Some(entry.description.clone()),
                ..Default::default()
            })
            .unwrap_or_else(|refusal| panic!("the value type {name} does not register: {refusal}"));
        let encoder_name = name.clone();
        let implementation = Arc::new(move |context: &CelCallContext, args: &[CelValue]| match args {
            [CelValue::Host(host)] => match host_text(&encoding, host) {
                Some(text) => CelValue::String(text.into()),
                None => cel_error(
                    CelEvaluationCode::InvalidArgument,
                    format!("string: the {encoder_name} value holds nothing its encoding writes"),
                    context.range,
                )
                .into(),
            },
            _ => cel_error(
                CelEvaluationCode::NoMatchingOverload,
                format!("string: expected a {encoder_name}"),
                context.range,
            )
            .into(),
        });
        environment
            .register_function(
                format!("string({name}): string"),
                FunctionMetadata {
                    implementation: Some(implementation),
                    description: Some(format!("The text of a {name}, in its plain encoding.")),
                    ..FunctionMetadata::default()
                },
            )
            .unwrap_or_else(|refusal| panic!("string({name}) does not register: {refusal}"));
    }
}

/// Each member of an entry as the CEL type its field reads as, in the entry's order.
fn field_types(entry: &ValueType) -> PropertyMap<String> {
    entry
        .members
        .iter()
        .flatten()
        .map(|(member, schema)| (member.as_str(), cel_type_of_schema(schema)))
        .collect()
}

/// The CEL type a member's schema declares: a value type's own, a scalar's, a list's
/// element and a map's value read in turn; anything else `dyn`.
fn cel_type_of_schema(schema: &Value) -> String {
    if let Some(entry) = value_type_of(schema) {
        return cel_type_of_value_type(entry).into();
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => "string".into(),
        Some("integer") => "int".into(),
        Some("number") => "double".into(),
        Some("boolean") => "bool".into(),
        Some("array") => match schema.get("items") {
            Some(items) if items.is_object() => format!("list<{}>", cel_type_of_schema(items)),
            _ => "list<dyn>".into(),
        },
        Some("object") => match schema.get("additionalProperties") {
            Some(values) if values.is_object() => format!("map<string, {}>", cel_type_of_schema(values)),
            _ => "map<string, dyn>".into(),
        },
        _ => "dyn".into(),
    }
}
