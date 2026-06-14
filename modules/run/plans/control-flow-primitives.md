# Declarative control-flow primitives for `std/run`

## Problem

`std/run` ships two kinds: `Run.Sequence` (ordered steps, with inline `if`/`while`/`switch`/`try` blocks) and `Run.Value` (pure value/mapping). Two common shapes have no declarative expression and force authors into either a hand-rolled `while` with manual index bookkeeping or an inline `JS.Script`:

- **Bounded repetition** — repeat work until a condition holds or a cap is reached (poll-until-ready, retry-shaped loops).
- **Iteration over a collection** — run a body per element, optionally collecting a transformed value per element, with controllable concurrency.

Both must stay type-safe, statically analyzable, and visually editable — the same bar as `Run.Sequence`.

## Solution

Add three kinds to `modules/run/telo.yaml`, each a thin **binding wrapper** over the existing `Run.Sequence` body. They reuse `Run.Sequence`'s `steps` grammar — **minus the inline `while` block**, since the kinds are themselves the loop primitives — plus its `inputs` (input contract) and `outputs` (CEL result map). Concretely the body validates against a reduced `$defs/bodyStep` (the `invoke` / `if` / `switch` / `try` / `throw` variants, no `while`); the step-execution engine that runs them stays shared and unchanged. The only thing each kind adds is a binding header and the extra CEL scope it puts in front of the body. `Run.Sequence` keeps its own inline `while` — it is **not** removed.

