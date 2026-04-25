---
"@telorun/starlark": minor
---

Add a native Rust controller for `std/starlark`, opt-in via `runtime: rust` on a `Telo.Import`. Implementation lives at `modules/starlark/rust/` and is loaded by the kernel's `NapiControllerLoader` (delivered in the prior PR). The existing `nodejs` controller stays the kernel-native default — no change for manifests that don't set `runtime:`.

The Rust controller is currently a PoC scaffold using the new `telorun-sdk` Rust crate (in-tree, not yet published to crates.io): `#[controller]` is the only macro the author touches, and the controller crate is a textbook Rust project with no `use napi` or `#[napi]` in its source. Replacing the scaffold's invoke body with a real `starlark-rust` evaluation is the natural next step — the SDK and macro shape are final.

Schema and orchestration layers are untouched; this is purely a new implementation behind an existing definition.
