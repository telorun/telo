//! The kernel's side of a resource's construction: resolve the kind, load its
//! controller, validate the document against the kind's schema, refuse a host
//! path it holds that is relative or names the wrong kind of entry, bind the
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
use telo_analyzer::schema_error_report::value_type_refusal_code;
use telo_analyzer::schema_validation::{schema_nesting_exceeded_message, ValidationUnfinished, SCHEMA_NESTING_EXCEEDED};
use telo_analyzer::runtime_code_of;

use crate::controller_loader::ControllerLoader;
use crate::controller_loaders::native_abi::host_vtable;
use crate::controller_registry::Definition;
use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;
use crate::host_paths::{refuse_mismatched_host_paths, refuse_relative_host_paths};
use crate::invocation_contract_binding::InvocationContract;

/// Build one resource instance from its document.
pub fn create_resource(
    definition: Rc<Definition>,
    manifest: &Value,
    name: &str,
    module: &str,
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
    refuse_relative_host_path_literals(&definition, manifest, name)?;
    validate_against_kind_schema(&definition, manifest, name)?;
    refuse_misplaced_host_paths(&definition, manifest, name)?;

    let contract = InvocationContract::resolve(&definition.manifest, manifest)?;
    let controller = definition.controller(loader)?;
    let host = host_vtable();
    let handle = controller.create(manifest, &host)?;

    Ok(Rc::new(ResourceInstance {
        name: name.to_string(),
        module: module.to_string(),
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

/// A relative host path written in the document — what Node's load refuses as
/// `HOST_PATH_RELATIVE` before anything is created, refused here before the schema,
/// whose `x-telo-type` would otherwise word it, since this kernel's analysis has no
/// host-path pass.
fn refuse_relative_host_path_literals(definition: &Definition, manifest: &Value, name: &str) -> Result<(), KernelError> {
    let Some(schema) = definition.manifest.get("schema").filter(|_| definition.declares_host_path()) else {
        return Ok(());
    };
    refuse_relative_host_paths(manifest, schema, &format!("{}/{name}", definition.kind))
}

/// A host path that exists as the other kind of entry than its slot names, or that
/// cannot be read — checked after the schema, as the Node kernel checks it at creation.
fn refuse_misplaced_host_paths(definition: &Definition, manifest: &Value, name: &str) -> Result<(), KernelError> {
    let Some(schema) = definition.manifest.get("schema").filter(|_| definition.declares_host_path()) else {
        return Ok(());
    };
    refuse_mismatched_host_paths(manifest, schema, &format!("{}/{name}", definition.kind))
}

/// Check the document against the kind's author-facing schema, compiled once per kind by
/// [`Definition::author_schema`], as Node's creation does: a copy validated, every literal
/// at an instance slot decoded first; a value type's own refusal under its own code, naming
/// the field and the reason, never the value.
fn validate_against_kind_schema(
    definition: &Definition,
    manifest: &Value,
    name: &str,
) -> Result<(), KernelError> {
    let written_kind = manifest.get("kind").and_then(Value::as_str).unwrap_or(&definition.kind).to_string();
    let refused = |reason: String| {
        KernelError::new(
            "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
            format!("Resource does not match schema for kind {written_kind}: {reason}"),
        )
    };
    let validator = match definition.author_schema() {
        Ok(Some(validator)) => validator,
        Ok(None) => return Ok(()),
        Err(message) => return Err(refused(message)),
    };
    let Err(refusal) = validator.check(&validator.decoded(manifest)) else { return Ok(()) };
    // A validation that could not finish holds no verdict on the resource.
    if refusal.issues.is_none() {
        return Err(KernelError::new(
            runtime_code_of(SCHEMA_NESTING_EXCEEDED),
            schema_nesting_exceeded_message(
                &format!("{}/{name}", definition.kind),
                "the resource",
                ValidationUnfinished::of(&refusal.message),
            ),
        ));
    }
    if let Some((issue, code)) = refusal.issues.iter().flatten().find_map(|issue| value_type_refusal_code(issue).map(|code| (issue, code))) {
        return Err(KernelError::new(format!("ERR_{code}"), format!("{}/{name}: {}", definition.kind, issue.message)));
    }
    Err(refused(refusal.message))
}
