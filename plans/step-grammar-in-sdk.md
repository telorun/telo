# The step grammar belongs to the SDK

Move step **execution** the rest of the way into `@telorun/sdk`, and make the step
**schema** a shared manifest fragment any kind can point at. Today both halves are split
at a line nobody chose, and the split is why a kind that wants a step body cannot have
one.

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

**The schema is duplicated four times.** `modules/run/telo.yaml` is 1536 lines and
carries four separate `$defs` blocks, one per step-bearing kind (`Run.Sequence`,
`Run.Iteration`, `Run.Projection`, `Run.Loop`), each defining its own step. Three of
them (`bodyStep`) are byte-identical to each other; the fourth (`step`) differs by
exactly one `oneOf` branch — `while/do`, which the wrapper kinds drop with "the kind
is itself the loop". JSON Schema `$defs` are local to the schema that declares them,
so four kinds in one file cannot share one grammar — let alone four kinds in four
modules.

**The consequence is that composite kinds cannot carry bodies.** Every kind that wraps
a region of work takes a `!ref` to an executable instead: `Sql.Transaction.steps` is a
ref, and so is every durable `Workflow`'s `invoke:`. That is why a durable workflow
needs a second document to do anything — `Workflow` + `Run.Sequence` — and why
`Durable.Idempotent` will need one too. The indirection buys nothing at the point of
use; it is a workaround for a grammar that cannot be referenced.

**And a module that owned it would fork it along version.** `exports.code:` means a
shared module library is no longer copied per consumer — the loader externalizes the
bare specifier and every dependent's shim resolves to the owning module's own entry
file, so one scope serves them all. What it does not remove is skew: dedup is per
(module, resolved version) and a mismatch is *reported, not prevented*, so two
dependents pinning different versions legitimately run two engines in one process. For
a component whose contract is journal-key determinism across a durable run, that is the
failure itself, arriving as a supported outcome. And two consumers sit outside the seam
altogether: an npm-delivered controller resolves its copy from its own tarball with
nothing to report it — `sql-sqlite` is one, on the `sql` path this plan names.
`plans/durable-execution.md` calls the step engine *the thing that must not fork* and
builds its whole backend seam around not forking it.

## Solution

Two halves, two mechanisms, because they are consumed by different things.

### Execution moves to `@telorun/sdk`

The engine follows the leaf it already delegates to. It is written against a
**structural context** — the `InvokeStepContext` pattern, widened to what control flow
additionally needs (`expandValue`, `invoke`, `invokeResolved`, scope handling) — so it
depends on neither the kernel nor `run`, exactly as the leaf does today.

**The SDK is not a convenient home, it is the only correct one.** `@telorun/sdk` is the
single name in `REALM_COLLAPSE_NAMES`: the bundle loader symlinks it into **the
kernel's own copy** rather than inlining it, which is what makes `Stream` and
`InvokeError` `instanceof` checks hold across the kernel/controller boundary. One
version per process, whatever anyone pins. A module library is one scope per pinned
version — which is one more than a step engine may have — and a copied file is one per
consumer.

It also retires a question the durable plan keeps re-litigating: whether `run` may gain
a dependency, whether `durable-local` may reach the engine, which direction the import
points. With the engine in the SDK, nobody imports anybody.

### The schema becomes a shared manifest fragment

A YAML manifest cannot import a TypeScript constant, so the grammar cannot ride along
in the SDK. It does not need to: the analyzer already owns a namespace for exactly
this — structural shapes several unrelated documents agree on, pointed at with
`$ref: "telo://manifest#/$defs/<Name>"` and resolved by the shared loader.

```yaml
steps:
  title: Steps
  type: array
  x-telo-topology-role: steps
  items:
    $ref: "telo://manifest#/$defs/Step"
```

**The mechanism is already used at this exact site.** The first `oneOf` branch of
`run`'s own step def is `$ref: "telo://manifest#/$defs/InvokeStep"`, and
`resolveLocalRef` resolves manifest fragments at the analyzer's single structural
chokepoint precisely so that a composer pointing at a shared shape "stays legible to
all of them at once — the step-array walks, the call graph, the zone projection, the
eval-path collector". Promoting the whole step def to a `Step` fragment finishes a job
already begun; a new annotation would start a parallel one.

