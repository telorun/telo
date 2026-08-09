# The step grammar belongs to the SDK

Move step **execution** the rest of the way into `@telorun/sdk`, and make the step
**schema** built-in vocabulary. Today both halves are split at a line nobody chose, and
the split is why a kind that wants a step body cannot have one.

## Problem

**The runtime is already half moved, and the boundary is an accident of history.**
`@telorun/sdk` owns the leaf — `InvokeStep`, `executeInvokeStep`, and an
`InvokeStepContext` that is deliberately structural: *"Satisfied structurally by
`ResourceContext` (Run.Sequence) and by a kernel-side adapter over the root module
context (boot `targets`). The leaf needs nothing else from the kernel."* Two consumers
of different kinds already share it — a module controller and the kernel's own boot
runner.

Everything above the leaf — `if` / `while` / `switch` / `try` / `throw` / `value`,
scopes, catches, the `steps.<name>.result` accumulator — lives in
`modules/run/nodejs/src/engine.ts`, 451 lines reachable only by `run`'s own
controllers. Nothing about that division is principled. It is where the code stopped.

**The schema is duplicated four times.** `modules/run/telo.yaml` is 1632 lines and
carries four separate `$defs` blocks, one per step-bearing kind (`Run.Sequence`,
`Run.Iteration`, `Run.Projection`, `Run.Loop`), each defining its own `step`. JSON
Schema `$defs` are local to the schema that declares them, so four kinds in one file
cannot share one grammar — let alone four kinds in four modules.

**The consequence is that composite kinds cannot carry bodies.** Every kind that wraps
a region of work takes a `!ref` to an executable instead: `Sql.Transaction.steps` is a
ref, and so is every durable `Workflow`'s `invoke:`. That is why a durable workflow
needs a second document to do anything — `Workflow` + `Run.Sequence` — and why
`Durable.Idempotent` will need one too. The indirection buys nothing at the point of
use; it is a workaround for a grammar that cannot be referenced.

**And a module that reimplemented it would fork it.** A controller ships as a bundle
with its dependencies **inlined**, so a step engine reached from `run`, `durable-local`,
`restate`, `temporal`, `sql` and `durable` would exist as six independent copies with
independently drifting behaviour. `plans/durable-execution.md` calls the step engine
*the thing that must not fork* and builds its whole backend seam around not forking it;
six inlined copies is the shape of exactly that failure.

## Solution

Two halves, two mechanisms, because they are consumed by different things.

### Execution moves to `@telorun/sdk`

The engine follows the leaf it already delegates to. It is written against a
**structural context** — the `InvokeStepContext` pattern, widened to what control flow
additionally needs (`expandValue`, `invoke`, `invokeResolved`, scope handling) — so it
depends on neither the kernel nor `run`, exactly as the leaf does today.

**The SDK is not a convenient home, it is the only correct one.** `@telorun/sdk` is the
single name in `REALM_COLLAPSE_NAMES`: the bundle loader symlinks it into every
controller bundle rather than inlining it, which is what makes `Stream` and
`InvokeError` `instanceof` checks hold across the kernel/controller boundary. One copy,
one identity, one behaviour. Anywhere else — a shared module, a published library, a
copied file — is N copies by construction.

It also retires a question the durable plan keeps re-litigating: whether `run` may gain
a dependency, whether `durable-local` may reach the engine, which direction the import
points. With the engine in the SDK, nobody imports anybody.

### The schema becomes built-in vocabulary

A YAML manifest cannot import a TypeScript constant, so the grammar cannot ride along
in the SDK. It becomes an annotation the analyzer and kernel understand:

```yaml
steps:
  title: Steps
  type: array
  x-telo-steps: true        # the grammar is supplied; do not restate it
```

Precedent on both sides. **`x-telo-binary`** is already an annotation that *emits
validation* rather than merely describing — the argument that made it legal (an `x-`
key degrades to "unconstrained" for unaware tooling, by specification) applies
unchanged. And **`x-telo-step-context`** already marks step arrays for the analyzer,
naming which fields carry the invoke ref, the output type and the pure-value form:

```yaml
x-telo-step-context: { invoke: invoke, outputType: outputType, value: value }
```

That parameterisation exists only because the analyzer does not know the step shape.
Once the shape is built-in it does, so **`x-telo-step-context` collapses into
`x-telo-steps`** — four annotations become one, and the analyzer stops being told
something it can derive.

The analyzer is already half-committed regardless: `call-graph.ts` owns the only
step-array recursion in the codebase, and `validate-step-inputs`,
`resolve-throws-union`, `validate-throws-coverage` and `validate-cel-context` all read
step arrays today.

### What this makes possible

