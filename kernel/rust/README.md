# Telo kernel (Rust)

A second Telo kernel, written in Rust. It loads a manifest, resolves resources, loads Rust controllers out of `cdylib`s, and dispatches invocations — no JavaScript anywhere in the path.

This is step one. It exists to prove the kernel itself can be a different language, not to reach parity with `kernel/nodejs`. See [`plans/rust-kernel-hello-world.md`](../../plans/rust-kernel-hello-world.md).

## Running

```
cargo run -p telo-cli -- run kernel/rust/tests/fixtures/hello-world/telo.yaml
```

The first run builds `modules/console/rust`; later runs hit Cargo's incremental cache. Success is `Hello from Telo!` on stdout and exit code 0.

`cargo test -p telo-kernel -p telo-cli` runs the fixtures end to end.

## What it supports

| Area           | Supported                                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| Documents      | `Telo.Application`, `Telo.Library`, `Telo.Definition`, resource docs                   |
| Module scope   | `imports` (local relative paths), `exports.kinds`, `exports.resources`, `Self.<Kind>`  |
| References     | `!ref <name>`, `!ref Self.<name>`, `!ref <Alias>.<name>`                               |
| Capabilities   | `Telo.Invocable`                                                                       |
| Targets        | inline invoke steps with literal `inputs`                                              |
| Contracts      | `inputType` / `outputType`, including declared defaults                                |
| Controllers    | `pkg:cargo/<crate>?local_path=<dir>#<entry>`                                           |

Not supported, each failing with a message that names what is missing rather than degrading quietly: CEL and `!cel`, `variables` / `secrets` / `ports`, `oci://` and other transports, streams, `extends`, template-backed definitions, `Run.Sequence`, every capability other than `Telo.Invocable`, and static analysis.

## Layout

Files mirror `kernel/nodejs/src/` one-for-one, kebab-case becoming snake_case. That is a rule, not a coincidence: where a file has no counterpart on the other side, one of the two layouts is wrong. Two consequences worth knowing before looking for something:

- **Manifest loading is not here.** It lives in `analyzer/rust`, because that is where it lives in Node — static analysis and the runtime read manifests through one path.
- **`controller_loaders/native_abi.rs` has no Node twin.** It is the host side of the C ABI; the Node.js kernel's equivalent is N-API, supplied by its runtime.

## How a controller is loaded

1. `Telo.Definition` registers the kind with its `controllers:` candidate list. Nothing is resolved yet.
2. On the kind's **first instantiation**, `controller_loader` orders the candidates by the import's `runtime:` policy (this kernel's native PURL type is `pkg:cargo`) and hands the winner to `cargo_loader`.
3. `cargo_loader` probes `rustc`, runs `cargo build --release --features telorun-sdk/native`, and reads the built `cdylib` path out of Cargo's JSON message stream.
4. `native_abi` opens the library, reads the vtable exported for the PURL's `#fragment`, checks the ABI version, and calls `register` once.

Deferring step 2 to first use is what lets this kernel load an **unmodified** standard-library manifest. `modules/console` declares four kinds and only two have Rust controllers; the other two register fine and fail — naming the kind — only if someone declares a resource of them.

The recoverable/fatal split is the same one `napi-loader.ts` makes: a missing `rustc` is the host's problem and the next candidate is tried; a `cargo build` that ran and failed is the author's code and surfaces immediately, because falling through would mask it.
