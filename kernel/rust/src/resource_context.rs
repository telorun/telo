//! The kernel's side of a resource's construction: resolve the kind, load its
//! controller, validate the document against the kind's schema, bind the
//! invocation contract, and hand the manifest to the controller.
//! Mirrors `../../nodejs/src/resource-context.ts`.
//!
//! The Node `ResourceContext` is also the object a controller calls back into.
//! Here those callbacks cross the C ABI instead, so the controller-facing half
//! is `controller_loaders/native_abi.rs`'s host vtable and this file is the
//! kernel-facing half.

use std::rc::Rc;

use serde_json::Value;
use telo_analyzer::builtins::is_supported_capability;

use crate::controller_loader::ControllerLoader;
use crate::controller_loaders::native_abi::host_vtable;
use crate::controller_registry::Definition;
use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;
use crate::invocation_contract_binding::InvocationContract;

/// Build one resource instance from its document.
pub fn create_resource(
    definition: Rc<Definition>,
    manifest: &Value,
    name: &str,
    loader: &ControllerLoader,
) -> Result<Rc<ResourceInstance>, KernelError> {
    if let Some(capability) = &definition.capability {
        if !is_supported_capability(capability) {
            return Err(KernelError::new(
                "ERR_CAPABILITY_UNSUPPORTED",
                format!(
                    "resource '{name}' has kind '{}', whose capability '{capability}' this kernel does not host yet. It runs Telo.Invocable resources only.",
                    definition.kind
                ),
            ));
        }
    }

    refuse_text_fields(&definition, name)?;
    refuse_catalog_sets(&definition, name)?;
    validate_against_kind_schema(&definition, manifest, name)?;

    let contract = InvocationContract::resolve(&definition.manifest, manifest)?;
    let controller = definition.controller(loader)?;
    let host = host_vtable();
    let handle = controller.create(manifest, &host)?;

    Ok(Rc::new(ResourceInstance {
        name: name.to_string(),
        kind: definition.kind.clone(),
        definition,
        contract,
        handle,
    }))
}

/// The `Text` fragment a kind's field or parameter is typed by.
const TEXT_FRAGMENT_REF: &str = "telo://manifest#/$defs/Text";

/// A kind whose schema or parameters reach the `Text` fragment: this kernel builds
/// no text records, so a controller of such a kind would be handed a raw message
/// where every other runtime hands `{ text, context, lang, computed }`.
fn refuse_text_fields(definition: &Definition, name: &str) -> Result<(), KernelError> {
    let params = definition.manifest.get("params").and_then(Value::as_array);
    let reaches = definition.manifest.get("schema").is_some_and(reaches_text)
        || params.is_some_and(|params| {
            params
                .iter()
                .any(|param| param.get("schema").is_some_and(reaches_text))
        });
    if !reaches {
        return Ok(());
    }
    Err(KernelError::new(
        "ERR_UNSUPPORTED_MANIFEST_FEATURE",
        format!(
            "resource '{name}' has kind '{}', which holds a `Text` — a text shown to a person, handed to its controller as a text record — and this kernel does not build text records yet",
            definition.kind
        ),
    ))
}

/// The annotation marking a kind's text catalog set.
const TEXT_CATALOG_SET_ANNOTATION: &str = "x-telo-text-catalog-set";

/// A kind marking a catalog set: this kernel does not gather a set's catalogs, so
/// it could not refuse a text translated twice in one language across them.
fn refuse_catalog_sets(definition: &Definition, name: &str) -> Result<(), KernelError> {
    if !definition
        .manifest
        .get("schema")
        .is_some_and(marks_catalog_set)
    {
        return Ok(());
    }
    Err(KernelError::new(
        "ERR_UNSUPPORTED_MANIFEST_FEATURE",
        format!(
            "resource '{name}' has kind '{}', which marks a text catalog set (`{TEXT_CATALOG_SET_ANNOTATION}`), and this kernel does not judge catalog sets yet",
            definition.kind
        ),
    ))
}

fn marks_catalog_set(schema: &Value) -> bool {
    match schema {
        Value::Object(object) => {
            object.contains_key(TEXT_CATALOG_SET_ANNOTATION) || object.values().any(marks_catalog_set)
        }
        Value::Array(items) => items.iter().any(marks_catalog_set),
        _ => false,
    }
}

fn reaches_text(schema: &Value) -> bool {
    match schema {
        Value::Object(object) => {
            object.get("$ref").and_then(Value::as_str) == Some(TEXT_FRAGMENT_REF)
                || object.values().any(reaches_text)
        }
        Value::Array(items) => items.iter().any(reaches_text),
        _ => false,
    }
}

/// Check the document against the kind's author-facing schema, compiled once per
/// kind by [`Definition::author_schema`].
fn validate_against_kind_schema(
    definition: &Definition,
    manifest: &Value,
    name: &str,
) -> Result<(), KernelError> {
    let Some(validator) = definition.author_schema()? else {
        return Ok(());
    };
    validator.validate(manifest).map_err(|message| {
        KernelError::manifest_validation_failed(format!(
            "resource '{name}' of kind '{}' is invalid: {message}",
            definition.kind
        ))
    })
}
