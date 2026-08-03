# Named bindings and pure steps in `run`

## Problem

Two shapes of pure computation have no declarative expression, and both drive authors to a `JS.Script` — not for a missing operation (the CEL catalog already has `parseJson`, `sha256`, `uuidv4`, `nowIso`, `regexGroups`, `sum`/`avg`/`min`/`max`, `sort`/`distinct`/`flatten`) but for no way to *name a step of a calculation*:

- **Inside a pure expression kind.** `Run.Value` evaluates one expression, so four derived values become one nested unreadable blob. `Run.Choice` re-computes the same subexpression in every row that needs it.
- **Inside a sequence.** An intermediate derived from a step's result — reshape a response, compute a total from rows, build the next call's inputs — costs a full `Run.Value` resource plus a dispatch, a span, a topology node and a module-scope name, for arithmetic. This is where post-processing of step output turns into a script.

The fix must stay type-checked, visually editable, and free of kind-specific knowledge in the analyzer.

## Solution

Two constructs, one per shape.

### 1. `bindings:` on the expression-scope kinds — `Run.Value` and `Run.Choice`

A **name-keyed map** of CEL expressions, evaluated in the kind's own invoke scope (`inputs`) and visible in `value`, in every row's `when`/`value`, and in `default`.

Order is **derived, not declared**: each expression's identifier chains name its dependencies, the set is topologically sorted, and a cycle is a static error. This follows the repo convention that an array means order is load-bearing (`steps`, `choices`, `targets`) and a map means it is not (`imports`, `variables`, `ports`, `cases`) — depending on YAML key order would be the first construct to break it, and would require insertion order to survive every loader/formatter/editor round-trip. It also makes duplicate names unrepresentable, drops the redundant `name:` column in the editor, and makes reordering rows safe.

Names are read **bare** (`gross - discount`, not `bindings.gross`) — that readability is the whole point — and evaluation is **lazy and memoised per scope entry**: a binding is computed on first use, at most once. This keeps a binding exactly equivalent to inlining its expression at each use site, which is what makes the feature a refactoring rather than a behaviour change.

Binding names stop at a nested inline `{ kind }` boundary inside a value, mirroring where the eval-path check already stops — that CEL belongs to the nested kind.

### 2. A pure step in the shared step grammar

A step variant carrying `value:` instead of `invoke:`, added to `$defs/step` and `$defs/bodyStep` so it is available in `Run.Sequence`, `Run.Loop`, `Run.Iteration` and `Run.Projection`. It evaluates its expression in the ordinary step scope — `inputs`, prior `steps.*`, and whatever the enclosing kind binds (`item`/`index`/`items`, `iteration`/`previous`) — publishes `steps.<name>.result`, and dispatches nothing: no resource, no span, no topology node.

This is what answers the sequence half of the Problem, and it needs no new scope rules: ordering, `steps.<name>.result` plumbing, error propagation and editor rendering are the ones the step grammar already has. There is no dispatch target whose contract could type its result, so it follows the binding rule instead: a plain chain into something already typed (an earlier step's result, the kind's `inputType`) carries that type through, and anything else stays permissive rather than guessed. The step is recognised generically: `x-telo-step-context` gains an optional `value` key naming the field that produces a result without dispatching. Implementation is one more branch in the shared `modules/run/nodejs/src/engine.ts`.

A `bindings:` header on the step kinds was rejected in its favour: bindings are evaluated before any step of their scope runs, so such a header could only ever see `inputs` — leaving the case that matters untouched while adding a third evaluation timing for authors to carry.

### Names and shadowing

A binding may not shadow **any name the CEL environment already binds at that site**, and the set is read from `buildCelEnvironment` (`analyzer/nodejs/src/cel-environment.ts`) rather than enumerated. That environment is already the single place where the ambient root variables (`variables`, `secrets`, `resources`, `ports`) and the annotation-contributed ones meet — `x-telo-context`, `x-telo-error-context` (which merges `error` at arbitrary depth through `try`/`catch`/`finally`), `x-telo-step-context`, element contexts — so a future ambient variable is covered the day it is registered, with no second list to keep in step. A collision is `BINDING_NAME_RESERVED`.

