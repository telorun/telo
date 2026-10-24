---
sidebar_label: Step Bodies
slug: /extend/step-bodies
description: "Give a kind of your own a body of steps — a transaction, a batch, a durable run — by pointing an array at the shared step grammar, so it gets invoke / if / while / switch / try and steps.<name>.result for free."
---

# Giving a kind a step body

A kind that wraps a region of work — a transaction, a durable run, a batch — can
carry the work **inside itself** rather than taking a reference to something else
that holds it. Point a step array at the shared grammar:

```yaml
kind: Telo.Definition
metadata:
  name: Transaction
capability: Telo.Invocable
# Selects the step canvas in the visual editor. Without it the kind renders as a
# plain form — the body is still valid, but nobody can see its shape.
topology: Sequence
schema:
  type: object
  required: [steps]
  properties:
    steps:
      title: Steps
      description: Work executed inside the transaction.
      x-telo-topology-role: steps
      type: array
      items:
        $ref: "telo://manifest#/$defs/Step"
```

That is the whole declaration. The grammar — `invoke` / `value` / `if` /
`while` / `switch` / `try` / `throw` / `rethrow`, the `steps.<name>.result` accumulator, the
`error` variable inside a `catch:` — comes with the reference, and so does every
analysis built on it: typed step results, throws coverage, the call graph, the
editor's step rendering.

## What you get, and what stays yours

The **array slot** is yours: its title and description, its
`x-telo-topology-role: steps` marker (which field on the canvas holds the body),
and any sibling annotation that types the CEL scope your kind offers a step
(`x-telo-context`). So a kind that binds `item` and `index` declares those
itself, exactly as `Run.Iteration` does. `topology: Sequence` on the definition
doc is what selects the step canvas at all; the role marker only tells it where
to look.

The **step** is not yours. A slot pointing at the fragment cannot narrow it:
draft-07 makes `$ref` exclusive, so a sibling restating a subset of the branches
reaches completion and hover but never the validator. One grammar for every body
is the point — a step body means the same thing in a sequence, a transaction and
a workflow.

**A predicate is a boolean.** A step's `when`, `if`, `elseif[].if` and `while`
must evaluate to `true` or `false`: `telo check` reports an expression typed as
anything else (`CEL_TYPE_ERROR` at the predicate), and the engine refuses a
result that is not a boolean with `ERR_PREDICATE_NOT_BOOLEAN`, naming where the
predicate is written and what it produced. Nothing is read by truthiness — a
string `"false"` is not false — so compare explicitly
(`!cel "variables.flag == 'true'"`).

**A number written in a `value:` step is the number CEL would write.** A pure
step whose `value:` is a literal publishes a number that is integral and within
int64 as an `int` and any other number as a `double`, as the whole value and at any depth of a literal map
or list — so `value: 3` then `!cel "steps.count.result * 2"` composes, as
`!cel "3"` always did. The rule reads the value, not its spelling: `3`, `3.0`
and `1e3` are ints, `3.5` is a double, and a double 3 is written `!cel "3.0"`.
`telo check` types `steps.<name>.result` the same way — a literal map is a closed
record, so a misspelled member is `CEL_UNKNOWN_FIELD`, a list is typed by its
elements when they all agree, and `steps.count.result * 2.0` over a literal `3`
is `CEL_TYPE_ERROR`. A `!cel` or `!interpolate` member of a literal map or list
is left as it evaluates and stays untyped; a step whose whole `value:` is one
`!cel` is typed by what the expression checks to.

**A step name is one type only when every step carrying it agrees.** Two steps
may share a name — one per branch of an `if`, or a loop's seed and the step
advancing it — and `steps.<name>.result` is typed only where all of them produce
the same type; where they differ the name is untyped and a mismatch surfaces at
run. An expression step reads its own name as what the other steps of that name
produce, so a counter seeded with `value: 0` is advanced with
`!cel "steps.i.result + 1"`; `+ 1.0` is `CEL_TYPE_ERROR`, since the seed is an
int.

## Running it

Execution lives in `@telorun/sdk` beside the grammar, so a controller runs a body
without depending on `modules/run`:

```ts
import { StepEngine, type Step } from "@telorun/sdk";

const engine = new StepEngine(ctx, {
  kind: "Transaction",
  resourceName: String(resource.metadata.name),
});
engine.resolveInvokes(manifest.steps);          // once, at init
// …
const steps: Record<string, unknown> = {};
await engine.executeSteps(manifest.steps, steps, undefined, { inputs }, invokeCtx);
```

A loaded manifest reaches your controller with every inline step target already
extracted and named, so `resolveInvokes` leaves each resolved reference — a
`{ __ref: true, kind, name }` — alone. A step built in code names its target
with `kindRef(kind, name)` from `@telorun/sdk`; a plain `{ kind, name }` there
is an inline declaration of `kind`.
Keep the call in `init()` all the same: it is what names the inline targets of a
body assembled at runtime (a template body's children, steps built in code). The
name is `inlineStepTargetName(owner, stepPath, stepName)` from `@telorun/sdk`,
the one rule the load pass and the engine share. `owner.kind` must be exactly
your kind's `metadata.name` and `owner.resourceName` the resource's
`metadata.name` — the load pass derives both from the manifest, so any other
string gives a loaded body's targets different names. The name is durable
identity: it is what a trace span and an `ERR_RESOURCE_NOT_FOUND` print, and what
a durable journal records a step's target by.
`executeSteps` takes the accumulator it fills (`steps.<name>.result`), an
optional `ScopeContext`, the extra CEL variables your kind binds, and the
`InvokeContext` you were invoked with — forwarding the last one is what makes a
retry backoff inside the body interruptible. `telo check` puts `inputs` in scope
only for an Invocable or Runnable composer.

## One slot, not two

A kind with a native `steps:` has not given up the arbitrary-executable case: a
one-step body is exactly that.

```yaml
steps:
  - name: work
    invoke: !ref someSequence
```

So a kind declares `steps:` **or** an executable `!ref`, never both — two
spellings of one thing means every annotation that qualifies the body (a
zone provision, a retry budget) has to be written twice and kept agreeing.

## Publishing one

The grammar is a shared fragment, which is manifest syntax an older runtime does
not know. A module that declares a step body this way must say so:

```yaml
requires:
  telo: ">=0.79.0"
```

That is what stops `telo upgrade` from moving a consumer onto a version of your
module their runtime cannot read, and what `telo check` reports when someone
runs it against your module directly. Note the gap: a range on an *imported*
library is not yet enforced at load time — the flattened analysis drops the
library doc — so a consumer who hand-pins an unreadable version still meets the
unresolvable `$ref` rather than the version message. See
[Declaring runtime requirements](./declaring-runtime-requirements.md).
