# Lens: Reliability

**Applies to** retries, delivery guarantees, idempotency, ordering, overload, dependency failure and
health — how the system behaves when calls fail, repeat or pile up. Builds on the architecture lens
(synchronous depth ≤ 1, sagas) and the data-modeling lens (owner-generated IDs, store-enforced
uniqueness, read models).

## Principles, in ranking order

1. **Cancellation and deadline propagate.** Every call carries the originator's cancellation and
   remaining deadline; every layer, retry loops included, stops when cancelled or out of time. In
   Telo, a retry policy rethrows a cancellation and `ERR_DURABLE_SUSPENDED`.
2. **One retrying layer per failure.** The innermost layer where the failed operation is idempotent
   retries it, with backoff and jitter — it redoes the least work. When it gives up, it reports the
   failure upward as terminal ("retries exhausted"), so nothing above retries it again. Broker
   redelivery after a consumer crash is a different failure, not a second retry. A durable workflow
   step's retrying layer is its `RetryPolicy`.
3. **At-least-once delivery with idempotent receivers.** Exactly-once promised by a broker is
   disqualified — it ends where the handler touches a store or an API.
4. **Idempotency.**
   - An operation that can be naturally idempotent is written that way and needs no key.
   - Otherwise the originator generates the key once per logical operation and reuses it on every
     retry: the record's own ID, or an explicit key for effects that create no record. Keys derived
     from content or assigned by the receiver are disqualified.
   - The key is recorded in the same atomic write as the effect, uniqueness enforced by the store.
     A separate "seen?" check before the work is disqualified.
   - A duplicate gets a response rebuilt from the business data the first attempt produced — never
     a stored response, an "already processed" error, or an empty success. The key record holds the
     key, a reference to what the operation produced, and a request fingerprint; the same key with a
     different request is refused as a conflict.
   - A key is kept at least as long as the longest window in which it can arrive — originator
     deadline, broker redelivery horizon, durable retry schedule — declared beside the operation,
     then expired. Keeping keys forever, or one fixed period for all, is disqualified.
5. **Order per key where the effect depends on it; none elsewhere.** The key is the aggregate ID;
   one message at a time per key, keys in parallel. Every event carries its aggregate's version, and
   consumers detect stale or skipped events by version, not arrival. Global ordering is
   disqualified.
6. **Bounded queues and load shedding.** Every queue on a request path has a declared bound; beyond
   it, work is refused at once with a retryable "overloaded" error. Autoscaling complements this and
   never replaces it.
7. **Circuit breaker on every synchronous network call** — one per dependency per replica, local
   state only. Breaker state shared across replicas is disqualified.
8. **Startup is gated on required dependencies; health checks after startup never include
   dependencies.** Before it reports ready, the service connects to every required dependency.
   Permanent errors — authentication refused, unknown database, schema version incompatible with
   the code — exit at once with an actionable message. Transient errors are retried with backoff
   and jitter until a declared startup deadline, not-ready meanwhile; the service exits with a clear
   error only when the deadline passes. Once started, liveness and readiness report only the
   service's own state — not stuck, not draining. Exiting at once on a transient boot error is
   disqualified.

## Distinguishing questions

1. Is losing this message harmless?
2. Is the operation naturally idempotent, idempotent at the layer where it failed, or neither?
3. Does the effect depend on the order of events for the same entity?
4. Is the effect inside our store, or at a third party?
5. Is the read user-facing, and is a stale answer acceptable — how stale?
6. Is the work synchronous on a request path, or asynchronous?
7. Is the dependency required (the service can serve nothing without it) or optional (it
   degrades)?

## Consequences

- **Loss harmless** (telemetry, metrics, cache hints) → at-most-once allowed. **Otherwise** →
  at-least-once.
- **Naturally idempotent** → no key. **Idempotent where it failed** → retried there. **Neither** →
  the retry moves up to the nearest layer holding a key.
- **Order matters** → keyed stream. A message failing after its retries parks its key: later
  messages for that key wait, other keys continue, an alert fires. **Order does not matter** →
  unordered; a failing message is dead-lettered and processing continues, with an alert. A parked
  or dead-lettered message is never deleted automatically.
- **Third party** → the key is passed on where the third party accepts one; intent is recorded
  before the call and outcome after it, as business data the duplicate response is rebuilt from.
- **Stale acceptable** → when the dependency fails, the read is answered from a cache of the last
  successful response: a derived read model refreshed by every successful read, with a declared
  maximum staleness, the response carrying the data's age. **Not acceptable** — anything a decision
  or write depends on (balances, stock at checkout, prices charged) and above all permissions and
  authentication → the error.
- **Synchronous** → bounded queue with shedding; work whose deadline has passed is dropped before it
  starts; an open breaker fails instantly with a retryable "unavailable" error. **Asynchronous** →
  the broker holds the backlog and consumers pull at their own pace; a consumer pauses while its
  dependency's breaker is open.
- **Required dependency** (the service's own database above all) → gates startup under principle 8.
  **Optional** → does not gate startup; connected on use behind its breaker.

**Always:**
- Every network call carries the propagated deadline; one starting without a deadline gets a
  declared default. A call with no deadline is disqualified.
- Every failure crossing a boundary is classified retryable or terminal.
- A timeout is an unknown outcome, resolved by retrying with the same key or by querying the third
  party with it. Assuming failure or success is disqualified.
- Hiding a failure behind an empty list, a zero or a default value is disqualified — return the
  classified error, or a stale answer marked with its age where allowed.
- A service recovers from a dependency outage on its own. Broken connections are detected and
  replaced, reconnection backs off with jitter, a pool never stays permanently broken, and
  long-lived channels (broker consumers, change subscriptions, open streams) re-establish and
  resume where they stopped. Re-establishing a connection before anything was sent is not a retry of
  the operation and is allowed at any layer. Needing a restart to recover is disqualified.

## Horizon

A second and third layer on the call path · a second replica of a receiver · 10× traffic or a
sudden spike · a dependency down for an hour · a database restarted or failed over while the
service runs · a second consumer of an event stream · a durable workflow retrying for days · a
third-party API in the flow.

## Verify

1. On every call path exactly one layer retries a given failure, and a cancelled or expired request
   stops every layer below it.
2. Delivering the same message or request twice has the effect of one delivery, and the duplicate
   gets the same answer.
3. Every key's retention is declared and covers its longest arrival window.
4. Messages failing after retries are parked or dead-lettered, raise an alert, and are never lost.
5. Under load beyond capacity, excess work is refused quickly with "overloaded" and memory stays
   bounded.
6. With a required dependency down at boot, the service stays not-ready without crash-looping and
   becomes ready once the dependency is back; with a permanent error it exits with an actionable
   message.
7. With a dependency down while the service runs, it stays healthy, fails fast (or serves marked
   stale data where allowed), and is not restarted.
8. With the database stopped and started again while the service runs, the service serves requests
   again without a restart, and its subscriptions resume.
