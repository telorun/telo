//! Native functions for the Rust function contract's tests: a comparison of two
//! timestamps, a byte echo, a function that panics, and one whose `Drop` leaves
//! a marker file so its destruction is observable from outside the process.

use serde::Deserialize;
use telorun_sdk::{function, Bytes, Function, FunctionContext, Result, Timestamp, Value};

pub struct IsBefore;

#[derive(Deserialize)]
pub struct Instants {
    pub a: Timestamp,
    pub b: Timestamp,
}

#[function(entry = "is_before")]
impl Function for IsBefore {
    type Config = Value;
    type Args = Instants;
    type Output = bool;

    fn create(_config: Value, ctx: &dyn FunctionContext) -> Result<Self> {
        ctx.log(9, "is_before created")?;
        Ok(IsBefore)
    }

    fn call(&self, args: Instants) -> Result<bool> {
        Ok(args.a < args.b)
    }
}

pub struct EchoBytes;

#[derive(Deserialize)]
pub struct Data {
    pub data: Bytes,
}

#[function(entry = "echo_bytes")]
impl Function for EchoBytes {
    type Config = Value;
    type Args = Data;
    type Output = Bytes;

    fn create(_config: Value, _ctx: &dyn FunctionContext) -> Result<Self> {
        Ok(EchoBytes)
    }

    fn call(&self, args: Data) -> Result<Bytes> {
        Ok(args.data)
    }
}

pub struct Explode;

#[function(entry = "explode")]
impl Function for Explode {
    type Config = Value;
    type Args = Value;
    type Output = bool;

    fn create(_config: Value, _ctx: &dyn FunctionContext) -> Result<Self> {
        Ok(Explode)
    }

    fn call(&self, _args: Value) -> Result<bool> {
        panic!("the explode fixture always panics")
    }
}

pub struct Marked {
    marker: String,
}

#[derive(Deserialize)]
pub struct MarkedConfig {
    pub marker: String,
}

#[function(entry = "marked")]
impl Function for Marked {
    type Config = MarkedConfig;
    type Args = Value;
    type Output = String;

    fn create(config: MarkedConfig, _ctx: &dyn FunctionContext) -> Result<Self> {
        Ok(Marked { marker: config.marker })
    }

    fn call(&self, _args: Value) -> Result<String> {
        Ok(self.marker.clone())
    }
}

impl Drop for Marked {
    fn drop(&mut self) {
        std::fs::write(&self.marker, b"dropped").expect("the drop marker is writable");
    }
}
