---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

A controller can name the kernel instance that owns its resource: `ctx.kernelInstanceId` is an opaque string, unique in the process, fixed for the kernel's whole life (a reconcile keeps it) and never reused, and a child manifest started through `ctx.runtime.run` or `App.Instance` has one of its own. In-process state every resource of one application must share is keyed by it rather than held module-global, since one process may run several kernels over the same controller bundle. The Rust SDK reads it as `ResourceContext::kernel_instance_id()`, `None` from a host that carries none (a kernel released before it, and the Rust kernel, whose `abi=telo-3` carries no session). The controller protocol now states that a session is one kernel instance for its whole life and is what a controller keys such state by.