- `run`'s four `$defs` copies collapse to four annotations. `Run.Sequence` becomes a
  thin `Telo.Runnable` wrapper over built-in vocabulary rather than the owner of it.
- **Any kind can carry a step body.** `Sql.Transaction`, `Durable.Idempotent` and every
  backend `Workflow` gain `steps:` natively — one document instead of two, no `!ref`
  ceremony, no duplication.
- **The polymorphic body survives, at a cost of two lines.** A kind with native
  `steps:` has not given up an arbitrary executable body: `steps: [{ invoke: !ref
  somethingElse }]` is one step. So there is no need for both `steps:` and `invoke:` on
  the same kind — one slot, no union, no two ways to say one thing.

### What does not move

`modules/run` keeps its kinds. The scope variables the wrapper kinds inject — `item`,
`index`, `iteration`, `previous` — are theirs, and so is the fan-out `concurrency`
loop; the SDK owns the grammar and its execution, not every composition over it. Where
exactly concurrent fan-out sits is the one boundary worth deciding during
implementation rather than here, because `plans/durable-execution.md` puts
branch-level parking under it.

**Polyglot is unaffected.** The Rust kernel needs its own engine either way; what binds
the two is the normative contract — the determinism rule and key scheme in
`kernel/specs/durable-execution.md` — not the TypeScript. Moving the Node
implementation to the Node SDK does not make the spec less necessary; it makes the Node
side stop having two of them.

## Decisions

- **The engine goes to `@telorun/sdk`, not to a shared module** — the SDK is
  realm-collapsed (symlinked into every bundle); a module is inlined. For a component
  whose whole design premise is that it must not fork, the difference is one copy
  versus one per consumer. Rejected: a `modules/step-engine` library, which reads
  tidier and delivers six behaviours.
- **The engine keeps a structural context, not a kernel import** — this is the existing
  `InvokeStepContext` property and it is what lets the same code serve a module
  controller and the kernel's boot runner. Widening it is a smaller change than it
  looks precisely because the leaf already proved the shape.
- **The schema is an annotation, not a cross-module `$ref`** — a manifest cannot import
  a constant, and a `$ref` reaching into another module's schema would need a new
  resolution mechanism *and* would make `sql` import `run` to describe its own
  transaction, inverting the dependency for a grammar neither owns. Rejected:
  cross-module `$defs` resolution.
- **`x-telo-step-context` collapses into `x-telo-steps`** — its three keys exist only
  to tell the analyzer where the invoke ref, output type and value field live in a shape
  it does not know. Once the shape is built-in, telling it is redundant and can drift.
- **One slot per kind (`steps:`), never `steps:` alongside `invoke:`** — a one-step
  body recovers the arbitrary-executable case exactly, so a second slot would be two
  spellings of one thing, and the zone-providing annotation would have to sit on both.
- **`Run.Sequence` survives as a kind** — it is the `Telo.Runnable` entry point for a
  step list with no other purpose, which is a real role. It simply stops being where
  the grammar lives.

## Sequencing

1. **Engine to the SDK.** Move `StepEngine` beside `executeInvokeStep`, widen the
   structural context, leave `run`'s controllers as thin callers. No manifest changes,
   no schema changes, no behaviour change — a pure relocation, verifiable by the
   existing suite.
2. **`x-telo-steps` in the analyzer and kernel.** Supply the grammar for an annotated
   array; keep `x-telo-step-context` working alongside it so nothing breaks mid-flight.
3. **Migrate `run`.** Four `$defs` blocks out, four `x-telo-steps` in,
   `x-telo-step-context` removed. This is the slice that proves the grammar is complete
   — if anything was kind-specific, it shows up here.
4. **Native bodies for composite kinds.** `Sql.Transaction` gains `steps:`;
   `Durable.Idempotent` and the backend `Workflow` kinds are authored with it from the
   start.

Slices 1 and 2 are independent and either can go first; 3 depends on both; 4 depends
on 3.

## Relationship to `plans/durable-execution.md`

This is a **prerequisite**, and it changes that plan in three places rather than
merely enabling it.

- Every backend `Workflow` kind carries `steps:` natively, so the two-document shape
  (`Workflow` + a named `Run.Sequence`) disappears from its examples.
- `Durable.Idempotent` is authored with a step body rather than an `invoke:` ref.
- Its *seam* slice gets smaller: "the step engine must not fork" stops being an
  argument the durable plan has to win, because by then the engine is in the one place
  that cannot fork. The seam still exists — a backend still decides *whether* and
  *where* a step executes — but it is a narrower claim.

It does **not** change the run-handle seam, the journaling and decision model, the zone
attributes, or the backend split. Those rest on the engine being *one* implementation,
which is what this plan delivers, not on where that implementation lives.