Because no check can be proven complete against scopes that do not exist yet, the rule is backed by a runtime guarantee as well: **scope variables always win over bindings**, and CEL's macro-bound identifiers keep CEL's own lexical scoping. A variable the walk misses therefore degrades to "this binding is invisible in that region" — visible, recoverable, and never a corrupted scope variable.

### Where the logic lives

The derivation — dependency extraction, evaluation order, cycle and reserved-name detection — is one browser-safe module, `analyzer/nodejs/src/cel-bindings.ts`, alongside `invocation-contract.ts` and `eval-paths.ts`. It reads the identifiers each expression already carries (`refs`, stamped at compile time by `templating/nodejs/src/cel/compile.ts`), so the graph costs no re-parse in the common path, and **parses** anything that arrives uncompiled rather than scanning it for tokens: an edge is the root of a member-access chain, so `inputs.total` depends on `inputs` and not on a sibling binding that happens to be called `total`. A lexical scan would invent that cycle and reject a correct manifest.

**The runtime does not re-derive it, because laziness makes the order structural.** A binding evaluated on first read reaches its dependencies by construction, so there is no order for the two halves to disagree about — the shared-module rule that governs `evalPathCovers` does not apply here. What the kernel does own is the guard the derivation cannot enforce at runtime: a binding that re-enters while it is resolving raises `ERR_BINDING_CYCLE`, backing the static `BINDING_CYCLE` diagnostic for a manifest that reached the runtime unchecked. Nothing is stamped onto the manifest.

Scope wiring uses a new generic annotation, **`x-telo-bindings-from: "<field>"`**, on the `x-telo-context` node of every field where the names are in scope — the same family as `x-telo-context-from` and `x-telo-context-element-from`, so no kind is named in analyzer code and a third-party kind opts in by annotating. At runtime the kernel exposes a scope-extension entry point on the controller context (`ctx.bindScope`) returning the extended scope a controller passes to `expandValue`; `modules/run/nodejs/src/value.ts` and `choice.ts` change by about a line each. New diagnostics: `BINDING_CYCLE`, `BINDING_NAME_RESERVED`; an unknown identifier is already covered by the existing CEL rule.

Ships with: `modules/run/tests/bindings.yaml` and `pure-step.yaml`, analyzer unit tests for the DAG/cycle/reserved/typing paths, an `Added` changie fragment for `run`, changesets for `@telorun/analyzer` / `@telorun/kernel` / `@telorun/sdk`, `modules/run/docs/bindings.md`, the pure step documented in the module README beside the other step forms, updates to `value.md` (its "when NOT to use" list is largely stale), a rewrite of the business-logic passage in `docs/guides/coming-from.md`, and the mandatory `apps/authoring-agent/chat/telo.yaml` primer sync.

## Decisions

