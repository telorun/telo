# Telo SDK (Rust)

The Rust SDK provides the authoring surface for Telo controllers written in Rust. It defines the shared contracts (traits and lifecycle types) that controllers use to plug into the kernel, so module code stays consistent across languages.

## What It Provides

> **Status:** Both backends are implemented. `napi` loads a controller into the Node.js kernel; `native` loads one into the Rust kernel (`kernel/rust`) over the C ABI in `telorun-abi`.

- **Controller trait** (`Controller`) — author-facing contract with `register`, `create`, `invoke`, and `snapshot` hooks. Implement on your struct, add `#[controller]` to the impl block, and the SDK generates the FFI bindings.
- **Resource context** (`ResourceContext`) — per-resource handle passed to `create`. Today exposes `create_type_validator(type_ref)` for resolving named or inline schemas into a `DataValidator`.
- **Schema validation** (`DataValidator`) — `validate(data)` returns `Ok(())` when the value conforms, otherwise a structured error.
- **Shared error type** (`ControllerError`) — carries `code` + `message`; the kernel surfaces `code` as the structured error code.
- **Data exchange** — `serde_json::Value` is the universal payload type, re-exported as `telorun_sdk::Value`.
- **CEL value types** (`Timestamp`, `Duration`, `Bytes`, `Uint64`) — the CEL types JSON has no number or string for. Each implements serde's `Serialize` / `Deserialize`: it writes its plain encoding (RFC 3339 text in UTC with milliseconds, seconds such as `"5400s"`, base64url, digits) and reads either that or the typed frame's tagged form. A `Timestamp` holds an instant to the millisecond and compares as an instant, whatever offset it was written with. A plain `i64` is a CEL `int`; a CEL `uint` is `Uint64`.
- **Typed frame** (`typed_frame`) — `to_frame` / `from_frame` carry any serde value through the frame internal boundaries use (`kernel/specs/durable-execution.md` §6), byte-identical to the Node SDK on the shared conformance vectors; `CelValue` is the value domain it is defined over.
- **No plain JSON writer.** The Node SDK's `plain-json.ts`, the writer for readers outside Telo, has no Rust twin: nothing in the Rust half writes to such a reader. A Rust controller that serializes a value for one itself goes through `serde_json`, which differs from the Node writer on doubles — NaN and ±Infinity become `null` (Node writes `"NaN"`, `"Infinity"`, `"-Infinity"`) and a negative zero stays `-0.0` (Node writes `0`).

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

## Functions

A callable kind (`capability: Telo.Callable` with `controllers:`) is implemented by the `Function` trait: `Config`, `Args` and `Output` are your own serde types, `create(config, ctx)` builds one instance per resource, and `call(&self, args)` answers one CEL call — synchronously, since a CEL expression has nowhere to wait. `#[function(entry = "…")]` exports it under the entry a PURL's `#fragment` names; the entry defaults to the snake_case of the type.

```rust
use serde::Deserialize;
use telorun_sdk::{function, Function, FunctionContext, Result, Timestamp, Value};

pub struct IsBefore;

#[derive(Deserialize)]
pub struct Instants { a: Timestamp, b: Timestamp }

#[function(entry = "is_before")]
impl Function for IsBefore {
    type Config = Value;
    type Args = Instants;
    type Output = bool;

    fn create(_config: Value, _ctx: &dyn FunctionContext) -> Result<Self> { Ok(IsBefore) }
    fn call(&self, args: Instants) -> Result<bool> { Ok(args.a < args.b) }
}
```

```yaml
controllers:
  - pkg:cargo/<your-cargo-name>?local_path=./rust#is_before
```

`FunctionContext` offers logging and nothing else. What `create` allocates is released by `Drop`: the kernel destroys the instance at teardown and on reload. The configuration crosses as the resource's plain JSON, and arguments and results as typed frames, so a timestamp, an int64, a `Uint64` or `Bytes` keeps its CEL type both ways; the Node kernel has already filled defaults and validated the arguments against the declared `params`, and validates the result against `returns`. An `Err` or a panic fails the calling expression as `ERR_FUNCTION_FAILED`, carrying your code — `ERR_CONTROLLER_PANIC` for a panic. A configuration the kind's schema accepted but your `Config` type cannot read fails creation with `ERR_FUNCTION_CONFIG_INVALID`: the schema and the type disagree. An `entry` must be ASCII letters, digits and underscores, or the attribute is a compile error. An instance the garbage collector releases before the kernel destroyed it still runs `Drop`; a panic there is written to stderr, since there is no caller left to report it to.

Natively a function is the `telo_function__<entry>` symbol returning `telorun-abi`'s `TeloFunction` vtable (`create`, `call`, `destroy`, `free`, with a `TeloFunctionHost` whose one slot is `log`), part of ABI version 3 (`abi=telo-3`). The Rust kernel evaluates no CEL, so it hosts no functions; under napi the entry is a namespace exporting `createFunction`.

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

Under napi, an integer in a `Value` your controller returns reaches the Node.js kernel as a JavaScript number when it lies within ±(2^53−1), and as a `BigInt` — a CEL `int` — beyond it, whatever its sign, so no integer arrives rounded.

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

A `ControllerError` your controller returns crosses to either kernel as two fields, never as text. The Rust kernel reads `code` and `message` from the C ABI's error payload. On the Node.js kernel, the napi bridge throws a JavaScript error whose `.code` is the controller's code and marks it as the controller's own, and the loader re-raises it as an `InvokeError`. So `try:` / `catches:` match a Rust controller's code the same way they match a JavaScript controller's, from `register`, `create` and `invoke` alike. Except where a call back into JavaScript threw: that exception is still pending and is what reaches the kernel, whatever code the controller returns in its place.

A value the napi bridge cannot hand to the controller — a byte chunk, a stream, anything JSON cannot represent — is refused before `invoke` runs. That refusal is the bridge's, not the controller's error, so it fails the dispatch with `ERR_EXECUTION_FAILED` and napi's message, as a JavaScript controller's plain `Error` does — a `catch:` sees it as `INTERNAL_ERROR`.

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
