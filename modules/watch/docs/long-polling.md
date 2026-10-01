# Long polling with a version cursor

A client that wants to see a change as soon as it happens, without holding a
socket open or polling on a timer, asks the server "has anything changed since
version N?" and the server holds the request until something has — or until a
bound, after which the client simply asks again. `Watch.Wait` is the hold;
`Watch.Publish` is the wake-up.

## The pattern

The **database stays the source of truth**. The store behind `Watch.Wait` is only
a wake-up signal: it never carries the data, and nothing is lost if it forgets a
topic or wakes a waiter early. Every request therefore has the same three steps:

1. **Read** the current state and its version from the database. If the version
   is already past the client's cursor, answer at once.
2. **Wait** on the topic with the version just read as `after`.
3. **Read again**, whatever the wait returned, and answer with what is there now.

```yaml
kind: Watch.MemoryStore
metadata: { name: watchStore }
---
kind: Watch.Wait
metadata: { name: planChanged }
store: !ref watchStore
maxTimeout: 30s
---
kind: Run.Sequence
metadata: { name: pollPlan }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [id, since]
    properties:
      id: { type: string }
      since: { type: integer }
steps:
  - name: before
    inputs: { id: !cel "inputs.id" }
    invoke: !ref readPlan              # → { version, … }
  - name: hold
    if: !cel "steps.before.result.version <= inputs.since"
    then:
      - name: wait
        inputs:
          topic: !interpolate "plan:${{ inputs.id }}"
          after: !cel "steps.before.result.version"
          timeout: 25s
        invoke: !ref planChanged
  - name: after
    inputs: { id: !cel "inputs.id" }
    invoke: !ref readPlan
```

The writer publishes **after** its transaction commits, with the version it
committed. The publish returns nothing:

```yaml
- name: save
  invoke: !ref savePlan                # commits, returns { version }
- name: notify
  inputs:
    topic: !interpolate "plan:${{ inputs.id }}"
    version: !cel "steps.save.result.version"
  invoke:
    kind: Watch.Publish
    store: !ref watchStore
```

### Why no change is missed

The gap between step 1 and step 2 is the dangerous one: a write that commits
after the read but before the wait opens would, with a plain notification,
wake nobody. The store closes it by **remembering the latest version per topic**.
A wait whose `after` is already below what the store knows returns at once with
`changed: true`, so a publish landing in that gap is seen at once while the store
remembers the topic.

A store may forget a topic nobody is waiting on (`Watch.MemoryStore` does, beyond
`maxTopics`). If the topic is forgotten inside that gap, the wait sees version 0,
waits, and returns `changed: false` at its timeout — step 3 then reads the change.
So a change is never lost: it is seen at once, or at the latest at the timeout.

### Why the cursor is the version read, not the client's

Waiting on the version the server just read — rather than the client's `since` —
means a wait never returns for a change the client already has, and the answer
after the wait is always at least as new as the one before it.

### Timeouts are data

A wait that runs out of time returns `{ changed: false, version }`; it never
throws. The request answers with what step 3 read, and the client asks again
with the version it now has. The same cursor can be waited on any number of
times: nothing is consumed or settled by a wait.

`timeout` is chosen per call (`25s`, or `!cel "duration(request.query.wait)"`),
and `maxTimeout` on the resource caps it, so no client can hold a request past
the deadlines of the proxies in front of the server. `maxTimeout` is evaluated
once, when the resource is created, so it may come from a variable
(`!cel "variables.longPollCap"`) but not from anything a call carries.

### Many waiters

Any number of calls may wait on one topic — every browser tab watching one plan —
and a single publish wakes all of them.

### Cancellation

A call cancelled while it waits — a client that disconnects, an elapsed deadline —
releases its waiter at once and rethrows the cancellation. Nothing is left
behind in the store.

### Versions

A version is any integer that only grows for a topic: a row's revision column, a
sequence value, an update counter. A publish at or below the version the store
knows changes nothing, so publishing out of order is harmless. After a restart an
in-memory store knows no versions at all, which is why step 1 comes first: the
database answers what the store cannot.

## Not for durable runs

A wait lives only in the memory of the call that opened it. A durable run's body
is replayed after a restart, and a replayed wait would begin waiting again for a
signal that went to the process that died — so a `Watch.Wait` inside a durable
region is a `telo check` error (`ZONE_ATTRIBUTE_VIOLATED`), and the runtime
refuses one it reaches there (`ERR_WATCH_REPLAY_FORBIDDEN`). A durable run waits
for a delivery with `Durable.Await`.

## A version signal, not a hand-off

Watching is a **version signal that any number of waiters share**: it carries no
payload, a publish is never consumed, and a waiter that misses the moment loses
nothing, because the version is remembered and the data is in the database.

Handing **one value to one waiter** — a tool result delivered to the call that is
waiting for it, an approval answered within a request's lifetime — is a different
primitive: the value itself travels, exactly one waiter takes it, and a second
delivery must be told the hand-off already happened. That is a rendezvous, not a
watch; build it on a primitive that owns a key's settlement rather than on a
version cursor.
