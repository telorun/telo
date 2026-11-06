---
status: done
priority: medium
depends-on: []
packages: [modules/domain-events, analyzer, kernel, sdk, modules/queue, apps/authoring-agent, apps/hub, docs]
---

# Domain events: announce what happened, handled in the emitter's transaction

## Problem

A library cannot tell its importers that something happened. A user-account library that must leave an audit row has to write the audit table itself: it has to know about the audit log, its connection and its shape. An application cannot add a reaction to a library's operation (an audit row, a welcome email, a counter) without forking the library. The queue outbox (`QueueSql.Enqueue` inside a `Sql.Transaction`) and `broadcast` move messages, but both have to be named by whoever writes. Neither lets the code that does the work stay ignorant of the code that reacts to it.

`kernel/specs/signals.md` sketched this as "signals": implicit output ports on resources, renamed at `exports.signals`. It was never implemented. This plan replaces it, and the spec file is deleted.

## Solution

A new module, **`domain-events`** (`metadata.name: DomainEvents`, imported as `Domain` throughout the docs and the primer, as `queue`'s `Queues` is imported as `Queue`).

- **`Domain.Event`** declares one event, and the event IS its payload's shape. It `extends: Telo.JsonSchema`, so it is a `Telo.Type` named in PascalCase (`UserCreated`). It is written exactly as a `Telo.JsonSchema`, and works anywhere a type does (`inputType: !ref UserCreated`). It adds no field. The kind is the marker that a shape is a published event: only a `Domain.Event` is accepted by an emit or a handler (`REFERENCE_KIND_MISMATCH` for a plain shape), and the hub and the studio list a library's events by kind, with no change of their own. Events sharing a payload share it through `extends`.
- **Visibility.** An event is private to its module unless the library lists it in `exports.resources`, as any named shape is; an importer writes `!ref Iam.UserCreated`.
- **Identity.** An event is matched as declared in the module instance its reference reaches, so a library imported twice as `isolated` has two separate events, each needing its own handler, and a `shared` one has one. The library and the application import `domain-events` separately; its kinds are one canonical kind each (`DomainEvents.Handler`), as for any module imported from several places.
- **Library reactions.** A library that reacts to another library's events (an `audit` library) exports an invocable; the application wires it with a typed handler.
- **`Domain.Emit`** is a `Telo.Invocable` `{ event }` whose inputs ARE the payload, held to the event's schema (`x-telo-value-schema-from`). A literal mismatch is refused before the app runs; a computed one is `ERR_INPUT_INVALID`. It runs every handler of its event one at a time, inside its own invocation, and then returns an empty object.
- **`Domain.Handler`** is a `Telo.Invocable` `{ event, when?, invoke, inputs? }` whose input is the payload. Its own controller evaluates `when` and `inputs`, so invoking a handler directly (a test) behaves as an emit's call does.
  - `when` is a runtime boolean over `event`; when it is false the handler returns without calling its target.
  - `inputs` is evaluated over `event` and checked against the target's `inputType`. Omitted, the target is invoked with `{}`, as `Broadcast.Subscription` and the queue worker do; a handler forwarding the payload whole writes `inputs: !cel "event"`.
  - The target's result is discarded.
  - A handler is not a service and goes in no `targets:`; it exists by being declared at module scope. It is a named top-level document, since its name is what traces and `ERR_DOMAIN_EVENT_HANDLER_FAILED` report.

**Delivery is synchronous, in the emitter's invocation.** Every zone open at the emit is open in each handler. A handler's statement on the emitter's connection that names no `transaction:` joins the open transaction and commits or rolls back with it; the library exports no transaction for this. A handler that fails fails the emit, and so rolls the transaction back. A handler suspending inside a `noSuspend` zone is refused, as anywhere else. Work that must happen after commit and survive a crash is a handler that enqueues on a `queue-sql` outbox in the same transaction; `QueueSql.Enqueue`'s own zone requirement is then proven through the emit. A handler publishing on a `broadcast-postgres` channel likewise delivers at commit. Three consequences `docs/delivery.md` states:
- A handler holds the emitter's transaction open while it runs, so external I/O goes through the outbox, never inside a handler.
- A handler whose target requires a zone holds every emit of its event to it, a test invoking `Domain.Emit` directly included; such a test wraps the emit in a `Sql.Transaction`.
- A handler that must be atomic with the emitter uses a target that requires the transaction, as `QueueSql.Enqueue` does; a plain `Sql.Command` joins one when it is open and is not checked.

**Failure contract.** A handler failure leaves the emit as `ERR_DOMAIN_EVENT_HANDLER_FAILED`, with `data: { event, handler }` and the original failure as its `cause`. That code is `Domain.Emit`'s whole `throws:` list, and a declared list is what leaves a kind, so the fan-out edges carry no handler's codes into a library's throws union or its `catches:` coverage. Cancellation and `ERR_DURABLE_SUSPENDED` pass through unchanged, since they are signals, not errors.

**Order.** Handlers run in application load order — the root, then its imports depth-first in `imports:` order, a shared library at its first reach — and within a module instance in the order its documents are read. The order is fixed per application, the same for every emit of an event. Handlers must not depend on each other's order; handlers that must run in sequence belong in one handler invoking a `Telo.Sequence`.

**The fan-out is static: a new `x-telo-ref` key.** An emit names its event and a handler names the same event, but nothing names the handlers from the emit. So the slot has to declare that dispatching it reaches them. `callsCoReferrers: { kind: <Kind>, slot: /<pointer> }` on an `x-telo-ref` means: dispatching this resource calls the **co-referrers** of this slot's target — every module-scope declaration (template-body instances included, `!for-each` members in family order) of that kind, or a kind extending it, whose slot at `slot` names the same declaration in the same module instance, whether the target is an instance or a named shape. It sits beside `throwsThrough` and `observes`, which also describe what the declaring resource does with a slot. `Domain.Emit.event` declares `{ kind: Self.Event, use: schema, callsCoReferrers: { kind: Self.Handler, slot: /event } }`. The analyzer's edges and the kernel's set come from one definition.
- **Analyzer.** It adds those `call` edges to the call graph, so zone requirements and violations and the studio's topology see the path emit → handler → target. The edges exist only where the handlers are in view: a library checked alone has none, and its importer's `telo check` reports what the fan-out reaches. An outbox enqueue in a handler is proven inside the emitter's transaction, and the same handler on an event also emitted outside one is `ZONE_REQUIREMENT_UNSATISFIED`, naming the path.
- **Typed `event`.** The handler types `event` with `x-telo-context-ref-from: event/schema`. Today that annotation's first hop finds nothing for an alias-qualified `!ref <Alias>.<name>` and leaves the binding open; it is changed, for every kind using it, to resolve such a reference through the holder's imports as `x-telo-value-schema-from` already does, with `extends` folded. Without it `event` is untyped for every imported event.
- **Controller boundary.** One new controller-protocol message, `Ref.CoReferrers` (request `{ instance, slot }`, response the ordered live handles, created on demand as `Ref.Resolve` does), reached as `ctx.resolveCoReferrers(slot)`. It is answered at dispatch from an index built at load and rebuilt on reconcile, never frozen at creation, so a library's emit and its importer's handlers form no init-order cycle and a reconcile that adds a handler reaches the next emit. The order above is stated once, in this message's spec. Adding the message makes the protocol generation `telo-10`; `9` is withdrawn as `4`–`8` were, since no carrier speaks it yet. The emit's controller owns running the handles one at a time, wrapping failures and passing signals through; the kernel names nothing of `Domain.*`.
- **Refusals.**
  - A malformed key is `X_TELO_REF_INVALID_CALLS_CO_REFERRERS` at the kind and `ERR_X_TELO_REF_INVALID_CALLS_CO_REFERRERS` at registration. Malformed means a `kind` that does not resolve, a `slot` that is no reference slot of that kind, or a `slot` whose kind cannot hold this slot's target.
  - A co-referrer declared inside an execution scope (`with:`, `x-telo-scope`) exists only while that scope runs, so it is `CO_REFERRER_SCOPED` at check and `ERR_CO_REFERRER_SCOPED` at load.
  - Both are pinned in `tests/check-run-agreement.yaml`.

The analyzer owns no knowledge of `Domain.*`.

## Decisions

- **The event is a type, and is its own payload shape.** It has nothing to start or provide, so a `Telo.Provider` would be an instance with nothing to do. A separate `payloadType` would add a second declaration per event, which `extends` already covers. The marker kind is kept over accepting any `Telo.Type`: it keeps a library's other shapes from being emitted or subscribed to by accident, and lets events be discovered by kind.
- **A module plus one generic `x-telo-ref` key and one protocol message, not kernel built-ins.** The old spec's `Telo.Event`, `emit:` step and `exports.events` would widen the grammar of both kernels, for something the reference-slot vocabulary can express. The key is reusable by any kind whose dispatch reaches its co-referrers.
- **The kernel answers the set; the module owns the strategy.** A kernel-side fan-out would hardcode one delivery strategy and a module's error code into the kernel; a set handed in at creation goes stale on reconcile and puts data the author never wrote into the configuration.
- **`callsCoReferrers` on `x-telo-ref`.** It is a fact about one reference slot, read where every other one is. "Co-referrers" is `x-telo-referrer-rules`' word for the other declarations reaching the same target through a slot; the handlers refer to the event, not to the emit, so `callsReferrers` would misread. `slot` is the existing key for a reference-slot pointer.
- **Explicit emits, no implicit ports.** A business event is a named intent at a chosen point, not a statement's success. The old `InsertUser.Success` port tied consumers to an implementation detail. Boundary payload renaming is dropped: a library that wants a public shape emits it.
- **Synchronous only.** A built-in "after commit" phase loses the event when the process dies between commit and handler. The outbox already gives the durable form, and composing it keeps one delivery rule.
- **Handlers join ambiently.** Naming the library's transaction would make its internal structure published contract while asserting nothing more precise, since `transaction:` asserts only a transaction on that connection. A plain `Sql.Command` therefore carries no static atomicity assertion in a handler, which is `sql`'s documented gap, not this module's.
- **Omitted `inputs` is `{}`.** Forwarding the payload by default would need a new annotation typing an omitted map from a binding; `{}` is what every stdlib trigger kind does, and both the omitted and the written form are checked with what exists.
- **Wrapped handler failures.** Propagating an importer's codes unchanged would make a library's throws depend on code it cannot see, and break its `catches:` coverage.
- **Sequential, one documented order.** One transaction's connection serves one statement at a time, and two kernels must run handlers in the same order for a failure with effects outside the database to reproduce. No priority: handlers that depend on each other go in one handler.
- **Handlers are invocables.** That lets the fan-out name the handler itself, puts its own `invoke` on the ordinary call-slot path, and lets a test invoke a handler directly.
- **"Event", not "signal".** "Signal" collides with abort signals and process signals.
- **No Rust change.** The module's controllers are Node bundles, which the Rust kernel cannot host, the Rust analyzer does not check `x-telo-ref`, and no carrier speaks the protocol generation yet — the carrier that lands implements `Ref.CoReferrers` with the rest of its set.

Bookkeeping:
- **Module docs:** `modules/domain-events/README.md`, plus `docs/delivery.md` (synchronous delivery, the transaction, order and failure), `docs/handling-from-a-library.md` and `docs/after-commit.md` (the outbox handler). The module also gets `license: MIT` and its `LICENSE`, and declares `requires: telo` at the release carrying `callsCoReferrers` — the generated `TELO_SURFACE_VERSION` when it is implemented (`0.131.0` in the examples) — verified by running the previous CLI against it.
- **Protocol:** `kernel/specs/controller-protocol.md` gains `Ref.CoReferrers` with its ordering rule and generation `telo-10`; `sdk/controller-protocol/` gains its message file and vectors and the generation `10`; `pnpm run check:controller-protocol` stays green.
- **Cross-references:** `modules/queue/docs/transactional-outbox.md` gains the handler form.
- **Agent guides:** `modules/CLAUDE.md` gains a Domain events paragraph. The root and analyzer `CLAUDE.md` gain `callsCoReferrers` in their `x-telo-ref` entries and the alias-qualified first hop in the `x-telo-context-ref-from` entry.
- **Authoring agent:** the primer and the hub `design-library` guide cover emitting from a library, handling as an importer, and `inputs: !cel "event"` for forwarding the payload.
- **Benefits ledger:** a Standard library entry, "Business events handled in the same transaction".
- **Releases:** a changeset for `@telorun/analyzer`, `@telorun/kernel` and `@telorun/sdk`, and an `Added` fragment for `domain-events`.
- **Cleanup:** `kernel/specs/signals.md` is deleted.

## Verify

- **Commit and rollback.** The `Iam` library and the `Accounts` application below:
  - signing up `ada@lovelace.dev` commits the user, audit and outbox rows;
  - the rollback fixture below fails the call with `ERR_DOMAIN_EVENT_HANDLER_FAILED`, the handler's failure as its cause, and leaves no user row;
  - `Iam`'s `exports.resources` names no transaction.
- **Static checks:**
  - the outbox handler reached through the emit inside `createUser` checks clean;
  - the same handler with the event also emitted outside a transaction is `ZONE_REQUIREMENT_UNSATISFIED` naming the path through the emit;
  - a literal payload mismatch is refused at check;
  - `event.kye` in `when` and in `inputs` is `CEL_UNKNOWN_FIELD`, for an imported event and a same-module one;
  - a handler omitting `inputs` whose target requires an input is `CONTRACT_INPUTS_MISMATCH` at `invoke`;
  - `inputs: !cel "event"` aimed at a target whose `inputType` the payload does not fit is `CEL_TYPE_ERROR`, and on a fitting target checks clean;
  - a library catching `ERR_DOMAIN_EVENT_HANDLER_FAILED` around its emit is covered, with an importer's handler throwing a code of its own;
  - a durable wait in a handler of an emit inside a transaction is refused.
- **Set and order:**
  - handlers in the root, in two imports and in an `include:` partial run root first, then imports depth-first, each in document order;
  - an application with an emit and handlers across three modules dispatches exactly the handlers its call graph lists, compared in one test;
  - a reconcile that adds a handler changes the next emit's set without recreating the emit;
  - `when: false` skips the target, and the handler's span has no child;
  - with the library imported twice as `isolated`, a handler on one import's event never runs for the other's emit; imported as `shared`, it runs for both;
  - a library and its importer each importing `domain-events` handle and emit one event;
  - an emit or a handler naming a plain `Telo.JsonSchema` is `REFERENCE_KIND_MISMATCH`, and `inputType: !ref UserCreated` types a sequence from the event;
  - an importer handling a non-exported event is refused by the existing export check.
- **Pass-through.** Cancellation and durable suspension pass through the emit unchanged.
- **Trace.** The trace shows the emit's dispatch span with one child per handler.
- **Refusals.** The refused application below reports both diagnostics shown; a malformed `callsCoReferrers` and a handler in a `with:` scope are each refused by `telo check` and at run, in `tests/check-run-agreement.yaml`. The previous published CLI rejects the module, and with `requires:` restored it reports `MODULE_REQUIRES_NEWER_RUNTIME`.

## Examples

### Before: the library writes its own reactions

```yaml
# iam/telo.yaml — must know the audit table and the welcome-email outbox
kind: Telo.Library
metadata: { name: Iam, version: 0.1.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.30.0
  QueueSql: oci://ghcr.io/telorun/queue-sql@0.2.0
  QueueSqlite: oci://ghcr.io/telorun/queue-sqlite@0.2.0
resources:
  connection: { kind: Sql.Connection }
  welcomeEmails: { kind: QueueSqlite.Queue }
exports:
  resources: [createUser]
---
kind: Sql.Transaction
metadata: { name: createUser }
connection: !ref connection
inputs: { userId: !cel "uuidv4()", email: !cel "inputs.email" }
steps:
  kind: Telo.Sequence
  steps:
    - name: insert
      invoke: { kind: Sql.Command, connection: !ref connection }
      inputs:
        sql: "INSERT INTO users (id, email) VALUES (?, ?)"
        bindings: [!cel "inputs.userId", !cel "inputs.email"]
    - name: audit
      invoke: { kind: Sql.Command, connection: !ref connection }
      inputs:
        sql: "INSERT INTO audit_log (action, subject) VALUES ('user.created', ?)"
        bindings: [!cel "inputs.userId"]
    - name: welcome
      invoke: { kind: QueueSql.Enqueue, queue: !ref welcomeEmails }
      inputs:
        id: !interpolate "welcome-${{ inputs.userId }}"
        message: { email: !cel "inputs.email" }
```

### After: the module's own kinds

```yaml
# modules/domain-events/telo.yaml
kind: Telo.Library
metadata:
  name: DomainEvents
  version: 0.1.0
  license: MIT
  description: >-
    Business events a library announces and its importers react to, inside the
    announcing call and its transaction. A library declares an event as a typed
    payload and emits it; any module handles it with a filter and a target. A
    failing handler fails the call, so a rollback undoes every reaction.
requires: { telo: ">=0.131.0" }
exports:
  kinds: [Event, Emit, Handler]
---
kind: Telo.Definition
metadata:
  name: Event
  description: >-
    Declares one business event as the JSON Schema of its payload. Usable
    anywhere a type is; only an event can be emitted or handled.
extends: Telo.JsonSchema
---
kind: Telo.Definition
metadata:
  name: Emit
  description: >-
    Announces an event with its payload as the call's inputs, held to the
    event's schema. Runs every handler of the event in order inside this call and
    returns an empty object; a handler failure fails the call.
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./nodejs/domain-events.mjs&local_path=./nodejs/src/index.ts#Emit]
throws:
  codes:
    ERR_DOMAIN_EVENT_HANDLER_FAILED:
      description: A handler of the event failed; the failure is the cause.
      data:
        type: object
        additionalProperties: false
        required: [event, handler]
        properties:
          event: { type: string, description: The event's name. }
          handler: { type: string, description: The failing handler's name. }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, x-telo-value-schema-from: /event }
outputType:
  kind: Telo.JsonSchema
  schema: { type: object, additionalProperties: false }
schema:
  type: object
  additionalProperties: false
  required: [event]
  properties:
    event:
      title: Event
      description: The event announced.
      x-telo-ref:
        kind: Self.Event
        use: schema
        callsCoReferrers: { kind: Self.Handler, slot: /event }
---
kind: Telo.Definition
metadata:
  name: Handler
  description: >-
    Reacts to one event: when its condition holds, calls its target with inputs
    computed from the payload. Runs inside the announcing call, so its writes
    share that call's transaction.
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./nodejs/domain-events.mjs&local_path=./nodejs/src/index.ts#Handler]
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, x-telo-value-schema-from: /event }
schema:
  type: object
  additionalProperties: false
  required: [event, invoke]
  properties:
    event:
      title: Event
      description: The event handled.
      x-telo-ref: { kind: Self.Event, use: schema }
    when:
      title: When
      description: Evaluated per event; false skips the target.
      type: boolean
      x-telo-eval: runtime
      x-telo-context: { type: object, properties: { event: { x-telo-context-ref-from: event/schema } } }
    invoke:
      title: Target
      description: What runs for the event; its result is discarded.
      x-telo-ref: { kind: Telo.Invocable, use: call, inputs: /inputs }
    inputs:
      title: Inputs
      description: The target's inputs over `event`; omitted, the target is invoked with `{}`.
      type: object
      additionalProperties: true
      default: {}
      x-telo-context: { type: object, properties: { event: { x-telo-context-ref-from: event/schema } } }
```

### After: the library emits, knowing nothing of its handlers

The audit insert and the welcome-email queue leave the library: the queue is no longer a `resources:` input, and both reactions move to the application.

```yaml
# iam/telo.yaml
kind: Telo.Library
metadata: { name: Iam, version: 0.1.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.30.0
  Domain: oci://ghcr.io/telorun/domain-events@0.1.0
resources:
  connection: { kind: Sql.Connection }
exports:
  resources: [createUser, UserCreated]
---
kind: Domain.Event
metadata: { name: UserCreated }
schema:
  type: object
  required: [userId, email]
  properties:
    userId: { type: string }
    email: { type: string }
---
kind: Sql.Transaction
metadata: { name: createUser }
connection: !ref connection
inputs: { userId: !cel "uuidv4()", email: !cel "inputs.email" }
steps:
  kind: Telo.Sequence
  inputType: !ref UserCreated
  steps:
    - name: insert
      invoke: { kind: Sql.Command, connection: !ref connection }
      inputs:
        sql: "INSERT INTO users (id, email) VALUES (?, ?)"
        bindings: [!cel "inputs.userId", !cel "inputs.email"]
    - name: announce
      invoke: { kind: Domain.Emit, event: !ref UserCreated }
      inputs: { userId: !cel "inputs.userId", email: !cel "inputs.email" }
```

### After: the application lends its connection and reacts in the same transaction

```yaml
# telo.yaml
kind: Telo.Application
metadata: { name: Accounts, version: 0.1.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.30.0
  SQLite: oci://ghcr.io/telorun/sqlite@0.13.0
  QueueSql: oci://ghcr.io/telorun/queue-sql@0.2.0
  QueueSqlite: oci://ghcr.io/telorun/queue-sqlite@0.2.0
  Domain: oci://ghcr.io/telorun/domain-events@0.1.0
  Iam:
    source: ./iam
    resources: { connection: !ref db }
targets:
  - !ref appSchema
  - name: signUp
    invoke: !ref Iam.createUser
    inputs: { email: "ada@lovelace.dev" }
---
kind: SQLite.Connection
metadata: { name: db }
file: ":memory:"
---
kind: SQLite.Table
metadata: { name: users }
table: users
columns:
  id: { type: text, primaryKey: true }
  email: { type: text, nullable: false }
---
kind: SQLite.Table
metadata: { name: auditLog }
table: audit_log
columns:
  action: { type: text, nullable: false }
  subject: { type: text, nullable: false }
---
kind: QueueSqlite.Table
metadata: { name: messages }
table: queue_messages
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref users, !ref auditLog, !ref messages]
---
# No `transaction:` — joins the transaction open on `db`.
kind: Domain.Handler
metadata: { name: auditUserCreated }
event: !ref Iam.UserCreated
invoke: { kind: Sql.Command, connection: !ref db }
inputs:
  sql: "INSERT INTO audit_log (action, subject) VALUES ('user.created', ?)"
  bindings: [!cel "event.userId"]
---
# The enqueue requires a transaction on `db`, proven through the emit.
kind: Domain.Handler
metadata: { name: queueWelcomeEmail }
event: !ref Iam.UserCreated
when: !cel "!event.email.endsWith('@example.com')"
invoke:
  kind: QueueSql.Enqueue
  queue:
    kind: QueueSqlite.Queue
    connection: !ref db
    schema: !ref appSchema
    table: !ref messages
    name: welcome-emails
    retention: 168h
    messageType:
      kind: Telo.JsonSchema
      schema:
        type: object
        required: [email]
        properties:
          email: { type: string }
inputs:
  id: !interpolate "welcome-${{ event.userId }}"
  message: { email: !cel "event.email" }
```

### Rollback: a failing handler undoes the emitter's write

A test beside the library: the handler forwards the payload whole and refuses it, and the user row is gone.

```yaml
# iam/tests/handler-failure-rolls-back.yaml
kind: Telo.Application
metadata: { name: HandlerFailureRollsBack, version: 0.1.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.30.0
  SQLite: oci://ghcr.io/telorun/sqlite@0.13.0
  Domain: oci://ghcr.io/telorun/domain-events@0.1.0
  Assert: oci://ghcr.io/telorun/assert@0.22.1
  Iam:
    source: ..
    resources: { connection: !ref db }
targets: [!ref appSchema, !ref test]
---
kind: SQLite.Connection
metadata: { name: db }
file: ":memory:"
---
kind: SQLite.Table
metadata: { name: users }
table: users
columns:
  id: { type: text, primaryKey: true }
  email: { type: text, nullable: false }
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref users]
---
kind: Domain.Handler
metadata: { name: refuseSignUp }
event: !ref Iam.UserCreated
inputs: !cel "event"
invoke:
  kind: Telo.Sequence
  inputType: !ref Iam.UserCreated
  steps:
    - name: refuse
      throw: { code: SIGN_UP_REFUSED, message: !interpolate "refused ${{ inputs.email }}" }
---
kind: Telo.Sequence
metadata: { name: test }
steps:
  - name: attempt
    try:
      - name: signUp
        invoke: !ref Iam.createUser
        inputs: { email: "grace@hopper.dev" }
    catch:
      - name: caught
        value: !cel "{'code': error.code, 'data': error.data}"
  - name: assertWrapped
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.caught.result"
      expected:
        code: ERR_DOMAIN_EVENT_HANDLER_FAILED
        data: { event: UserCreated, handler: refuseSignUp }
  - name: readUsers
    invoke: { kind: Sql.Query, connection: !ref db }
    inputs: { sql: "SELECT id FROM users" }
  - name: assertRolledBack
    invoke: { kind: Assert.Equals }
    inputs: { actual: !cel "steps.readUsers.result.rows", expected: [] }
```

### Refused: an emit outside the transaction, and a handler in a scope

An application that re-announces a user from a boot target, and tests a handler declared inside a sequence's `with:`. It is a `telo check` illustration of both diagnostics; `tests/check-run-agreement.yaml` pins each in a fixture of its own.

```yaml
# refused/telo.yaml
kind: Telo.Application
metadata: { name: ReannounceUsers, version: 0.1.0 }
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@0.13.0
  QueueSql: oci://ghcr.io/telorun/queue-sql@0.2.0
  QueueSqlite: oci://ghcr.io/telorun/queue-sqlite@0.2.0
  Domain: oci://ghcr.io/telorun/domain-events@0.1.0
  Iam:
    source: ../iam
    resources: { connection: !ref db }
targets:
  - !ref appSchema
  - invoke: !ref reannounceUser
    inputs: { userId: "u-1", email: "ada@lovelace.dev" }
  - !ref signUpTest
---
kind: SQLite.Connection
metadata: { name: db }
file: ":memory:"
---
kind: QueueSqlite.Table
metadata: { name: messages }
table: queue_messages
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref messages]
---
kind: Domain.Handler
metadata: { name: queueWelcomeEmail }
event: !ref Iam.UserCreated
invoke:
  kind: QueueSql.Enqueue
  queue:
    kind: QueueSqlite.Queue
    connection: !ref db
    schema: !ref appSchema
    table: !ref messages
    name: welcome-emails
    retention: 168h
    messageType:
      kind: Telo.JsonSchema
      schema:
        type: object
        required: [email]
        properties:
          email: { type: string }
inputs:
  id: !interpolate "welcome-${{ event.userId }}"
  message: { email: !cel "event.email" }
---
kind: Domain.Emit
metadata: { name: reannounceUser }
event: !ref Iam.UserCreated
---
kind: Telo.Sequence
metadata: { name: signUpTest }
with:
  - kind: Domain.Handler
    metadata: { name: captureUserCreated }
    event: !ref Iam.UserCreated
    invoke: { kind: Telo.Sequence, steps: [] }
steps:
  - name: signUp
    invoke: !ref Iam.createUser
    inputs: { email: "grace@hopper.dev" }
```

```
$ telo check refused/telo.yaml
error  QueueSql.Enqueue at queueWelcomeEmail.invoke requires a SQL.Transaction zone on
       SQLite.Connection 'db', and the path
       queueWelcomeEmail.invoke → queueWelcomeEmail → reannounceUser → targets[1] is an
       Application's targets: entry — nothing encloses boot.  ZONE_REQUIREMENT_UNSATISFIED
error  Domain.Handler 'captureUserCreated' handles Iam.UserCreated but is declared in the
       `with:` scope of 'signUpTest', so it exists only while that sequence runs and no
       emit can reach it; declare it at module scope.  CO_REFERRER_SCOPED
```
