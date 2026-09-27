---
description: "Stream.Concat: join several producers' streams into one, in order, invoking each producer only when the previous stream has ended"
sidebar_label: Stream.Concat
---

# Stream.Concat

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Reads the `output` streams of several producers as **one stream, source after source**.
Every source is invoked **lazily**: nothing runs when the Concat is called, the first
source is invoked on the first pull, and each next one only once the stream before it
has ended. So work a later source does — a model call, a query, a file read — starts
only after everything before it was delivered, and never when a reader stops early.

```yaml
- name: turn
  invoke:
    kind: Stream.Concat
    sources:
      - invoke: { kind: Stream.Of }
        inputs:
          items: !cel "[{'type': 'user-message', 'content': context.message}]"
      - invoke: !ref agent            # returns { output: <stream> }
        inputs:
          prompt: !cel "context.message"
  inputs:
    context: { message: !cel "inputs.message" }
```

## Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `sources` | list, at least one | The producers, in the order their streams are joined. **Required.** |
| `sources[].invoke` | reference | Any invocable or runnable — a `!ref` or an inline declaration — that returns `{ output: <stream> }`. `telo check` verifies that shape against what the source declares it returns — its own `outputType`, its kind's, or the keys of a `Run.Sequence`'s `outputs:` — and reports `REFERENCE_OUTPUT_MISMATCH` at the slot when it cannot be. **Required.** |
| `sources[].inputs` | map, CEL leaves | The source's arguments, evaluated when it is invoked. `telo check` holds them to that source's own `inputType`, so a misspelled argument is an error before it runs. Omitted, the source is called with no arguments. |

## Inputs / Output

| Input | Purpose |
| --- | --- |
| `context` | Caller data every `inputs:` map reads as `context`. `{}` when omitted. |

`output` is every value of each source's `output` stream, in source order.

## What the expressions see

`context` — the caller's `context` input. Nothing else of the Concat's call is bound:
its only other value is the stream it returns.

## Invocation context

Every source is invoked under the **Concat's own invocation context**, captured when the
Concat is called — its cancellation, its trace, its zones — never whatever context the
reader happens to drain in. A source is therefore cancelled with the Concat's call, and
its trace nests under it.

## Endings

| What happens | The output |
| --- | --- |
| Every source's stream ends | ends |
| A source's invocation fails, or its stream raises | raises that error, with its original code; no later source is invoked |
| A source returns no `output` stream | raises `ERR_INVALID_VALUE`; no later source is invoked. Reached only by a source that declares no output contract — one whose declared output cannot hold `output` is refused by `telo check` |
| The consumer stops reading | ends; the current source's stream is stopped and no later source is invoked |
| The Concat's invocation is cancelled | raises `ERR_INVOKE_CANCELLED`; the current source's stream is stopped — even mid-pull — and no later source is invoked |

Every one of these is raised by the returned **stream** as it is drained, never by the
call itself. The `sources[].invoke` slot is a `trigger.consumer` reference for that
reason — control reaches a source when someone drains the stream the Concat returned.
The kind declares `throws: { inherit: true }` with `ERR_INVALID_VALUE`, as `Stream.Tap`
does, so **every source's codes count in the Concat's throw union**: a route that renders
the Concat's stream can name a source's code in its `catches:`, and `telo check` holds
that list against what the sources declare. Cancellation is not declared.

A source whose stream is stopped while a pull is still in flight is told to stop at
once; the outcome of that pull is logged rather than awaited, since the source may be
paused indefinitely.
