//! Resolves one `imports:` entry to a child module.
//! Mirrors `../../../nodejs/src/controllers/module/import-controller.ts`.
//!
//! Two things happen here that shape everything downstream: the child's source
//! is resolved against the *importing manifest*, and the entry's `runtime:` is
//! normalised into the controller-selection policy stamped on the child — which
//! is why a kind's controller is chosen by the import that reached it rather
//! than by the module that declared it.
//!
//! One deliberate divergence from the Node twin, per the mirror rule: Node's
//! `resolve-ref-sentinels.ts` walks a `Telo.Import`'s `resources:` block so the
//! references an importer supplies for a library's declared inputs resolve. This
//! kernel does not implement that block at all — it is refused below and by
//! `UNSUPPORTED_MODULE_FIELDS` on the library side — so there is nothing there to
//! walk. The walk lands here when the feature does.

use serde_json::Value;
use telo_analyzer::resolve_source;
use telo_analyzer::sources::oci_ref::is_oci_ref;

use crate::error::KernelError;
use crate::runtime_registry::{normalize_runtime, ControllerPolicy};

pub struct ImportSpec {
    pub source: String,
    pub policy: ControllerPolicy,
}

/// Expand an `imports:` entry — a bare source string, or the object form.
///
/// `from_artifact` is true when the importing module was loaded from an `oci://`
/// artifact. A relative import there names a library inside that artifact, which
/// this kernel does not resolve (nested libraries are unsupported), so it is refused
/// rather than joined to the artifact's cache path.
pub fn parse_import(
    alias: &str,
    entry: &Value,
    base_source: &str,
    from_artifact: bool,
) -> Result<ImportSpec, KernelError> {
    let (source, runtime) = match entry {
        Value::String(source) => (source.as_str(), None),
        Value::Object(map) => {
            for unsupported in ["variables", "secrets", "resources", "needs"] {
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

    if from_artifact && source.starts_with('.') {
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!(
                "import '{alias}' is a relative path, {source}, declared by a module loaded from an oci:// artifact. Nested libraries (a library shipped inside another artifact) are not supported by this kernel; import it by its own oci:// ref."
            ),
        ));
    }

    if source.contains("://") && !is_oci_ref(source) {
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!(
                "import '{alias}' resolves through a transport this kernel has no implementation for: {source}. It reads local paths and oci:// refs only."
            ),
        ));
    }

    Ok(ImportSpec {
        source: resolve_source(base_source, source),
        policy: normalize_runtime(runtime)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refuses_a_relative_import_inside_an_artifact_and_keeps_local_ones() {
        let entry = json!("./lib");
        let Err(refusal) = parse_import("Lib", &entry, "oci://ghcr.io/x/app@1.0.0", true) else {
            panic!("a relative import inside an artifact must be refused");
        };
        assert_eq!(refusal.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE");
        assert!(refusal.message.contains("Nested libraries"), "{}", refusal.message);

        let Ok(local) = parse_import("Lib", &entry, "/work/app/telo.yaml", false) else {
            panic!("a relative import from a local module must resolve");
        };
        assert_eq!(local.source, "/work/app/lib");
    }
}
