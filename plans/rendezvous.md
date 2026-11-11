---
status: done
priority: medium
depends-on: []
packages: [modules/rendezvous]
---

# Rendezvous

## Problem

Several kinds of work stop mid-invocation and wait for a value that another call supplies:

- an agent tool whose work runs in a client, which returns the result through a separate request;
- an approval;
- a webhook answered within a request's lifetime;
- an OAuth device or redirect callback;
- any human-in-the-loop step.

Telo has this only in durable form. `Durable.Await` requires a replayed `Durable.Run` region and parks the run, and `Local.Deliver` is its engine-specific delivery half. Work that is not durable, and should not be, has no primitive. It ends up polling a store in a loop, which adds latency to every wait, knows nothing of cancellation, and silently assumes one process.

A version signal that any number of waiters share, with no payload — long polling on a cursor — is not this problem; it is `watch` (`Watch.Wait` / `Watch.Publish`).

## Solution

A new module, **`rendezvous`** (`metadata.name: Rendezvous`), with a named meeting place, two invocable kinds that name it, and an in-memory backend.

### Usage

An approval an HTTP client waits for. One request long-polls for the decision; another delivers it. The decision may arrive before the poll starts, and the poll may time out and be re-issued.

```yaml
kind: Telo.Application
metadata:
  name: ApprovalPoll
  version: 1.0.0
  description: A client waits for a manager's decision on one request while the manager posts it on another.
requires:
  telo: ">=0.133.0"
imports:
  Rendezvous: ../../modules/rendezvous
  Http: ../../modules/http-server
ports: { http: { env: PORT, protocol: tcp, default: 8081 } }
targets:
  - !ref server
---
kind: Rendezvous.MemoryPoint
metadata: { name: decisions }
hold: 120s
payloadType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approved]
    properties:
      approved: { type: boolean }
      note: { type: string }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref routes }
---
kind: Http.Api
metadata: { name: routes }
routes:
  - request: { path: "/approvals/{id}/decision", method: GET }
    handler: { kind: Rendezvous.Await, point: !ref decisions, timeout: 25s }
    inputs: { key: !cel "request.params.id" }
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
    catches:
      - when: !cel "error.code == 'ERR_RENDEZVOUS_AWAIT_TIMEOUT'"
        status: 204
      - when: !cel "error.code == 'ERR_RENDEZVOUS_KEY_BUSY'"
        status: 409
        content: { application/problem+json: {} }
  - request:
      path: "/approvals/{id}/decision"
      method: PUT
      schema:
        body:
          type: object
          required: [approved]
          properties:
            approved: { type: boolean }
            note: { type: string }
    handler: { kind: Rendezvous.Deliver, point: !ref decisions }
    inputs:
      key: !cel "request.params.id"
      payload: !cel "request.body"
    returns:
      - { status: 202, content: { application/json: { body: !cel "result" } } }
```

*Observed:* `PUT` before any `GET` answers `202 {"delivered": false}` (held); the next `GET` for that id returns the decision at once. `PUT` while a `GET` waits answers `202 {"delivered": true}` and the `GET` returns. A `GET` unanswered for 25 s answers `204`; a re-issued `GET` still collects a decision delivered in the gap. A second `GET` for an id that already has a waiter answers `409`, and a client that reconnects before the server has seen the old connection close retries.

*Refused at `telo check`, each a one-line edit to the manifest above:*
- `payload: { approved: "yes" }` on the `PUT` route — a literal payload must fit `payloadType`: `CONTRACT_INPUTS_MISMATCH`. A computed payload (`!cel`) is refused by the call instead, as `ERR_INPUT_INVALID`.
- deleting `timeout: 25s` from the `Await`, or `hold: 0s` on the point — `SCHEMA_VIOLATION`.
- `key: ""` — `CONTRACT_INPUTS_MISMATCH`.
- in a `Telo.Sequence` step, reading `steps.decision.result.approvd` of an `Await` — the result is typed by `payloadType`, so a misspelt field is `CEL_UNKNOWN_FIELD`.

*Refused at `telo check`:* an `Await` inside a durable region. The check reports `ZONE_ATTRIBUTE_VIOLATED`, "this wait lives only in the memory of the call that opened it, … inside a durable run, wait for a delivery with Durable.Await instead":

