# `Collection.Fold` — accumulation over a collection

## Problem

The `collection` module covers reshaping (`GroupBy`, `Sort`, `Distinct`, `Chunk`, `Join`) and whole-set reduction with a fixed aggregator vocabulary (`Summarize`: `sum`/`avg`/`min`/`max`/`size`). What none of them express is **accumulation with author-defined state**: a running balance, a greedy allocation across invoices, dedupe that remembers what it has seen, a state machine folded over an event list. `Run.Projection` maps but cannot carry state between elements; `Run.Loop` can, but it is a dispatch engine — its body invokes resources, so a pure calculation pays a resource, a span and a topology node per step.

This is the one algebraic shape missing from the pure-data-transform set, and it is the shape most real business rules take — so today they become a `JS.Script`.

## Solution

Add **`Collection.Fold`** to `modules/collection/telo.yaml`: a `Telo.Invocable`, pure CEL, no dispatch — a list in, one value out. It sits beside `Summarize`, whose fixed aggregators are the special case of what `Fold` generalises, and inside the module whose contract is already "pure data transforms — a list in, a list out, no I/O and no control flow".

Fields:

- **`collection`** — CEL resolving to the array folded over. Sees `inputs`.
- **`initial`** — the starting accumulator. Sees `inputs`.
- **`accumulate`** — the accumulator's next value, evaluated once per element. Sees `acc`, `item`, `index`, `items`, `inputs`.
- **`while`** — optional early exit, evaluated **before** each element; the fold stops when it is false. Same scope as `accumulate`.
- **`value`** — the result, projected from the finished accumulator. Sees `acc`, `items`, `inputs`; write `!cel "acc"` when the accumulator already is the result.
- **`accType`** — optional accumulator contract (`x-telo-ref: Telo.Type`), typing the intermediate state.
- **`outputType`** — optional per-instance result contract (`x-telo-ref: Telo.Type`), exactly as on `Run.Value` / `Run.Projection`.

`initial`, `accumulate` and `value` are **unconstrained value slots**, the same shape as `Run.Value`'s `value` and a `Run.Choice` row's: a pure `!cel` expression, or a YAML structure with `!cel` leaves, or a literal. That is what keeps scalar folds — a running total, a max-so-far, a joined string, the `Summarize` generalisation this kind promises — expressible alongside the object form, with replace-not-merge semantics falling out unambiguously and no `anyOf` for the editor to render.

Two independent contracts, each with its own static check, both optional:

- **`accType` types the intermediate state.** `acc` is typed from it inside `while`, `accumulate` and `value`, and **both `initial` and `accumulate`** carry `x-telo-value-schema-from: accType` — the seed is the first accumulator, so checking only the step would leave a seed missing a required field type-checking as though the field were there, and the invariance guarantee false at element zero.
- **`outputType` types the result for callers.** `value` carries `x-telo-value-schema-from: outputType`, and because the kernel binds a per-instance contract, `steps.X.result.<field>` type-checks at every consumer. This is the pairing `Run.Value`, `Run.Sequence.outputs` and `Run.Projection.outputs` already use.

