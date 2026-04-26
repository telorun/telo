---
description: "Selecting the native Rust controller for std/starlark via the Telo.Import runtime field."
sidebar_label: Rust runtime
---

# Starlark — Rust runtime

> Examples below assume this module is imported with `Telo.Import` alias `Starlark`. If you import the module under a different name, substitute your alias accordingly.

The `std/starlark` module ships two controller implementations:

| Implementation | Declared as                    | Backed by               |
| -------------- | ------------------------------ | ----------------------- |
| `nodejs`       | `pkg:npm/@telorun/starlark`    | `starlark-webasm`       |
| `rust`         | `pkg:cargo/telorun-starlark`   | Native Rust addon (N-API) |

By default, `Telo.Import` of `std/starlark` resolves to the kernel-native implementation — `nodejs` for the Node.js kernel today.

## Opting into the Rust controller

```yaml
kind: Telo.Import
metadata:
  name: Starlark
source: ../modules/starlark
runtime: rust
```

The kernel will:

1. Probe `rustc --version`. Missing → fall back if the runtime spec allows it (e.g. `runtime: [rust, any]`); error if the spec is strict.
2. Run `cargo build --release --features napi` in `modules/starlark/rust/`.
3. Locate the produced dylib via `cargo metadata` and copy it to `<libname>.node`.
4. Load via Node's `require` and use it as the controller.

First-run cost is the cold cargo build (~30s). Subsequent runs hit Cargo's incremental cache and are sub-second.

## Other `runtime:` forms

| Form                          | Meaning                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| (omitted)                     | Same as `runtime: auto` — kernel-native first, fall through                       |
| `runtime: auto`               | Best effort: kernel-native first, then any other available controller             |
| `runtime: native`             | Strict kernel-native (`nodejs` for the Node.js kernel)                            |
| `runtime: nodejs`             | Strict — only the nodejs controller. Fails on miss                                |
| `runtime: rust`               | Strict — only the rust controller. Fails on miss                                  |
| `runtime: [rust, nodejs]`     | Ordered fallback: try rust, then nodejs; fail if both miss                        |
| `runtime: [rust, any]`        | Rust preferred; fall through to anything else available                           |

## Authoring a Rust controller

The Rust controller crate at `modules/starlark/rust/` is a textbook Rust project — `Cargo.toml` + `src/`. The contributor never writes `use napi::*` or `#[napi]` attributes; the `#[controller]` macro from `telorun-sdk` generates all FFI plumbing.

See [the SDK README](https://github.com/codenet-pl/DiglyAI/blob/main/sdk/rust/README.md) for the controller-author contract.
