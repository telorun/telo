---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

A native function has a contract. `@telorun/sdk` exports `FunctionController`, `FunctionInstance`, `FunctionContext` and `ERR_FUNCTION_ASYNC`: a callable kind's controller receives a context offering only `resolveControllerFile`, `resolveNativeFile`, `log` and `effect`, and returns an instance whose `call(args)` is synchronous — a `call` returning a promise fails the TypeScript build. A kind that extends a native callable kind and inherits its controller, with `base:` or by merge, creates its ancestor's instance as any inheriting kind does.

The kernel binds every function's `call` — a `Telo.Function` as well as a native one — to its signature when it creates the instance, so every holder reaches the bound one: defaults fill (a fresh copy per call), declared scalars normalize, and arguments and result are validated (`ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`); anything else the function throws is `ERR_FUNCTION_FAILED` naming it as `<kind>/<name>`. A CEL call is bound and validated once. A promise returned at runtime is `ERR_FUNCTION_ASYNC`, and its later rejection is logged; a controller with no `create`, an instance with no `call` or an `async` `call` is `ERR_CONTROLLER_INVALID` naming the function. What `create` allocates through `ctx.effect` is released at teardown and reload. The analyzer exports `callableBodyField` and `parameterSchemaOf`, which the kernel uses to tell a native function from one written in CEL; `callArgumentBinding` gains `name`, and `bindNamed` leaves an omitted required parameter absent for validation to report.
