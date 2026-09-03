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
`while` / `switch` / `try` / `throw`, the `steps.<name>.result` accumulator, the
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

`resolveInvokes` turns an inline `invoke: { kind: … }` into a named resource in
your module's scope, so it must run while the resource is being created. The
`{ kind, resourceName }` pair is what the generated name is built from — the
engine owns that recipe, because the name it mints is manifest-visible topology
(it is what a trace span and an `ERR_RESOURCE_NOT_FOUND` print).
`executeSteps` takes the accumulator it fills (`steps.<name>.result`), an
optional `ScopeContext`, the extra CEL variables your kind binds, and the
`InvokeContext` you were invoked with — forwarding the last one is what makes a
retry backoff inside the body interruptible.

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
