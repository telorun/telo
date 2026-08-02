//! The C ABI a Rust controller exposes to a Rust kernel.
//!
//! This crate exists so the two halves of the boundary — the controller side in
//! `telorun-sdk`'s native backend and the host side in `telo-kernel` — agree on
//! one layout instead of restating it. It carries no features and no
//! dependencies, which is the point: the kernel must be able to depend on the
//! ABI without dragging in `telorun-sdk`'s backend selection, or Cargo's feature
//! unification would compile the napi backend into the kernel binary and fail at
//! link time.
//!
//! Data crosses as UTF-8 JSON in [`TeloBuf`] buffers. Each side frees only the
//! buffers it allocated, through the `free` slot of its own vtable — mixing
//! allocators across a `cdylib` boundary is undefined behaviour.
//!
//! There is no Node counterpart to this crate: on the Node.js kernel the
//! equivalent contract is N-API, supplied by the runtime.

use std::ffi::c_void;

/// Bumped on any layout or semantic change to the structs below. The host
/// refuses a controller reporting a different version rather than reading a
/// mismatched vtable.
pub const TELO_ABI_VERSION: u32 = 2;

/// Status returned by fallible ABI calls: `0` on success, non-zero on failure
/// with the out-parameter holding a JSON `{"code","message"}` object.
pub const TELO_OK: i32 = 0;
pub const TELO_ERR: i32 = 1;

/// An owned byte buffer crossing the boundary. Always UTF-8 JSON in this ABI.
///
/// The allocating side also frees it: a buffer produced by the controller is
/// released through [`TeloController::free`], one produced by the host through
/// [`TeloHost::free`].
#[repr(C)]
pub struct TeloBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl TeloBuf {
    pub const fn empty() -> Self {
        Self {
            ptr: std::ptr::null_mut(),
            len: 0,
            cap: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.ptr.is_null() || self.len == 0
    }

    /// Hand ownership of `bytes` to the other side of the boundary.
    pub fn from_vec(bytes: Vec<u8>) -> Self {
        let mut bytes = std::mem::ManuallyDrop::new(bytes);
        Self {
            ptr: bytes.as_mut_ptr(),
            len: bytes.len(),
            cap: bytes.capacity(),
        }
    }

    /// Take ownership back. Only the side that allocated the buffer may call
    /// this — the allocator must match.
    ///
    /// # Safety
    /// `self` must be a buffer produced by [`TeloBuf::from_vec`] on this side of
    /// the boundary and not yet reclaimed.
    pub unsafe fn into_vec(self) -> Vec<u8> {
        if self.ptr.is_null() {
            return Vec::new();
        }
        Vec::from_raw_parts(self.ptr, self.len, self.cap)
    }

    /// Borrow the buffer's contents without taking ownership.
    ///
    /// # Safety
    /// `self` must point at `len` initialised bytes that outlive the borrow.
    pub unsafe fn as_slice(&self) -> &[u8] {
        if self.ptr.is_null() {
            return &[];
        }
        std::slice::from_raw_parts(self.ptr, self.len)
    }
}

/// Kernel-side capabilities a controller may call back into during `create` and
/// `invoke`. `ctx` is opaque to the controller and is passed back verbatim.
///
/// Deliberately small: the kernel — not the controller — owns invocation-contract
/// validation, so the only schema call here is resolving a *named* type reference
/// that the controller cannot see from its own manifest fragment.
#[repr(C)]
pub struct TeloHost {
    pub ctx: *mut c_void,
    /// Resolve a named `Telo.Type` reference to its JSON Schema. Writes the
    /// schema JSON into the out-parameter on [`TELO_OK`], an error object
    /// otherwise. The buffer belongs to the host.
    pub resolve_type:
        unsafe extern "C" fn(ctx: *mut c_void, name: *const u8, name_len: usize, out: *mut TeloBuf) -> i32,
    /// Cooperative cancellation poll for the invocation in flight.
    pub is_cancelled: unsafe extern "C" fn(ctx: *mut c_void) -> bool,
    /// Release a buffer the host allocated.
    pub free: unsafe extern "C" fn(buf: TeloBuf),
}

/// The vtable a controller `cdylib` exports.
///
/// One symbol per controller, named [`entry_symbol`]; it takes no arguments and
/// returns a pointer to a `'static` vtable. `invoke` and `snapshot` are optional
/// so a controller that implements neither is representable — the kernel reports
/// a precise error instead of calling into a stub.
#[repr(C)]
pub struct TeloController {
    pub abi_version: u32,
    /// Process-level init, called once before the first `create`.
    pub register: unsafe extern "C" fn(out_err: *mut TeloBuf) -> i32,
    /// Build one resource instance from its manifest JSON. Returns an opaque
    /// handle, or null with `out_err` populated.
    pub create: unsafe extern "C" fn(
        manifest: *const u8,
        manifest_len: usize,
        host: *const TeloHost,
        out_err: *mut TeloBuf,
    ) -> *mut c_void,
    pub invoke: Option<
        unsafe extern "C" fn(
            handle: *mut c_void,
            input: *const u8,
            input_len: usize,
            host: *const TeloHost,
            out: *mut TeloBuf,
        ) -> i32,
    >,
    pub snapshot: Option<unsafe extern "C" fn(handle: *mut c_void, out: *mut TeloBuf) -> i32>,
    /// Drop an instance produced by `create`.
    ///
    /// Fallible like every other slot: teardown can fail, and a host that cannot
    /// see the failure cannot report it. Returning it here is what keeps the
    /// controller side from having to discard the error to satisfy the ABI.
    pub destroy: unsafe extern "C" fn(handle: *mut c_void, out_err: *mut TeloBuf) -> i32,
    /// Release a buffer the controller allocated.
    pub free: unsafe extern "C" fn(buf: TeloBuf),
}

/// Exported symbol name for a controller entry.
///
/// The entry is the `#fragment` of the `pkg:cargo` PURL, mirroring the npm
/// loader's "one source file per controller, export name matches the file"
/// convention. A controller declared without an explicit entry also exports
/// `telo_controller__default`, which is what a fragment-less PURL resolves to.
pub fn entry_symbol(entry: &str) -> String {
    format!("telo_controller__{entry}")
}

/// The entry a `pkg:cargo` PURL with no `#fragment` resolves to.
pub const DEFAULT_ENTRY: &str = "default";
