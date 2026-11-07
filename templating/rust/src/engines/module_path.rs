//! The `!module-path` engine, mirroring `../../../nodejs/src/engines/module-path.ts`: a file
//! or directory that ships inside the module, named by its location. Its path grammar is
//! `include::normalize_module_path`, beside the embeds' own; resolving it to an absolute
//! path is the kernel's.
//!
//! The include engines' posture throughout: `compile` leaves the marker, the path is a
//! literal checked as a pure string, and `file_claims` hands the path — a directory may be
//! claimed — to publish and packaging. It produces a `Telo.HostPath`.

use serde_json::{json, Value};

use crate::cel::verdict_codes::TemplatingError;
use crate::engine::{AnalyzeEnv, AnalyzeResult, CompileEnv, CompileOutcome, EngineFileClaim, TemplatingEngine};
use crate::engines::include::{normalize_module_path, path_analysis};

/// Engine name for the tag naming a module file or directory, `!module-path`.
pub const MODULE_PATH_ENGINE: &str = "module-path";

pub struct ModulePathEngine;

impl TemplatingEngine for ModulePathEngine {
    fn name(&self) -> &'static str {
        MODULE_PATH_ENGINE
    }

    #[allow(unused_variables)]
    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError> {
        Ok(CompileOutcome::Unchanged)
    }

    fn produced_type(&self) -> Option<Value> {
        Some(json!({ "type": "string", "x-telo-type": "Telo.HostPath" }))
    }

    #[allow(unused_variables)]
    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult {
        path_analysis(normalize_module_path(source))
    }

    fn file_claims(&self, source: &str) -> Vec<EngineFileClaim> {
        match normalize_module_path(source) {
            Ok(path) => vec![EngineFileClaim { path, directory: true, not_found_code: "MODULE_PATH_NOT_FOUND" }],
            Err(_) => Vec::new(),
        }
    }
}
