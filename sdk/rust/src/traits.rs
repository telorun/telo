use crate::error::ControllerError;
use crate::Value;

pub type Result<T> = std::result::Result<T, ControllerError>;

/// Author-facing controller contract. Implement on your controller struct,
/// then add `#[controller]` to the impl block to generate FFI bindings for
/// the active backend.
pub trait Controller: Sized + 'static {
    /// Process-level init; called once per `.node` load before any `create`.
    /// Default: no-op. Override when the backing library needs one-time
    /// global setup (e.g. installing panic handlers, warming thread pools).
    fn register(_ctx: &dyn ControllerContext) -> Result<()> {
        Ok(())
    }

    /// Per-resource constructor. Called once per resource of this kind.
    fn create(manifest: Value, ctx: &dyn ResourceContext) -> Result<Self>;

    /// One-shot invocation entry point. Default: not supported (the macro
    /// only emits an FFI binding when the impl block defines this method).
    fn invoke(&self, _input: Value) -> Result<Value> {
        Err(ControllerError::new(
            "ERR_NOT_INVOCABLE",
            "Controller did not implement invoke()",
        ))
    }

    /// Resource-state snapshot for `${{ resources.<name>.* }}` CEL access.
    /// Default: null. Override when peer resources read this resource's state.
    fn snapshot(&self) -> Value {
        Value::Null
    }
}

/// Process-level context passed to `Controller::register`. Reserved for
/// future use; no methods needed for the PoC.
pub trait ControllerContext {}

/// Per-resource context passed to `Controller::create`. The kernel-internal
/// implementation bridges JS calls into this trait.
pub trait ResourceContext {
    /// Resolve a type reference (named string or inline schema as a `Value`)
    /// to a `DataValidator`. Mirrors the JS-side `ctx.createTypeValidator`.
    fn create_type_validator(&self, type_ref: &Value) -> Result<Box<dyn DataValidator>>;
}

/// Schema/type validator. Returned by `ResourceContext::create_type_validator`.
/// `validate` returns Ok when `data` conforms; otherwise an error whose
/// message describes the violation.
pub trait DataValidator {
    fn validate(&self, data: &Value) -> Result<()>;
}
