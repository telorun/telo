---
description: "Ask whoever runs a module for what it depends on — a database, a signing key — as a typed need, supplied at the import, whole or field by field, or read from the environment at the root."
---

# Declaring a need

A library often depends on something it cannot create itself: the address and
credentials of a database, a key to sign sessions with. Written as `variables:`
and `secrets:`, every application importing the library has to redeclare and
forward them, and nothing says what the values *are*. A **need** says it once,
typed by a **need type**, and is supplied by whoever imports the library.

```yaml
kind: Telo.Library
metadata: { name: Orders }
imports:
  Fx: ../need-types
needs:
  databaseAccess:
    kind: Fx.DatabaseAccess
    version: ">=15.0.0"
    features: [pgvector]
    parameters: { size: 10Gi }
  cache:
    kind: Fx.DatabaseAccess
    optional: true
```

- `kind:` names a need type — a kind declared by a `Telo.NeedType` document,
  written alias-qualified like any other kind (`<Alias>.<Kind>`, or `Self.<Kind>`
  for one the library declares itself). See [Writing a need type](/extend/need-types).
- `version:` is a range in explicit comparators (`>=15.0.0`, `>=15.0.0 <16.0.0`;
  the `requires:` grammar, so no `^`, `~`, `||` or bare version), legal only when the need type is versioned; `features:` asks for
  names the type lists. Anything else is `NEED_PARAMETERS_INVALID`.
- `parameters:` are literals the need type admits, checked against its
  `parameters` schema (`NEED_PARAMETERS_INVALID`).
- `optional: true` means the library runs without one.

## Reading a need

Inside the library a need is a declaration like any other resource, in the
module's one namespace (`DUPLICATE_RESOURCE_NAME`). Its fields are read in CEL:

```yaml
kind: Run.Value
metadata: { name: describe }
value:
  url: !cel "resources.databaseAccess.url"
  cache: !cel "resources.cache == null ? 'none' : resources.cache.url"
```

`resources.<need>` is typed from the need type's fields and closed, so a field
the type does not declare is `CEL_UNKNOWN_FIELD`. An optional need is nullable,
and reading one unguarded is `CEL_NULLABLE_ACCESS`. A need is never handed to a
controller as an instance (`ctx.resolveRef` on one is `ERR_REF_UNRESOLVED`): it is
read by field, or taken whole at a reference slot of a kind that consumes it,
whose controller opens it with `ctx.resolveNeed` — see
[A kind that consumes and verifies a need](/extend/consuming-needs). An optional
need may be absent, so a `!ref` to one at any kind's reference slot is
`NEED_OPTIONAL_REFERENCED` — except inside the branch of an `!if` that proves it
present.

## Choosing by whether a need is supplied

An optional need's presence can decide a choice: `!cel "resources.<need> != null"`
(or `== null`) in an `!if` condition is a dimension of the configurations the
application is checked in, `present` or `absent`. Inside the branch that proves it
present the need is non-null — its fields read with no guard, and a `!ref` to it is
legal:

```yaml
--- !if
metadata: { name: store }
if: !cel "resources.databaseAccess != null"
then:
  kind: Postgres.Connection
  access: !ref databaseAccess
else:
  kind: SQLite.Connection
  file: !cel "resources.data.path.joinPath('app.db')"
```

A member a need type's field binds to a closed argument is a dimension too:
`!cel "resources.databaseAccess.url.scheme"` where the field's `Telo.Url` declares
`scheme: { enum: [...] }`. Any other member (`…url.host`) is decided only at boot,
so a condition reading it is `BRANCH_UNDECIDABLE`.

The dimension is keyed by the need's path whoever reads it: `resources.databaseAccess`
for a module's own need, `resources.Orders.databaseAccess` in an application
importing the library as `Orders` and leaving the need to its environment — the
key `telo check`'s labels (`(when resources.Orders.databaseAccess is absent)`),
`Kernel.Starting` and the needs report use. An import supplying the need — a
fulfilment, or field by field — makes it present in every configuration; one
forwarding an optional need of the application whole makes it that need's
dimension. The kernel reads the need from the environment before it expands the
documents, so a partial supply is `ERR_NEED_PARTIALLY_SUPPLIED` before anything
exists.

