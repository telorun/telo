//! The single dispatch chokepoint: everything that invokes a resource goes
//! through here, so contract checking cannot be bypassed by a new call site.
//! Mirrors `../../nodejs/src/invoke-dispatch.ts`.

use serde_json::Value;

use crate::controller_loaders::native_abi::host_vtable;
use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;

pub fn invoke(instance: &ResourceInstance, inputs: &Value) -> Result<Value, KernelError> {
    let prepared = instance.contract.prepare_inputs(inputs).map_err(|err| {
        KernelError::new(
            err.code.clone(),
            format!("resource '{}': {}", instance.name, err.message),
        )
    })?;
    let host = host_vtable();
    let result = instance.handle.invoke(&prepared, &host)?;
    instance.contract.check_output(&result).map_err(|err| {
        KernelError::new(
            err.code.clone(),
            format!("resource '{}': {}", instance.name, err.message),
        )
    })?;
    Ok(result)
}
