//! Host side of the controller C ABI: turns a `cdylib` into something the
//! kernel can create resources from and dispatch into.
//!
//! No Node counterpart — the Node.js kernel's equivalent is N-API, supplied by
//! the runtime. The unsafe surface is confined to this file; everything above it
//! sees `Value` in and `Value` out.
//!
//! Ownership rules the ABI fixes and this file upholds: the library outlives
//! every handle taken from it (each [`ControllerHandle`] holds an `Rc` to the
//! [`LoadedController`]), and each side frees only its own buffers.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::rc::Rc;

use serde_json::Value;
use telorun_abi::{entry_symbol, TeloBuf, TeloController, TeloHost, TELO_ABI_VERSION, TELO_OK};

use crate::error::KernelError;

type EntryFn = unsafe extern "C" fn() -> *const TeloController;

pub struct LoadedController {
    /// Held for its lifetime effect: unloading the library would invalidate the
    /// vtable and every live handle.
    _library: libloading::Library,
    vtable: *const TeloController,
    purl: String,
}

impl LoadedController {
    /// Open `path` and read the vtable for `entry`.
    ///
    /// # Safety
    /// `path` must be a controller built against this ABI version; loading an
    /// arbitrary shared object and calling through its exports is the unsafe
    /// step this whole file exists to contain.
    pub unsafe fn open(path: &Path, entry: &str, purl: &str) -> Result<Rc<Self>, KernelError> {
        let library = unsafe { libloading::Library::new(path) }.map_err(|err| {
            KernelError::controller_invalid(format!(
                "failed to load controller library {}: {err}",
                path.display()
            ))
        })?;
        let symbol_name = entry_symbol(entry);
        let vtable = {
            let entry_fn: libloading::Symbol<EntryFn> = unsafe {
                library.get(symbol_name.as_bytes())
            }
            .map_err(|err| {
                KernelError::controller_invalid(format!(
                    "controller {} exports no entry `{entry}` (looked for symbol `{symbol_name}`): {err}",
                    path.display()
                ))
            })?;
            unsafe { entry_fn() }
        };
        if vtable.is_null() {
            return Err(KernelError::controller_invalid(format!(
                "controller entry `{entry}` in {} returned a null vtable",
                path.display()
            )));
        }
        let abi_version = unsafe { (*vtable).abi_version };
        if abi_version != TELO_ABI_VERSION {
            return Err(KernelError::controller_invalid(format!(
                "controller {} was built against ABI version {abi_version}, this kernel speaks {TELO_ABI_VERSION}. Rebuild the controller.",
                path.display()
            )));
        }
        let loaded = Rc::new(Self {
            _library: library,
            vtable,
            purl: purl.to_string(),
        });
        loaded.register()?;
        Ok(loaded)
    }

    fn vtable(&self) -> &TeloController {
        unsafe { &*self.vtable }
    }

    /// Process-level init, once per loaded library.
    fn register(&self) -> Result<(), KernelError> {
        let mut out = TeloBuf::empty();
        let status = unsafe { (self.vtable().register)(&mut out as *mut TeloBuf) };
        if status == TELO_OK {
            return Ok(());
        }
        Err(self.take_error(out, "register"))
    }

    pub fn create(
        self: &Rc<Self>,
        manifest: &Value,
        host: &TeloHost,
    ) -> Result<ControllerHandle, KernelError> {
        let bytes = serde_json::to_vec(manifest).map_err(|err| {
            KernelError::manifest_validation_failed(format!("manifest is not serializable: {err}"))
        })?;
        let mut out = TeloBuf::empty();
        let handle = unsafe {
            (self.vtable().create)(
                bytes.as_ptr(),
                bytes.len(),
                host as *const TeloHost,
                &mut out as *mut TeloBuf,
            )
        };
        if handle.is_null() {
            return Err(self.take_error(out, "create"));
        }
        Ok(ControllerHandle {
            controller: Rc::clone(self),
            handle,
        })
    }

    /// Whether this controller exposes an invoke entry point at all. Read from
    /// the vtable, so "this kind is not invocable" is answerable before dispatch.
    pub fn is_invocable(&self) -> bool {
        self.vtable().invoke.is_some()
    }

    pub fn purl(&self) -> &str {
        &self.purl
    }

