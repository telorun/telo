# Telo SDK (Rust)

The Rust SDK provides the authoring surface for Telo controllers written in Rust. It defines the shared contracts (traits and lifecycle types) that controllers use to plug into the kernel, so module code stays consistent across languages.

## What It Provides

> **Status:** Both backends are implemented. `napi` loads a controller into the Node.js kernel; `native` loads one into the Rust kernel (`kernel/rust`) over the C ABI in `telorun-abi`.

- **Controller trait** (`Controller`) — author-facing contract with `register`, `create`, `invoke`, and `snapshot` hooks. Implement on your struct, add `#[controller]` to the impl block, and the SDK generates the FFI bindings.
- **Resource context** (`ResourceContext`) — per-resource handle passed to `create`. Today exposes `create_type_validator(type_ref)` for resolving named or inline schemas into a `DataValidator`.
- **Schema validation** (`DataValidator`) — `validate(data)` returns `Ok(())` when the value conforms, otherwise a structured error.
- **Shared error type** (`ControllerError`) — carries `code` + `message`; the kernel surfaces `code` as the structured error code.
- **Data exchange** — `serde_json::Value` is the universal payload type, re-exported as `telorun_sdk::Value`.

Author principle: Rust developers write Rust, nothing else. A controller crate is `Cargo.toml` + `src/*.rs` — no `build.rs`, no `package.json`, no JS tooling, no awareness of which kernel will load it.

```rust
use telorun_sdk::{controller, Controller, InvokeContext, ResourceContext, Result, Value};

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

    fn invoke(&self, input: Value, ctx: &InvokeContext) -> Result<Value> {
        if ctx.cancellation.is_cancelled() {
            return Ok(Value::Null);
        }
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

- `napi` — N-API bindings for the Node.js kernel.
- `native` — a C-ABI vtable export for the Rust kernel, defined in [`abi/`](https://github.com/telorun/telo/tree/main/sdk/rust/abi).

**There is no default backend, deliberately.** A controller crate carries no `[features]` block, so the backend can only be chosen from outside it — and `--no-default-features` on that build would apply to the *controller* crate, not to this dependency. Each kernel therefore selects one as a dependency feature when it builds the crate:

| Kernel   | Build invocation                                            |
| -------- | ----------------------------------------------------------- |
| Node.js  | `cargo build --release --features telorun-sdk/napi`          |
| Rust     | `cargo build --release --features telorun-sdk/native`        |

A bare `cargo check` / `cargo clippy` / rust-analyzer run compiles the traits and your `impl` with no bridge at all, which is what keeps the inner loop working on a fresh clone.

**Your controller's source and `Cargo.toml` do not change between kernels.** The `Controller` trait and `serde_json::Value` are backend-independent; only the generated bridge differs.

`#[controller]` takes an optional `entry` naming the exported controller, which is what a `pkg:cargo` PURL's `#fragment` selects:

```rust
#[controller(entry = "writeline_controller")]
impl Controller for WriteLine { /* … */ }
```

Omit it and the entry defaults to the snake_case of the type, *and* the crate's `default` entry is exported — the one a fragment-less PURL resolves to. Two entry-less controllers in one crate collide at link time, which is the right failure: only one can be "the crate's controller".

The entry means the same thing on both backends. Natively it names the exported C symbol; under napi it becomes the export *namespace*, so the Node loader projects `module.<entry>.create`. That is also what lets one crate carry several controllers under napi, where every bridge would otherwise export a flat `create` / `register`.

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

`inherit` is driven by the analyzer's dataflow pass over `x-telo-step-context` arrays. See [modules/run/docs/structured-errors.md](https://github.com/telorun/telo/blob/main/modules/run/docs/structured-errors.md) for the end-to-end flow.
