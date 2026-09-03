---
sidebar_label: Sharing Across Libraries
slug: /extend/library-resource-inputs
description: "Hand one instance down to several libraries with a resources: block, or let several libraries reach one shared library with lifecycle: shared — so two libraries over one database connection see one connection, not two."
---

# Sharing resources across libraries

A library declares three kinds of input. Two are scalar and long-standing —
`variables:` and `secrets:`. The third is `resources:`: the **instances** the
library requires from whoever imports it.

```yaml
kind: Telo.Library
metadata: { name: HubSearch }
imports:
  Sql: oci://ghcr.io/telorun/sql@<version>
resources:
  connection:
    kind: Sql.Connection
    description: The database this library reads from.
variables:
  minScore: { type: number, default: 0.3 }
exports:
  resources: [searchResources]
```

The importer supplies them at the import's object form:

```yaml
imports:
  Search:
    source: ./hub-search.yaml
    resources: { connection: !ref db }
    variables: { minScore: !cel "variables.vectorMinScore" }
```

## What it is for

Instances used to flow **up** and never **down**. `exports.resources` hands an
instance to an importer; nothing handed one the other way. Each import
declaration also builds its own child module context with its own instances, so
two libraries importing a third get **two of everything in it** — measured: an
application importing two libraries that each import one library owning a SQLite
connection fails with `no such table`, because the writer and the reader are on
different connections.

Without this block, any set of libraries that must share a resource has to be
linearized into a total order, every layer re-exporting the union of everything
beneath it — which gives away the self-containment a split is for.

It is a correctness constraint, not a preference: `durable-journal-postgres`
attests exactly-once only when the journal writes on the same connection as the
work it records, and a second pool silently degrades every region to
at-least-once.

## Inside the library, an input is an ordinary name

`!ref connection` at a reference slot and `resources.connection.<field>` in CEL
answer exactly as they do for a locally declared resource. The analyzer stands a
**kind-only declaration** behind each entry in the library's own scope, which is
what makes that true: a library's internals are validated in the library's own
pass — a consumer's flattened analysis drops the library doc — so with nothing
behind `connection` there would be nothing for `!ref connection` to resolve
against.

Kind-only is enough because it is already what a reference slot gets: a reading
types its `status:` half from the kind, closed so a typo below it is
`CEL_UNKNOWN_FIELD`, and leaves the flat half open, since no manifest declares
what `snapshot()` returned.

## An entry is constrained by kind, and by nothing else

There is no `use:` here. The boundary is a dependency edge for init order
whatever the library does with the instance, so the token would carry nothing the
edge model reads — and, since the flattened application analysis drops the
library doc, it would be the only app-level statement about how a handed-down
instance is reached, and an unchecked one.

Detach and zone-attribute checks run in the library's own pass, where the call
site is. A zone requirement reaching an injected input cannot be discharged there
and defers to the injection site, which is the existing
`ZONE_REQUIREMENT_DEFERRED` vocabulary rather than a new rule.

Two checks are declaration-derived and cannot answer inside the library, so they
move to the injection site, where the real declaration is:
`x-telo-schema-projection-from` (which projects one instance's own entries) and
`OBSERVED_STATE_NEVER_RUN` (which a library cannot answer about a resource it
does not declare).

## Borrowed, not owned

An injected resource's effect frame belongs to the scope that **declared** it.
The child context never includes it in its own teardown — otherwise a library's
teardown would close the application's connection out from under everything else
still using it.

Its published reading is mirrored into the library's `resources` scope, so
`resources.connection.status.<field>` inside the library reads the same value the
owner publishes, at the moment the owner publishes it.

## Diagnostics

| Code | Where | Meaning |
| --- | --- | --- |
| `RESOURCE_INPUT_KIND_UNRESOLVED` | the library | the entry's `kind:` resolves to nothing in the declaring scope, so it accepts anything |
| `RESOURCE_INPUT_MISSING` | the import | a declared entry was not supplied — the same failure as a missing required variable |
| `RESOURCE_INPUT_UNKNOWN` | the import | an entry the target library does not declare |
| `RESOURCE_INPUT_UNRESOLVED` | the import | the value is not a `!ref` to a resource this module declares |
| `RESOURCE_INPUT_KIND_MISMATCH` | the import | the supplied resource's kind does not satisfy the declared constraint, transitively |
| `RESOURCE_INPUT_EXPORTED` | the library | an input name also listed in `exports.resources` — an input is borrowed, so there is nothing to export |

Init order falls out on its own: the import gains a dependency edge per injected
target — to a local resource, or to the import that exports a cross-module one —
so a cycle among those is caught by the graph that already catches cycles. Only
that direction is modelled: nothing connects a forwarded export back to the
import that owns it, so a cycle closing through an imported instance still
surfaces as an init-loop failure rather than as a reported cycle. Either way an
import whose target is registered but not yet initialized defers with
`ERR_LOCAL_REF_PENDING` and is retried.

## Library singletons

`resources:` hands one instance down to several libraries. The other half of the
same problem is a library that *owns* an instance several libraries need. By
default each import declaration builds its own child scope with its own
instances, so two libraries importing a third get two of everything in it —
which for a library owning a connection means two connections.

`lifecycle:` on a `Telo.Library` names the choice:

```yaml
kind: Telo.Library
metadata: { name: SharedStore }
lifecycle: shared      # `isolated` is the default
```

- **`isolated`** (default) — one instantiation per import declaration. Right for
  a library whose instances are the importer's: a client configured per consumer,
  a codec, a formatter.
- **`shared`** — one instantiation for the whole application. Every import of it,
  at any depth, resolves to the same child scope and the same instances.

The default is `isolated` because it is what every published module was written
against; flipping it would silently collapse existing resource graphs and turn
per-import `variables:` into a conflict.

**The root owns a singleton; every import borrows it.** Its child scope is
spawned under the root rather than under whichever import reached it first —
otherwise tearing that importer down would close a library two others still hold,
and which importer that is depends on init order. It is torn down after every
other root child, so a borrower's own inverses still find it alive.

**Every import of a singleton must agree.** One instantiation has one
configuration, so two imports supplying different variables, secrets or resource
instances is a conflict, naming both aliases and the key that differs — never the
value of a secret. Reported as `SHARED_LIBRARY_CONFLICT` at `telo check` wherever
it is decidable there (literal values; references only within one module, since a
name means the same instance only in one scope), and as
`ERR_SHARED_LIBRARY_CONFLICT` at boot, which holds the resolved values and the
live instances and is authoritative. And a per-import `logging:` or `runtime:`
override is refused (`SHARED_LIBRARY_OVERRIDE`, statically): both scope a subtree
that is no longer one import's subtree.

A second import of a singleton costs no fetch, no parse and no analysis pass —
the registry is keyed on the resolved module URL, and only a shared library is
ever in it.

## Declaring a floor

`resources:` and `lifecycle:` on a library are syntax that did not exist before
telo 0.83. A module using either is unreadable to every older runtime, which
would reject it with a `SCHEMA_VIOLATION` on the library's own line. Declare the
floor so the failure names the cause instead:

```yaml
requires:
  telo: ">=0.83.0"
```
