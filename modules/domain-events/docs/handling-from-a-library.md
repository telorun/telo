# Handling a library's events

A library announces an event; its importer reacts with a `Domain.Handler` declared in the importer's own module.

```yaml
imports:
  Domain: oci://ghcr.io/telorun/domain-events@<version>
  Iam:
    source: ./iam
    resources: { connection: !ref db }
---
kind: Domain.Handler
metadata: { name: auditUserCreated }
event: !ref Iam.UserCreated
when: !cel "!event.email.endsWith('@example.com')"
invoke: { kind: Sql.Command, connection: !ref db }
inputs:
  sql: "INSERT INTO audit_log (action, subject) VALUES ('user.created', ?)"
  bindings: [!cel "event.userId"]
```

- The library and the application each import `domain-events`; its kinds are one canonical kind each.
- `Iam.UserCreated` must be in the library's `exports.resources`; handling a non-exported event is `UNRESOLVED_REFERENCE`.
- `event` is typed from the event's schema: `event.kye` is `CEL_UNKNOWN_FIELD`, for an imported and a same-module event alike.
- `inputs` is checked against the target's `inputType`. Omitted, the target is invoked with `{}`, so a target that requires an input is `CONTRACT_INPUTS_MISMATCH`. `inputs: !cel "event"` forwards the payload whole and is checked as a whole.
- `when` is a runtime boolean over `event`; false skips the target.

## A library reacting to another library's events

A library that reacts to another library's events (an `audit` library) exports an invocable; the application wires it with a handler whose `invoke` is that invocable. A handler declared inside a library is checked at that library's own `telo check` and again at every importer's, where every emit of the application is in view.

## Identity

An event is matched as declared in the module instance the reference reaches. A library imported twice as `isolated` has two events, each needing its own handler; a `shared` one has one, and a handler on it runs for every emit reaching it.
