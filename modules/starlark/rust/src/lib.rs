//! Native Rust controller for `std/starlark`. Loaded into the Node.js kernel
//! via the SDK's napi backend.
//!
//! This is the PoC scaffold: it proves the polyglot machinery end-to-end
//! (cargo build → `.node` → kernel dispatch → invoke) by returning a marker
//! payload showing which controller ran. Replacing the body of `invoke` with
//! a real `starlark-rust` evaluation is the natural follow-up — this scaffold
//! is the right shape, not a throwaway.

use telorun_sdk::{
    controller, Controller, ControllerError, ResourceContext, Result, Value,
};

pub struct StarlarkScript {
    code: String,
}

#[controller]
impl Controller for StarlarkScript {
    fn create(manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        let code = manifest
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                ControllerError::new(
                    "ERR_MISSING_CODE",
                    "starlark.Script requires a non-empty `code` field",
                )
            })?
            .to_string();
        Ok(Self { code })
    }

    fn invoke(&self, input: Value) -> Result<Value> {
        Ok(serde_json::json!({
            "controller": "rust",
            "code_length": self.code.len(),
            "input": input,
        }))
    }
}
