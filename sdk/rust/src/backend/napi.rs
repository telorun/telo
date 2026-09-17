//! N-API backend: bridges the Rust [`Controller`] contract to JS-callable
//! exports via napi-rs. Active when the `napi` feature is enabled.

use napi::{Env, JsError, JsFunction, JsObject, JsUnknown, Property, PropertyAttributes, Ref};
use serde_json::Value;

use crate::error::{guard, ControllerError};
use crate::function_controller::{wire as function_wire, Function, FunctionContext};
use crate::invoke_context::{CancellationToken, InvokeContext};
use crate::logging::SeverityNumber;
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
        let arg = value_to_js(&self.env, type_ref)?;
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
        let arg = value_to_js(&self.env, data)?;
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

/// The largest integer a JS number holds exactly, `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Convert `serde_json::Value` to a JS value. Fails unmarked, like
/// [`js_to_value`].
///
/// An integer within ±(2^53−1) is a number and any other is a `BigInt`, whatever
/// its sign — one rule, where napi's serializer makes a positive integer above
/// `u32::MAX` a `BigInt` and leaves a negative one a number.
pub fn value_to_js(env: &Env, val: &Value) -> napi::Result<JsUnknown> {
    Ok(match val {
        Value::Null => env.get_null()?.into_unknown(),
        Value::Bool(b) => env.get_boolean(*b)?.into_unknown(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i.unsigned_abs() <= MAX_SAFE_INTEGER {
                    env.create_int64(i)?.into_unknown()
                } else {
                    env.create_bigint_from_i64(i)?.into_unknown()?
                }
            } else if let Some(u) = n.as_u64() {
                env.create_bigint_from_u64(u)?.into_unknown()?
            } else {
                let f = n.as_f64().expect("a JSON number is an integer or a double");
                env.create_double(f)?.into_unknown()
            }
        }
        Value::String(s) => env.create_string(s)?.into_unknown(),
        Value::Array(items) => {
            let mut array = env.create_array_with_length(items.len())?;
            for (index, item) in items.iter().enumerate() {
                let index = u32::try_from(index).map_err(|_| {
                    napi::Error::new(napi::Status::InvalidArg, "an array longer than 2^32-1 elements")
                })?;
                array.set_element(index, value_to_js(env, item)?)?;
            }
            array.into_unknown()
        }
        Value::Object(members) => {
            let mut object = env.create_object()?;
            for (key, member) in members {
                object.set_named_property(key, value_to_js(env, member)?)?;
            }
            object.into_unknown()
        }
    })
}

/// The function context backed by the JS `FunctionContext` object `create`
/// received, valid for the synchronous duration of that call.
pub struct NapiFunctionContext<'a> {
    env: &'a Env,
    ctx: &'a JsObject,
}

impl<'a> NapiFunctionContext<'a> {
    pub fn new(env: &'a Env, ctx: &'a JsObject) -> Self {
        Self { env, ctx }
    }
}

impl FunctionContext for NapiFunctionContext<'_> {
    fn log(&self, severity: SeverityNumber, message: &str) -> Result<()> {
        let logger: JsObject = self.ctx.get_named_property("log")?;
        let log: JsFunction = logger.get_named_property("log")?;
        let severity = self.env.create_int64(severity)?.into_unknown();
        let message = self.env.create_string(message)?.into_unknown();
        log.call(Some(&logger), &[severity, message])?;
        Ok(())
    }
}

/// Build a function instance from its resource's plain JSON — the body of the
/// `create` a `#[function]` bridge exports, with a panic reported as
/// `ERR_CONTROLLER_PANIC`.
pub fn create_function<F: Function>(env: &Env, config_json: &str, ctx: &JsObject) -> Result<F> {
    guard(|| {
        let config = function_wire::config::<F>(config_json.as_bytes())?;
        F::create(config, &NapiFunctionContext::new(env, ctx))
    })
}

/// Call a function instance with the typed frame of its arguments, returning the
/// typed frame of its result — the body of the bridge's `callFrame`.
pub fn call_function<F: Function>(instance: Option<&F>, args_frame: &str) -> Result<String> {
    guard(|| {
        let instance = instance.ok_or_else(|| {
            ControllerError::new("ERR_FUNCTION_DESTROYED", "the function instance was destroyed and cannot be called")
        })?;
        function_wire::call(instance, args_frame.as_bytes())
    })
}

/// Drop a function instance the garbage collector released before the kernel
/// destroyed it. There is no caller to hand a failure to, and a panic unwinding
/// into the collector's finalizer aborts the process, so a panic in its `Drop`
/// is caught and written to stderr — the one place left to report it.
pub fn finalize_function<F: Function>(instance: Option<F>) {
    if instance.is_none() {
        return;
    }
    if let Err(err) = destroy_function(instance) {
        eprintln!(
            "telo: a Rust function released by the garbage collector without being destroyed failed in its Drop: {err}"
        );
    }
}

/// Drop a function instance, reporting a panic in its `Drop`.
pub fn destroy_function<F: Function>(instance: Option<F>) -> Result<()> {
    guard(|| {
        drop(instance);
        Ok(())
    })
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
