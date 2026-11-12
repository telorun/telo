//! What a load whose graph recorded import failures is refused with, mirroring
//! `../../nodejs/src/import-load-failure.ts`: one error carrying every import's diagnostic
//! as `telo check` reports it, headed by the first failure's own message, under the runtime
//! twin of that failure's code (`ERR_KIND_PREFIX_RESERVED`, `ERR_INVALID_IMPORT_TARGET`).

use telo_analyzer::{import_failure_code, import_failure_diagnostics, LoadedGraph};

use crate::error::KernelError;

/// `None` when every import of `graph` loaded.
pub fn import_load_failure(graph: &LoadedGraph) -> Option<KernelError> {
    let first = graph.errors.first()?;
    Some(
        KernelError::new(format!("ERR_{}", import_failure_code(first)), first.message.clone())
            .with_diagnostics(import_failure_diagnostics(&graph.errors)),
    )
}
