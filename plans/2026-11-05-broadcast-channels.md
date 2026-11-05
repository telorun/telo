---
status: done
priority: medium
depends-on: []
packages: [modules/broadcast, modules/broadcast-postgres, modules/postgres, apps/hub, apps/authoring-agent, docs]
tracking: feat/broadcast-channels-and-argument-maps
---

# Broadcast channels: one message to every live subscription, across replicas

## Problem

Nothing in Telo tells every running instance of an application that something happened. `watch` raises a topic's version so a long poll wakes, but it carries no payload, and its only store keeps state in one process. A queue delivers each message to one worker, not to all. So any feature that must reach every replica — a screen that refreshes when another viewer writes, a cache to drop, a configuration reload, a presence list — either works on one process only or invents its own transport.

## Solution

Two new modules, split as every storage-neutral family in the standard library is: the contract and its operations in one, each backend in its own.

**`broadcast` (`Broadcast`)**

- `Broadcast.Channel` — an abstract `Telo.Provider`: one named conduit that messages are sent on. `name` is its durable identity (two resources naming one channel on one backend are one channel), matching `^[a-z][a-z0-9_]{0,47}$`; `messageType` is the `Telo.Type` every message on it satisfies, marked `x-telo-serializable: true`, so a live value type in it is refused; `maxBytes` bounds a message's encoded JSON size, its topic included.
- **Topics are on the message.** A message may carry a `topic`: dot-separated segments of `[a-z0-9_-]`, at most 128 bytes (`rooms.42`, `tasks.7.comments`). A topic is a string at publish time, so one channel carries any number of them — a room, a record, one user's notifications — without a resource each.
- `Broadcast.MemoryChannel` — the channel within one running application, for development, tests and single-instance applications, named as such in its description. Its registry is keyed by (`ctx.kernelInstanceId`, channel `name`): two memory channels naming one channel in one application are one channel, an application sharing a process with another never shares one, an entry is removed when its last listener leaves, and a host that does not provide the seam is refused with `ERR_CONTROLLER_HOST_INCOMPATIBLE`. `broadcast` declares `requires: telo` at the release that ships the seam.
- `Broadcast.Publish` — an invocable `{ channel, topic?, message }`. `message` is checked against the channel's `messageType` before it is sent (`x-telo-value-schema-from`: a literal mismatch is refused before the app runs, a computed one is `ERR_INPUT_INVALID`), and `topic` against the topic grammar the same two ways; an encoded message over `maxBytes` is `ERR_BROADCAST_MESSAGE_TOO_LARGE`; a backend that cannot send is `ERR_BROADCAST_UNAVAILABLE` — the abstract's `throws:` ceiling. It is marked `x-telo-violates-zone: replayed`, as `watch`'s publish is: a replayed step would send again.
- `Broadcast.Subscription` — a `Telo.Service` `{ channel, topics?, invoke, inputs?, onGap?, onError?, concurrency, buffer }`: a live subscription, holding nothing once it stops. `topics` is a list of patterns over the topic grammar, `*` matching one segment and `>` (last only) one or more; omitted, it receives every message on the channel, topic or not. A pattern breaking the grammar is `SCHEMA_VIOLATION`. It is started like every service only when `targets:` names it, holding a kernel hold while subscribed, and invokes `invoke` with its `inputs:` evaluated over `topic` (null when none was sent) and `message` for each matching message (the map held to the handler's `inputType`; omitted, the handler is invoked with `{}`), at most `concurrency` at a time (default 1, so in order), queueing at most `buffer` messages (default 256). A full buffer drops its backlog and raises a gap. A handler failure, or a received message that fails `messageType` (`ERR_BROADCAST_MESSAGE_INVALID`, from a publisher on another version), never stops the subscription: it is logged at error level with its code, recorded as an error on the dispatch span, and passed to `onError` when written. A gap runs `onGap` when written and is logged at warning level when not.
- The `@telorun/broadcast` code interface: what a backend implements (`publish`, `subscribe`) and what another module's controller calls to subscribe directly. A backend is recognised by those methods alone. The contract is the message, the delivery rules and the wire behaviour, not the JavaScript interface, so a controller in another language implements the same channel.

**`broadcast-postgres`** — `BroadcastPostgres.Channel`, extending `Broadcast.Channel`, over a `Postgres.Connection`'s `listen` / `notify` members. Each channel is the notification channel `telo_broadcast_<name>`, listened on over one connection per replica however many subscriptions and topics it serves; the topic travels in the payload and each replica matches it against its own subscriptions. `maxBytes` may not exceed the notification payload limit (7999 bytes; `BROADCAST_MAX_BYTES_EXCEEDS_BACKEND`, a rule twinned at creation). Published inside an open `Sql.Transaction` on its connection — found through `SqlConnection.bindsZone`, as the queue outbox finds it — a message is delivered when the transaction commits and never when it rolls back; outside one it is sent at once. A full server notification queue fails the publishing transaction's commit, surfacing as that transaction's error. `modules/postgres` gains, additively, a reconnect notice on `listen`, so a listener learns that its connection dropped and was re-established; that notice is what the channel turns into a gap.

**The delivery contract**, normative in `modules/broadcast/docs/channel-contract.md`:

- **At most once, to subscriptions live when it is sent** whose `topics` match. Nothing is stored; a subscription that was not connected never receives it.
- **Topics are matched by the subscriber.** Every replica receives every message on the channel and drops what none of its subscriptions match, so a topic is a filter, not a security boundary: any replica may read any topic on a channel it subscribes to.
- **Order is commit order**; several publishes in one transaction arrive in call order. Nothing more is promised across publishers.
- **Gaps are reported.** A subscription whose backend connection dropped, or whose buffer overflowed, receives a `gap` meaning "messages may have been missed": a consumer that must stay correct re-reads its source of truth. The memory backend never reports one.
- **Transactions are a backend property.** The PostgreSQL backend delivers on commit; the memory backend has no transaction to join and sends at once, so it is for one running application only, as its description says.
- **A message is a hint, not data to trust.** It says that something happened; the consumer reads what changed from where it lives, under that reader's own authorization.
- **It is a low-rate bus.** PostgreSQL serializes notifying commits, so a channel carries hints about writes, never a stream of data.

**Before / after.** Before, invalidating a cache on every replica means a polling loop per process. After, a write publishes `{ key }` on a `Broadcast.Channel` and a `Broadcast.Subscription` on every replica drops that key; a chat room publishes under `rooms.<id>` and each replica's subscription to `rooms.*` hears every room on one channel.

## Decisions

- **A new module, not a `watch` backend.** `watch` is a wake-up for one waiter's cursor; a broadcast carries a payload to every subscriber and keeps no state. Bending one into the other would weaken both contracts.
- **A channel is the conduit, the topic is on the message**, as NATS subjects and MQTT topics are. Rejected: one declared resource per topic (the Google Cloud Pub/Sub and Kafka model), which cannot express a room, a record or a user as a destination, and which on PostgreSQL would hold one listening connection per topic per replica.
- **The service is named `Subscription`**, for what it is. It is live and stores nothing, which its description says, since some brokers' subscriptions are durable.
- **No persistence and no replay.** A durable fan-out is a log with consumer positions — `record-stream`'s journal already is one. Broadcast is the cheap, live primitive, and its `gap` signal is what lets a consumer stay correct without a log.
- **The channel name is the identity**, not the resource name, as for queues: renaming a resource keeps every replica on one channel, and two applications share a channel by naming it — which is a trust decision, since either can then publish to the other's subscribers.
- **A failed handler is reported, not retried.** There is nothing to retry for an at-most-once hint; the failure reaches the log, the trace and `onError`, and the next message is handled.
- **PostgreSQL first.** It is the shared backend the standard library already depends on, and its notifications are transactional. A Redis or NATS backend is another module implementing the same interface; SQLite is single-instance, served by the memory channel.

Bookkeeping: module docs (`modules/broadcast/docs/` — the contract, topics and patterns, the subscription, publishing in a transaction; `modules/broadcast-postgres/docs/`; `modules/postgres` docs for the reconnect notice), each new module with `license: MIT` and its `LICENSE`; manifest tests under each `tests/`, the PostgreSQL ones under `modules/broadcast-postgres/tests/integration/` starting their database from the postgres container fixture; the primer and the hub `design-library` guide's shared primitives; `modules/CLAUDE.md` gains a Broadcast paragraph; a ledger entry under Standard library, "Messages to every running instance"; `Added` fragments for `broadcast`, `broadcast-postgres` and `postgres`. `broadcast-postgres` depends on the reconnect notice through its import of `postgres`, and declares no `requires:`.

## Verify

- Two `App.Instance` children on one PostgreSQL database, each with a `Broadcast.Subscription`: a publish in one invokes both subscriptions' handlers once.
- Two `App.Instance` children each declaring a memory channel named `events` with a subscription: a publish in one invokes only its own handler; within one application a library's memory channel and the application's own, both named `events`, deliver to each other.
- A subscription whose `invoke` requires `key`, with no `inputs`, is `CONTRACT_INPUTS_MISMATCH`; `inputs: { key: !cel "message.key" }` checks clean, `message.kye` is `CEL_UNKNOWN_FIELD`, and a handler receives exactly the mapped object.
- On one channel, a subscription to `rooms.*` receives `rooms.42` and not `rooms.42.typing`; one to `rooms.>` receives both; one with no `topics` receives every message, a topic-less one included; `rooms.**` as a pattern is `SCHEMA_VIOLATION`.
- A publish inside a `Sql.Transaction` that rolls back reaches no handler; one that commits reaches every handler after the commit, in call order.
- A message violating `messageType` is refused before the app runs when literal and with `ERR_INPUT_INVALID` when computed; one over `maxBytes` is `ERR_BROADCAST_MESSAGE_TOO_LARGE`; a topic breaking the grammar is refused the same two ways.
- A handler that fails on one message is logged with its code and `onError` runs; the next message is still handled. A received message of the wrong shape runs no handler and reports `ERR_BROADCAST_MESSAGE_INVALID`.
- Restarting the database delivers a `gap` to every subscription after it reconnects; a handler slower than the publish rate with `buffer: 2` drops its backlog and receives a gap; messages after either arrive.
- `maxBytes: 100000` on a PostgreSQL channel is `BROADCAST_MAX_BYTES_EXCEEDS_BACKEND`, refused at the declaring library and failing a consumer's run with the twin.

## Example after the change

```yaml
kind: BroadcastPostgres.Channel
metadata: { name: cacheEvents }
name: cache_events
connection: !ref db
maxBytes: 1024
messageType: !ref CacheEvent
---
kind: Broadcast.Subscription
metadata: { name: dropOnChange }
channel: !ref cacheEvents
topics: [tenants.*.cache]
invoke: !ref dropCacheEntry   # any invocable
inputs: { key: !cel "message.key" }   # evaluated over topic and message
```
