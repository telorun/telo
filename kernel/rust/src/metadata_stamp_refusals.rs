//! The kernel's refusal of a loader stamp an author wrote in `metadata`
//! (`ERR_METADATA_RESERVED_FIELD`), over what the load found. Mirrors
//! `metadataStampLoadRefusal` in `../../nodejs/src/metadata-stamp-refusals.ts`; a stamp on a
//! declaration the kernel makes itself has no twin, since this kernel makes none.

use telo_analyzer::AnalysisDiagnostic;

use crate::error::KernelError;

pub const ERR_METADATA_RESERVED_FIELD: &str = "ERR_METADATA_RESERVED_FIELD";

/// The load's refusal of `stamps`, one line each naming its file, carrying each stamp under
/// the refusal's code and then every other error the analysis found.
pub fn metadata_stamp_load_refusal(stamps: &[AnalysisDiagnostic], others: Vec<AnalysisDiagnostic>) -> KernelError {
    let message = stamps
        .iter()
        .map(|d| match d.data.as_ref().and_then(|data| data.file_path.as_deref()) {
            Some(file) => format!("{file}: {}", d.message),
            None => d.message.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut carried: Vec<AnalysisDiagnostic> = stamps
        .iter()
        .cloned()
        .map(|mut d| {
            d.code = Some(ERR_METADATA_RESERVED_FIELD.to_string());
            d
        })
        .collect();
    carried.extend(others);
    KernelError::new(ERR_METADATA_RESERVED_FIELD, message).with_diagnostics(carried)
}