    /// Copy a controller-allocated buffer out and hand it back to be freed.
    fn take_bytes(&self, buf: TeloBuf) -> Vec<u8> {
        let bytes = unsafe { buf.as_slice() }.to_vec();
        unsafe { (self.vtable().free)(buf) };
        bytes
    }

    /// Decode the `{code, message}` payload a failed call wrote.
    fn take_error(&self, buf: TeloBuf, operation: &str) -> KernelError {
        let bytes = self.take_bytes(buf);
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(payload) => {
                let code = payload
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("ERR_CONTROLLER")
                    .to_string();
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("controller reported no message")
                    .to_string();
                KernelError::new(code, message)
            }
            Err(_) => KernelError::controller_invalid(format!(
                "controller {} failed during {operation} and returned an undecodable error payload",
                self.purl
            )),
        }
    }
}

/// One resource instance living inside a loaded controller.
pub struct ControllerHandle {
    controller: Rc<LoadedController>,
    handle: *mut c_void,
}

impl ControllerHandle {
    pub fn invoke(&self, input: &Value, host: &TeloHost) -> Result<Value, KernelError> {
        let Some(invoke) = self.controller.vtable().invoke else {
            return Err(KernelError::new(
                "ERR_RESOURCE_NOT_INVOCABLE",
                format!(
                    "controller {} implements no invoke()",
                    self.controller.purl
                ),
            ));
        };
        let bytes = serde_json::to_vec(input).map_err(|err| {
            KernelError::input_invalid(format!("inputs are not serializable: {err}"))
        })?;
        let mut out = TeloBuf::empty();
        let status = unsafe {
            invoke(
                self.handle,
                bytes.as_ptr(),
                bytes.len(),
                host as *const TeloHost,
                &mut out as *mut TeloBuf,
            )
        };
        if status != TELO_OK {
            return Err(self.controller.take_error(out, "invoke"));
        }
        let payload = self.controller.take_bytes(out);
        serde_json::from_slice(&payload).map_err(|err| {
            KernelError::controller_invalid(format!(
                "controller {} returned an undecodable result: {err}",
                self.controller.purl
            ))
        })
    }
}

impl Drop for ControllerHandle {
    fn drop(&mut self) {
        let mut out = TeloBuf::empty();
        let status =
            unsafe { (self.controller.vtable().destroy)(self.handle, &mut out as *mut TeloBuf) };
        if status == TELO_OK {
            return;
        }
        // `Drop` cannot return, and unwinding out of it during another unwind
        // aborts — so this is reported to stderr rather than raised. Silence is
        // the one option not on the table.
        let err = self.controller.take_error(out, "destroy");
        eprintln!(
            "telo: controller {} failed to tear down resource: {err}",
            self.controller.purl
        );
    }
}

/// Build the callback table handed to a controller for one call.
///
/// `resolve_type` reports rather than guesses, and cancellation is always
/// "not cancelled": this kernel has no cancellation source yet, so a controller
/// that polls the token correctly sees the truth for a run that cannot be
/// cancelled.
pub fn host_vtable() -> TeloHost {
    TeloHost {
        ctx: std::ptr::null_mut(),
        resolve_type,
        is_cancelled,
        free: free_buf,
    }
}

// Every host callback is unwind-guarded for the same reason the SDK's shims are:
// these frames are entered from the controller's `extern "C"` code, and a panic
// crossing back would abort the process rather than fail the call.

unsafe extern "C" fn resolve_type(
    _ctx: *mut c_void,
    name: *const u8,
    name_len: usize,
    out: *mut TeloBuf,
) -> i32 {
    let message = catch_unwind(AssertUnwindSafe(|| {
        let requested = unsafe { std::slice::from_raw_parts(name, name_len) };
        let requested = String::from_utf8_lossy(requested);
        format!("named type '{requested}' cannot be resolved: this kernel has no type registry yet")
    }))
    .unwrap_or_else(|_| "the host panicked resolving a named type".to_string());
    if !out.is_null() {
        unsafe { *out = TeloBuf::from_vec(message.into_bytes()) };
    }
    telorun_abi::TELO_ERR
}

unsafe extern "C" fn is_cancelled(_ctx: *mut c_void) -> bool {
    false
}

unsafe extern "C" fn free_buf(buf: TeloBuf) {
    let _ = catch_unwind(AssertUnwindSafe(|| drop(unsafe { buf.into_vec() })));
}