What the choice leaves out is not needed. In the example, `data` is read only in
the `else:` branch, so it is **required only where `databaseAccess` is absent**:
with `DATABASE_URL` set the application starts without it, and with neither set
it is `ERR_NEED_UNMET` naming only `data`'s variable. A need that is not optional
is required in exactly the configurations its fields' reads, its `!ref`s or an
import forwarding it reach — a library's need where the library's own documents
reach it, through every import between it and the application — and one no
configuration reaches is never required. `telo needs report` gives each need's
`requiredWhen` (`[{ "resources.databaseAccess": "absent" }]`) with the
`dimensions` it is keyed by, and `telo run <app> --help` says `required when
DATABASE_URL is unset`.

## Constraints are verified, never just stated

A `version:` or `features:` is a claim about the real thing, so it must reach a
reference slot that **observes** it: through the module's own resources that take
the need whole at such a slot (an entry of a templated kind's `resources:` body
included), or through every need it is forwarded to whole at
an import, recursively. A kind observing a constraint reports what it found and
the kernel compares (`ERR_NEED_UNMET`, naming where the value came from and the
required against the actual). A constraint nothing observes is
`NEED_CONSTRAINT_UNVERIFIED` at its key, and refused by the kernel at load. A
pure provisioning request — a size, a region — belongs in `parameters:`, which
nothing has to observe.

A field the need type marks `x-telo-sensitive` is redacted — printed as
`[redacted]` — in the logs of the importer that supplied it and of every library
it reaches, as a `secrets:` value is. So is a `Telo.Url` field's password, and
the URL's whole text when it holds one; its host is not.

## Supplying a need at the import

The importer supplies a library's needs in the object form of its `imports:`
entry, in one of two forms.

**Field by field** — a map of the need type's fields, each a literal or an
expression over the importer's own scope, evaluated once when the import is
created:

```yaml
imports:
  Orders:
    source: ./orders
    needs:
      databaseAccess:
        url: !interpolate "postgres://${{ variables.dbHost }}:5432/orders"
```

Every field the type requires must be there (`NEED_SLOT_MISMATCH`) and no other
(`NEED_FIELD_UNDECLARED`); a literal of the wrong type is `SCHEMA_VIOLATION`, an
expression of the wrong type `CEL_TYPE_ERROR`.

**Whole** — a `!ref` to a need, or to a fulfilment, of the importer:

```yaml
kind: Telo.Library
metadata: { name: Shop }
imports:
  Fx: ../need-types
  Orders:
    source: ./orders
    needs:
      databaseAccess: !ref orderDatabase
needs:
  orderDatabase:
    kind: Fx.DatabaseAccess
```

The referenced need or fulfilment must be of the same need type
(`REFERENCE_KIND_MISMATCH`). An optional need cannot be forwarded to a required
one, since it may be absent (`NEED_FORWARD_INCOMPATIBLE`), and a need forwarded
whole must state at least what the need it supplies does: a version range within
the target's (`>=16.0.0` into `>=15.0.0`), and every feature it asks for
(`NEED_FORWARD_INCOMPATIBLE`). The narrower range is the one enforced: the kernel
compares an observation against the outermost need of the whole-forward chain. A
key the library does not declare is `NEED_UNDECLARED`.

## Writing the fulfilment yourself

A resource of the need-type kind is a **fulfilment** the module writes itself,
with `fields:`:

```yaml
kind: Fx.DatabaseAccess
metadata: { name: archiveDatabase }
fields:
  url: !cel "'postgres://archive.internal:5432/' + variables.archiveName"
```

Each field is a literal or a startup expression, like any other provider's
field. It is read the same way a need is (`resources.archiveDatabase.url`) and
supplies a need whole (`databaseAccess: !ref archiveDatabase`). It cannot be a
boot target — nothing starts it.

## What nobody supplies

A need nobody supplies bubbles up the import tree. Its **need path** is its name
beneath each importer's alias: `Orders.databaseAccess`, or
`Wrapper.Orders.databaseAccess` for a library imported by a library. A need that
reaches the root unsupplied is read from the environment when the application
loads, before any resource initializes — one environment variable per field,
named after its path: `TELO_NEED_ORDERS__DATABASE_ACCESS__URL` for the `url`
field of `Orders.databaseAccess`. A required need with none of its variables set
is refused with `ERR_NEED_UNMET`, naming the path, the need type, the declaring
module and every variable to set — when the configuration the application starts
in needs it (above). An optional one, and one that configuration does not need,
reads `null`.

