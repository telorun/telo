---
description: "Stream.Tap: observe every value of a stream as it passes — hand each one to a handler before delivering it, unchanged and in order, holding nothing"
sidebar_label: Stream.Tap
---

# Stream.Tap

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Passes every value of a stream through **unchanged and in order**, and hands each one to a
handler just before delivering it. The stage for a stream that has to be *watched* —
printed, logged, counted, recorded — while a later stage still consumes the same values.

```yaml
- name: printed
  invoke:
    kind: Stream.Tap
    invoke: { kind: Console.Write }
    when: !cel "item.type == 'stdout'"
    inputs:
      output: !cel "item.chunk"
  inputs:
    input: !cel "steps.command.result.output"
```

## Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `invoke` | reference | The handler each value is handed to — any invocable or runnable, a `!ref` or an inline declaration. **Required.** |
| `inputs` | map, CEL leaves | The handler's arguments, evaluated once per dispatched value. `telo check` holds them to the handler's own `inputType`, so a misspelled argument is an error before it runs. Omitted, the handler is called with no arguments. |
| `when` | CEL → boolean | Whether to dispatch for this value. `false` skips the dispatch and never the delivery. Omitted, every value is dispatched. |

A run-only handler — one with `run()` and no `invoke()` — is started exactly as a step's
`invoke:` starts it: with `run()`, which takes no arguments, so `inputs:` does not reach it.

## Inputs / Output

`input` is the stream to observe; `output` is every value of it, unchanged and in order.

## What the expressions see

`item` (the current value) and `index` (its zero-based position — an integer, counting
every value whether or not it was dispatched). The handler's arguments are what you
write under the `inputs:` field, each expression there reading `item` and `index` to
build them.

## Dispatch before delivery

For each value the tap evaluates `when`, dispatches the handler and **waits for it**, and
only then delivers the value. Two things follow:

- **What the handler observed is exactly what the consumer received**, even when the
  consumer stops early — no value is dispatched that was not delivered, or delivered
  that was not dispatched (a closed `when` aside).
- **Nothing is held.** Two taps in series interleave: value 0 crosses both before value
  1 is pulled.

## Failure

A handler that fails **rejects the drain** of the tap's output with the handler's own
error, unwrapped — its code is what a `try:` / `catch` or a route's `catches:` sees. The
value whose handler failed is **not delivered**, and nothing after it is dispatched.

The tap declares `throws: { inherit: true }`, so `telo check` counts the handler's codes
in the tap's own throw union: a route whose handler taps and drains must render them, and
one that does not is reported as `UNCOVERED_THROW_CODE`.

A failure *below* the tap stops it too: the value the later stage refused had already been
dispatched, and nothing after it is.

The tap's own refusals:

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | `input` is not a stream. Raised when the tap is invoked, before anything is pulled. A value written literally at `input:` never gets that far: no literal can be a stream, so `telo check` refuses it. |
| `ERR_INVALID_VALUE` | `when` evaluated to something other than a boolean, naming the value's position. A literal or an expression statically known not to be boolean is a `telo check` error instead. |

## Lazy, and abandonable

Nothing is pulled when the tap is invoked; each value is dispatched as the consumer pulls
it. A consumer that stops draining causes `for await` to call `return()` on this stage,
which propagates to its source and on to the transport — and no further value is
dispatched.

## The context the handler runs under

The **tap's own invocation**. The context the tap was invoked with — its cancellation and
its trace — is captured when the stream is produced and passed to every dispatch. It is
never the context of whoever happens to drain the stream: a stream produced by one call
and drained by, say, an HTTP response writer still dispatches its handler as part of the
call that produced it.

## The handler's result is discarded

Whatever the handler returns is dropped — including a stream, which is never drained. A
tap observes; to reshape the values, use [`Stream.Map`](./map.md).

## `Stream.Tap` or `RecordStream.Tee`

`RecordStream.Tee` splits one stream into two outputs. When a sequence consumes both, the
step draining the first runs to completion before the next step starts, so everything the
second output will see is **buffered in memory for the whole stream**.

A tap has one output and does its observing inline, so it holds nothing. Prefer it when
one of the two consumers is a per-value side effect — printing, logging, counting. Keep
`Tee` for two genuinely independent consumers of the same values.

## Printing a command live and branching on its exit code

The composition the tap exists for. `Shell.CommandStream` emits `{type: stdout|stderr,
chunk}` records and then a terminal `{type: exit, exitCode, signal}`. The tap prints each
chunk as it arrives; `Stream.FlatMap` keeps only the exit record; the sequence branches on
its code — one stream, with no stage holding the output.

```yaml
kind: Run.Sequence
metadata: { name: build }
steps:
  - name: command
    inputs:
      command: "make build"
    invoke:
      kind: Shell.CommandStream
      host: { kind: Shell.LocalHost }
  - name: printed
    inputs:
      input: !cel "steps.command.result.output"
    invoke:
      kind: Stream.Tap
      invoke: { kind: Console.Write }
      when: !cel "item.type == 'stdout' || item.type == 'stderr'"
      inputs:
        output: !cel "item.chunk"
  - name: exitOnly
    inputs:
      input: !cel "steps.printed.result.output"
    invoke:
      kind: Stream.FlatMap
      values: !cel "item.type == 'exit' ? [item] : []"
  - name: exit
    inputs:
      input: !cel "steps.exitOnly.result.output"
    invoke: { kind: Stream.Collect }
  - name: onExit
    if: !cel "steps.exit.result.items[0].exitCode != 0"
    then:
      - name: failed
        throw:
          code: BUILD_FAILED
          message: !cel "'make exited ' + string(steps.exit.result.items[0].exitCode)"
```

`Console.Write` prints each chunk exactly as given, with no newline added, so the
command's own line breaks come through. `Collect` is what drains the pipeline — and so
what drives the printing — and it holds only the one exit record.