```yaml
kind: Telo.Application
metadata:
  name: ExpenseFlow
  version: 1.0.0
  description: A durable workflow that wrongly waits with a non-durable await.
requires:
  telo: ">=0.133.0"
imports:
  Rendezvous: ../../modules/rendezvous
  DurableLocal: ../../modules/durable-local
  Journal: ../../modules/durable-journal-file
targets:
  - { name: start, invoke: !ref expense }
variables:
  journalDir: { env: JOURNAL_DIR, type: string, x-telo-type: { name: Telo.HostPath, entry: directory }, default: .telo/expenses }
---
kind: DurableLocal.Workflow
metadata: { name: expense }
journal: { kind: Journal.Journal, directory: !cel "variables.journalDir" }
steps:
  - name: decision
    inputs: { key: "expense-1" }
    invoke:
      kind: Rendezvous.Await
      point:
        kind: Rendezvous.MemoryPoint
        payloadType:
          kind: Telo.JsonSchema
          schema: { type: object, required: [approved], properties: { approved: { type: boolean } } }
      timeout: 25s
```

### The meeting is symmetric

An await and a deliver meet on a **key**, and whichever side arrives first waits for the other.
- **Await first:** the waiter is woken the moment a delivery arrives, with no polling.
- **Deliver first:** the value is **held** for the point's `hold:` window, and a waiter that opens in that window receives it immediately.

*Why held rather than refused:* a producer can legitimately answer before the consumer is waiting. In an agent, every tool call of one model step is announced before the first one is dispatched, so a client can answer a later call while an earlier one still runs. A "no waiter" refusal would turn that ordering into errors for correct clients.

A key names one meeting; keys are unique per meeting (a tool-call id, an approval id, an OAuth `state`). The point remembers only held values and open waiters, nothing after a hand-over.

*Verify:* deliver-then-await and await-then-deliver both hand over the value.

### Kinds

- **`Rendezvous.Point`** is an abstract `Telo.Provider`: the named meeting place and the contract a backend implements. It owns the key space, so two points never meet.
  - **`payloadType`** (a `Telo.JsonSchema` reference, serializable) is what a delivery carries.
  - **`hold`** is how long an undelivered value waits for a waiter (`Telo.Duration`, greater than zero, default `60s`).
- **`Rendezvous.MemoryPoint`** is the in-process backend, an explicit concrete kind in this module, never an implicit default. Its state lives on its own instance. It depends on nothing, so a module of its own would add a module with no dependency reason to exist.
- **`Rendezvous.Await`** is an invocable returning the delivered value.
  - **`point`** is a required dependency reference to `Self.Point`.
  - **`timeout`** is required and creation-time. A wait that is not durable holds an invocation, and one without a bound holds it forever.
  - **Input `key`** (non-empty string). The result is typed by the point's `payloadType`, so the steps reading it in a `Telo.Sequence` are type-checked.
  - **Throws:**
    - **`ERR_RENDEZVOUS_AWAIT_TIMEOUT`** when the deadline passes. It is raised rather than returned, for the reason `ERR_DURABLE_AWAIT_TIMEOUT` is: a declared deadline declares that going unanswered is a failure.
    - **`ERR_RENDEZVOUS_KEY_BUSY`** when a second waiter opens a key that already has one. There is one waiter per key.
  - **Cancellation:** a cancelled invocation releases its waiter, consuming nothing, and rethrows the cancellation. This is not a new code; cancellation is not an error.
- **`Rendezvous.Deliver`** is an invocable.
  - **`point`** is a required dependency reference to `Self.Point`.
  - **Inputs:** `key` and `payload`; the payload must have the point's `payloadType` — `telo check` refuses a literal that does not, and the call refuses a computed one (`ERR_INPUT_INVALID`).
  - **Output:** `{ delivered: boolean }` — `true` when a waiter took the value, `false` when it was held.
  - A deliver in another application declares the same point; with a backend that spans processes the two meet.

*Verify:*
- A literal payload of the wrong shape fails `telo check` at the deliver; a computed one fails the call.
- A missing `timeout:` fails `telo check`.
- Two points with different `payloadType`s using one key string never meet.

### The point contract

Two operations, stated normatively in the module's docs:
- **take** a value for a key with a timeout, resolving `taken`, `timedOut`, `cancelled` or `busy`;
- **offer** a value under a key, resolving `delivered` or `held`.

Per key the two are atomic: a value goes to at most one take, and a take that resolved `timedOut` or `cancelled` consumed nothing. The operations never reject on those outcomes; `Await` and `Deliver` own every code. A backend reads `hold` from its own configuration, and cancellation reaches `take` through the invocation context.

### Key lifecycle