**The recognizer is a derived stamp, not a marker.** Fragment expansion stamps every
slot with `x-telo-fragment: <Name>`, so "is this array a step array" is
`manifestFragmentOf(field.items) === "Step"` — read through one accessor
(`analyzer/nodejs/src/step-slot.ts`, the `ref-slot.ts` / `zone-slot.ts` precedent) by
the call graph, `validate-step-inputs`, `resolve-throws-union`,
`validate-throws-coverage` and `validate-cel-context`. That stamp is what already
retired `x-telo-retry`: the analyzer reads `step.retry.attempts` because that is what
a step IS, rather than discovering a retry-bearing field through a marker the kind had
to remember to write. An `x-telo-steps` annotation would be the third spelling of one
fact — beside `x-telo-step-context` (analyzer) and `x-telo-topology-role: steps`
(editor) — and the only one an author can forget.

**`x-telo-step-context` collapses into the stamp.** Its three keys (`invoke`,
`outputType`, `value`) exist only to tell the analyzer where those fields live in a
shape it does not know; once the shape is the fragment, they are constants of it. It
keeps being READ for already-published modules — no migration entry can synthesize a
`$ref`, since the patch vocabulary writes scalars — exactly as the legacy `x-telo-ref`
string form does.

**`Step` is the first RECURSIVE fragment that is not a schema**, which the fragment set
anticipates: "should a self-containing fragment that is not a schema ever land, the two
ideas split and this set stays the one about schemas". So `SCHEMA_FRAGMENTS` splits in
two — `RECURSIVE_FRAGMENTS` drives localize-and-hoist (a shape containing itself cannot
be inlined), `SCHEMA_FRAGMENTS` keeps its one remaining job of saying which completion
vocabulary a slot admits. The hoist target is already right: `schema:` is a depth-0
schema-region key, so the `#/$defs/telo:Step` copy lands at the root of the node AJV
compiles, and `mergeTypeSchemas` already merges `$defs` key-wise for an `extends` child.

**One defect to fix on the way.** `hoistFragmentDef` clones and stamps but never
expands — harmless for `JsonSchema7`, which references no non-recursive fragment, and
fatal for `Step`, whose `oneOf[0]` is a foreign `telo://manifest#/$defs/InvokeStep`
reference. The editor's `$ref` resolver throws on anything not starting with `#/` and
resolves every `oneOf` entry, so an unexpanded hoist takes the canvas down — the same
failure gating fragment expansion once caused. Hoisting must expand nested
non-recursive fragments.

### What this makes possible

- `run`'s four `$defs` copies collapse to four one-line `$ref`s. `Run.Sequence` becomes
  a thin `Telo.Runnable` wrapper over shared vocabulary rather than the owner of it.
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
loop; the SDK owns the grammar and its execution, not every composition over it. The
step ARRAY slot stays with the kind too — its title, its `x-telo-topology-role: steps`
marker, its `x-telo-value-schema-from` — and so does `with:`, whose `x-telo-scope` is a
list of JSON pointers relative to the declaring kind's own resource root, so a kind
spelling its slot `body:` needs its own. Where exactly concurrent fan-out sits is the
one boundary worth deciding during implementation rather than here, because
`plans/durable-execution.md` puts branch-level parking under it.

**Polyglot is unaffected.** The Rust kernel needs its own engine either way; what binds
the two is the normative contract — the determinism rule and key scheme in
`kernel/specs/durable-execution.md` — not the TypeScript. Moving the Node
implementation to the Node SDK does not make the spec less necessary; it makes the Node
side stop having two of them.

## Decisions

- **The engine goes to `@telorun/sdk`, not to a shared module** — the SDK is
  realm-collapsed onto the kernel's own copy, so it is one version per process
  unconditionally. A module library is no longer *inlined* (that is what `exports.code:`
  fixed) but it is still versioned per consumer, skew is reported rather than
  prevented, an npm-delivered controller is outside the seam entirely, and the kernel's
  own boot runner cannot reach it at all — so the leaf would stay in the SDK and the
  engine would sit one module away, re-creating this plan's opening complaint. It also
  puts a declared `imports:` edge on every consumer (`sql`, `durable-local`, `restate`,
  `temporal`), which is the dependency-direction question the SDK retires outright.
  Rejected: a `modules/step-engine` library, which reads tidier and delivers one engine
  per pinned version.