Both static checks read a **written structure** — a map with `!cel` leaves, a literal. A slot written as one whole expression is accepted wherever its contract would be, because nothing in Telo compares a CEL expression's result type against a declared type; for that shape the contract is enforced at dispatch. That is a repo-wide gap, not this kind's, and closing it (inferring a program's result type and comparing it to its slot) would also close `Run.Choice`'s `when` and every `if:` predicate.

`item` is typed automatically from `collection` through the existing `x-telo-context-element-from` annotation, exactly as in `Sort`/`Distinct`/`Join`, and `acc` from `accType` through `x-telo-context-from-root` — which gains one generic fix in the analyzer: it now resolves a `telo#Type` slot to the schema it names rather than to the `{ kind, schema }` wrapper around it, without which `acc` would expose `kind`/`schema` and a scalar accumulator could not be typed at all. Both contracts omitted, everything stays permissive and nothing false-positives; declaring one is what opts in, the same gradual stance as the rest of the module.

**Termination is structural**: iterations are bounded by `size(collection)` and `while` can only shorten the run. That is why this is a fold and not a general recursion or function kind — recursion is unbounded and unanalyzable, a fold is neither.

The result is the projection itself, **not** wrapped under a named key the way `rows` / `items` / `chunks` / `summary` are.

Controller: `modules/collection/nodejs/src/fold-controller.ts`, bundled as `pkg:telo/local/js` like its siblings, and reusing `ordering.ts`/`key-identity.ts` conventions where relevant. Ships with `modules/collection/tests/fold.yaml`, an `Added` changie fragment for `collection`, `Fold` added to `exports.kinds`, and `modules/collection/docs/fold.md` plus a mention in `operations.md`. The `apps/authoring-agent/chat/telo.yaml` primer is updated in the same change.

## Decisions

- **`collection`, not `run`** — every `run` kind exists to dispatch something; `Fold` dispatches nothing. It is a pure list-in transform, the general form of the module's own `Summarize`, and the module description already commits to reduction without I/O or control flow. Rejected `Run.Fold`: better discoverability next to `Run.Loop`, but it would be the only `run` kind that invokes no resource.
- **Result unwrapped, with a per-instance `outputType`** — every sibling wraps because its result shape is fixed; `Fold`'s is author-defined, which is exactly why it cannot. A fixed kind-level `{ value: … }` contract would buy nothing for callers: contracts replace rather than merge, so an author declaring `outputType` would have to restate the wrapper inside it, and without one every consumer reads `result.value.<field>` permissively. Rejected wrapping for sibling symmetry: it costs the caller-facing typing this kind exists to provide.
- **`initial`, `accumulate` and `value` are unconstrained value slots** — one slot carries both the scalar and the object fold, so a running total is as expressible as a record accumulator. Rejected the sibling `key`/`aggregate`/`select` map form (excludes scalar accumulators, and leaves replace-vs-merge unstated) and rejected an `anyOf` over both (an editor-rendering and static-check cost for no expressive gain).
- **`accType` and `outputType` are separate contracts** — intermediate state and caller-facing result are different shapes whenever `value:` projects, and collapsing them would force the accumulator's internals into the public contract.
- **`while` guards before the element, not after** — a fold that stops "once the balance is exhausted" must not consume the element that would overdraw it. Post-check semantics would require the accumulate expression to defend itself on every element.
- **`accType` checked statically at both ends, never per element** — `initial` and `accumulate` both carry the annotation, so the seed and the step are held to the same shape; validating the live accumulator on every element would put an AJV pass in the inner loop of a pure calculation. The kernel's ambient output validation still covers the final result against `outputType`.
- **No `catches:`** — the kind is pure and no sibling in `collection` has one; whole-operation recovery belongs at the call site, where the surrounding `Run.Sequence` already has `try`/`catch`.
- **`value` is required, not optional** — an omit-shortcut ("no `value:` means the accumulator is the result") would leave `outputType` attached to no slot at all in exactly the case an author is most likely to reach for, and a `value:` key written blank parses to null, which the schema cannot tell from a CEL node. Requiring it costs one line (`!cel "acc"`), keeps the output contract on exactly one slot, and turns the blank case into a load-time error.
- **`while` misuse is `ERR_INVALID_PREDICATE`** — the code `Run.Choice` already raises for a non-boolean predicate; one name for one mistake across the standard library.
- **No `bindings:` field in this change** — the named-binding mechanism (`modules/run/plans/pure-value-bindings.md`) is scoped to the `run` module. Because it is annotation-driven and kind-agnostic, `Fold` opts in later with a one-line schema change and no new machinery; `accumulate` is a strong candidate once it lands.
- **`Added` (minor)** — a new kind, no existing behaviour changes.

## Example after the change

```yaml
# Apply a payment across invoices oldest-first, stopping when it is exhausted.
kind: Collection.Fold
metadata: { name: AllocatePayment }
collection: !cel "inputs.invoices"
accType: # the intermediate state — checked against `initial` and `accumulate`
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: false
    required: [remaining, allocations]
    properties:
      remaining: { type: number }
      allocations: { type: array }
outputType: # the caller-facing contract — types `steps.<name>.result` downstream
  kind: Telo.JsonSchema
  schema:
    type: array
    items:
      type: object
      required: [invoice, applied]
      properties:
        invoice: { type: string }
        applied: { type: number }
initial:
  remaining: !cel "inputs.amount"
  allocations: []
while: !cel "acc.remaining > 0.0"
accumulate:
  remaining: !cel "acc.remaining - min(acc.remaining, item.due)"
  allocations: !cel "acc.allocations + [{'invoice': item.id, 'applied': min(acc.remaining, item.due)}]"
value: !cel "acc.allocations"
# result -> [ { invoice, applied }, ... ]
```
