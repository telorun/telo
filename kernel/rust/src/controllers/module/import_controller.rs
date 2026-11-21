//! Turns one `Telo.Import` document into a child module.
//! Mirrors `../../../nodejs/src/controllers/module/import-controller.ts`.
//!
//! The child is the module the load's graph resolved the import to — this file
//! resolves nothing itself — and the document's `runtime:` is normalised into the
//! controller-selection policy stamped on the child, which is why a kind's
//! controller is chosen by the import that reached it rather than by the module
//! that declared it.
//!
//! One deliberate divergence from the Node twin, per the mirror rule: Node's
//! `resolve-ref-sentinels.ts` walks a `Telo.Import`'s `resources:` block so the
//! references an importer supplies for a library's declared inputs resolve. This
//! kernel does not implement that block at all — it is refused below and by
//! `UNSUPPORTED_MODULE_FIELDS` on the library side — so there is nothing there to
//! walk. The walk lands here when the feature does.

use serde_json::Value;
use telo_analyzer::sources::oci_ref::is_oci_ref;
use telo_analyzer::ImportEdge;

use crate::error::KernelError;
use crate::sentinel_pass::{compile_sentinels, Owner};
use crate::runtime_registry::{normalize_runtime, ControllerPolicy};

pub struct ImportSpec {
    /// The canonical source of the module the graph's edge reached.
    pub source: String,
    pub policy: ControllerPolicy,
}

/// One `Telo.Import` document of a module — desugared from its `imports:` map or authored —
/// as the module the load's graph resolved it to (`edge`) and the controller policy its
/// `runtime:` selects. `owner` names it in a refusal and `at` is its path there (the
/// `imports:` entry a desugared one came from, nothing for an authored one).
pub fn import_spec(
    document: &Value,
    edge: &ImportEdge,
    owner: Owner,
    at: &str,
    alias: &str,
) -> Result<ImportSpec, KernelError> {
    // What the import supplies is consumed here, so it takes the pass before the supply
    // itself is refused.
    let mut entry = document.clone();
    let mut skip = ["kind", "metadata", "source", "runtime", "resources", "needs"].to_vec();
    skip.retain(|key| document.get(*key).is_some());
    compile_sentinels(owner, &mut entry, at, &skip)?;
    for unsupported in ["variables", "secrets", "resources", "needs"] {
        if document.get(unsupported).is_some() {
            return Err(KernelError::new(
                "ERR_UNSUPPORTED_MANIFEST_FEATURE",
                format!("import '{alias}' passes `{unsupported}:`, which this kernel does not bind yet"),
            ));
        }
    }
    Ok(ImportSpec { source: edge.target_source.clone(), policy: normalize_runtime(document.get("runtime"))? })
}

/// An import this kernel cannot read: a relative path inside an `oci://` artifact (a
/// nested library), or a transport it has no implementation for.
pub fn refuse_unreadable_import(alias: &str, source: &str, from_artifact: bool) -> Result<(), KernelError> {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_relative_import_inside_an_artifact_and_keeps_local_ones() {
        let Err(refusal) = refuse_unreadable_import("Lib", "./lib", true) else {
            panic!("a relative import inside an artifact must be refused");
        };
        assert_eq!(refusal.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE");
        assert!(refusal.message.contains("Nested libraries"), "{}", refusal.message);
        assert!(refuse_unreadable_import("Lib", "./lib", false).is_ok());
    }
}
