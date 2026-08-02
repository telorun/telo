//! Resource instances and the scope they resolve in.
//! Mirrors `../../nodejs/src/evaluation-context.ts`.
//!
//! The Node file is large because it also publishes `resources.<name>.*` for CEL
//! and folds observed state into it. This kernel has no expression engine, so
//! nothing reads a published snapshot and none is taken — `snapshot()` on the
//! ABI stays unused until CEL lands, at which point publication belongs here.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::controller_loaders::native_abi::ControllerHandle;
use crate::controller_registry::Definition;
use crate::error::KernelError;
use crate::invocation_contract_binding::InvocationContract;

/// A live resource: the controller handle plus the call signature bound to it.
///
/// Binding at construction is deliberate — the kernel's single
/// instance-production site is the only place that can guarantee an instance is
/// never observable without its contract.
pub struct ResourceInstance {
    pub name: String,
    pub kind: String,
    pub definition: Rc<Definition>,
    pub contract: InvocationContract,
    pub handle: ControllerHandle,
}

#[derive(Default)]
pub struct EvaluationContext {
    resources: RefCell<HashMap<String, Rc<ResourceInstance>>>,
}

impl EvaluationContext {
    pub fn set_resource(&self, instance: Rc<ResourceInstance>) {
        self.resources
            .borrow_mut()
            .insert(instance.name.clone(), instance);
    }

    pub fn get_resource(&self, name: &str) -> Option<Rc<ResourceInstance>> {
        self.resources.borrow().get(name).cloned()
    }

    pub fn require_resource(&self, name: &str) -> Result<Rc<ResourceInstance>, KernelError> {
        self.get_resource(name).ok_or_else(|| {
            KernelError::resource_not_found(format!("resource '{name}' is not declared"))
        })
    }
}