The name rule, precedence and the rest of the environment door are in
[Providing needs](/learn/providing-needs).

## An application's own needs

An application declares needs as a library does. Nothing imports an
application, so each of its needs is read from the environment — and it alone
may choose the variable a field is read from, with `env:`:

```yaml
kind: Telo.Application
metadata: { name: Shop }
imports:
  Fx: ../need-types
  Orders:
    source: ./orders
    needs:
      databaseAccess: !ref databaseAccess
needs:
  databaseAccess:
    kind: Fx.DatabaseAccess
    env: { url: DATABASE_URL }
```

`databaseAccess` is read from `DATABASE_URL` instead of its derived name
`TELO_NEED_DATABASE_ACCESS__URL`, and handed to `Orders` whole, so
`TELO_NEED_ORDERS__DATABASE_ACCESS__URL` is no longer read at all. This is how a
library's need gets a name the operator chooses: the application declares a need
of its own with `env:` and forwards it at the import.

- `env:` names fields of the need type only (`NEED_FIELD_UNDECLARED`), and once
  written binds every required field (`NEED_SLOT_MISMATCH`); a field it leaves
  out keeps its derived name.
- A library's need cannot bind a name (`LIBRARY_ENV_KEY_REJECTED`): only the
  application being run reads the environment.

## Public addresses

The addresses an application is reached at are needs too, of the
kernel-declared types `Telo.PublicUrl` (one address) and
`Telo.PublicHostPattern` (a family of tenant hosts), written with no import:

```yaml
ports:
  http: { env: PORT, default: 8080 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  tenants:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
```

They are supplied only through the root: the application declares its own,
naming a `tcp` port, and forwards it whole to a library, which declares the
type with no parameters. A fulfilment written in the manifest, a field-by-field
supply and a library's address need left unforwarded are
`NEED_ROOT_SUPPLY_REQUIRED` — a domain name never appears in a manifest. An
`Http.Server` mount names the needs it answers in `hostnames`. The parameters
are in [Writing a need type](/extend/need-types#kernel-declared-address-types);
how a host supplies the addresses — or lets the kernel derive them from its
templates — in [Providing needs](/learn/providing-needs#public-addresses).

## Persistent storage

Files that must survive restarts and redeployments go in a directory the
application asks for as a need of the kernel-declared type
`Telo.DurableDirectory`, written with no import:

```yaml
needs:
  data:
    kind: Telo.DurableDirectory
    parameters: { size: 5Gi, access: single-writer }
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "resources.data.path.joinPath('app.db')"
```

`size` is the least the application needs (default `1Gi`) and `access` is
`single-writer` (default — at most one running instance has the directory) or
`shared`. The directory is the host's to provide, so no path to it is written
in the manifest; under `telo run` set `TELO_NEED_DATA__PATH`, or
`TELO_HOST_STATE_DIR` once for every need. A library declares its own and the
application may forward one whole, as long as it gives at least what the
library asks for. What each parameter promises and how a host supplies the
directory are in
[Providing needs](/learn/providing-needs#durable-directories).

## One fulfilment per module instance

Each import of an `isolated` library (the default) is a module instance of its
own, so two imports of one library each have their own fulfilments. A
`lifecycle: shared` library is one instance for the whole application: its needs
sit beneath its own name directly under the root (`Sessions.signingKey`),
whichever aliases reach it, and every import must supply them identically, or
not at all (`SHARED_LIBRARY_CONFLICT` / `ERR_SHARED_LIBRARY_CONFLICT`).

## A defect in an imported library

`telo check` builds every imported library whole, so a need-table defect inside
one — a constraint nothing verifies, a type that does not resolve — is reported
in the importer's check too, once, at the `imports:` entry through which the
library is reached. The repair is the library's; the kernel refuses the
application at load all the same.

## A need is not a resource input

A library's `resources:` entry is a live instance its importer must hand over —
a connection pool, a store. A need is a value any level up the import tree may
supply. A `resources:` entry constrained to a need type is
`RESOURCE_INPUT_NEED_TYPE`: declare it under `needs:`.

## See also

- [Providing needs](/learn/providing-needs)
- [Writing a need type](/extend/need-types)
- [A kind that consumes and verifies a need](/extend/consuming-needs)
- [Sharing resources across libraries](/extend/library-resource-inputs)
- [Diagnostics reference — needs](/reference/diagnostics#needs)
