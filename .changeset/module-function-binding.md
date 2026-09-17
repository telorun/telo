---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/templating": minor
"@telorun/analyzer": minor
---

Functions run. The kernel creates `Telo.Function` resources and any other callable resource, and binds every module call a resource's manifest makes — `Self.fn(…)`, `<ModuleName>.fn(…)`, `<Alias>.fn(…)` — when it creates that resource, before its compile-time fields evaluate, once per module scope per name. A call then evaluates wherever an expression does: a compile-time field, a step guard, a step, a template body (which calls through the library that defined the template). Two isolated imports of a library bind to two instances, a shared library to one. A `Telo.Function` body sees its parameters and the functions its module can call, nothing else; an omitted optional parameter takes its declared `default` or `null`. A function publishes no reading, so `resources.<name>` does not contain it.

A call is refused when its resource is created: `ERR_FUNCTION_UNRESOLVED` (nothing by that name), `ERR_FUNCTION_NOT_EXPORTED` (the imported library keeps it private), `ERR_FUNCTION_NOT_CALLABLE` (a resource that is not a function); a callee not yet initialized defers the caller like a pending reference, and a wrong argument count is `ERR_FUNCTION_ARITY_MISMATCH`. A function resource with a signature holding a required parameter after an optional one or a shape named as a bare string, a function named after a CEL macro, or an instance of a native function kind declaring `deterministic`, is refused at creation with `ERR_CALLABLE_DEFINITION_INVALID`, as `telo check` reports it. A `Telo.Function` declaring `deterministic` fails its kind's schema (`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`): a body's determinism is derived, never claimed.

Whatever a function throws fails the expression as `ERR_FUNCTION_FAILED`, carrying the function's qualified name and the thrown code and message. It is a new ambient code (`@telorun/sdk` exports `ERR_FUNCTION_FAILED` in `AMBIENT_CONTRACT_ERROR_CODES`): a `try:` or `catches:` can catch it, and a retry policy does not re-attempt it. A failed expression now keeps a coded error's code and data instead of rewrapping it as an uncoded error.

A call is a dependency of the resource making it, so editing a function in the entry module rebuilds its callers on reconcile; a kind definition in the impact set now reports `restartRequired`, since a kind registers once per kernel. `@telorun/templating` exports `MODULE_CALL_DISPATCH_KEY` and `ModuleCallDispatch`; `@telorun/analyzer` exports `callableInstanceIssues`.
