//! Native backend — the controller half of the C ABI a Rust kernel loads.
//!
//! Active with `--features native`. The `#[controller]` macro emits a `static`
//! [`TeloController`] vtable whose slots are the generic shims below, so the
//! author writes no FFI and the unsafe surface lives here once.
//!
//! Every shim catches unwinds: an `extern "C"` frame aborts the process on a
//! panic, which would take the kernel down with the controller. A panic is
//! reported as `ERR_CONTROLLER_PANIC` so the kernel can tell "the controller
//! itself crashed" from "user code returned an error".

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::Value;
use telorun_abi::{TeloBuf, TeloController, TeloHost, TELO_ABI_VERSION, TELO_ERR, TELO_OK};

use crate::error::ControllerError;
use crate::invoke_context::{CancellationToken, InvokeContext};
use crate::traits::{Controller, ControllerContext, DataValidator, ResourceContext, Result};

pub use telorun_abi::TeloController as Vtable;

/// Process-level context. Nothing crosses the ABI for `register` yet, so this
/// carries no state.
pub struct NativeControllerContext;

impl ControllerContext for NativeControllerContext {}

/// Per-resource context backed by the host's callback table.
///
/// Holds the raw `TeloHost` for the duration of one `create` call only — the
/// kernel owns the table and it is not valid past the call.
pub struct NativeResourceContext {
    host: *const TeloHost,
}

impl NativeResourceContext {
    /// # Safety
    /// `host` must be non-null and valid for the duration of the `create` call
    /// this context is passed to.
    pub unsafe fn new(host: *const TeloHost) -> Self {
        Self { host }
    }

