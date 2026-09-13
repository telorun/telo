//! N-API backend: bridges the Rust [`Controller`] contract to JS-callable
//! exports via napi-rs. Active when the `napi` feature is enabled.

use napi::{Env, JsError, JsFunction, JsObject, JsUnknown, Property, PropertyAttributes, Ref};
use serde_json::Value;

use crate::error::ControllerError;
use crate::invoke_context::{CancellationToken, InvokeContext};
use crate::traits::{ControllerContext, DataValidator, ResourceContext, Result};

impl From<napi::Error> for ControllerError {
    fn from(err: napi::Error) -> Self {
        ControllerError::new("ERR_NAPI", err.reason)
    }
}

/// Property the thrown JS error carries when it is a controller's OWN error,
/// which is what the Node loader keys on to re-raise it as an `InvokeError`.
/// Everything else the bridge can throw — a value napi cannot convert, a
/// napi-derive argument check — lacks it and stays a plain failure.
pub const CONTROLLER_ERROR_MARKER: &str = "teloControllerError";

/// The error thrown for a [`ControllerError`] a controller returned: a JS
/// `Error` whose `.code` is the controller's code and whose `.message` is its
/// plain message — the two fields the native ABI carries — marked with
/// [`CONTROLLER_ERROR_MARKER`]. Built here and thrown as that object, so napi
/// never derives anything from a status.
pub fn controller_error(env: &Env, err: ControllerError) -> napi::Error {
    match marked_error(env, &err) {
        Ok(raised) => napi::Error::from(raised),
        // A call back into JavaScript that threw leaves its exception pending,
        // which fails these calls, and napi then throws that exception instead
        // of this one. Otherwise nothing is dropped: the fallback still says
        // what was returned and why it could not be raised as such.
        Err(build) => napi::Error::new(
            napi::Status::GenericFailure,
            format!(
                "[{}] {} (not raised as a controller error: {})",
                err.code, err.message, build.reason
            ),
        ),
    }
}

fn marked_error(env: &Env, err: &ControllerError) -> napi::Result<JsUnknown> {
    let error = JsError::from(napi::Error::new(err.code.clone(), err.message.clone()))
        .into_unknown(*env);
    let mut object = error.coerce_to_object()?;
    object.define_properties(&[Property::new(CONTROLLER_ERROR_MARKER)?
        .with_value(&env.get_boolean(true)?)
        .with_property_attributes(PropertyAttributes::Default)])?;
    Ok(object.into_unknown())
}

/// Concrete `ControllerContext` for the napi backend. Reserved for future
/// methods; today register() takes a context but doesn't call into it.
pub struct NapiControllerContext;

impl ControllerContext for NapiControllerContext {}

/// Concrete `ResourceContext` backed by a JS `ResourceContext` object.
/// Holds an Env+Reference pair so it can call back into JS during create().
///
/// Refs are intentionally leaked at drop time: napi-rs's own `Ref<T>` has no
/// release-build Drop (it leaks in release and asserts in debug), and the
/// process-exit ordering between Rust drops and napi env teardown is
/// undefined — calling `unref` on a torn-down env segfaults Node. Resources
/// live for the kernel's lifetime, so the leak is bounded.
pub struct NapiResourceContext {
    env: Env,
    ctx_ref: Ref<()>,
}

impl NapiResourceContext {
    pub fn new(env: Env, ctx_obj: JsObject) -> napi::Result<Self> {
        let ctx_ref = env.create_reference(ctx_obj)?;
        Ok(Self { env, ctx_ref })
    }
}

impl ResourceContext for NapiResourceContext {
    fn create_type_validator(&self, type_ref: &Value) -> Result<Box<dyn DataValidator>> {
        let ctx_obj: JsObject = self.env.get_reference_value(&self.ctx_ref)?;
        let create_fn: JsFunction = ctx_obj.get_named_property("createTypeValidator")?;
        let arg = self.env.to_js_value(type_ref)?;
        let result: JsUnknown = create_fn.call(Some(&ctx_obj), &[arg])?;
        let validator_obj = result.coerce_to_object()?;
        let validator_ref = self.env.create_reference(validator_obj)?;
        Ok(Box::new(NapiDataValidator {
            env: self.env,
            validator_ref,
        }))
    }
}

/// Concrete `DataValidator` backed by a JS validator object with a `validate`
/// method. Same Drop policy as `NapiResourceContext` — Refs are leaked.
pub struct NapiDataValidator {
    env: Env,
    validator_ref: Ref<()>,
}

impl DataValidator for NapiDataValidator {
    fn validate(&self, data: &Value) -> Result<()> {
        let validator_obj: JsObject = self.env.get_reference_value(&self.validator_ref)?;
        let validate_fn: JsFunction = validator_obj.get_named_property("validate")?;
        let arg = self.env.to_js_value(data)?;
        // The JS validate() throws on invalid input — napi-rs converts the
        // thrown Error into Err(napi::Error), which our From impl maps to
        // ControllerError so the caller surfaces it as a controller error.
        validate_fn.call(Some(&validator_obj), &[arg])?;
        Ok(())
    }
}

/// Convert a JS value into `serde_json::Value` via napi-rs's serde-json
/// feature. The macro uses this on the input/output of every napi-bound
/// method so the user's controller code only ever sees `Value`. A failure is
/// napi's own error, thrown unmarked: the bridge refusing a value it cannot
/// represent (bytes, a stream, a function) is not an error the controller
/// returned.
pub fn js_to_value(env: &Env, val: JsUnknown) -> napi::Result<Value> {
    env.from_js_value(val)
}

/// Convert `serde_json::Value` to a JS value. Fails unmarked, like
/// [`js_to_value`].
pub fn value_to_js(env: &Env, val: &Value) -> napi::Result<JsUnknown> {
    env.to_js_value(val)
}

/// Build an [`InvokeContext`] whose token polls the JS `InvokeContext` object
/// passed as the invoke's second argument. Each `is_cancelled()` reads
/// `ctx.cancellation.isCancelled` (a getter) — a per-poll callback into JS,
/// valid for the synchronous duration of the controller's `invoke()`. With no
/// object (a direct napi call), the token is never cancelled.
pub fn invoke_context_from_js(ctx: Option<JsObject>) -> InvokeContext {
    match ctx {
        Some(obj) => InvokeContext {
            cancellation: CancellationToken::from_poll(move || poll_cancelled(&obj)),
        },
        None => InvokeContext::never(),
    }
}

fn poll_cancelled(ctx: &JsObject) -> bool {
    fn read(ctx: &JsObject) -> Result<bool> {
        let cancellation: JsObject = ctx.get_named_property("cancellation")?;
        let cancelled: bool = cancellation.get_named_property("isCancelled")?;
        Ok(cancelled)
    }
    // A read failure (shape drift, torn-down handle) defaults to "not cancelled"
    // rather than spuriously aborting live work.
    read(ctx).unwrap_or(false)
}
