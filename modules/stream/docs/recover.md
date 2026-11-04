---
description: "Stream.Recover: end a stream that fails part-way with a final value computed from the failure, instead of the failure"
sidebar_label: Stream.Recover
---

# Stream.Recover

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Passes every value of a stream through **unchanged and in order**. When the source fails
part-way, it logs the failure and ends the stream with one last value computed from the
error, instead of the failure. The stage for a stream already handed to a transport — an
HTTP response, a socket — where a failure can no longer change the status, so the
reader's only way to learn of it is a record it can read.

```yaml
- name: frames
  invoke:
    kind: Stream.Map
    elementType: !ref Sse.Frame
    value: { event: !cel "item.type", data: !cel "item" }
  inputs: { input: !cel "steps.events.result.output" }
- name: ended
  invoke:
    kind: Stream.Recover
    elementType: !ref Sse.Frame
    value: { event: error, data: { code: !cel "error.code", detail: !cel "error.message" } }
  inputs: { input: !cel "steps.frames.result.output" }
```

## Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `value` | CEL, or a structure with `!cel` leaves | The last value, evaluated once when the source fails. **Required.** |
| `elementType` | reference | The contract `value` satisfies — usually the one the stage before declares. `telo check` holds `value` to it, so a misspelt member is an error before the app runs. |
| `when` | CEL → boolean | Whether to recover this failure. `false` rethrows it. Omitted, every failure is recovered. |

## Inputs / Output

`input` is the stream to guard; `output` is every value of it, then `value` when it fails.

## What the expressions see

`error` — the failure, in the shape a step's `catch:` branch reads it:

| Member | |
| --- | --- |
| `code` | The failure's code; `INTERNAL_ERROR` for a failure that carries none. |
| `message` | The developer's message. |
| `data` | The failure's structured data; `null` when it carries none. |
| `displayMessage` | The text a person is shown, as its record; `null` when it carries none. |

## What is never recovered

A **cancellation** (`ERR_INVOKE_CANCELLED`) and a **suspension** (`ERR_DURABLE_SUSPENDED`)
are always rethrown, whatever `when` says: one belongs to whoever cancelled, the other to
the workflow that owns the run, as with every catcher in Telo.

## Logging

A recovered failure is logged at `error`, with the error. It is absorbed here, so the log
is the only server-side report of it; a failure `when` declines is not logged here.

## Stopping early

A consumer that stops reading, or releases the stream unread after it has started, stops
the source, exactly as with `Stream.Map`.

## Errors

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | `input` is not a stream. Raised by the call. |
| `ERR_INVALID_VALUE` | `when` evaluated to something other than a boolean. Raised as the source fails, instead of the failure. |
