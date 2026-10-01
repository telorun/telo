---
"@telorun/analyzer": patch
"@telorun/kernel": patch
---

A value written through a tag is no longer judged against value constraints it cannot satisfy before it exists. `telo check` and the kernel's create-time validation judge a `!cel` value not at all, and an `!interpolate`, `!include-*` or `!module-path` value only for the type the tag produces: a correct `!interpolate` at a slot declaring `minLength`, `pattern` or `format` (an argument at a call site, a resource's own field such as `OTLP.Sink.timeout`, `Timer.Delay`'s `duration`) and a `!cel` object passed into a contract whose members declare `format` or `pattern` now check and run, where they were refused with `CONTRACT_INPUTS_MISMATCH` / `SCHEMA_VIOLATION` or `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`. A string tag at an `integer` slot is still refused, and a `!literal` is judged by its text. When the kernel refuses a resource holding an expression, it names the remaining finding rather than the first error its validator met.