- A fresh `Await` on a key whose earlier waiter timed out or was cancelled opens normally and takes a value held under the key.
- A second `Deliver` to a held key replaces the value and restarts its window, and reports `delivered: false`. A retried delivery is harmless.
- A held value past its window is removed unobserved; a later await waits fresh.
- A `Deliver` after a hand-over finds no memory of the key and is held like a first delivery.
- `delivered: true` means a waiter took the value; if that waiter's caller is cancelled in the same instant, the value goes with it.
- Held values are bounded by delivery rate × `hold`; the docs say so.

*Verify:* await times out, then deliver, then re-await — the re-await receives the value. Two delivers then an await — the second value arrives. A held value is gone after `hold`. Cancel a waiter, deliver, await — the value is handed over.

### Not durable, and statically so

`Rendezvous.Await`'s waiter lives only for the call. Inside a replaying region, a restart would begin the wait again for a delivery that went to the process that died. So the kind declares **`x-telo-violates-zone: { replayed: … }`** with its reason (this wait lives only in the memory of the call that opened it, so a replay after a restart would begin waiting again for a delivery that went to the process that died; inside a durable run, wait for a delivery with `Durable.Await` instead), and `telo check` refuses it inside a durable region. `Durable.Await` is the kind for that case, and the refusal's message says so. The boundary is a static error, not a sentence in the docs.

*Verify:* a `Rendezvous.Await` inside a `DurableLocal.Workflow` fails `telo check` with `ZONE_ATTRIBUTE_VIOLATED`.

## Decisions

- **The meeting place is one named resource both kinds reference**, not a store plus an `Await` that `Deliver` reaches through. A deliver must not depend on a waiter it never runs, and the payload type and key space need one owner both sides name; otherwise two meetings collide on a key string and a value is checked against one shape and handed to another.
- **The point is its own contract, not an extension of `KvStore.Store`.** A key/value store is point-access, durable and non-evicting, and four modules rely on exactly that. It cannot wake anyone, and widening it would force notification onto every KV backend.
- **Two kinds, not one resource with two operations.** Await and deliver run in different invocations, often on different routes and sometimes in different applications. An operation switch would be one node where an editor needs two.
- **A separate vocabulary from `Durable.Await`.** A deliver able to wake either kind would make this module know about the durable engine, or the reverse, and the durable delivery half is deliberately engine-specific.
- **No memory after a hand-over.** A marker would exist only to label a late duplicate, which nothing acts on, and settling a key on timeout would drop a delivery arriving before the client's re-await.

## Edge cases

- **A mistyped key delivered while nobody waits** reads `delivered: false` and expires unobserved. The primitive cannot know the key was wrong.
- **Timeout and delivery racing.** The point's atomic offer decides; a value arriving after a timeout is held for a later take and never reaches a waiter that has already raised.
- **Multi-instance.** The memory backend is one process: an await and a deliver on different replicas do not meet, and the deliver reads `delivered: false`. The kind descriptions and docs say so. A deployment with several instances uses a backend that wakes across them — a later module implementing the same contract, with no change to `Await` or `Deliver`.

## Housekeeping

- The new module's docs include a normative point contract, covering the atomic pair, the outcomes, release without consuming, replace-on-held and expiry, and a long-polling guide that tells clients to retry on a busy key. It also gets a README, hub descriptions that name no backend and no durable kind, `license: MIT` with its own `LICENSE`, and `metadata.categories: [Coordination]`.
- The module exports the point contract under the code specifier `@telorun/rendezvous`, so a backend in another module implements it without importing the module's controllers.
- A benefits-ledger entry in `docs/guides/what-you-get.md` under Standard library coordination: waiting for a value another call supplies, with a bounded timeout and cancellation, no polling.
- `durable`'s docs gain one line: a wait that needs no durability is `rendezvous`.
- An `Added` release fragment, and `telo release floor` for the module's measured floor. The module's controllers return effect chains, so it declares the effect-chain floor the stdlib already uses.
- Tests in the module:
  - deliver before await, and await before deliver;
  - re-await after a timeout collecting a delivery made in the gap;
  - replacement of a held value, and expiry after `hold`;
  - timeout;
  - cancellation releasing the waiter at once, a later delivery then held for the next take;
  - a busy key;
  - a literal payload mismatch at the deliver's `inputs:`, and a computed one refused by the call;
  - the durable-region refusal (`ZONE_ATTRIBUTE_VIOLATED`, in the module's own `tests/`, as `watch` pins its own).
- The authoring agent's primer describes the module, and when to use `Durable.Await` instead.
