---
description: "Selecting the native Rust controllers for the console module via the import's runtime field."
sidebar_label: Rust runtime
---

# Console — Rust runtime

> Examples below assume this module is imported with an `imports:` entry under alias `Console`. If you import the module under a different name, substitute your alias accordingly.

Two of the module's four kinds ship a second, native Rust implementation:

| Kind          | `nodejs`                                  | `rust`                                          |
| ------------- | ----------------------------------------- | ----------------------------------------------- |
| `WriteLine`   | `pkg:telo/local/js` (bundled)             | `pkg:cargo/telorun-console#writeline_controller` |
| `ReadLine`    | `pkg:telo/local/js` (bundled)             | `pkg:cargo/telorun-console#readline_controller`  |
| `WriteStream` | `pkg:telo/local/js` (bundled)             | —                                                |
| `StreamWait`  | `pkg:telo/local/js` (bundled)             | —                                                |

`WriteStream` and `StreamWait` carry `x-telo-stream` inputs, and the Rust SDK has no stream contract yet, so they stay JavaScript-only.

The Rust controllers exist because the Rust kernel (`kernel/rust`) cannot run a JavaScript controller. Printing a line is what makes a manifest observable, so `console` is the first standard-library module that kernel needs.

## Which one runs

The JavaScript controller is listed first in `telo.yaml`, so the Node.js kernel's default `auto` policy keeps resolving to it. The Rust kernel's native PURL type is `pkg:cargo`, so the same unmodified declaration resolves to the Rust controller there. Neither kernel needs a `runtime:` field for the ordinary case.

To force the Rust controllers on the Node.js kernel, use the object form of the import:

```yaml
imports:
  Console:
    source: ../path/to/console
    runtime: [rust, any]
```

**Use `[rust, any]`, not strict `rust`.** Coverage is partial, and a strict policy fails the *whole import* when any one kind has no matching candidate — `WriteStream` and `StreamWait` would take the module down with them. The `any` tail lets each kind resolve independently: `WriteLine` and `ReadLine` to Rust, the stream kinds to JavaScript.

That fallback does not hide a broken controller. A candidate that resolves but fails to load is a hard error, never an env-missing one, so it surfaces instead of quietly reverting to the JavaScript controller. `modules/console/tests/runtime-rust.yaml` covers this path.

The Node.js kernel then probes `rustc`, runs `cargo build --release --features telorun-sdk/napi` in `modules/console/rust/`, and loads the resulting addon. This only works from a source checkout: `?local_path=` names a crate directory, and a published artifact carries no prebuilt native layer yet — which is why the example above uses a path rather than the `oci://` ref.

Each kind names its own controller inside the one crate through the PURL's `#fragment` (`#writeline_controller`, `#readline_controller`). On the Rust kernel that selects an exported C symbol; on the Node.js kernel the napi bridge namespaces its exports by the same name, so `module.writeline_controller.create` is what the loader projects.

`runtime:` accepts the same forms it does everywhere — see [the starlark module's Rust runtime doc](https://github.com/telorun/telo/blob/main/modules/starlark/docs/runtime-rust.md) for the full table.

## Behaviour differences

The Rust `WriteLine` and `ReadLine` render the same `{style content}` markup as the JavaScript ones — `markup.rs` is a port of `markup.ts`, with unit tests mirroring `tests/markup-smoke.yaml`. Two things differ, both because the Rust `ResourceContext` is narrower than the Node one:

- Standard input and output come from the process rather than from `ctx.stdin` / `ctx.stdout`, so a host cannot substitute streams.
- No `LineWritten` event is emitted — the Rust SDK has no `emit` yet.