- **Map, not array** — order derived from the reference DAG rather than declared, matching the repo's array-is-ordered / map-is-not convention and the "ordering is derived, not declared" principle the init loop already applies to resources. Rejected an array of `{name, value}`: it makes order load-bearing where declaration order carries no information a reader needs, and needs its own uniqueness diagnostic.
- **Lazy, memoised evaluation** — a binding must mean exactly what inlining its expression would mean. Rejected eager topological evaluation: it runs a binding only one `Run.Choice` row needs on every invoke, forces every partial expression (division, index, parse) to be made total, and makes a `previous`-derived value carry the null-guard its use site already has — reintroducing the duplication the feature removes. "Failure timing depends on which branch wins" is the existing semantics of inline CEL, so it is not a regression; the order stays derived and cycle-checked statically, and nothing observable depends on it.
- **Bare names, with the reserved set read from the CEL environment and a precedence rule** — `gross - discount` is the readability being bought. Rejected a `bindings.` / `let.` prefix: it makes the collision class unrepresentable, but costs exactly what the feature exists for. Rejected deriving the set by walking the variable-introducing annotations: it misses the ambient root variables, which are registered directly on the environment, so a binding named `resources` would pass the check and then be silently shadowed. The precedence guarantee (scope variables win) buys the prefix's containment, and the diagnostic makes the collision visible instead of silent.
- **Bindings only on the expression-scope kinds; step kinds get the pure step** — rejected a `bindings:` header on `Run.Sequence`/`Loop`/`Iteration`/`Projection`: evaluated before any step, it cannot see `steps.*`, so it would miss the sequence case entirely while adding a third timing. Rejected a second post-step bindings region: more machinery, more timings, and a pure step already reuses `steps.<name>.result` typing, ordering and rendering wholesale.
- **Names stop at nested inline `{ kind }` boundaries** — the same rule the eval-path check follows, so one boundary is explained once.
- **Derivation in the analyzer, re-imported by the kernel** — rejected the SDK (the versioned author contract, no runtime deps, no CEL) and rejected a shared TS library inlined into module bundles (that pattern is for contracts third parties *compile* against; bindings change CEL scope semantics, and a future Rust controller would have to reimplement them).
- **No stamped metadata, and no shared order at runtime** — lazy evaluation reaches each dependency by construction, so the derived order is a static artifact (diagnostics, typing, what the editor shows) rather than something the kernel replays. That removes both a `metadata.bindingOrder` and the question of who owns stamping it; the runtime keeps only the re-entrancy guard.
- **Explicit `ctx.bindScope`, not automatic kernel application** — `expandValue` receives an arbitrary value with no schema path, so the kernel cannot tell that a bindings region applies. Making it automatic means a new pre-binding pass over every kind's schema to save one line per controller.
- **No per-binding type declaration** — a `{ value, type }` object per entry would destroy the clean map form. Types are inferred where the expression is a chain into a typed scope and fall back to permissive otherwise.
- **`Added` (minor)** — an additive optional field and an additive step variant; no existing manifest changes meaning.

## Example after the change

```yaml
kind: Run.Value
metadata: { name: PriceLine }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [qty, unitPrice, discountRate, taxRate]
    properties:
      qty: { type: number }
      unitPrice: { type: number }
      discountRate: { type: number }
      taxRate: { type: number }
bindings:
  net: !cel "gross - discount" # declared before what it depends on — order is derived
  gross: !cel "inputs.qty * inputs.unitPrice"
  discount: !cel "gross * inputs.discountRate"
value:
  net: !cel "net"
  tax: !cel "net * inputs.taxRate"
  total: !cel "net + net * inputs.taxRate"
---
# One subexpression, shared by every row, computed at most once — and never at
# all when no row that needs it is reached.
kind: Run.Choice
metadata: { name: ShippingTier }
bindings:
  weight: !cel "sum(inputs.items.map(i, i.grams)) / 1000.0"
choices:
  - when: !cel "weight > 30.0"
    value: { tier: freight }
  - when: !cel "weight > 2.0"
    value: { tier: parcel }
default:
  value: { tier: letter }
---
# A step-derived intermediate with no dispatch: `total` is a pure step, so it
# costs no resource, no span and no topology node.
kind: Run.Sequence
metadata: { name: Checkout }
steps:
  - name: cart
    invoke: !ref LoadCart
    inputs: { id: !cel "inputs.cartId" }
  - name: total
    value: !cel "sum(steps.cart.result.lines.map(l, l.price * double(l.qty)))"
  - name: charge
    invoke: !ref ChargeCard
    inputs:
      amount: !cel "steps.total.result"
      customer: !cel "steps.cart.result.customerId"
```
