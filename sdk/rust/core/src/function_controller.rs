//! The native function contract — what a Rust callable kind implements.
//!
//! The Rust half of `sdk/nodejs/src/function-controller.ts`. A function is built
//! once per resource by `create` and then called synchronously from inside a CEL
//! expression, which has nowhere to wait — so `call` is a plain `fn`, never
//! `async`. Its argument and result types are the author's own serde types; the
//! CEL value types (`Timestamp`, `Duration`, `Bytes`, `Uint64`) keep their CEL
//! type across the boundary because arguments and results cross as typed frames.
//!
//! What `create` allocates is released when the instance is dropped: the kernel
//! destroys it on teardown and on reload, so `Drop` is the inverse of `create`.
//!
//! ```ignore
//! use serde::Deserialize;
//! use telorun_sdk::{function, Function, FunctionContext, Result, Timestamp};
//!
//! pub struct IsBefore;
//!
//! #[derive(Deserialize)]
//! pub struct Args { a: Timestamp, b: Timestamp }
//!
//! #[function(entry = "is_before")]
//! impl Function for IsBefore {
//!     type Config = serde_json::Value;
//!     type Args = Args;
//!     type Output = bool;
//!     fn create(_config: Self::Config, _ctx: &dyn FunctionContext) -> Result<Self> { Ok(IsBefore) }
//!     fn call(&self, args: Args) -> Result<bool> { Ok(args.a < args.b) }
//! }
//! ```

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::logging::SeverityNumber;
use crate::traits::Result;

/// Everything a function reaches through Telo: logging. No environment, no
/// resource, no dispatch — which limits what the context gives, not what Rust
/// can do, so a native kind's determinism is a claim its author makes.
pub trait FunctionContext {
    /// Emit a record through the resource's logger. Available during `create`.
    fn log(&self, severity: SeverityNumber, message: &str) -> Result<()>;
}

/// A callable kind's native implementation. Add `#[function(entry = "…")]` to
/// the impl block to export it under that entry — the PURL's `#fragment`.
pub trait Function: Sized + 'static {
    /// The resource's own configuration, read from its plain JSON.
    type Config: DeserializeOwned;
    /// The arguments, one field per declared parameter name.
    type Args: DeserializeOwned;
    /// What `call` returns, checked against the declared `returns`.
    type Output: Serialize;

    fn create(config: Self::Config, ctx: &dyn FunctionContext) -> Result<Self>;

    fn call(&self, args: Self::Args) -> Result<Self::Output>;
}

/// The configuration, arguments and result of one call, as the text both
/// backends carry: plain JSON in, typed frames for arguments and results.
pub mod wire {
    use super::Function;
    use crate::error::ControllerError;
    use crate::traits::Result;
    use crate::typed_frame;

    /// The resource's configuration as `F::Config`. The kernel has already
    /// validated it against the kind's schema, so a refusal here means that
    /// schema and the Rust type disagree — never a call's arguments.
    pub fn config<F: Function>(json: &[u8]) -> Result<F::Config> {
        serde_json::from_slice(json).map_err(|err| {
            ControllerError::new(
                "ERR_FUNCTION_CONFIG_INVALID",
                format!(
                    "the function's configuration does not read as its `Config` type: {err}. The kind's schema accepted it, so the schema and the type disagree"
                ),
            )
        })
    }

    pub fn args<F: Function>(frame: &[u8]) -> Result<F::Args> {
        let text = std::str::from_utf8(frame)
            .map_err(|err| ControllerError::new("ERR_INPUT_INVALID", format!("the arguments are not UTF-8: {err}")))?;
        typed_frame::from_frame(text)
            .map_err(|err| ControllerError::new("ERR_INPUT_INVALID", format!("the arguments do not read: {}", err.message)))
    }

    pub fn output<F: Function>(output: &F::Output) -> Result<String> {
        typed_frame::to_frame(output)
            .map_err(|err| ControllerError::new("ERR_OUTPUT_INVALID", format!("the result cannot be written: {}", err.message)))
    }

    /// Construct, then call — the whole body of a `call`, for either backend.
    pub fn call<F: Function>(instance: &F, frame: &[u8]) -> Result<String> {
        let args = args::<F>(frame)?;
        let output = instance.call(args)?;
        self::output::<F>(&output)
    }

    #[cfg(test)]
    mod tests {
        use super::super::{Function, FunctionContext};
        use crate::traits::Result;

        struct Scaled;

        impl Function for Scaled {
            type Config = i64;
            type Args = serde_json::Value;
            type Output = bool;
            fn create(_config: i64, _ctx: &dyn FunctionContext) -> Result<Self> {
                Ok(Scaled)
            }
            fn call(&self, _args: serde_json::Value) -> Result<bool> {
                Ok(true)
            }
        }

        #[test]
        fn refuses_a_configuration_its_type_cannot_read_as_a_configuration_error() {
            let error = super::config::<Scaled>(br#""two""#).err().unwrap();
            assert_eq!(error.code, "ERR_FUNCTION_CONFIG_INVALID");
        }
    }
}
