//! A controller whose failures are the controller's OWN errors, for asserting
//! how the Node kernel raises them: `create` fails when the resource sets
//! `failCreate: true`, and `invoke` fails with `ERR_FIXTURE` when its input
//! sets `fail: true`, otherwise returning the input unchanged.

use telorun_sdk::{
    controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value,
};

pub struct Probe;

#[controller]
impl Controller for Probe {
    fn create(manifest: Value, ctx: &dyn ResourceContext) -> Result<Self> {
        let _ = ctx;
        if manifest.get("failCreate") == Some(&Value::Bool(true)) {
            return Err(ControllerError::new(
                "ERR_FIXTURE_CREATE",
                "the probe was configured to fail at create",
            ));
        }
        Ok(Self)
    }

    fn invoke(&self, input: Value, ctx: &InvokeContext) -> Result<Value> {
        let _ = ctx;
        if input.get("fail") == Some(&Value::Bool(true)) {
            return Err(ControllerError::new(
                "ERR_FIXTURE",
                "the probe was asked to fail",
            ));
        }
        Ok(input)
    }
}
