# Telo SDK (Rust)

The Rust SDK provides the authoring surface for Telo controllers written in Rust. It defines the shared contracts (traits and lifecycle types) that controllers use to plug into the kernel, so module code stays consistent across languages.

## What It Provides

> **Status:** PoC scaffold. The shape is the final design — future Rust controllers use this infrastructure unchanged. The `native` backend is a stub until the pure-Rust kernel ships.

- **Controller trait** (`Controller`) — author-facing contract with `register`, `create`, `invoke`, and `snapshot` hooks. Implement on your struct, add `#[controller]` to the impl block, and the SDK generates the FFI bindings.
- **Resource context** (`ResourceContext`) — per-resource handle passed to `create`. Today exposes `create_type_validator(type_ref)` for resolving named or inline schemas into a `DataValidator`.
- **Schema validation** (`DataValidator`) — `validate(data)` returns `Ok(())` when the value conforms, otherwise a structured error.
- **Shared error type** (`ControllerError`) — carries `code` + `message`; the kernel surfaces `code` as the structured error code.
- **Data exchange** — `serde_json::Value` is the universal payload type, re-exported as `telorun_sdk::Value`.

Author principle: Rust developers write Rust, nothing else. A controller crate is `Cargo.toml` + `src/*.rs` — no `build.rs`, no `package.json`, no JS tooling, no awareness of which kernel will load it.

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

Place this in `modules/<your-name>/rust/src/lib.rs` and reference it from your module's `telo.yaml`:

```yaml
controllers:
  - pkg:cargo/<your-cargo-name>?local_path=./rust
```

## When to Use It

Use the SDK when building or extending Telo controllers in Rust. It is not the kernel itself; it is the contract layer that keeps controller behavior consistent across the polyglot runtime.

The SDK ships two backends, gated by Cargo features:

- `napi` (default) — N-API bindings for today's Node.js kernel.
- `native` (stub) — placeholder for the future pure-Rust kernel. Trait shapes are present so `cargo check --features native --no-default-features` confirms your controller compiles for both.

The kernel's loader picks the backend at build time. **Your controller's source and `Cargo.toml` do not change** — backend selection is injected via `--features`. When the kernel is rewritten in Rust, controllers port over without source edits: the `Controller` trait, `serde_json::Value`, and the `#[cfg(feature = "native")]` branch all stay put.

Today the SDK covers `Telo.Runnable` / `Telo.Invocable` capabilities. `Service`, `Mount`, and `Provider` are not yet in the trait set and are added as controllers need them.

## Errors

Telo distinguishes two kinds of failure from an `Invocable` / `Runnable`:

- **Operational failures** — anything other than a declared domain error. In the current Rust surface, this is any `ControllerError` whose `code` is not declared in the controller's `Telo.Definition`, plus panics, I/O failures, validator rejections (`ERR_VALIDATION_FAILED`), and serde errors (`ERR_JSON`). These propagate to the kernel's infrastructure layer (HTTP → Fastify 5xx, sequence → bubbles up) and represent bugs or environment failure.
- **Domain failures** — errors whose `code` is part of the invocable's public contract (e.g. `UNAUTHORIZED`, `EXPIRED`). Route handlers match on the code via `catches:` entries; sequences handle them in `try`/`catch`. The Node.js SDK exposes a dedicated `InvokeError` type for this channel; the Rust SDK uses `ControllerError` with a declared `code` for now, and will gain a structured-error type matching the Node.js shape as the channel solidifies on the Rust side.

```rust
use telorun_sdk::{ControllerError, Result, Value};

fn verify(token: &str) -> Result<Value> {
    if token.is_empty() {
        return Err(ControllerError::new(
            "UNAUTHORIZED",
            "Token missing or invalid",
        ));
    }
    Ok(Value::Null)
}
```

Controllers that return domain errors **must** declare their codes in their `Telo.Definition`:

```yaml
kind: Telo.Definition
metadata: { name: VerifyToken }
capability: Telo.Invocable
throws:
  codes:
    UNAUTHORIZED: { description: Missing or invalid token. }
    EXPIRED:
      description: Token is past its expires_at.
      data:
        type: object
        properties:
          expiredAt: { type: string, format: date-time }
        required: [expiredAt]
```

Undeclared codes emit an `${kind}.${name}.InvokeRejected.Undeclared` observability event — the analyzer catches these statically, regardless of which SDK the controller is written in.

Composers that propagate rather than originate codes can declare:

```yaml
throws:
  inherit: true   # union of everything I call (requires x-telo-step-context)
  # or
  passthrough: true   # union is whatever my inputs.code resolves to (Run.Throw-style)
```

`inherit` is driven by the analyzer's dataflow pass over `x-telo-step-context` arrays. See [modules/run/docs/structured-errors.md](../../modules/run/docs/structured-errors.md) for the end-to-end flow.
