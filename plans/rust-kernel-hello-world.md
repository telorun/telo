# Rust kernel — step one

## Problem

Telo claims polyglot architecture, but every runtime is Node.js. The existing Rust work
(`sdk/rust`, `modules/starlark/rust`, the `runtime:` selection policy) proved a **controller**
can be Rust — it did not prove the **kernel** can be. Until a second kernel exists, the
polyglot claim rests on a design intention rather than a running binary, and the SDK's
`native` backend (`sdk/rust/src/backend/native.rs`, all `unimplemented!()`) has no consumer
to keep it honest.

Step one is a Rust kernel that runs the hello-world manifest end to end: parse the YAML,
resolve an imported library, load a Rust controller, dispatch one invocation, print a line.
Nothing more.

## Solution

Five new crates, four mirroring the pnpm workspace one-to-one so each Rust file has an
obvious Node counterpart:

| Crate            | Mirrors            | Contents                                                                |
| ---------------- | ------------------ | ----------------------------------------------------------------------- |
| `templating/rust` | `templating/nodejs` | `sentinel.rs`, `yaml_tags.rs` — the `!ref` tag only; CEL lands here later |
| `analyzer/rust`   | `analyzer/nodejs`   | `manifest_loader.rs`, `parse_loaded_file.rs`, `resolve_ref_sentinels.rs`, `builtins.rs`, `system_kinds.rs`, `loaded_types.rs`, `types.rs` |
| `kernel/rust`     | `kernel/nodejs`     | `kernel.rs`, `module_context.rs`, `evaluation_context.rs`, `resource_context.rs`, `controller_registry.rs`, `controller_loader.rs`, `controller_loaders/`, `controllers/`, `invoke_dispatch.rs`, `invocation_contract_binding.rs`, `schema_validator.rs`, `runtime_registry.rs`, `manifest_sources/`, `error.rs` |
| `cli/rust`        | `cli/nodejs`        | `cli.rs`, `commands/run.rs`; binary `telo-rs`                            |
| `sdk/rust/abi`    | — (see below)       | `telorun-abi`: the `#[repr(C)]` controller vtable, host callback table and buffer type |

**Alignment is a hard rule, not a preference.** A Rust file carries the same stem as its Node
counterpart (kebab-case → snake_case, which Rust requires) and sits at the same path within
its crate. Where no counterpart exists the Node side is what moves — a Rust file with no Node
twin means the Node layout was wrong. Two consequences fall out immediately: manifest loading
lives in `analyzer/`, not `kernel/` (so `analyzer/rust` exists despite doing no analysis), and
`CLAUDE.md`'s Kernel Internals section still names a `kernel/nodejs/src/loader.ts` that no
longer exists — that reference is corrected as part of this work.

Two files are genuine exceptions, each saying so in its own header:
`kernel/rust/src/controller_loaders/native_abi.rs` (the host side of the C ABI — Node's
equivalent is N-API, supplied by its runtime) and `kernel/rust/src/error.rs` (Node's kernel
raises `RuntimeError` from `@telorun/sdk`, which this kernel must not depend on).

**Vocabulary.** `Telo.Application` (metadata, imports, targets), `Telo.Library` (metadata,
`exports.kinds`, `exports.resources`), `Telo.Definition` (capability, controllers, schema,
`inputType`, `outputType`), `Self.<Kind>` resource docs, `!ref <name>` and `!ref <Alias>.<name>`,
the `Telo.JsonSchema` built-in, `targets` entries as inline invoke steps with literal inputs,
and input/output contract validation. `Telo.Invocable` is the only supported capability — every
other one registers and errors precisely if a resource of that kind is declared. Init is single
pass; without CEL nothing in scope can defer. Out: CEL, `variables`/`secrets`/`ports`, static
analysis, OCI imports, streams, scopes, `extends`, templates, observed state, `include`.

**Controller loading.** `pkg:cargo/<name>?local_path=<dir>#<entry>` → probe `rustc`, run
`cargo build --release --features telorun-sdk/native`, read the built path out of Cargo's JSON
message stream, `dlopen` the `cdylib` with `libloading` against a C-ABI vtable (JSON in / JSON
out) emitted by the `#[controller]` macro's previously-empty `native` branch. Resolution is
**deferred to the kind's first instantiation**: a definition whose candidate list holds nothing
this kernel can host registers fine and errors, naming the kind, only when a resource of it is
declared. That is what lets the Rust kernel load an unmodified `console/telo.yaml` whose stream
kinds have no Rust controller.

**`sdk/rust`.** The `native` backend stops being a stub: a real `create_type_validator` over the
`jsonschema` crate, a real `InvokeContext`, and generic ABI shims that catch unwinds, since a
panic crossing an `extern "C"` frame would abort the kernel with the controller. `#[controller]`
gains an optional `entry = "…"` naming the exported symbol, which is what a PURL's `#fragment`
selects. The `napi` backend is otherwise untouched.

**`modules/console/rust/`.** `WriteLine` and `ReadLine`, plus a full port of `markup.ts` — a
partial markup implementation would silently diverge from the JS controller. Rust unit tests
mirror the cases in `modules/console/tests/markup-smoke.yaml`. `console/telo.yaml` gains one
`pkg:cargo` candidate per ported kind, listed **after** the existing `pkg:telo/local/js`, so the
Node kernel's default `auto` policy still resolves to JS.

