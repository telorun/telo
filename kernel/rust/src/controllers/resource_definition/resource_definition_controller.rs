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
use telo_analyzer::capability_roster::capability_problem;

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

    // The closed roster, worded as the Node kernel and `telo check` word it. This
    // kernel reads no migration, so the legacy `capability: <Alias>.<Kind>`
    // reaches here unrewritten and is refused as what it is.
    if let Some(problem) =
        capability_problem(document.get("capability"), document.get("extends").is_some())
    {
        return Err(KernelError::new(
            format!("ERR_{}", problem.code),
            format!("Telo.Definition '{name}': {}", problem.message),
        ));
    }
    let capability = document.get("capability").and_then(Value::as_str);

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

#[cfg(test)]
mod tests {
    use super::*;

    /// A module shipping a function kind must stay loadable here: this kernel
    /// hosts no functions, but refusing the capability would refuse every other
    /// kind in the same module.
    #[test]
    fn registers_a_callable_kind() {
        let document = serde_json::json!({
            "kind": "Telo.Definition",
            "metadata": { "name": "Hmac" },
            "capability": "Telo.Callable",
            "params": [{ "name": "message", "schema": { "type": "string" } }],
            "returns": { "schema": { "type": "string" } },
        });
        let definition = register_definition(
            "Crypto",
            "telo.yaml",
            &ControllerPolicy::default(),
            &document,
        )
        .expect("a callable kind registers");
        assert_eq!(definition.capability.as_deref(), Some("Telo.Callable"));
    }

    /// The vectors every runtime judging a `capability:` answers identically —
    /// `analyzer/capability-conformance/README.md`.
    const VECTORS: &str =
        include_str!("../../../../../analyzer/capability-conformance/vectors.json");

    /// The closed roster, refused at registration with the codes `telo check`
    /// reports as `CAPABILITY_UNKNOWN` / `CAPABILITY_NOT_DECLARABLE`. This kernel
    /// refuses every `extends:` after the roster, so an accepted row declaring
    /// one is held only to raising no roster refusal.
    #[test]
    fn answers_every_capability_conformance_vector() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("vectors parse");
        for row in vectors["rows"].as_array().expect("rows") {
            let id = row["id"].as_str().expect("id");
            let mut document = serde_json::json!({
                "kind": "Telo.Definition",
                "metadata": { "name": "Thing" },
            });
            if let Some(capability) = row.get("capability") {
                document["capability"] = capability.clone();
            }
            if row["extends"].as_bool().expect("extends") {
                document["extends"] = Value::from("Lib.Base");
            }
            let answer =
                register_definition("Lib", "telo.yaml", &ControllerPolicy::default(), &document);
            match row["code"].as_str() {
                None => {
                    if let Err(error) = answer {
                        assert!(!error.code.starts_with("ERR_CAPABILITY_"), "{id}: {}", error.code);
                    }
                }
                Some(code) => {
                    let Err(error) = answer else { panic!("{id}: registered") };
                    assert_eq!(error.code, format!("ERR_{code}"), "{id}");
                    assert_eq!(
                        error.message,
                        format!("Telo.Definition 'Thing': {}", row["message"].as_str().expect("message")),
                        "{id}"
                    );
                }
            }
        }
    }
}
