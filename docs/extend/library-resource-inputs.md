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

A supplied variable or secret — and the library's own `default:`, standing in for
one the import leaves out — is read against the entry the library declares, for
every value type: text in a type's encoding is decoded (an RFC 3339 string at a
`Telo.Timestamp` entry is a timestamp inside the library, a URL's text a `Telo.Url`),
then the value is validated. A literal the entry refuses is `SCHEMA_VIOLATION` at the
import that wrote it (`URL_INVALID` for a URL, `HOST_PATH_RELATIVE` for a relative
host path), an expression of the wrong type `CEL_TYPE_ERROR`, and the kernel refuses
the same supply when the import initializes, naming the import and the variable and
never the value.

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

## An optional input, and the library's own default

An entry may declare `optional: true` — the key a `needs:` entry carries — when
the library can do without the instance, offering a default of its own. There is
no `default:` key: the default is a declaration of the library's, written under a
name of its own and declared only where the input is absent.

```yaml
kind: Telo.Library
metadata: { name: Notes }
imports:
  Kv: oci://ghcr.io/telorun/kv-store@<version>
  KvMemory: oci://ghcr.io/telorun/kv-store-memory@<version>
resources:
  store:
    kind: Kv.Store
    optional: true
--- !if
metadata: { name: memoryStore }
if: !cel "resources.store == null"
then:
  kind: KvMemory.Store
---
kind: Self.Notebook
metadata: { name: notebook }
store: !if
  if: !cel "resources.store != null"
  then: !ref store
  else: !ref memoryStore
```

- **Inside the library `resources.store` is nullable**, so an unguarded read is
  `CEL_NULLABLE_ACCESS`; inside a branch proving it present it is not.
- **`!ref store` is legal only in a branch proving it present.** Anywhere else it
  is `RESOURCE_INPUT_OPTIONAL_REFERENCED` — a reference slot holds its instance
  for the resource's whole life, and an omitted input has none. Forwarding it to
  another import's `resources:` is refused the same way. The use site chooses with
  a field-value `!if` whose `then:` is the input and `else:` the default, or with
  the default written inline in `else:` when nothing else uses it.
- **Its presence is a dimension of the library's own check** — read only as a
  bare `resources.store != null` / `== null`, keyed `resources.store` — so
  `telo check` on the library checks both configurations and labels what one of
  them finds: a typo in the default is reported `(when resources.store is
  absent)`.
- **Presence per import is a literal fact.** An import supplies the input or it
  does not, and neither an import nor a `!ref` can be chosen, so an importer's own
  check enumerates nothing for it and prints no label. A library whose `!ref
  store` sits outside a proving branch is refused at the `imports:` entry of every
  importer omitting the input, and the kernel's import controller refuses the
  same import (`ERR_RESOURCE_INPUT_OPTIONAL_REFERENCED`). The import controller
  expands the library's documents with that import's facts before registering any
  of its resources, so the default is never created where the input is supplied.
  A need the default alone reads is required only by the imports that omit the
  input.

**Two names, two ownerships.** The input is always borrowed and never torn down
by the library's context; the default is always owned — by the import's child
context, or by the root-spawned context of a `lifecycle: shared` library — and
exists only where the input is absent.

A non-optional entry stays required at every import.

## A collector lists its members

A member that must be registered with a collector — a `Sql.Schema`'s tables, a
server's mounts, `logging.sinks` — is never a fallback. Membership is declared
only by the collector, by reference, in the module declaring the collector. A
module offering such a member exports it as a ready-made instance the
collector's owner lists (`tables: [!ref Accounts.users]`), and does not borrow
that same collector: a library taking the schema as an input and exporting a
table the schema lists cannot initialize. The import initializes after the schema
it is handed, and the table it exports exists only once it has — so `telo check`
reports the loop as `DEPENDENCY_CYCLE` at the import, and the kernel refuses it
as `ERR_CIRCULAR_DEPENDENCY` before the resources involved initialize. Move the
members into a leaf module that borrows nothing.

That is what makes **a reference through an import alias a hard init-order
edge** to the import: a resource's own `!ref <Alias>.<name>`, or a startup read
of `resources.<Alias>.<name>`, orders it after that import. A kind spelled
through the alias stays a soft, creation-order edge, and a step's reference is
dispatched only once everything has initialized, so a sequence handed to a
library may call the library's exports from its steps.

The graph stores are the case in point: their bookkeeping tables (`layers`,
`drafts`, the revisions strategy's tables) are members of the application's
schema, shared by a layer and its bases, so the schema's owner declares them and
a store's bookkeeping slots stay required — a store wrapper declaring a default
of its own would hand the schema a table it does not list.

An export declared only in some configurations is legal; a reference where it
does not exist is the ordinary unresolved reference, labelled with its
configuration.

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
| `RESOURCE_INPUT_MISSING` | the import | a declared entry not `optional: true` was not supplied — the same failure as a missing required variable |
| `RESOURCE_INPUT_OPTIONAL_REFERENCED` | the `!ref`, labelled with the configuration the input is absent in; at an omitting importer's `imports:` entry | an optional input referenced outside a branch proving it present |
| `RESOURCE_INPUT_UNKNOWN` | the import | an entry the target library does not declare |
| `RESOURCE_INPUT_UNRESOLVED` | the import | the value is not a `!ref` to a resource this module declares |
| `RESOURCE_INPUT_KIND_MISMATCH` | the import | the supplied resource's kind does not satisfy the declared constraint, transitively |
| `RESOURCE_INPUT_EXPORTED` | the library | an input name also listed in `exports.resources` — an input is borrowed, so there is nothing to export |
| `RESOURCE_INPUT_NEED_TYPE` | the library | the entry's kind is a need type — a value any level up the import tree may supply is a [need](/learn/declaring-a-need), declared under `needs:` |

Init order falls out on its own: the import gains a dependency edge per injected
target — to a local resource, or to the import that exports a cross-module one —
and a resource referencing an export gains one to the import exporting it, so a
cycle through an import is caught by the graph that already catches cycles
(`DEPENDENCY_CYCLE`, reported at the import). An import whose target is
registered but not yet initialized defers with `ERR_LOCAL_REF_PENDING` and is
retried.

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
configuration, so two imports supplying different variables, secrets, resource
instances or [needs](/learn/declaring-a-need) is a conflict, naming both aliases
and the key that differs — never the value of a secret or a need. Two values are the
same when they are equal as the import builds them, so two spellings of one URL or
one instant agree. Reported as `SHARED_LIBRARY_CONFLICT` at `telo check` wherever
it is decidable there (literal values; references only within one module, since a
name means the same instance only in one scope; and in every module, one import
supplying an optional input another omits — a singleton has one configuration),
and as
`ERR_SHARED_LIBRARY_CONFLICT` at boot, which holds the resolved values and the
live instances and is authoritative. And a per-import `logging:` or `runtime:`
override is refused (`SHARED_LIBRARY_OVERRIDE`, statically): both scope a subtree
that is no longer one import's subtree.

A second import of a singleton costs no fetch, no parse and no analysis pass —
the registry is keyed on the resolved module URL, and only a shared library is
ever in it.

## Declaring a floor

`resources:` and `lifecycle:` on a library are syntax that did not exist before
telo 0.83, and `optional:` on a `resources:` entry before the release carrying
choices and configurations. A module using any of them is unreadable to every
older runtime, which would reject it with a `SCHEMA_VIOLATION` on the library's
own line. Declare the floor so the failure names the cause instead:

```yaml
requires:
  telo: ">=0.83.0"   # or the release carrying `optional:`, for a module using it
```
