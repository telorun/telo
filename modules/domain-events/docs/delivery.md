# Delivery

Delivery is synchronous, inside the emitter's invocation. `Domain.Emit` asks the kernel for the handlers of its event at each call and runs them one at a time through the ordinary dispatch path, so each handler has its own span under the emit's, and the caller's zones and cancellation apply to it.

## The transaction

Every zone open at the emit is open in each handler. A handler's statement on the emitter's connection that names no `transaction:` joins the open transaction and commits or rolls back with it; the library exports no transaction for this. A handler that fails fails the emit, so the transaction rolls back and the user row the library wrote is gone:

1. the library writes its row;
2. it emits `UserCreated`;
3. the application's audit handler writes its row on the same connection;
4. all three commit together, or none does.

A handler suspending inside a `noSuspend` zone (a durable wait inside a transaction) is refused by `telo check`, as anywhere else.

## Order

Handlers run in application load order: the root, then its imports depth-first in `imports:` order (a `shared` library at its first reach), and within a module instance in the order its documents are read. The order is fixed per application and is the same for every emit of an event. Handlers must not depend on each other's order; handlers that must run in sequence belong in one handler invoking a `Telo.Sequence`.

## A library imported in a scope

A `Telo.Import` declared in a `with:` scope gives each run of that scope an instance of its library of its own. The library's handlers of its own events run for the emits that instance makes during the run, and for no other run's; once the run ends they are gone, and an emit still asking for them is cancelled.

Such an instance lives one scope run, so its handlers can only handle events that live as long. A handler there of a `shared` library's event — or of any event the application holds for its whole life — would never be reached by that event's emits, so `telo check` refuses it (`CO_REFERRER_SCOPED`) and so does the run. Declare such a handler in a module that lives as long as the event's library: the application itself, or a library it imports through `imports:`.

## Failure

A handler failure leaves the emit as `ERR_DOMAIN_EVENT_HANDLER_FAILED` with `data: { event, handler }` (the event's and the handler's names) and the original failure as `cause`; when the handler's failure carries a display message, the emit's error keeps it. Handlers after the failing one do not run. That code is the emit's whole `throws:` list, so a handler's own codes never enter a library's throws union or its `catches:` coverage: a library may catch `ERR_DOMAIN_EVENT_HANDLER_FAILED` around its emit whatever code an importer's handler throws. Cancellation and `ERR_DURABLE_SUSPENDED` are signals, not errors, and pass through unchanged.

## Consequences

- **A handler holds the emitter's transaction open while it runs.** External I/O (sending an email, calling an API) goes through the outbox — see [work after commit](after-commit.md) — never inside a handler.
- **A handler whose target requires a zone holds every emit of its event to it**, a test invoking `Domain.Emit` directly included. `telo check` reports an emit outside the zone as `ZONE_REQUIREMENT_UNSATISFIED`, naming the path through the emit. Such a test wraps the emit in a `Sql.Transaction`.
- **A handler that must be atomic with the emitter uses a target that requires the transaction**, as `QueueSql.Enqueue` does. A plain `Sql.Command` joins a transaction when one is open and is not checked.

## What `telo check` sees

The emit's event slot declares that dispatching it reaches the handlers of the same event, so the call graph has the path emit, handler, target. A library's handlers are checked at its own `telo check`, against the emits it and its imports make, and again at every importer's, against every emit of the application; a finding is reported once, where its reader can fix it.
