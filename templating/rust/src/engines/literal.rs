//! The `!literal` engine — `literal.ts`. Treats the tagged scalar as opaque text: no CEL
//! interpolation, no analysis. `compile` resolves to the source verbatim so the runtime sees
//! a plain string.
//!
//! Opaque text is TEXT — the type is a constant of the tag, exactly as an embed's is, not a
//! function of the slot. Declaring nothing would put `!literal` in `!cel`'s category,
//! "produces whatever the slot asks for".

use serde_json::{json, Value};

use crate::cel::verdict_codes::TemplatingError;
use crate::engine::{AnalyzeEnv, AnalyzeResult, CompileEnv, CompileOutcome, TemplatingEngine};

/// The registry key of the `!literal` engine.
pub const LITERAL_ENGINE: &str = "literal";

pub struct LiteralEngine;

impl TemplatingEngine for LiteralEngine {
    fn name(&self) -> &'static str {
        LITERAL_ENGINE
    }

    #[allow(unused_variables)]
    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError> {
        Ok(CompileOutcome::Resolved(Value::String(source.into())))
    }

    fn produced_type(&self) -> Option<Value> {
        Some(json!({ "type": "string" }))
    }

    #[allow(unused_variables)]
    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult {
        AnalyzeResult::default()
    }
}
