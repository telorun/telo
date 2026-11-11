# Rendezvous

`rendezvous` — hand one value from one call to another that is waiting for it. A
call blocks under a key until another call supplies a value under the same key,
with a bounded timeout, cancellation and no polling. It fits an approval, a
webhook answered within a request's lifetime, an OAuth callback, an agent tool
whose work runs in a client, and any human-in-the-loop step.

## Kinds

- **`Rendezvous.Point`** — abstract `Telo.Provider`: the named meeting place and
  the contract a backend implements. It owns the key space, so two points never
  meet. `payloadType` (required, a serializable `Telo.JsonSchema`) is what a
  delivery carries; `hold` (greater than zero, `60s` when omitted) is how long a
  value delivered before anyone waits is kept. Contract:
  [docs/point-contract.md](docs/point-contract.md).
- **`Rendezvous.MemoryPoint`** — the point in this resource's own memory. Nothing
  is shared between processes or survives a restart.
- **`Rendezvous.Await`** — invocable. Input `key` (non-empty string); result is
  the delivered value, typed by the point's `payloadType`. Config: `point` and
  `timeout`, both required (`timeout` is read once at creation). Throws
  `ERR_RENDEZVOUS_AWAIT_TIMEOUT` when nothing arrives in time and
  `ERR_RENDEZVOUS_KEY_BUSY` when another call already waits under the key. A
  cancelled call releases its waiter, consumes nothing and rethrows the
  cancellation.
- **`Rendezvous.Deliver`** — invocable. Inputs `key` and `payload`, the payload
  must have the point's `payloadType`: `telo check` refuses a literal that does not,
  and the call refuses a computed one (`ERR_INPUT_INVALID`). Output
  `{ delivered: boolean }`: `true` when a waiting call took the value, `false`
  when it was held.

## The meeting is symmetric

Whichever side arrives first waits. A waiter is woken the moment a delivery
arrives; a delivery that arrives first is held for the point's `hold` and handed
to a waiter that opens inside the window. A second delivery to a held key
replaces the value and restarts the window; a held value nobody takes in time is
removed. Nothing is remembered after a hand-over.

## Example

```yaml
kind: Telo.Application
metadata: { name: Approvals, version: 1.0.0 }
imports: { Rendezvous: oci://ghcr.io/telorun/rendezvous@0.2.0 }
---
kind: Rendezvous.MemoryPoint
metadata: { name: decisions }
hold: 120s
payloadType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approved]
    properties: { approved: { type: boolean } }
---
kind: Rendezvous.Await
metadata: { name: awaitDecision }
point: !ref decisions
timeout: 25s
# invoked with { key: "approval-42" } → { approved: true }
---
kind: Rendezvous.Deliver
metadata: { name: decide }
point: !ref decisions
# invoked with { key: "approval-42", payload: { approved: true } } → { delivered: true }
```

The long-polling request shape over HTTP is in
[docs/waiting-for-a-delivery.md](docs/waiting-for-a-delivery.md).

## Single process

`Rendezvous.MemoryPoint` lives in one process: a wait and a delivery in different
instances never meet, and the delivery reads `delivered: false`. An application
with several instances needs a point that reaches across them; it implements the
same contract and `Await` and `Deliver` do not change.

## Durable runs

A wait lives only in the call that opened it, so `Rendezvous.Await` declares that
it cannot run inside a replayed (durable) region: `telo check` reports
`ZONE_ATTRIBUTE_VIOLATED` there. A durable run waits with `Durable.Await`.
