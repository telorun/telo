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
