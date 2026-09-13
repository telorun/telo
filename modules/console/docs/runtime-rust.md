---
description: "Selecting the native Rust controllers for the console module via the import's runtime field."
sidebar_label: Rust runtime
---

# Console — Rust runtime

> Examples below assume this module is imported with an `imports:` entry under alias `Console`. If you import the module under a different name, substitute your alias accordingly.

Three of the module's five kinds ship a second, native Rust implementation:

| Kind          | `nodejs`                                  | `rust`                                          |
| ------------- | ----------------------------------------- | ----------------------------------------------- |
| `WriteLine`   | `pkg:telo/local/js` (bundled)             | `pkg:cargo/telorun-console#writeline_controller` |
| `Write`       | `pkg:telo/local/js` (bundled)             | `pkg:cargo/telorun-console#write_controller`     |
| `ReadLine`    | `pkg:telo/local/js` (bundled)             | `pkg:cargo/telorun-console#readline_controller`  |
| `WriteStream` | `pkg:telo/local/js` (bundled)             | —                                                |
| `StreamWait`  | `pkg:telo/local/js` (bundled)             | —                                                |

`WriteStream` and `StreamWait` carry `Telo.Stream` inputs, and the Rust SDK has no stream contract yet, so they stay JavaScript-only.

`Write`, `ReadLine` and `WriteLine` are ported because the module exports a ready-made instance of each, and a library's exported instances are created when the module loads — a kind with no Rust controller would make the whole module unloadable on the Rust kernel, not merely that one kind unusable.

**The Rust `Write` writes text only.** A Rust controller receives its input as a JSON value, which has no bytes variant: the Rust kernel's manifest values carry none (`!include-bytes` fails there explicitly), and on the Node.js kernel the napi bridge refuses a `Uint8Array` before the controller runs (the dispatch fails with `ERR_EXECUTION_FAILED` and the message `invalid type: byte array, expected any valid JSON value`). Any other value that is not a string is refused by the controller itself with `ERR_OUTPUT_NOT_TEXT`, rather than written as some rendering of it. To write bytes, let the JavaScript controller serve `Write` — the default on the Node.js kernel.

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

**Use `[rust, any]`, not strict `rust`.** Coverage is partial, and a strict policy fails the *whole import* when any one kind has no matching candidate — `WriteStream` and `StreamWait` would take the module down with them. The `any` tail lets each kind resolve independently: `WriteLine`, `Write` and `ReadLine` to Rust, the stream kinds to JavaScript.

That fallback does not hide a broken controller. A candidate that resolves but fails to load is a hard error, never an env-missing one, so it surfaces instead of quietly reverting to the JavaScript controller. `modules/console/tests/runtime-rust.yaml` covers this path.

The Node.js kernel then probes `rustc`, runs `cargo build --release --features telorun-sdk/napi` in `modules/console/rust/`, and loads the resulting addon. This only works from a source checkout: `?local_path=` names a crate directory, and a published artifact carries no prebuilt native layer yet — which is why the example above uses a path rather than the `oci://` ref.

Each kind names its own controller inside the one crate through the PURL's `#fragment` (`#writeline_controller`, `#write_controller`, `#readline_controller`). On the Rust kernel that selects an exported C symbol; on the Node.js kernel the napi bridge namespaces its exports by the same name, so `module.writeline_controller.create` is what the loader projects.

`runtime:` accepts the same forms it does everywhere — see [the starlark module's Rust runtime doc](https://github.com/telorun/telo/blob/main/modules/starlark/docs/runtime-rust.md) for the full table.

## Behaviour differences

The Rust `WriteLine` and `ReadLine` render the same `{style content}` markup as the JavaScript ones — `markup.rs` is a port of `markup.ts`, with unit tests mirroring `tests/markup-smoke.yaml`. The Rust `Write` renders none, as in JavaScript: it writes its text exactly as given, with no newline. What differs follows from the controllers being native:

- Standard input and output come from the process rather than from `ctx.stdin` / `ctx.stdout`, so a host cannot substitute streams. This holds for all three, `Write` included.
- The Rust `WriteLine` emits no `LineWritten` event — the Rust SDK has no `emit` yet. `Write` and `ReadLine` emit no event in either runtime, so nothing differs for them.
- The Rust `Write` writes text only, where the JavaScript one also writes bytes: bytes and any other non-string value are refused, as described above. `WriteLine` and `ReadLine` take text in both runtimes.
- A write that standard output refuses fails the dispatch with `ERR_STDOUT_WRITE_FAILED` from any of the three Rust controllers.