- **The engine keeps a structural context, not a kernel import** — this is the existing
  `InvokeStepContext` property and it is what lets the same code serve a module
  controller and the kernel's boot runner. Widening it is a smaller change than it
  looks precisely because the leaf already proved the shape.
- **The schema is an analyzer-owned fragment — not an annotation, and not a
  cross-module `$ref`.** Three options, not two. A `$ref` into another module's `$defs`
  would need a new resolution mechanism *and* would make `sql` import `run` to describe
  its own transaction, inverting the dependency for a grammar neither owns. A new
  `x-telo-steps` annotation is a marker an author has to remember to write, of exactly
  the kind the `x-telo-fragment` stamp already retired once (`x-telo-retry`). The
  `telo://manifest` namespace is neither: it is where `InvokeStep`, `RetryPolicy` and
  `JsonSchema7` already live, it already carries this very step schema's dispatch
  branch, and every structural walk already resolves it at one chokepoint. Rejected:
  cross-module `$defs` resolution; a new annotation.
- **`x-telo-step-context` collapses into the `x-telo-fragment: Step` stamp** — its three
  keys exist only to tell the analyzer where the invoke ref, output type and value field
  live in a shape it does not know. Once the shape is the fragment, they are constants
  of it. It stays read for published modules, with the standing of the legacy
  `x-telo-ref` string form.
- **`while/do` is admitted in every step body** — a fragment cannot be narrowed by its
  consumer (draft-07 makes `$ref` exclusive, so siblings reach completion and hover but
  never AJV), and the three wrapper kinds drop that one branch for an editorial reason
  ("the kind is itself the loop"), not a soundness one: a nested `while` inside a
  for-each body is ordinary control flow the same executor already runs. Admitting it is
  a strict widening that breaks no manifest. Rejected: a second while-less fragment,
  which puts the duplication back into the one place this plan exists to remove it
  from.
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
2. **The `Step` fragment.** Add it to `ManifestRootSchema`; split `SCHEMA_FRAGMENTS`
   into the recursive set (localize-and-hoist) and the schema set (which vocabulary);
   make `hoistFragmentDef` expand nested non-recursive fragments; add the `step-slot.ts`
   accessor and read it beside `x-telo-step-context` so nothing breaks mid-flight.
3. **Migrate `run`.** Four `$defs` blocks out, four `items: { $ref: … }` in,
   `x-telo-step-context` off run's own kinds. This is the slice that proves the grammar
   is complete — if anything was kind-specific, it shows up here.
4. **Native bodies for composite kinds.** `Sql.Transaction` gains `steps:`;
   `Durable.Idempotent` and the backend `Workflow` kinds are authored with it from the
   start.

Slices 1 and 2 are independent and either can go first; 3 depends on both; 4 depends
on 3.

**Slices 1–3 are implemented.** `run` declares `requires: { telo: ">=0.79.0" }` — the
grammar is a fragment an older analyzer cannot resolve, so a consumer on 0.78.0 must
be told the version, not handed an unresolvable `$ref` inside a module it does not own.

### What slice 4 turned out to need first

`Sql.Transaction.steps` is not merely a ref that becomes an array: it is the slot
carrying `x-telo-provides-zone: /connection`. A providing annotation is read on a REF
slot, and the zone projection discharges a requirement along the call-graph edge out of
that slot. A step body has no such edge — it has one per step, plus whatever its
branches nest — so "this body provides a zone" is a relation the projection does not
currently express.

Two shapes, and the choice is a real one because it decides what a provision MEANS:

- **The provision attaches to the body**, discharging every requirement reachable
  through its steps. Matches the runtime exactly (the controller opens the zone once
  around `executeSteps`), and generalises to every composite kind that will carry a
  body — a durable run and a batch want the same reading. Costs a case in
  `resolve-zone-requirements.ts` for a providing slot whose outgoing edges are step
  edges.
- **The provision stays on a ref**, and a native body is simply not zone-providing —
  `Sql.Transaction` keeps its ref slot and only the kinds that provide no zone gain
  bodies. Nothing changes in the analyzer, and the shape this plan set out to remove
  survives in the one kind that most wants it.

Until that is decided, slice 4 is unstarted; nothing in slices 1–3 depends on it.

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
