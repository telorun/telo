# domain-events

Business events a library announces and its importers react to, inside the announcing call and its transaction. A library declares an event as a typed payload and emits it, knowing nothing of who reacts; the application adds the reactions (an audit row, a welcome email, a counter) without forking the library.

Import it as `Domain`:

```yaml
imports:
  Domain: oci://ghcr.io/telorun/domain-events@<version>
```

## Kinds

- **`Domain.Event`** declares one event as the JSON Schema of its payload. It is written exactly like a `Telo.JsonSchema` (`schema:`), works anywhere a type does (`inputType: !ref UserCreated`) and adds no field. Only an event is accepted by an emit or a handler; a plain `Telo.JsonSchema` is `REFERENCE_KIND_MISMATCH`. An event is private to its module unless the library lists it in `exports.resources`; an importer writes `!ref Iam.UserCreated`.
- **`Domain.Emit`** `{ event }` announces the event. Its inputs are the payload, held to the event's schema (a literal mismatch is refused by `telo check`, a computed one fails at run with `ERR_INPUT_INVALID`). It runs every handler of the event one at a time, inside its own call, and returns `{}`.
- **`Domain.Handler`** `{ event, when?, invoke, inputs? }` reacts to one event. Declare it at module scope as a named top-level document (not in a `with:` scope, and in no `targets:`).
  - `when` is a runtime boolean over `event`; false returns without calling the target.
  - `inputs` is evaluated over `event` and checked against the target's `inputType`. Omitted, the target is invoked with `{}`; `inputs: !cel "event"` forwards the payload whole.
  - The target's result is discarded.

## Example

```yaml
# iam/telo.yaml
kind: Telo.Library
metadata: { name: Iam, version: 0.1.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@<version>
  Domain: oci://ghcr.io/telorun/domain-events@<version>
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

```yaml
# the application
kind: Domain.Handler
metadata: { name: auditUserCreated }
event: !ref Iam.UserCreated
invoke: { kind: Sql.Command, connection: !ref db }
inputs:
  sql: "INSERT INTO audit_log (action, subject) VALUES ('user.created', ?)"
  bindings: [!cel "event.userId"]
```

## Guarantees

- Handlers run synchronously in the emitter's invocation, in the emitter's zones — see [delivery](docs/delivery.md).
- Order: the application's load order, fixed per application — the root, then its imports depth-first in `imports:` order (a `shared` library at its first reach), and within a module instance its documents in the order they are read.
- A handler failure fails the emit as `ERR_DOMAIN_EVENT_HANDLER_FAILED` (`data: { event, handler }`, the handler's failure as `cause`), which is the emit's whole `throws:` list. Cancellation and `ERR_DURABLE_SUSPENDED` pass through unchanged.
- An event is matched as declared in the module instance its reference reaches: a library imported twice as `isolated` has two events, a `shared` one has one.

More: [delivery, the transaction and failure](docs/delivery.md), [handling a library's events](docs/handling-from-a-library.md), [work after commit](docs/after-commit.md).
