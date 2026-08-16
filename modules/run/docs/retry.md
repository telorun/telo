---
description: "Re-attempting a step that failed: what retry retries, what it refuses to, and what must not be passed to it"
sidebar_label: Step retry
---

# Retrying a step

Any dispatch site can carry a `retry:` policy — a step in `Run.Sequence`, `Run.Iteration`, `Run.Loop` or `Run.Projection`, **and an entry in an Application's `targets:`**. They are one kernel-owned shape (`telo://manifest#/$defs/InvokeStep`), so `{ invoke, inputs, when, retry }` means the same thing wherever a target is named:

```yaml
steps:
  - name: Charge
    invoke: !ref PaymentApi
    inputs:
      amount: !cel "inputs.amount"
    retry:
      attempts: 3          # re-attempts AFTER the first try, so up to 4 calls
      initialDelay: 250    # ms before the first re-attempt
      factor: 2            # 250 → 500 → 1000 …
      maxDelay: 32000      # ceiling per wait
      jitter: full         # each wait picked uniformly from [0, delay]
```

Every field above is its default, so `retry: { attempts: 3 }` is the whole policy in the common case. The field names are `Http.Request`'s, deliberately: two spellings of backoff in one standard library would make the word change meaning depending on where it is written.

`jitter: full` is the default because retries that failed together should not re-attempt together — a fleet that lost a dependency at the same instant otherwise rebuilds the same thundering herd on every wait. Set `jitter: none` when a test needs a deterministic schedule.

## What gets retried

**A domain failure, and nothing else.** There is no status to classify at this level, so the rule cannot be a positive list — what there is instead is an explicit instruction, since a step carries `retry:` only because someone wrote it. Two things are excluded, and neither needs a judgement call:

- **Cancellation.** The invocation has been asked to stop; re-issuing it ignores that.
- **A contract violation** — `ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`, `ERR_CONTRACT_UNRESOLVABLE`. These are the kernel's verdict on the *shape of the call*, not on the work. They are a property of the manifest, so every re-attempt fails identically; retrying one only puts `attempts × maxDelay` of sleeping between a typo and the message naming it.

Everything else is retried, including an error a `catch:` would have matched. `retry:` runs first — it is per-dispatch, and `try`/`catch` sees only what survives the budget.

## A live value cannot be retried

A stream is consumed by reading, so it exists exactly once. Passing one into a dispatch that may repeat means every re-attempt sends nothing — the first attempt drained it:

```yaml
  - name: Upload
    invoke: !ref Storage
    inputs:
      body: !cel "steps.Encode.result.output"   # a byte stream
    retry: { attempts: 3 }                      # ← LIVE_VALUE_RETRIED
```

The analyzer reports this as `LIVE_VALUE_RETRIED` before anything runs, on the step's own policy and on the invoked target's alike — it knows the field is a re-attempt because of the shape it was declared with, not because the kind remembered to flag it. Two ways out, depending on the size of the payload:

- **Collect it first**, when it fits in memory — `Stream.Collect` turns it into a list a re-attempt can replay.
- **Chunk the work**, when it does not — `Stream.Chunk` gives each piece its own offset, so each dispatch carries a replayable unit and the retry applies per chunk.

## Retries compose multiplicatively

A step's `retry:` wraps the whole dispatch, and a target that re-attempts internally does so inside it. They multiply:

```yaml
  - name: Charge
    invoke: !ref PaymentApi     # Http.Request with retry: { attempts: 3 }
    retry: { attempts: 3 }      # → up to 4 × 4 = 16 requests
```

Nothing warns about this. Pick one level: the target's when the failure is a transport detail it can classify (`retryOn` tells a 429 from a 500), the step's when it is not.

## What the check does not cover

`LIVE_VALUE_RETRIED` fires for a plain chain rooted at `steps.` or `inputs.` — a step result, or a value the enclosing kind declared and forwarded. Three live-bearing roots are **not** checked: an iteration's `item`, a route handler's `request.body`, and a named `bindings:` entry. A live value reaching a retried dispatch by one of those routes is a runtime failure, not a `telo check` one. The narrowing is deliberate — a root whose schema the analyzer cannot resolve would have to be guessed at, and a wrong guess compares the wrong shape — but it means the diagnostic is a floor, not a proof.

## Cancellation

The wait is interruptible. A cancelled run — Ctrl-C on a boot target, a client disconnecting from the route a handler is serving, a deadline expiring — stops during the backoff rather than sitting it out, and fails with `ERR_INVOKE_CANCELLED`.

Every other point in a sequence was already a cancellation point, because the kernel refuses a dispatch reached after the tree was cancelled. A backoff is time spent inside the step leaf, where that gate cannot see it, so the invocation is forwarded there explicitly.

The failure that caused the wait is carried on the cancellation as `data.pendingFailure`, so cancelling mid-backoff does not lose the error you were retrying:

```
Step "Charge": cancelled while waiting to re-attempt (interrupted).
  pendingFailure: { code: ERR_UPSTREAM, message: "upstream said 503" }
```

## Limits

`delay:` is a deprecated duration-string spelling of `initialDelay` (`"250ms"`, `"1s"`), read only when `initialDelay` is absent. It is kept because published manifests carry it; a malformed value fails `telo check` rather than silently becoming a different backoff.
