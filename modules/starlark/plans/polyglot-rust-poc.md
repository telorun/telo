# Polyglot Controllers — Rust

## Goal

Prove that Telo can load and dispatch a controller written in a language other than JavaScript, end‑to‑end, using the smallest real module we have.

The PoC succeeds when `pnpm run telo manifest.yaml` executes a `starlark.Script` resource whose controller is a **native Rust addon loaded in‑process** — and the same manifest still works if the addon is absent (falls back to the existing npm controller).

Non‑goal: any form of subprocess, stdin/stdout protocol, or "Rust binary invoked per call." The whole point is that Rust code runs in the Node.js process at FFI speed, just like SWC, biome, parcel, rspack.

### What's "PoC" and what's final

The only PoC-scoped aspect is **"exactly one module has a Rust implementation"** (starlark). Everything else — the selection policy, the `NapiControllerLoader`, the `telorun-sdk` shape, the `#[controller]` macro contract, the backend abstraction, the feature-flag migration story — is the **final design**, not a throwaway prototype. Future Rust controllers will use this infrastructure as-is; we're not planning a rewrite.

This matters for review: reviewers should evaluate the SDK and loader for long-term sustainability, not "good enough for a demo."

**Author principle: Rust developers write Rust, nothing else.** A controller crate is `Cargo.toml` + `src/*.rs` — no `build.rs`, no `package.json`, no JS tooling, no napi‑specific build scripts, no awareness of which kernel will load it. All runtime plumbing (napi bindings, platform binary layout, feature injection, dylib → `.node` rename) is handled by the SDK (via the `#[controller]` macro) and the loader (via its build invocation). A Rust author opening a controller crate should see a textbook Rust project — if they see a `package.json`, something is wrong.

**Forward‑compatibility requirement:** the shape of a Rust controller must be agnostic to how the kernel loads it. Today will be loaded via N‑API; when the kernel is rewritten in Rust, controllers port over with **zero changes** — no source edits, no Cargo.toml edits, no feature‑flag flips in the crate. Anything that's napi-specific (binary naming, `.node` rename step, `cargo build --features napi` invocation, platform suffix convention) lives inside `NapiControllerLoader` and the SDK's `napi` backend — it does not leak into the pure‑Rust kernel's future loader, which is free to use any native convention (`.so` / `.dylib` / static link / plugin registry, whatever suits it).

## Target: `starlark.Script`

The existing TS implementation ([modules/starlark/nodejs/src/script.ts](../nodejs/src/script.ts)) is a workaround on a workaround:

