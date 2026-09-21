# Rendezvous

## Problem

Several kinds of work stop mid-invocation and wait for a value that another call supplies:

- an agent tool whose work runs in a client, which returns the result through a separate request;
- an approval;
- a webhook answered within a request's lifetime;
- an OAuth device or redirect callback;
- any human-in-the-loop step.

Telo has this only in durable form. `Durable.Await` requires a replayed `Durable.Run` region and parks the run, and `Local.Deliver` is its engine-specific delivery half. Work that is not durable, and should not be, has no primitive. It ends up polling a store in a loop, which adds latency to every wait, knows nothing of cancellation, and silently assumes one process.

## Solution

A new module, **`rendezvous`** (`metadata.name: Rendezvous`), with two invocable kinds, a store contract, and an in-memory backend.

### The meeting is symmetric

*Before:* n/a.

*After:* an await and a deliver meet on a **key**, and whichever side arrives first waits for the other.
- **Await first:** the waiter is woken the moment a delivery arrives, with no polling.
- **Deliver first:** the value is **held** for the deliver's `hold:` window, and a waiter that opens in that window receives it immediately.

A deliver reports its outcome as data, one of three:
- **`delivered`:** a waiter took the value.
- **`held`:** no waiter yet; the value is kept for the window.
- **`settled`:** the key is already finished. It was delivered, timed out or was cancelled, so this delivery is late or a duplicate.

*Why held rather than refused:* a producer can legitimately answer before the consumer is waiting. In an agent, every tool call of one model step is announced before the first one is dispatched, so a client can answer a later call while an earlier one still runs. A "no waiter" refusal would turn that ordering into errors for correct clients.

*Verify:* deliver-then-await and await-then-deliver both hand over the value; a second deliver to a finished key reports `settled`.

### Kinds

- **`Rendezvous.Await`** is an invocable returning the delivered value.
  - **`outputType`** (required; a schema reference, per instance, as on `Durable.Await`) types what a delivery carries, so the steps reading the result are type-checked.
  - **`key`** is runtime CEL over the call's `inputs`.
  - **`timeout`** is required and creation-time. A wait that is not durable holds an invocation, and one without a bound holds it forever.
  - **`store`** is a required dependency reference to `Self.Store`.
  - **Throws:**
    - **`ERR_RENDEZVOUS_TIMEOUT`** when the deadline passes. The timeout is raised rather than returned, for the reason `ERR_DURABLE_AWAIT_TIMEOUT` is: a declared deadline declares that going unanswered is a failure.
    - **`ERR_RENDEZVOUS_KEY_BUSY`** when a second waiter opens a key that already has one. There is one waiter per key.
  - **Cancellation:** a cancelled invocation settles its key and rethrows the cancellation. This is not a new code; cancellation is not an error.
- **`Rendezvous.Deliver`** is an invocable.
  - **`await`** is a required reference to `Self.Await`. The deliver reaches the store through it, and it is what ties a delivery's shape to the waiter's.
  - **`key`** is runtime CEL.
  - **`payload`** carries `x-telo-schema-from: await/outputType`, so every delivery is checked statically against what its waiter declared.
  - **`hold`** is the window a value waits for a waiter, creation-time.
  - Its closed output is `{ outcome: delivered | held | settled }`.
  - **Throws:** **`ERR_RENDEZVOUS_PAYLOAD_INVALID`**, the runtime twin of the static payload check.
  - A deliver in another application declares the same `Await` resource. The reference is configuration, not a live waiter.
- **`Rendezvous.Store`** is a new abstract with its own contract, which includes waking:
  - **open** a waiter under a key with a deadline;
  - **offer** a value, with the store answering `delivered`, `held` or `settled` atomically;
  - **wake** a waiter;
  - **release** a waiter on timeout or cancellation, which marks the key settled.

  Each backend declares a `settledRetention:`: how long a settled marker is remembered, so a late delivery reads as `settled` rather than `held`.
- **`Rendezvous.MemoryStore`** is the in-process backend, an explicit concrete kind in this module, never an implicit default. It depends on nothing, so a module of its own would add a module with no dependency reason to exist.

*Verify:*
- Every kind validates as specified.
- A payload of the wrong shape fails `telo check` at the deliver.
- A missing `timeout:` fails `telo check`.

### Not durable, and statically so

`Rendezvous.Await`'s waiter lives only for the call. Inside a replaying region, a restart would begin the wait again for a delivery that went to the process that died. So the kind declares **`x-telo-violates-zone: { replayed: … }`** with its reason, and `telo check` refuses it inside a durable region. `Durable.Await` is the kind for that case, and the refusal's message says so. The boundary is a static error, not a sentence in the docs.

*Verify:* a `Rendezvous.Await` inside a `DurableLocal.Workflow` fails `telo check` with the zone violation. `tests/check-run-agreement.yaml` gains the row, refused by both halves.

## Decisions

- **The store is its own contract, not an extension of `KvStore.Store`.** A key/value store is point-access, durable and non-evicting, and four modules rely on exactly that. It cannot wake anyone, and widening it would force notification onto every KV backend.
- **Two kinds, not one resource with two operations.** Await and deliver run in different invocations, often on different routes and sometimes in different applications. An operation switch would be one node where an editor needs two.
- **A separate vocabulary from `Durable.Await`.** A deliver able to wake either kind would make this module know about the durable engine, or the reverse, and the durable delivery half is deliberately engine-specific.
- **Held, not refused, when the deliver is first.** See above.
- **The in-memory backend lives in the module and is named explicitly.** This is the same rule as the durable journal store.

## Correctness and edge cases

- **A mistyped key delivered while nobody waits** reads `held` and expires unobserved. A caller that can confirm the key exists checks before delivering. The primitive cannot know.
- **Timeout and delivery racing.** The store's atomic offer decides which one won. A value arriving after the timeout settled the key reports `settled`, and never reaches a waiter that has already raised.
- **Cancellation.** It needs the invocation's cancellation signal on the controller surface, which the SDK already provides. The waiter wakes immediately and settles its key.
- **Multi-instance.** The memory store is one process: an await and a deliver on different instances do not meet. A deployment with several instances uses a backend that wakes across them. That is a later module implementing the same contract, with no change to `Await` or `Deliver`.

## Housekeeping

- The new module's docs include a normative store contract, covering the atomic offer, the three outcomes, the wake guarantee and settled markers. It also gets a README, and hub descriptions that name no backend and no durable kind.
- `durable`'s docs gain one line: a wait that needs no durability is `rendezvous`.
- An `Added` release fragment. The module's controllers return effect chains, so it declares the effect-chain floor the stdlib already uses.
- Tests in the module:
  - deliver before await, and await before deliver;
  - timeout;
  - cancellation releasing the waiter at once, then `settled` for a later delivery;
  - a busy key;
  - a static payload mismatch;
  - the durable-region refusal.
- The authoring agent's primer describes the module, and when to use `Durable.Await` instead.
