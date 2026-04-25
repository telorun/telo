//! Native (in-process pure-Rust) backend stub.
//!
//! Active when the `native` feature is enabled. Trait shapes are present so
//! that authors can `cargo check --features native --no-default-features` to
//! confirm their controller compiles for the future Rust kernel. Method
//! bodies are `unimplemented!()` because the Rust kernel that consumes this
//! backend doesn't exist yet — the SDK's job here is to lock the migration
//! shape, not to deliver a working native runtime.

use serde_json::Value;

use crate::error::ControllerError;
use crate::traits::{ControllerContext, DataValidator, ResourceContext, Result};

pub struct NativeControllerContext;

impl ControllerContext for NativeControllerContext {}

pub struct NativeResourceContext;

impl ResourceContext for NativeResourceContext {
    fn create_type_validator(&self, _type_ref: &Value) -> Result<Box<dyn DataValidator>> {
        unimplemented!("native backend is not implemented; rebuild with --features napi")
    }
}

pub struct NativeDataValidator;

impl DataValidator for NativeDataValidator {
    fn validate(&self, _data: &Value) -> Result<()> {
        unimplemented!("native backend is not implemented; rebuild with --features napi")
    }
}

pub fn _silence_unused_imports() {
    let _ = ControllerError::new("X", "Y");
}
