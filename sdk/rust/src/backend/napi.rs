//! N-API backend: bridges the Rust [`Controller`] contract to JS-callable
//! exports via napi-rs. Active when the `napi` feature is enabled (the SDK's
//! default).

use napi::{Env, JsFunction, JsObject, JsUnknown, Ref};
use serde_json::Value;

use crate::error::ControllerError;
use crate::traits::{ControllerContext, DataValidator, ResourceContext, Result};

impl From<napi::Error> for ControllerError {
    fn from(err: napi::Error) -> Self {
        ControllerError::new("ERR_NAPI", err.reason)
    }
}

/// Convert a Rust [`ControllerError`] into a napi::Error so the JS side sees
/// a thrown Error with the original code+message preserved.
pub fn to_napi_error(err: ControllerError) -> napi::Error {
    napi::Error::new(
        napi::Status::GenericFailure,
        format!("[{}] {}", err.code, err.message),
    )
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
    pub fn new(env: Env, ctx_obj: JsObject) -> Result<Self> {
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
/// method so the user's controller code only ever sees `Value`.
pub fn js_to_value(env: &Env, val: JsUnknown) -> Result<Value> {
    let v: Value = env.from_js_value(val)?;
    Ok(v)
}

/// Convert `serde_json::Value` to a JS value.
pub fn value_to_js(env: &Env, val: &Value) -> Result<JsUnknown> {
    let js = env.to_js_value(val)?;
    Ok(js)
}
