//! A controller probing the SDK's napi bridge: its failures are the controller's
//! OWN errors, for asserting how the Node kernel raises them — `create` fails
//! when the resource sets `failCreate: true`, and `invoke` fails with
//! `ERR_FIXTURE` when its input sets `fail: true`. An input setting
//! `numbers: true` returns integers on each side of the bounds a JS number holds
//! exactly, for asserting which reach the kernel as numbers. Otherwise `invoke`
//! returns the input unchanged.

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
        if input.get("numbers") == Some(&Value::Bool(true)) {
            return Ok(serde_json::json!({
                "numbers": {
                    "small": 7,
                    "negative": -7,
                    "aboveU32": 4_294_967_296u64,
                    "maxSafe": 9_007_199_254_740_991i64,
                    "aboveSafe": 9_007_199_254_740_993i64,
                    "belowNegativeSafe": -9_007_199_254_740_993i64,
                }
            }));
        }
        Ok(input)
    }
}
