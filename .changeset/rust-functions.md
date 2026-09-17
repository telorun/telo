---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

A native function can be written in Rust. The Node kernel loads a `pkg:cargo` function built with the Rust SDK's `#[function(entry = "…")]`: its entry namespace exports `createFunction`, the instance is created as an effect of the resource's `create` — so teardown and reload destroy it and its `Drop` runs then — and every call crosses as typed frames, so a timestamp written at `+02:00` compares with a later `Z` one as an instant and bytes arrive byte for byte. A panic fails the calling expression as `ERR_FUNCTION_FAILED` carrying `ERR_CONTROLLER_PANIC`. A configuration its `Config` type cannot read fails creation with `ERR_FUNCTION_CONFIG_INVALID`; an `entry` that is not ASCII letters, digits and underscores is a compile error naming the attribute; and a panic in `Drop` for an instance the garbage collector releases undestroyed is written to stderr rather than aborting the process.

The Rust controller ABI moves to version 3, which adds the function vtable: a prebuilt `pkg:telo/local/dylib` candidate states `abi=telo-3`, and a dylib built against version 2 is refused when the Rust kernel opens it. `CONTROLLER_DYLIB_ABI_MISSING` and the `abi` axis examples name `telo-3`.
