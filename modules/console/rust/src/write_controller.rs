//! Native Rust controller for `console.Write`.
//!
//! Mirrors `../../nodejs/src/write-controller.ts`: write the text to standard
//! output exactly as given — no markup rendering, no newline — and return it.
//!
//! Text only. `Value` has no bytes variant, so a byte chunk cannot reach this
//! controller: the Rust kernel's manifest values have none, and on the Node
//! kernel the napi bridge refuses a `Uint8Array` before `invoke` runs. Any other
//! non-string value is refused rather than coerced, since writing a rendering of
//! it would put different bytes on stdout than the caller sent.
//!
//! Ported because the module exports a ready-made `write` singleton, and a
//! library's exported instances are created when the module loads.

use std::io::Write as _;

use telorun_sdk::{
    controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value,
};

pub struct Write;

#[controller(entry = "write_controller")]
impl Controller for Write {
    fn create(_manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(Self)
    }

    fn invoke(&self, input: Value, _ctx: &InvokeContext) -> Result<Value> {
        let output = match input.get("output") {
            Some(Value::String(text)) => text,
            other => {
                return Err(ControllerError::new(
                    "ERR_OUTPUT_NOT_TEXT",
                    format!(
                        "Console.Write: the Rust controller writes text only; 'output' is {}. Bytes are written by the JavaScript controller — import the module with a runtime policy that selects it.",
                        describe(other)
                    ),
                ));
            }
        };

        let mut stdout = std::io::stdout();
        stdout
            .write_all(output.as_bytes())
            .and_then(|()| stdout.flush())
            .map_err(|err| ControllerError::new("ERR_STDOUT_WRITE_FAILED", err.to_string()))?;

        Ok(Value::String(output.clone()))
    }
}

fn describe(value: Option<&Value>) -> &'static str {
    match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "a boolean",
        Some(Value::Number(_)) => "a number",
        Some(Value::String(_)) => "a string",
        Some(Value::Array(_)) => "an array",
        Some(Value::Object(_)) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use telorun_sdk::{Controller, InvokeContext};

    use super::Write;

    #[test]
    fn returns_the_text_it_wrote() {
        let result = Write
            .invoke(json!({ "output": "{green x} a\\\\b" }), &InvokeContext::never())
            .expect("text is written");
        assert_eq!(result, json!("{green x} a\\\\b"));
    }

    #[test]
    fn refuses_a_value_that_is_not_text() {
        for output in [json!(42), json!({ "0": 98 }), json!([98]), json!(null)] {
            let err = Write
                .invoke(json!({ "output": output }), &InvokeContext::never())
                .expect_err("non-text is refused");
            assert_eq!(err.code, "ERR_OUTPUT_NOT_TEXT", "{err}");
        }
    }

    #[test]
    fn refuses_a_missing_output() {
        let err = Write
            .invoke(json!({}), &InvokeContext::never())
            .expect_err("missing output is refused");
        assert_eq!(err.code, "ERR_OUTPUT_NOT_TEXT", "{err}");
    }
}
