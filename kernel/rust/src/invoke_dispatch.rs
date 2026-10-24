//! The single dispatch chokepoint: everything that invokes a resource goes
//! through here, so contract checking cannot be bypassed by a new call site.
//! Mirrors `../../nodejs/src/invoke-dispatch.ts`.

use serde_json::Value;

use crate::controller_loaders::native_abi::host_vtable;
use crate::declared_display_messages::settle_display_message;
use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;

/// Every failure leaving the dispatch gets the display message its kind declares for its
/// code (or an ambient code's built-in one), its data held to the declared
/// schema — the one exit point, as in the Node kernel's dispatch chokepoint.
pub fn invoke(instance: &ResourceInstance, inputs: &Value) -> Result<Value, KernelError> {
    dispatch(instance, inputs).map_err(|err| {
        settle_display_message(
            err,
            &instance.definition.declared_display_messages,
            &format!("{} '{}'", instance.kind, instance.name),
        )
    })
}

fn dispatch(instance: &ResourceInstance, inputs: &Value) -> Result<Value, KernelError> {
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
