# Idempotency

`Idempotency.Once` — run a body **at most once** per key, across retries and process restarts.

## Why use this

- **No double-execution window** — the "has this already run?" check and the claim are one atomic store operation. A replay-only cache followed by a separate lock reopens exactly the gap this closes.
- **Results replay** — a repeat call returns the stored result instead of re-running the body, so a client retry is safe rather than expensive.
- **Failures stay retryable** — a body that throws releases the key. A transient failure is never frozen as a permanent completion.
- **A dead holder frees the key** — the claim is time-bounded, so a process that dies mid-body cannot wedge the operation forever.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Idempotency.Once` | Wraps a body and runs it at most once per key against a `KvStore.Store`. |

## Example

```yaml
kind: KvStoreSql.Store
metadata: { name: store }
connection: !ref db
---
kind: Idempotency.Once
metadata: { name: chargeOnce }
store: !ref store
claimTtl: "2m"     # how long one caller may hold the key while running
ttl: "24h"         # how long a completed result is remembered
invoke: !ref chargePayment
```

Called from a step, with a **deterministic** key so a retry targets the same logical operation:

```yaml
- name: charge
  invoke: !ref chargeOnce
  inputs:
    key: !cel "'charge:' + inputs.orderId"
    inputs:
      amount: !cel "inputs.amount"
```

## Fields

| Field | Purpose |
| --- | --- |
| `store` | The `KvStore.Store` holding claims and settled results. |
| `claimTtl` | How long one caller may hold the key while its body runs. Renewed on a heartbeat while in flight, so this bounds a **dead** holder, not a slow one. |
| `ttl` | How long a completed result is remembered and replayed. |
| `invoke` | The body run at most once per key. |

## Result

```yaml
{ executed, state, result?, holder? }
```

| `state` | Meaning |
| --- | --- |
| `fresh` | This call claimed the key and ran the body. `result` is what it returned. |
| `replayed` | The key was already settled. `result` is the stored value; the body did not run. |
| `in-flight` | Another caller holds the key right now. The body did not run and there is no result yet. |

Branch on `state`, not on `executed` alone — `replayed` and `in-flight` both report `executed: false` but mean opposite things: one has an answer, the other has none yet.

```yaml
- name: charge
  invoke: !ref chargeOnce
  inputs: { key: !cel "inputs.requestId" }
- name: respond
  invoke: !ref reply
  inputs:
    status: !cel "steps.charge.result.state == 'in-flight' ? 409 : 200"
```

## Errors

| Code | Cause |
| --- | --- |
| `ERR_INVALID_KEY` | `key` was absent or empty. It identifies the operation, so a blank key would merge unrelated calls onto one record. |
| `ERR_CLAIM_LOST` | The body **ran**, but its claim had lapsed, so the result could not be recorded — a later call may run it again. Raise `claimTtl`. |

`ERR_CLAIM_LOST` is worth understanding, because it is the one case where the
at-most-once guarantee is already broken by the time you hear about it. The claim
is never released once the body has run: if recording the outcome fails, the
claim simply lapses on `claimTtl`, so no retry can re-run the body inside that
window. Releasing it there — or reporting `fresh` as though the record were
durable — would be the double execution this kind exists to prevent.

## Choosing the two durations

`claimTtl` should sit comfortably above the body's worst-case duration. Too short and a genuinely slow body can have its key taken over and the work done twice; there is no value that is safe if the body can outrun every heartbeat, so size it against the real upper bound.

Every outcome is logged: a replay and an in-flight collision at `info`, a fresh run and the retryable release after a failed body at `debug`, and a lost claim at `error`. Both suppressed paths return successfully, so without the record nothing marks that the body did not run. `ERR_CLAIM_LOST` is logged as well as thrown — the at-most-once guarantee breaking must stay visible regardless of what the caller does with the error.

> **`idempotency.key` is on those records, including the `info` ones**, and an idempotency key is supplied by the caller — often a request id, sometimes a user or tenant id. Redact it at the root if that is not acceptable:
>
> ```yaml
> logging:
>   redact:
>     paths: ["idempotency.key"]
> ```

A heartbeat that fails to renew is logged at `warn` with the key. It is not fatal on its own — a later beat may succeed — but it is a store *write* failing, which is an infrastructure fault, and it is the leading indicator of an `ERR_CLAIM_LOST`. It is `warn` rather than `debug` precisely because a level you have to raise in advance is no use here: by the time anyone is diagnosing the lost claim, the store failure that caused it is long over.

`ttl` should cover the window in which a caller could retry — a client's retry budget, a webhook sender's redelivery schedule. Once it lapses the key is new again and the operation may legitimately run once more.

## At most once, not exactly once

This kind guarantees the body runs **at most** once per key. Exactly-once against an external system additionally requires that the key be deterministic (so a retry names the same operation) and that the remote side reconcile — a payment provider's own idempotency key, an upstream dedupe window. `Idempotency.Once` is what makes the client half of that possible: a stable key, durably recorded.

## Relationship to `Lease.Critical`

Both take a keyed claim from the same store, and they are not the same thing:

| | `Lease.Critical` | `Idempotency.Once` |
| --- | --- | --- |
| Question | "Is anyone else doing this **right now**?" | "Has this **ever** been done?" |
| After success | Releases — the next caller runs again | Settles — the next caller replays |
| Use for | Cron-overlap prevention, singleflight, migrations | Payments, outbound webhooks, mail |

Use a lease to stop concurrent work. Use idempotency to stop repeated work.
