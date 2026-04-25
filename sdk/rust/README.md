# telorun-sdk

Rust SDK for authoring Telo controllers.

> **Status:** PoC scaffold. The shape is the final design — future Rust controllers use this infrastructure unchanged. The `native` backend is a stub until the pure-Rust kernel ships.

## Author principle

Rust developers write Rust, nothing else. A controller crate is `Cargo.toml` + `src/*.rs`. No `build.rs`, no `package.json`, no JS tooling, no awareness of which kernel will load it.

The author writes pure trait code; `#[controller]` generates everything FFI-related.

## Minimal example

```rust
use telorun_sdk::{controller, Controller, ResourceContext, Result, Value};

pub struct MyController {
    code: String,
}

#[controller]
impl Controller for MyController {
    fn create(manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(MyController {
            code: manifest["code"].as_str().unwrap_or("").to_string(),
        })
    }

    fn invoke(&self, input: Value) -> Result<Value> {
        Ok(serde_json::json!({ "echoed": input }))
    }
}
```

That's the full author surface. Place this in `modules/<your-name>/rust/src/lib.rs` and add the corresponding entry to your module's `telo.yaml`:

```yaml
controllers:
  - pkg:cargo/<your-cargo-name>?local_path=./rust
```

## Backends

The SDK ships two backends, gated by Cargo features:

- `napi` (default) — N-API bindings for the Node.js kernel.
- `native` (stub) — placeholder for the future pure-Rust kernel. Trait shapes are present so `cargo check --features native --no-default-features` confirms your controller compiles for both.

The kernel's loader picks the backend at build time. **Your controller's source and `Cargo.toml` do not change** — backend selection is injected via `--features`.

## Forward-compatibility

When the kernel is rewritten in Rust, controllers built on this SDK port over with zero changes:

- The `Controller` trait shape stays the same.
- `serde_json::Value` remains the data exchange type.
- The `#[cfg(feature = "native")]` branch keeps compiling in CI.

## What's intentionally minimal

- Only `ResourceContext::create_type_validator` and `DataValidator::validate` are modeled — what the starlark PoC needed. Other methods are added when a controller needs them.
- Only `Telo.Runnable` / `Telo.Invocable` capabilities are supported. `Service`, `Mount`, `Provider` are not yet in the trait set.
- The `native` backend's bodies are `unimplemented!()`. The Rust kernel doesn't exist yet; the SDK's job here is to lock the migration shape.

## Layout

```
sdk/rust/
├── Cargo.toml         # default = ["napi"]
├── macros/            # proc-macro crate (#[controller])
└── src/
    ├── lib.rs         # public API
    ├── traits.rs      # Controller, ResourceContext, DataValidator
    ├── error.rs       # ControllerError
    └── backend/
        ├── napi.rs    # #[cfg(feature = "napi")]
        └── native.rs  # #[cfg(feature = "native")] — stubs
```
