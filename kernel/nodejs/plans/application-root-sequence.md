# Application targets as a flat boot sequence

## Problem

Running anything on boot today requires the `run` module. To execute even a flat list of invocations — the overwhelmingly common case — an Application imports `std/run`, declares a `Run.Sequence`, and points `targets` at it by name.

The usage data makes the cost concrete:

- `run` is the most-imported stdlib module — ~69 importers — and exports exactly one kind, `Run.Sequence`.
- Of ~130 `Run.Sequence` declarations, ~123 are boot targets (named in an Application's `targets`), and ~86 (66%) are a flat list of `invoke` steps with at most a `when:` guard — no `if`/`while`/`switch`/`try`, no `with:` scope, no `inputs`/`outputs`.
- So most apps import `run` solely to run a flat, optionally-gated list of invokes on boot. The import plus the `Run.Sequence` document is pure boilerplate.

Two concrete pains fall out:

1. **No conditional boot.** There is no way to gate a target on a variable ("start dev-tools only when `mode == dev`", "seed the DB only when `seed` is set") without importing `run` and rewriting the boot entry as a `Run.Sequence`.
2. **Import noise.** Trivial apps and virtually every module test carry a `run` import and a wrapper document just to do flat sequencing.

The capable engine — control flow, scopes, error handling — already exists in `modules/run/nodejs/src/sequence.ts`. The goal is **not** to relocate that engine into the kernel; it is to let the flat 66% live directly on the Application without importing `run`, while sharing one leaf executor so the two paths can never diverge.

## Design

Give Application `targets` a flat, declarative step form, executed on boot, built on a single leaf invoke-step executor shared with `Run.Sequence` through the SDK.

### `targets` shape

`targets` becomes an `anyOf` of three forms, mixable in one list:

```yaml
targets:
  - MyServer                                   # bare ref — run() a Runnable/Service (unchanged)

  - ref: DevTools                              # gated ref — run() only when the guard holds
    when: "${{ variables.mode == 'dev' }}"

  - name: Seed                                 # inline invoke — call an Invocable
    invoke: { kind: Db.Seed }
    inputs: { count: "${{ variables.seed_count }}" }
    when: "${{ variables.seed }}"

  - name: Check
    invoke: { kind: Assert.Schema }
    inputs: { value: "${{ steps.Seed.result }}" }   # result plumbing between targets
```

- **Flat by construction.** An inline target is a single `invoke` leaf plus an optional `when:` guard and `retry:`. It is *not* the nested step type — `if`/`while`/`switch`/`try`/`throw`/`with`/`inputs`/`outputs` are not available here. The schema admits only the leaf, so there is no partial engine to misread and nothing to render in the editor beyond a flat node list.
- **Discrimination.** A bare string runs a `Runnable`/`Service`. An object with `ref` is a gated reference (still `run()`). An object with `invoke` is an inline `Invocable` call. Inline targets are invocable-only; running a `Runnable`/`Service` stays the `ref`/bare-string form.
- **CEL scope.** `when:` and `inputs:` evaluate against the root scope (`variables`/`secrets`/`ports`/`resources`) plus `steps.<name>.result` accumulated from earlier targets. Targets run after all resources init, so `resources.*` is available.
- **Reach for `Run.Sequence`** when a boot entry needs control flow, a `with:` scope, or a return value.

### Shared leaf executor (SDK)

The leaf invoke-step semantics live once, in the SDK, as a public primitive — **not** in the kernel.

- **Dependency direction.** `@telorun/sdk` is the foundation: it *defines* the contracts (`ResourceContext`, `KindRef`, `ScopeContext`, `InvokeError`) locally and has no kernel dependency. The kernel depends on the SDK (21 src files; `workspace:*`). The `run` module depends on the SDK, not the kernel. The kernel imports nothing from `modules/run`.
- The leaf executor in `sequence.ts` already runs entirely on SDK contracts (`ctx.expandValue`, `ctx.invoke`, `ctx.invokeResolved`, `InvokeError`, `KindRef`, `ScopeContext`) — zero kernel internals. It moves into the SDK as a public export, where both consumers already stand.
- Signature, roughly: `executeInvokeStep(step, ctx, celScope, scope?) → { result } | skipped` — the `when` guard, `inputs` CEL expansion, ref resolution, `retry`, and the `steps.<name>.result` shape, single-sourced.

The kernel boot runner and the `Run.Sequence` controller become **peers** on top of this primitive; neither owns the other, and the `when`/`inputs`/`retry`/result-shape semantics cannot drift. Because the shared logic sits at the SDK / module-author layer (a small, well-specified leaf) rather than in the kernel orchestrator, a polyglot kernel gains a flat boot runner without embedding an interpreter.

### Boot path (kernel)

- The kernel's flat `targets` runner iterates the list, threads an accumulating `steps` object, and calls the SDK leaf executor for each `invoke` target; bare/`ref` targets dispatch to `run()`, gated by `when`.
- The kernel resolves inline kinds in `invoke` targets the same way the `run` controller does today (`ctx.resolveChildren`, already available to it).
- The existing bare-string target path is unchanged and back-compatible — manifests using it are untouched.

### `Run.Sequence` (run module)

- Its controller's invoke-leaf execution delegates to the SDK leaf executor instead of its private copy — it sheds the duplicate and gets thinner.
- It keeps everything the kernel does not have: the control-flow traversal (`if`/`while`/`switch`/`try`/`throw`), `with:` scopes, and the `inputs`/`outputs` callable wrapper. The ~34% of sequences that branch, loop, catch, scope resources, or serve as per-request HTTP handlers continue to work unchanged.

### Canonical leaf schema

- The leaf invoke-step schema (`name`/`invoke`/`inputs`/`when`/`retry`, with its `x-telo-topology-role` annotations) becomes canonical in `analyzer/nodejs/src/builtins.ts`. The Application `targets` form consumes it directly; `Run.Sequence`'s `invoke` branch references the same leaf and keeps the control-flow branches (`if`/`while`/`switch`/`try`/`throw`) in `modules/run/telo.yaml`.
- `when` becomes a first-class, schema-declared field on the leaf. Today the executor honours `when` on invoke steps (`sequence.ts` reads `step.when`) but `modules/run/telo.yaml` never declares it — so `when` works at runtime yet is invisible to the analyzer. Promoting it to the canonical leaf fixes that for `Run.Sequence` and gives `targets` its gating field from the same source.
- The analyzer already resolves topology generically from annotations, so no kind-specific analyzer code is added — the flat `targets` leaf is typed by the same generic resolver.

## Boundaries

- **Flat only.** `targets` gains the invoke leaf and `when`; control flow, scopes, and the callable wrapper stay in `Run.Sequence`. The moment a boot entry needs `if`/loop/`try` it imports `run` — which then reads as a signal of real complexity rather than noise.
- **Gates `run()`, not existence.** A `when:` on a target gates whether that listed target runs. It does not gate whether a resource is instantiated, and it does not affect auto-start Services (which come up on init regardless). Conditional resource *existence* is a separate, heavier concern and out of scope here.

## hello-world

`examples/hello-world.yaml` drops the `run` import and the `Run.Sequence` document; the `Console.WriteLine` invoke moves inline onto `targets`. It still imports `Console`.

```yaml
targets:
  - name: SayHello
    invoke: { kind: Console.WriteLine }
    inputs: { output: "Hello from Telo!" }
```

## Impact

The flat `targets` form eliminates the `run` import from ~41 of ~69 importers (~59%) and covers ~66% of all `Run.Sequence` instances. `run` remains necessary — and now meaningful — for the ~34% that branch, loop, catch, open `with:` scopes, or serve as callable handlers.

## Housekeeping

- Changeset covering the affected packages: `@telorun/sdk` (new public leaf executor), kernel (`targets` schema + boot runner), `run` module (delegate to the SDK leaf), analyzer (canonical leaf schema, `targets` typing).
- Documentation: update `modules/run/docs/` (`Run.Sequence` is now the control-flow tier; flat boot sequencing moves to `targets`) and the hello-world example. If a new doc page is added, wire it into `pages/docusaurus.config.ts` and `pages/sidebars.ts`.
