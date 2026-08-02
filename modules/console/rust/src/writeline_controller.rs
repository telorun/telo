//! Native Rust controller for `console.WriteLine`.
//!
//! Mirrors `../../nodejs/src/writeline-controller.ts`: render the markup, write
//! the line to standard output, return the unrendered text as the result.
//!
//! Two differences from the TypeScript controller, both following from the Rust
//! `ResourceContext` being narrower than the Node one: standard output is taken
//! from the process rather than from `ctx.stdout`, and no `LineWritten` event is
//! emitted — the Rust SDK has no `emit` yet.

use std::io::{IsTerminal, Write};

use telorun_sdk::{
    controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value,
};

use crate::markup::render;

pub struct WriteLine;

#[controller(entry = "writeline_controller")]
impl Controller for WriteLine {
    fn create(_manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(Self)
    }

    fn invoke(&self, input: Value, _ctx: &InvokeContext) -> Result<Value> {
        let output = input
            .get("output")
            .and_then(|value| value.as_str())
            .unwrap_or_default();

        let mut stdout = std::io::stdout();
        let rendered = render(output, stdout.is_terminal());
        writeln!(stdout, "{rendered}")
            .and_then(|()| stdout.flush())
            .map_err(|err| ControllerError::new("ERR_STDOUT_WRITE_FAILED", err.to_string()))?;

        Ok(Value::String(output.to_string()))
    }
}