**Tests.** `kernel/rust/tests/` runs fixture manifests under `kernel/rust/tests/fixtures/`
through the kernel and asserts the dispatch result; `cli/rust/tests/` spawns the `telo-rs`
binary and asserts stdout and exit code, since that is the package the binary belongs to. The
fixtures are also checked by the Node analyzer's pre-commit hook, so both kernels agree they are
valid manifests.

## Decisions

- **Dynamic `cdylib` loading, not static linking.** Static linking would reach a running
  manifest sooner but makes the kernel a fixed binary with no module ecosystem, and every line
  of it would be deleted at step two. Dynamic loading fills in the migration shape the polyglot
  PoC plan already promised.
- **The OCI import is dropped from the fixture, for a structural reason.** A published console
  artifact carries no Rust-hostable controller: `?local_path=` resolves only in a source
  checkout. Supporting `oci://` here would require a bundled native layer
  (`pkg:telo/local/dylib?path=…&os=…&arch=…&libc=…`, prebuilt per selector) and a
  cross-compile-and-publish pipeline. That is step two, not a shortcut skipped here.
- **No CEL.** Rejected the `cel-interpreter` crate for now: with starlark out of scope the
  hello-world manifest has no expression in it, and CEL drags in `variables`/`steps` scoping
  that doubles the surface.
- **Starlark is out of scope.** Its Rust controller returns a marker payload, not a real
  evaluation, so running it would prove less than console does — and console is what
  hello-world actually imports. `modules/starlark/rust` is untouched.
- **Console migrates `WriteLine` and `ReadLine`.** `WriteStream` and `StreamWait` are
  stream-based and the Rust SDK has no stream contract; designing one is a plan of its own.
  `ReadLine` is in despite being unused by the fixture: console exports a ready-made `readLine`
  singleton, and a library's exported instances are created when the module loads — so leaving
  it out made the whole module unloadable, not merely that one kind unusable.
- **Controller resolution is deferred to first instantiation.** Resolving at
  `Telo.Definition` init would reject `console` outright over two kinds nobody uses. Both
  kernels defer: `kernel/nodejs` resolves and imports inside its lazy-controller thunk too,
  so the two agree on when a partially-covered module fails.
- **`telorun-sdk` loses its default backend feature.** The original plan had the Rust kernel
  build controllers with `--no-default-features --features native`, which cannot work: those
  flags apply to the controller crate, and the controller crate deliberately has no `[features]`
  block. A dependency feature is the only selector that reaches the SDK, so each kernel now
  passes `--features telorun-sdk/napi` or `--features telorun-sdk/native`. A bare `cargo check`
  still compiles the traits and the author's `impl`, just without a bridge.
- **`telorun-abi` is its own crate, so five rather than four.** The two halves of the ABI must
  agree on one layout, but the kernel cannot depend on `telorun-sdk` to get it: Cargo would
  unify the napi backend into the kernel binary, which then fails to link. A featureless
  contract crate is the only shape that lets both sides share the definition. It has no Node
  counterpart because Node has no such problem — N-API is its runtime's.
- **Five crates rather than one.** A single `telo-rs` crate would be smaller today but would
  break the filename-alignment rule at the first shared file, since manifest loading is an
  analyzer concern in Node.
- **Releases:** the Rust crates stay in-tree and unpublished, so they take no changesets.
  `modules/console` gets a changie fragment (`Added`); `@telorun/kernel` gets a changeset for
  the `napi-loader` feature flag. No manifest surface changes, so `apps/authoring-agent`'s
  system prompt needs no update; `CLAUDE.md`'s Monorepo Structure, Kernel Internals and
  controller-delivery sections do.

## Known limitations to close next

These are consequences of the narrow scope, not accepted end states. Each needs a follow-up
before the Rust kernel is a peer of the Node one:

- **The Rust `ResourceContext` has no I/O or event surface.** `console`'s Rust controllers write
  to the process's own stdout/stdin rather than `ctx.stdout` / `ctx.stdin`, so a host cannot
  substitute or capture streams per run — which is how the Node test runner works — and they
  emit no `LineWritten` event. The two backends' observable surfaces therefore differ for the
  same kind. Closing it means adding `stdout`/`stdin`/`emit` to the trait and to `telorun-abi`.
- **A published Rust controller has nowhere to live.** `?local_path=` resolves only in a source
  checkout, so `oci://` imports of a Rust-backed module cannot work until bundled native layers
  (`pkg:telo/local/dylib` + `os`/`arch`/`libc` selectors) and a cross-compile pipeline exist.
- **The controller cache is per-thread**, because its entries are `Rc`. One kernel run is one
  thread, so `register` still runs once per run; a process running two kernels concurrently
  would build and register twice. Process-wide caching needs a `Send + Sync` controller handle.

## Complete example after the change

`kernel/rust/tests/fixtures/hello-world/telo.yaml` — identical to `examples/hello-world/telo.yaml`
apart from the import source:

```yaml
kind: Telo.Application
metadata:
  name: HelloConsole
  version: 1.0.0
imports:
  Console: ../../../../../modules/console
targets:
  - invoke: !ref Console.writeLine
    inputs:
      output: "Hello from Telo!"
```

Run it:

```
cargo run -p telo-cli -- run kernel/rust/tests/fixtures/hello-world/telo.yaml
```

First run builds `modules/console/rust` via cargo; subsequent runs hit the incremental cache.
Success is `Hello from Telo!` on stdout and exit code 0 — produced by a Rust kernel loading a
Rust controller out of an unmodified standard-library module.
