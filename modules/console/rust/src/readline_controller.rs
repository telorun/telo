//! Native Rust controller for `console.ReadLine`.
//!
//! Mirrors `../../nodejs/src/readline-controller.ts`: render the prompt, write
//! it without a newline, read one line back, return it as `{ value }`.
//!
//! Ported alongside `WriteLine` because the module exports a ready-made
//! `readLine` singleton, and a library's exported instances are created when the
//! module loads — so a kind with no Rust controller here would make the whole
//! module unloadable, not merely that one kind unusable.

use std::io::{BufRead, IsTerminal, Write};

use telorun_sdk::{
    controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value,
};

use crate::markup::render;

pub struct ReadLine;

#[controller(entry = "readline_controller")]
impl Controller for ReadLine {
    fn create(_manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(Self)
    }

    fn invoke(&self, input: Value, _ctx: &InvokeContext) -> Result<Value> {
        let prompt = input
            .get("prompt")
            .and_then(|value| value.as_str())
            .unwrap_or_default();

        let mut stdout = std::io::stdout();
        let rendered = render(prompt, stdout.is_terminal());
        write!(stdout, "{rendered}")
            .and_then(|()| stdout.flush())
            .map_err(|err| ControllerError::new("ERR_STDOUT_WRITE_FAILED", err.to_string()))?;

        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|err| ControllerError::new("ERR_STDIN_READ_FAILED", err.to_string()))?;

        // Strip exactly the line terminator, matching readline's `question`
        // callback — trimming further would eat significant trailing spaces.
        let mut value = line.as_str();
        if let Some(stripped) = value.strip_suffix('\n') {
            value = stripped;
        }
        if let Some(stripped) = value.strip_suffix('\r') {
            value = stripped;
        }

        Ok(serde_json::json!({ "value": value }))
    }
}