- **`Run.Loop`** (`Telo.Runnable`) — repeats the `steps` body. Header: `condition` (CEL bool, continue while true) and/or `maxIterations` (CEL int cap); at least one required, loop stops at whichever trips first. Adds scope `iteration` (0-based integer) and `previous` (the prior iteration's `steps` map; nullable on iteration 0).
- **`Run.Iteration`** (`Telo.Runnable`) — runs the `steps` body once per element of `collection` (CEL → array). No collected result. Header: `collection`, `concurrency` (default 1). Adds scope `item`, `index` (integer), `items`.
- **`Run.Projection`** (`Telo.Invocable`) — same per-element binding as `Run.Iteration`, but collects each element's `outputs` into an array, preserving input order even under concurrency. Header: `collection`, `concurrency`. Adds scope `item`, `index`, `items`.

All three accept an optional kind-level **`catches`** list — the repo's house-style error contract (`x-telo-catches-for` / `x-telo-outcome-list`, `error` typed via `x-telo-error-context`). It catches a throw that escapes the **whole operation** and maps it to the operation's fallback result; entries are `{ when: <CEL over `error`>, value }` and their CEL scope is `error` + `inputs` (not `item`/`index`). Per-element recovery stays inside the `steps` body via the existing inline `try/catch`.

Implementation reuses the `RunSequence` engine. `executeSteps`/`executeStep`/`resolveInvokes` and the step-type machinery in `modules/run/nodejs/src/sequence.ts` move into a shared `engine.ts` in the same package; `sequence.ts` and the three new controllers (`loop.ts`, `iteration.ts`, `projection.ts`) import it and differ only in how they drive it and which `extraCtx` they inject per body execution. Each new controller, like `RunSequence`, implements both `run()` and `invoke()` and honours `outputs`, so a `Run.Loop` used as a step can hand back its final state. New controllers are exported from `@telorun/run` (`#loop`, `#iteration`, `#projection`) and registered as `Telo.Definition` docs with `controllers: pkg:npm/@telorun/run@<ver>?local_path=./nodejs#<name>`. Add the three names to `exports.kinds`.

Iteration/Projection introduce one new analyzer capability: typing `item`. A new generic annotation **`x-telo-context-element-from: "collection"`** resolves the CEL type of the sibling `collection` expression, requires an array, and exposes its element schema as the bound variable; an explicit optional **`itemType`** field is the escape hatch when `collection` flows from an untyped input, and the analyzer falls back to opaque `dyn` otherwise (gradual typing, matching `x-telo-stream` past a boundary). `index`/`iteration` are static integers, `previous`/`items` reuse existing context annotations, and `Run.Projection`'s own `outputType` is derived as `array<element>` from its `outputs` so downstream `steps.proj.result[0].field` type-checks (same mechanism as `x-telo-step-context`).

## Decisions

- **Three kinds, parallelism is a field not a kind** — `concurrency` on `Run.Iteration`/`Run.Projection` (default 1 = ordered sequential, `>1` = that many elements in flight). A separate `Run.Parallel` was dropped: "run the body per item, items concurrently" is exactly `Run.Iteration`/`Run.Projection` with `concurrency > 1`, so a distinct kind would be redundant.
- **Declarative field names** — `steps` / `inputs` / `outputs` / `collection` / `condition` / `maxIterations` / `concurrency` / `onError`. Names describe the construct, matching the `Run.Sequence`/`Run.Value` noun register; rejected verb-ish `do`/`each`/`in`/`while`/`times`.
- **Body reuses Sequence's step grammar minus the inline `while` block** — a reduced `$defs/bodyStep` (keeps `invoke` / `if` / `switch` / `try` / `throw`; drops `while`). The new kinds *are* the loop primitives, so an inline `while` inside their bodies is redundant — nest a `Run.Loop`/`Run.Iteration` instead. Precedent: `targets` already runs a deliberately reduced step vocabulary that omits control flow ([analyzer/nodejs/src/builtins.ts](analyzer/nodejs/src/builtins.ts) — *"Control flow (if/while/switch/try) is not available here — reach for Run.Sequence"*). The step-execution engine stays shared and whole; only the schema narrows, so there is still one engine and one renderer.
- **`while` stays in `Run.Sequence`; not removed globally** — rejected removing it in favour of `Run.Loop`. A `Removed` changie kind would force `run` → 1.0.0 and is blocked by `scripts/check-no-major-module-bump.mjs`; and since `if`/`switch`/`try` have no standalone replacement, deleting only `while` would be an asymmetric, unexplainable cut. So inline `while` remains the in-sequence loop; `Run.Loop` is the standalone/iteration-scoped one.
- **`maxIterations` over `maxTimes`** — reads against the `iteration` counter variable.
- **`Run.Loop` exposes `previous`** (prior iteration's `steps` map, nullable) — enables poll-until-ready conditions; unguarded access is caught by the existing `CEL_NULLABLE_ACCESS` rule.
- **Error handling is `catches`, not a policy enum** — rejected `onError: fail | settle`. `onError` read like a handler hook, and the fail-vs-settle behaviour falls out of the existing `catches` convention instead of needing its own field: whole-operation `catches` maps an escaped throw to a fallback result; an uncaught throw aborts (fail-fast, cancelling in-flight siblings); "settle/continue past a bad element" is expressed where it belongs — an inline `try/catch` around that element's `steps`. Fail-fast is the fixed default. Whole-operation level (not per-element) was chosen to match how routes/handlers use `catches` everywhere else.
- **Shared engine extraction** — move the step machinery out of `sequence.ts` into `engine.ts` within the same package so all four kinds share one execution path; rejected duplicating the engine per controller.
- **`x-telo-context-element-from` + `itemType` escape hatch** — one generic, kind-agnostic annotation for element typing (honours the topology-driven constraint: no resource-kind knowledge hardcoded in the analyzer), with sound gradual fallback to `dyn`.
- **Versioning & docs** — add a changeset for the `@telorun/run` npm bump (the module's changie fragment is auto-generated from it); use `Added` (minor). New docs under `modules/run/docs/` wired into `pages/docusaurus.config.ts`, `pages/sidebars.ts`, with `sidebar_label` frontmatter. Add `modules/run/tests/*.yaml` per kind.

## Example after the change

```yaml
# Poll a job until ready, capped at 10 attempts
- kind: Run.Loop
  metadata: { name: PollUntilReady }
  condition: !cel "previous == null || !previous.check.result.ready"
  maxIterations: !cel "10"
  steps:
    - name: check
      invoke: !ref GetStatus
      inputs: { id: !cel "inputs.jobId" }

# Email every user, 10 in flight at a time; continue past a bad address
# (per-element settle = inline try/catch in the body)
- kind: Run.Iteration
  metadata: { name: NotifyUsers }
  collection: !cel "inputs.users"
  concurrency: 10
  steps:
    - name: guarded
      try:
        - name: send
          invoke: !ref SendEmail
          inputs: { to: !cel "item.email", n: !cel "index" }
      catch:
        - name: report
          invoke: !ref LogFailure
          inputs: { user: !cel "item", error: !cel "error.message" }

# Enrich each id, collect results into an array (input order preserved);
# map a whole-operation failure to a fallback result (kind-level catches)
- kind: Run.Projection
  metadata: { name: EnrichIds }
  collection: !cel "inputs.ids"
  concurrency: 8
  steps:
    - name: fetch
      invoke: !ref FetchRecord
      inputs: { id: !cel "item" }
  outputs:
    id:   !cel "item"
    name: !cel "steps.fetch.result.name"
  catches:
    - when: !cel "error.code == 'RATE_LIMITED'"
      value: []
# result -> [ { id, name }, ... ]   (or [] if the operation is rate-limited)
```
