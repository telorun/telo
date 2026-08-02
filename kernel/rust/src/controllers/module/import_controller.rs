//! Resolves one `imports:` entry to a child module.
//! Mirrors `../../../nodejs/src/controllers/module/import-controller.ts`.
//!
//! Two things happen here that shape everything downstream: the child's source
//! is resolved against the *importing manifest*, and the entry's `runtime:` is
//! normalised into the controller-selection policy stamped on the child — which
//! is why a kind's controller is chosen by the import that reached it rather
//! than by the module that declared it.

use serde_json::Value;
use telo_analyzer::resolve_source;

use crate::error::KernelError;
use crate::runtime_registry::{normalize_runtime, ControllerPolicy};

pub struct ImportSpec {
    pub source: String,
    pub policy: ControllerPolicy,
}

/// Expand an `imports:` entry — a bare source string, or the object form.
pub fn parse_import(
    alias: &str,
    entry: &Value,
    base_source: &str,
) -> Result<ImportSpec, KernelError> {
    let (source, runtime) = match entry {
        Value::String(source) => (source.as_str(), None),
        Value::Object(map) => {
            for unsupported in ["variables", "secrets"] {
                if map.contains_key(unsupported) {
                    return Err(KernelError::new(
                        "ERR_UNSUPPORTED_MANIFEST_FEATURE",
                        format!(
                            "import '{alias}' passes `{unsupported}:`, which this kernel does not bind yet"
                        ),
                    ));
                }
            }
            let source = map
                .get("source")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::manifest_validation_failed(format!(
                        "import '{alias}' has no `source`"
                    ))
                })?;
            (source, map.get("runtime"))
        }
        other => {
            return Err(KernelError::manifest_validation_failed(format!(
                "import '{alias}' must be a source string or an object, got {other}"
            )))
        }
    };

    if source.contains("://") {
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!(
                "import '{alias}' resolves through a transport this kernel has no implementation for: {source}. It reads local paths only."
            ),
        ));
    }

    Ok(ImportSpec {
        source: resolve_source(base_source, source),
        policy: normalize_runtime(runtime)?,
    })
}