    /// Ask the kernel for the JSON Schema behind a named `Telo.Type`.
    fn resolve_named_type(&self, name: &str) -> Result<Value> {
        let host = unsafe { &*self.host };
        let mut out = TeloBuf::empty();
        let status = unsafe {
            (host.resolve_type)(host.ctx, name.as_ptr(), name.len(), &mut out as *mut TeloBuf)
        };
        let bytes = unsafe { out.as_slice() }.to_vec();
        unsafe { (host.free)(out) };
        if status != TELO_OK {
            let message = String::from_utf8_lossy(&bytes).to_string();
            return Err(ControllerError::new("ERR_TYPE_NOT_FOUND", message));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
}

impl ResourceContext for NativeResourceContext {
    /// Resolve any of the forms a type field may take — a named reference, a
    /// resolved `{kind, name}` ref, an inline `{kind, schema}` declaration, or
    /// raw JSON Schema — to a compiled validator. Mirrors the analyzer's
    /// `resolveTypeFieldToSchema`.
    fn create_type_validator(&self, type_ref: &Value) -> Result<Box<dyn DataValidator>> {
        let schema = match type_ref {
            Value::String(name) => self.resolve_named_type(name)?,
            Value::Object(map) => match (map.get("schema"), map.get("name")) {
                (Some(schema), _) => schema.clone(),
                (None, Some(Value::String(name))) => self.resolve_named_type(name)?,
                _ => type_ref.clone(),
            },
            other => other.clone(),
        };
        Ok(Box::new(NativeDataValidator::compile(&schema)?))
    }
}

/// JSON Schema validator over the `jsonschema` crate.
pub struct NativeDataValidator {
    validator: jsonschema::Validator,
}

impl NativeDataValidator {
    pub fn compile(schema: &Value) -> Result<Self> {
        let validator = jsonschema::validator_for(schema)
            .map_err(|err| ControllerError::new("ERR_SCHEMA_INVALID", err.to_string()))?;
        Ok(Self { validator })
    }
}

impl DataValidator for NativeDataValidator {
    fn validate(&self, data: &Value) -> Result<()> {
        let messages: Vec<String> = self
            .validator
            .iter_errors(data)
            .map(|err| format!("{}: {}", err.instance_path(), err))
            .collect();
        if messages.is_empty() {
            return Ok(());
        }
        Err(ControllerError::new(
            "ERR_VALIDATION_FAILED",
            messages.join("; "),
        ))
    }
}

// ---------------------------------------------------------------------------
// ABI shims. Referenced as function pointers from the macro-emitted vtable.
// ---------------------------------------------------------------------------

/// Build the vtable for `C`. Called from the `static` the macro emits, so the
/// vtable's storage is the controller crate's, not a leak.
pub const fn vtable<C: Controller>(
    invoke: Option<
        unsafe extern "C" fn(*mut c_void, *const u8, usize, *const TeloHost, *mut TeloBuf) -> i32,
    >,
    snapshot: Option<unsafe extern "C" fn(*mut c_void, *mut TeloBuf) -> i32>,
) -> TeloController {
    TeloController {
        abi_version: TELO_ABI_VERSION,
        register: register::<C>,
        create: create::<C>,
        invoke,
        snapshot,
        destroy: destroy::<C>,
        free: free_buf,
    }
}

/// Release a buffer this crate allocated.
///
/// # Safety
/// `buf` must have been produced by [`TeloBuf::from_vec`] in this crate.
pub unsafe extern "C" fn free_buf(buf: TeloBuf) {
    drop(unsafe { buf.into_vec() });
}

/// # Safety
/// `out_err` must point at a writable [`TeloBuf`].
pub unsafe extern "C" fn register<C: Controller>(out_err: *mut TeloBuf) -> i32 {
    match guard(|| C::register(&NativeControllerContext)) {
        Ok(()) => TELO_OK,
        Err(err) => {
            unsafe { write_error(out_err, &err) };
            TELO_ERR
        }
    }
}

/// # Safety
/// `manifest` must point at `manifest_len` valid bytes, `host` at a live
/// [`TeloHost`], and `out_err` at a writable [`TeloBuf`].
pub unsafe extern "C" fn create<C: Controller>(
    manifest: *const u8,
    manifest_len: usize,
    host: *const TeloHost,
    out_err: *mut TeloBuf,
) -> *mut c_void {
    let result = guard(|| {
        let bytes = unsafe { std::slice::from_raw_parts(manifest, manifest_len) };
        let value: Value = serde_json::from_slice(bytes)?;
        let ctx = unsafe { NativeResourceContext::new(host) };
        C::create(value, &ctx)
    });
    match result {
        Ok(instance) => Box::into_raw(Box::new(instance)) as *mut c_void,
        Err(err) => {
            unsafe { write_error(out_err, &err) };
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `handle` must be a live instance produced by [`create`] for the same `C`,
/// `input` must point at `input_len` valid bytes, and `out` must be writable.
pub unsafe extern "C" fn invoke<C: Controller>(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
    host: *const TeloHost,
    out: *mut TeloBuf,
) -> i32 {
    let result = guard(|| {
        let instance = unsafe { &*(handle as *const C) };
        let bytes = unsafe { std::slice::from_raw_parts(input, input_len) };
        let value: Value = serde_json::from_slice(bytes)?;
        let ctx = unsafe { invoke_context(host) };
        instance.invoke(value, &ctx)
    });
    unsafe { write_result(out, result) }
}

/// # Safety
/// `handle` must be a live instance produced by [`create`] for the same `C`.
pub unsafe extern "C" fn snapshot<C: Controller>(handle: *mut c_void, out: *mut TeloBuf) -> i32 {
    let result = guard(|| {
        let instance = unsafe { &*(handle as *const C) };
        Ok(instance.snapshot())
    });
    unsafe { write_result(out, result) }
}

/// # Safety
/// `handle` must be a live instance produced by [`create`] for the same `C`,
/// and must not be used afterwards.
pub unsafe extern "C" fn destroy<C: Controller>(handle: *mut c_void, out_err: *mut TeloBuf) -> i32 {
    if handle.is_null() {
        return TELO_OK;
    }
    // A panic in `Drop` is reported, not discarded: teardown failing is exactly
    // the kind of thing a host needs to hear about, and the instance is gone
    // either way.
    match guard(|| {
        drop(unsafe { Box::from_raw(handle as *mut C) });
        Ok(())
    }) {
        Ok(()) => TELO_OK,
        Err(err) => {
            unsafe { write_error(out_err, &err) };
            TELO_ERR
        }
    }
}

/// Wire the host's cancellation poll into an [`InvokeContext`]. A null host
/// yields a token that never cancels rather than a dangling call.
unsafe fn invoke_context(host: *const TeloHost) -> InvokeContext {
    if host.is_null() {
        return InvokeContext::never();
    }
    let ctx = (*host).ctx;
    let poll = (*host).is_cancelled;
    // Raw pointers carry no lifetime, so the closure satisfies `'static`; the
    // token is documented as valid only for the duration of the call, which is
    // exactly how long the host guarantees the table.
    let ctx = ctx as usize;
    InvokeContext {
        cancellation: CancellationToken::from_poll(move || poll(ctx as *mut c_void)),
    }
}

/// Run a fallible body, converting a panic into a structured error rather than
/// letting it unwind into the host's frame.
fn guard<T>(body: impl FnOnce() -> Result<T>) -> Result<T> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(payload) => Err(ControllerError::new(
            "ERR_CONTROLLER_PANIC",
            panic_message(&payload),
        )),
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "controller panicked".to_string()
}

unsafe fn write_result(out: *mut TeloBuf, result: Result<Value>) -> i32 {
    match result {
        Ok(value) => {
            if out.is_null() {
                return TELO_OK;
            }
            let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"null".to_vec());
            *out = TeloBuf::from_vec(bytes);
            TELO_OK
        }
        Err(err) => {
            write_error(out, &err);
            TELO_ERR
        }
    }
}

unsafe fn write_error(out: *mut TeloBuf, err: &ControllerError) {
    if out.is_null() {
        return;
    }
    let payload = serde_json::json!({ "code": err.code, "message": err.message });
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
    *out = TeloBuf::from_vec(bytes);
}
