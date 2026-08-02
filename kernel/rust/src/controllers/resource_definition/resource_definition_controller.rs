//! Registers a `Telo.Definition` document as a kind.
//! Mirrors `../../../nodejs/src/controllers/resource-definition/resource-definition-controller.ts`.
//!
//! The Node controller resolves the kind's controller here, so a broken
//! `controllers:` candidate fails at boot. This one only records the candidate
//! list: a standard-library module ships kinds for several runtimes, and
//! rejecting the module because one of its kinds has no Rust controller would
//! make an unmodified `telo.yaml` unloadable. The resolution happens on first
//! instantiation instead — see `controller_registry::Definition::controller`.

use std::rc::Rc;

use serde_json::Value;
use telo_analyzer::builtins::is_capability;

use crate::controller_registry::Definition;
use crate::error::KernelError;
use crate::runtime_registry::ControllerPolicy;

pub fn register_definition(
    module_name: &str,
    source: &str,
    policy: &ControllerPolicy,
    document: &Value,
) -> Result<Rc<Definition>, KernelError> {
    let name = document
        .get("metadata")
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::manifest_validation_failed(format!(
                "a Telo.Definition in '{source}' has no metadata.name"
            ))
        })?;

    if name.contains('.') {
        return Err(KernelError::manifest_validation_failed(format!(
            "Telo.Definition '{name}' in '{source}': a kind name must contain no dot — the reference grammar splits on the first one"
        )));
    }

    let capability = document.get("capability").and_then(Value::as_str);
    if let Some(capability) = capability {
        if !is_capability(capability) {
            return Err(KernelError::manifest_validation_failed(format!(
                "Telo.Definition '{name}': '{capability}' is not a kernel capability"
            )));
        }
    }

    if document.get("extends").is_some() {
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!("Telo.Definition '{name}': `extends` is not supported by this kernel yet"),
        ));
    }

    let controllers = match document.get("controllers") {
        None => Vec::new(),
        Some(Value::Array(entries)) => entries
            .iter()
            .map(|entry| {
                entry.as_str().map(str::to_string).ok_or_else(|| {
                    KernelError::manifest_validation_failed(format!(
                        "Telo.Definition '{name}': every `controllers:` entry must be a PURL string, got {entry}"
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => {
            return Err(KernelError::manifest_validation_failed(format!(
                "Telo.Definition '{name}': `controllers:` must be a list of PURL strings, got {other}"
            )))
        }
    };

    Ok(Rc::new(Definition::new(
        module_name.to_string(),
        name.to_string(),
        capability.map(str::to_string),
        document.clone(),
        controllers,
        source.to_string(),
        policy.clone(),
    )))
}