- Loads Starlark as WASM (`starlark-webasm`)
- Monkey‑patches `globalThis.fetch` for `file://` URLs ([script.ts:26-45](../nodejs/src/script.ts#L26-L45))
- Silences `console.log` during init ([script.ts:51-57](../nodejs/src/script.ts#L51-L57))
- Parses return values by regex‑replacing Python repr ([script.ts:107-122](../nodejs/src/script.ts#L107-L122)) — breaks on any user string containing `'`, `True`, `False`, or `None`

Replacing this with native `starlark-rust` (Meta's reference implementation, used in Buck2) loaded via N‑API delivers real user value beyond "polyglot works":

- In‑process FFI call per invoke — microseconds, not milliseconds
- Interpreter state reused across invokes within one resource lifetime
- Structured `starlark::Value` → `serde_json::Value` conversion — kills the regex hack
- Real error spans surfaced as structured errors
- Smaller runtime footprint (no WASM blob, no `fetch` patch)

**Research prerequisite — not yet confirmed.** `starlark-rust` does not ship a built-in `Value → serde_json::Value` conversion in its public API. The project's own binary does it via an internal visitor. Before implementation starts, confirm which of these is true for the target version:

1. A public `Value::to_json` / `serde` impl exists (ideal — one-line conversion).
2. A public visitor API is exposed but roundtrip logic must be written (~50 lines of match on `StarlarkValue` kind).
3. Neither (worst case — vendor the upstream visitor behind a thin wrapper).

All three still deliver "kills the regex hack." Outcome (2) or (3) shifts some conversion logic into the controller or the SDK (e.g. a `starlark_to_json` helper), but the author principle is unchanged: they only write what matters for the Rust version of the Telo runtime — Rust controller code and the data shape the kernel will consume. This does not block the plan — but confirm the facts before the first commit. Block ownership: whoever writes the controller crate owns the research.

### Why the surface is clean

`StarlarkScript.invoke(input) → result` is pure data‑in / data‑out, and the current TS controller only uses `ctx` for `createTypeValidator` on input and output. That is the single JS‑side call the Rust controller needs to make — which means the Rust SDK needs to model only one context method for the PoC. Enough real interop to prove the contract, not so much that the PoC becomes a study in napi‑rs.

## Prerequisites (must land before any new loader code)

The plan's claim that "the signature is already polyglot-shaped" is only half true. The _shape_ of `ControllerLoader.load(purlCandidates)` is right, and a working call site already exists: [resource-definition-controller.ts:35-58](../../../kernel/nodejs/src/controllers/resource-definition/resource-definition-controller.ts#L35-L58) — `Telo.Definition.init()` calls `controllerLoader.load(this.resource.controllers, this.resource.metadata.source)` and then `ctx.registerController(...)`. **Controller loading is a Telo resource lifecycle event today, not a separate kernel phase**, and this PoC keeps it that way. Inventing a parallel kernel-driven walk over definitions would duplicate the resource model.

What _is_ dead is parallel cache infrastructure inside `ControllerRegistry`:

- [controller-registry.ts:30](../../../kernel/nodejs/src/controller-registry.ts#L30) guards a stale loader-cache registration on `baseDir`, but [line 23](../../../kernel/nodejs/src/controller-registry.ts#L23) hardcodes `const baseDir = null`. The `registerControllerLoader(...)` branch never fires.
- [`getController`](../../../kernel/nodejs/src/controller-registry.ts#L40) returns a stub `{ schema: { additionalProperties: false } }` on a cache miss, instead of throwing. With the `Telo.Definition.init` path live, the stub is unreachable for any kind that has `controllers:` declared — but it silently masks bugs whenever a definition's init has not completed.

**Prerequisite PR (before anything in this plan):** delete the dead branches and tighten the contract — do **not** introduce a parallel kernel-driven load phase. Concretely:

1. Remove the never-fired `registerControllerLoader` cache from `ControllerRegistry` and its call site at `controller-registry.ts:30-31`. The `Telo.Definition.init` path supersedes it in full.
2. Make `getController` throw `ERR_CONTROLLER_NOT_LOADED` on miss instead of returning a stub. Any caller hitting `getController` for a kind whose `Telo.Definition` has not yet init'd is a bug today; the stub hides it.
3. Add an optional third parameter to `ControllerLoader.load(candidates, baseUri, policy?)`, threaded through `Telo.Definition.init`. No producers wired yet — every call site passes `undefined`. This gives PR 1 a typed seam to plug into without touching the live load path.

No new lifecycle hook, no new walk over definitions. Controller loading remains exactly where it lives today: the `Telo.Definition` resource's `init`. PR 1 wires the policy producer (`Telo.Import` → child `ModuleContext`) and the `NapiControllerLoader` into that same seam.

The rest of this plan assumes that prerequisite is in place.

## Architecture

### Existing seam

[controller-loader.ts:23](../../../kernel/nodejs/src/controller-loader.ts#L23) already takes `purlCandidates: string[]` and line 27 does:

```ts
const purl = purlCandidates.find((p) => p.startsWith("pkg:npm"));
```

The signature is already polyglot‑shaped. `Telo.Definition.controllers` is already an array. More importantly, line 69 does `await import(entryFile)` — and **Node's `import()` natively loads `.node` addons**. So the actual mechanism for consuming a Rust controller is already wired up. We just need to resolve a `pkg:cargo` PURL to a `.node` file path instead of a `.js` entry.

### Dispatch model

```
ControllerLoader.load(candidates, baseUri, selectionPolicy)
  └─ scheme dispatcher
       ├─ pkg:npm   → NpmControllerLoader    (existing logic, extracted)
       └─ pkg:cargo → NapiControllerLoader   (new — generic, reused by all future Rust controllers)
```

### Runtime selection (user-facing)

Module authors list **available** implementations via `Telo.Definition.controllers`. Importers pick which one to use with a single `runtime:` field on `Telo.Import`. Users think in implementation labels (`nodejs`, `rust`) — the directory names they see at `modules/<name>/nodejs/` and `modules/<name>/rust/` — not in PURL types.

| Form                          | Meaning                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| (field omitted)               | Same as `runtime: auto`                                                                                            |
| `runtime: auto`               | Best effort: try kernel-native first, then fall through to any other available controller in definition order      |
| `runtime: native`             | Strict: only the kernel's native runtime (`nodejs` for the Node.js kernel, `rust` for the future Rust kernel)      |
| `runtime: rust`               | Strict: only the rust controller. Fails on miss                                                                    |
| `runtime: nodejs`             | Strict: only the nodejs controller. Fails on miss                                                                  |
| `runtime: [rust, nodejs]`     | Ordered fallback. Try in order; fail if none resolve                                                               |
| `runtime: [rust, any]`        | rust preferred; fall through to any other available controller in definition order                                 |
| `runtime: any`                | Pure definition order with no kernel-native promotion — try each controller as the module author listed them       |
| `runtime: []`                 | Validation error — empty list has no useful meaning                                                                |

`any` is a wildcard token usable as a list element (or alone). It expands to "all remaining controllers in definition order, minus the labels already listed earlier in the same `runtime` list." This is the single composition mechanism behind the convenience keywords:

- `nodejs` ↔ `pkg:npm`
- `rust` ↔ `pkg:cargo`
- `native` — resolves at policy-bind time to the kernel's self-reported native label
- `any` — wildcard tail; expands to all-remaining controllers in definition order
- `auto` — sugar for `[<kernel-native>, any]`. Used as both the missing-field default and an explicit value
- (missing) — sugar for `auto`

Adding a new runtime is a one-entry change to the label-to-PURL-type table — `Telo.Definition.controllers` and `Telo.Import.runtime` both already use the friendly label.

Why `auto` (and not strict-native) is the default-on-missing: a manifest that imports starlark from a manifest written before the rust controller existed should keep working unchanged after the rust controller ships, regardless of which kernel runs it. Strict-native-by-default would surface every gap as a hard error; `auto` falls through to whatever the module author actually shipped.

Example manifest:

```yaml
kind: Telo.Application
metadata: { name: my-app }
---
kind: Telo.Import
metadata:
  name: Starlark
source: ../modules/starlark
runtime: rust          # strict — fail if the rust controller is unavailable
```

#### Plumbing — where the runtime selection actually flows

Controller loading already happens inside `Telo.Definition.init` (see Prerequisites). The selection producer slots in upstream of that, not as a separate phase:

1. `Telo.Import` create reads the import's `runtime` field and normalizes it to a resolved policy: an ordered list of PURL types optionally terminated by a wildcard sentinel meaning "all remaining controllers in definition order." Normalization expands `auto` to `[<kernel-native>, <wildcard>]`, `native` to `[<kernel-native>]`, and any in-list `any` token to the wildcard sentinel. The result is stamped on the child `ModuleContext` it spawns at [import-controller.ts:87-97](../../../kernel/nodejs/src/controllers/module/import-controller.ts#L87-L97), **before** `child.initializeResources()` runs at [line 127](../../../kernel/nodejs/src/controllers/module/import-controller.ts#L127). Root-module contexts with no enclosing import resolve as if the import had no `runtime` field — i.e. `auto`.
2. `Telo.Definition.init` reads the resolved policy from its own enclosing module context (via `ResourceContext` — a small additive method, e.g. `ctx.getControllerPolicy()`). Because policy was resolved on import and stored on the child context, this is a one-step lookup, not a walk up the import tree.
3. `Telo.Definition.init` passes that policy as the third argument to `controllerLoader.load(this.resource.controllers, this.resource.metadata.source, policy)`.
4. `ControllerLoader.load` walks the resolved list. For each entry, it picks the matching PURL candidate (if any) and tries to load it. When the entry is the wildcard sentinel, it iterates all remaining candidates in definition order, skipping PURL types already attempted earlier in the list. Without a wildcard, candidates whose PURL type isn't in the resolved list are dropped entirely.
5. On per-candidate resolution failure, advance to the next candidate — except for the hard-fail cases in `NapiControllerLoader` (see "cargo build failures" below) where the error is user code and must surface.

#### Registry cache key: kind + runtime, not kind alone

Today [`controllersByKind`](../../../kernel/nodejs/src/controller-registry.ts#L9) is keyed by kind string. This works while every load of a given kind produces the same artifact. With per-import runtime selection, two imports of the same library can pick different implementations, and a pure kind-keyed cache would let the first winner lock out the second.

The registry gains a composite cache key: `(kind, runtimeFingerprint)` where `runtimeFingerprint` is a short hash of the resolved policy (the post-normalization PURL-type list plus the wildcard flag). Two imports with identical resolved policies share one cached controller; divergent ones get separate entries. `hasController(kind)` and `getDefinition(kind)` remain kind-only — only the _loaded instance_ is policy-scoped.

This is a behavior change; call it out explicitly in the kernel PR.

### Rust controller shape — zero per‑controller glue

A napi‑rs build produces a `.node` binary whose exported object is indistinguishable from a JS module's exports. When the loader calls `await import("./telorun_starlark.linux-x64-gnu.node")`, it gets back `{ register, create }` — the exact shape the kernel registry already expects ([controller-loader.ts:70](../../../kernel/nodejs/src/controller-loader.ts#L70)).

**The controller author writes only what matters for the Rust version of the Telo runtime** — Rust controller code, no napi imports, no FFI glue, no delegation crate:

```rust
use telorun_sdk::{controller, Controller, ControllerContext, ResourceContext,
                  Result, Value, DataValidator};

pub struct StarlarkScript {
    code: String,
    input_validator: Box<dyn DataValidator>,
    output_validator: Box<dyn DataValidator>,
    // starlark interpreter state …
}

#[controller]
impl Controller for StarlarkScript {
    /// Process-level init. Called once per .node load, before any create().
    /// Default impl is a no-op; override when the backing library needs one-time
    /// global setup (e.g. installing panic handlers, warming thread pools).
    /// Maps to the kernel's existing `register(ctx)` export slot.
    fn register(_ctx: &dyn ControllerContext) -> Result<()> { Ok(()) }

    fn create(manifest: Value, ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(Self {
            code: manifest["code"].as_str().ok_or(...)?.to_string(),
            input_validator: ctx.create_type_validator(&manifest["inputType"])?,
            output_validator: ctx.create_type_validator(&manifest["outputType"])?,
            // …
        })
    }

    fn invoke(&self, input: Value) -> Result<Value> {
        self.input_validator.validate(&input)?;
        let result = run_starlark(&self.code, &input)?;
        self.output_validator.validate(&result)?;
        Ok(result)
    }

    /// Exposes resource state to `${{ resources.<name>.* }}` CEL expressions.
    /// Default impl returns `Value::Null` — fine for pure Runnable/Invocable
    /// resources that nothing downstream reads from. Any controller whose
    /// resource is referenced by CEL must override this.
    fn snapshot(&self) -> Value { Value::Null }
}
```

That's the entire author-facing surface. `#[controller]` is the single attribute the author writes; every bit of napi‑rs plumbing (exported functions, JS class binding, value marshalling, error conversion) is generated by the macro. If `starlark-rust`'s JSON conversion forces a helper module (Outcomes 2/3 in the research note above), the author adds it as another `.rs` file — still pure Rust, still no FFI glue.

**Why `register` and `snapshot` are on the trait.** The kernel's existing controller protocol exposes both — `register(ctx)` at module load for process-level init (the TS starlark controller uses it to initialize the WASM runtime and patch `fetch`, [script.ts:48](../nodejs/src/script.ts#L48)), and `snapshot()` on the `ResourceInstance` returned from `create()` for making `resources.<name>.*` available to CEL expressions in peer resources. A Rust controller that omits `snapshot` silently breaks any manifest that references its output via `${{ resources.X.y }}`. Both have safe default implementations on the trait so the starlark PoC (which uses neither) doesn't write boilerplate — starlark-rust is constructed per-`create`, not per-process, and nothing reads `resources.MyScript.*`.

**Error surface.** User-facing errors (starlark parse failures, validation failures, bad input) are returned as `Err(...)` from the trait methods; the macro maps them to thrown JS `Error` with the message preserved. Panics are caught by napi‑rs and surfaced with a distinguishing error code so the kernel can tell "user code failed" from "controller itself crashed" — the former bubbles as a normal resource error, the latter should halt execution.

### Shared Rust SDK — centralized FFI + backend abstraction

Rust controllers call into `ResourceContext`, which is a JS object today and will be a Rust trait object once the kernel is pure Rust. To insulate controllers from that, the SDK defines the contract as pure Rust traits and ships **two backends** behind a Cargo feature flag:

```
sdk/rust/
├── Cargo.toml                   # [features] default=["napi"]; napi=[dep:napi,…]; native=[]
├── macros/                      # proc-macro crate (backend-agnostic)
│   └── src/lib.rs               # #[controller] — emits cfg(feature=…) branches
└── src/
    ├── lib.rs                   # pub use traits + re-export macro
    ├── traits.rs                # Controller, ResourceContext, DataValidator, …
    ├── backend/
    │   ├── napi.rs              # #[cfg(feature="napi")] — today's backend
    │   └── native.rs            # #[cfg(feature="native")] — placeholder; filled when kernel goes Rust
    └── value.rs                 # pub use serde_json::Value as Value (neutral data type)
```

Key properties:

- **Controllers depend only on `telorun-sdk`** — no `features` block on the dep. Backend selection is injected externally by the kernel's build invocation (see below).
- **SDK has `default = ["napi"]`.** Today's only shipping backend is the default, so `cargo check` / `cargo clippy` / `rust-analyzer` / `cargo test` — invoked bare by developer tooling on file save — all Just Work on a fresh clone. The future Rust kernel's loader explicitly passes `--no-default-features --features native` when it wants the pure‑Rust backend. Controllers' `Cargo.toml` still has no `features` block on the dep; what's being overridden is the SDK's _own_ default, not the downstream controller's choice.
- **napi‑rs is an optional dep** of the SDK (`optional = true`). With `--no-default-features --features native`, Cargo does not download or compile napi‑rs at all — it's not "unused," it's genuinely absent from the build graph.
- **`#[controller]` macro is the ONLY author‑facing surface.** It emits code gated on `#[cfg(feature = "napi")]` / `#[cfg(feature = "native")]`; the resolver uses the _downstream crate's_ feature selection, which is driven by the kernel's build invocation — controllers don't pick.
- **Macro crate links to nothing.** Proc macros just emit token streams. Backend‑agnostic by construction.
- **CI builds both feature sets.** `cargo check --features napi --no-default-features` and `cargo check --features native --no-default-features` run on every SDK change (in addition to the bare default build). A type error in the `native` branch that `--features napi` missed is caught here. Test run is a separate matrix entry; `cargo check` in both modes is the minimum bar because proc-macro-emitted code behind `#[cfg]` branches is only compiled when that cfg is active.
- **Single Cargo workspace at the repo root.** A top-level `Cargo.toml` declares all Rust crates as workspace members (`sdk/rust`, `sdk/rust/macros`, `modules/*/rust`). One `target/` and one `Cargo.lock`, parallel to the pnpm workspace for JS. Lands in PR 1 alongside the first Rust crate (the napi-echo fixture); PR 2 adds `sdk/rust` and `modules/starlark/rust` to the members list.

### Backend abstraction & migration path

Controller crate:

```toml
# modules/starlark/rust/Cargo.toml
[lib]
crate-type = ["cdylib", "rlib"]   # cdylib for napi .node; rlib for static-link plugin

[dependencies]
telorun-sdk = { path = "../../../sdk/rust" }   # no features — injected by the build
```

Build invocation is where the backend is picked:

- **Today (`NapiControllerLoader` dev mode):** `cargo build --release` — relies on the SDK's `default = ["napi"]`.
- **Future Rust kernel's loader:** `cargo build --release --no-default-features --features native`.

When the Rust kernel ships, the new kernel carries its own controller loader that invokes cargo with `--no-default-features --features native`. **Zero changes to any controller's `Cargo.toml`, zero changes to any controller's source, zero changes to the SDK.** The migration is entirely on the kernel side.

The "zero changes" claim holds iff (a) the future Rust kernel uses the same `Controller` trait shape, (b) `serde_json::Value` remains the data exchange type, and (c) the macro's `#[cfg(feature="native")]` branch keeps compiling. The proc macro emits distinct code for each backend; if (c) bit‑rots, the migration claim is fiction within months. The CI matrix in Q2 enforces (c) and is load‑bearing for the design.

## Changes required

### 1. `modules/starlark/telo.yaml`

Add a second PURL alongside the existing one:

```yaml
controllers:
  - pkg:npm/@telorun/starlark@0.1.11?local_path=./nodejs#script
  - pkg:cargo/telorun-starlark?local_path=./rust
```

Order is stylistic — list `pkg:npm` first by convention so the file reads "stable shipping path, then native add-on." With `runtime: auto` as the default, the kernel-native PURL type is tried first regardless of declared order, and the remaining types are tried as wildcard fallback in declared order. The ordering only becomes load-bearing for `auto` once a third PURL type appears, or for `auto` running on a kernel whose native runtime has no controller listed.

### 2. `kernel/nodejs/src/controller-loader.ts` + runtime selection

- Extract today's `load()` body into `NpmControllerLoader.load()`.
- Introduce `NapiControllerLoader.load()` — handles `pkg:cargo`, resolves `.node` path, hands it to the same `import()` call. Resolution outcomes and fallback boundary are specified in the `NapiControllerLoader` section above.
- Add a runtime-label registry (`nodejs ↔ pkg:npm`, `rust ↔ pkg:cargo`) plus the kernel's self-reported native label (`nodejs` for the Node.js kernel) and the magic tokens `auto`, `native`, `any`. Normalization rules: `auto` → `[<kernel-native>, <wildcard>]`; `native` → `[<kernel-native>]`; in-list `any` → wildcard sentinel. Empty list and unknown labels fail validation; `any` outside of a list is legal and means a list of just the wildcard.
- Top‑level `ControllerLoader.load(candidates, baseUri, policy)` walks the resolved policy in order, picks a loader by PURL scheme, tries the next candidate on resolution failure, expands the wildcard sentinel inline against `Telo.Definition.controllers` minus already-listed types, and fails when the list is exhausted (unless the per-loader outcome table says "fail hard"). When `policy` is absent (root-module direct registration), it behaves as `auto`.
- Import controller ([controllers/module/import-controller.ts](../../../kernel/nodejs/src/controllers/module/import-controller.ts)) reads `runtime`, normalizes it via the runtime-label registry, and stamps the resolved policy on its spawned child `ModuleContext` before `child.initializeResources()` runs. `Telo.Definition.init` reads the policy from its enclosing module context (via a new `ResourceContext.getControllerPolicy()`) and forwards it to `ControllerLoader.load`. No new kernel-driven walk over definitions — the existing resource lifecycle is the load step.
- Schema updates, **two places**:
  - `kernel/nodejs/src/controllers/module/import-controller.ts` inline `schema` export — runtime validation when the import controller materializes the resource.
  - `analyzer/nodejs/src/builtins.ts`'s `Telo.Definition` entry for `Import` — static analysis would otherwise reject `runtime:` as an unknown property before the manifest reaches the kernel. Both must accept the same shape (string or array of strings).

Public `ControllerLoader.load` signature changes (new `policy` parameter). Kernel-internal callers updated; no user-manifest impact.

### 3. New `NapiControllerLoader` (generic)

Responsibilities — all reusable across every future Rust controller **that runs on the Node.js kernel**. This loader is napi‑specific by design; its naming, paths, and build invocation do not bind the future pure‑Rust kernel's loader in any way.

- Parse `pkg:cargo/<name>?local_path=<path>` (PackageURL supports `cargo` natively). Note: the PURL itself is runtime-neutral — the same `pkg:cargo/...` entry in `Telo.Definition.controllers` will be consumed by a different loader when the Rust kernel arrives.
- Resolve the `.node` file using napi‑rs's default layout. Two resolution modes:
  - **Dev mode (when `local_path` exists)**: the loader compiles the crate on every load by invoking `cargo build --release --features napi` in `{local_path}`. **Raw cargo — not `napi build`** — so the author's crate stays free of `build.rs` and `package.json`. The `--features napi` injection is what selects the napi backend; controllers' `Cargo.toml` doesn't specify features, so it's the loader's job. Cargo's incremental cache handles up‑to‑date checks — no‑op when nothing changed (~100ms–few s overhead), full compile on first run or after source changes. Cargo emits a platform dylib at `{local_path}/target/release/lib<name>.{so,dylib,dll}`; the loader renames/symlinks it to `<name>.node` (the minimum Node needs to load it) before calling `import()`. Edit‑run loop: save a `.rs` file, re‑run your manifest, the change is picked up — same feel as `cargo run`.
  - **Distribution mode (no `local_path`)**: resolve through `node_modules` like the npm loader does today — napi‑rs's convention is one npm package per platform (`@scope/<name>-linux-x64-gnu` etc.) with the main package declaring them as `optionalDependencies`. No build step; consumers get a prebuilt `.node`. Out of scope for the PoC (see below), but the loader leaves a clean hook.
- Resolution outcomes, precisely:

  | Outcome                                                                              | Category                          | Fallback allowed                | No fallback                 |
  | ------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------- | --------------------------- |
  | `.node` resolved successfully (dist mode or fresh build)                             | success                           | load it                         | load it                     |
  | `local_path` directory is absent                                                     | env-missing (recoverable)         | fall through to next candidate  | error                       |
  | `rustc` not on `$PATH` (detected by spawning `rustc --version` before `cargo build`) | env-missing (recoverable)         | fall through to next candidate  | error                       |
  | Dist mode and no prebuilt `.node` on disk for the current platform                   | env-missing (recoverable)         | fall through to next candidate  | error                       |
  | `cargo build` launched, exit code ≠ 0                                                | user-code error (non-recoverable) | **fail hard** with cargo stderr | fail hard with cargo stderr |
  | `.node` produced but `import()` throws                                               | user-code error (non-recoverable) | fail hard                       | fail hard                   |

  "Fallback allowed" applies when there is still a next candidate in the resolved policy — either a remaining named entry or the wildcard tail (from `auto`, missing field, or an explicit `any` token). "No fallback" applies when the current candidate is the last reachable entry — single-value strict (`runtime: rust`, `runtime: native`), or the final entry of an explicit list with no `any` tail.

  The critical distinction: the loader probes `rustc --version` _before_ invoking `cargo build`. If rustc is absent, that's a property of the host, not the user's code, and falling back is safe. If rustc ran and cargo returned ≠ 0, the user has a compile error and silently switching to the WASM controller would mask it. This boundary is the single decision that governs fallback correctness; it needs an explicit test with rustc absent (PATH-masked) _and_ a test with a deliberate compile error.

- Call `await import(resolved)` — identical code path to npm.

No starlark‑specific logic lives here. Adding the second Rust controller later reuses this loader as‑is.

### 4. `sdk/rust/` — new shared crate (with proc macro sub-crate)

- Pure Rust traits (`Controller`, `ResourceContext`, `DataValidator`) on neutral data types (`serde_json::Value`).
- Two backends feature‑gated: `napi` (today) and `native` (stub for future).
- `sdk/rust/macros/` proc‑macro crate exporting `#[controller]` — generates FFI bindings per active backend.
- Only the methods starlark uses are modeled: `ResourceContext::create_type_validator`, `DataValidator::validate`.
- Crate lives in‑tree at `sdk/rust/`; not published to crates.io for this PoC.

### 5. `modules/starlark/rust/` — new controller crate

```
modules/starlark/rust/
├── Cargo.toml              # crate-type = ["cdylib", "rlib"]; deps: telorun-sdk (no features), starlark, serde_json
└── src/lib.rs              # pub struct + #[controller] impl — NO napi imports
```

**Everything in the crate is what matters for the Rust version of the Telo runtime — Rust source and Cargo metadata, nothing else.** No `build.rs`, no `package.json`, no `napi build` config, no JS tooling, nothing non‑Rust. The crate may grow additional `.rs` files in `src/` if the controller naturally factors that way (e.g. a JSON conversion helper), but a Rust author opening the crate sees a standard Rust project — `Cargo.toml` + `src/`. Any napi‑specific build machinery lives in the loader, not in the author's workspace.

Note: the controller's `Cargo.toml` contains **no feature selection** for `telorun-sdk`. The backend feature (`napi` today, `native` in the future) is passed by the kernel's build invocation (`cargo build --features napi` / `cargo build --features native`). This is what makes controllers portable across kernels without edits.

`src/lib.rs` mirrors [script.ts](../nodejs/src/script.ts) semantics:

1. `create(manifest, ctx)` — stores `code`, calls `ctx.create_type_validator` for `inputType` / `outputType`, returns a `StarlarkScript` handle.
2. `invoke(input)` — validates input, runs starlark with `input` bound as a global, calls `run(input)`, serializes `starlark::Value` → `serde_json::Value` via proper native serialization, validates output, returns it.

No CLI, no stdin/stdout, no subprocess. Pure in‑process via the macro‑generated napi binding.

## Open questions

Each has a "proposed" answer; call it out if you'd prefer something else.

**Q1. `native` backend content in the PoC.**
Proposed: ship `sdk/rust/src/backend/native.rs` as a stub (`unimplemented!()` bodies plus trait shapes) so the feature flag exists and compiles, but don't pretend to have a working pure‑Rust backend. The point is to pin the migration shape, not to deliver it. **Caveat:** CI under `--features native` with `unimplemented!()` bodies only verifies that the abstraction _compiles_, not that it _works_. The value is "the types match," not "the migration is proven."

**Q2. CI coverage of both backends.**
Proposed: the SDK crate runs `cargo check` under `--features napi --no-default-features`, `--features native --no-default-features`, _and_ a bare default build (which hits `napi` via the default feature). Regression in any breaks the build. Without this, the `native` backend bit‑rots immediately and the migration claim is fiction.

**Q3. Scope of the kernel PR vs. the module PR.**
Suggested split:

- **PR 0 (prerequisite)**: delete the dead `ControllerRegistry` cache branches, make `getController` throw on miss, and add an optional `policy` parameter to `ControllerLoader.load` threaded through `Telo.Definition.init` (no producers wired yet, every call site passes `undefined`). Pure refactor — no new behavior, no new PURL types, no `NapiControllerLoader`. Tests the existing npm path end-to-end and confirms the policy seam compiles.
- **PR 1 (kernel)**: `NapiControllerLoader` + schema update on the `Telo.Import` inline schema + a tiny `.node` fixture built from a trivial Rust crate under `kernel/nodejs/tests/napi-echo/` to prove the loader dispatches correctly. Fixture is prebuilt and checked in for the current dev platform (or built on demand in a test setup script).
- **PR 2 (sdk-rust + module)**: `sdk/rust/` crate (with macro sub-crate) + `modules/starlark/rust/` + telo.yaml update + tests that run only when the `.node` is built.

Lets the loader ship and get reviewed without blocking on a Rust toolchain in CI.

**Q4. How does the Rust SDK crate appear in changesets?**
Problem: CI gates on `pnpm changeset status --since=origin/main`, which only inspects npm packages declared in the workspace. A crates.io-tracked `telorun-sdk` has no `package.json` and is invisible to that tool.

Proposed: for the PoC, the Rust crates live **in-tree only** — not published to crates.io, not versioned by changesets. Changesets cover `@telorun/kernel` and `@telorun/starlark` (which gain behavioral changes).

## Out of scope

- **Cross‑platform `.node` distribution.** `NapiControllerLoader` must leave a clean resolution hook for the napi‑rs per‑platform package convention (`@scope/pkg-<triple>` as `optionalDependencies`), but shipping it is a follow‑up. Dev‑mode (`local_path`) build is the only path proven by this PoC.
- **Rust SDK surface — only what starlark needs.** Model `ResourceContext::create_type_validator` and `DataValidator::validate`. Other `ResourceContext` methods are not added until a controller needs them.
- **Capabilities — `Runnable` / `Invocable` only.** No `Service`, `Mount`, `Provider` shape in the Rust SDK trait set.
- **`native` backend — stubs only.** Trait shapes plus `unimplemented!()` bodies; no working pure‑Rust backend.

## Success criteria

1. With `modules/starlark/rust/` present and a test manifest that opts into Rust via `runtime: rust` on the `Telo.Import`, running the manifest triggers `cargo build --release` on first run, produces the `.node` addon (via dylib rename), and hits the Rust addon. Re‑running is fast (cargo cache hit, no recompile).
2. Editing a `.rs` file in the crate and re‑running the opted‑in manifest picks up the change automatically — no manual build step.
3. A manifest with no `runtime:` field on the starlark `Telo.Import` (i.e. `auto`) resolves to the nodejs controller on the Node.js kernel, even when the Rust crate is present. This verifies kernel-native preference is the effective default.
4. With rustc unavailable (verified by spawning `rustc --version` before `cargo build`), `runtime: auto` falls back to the nodejs controller silently. `runtime: rust` errors. Build _failures_ (rustc present, `cargo build` exit ≠ 0) surface cargo's diagnostics and fail hard regardless of `runtime` value — no fallback. Test coverage includes both rustc-absent (PATH-masked) and deliberate-compile-error cases.
5. Registry cache: two `Telo.Import`s of the starlark library with divergent runtime selections (`runtime: nodejs` vs `runtime: rust`) in the same manifest both load and run — the cache's composite `(kind, runtimeFingerprint)` key prevents the first winner from locking out the second.
6. Wildcard fallback: `runtime: [rust, any]` with rustc available loads the rust controller; with rustc PATH-masked, it falls through to nodejs silently (the `any` tail expands to the remaining controllers in definition order). With rustc available but a deliberate compile error, it fails hard — `any` does not mask user-code errors.
7. **The controller crate directory contains no files other than `Cargo.toml`, `src/*.rs`, and cargo‑generated `target/`.** No `build.rs`, no `package.json`, no `.napirc`, no `index.node` committed artifacts. Enforced by a test (e.g. a repo-level script that lists files under `modules/*/rust/` and fails on anything outside the allowlist).
8. The starlark controller crate's `Cargo.toml` contains **no direct dependency on `napi`, `napi-derive`, `napi-build`, or any napi‑rs sub-crate**, and **no `features` block on the `telorun-sdk` dependency**. Only `telorun-sdk = { path = "..." }` (plus pure‑Rust deps like `starlark`, `serde_json`).
9. The starlark controller's `src/lib.rs` contains **no `use napi::…` imports and no `#[napi]` attributes**. Only `#[controller]` from the SDK.
10. Running bare `cargo build` on the controller crate uses the SDK's default `napi` feature and produces the `.node` addon. Running `cargo build --no-default-features --features native` on the **same unchanged crate** compiles successfully against the stub `native` backend. This proves a future Rust kernel can build the same controller by passing different `--features` flags — zero Cargo.toml edits, zero source edits.
11. IDE sanity: `cargo check` with no flags, `cargo clippy` with no flags, and rust-analyzer on a fresh clone all succeed without errors or warnings about missing features. This is the single check that the `default = ["napi"]` decision is right.
12. CI runs `cargo check` for the SDK under the bare default, `--features napi --no-default-features`, and `--features native --no-default-features` — all three must pass on every SDK change.
13. A second hypothetical Rust controller could be added with **zero changes** to `kernel/nodejs/` and **zero per‑controller FFI glue** — only a new crate under its own module, a new PURL entry in that module's `telo.yaml`, and whatever new methods it needs on the shared `sdk/rust/` crate.
14. No change to any other module's runtime behavior.
15. Documentation added at `modules/starlark/docs/` explaining how to build and use the Rust addon (per CLAUDE.md mandatory docs rule), plus a short note at `sdk/rust/README.md` explaining how to author a new Rust controller.
16. Changesets added for `@telorun/kernel`, `@telorun/sdk`, and `@telorun/starlark` (per CLAUDE.md mandatory changesets rule). The Rust crate is in-tree only for the PoC and intentionally not covered by changesets — see Q4.
