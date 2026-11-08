---
status: draft
priority: high
depends-on: [2026-10-29-per-invocation-scope-configuration.md, 2026-11-08-keyed-pools.md]
packages: [analyzer, kernel, sdk, ide-support, http-server, kv-store, cache, sql, postgres, sqlite, sql-repository, crud, blob, queue, vector-store, record-stream, graph, broadcast, authoring-agent, hub]
---

# Data ownership: multi-tenancy and per-user records

## Problem

1. **Nothing in a manifest says a request acts for one tenant, or for one user inside it.** A tenant's connection is built per call in a `with:` scope, or per key by a keyed pool entered on every route, each handed a key by its caller; nothing makes two keys in one request equal, so a request can write one tenant's rows and another tenant's files. Inside a tenant, a user's own records are told apart from another user's only by a column every statement must remember to filter.
2. **An owner-blind store is silent.** A module-level cache, key/value store, connection or queue used by a tenant's request serves every tenant from one partition, and every user of a tenant from one. Nothing declares that the application is multi-tenant, so `telo check` has nothing to judge it against, and the leak is a cache key that forgot the tenant.
3. **An owner id is whatever the caller sends.** A tenant or user read from a path parameter or a body field lets any caller name any owner; the authenticated organization and subject (`request.principal.org`, `request.principal.subject`) are one CEL expression away, and nothing tells the two apart.

A multi-tenant application keeps its tenants in one of two layouts, or both — a database per tenant, or shared tables with a tenant column — often with per-user records inside each tenant. The plan serves both layouts and any stack of owners (sections 1 and 4). It rests on the keyed-pools plan's machinery — one instance per key, routed by a zone — and adds no field to its kinds.

## Solution

### 1. An ownership says who data belongs to, and the dispatch that serves a request enters it

*Before:* a tenant's database connection can be built per call in a `with:` scope, or per key in a keyed pool entered by a checkout on every route, each handed a key by its caller. Nothing makes two keys in one request equal, nothing says where they come from, and nothing at all says that inside a tenant some records belong to one user.

*After:* **`Telo.Ownership`** is one layer of who data belongs to: the tenant, then — declared `within` it — the user. Each layer is a zone of its own. A router or worker lists the layers it serves and enters them in order around every handler it dispatches, each owner read from the signed-in principal; **`Telo.AsOwner`** enters one explicitly where the owner is anyone else. CEL reads each owner by the layer's own name — `tenant.id`, `user.id` and the fields of a record the layer builds once per owner — and any declaration that reads one when it is created is built once per owner, with nothing else written: a connection whose `file` reads `tenant.id` is each tenant's own connection.

**`Telo.Ownership`**
- A `Telo.Provider`. An owner is always a `Telo.OwnerKey` of its ownership (section 3).
- **Fields:**
  - `within` (optional): a `!ref` to the `Telo.Ownership` this one nests in. An inner layer is entered only inside its outer one, and its owners, records and resources are keyed by the whole chain — a user's record in one tenant is not their record in another. A `within` chain that loops is `OWNERSHIP_WITHIN_INVALID`, and `ERR_OWNERSHIP_WITHIN_INVALID` at load.
  - `references` (`confined`, the default, or `open`): whether a row of one owner may reference another owner's row in a shared table (section 4). A tenant is `confined`; a user layer in a collaborative application is `open`.
  - `shared` (section 2).
  - `recordType` (optional): the schema of what is known about an owner, written like `outputType`; an object schema declaring no `id` property (`OWNERSHIP_RECORD_TYPE_INVALID`, `ERR_OWNERSHIP_RECORD_TYPE_INVALID` at creation). Absent, the record is empty.
  - `steps` (optional): the shared step grammar, reading `key` (this layer's `Telo.OwnerKey`) and the bindings of every layer outside it, run when an owner has no record.
  - `record`: the record's fields, evaluated over the same and `steps.<name>.result` and checked against `recordType`; required exactly when `recordType` is written.
  - `perOwner` (optional): `!ref` entries naming declarations built once per owner though no field of theirs reads an owner — an in-memory store with nothing to configure.
  - `targets` (optional): `!ref` entries naming owner-bound `Telo.Runnable` declarations, run in order when an owner's resources are built — each tenant's schema migration. An entry not owner-bound to this ownership is `OWNERSHIP_TARGET_NOT_OWNER_BOUND`, and `ERR_OWNERSHIP_TARGET_NOT_OWNER_BOUND` at load.
  - `buildTimeout` (default `30s`, covering the record, the owner's resources and `targets`), `recordLifetime` (default `60s`), `idleTimeout` (default `300s`), `maxLifetime` (no default; absent means an owner's resources never age out) and `maxOwners` (default `10000`).
- **Its name is its CEL binding:** an ownership named `tenant` is read as `tenant`. A name the kernel already binds (`variables`, `secrets`, `resources`, `ports`, `module`, `self`, `inputs`, `steps`, `request`, `error`, `result`, `key`) is `OWNERSHIP_NAME_RESERVED`, and `ERR_OWNERSHIP_NAME_RESERVED` at load; a kind's own context binding of the same name shadows it, as an inner region's does.
- **The record:** built when an owner is entered and has none — before the owner's resources (below), which read it. Concurrent entries of one owner wait for one build, which runs detached from every caller under `buildTimeout` (`ERR_OWNER_BUILD_TIMEOUT`, retryable), exactly as a keyed pool's build does; a failed build caches nothing, and its codes reach whoever entered. An owner the steps refuse — a `throw` when its row is missing — therefore fails before any handler runs. A record is rebuilt at its next entry after `recordLifetime`, so a changed plan or name shows to runtime reads within that time; rebuilding it does not rebuild the owner's resources. The text values of every field `recordType` marks `x-telo-sensitive` join a redaction set held for the owner's lifetime, as a pool member's build credentials do.
- **Its zone:** each ownership provides a `Telo.Ownership` zone correlated on itself. The zone's provider is always the ownership, whoever asks for it to be opened, so opening it at a router or a worker is not one kind claiming another's zone; the execution-zones spec gains that sentence. The entry holds only identities; the ownership keeps its own map from zone entry to owner and record.

**Owner-bound declarations** — one instance per owner, derived from what a declaration reads:
- **Which they are**, computed statically from the reference graph: a module-scope declaration with a creation-time field reading an ownership's binding, one listed in its `perOwner`, and any declaration that references an owner-bound declaration in a `use: dependency` slot or reads one in a creation-time field, transitively — a `SQLite.Connection` whose `file` reads `tenant.id`, the `Sql.Query`, `Sql.Transaction` and `Sql.Schema` over it, a namespaced store whose namespace reads `tenant.id`, and a library's declarations over a `resources:` input supplied with one. The keyed-pools plan's member-bound computation, with an ownership as the key source.
- **One ownership chain:** a declaration reading the bindings of an ownership and of one `within` it is bound to the inner one, keyed by the whole chain. One bound to two ownerships of different chains, or to an ownership and a keyed pool, is `OWNER_BOUND_MULTIPLE` at the declaration, naming both and the chain that bound each — at the `imports:` entry when it reaches a library declaration — and `ERR_OWNER_BOUND_MULTIPLE` at load.
- **Built whole, per owner:** when an owner is entered and has no resources, the record is built, then every declaration owner-bound to that ownership is created, in one init loop under the build's root invocation context, then `targets` run — exactly as a keyed pool builds a member, sharing its build rules: one build per owner however many enter it at once, `buildTimeout`, a creation failure reaching whoever entered as `ERR_RESOURCE_INITIALIZATION_FAILED` with the root failure as `cause`, nothing cached on failure.
- **This is the database-per-owner layout** — a database per tenant, or per user in a local-first application. The connection is an ordinary declaration whose `file`, `database` or server reads the owner — or the owner's record, `tenant.region` choosing a host — and the `Sql.Schema` over it is in the ownership's `targets`, so each owner's database is created and migrated when the owner is first entered, before any of its requests, and again only when the application's schema changes. An owner that is never entered is never migrated; the guide says how an operator migrates every tenant ahead of a release, with `Telo.AsOwner` over each.
- **Routing:** a dispatch of an owner-bound declaration goes to its instance in the owner context of the innermost entered owner of its ownership — one context per owner and per module instance, created by the build and torn down with it. Its controller is unchanged. Inside an ownership, `resources.<name>` of an owner-bound declaration reads that owner's instance.
- **Lifetime of an owner's resources:** torn down through their inverse chains after `idleTimeout` with no hold, retired after `maxLifetime` (later entries build anew, the retired set torn down at its last hold), and bounded by `maxOwners` live owners per process — an entry of a new owner with no idle one to evict fails at once with `ERR_OWNERS_EXHAUSTED`, retryable, and otherwise the least recently used idle owner is evicted. A declaration reads the record as it was when the owner's resources were built. Owners are process-local: each replica keeps its own.
- **Not owner-bound:** a declaration in a `with:` scope is created per run, inside the zone the run was opened in, so a creation-time field of one reads that run's owner and requires the zone, and the declaration stays per run. A reach of an owner-bound declaration outside its ownership is `ZONE_REQUIREMENT_UNSATISFIED`, and `ERR_ZONE_REQUIRED` at run time, naming the ownership and the chain that bound it — a boot target, detached work, a router that does not enter it.
- **Durable execution:** an owner-bound declaration as a durable step's own target is refused at the sender with `ERR_DURABLE_TARGET_UNENCODABLE`, naming the chain that bound it, as a member-bound one is; durable work reaches it through a step whose target is a `Telo.AsOwner` taking the owner from the run's inputs.

**Entering at the dispatch: `x-telo-enters-ownership`**
- On a reference slot whose `use` includes `call` or `trigger.inbound`: dispatching through the slot runs the target inside the ownerships a list field names. The annotation's value names, relative to the object holding the slot, that field (`entries`) and optionally a binding of the slot's CEL context owners may be read from (`from`). Each entry is the shared fragment `telo://manifest#/$defs/OwnershipEntry`: `by` (a `!ref` to a `Telo.Ownership`) and exactly one of `from` (a member of the annotation's binding) or `owner` (a runtime-evaluated `Telo.OwnerKey` of `by`).
- **Order:** entries are entered in list order, outermost first; an entry whose `within` is not entered before it is `OWNERSHIP_ENTRY_ORDER`, and `ERR_OWNERSHIP_ENTRY_ORDER` at creation. An empty or absent list does nothing.
- **Where an owner comes from:** a `from` member is read off the binding the kind declares — the authenticated principal, for a router — so it is trusted by construction and needs no sealed type; it must be a string or null member of that binding's type. An `owner` field is held to its sealed type (section 3). Anything else, or a pointer naming nothing, is `ENTERS_OWNERSHIP_INVALID` at the kind and `ERR_ENTERS_OWNERSHIP_INVALID` at registration.
- **No owner:** a null owner is refused before anything is built with `ERR_OWNER_REQUIRED`, its data naming the ownership. The kind's entries field declares it in `x-telo-raises`, so it is catchable where the handler's failures are.
- The controller opens the ownerships through one SDK call naming its own slot, as `withZone` does; a slot without the annotation throws `ERR_ZONE_ANNOTATION_MISSING`. The kernel reads every entry through the annotation, so a controller never handles an owner key.
- It is the controller that dispatches which opens the zones, so no zone crosses an inbound boundary and no mount kind has to cooperate. That is why the router names the ownerships, not its mount: the mount keeps `authentication:`, and the router reads the principal it produced.
- **Adopters:**
  - `Http.Api` gains `ownership`, a list of entries read `from` `request.principal` — `[{ by: !ref tenant, from: org }, { by: !ref user, from: subject }]`. A principal with a null member, or none, is refused with `ERR_OWNER_REQUIRED`, raised into each route's `catches:` as the mount's authentication refusals are, and a 403 when nothing catches it. A route that must not be owner-scoped belongs to another router. `Auth.Principal` is unchanged.
  - `Queue.Worker` gains `ownership`, a list of entries each with an `owner` evaluated over `message`. A message type declares each owner field a `Telo.OwnerKey` of its ownership, so the site enqueuing it must supply a sealed value (section 3).

**`Telo.AsOwner`** — entering where the owner is not the signed-in principal: an operator acting for a tenant named in the URL, a job over every tenant, a second owner inside a call.
- **Fields:** `ownership` (a `!ref` to a `Telo.Ownership`) and `invoke` (a `Telo.Executable`). A `Telo.Invocable`, declared inline or at top level like a checkout.
- **Contract:** input `{ owner, inputs }` — `owner` a `Telo.OwnerKey` of `/ownership` or null, `inputs` typed from `/invoke/inputType` and defaulting to `{}`; output typed from `/invoke/outputType`. A null `owner` fails with `ERR_OWNER_REQUIRED` before anything is built. The owner is an input rather than a field because a field of a declaration sees neither its caller's step results nor its request.
- An inner ownership's `Telo.AsOwner` requires its outer one's zone, so it is reached only inside it.
- **Throws:** the target's codes, `ERR_OWNER_REQUIRED`, `ERR_OWNERS_EXHAUSTED`, `ERR_OWNER_BUILD_TIMEOUT`, `ERR_RESOURCE_INITIALIZATION_FAILED` and the build's codes. An annotated slot's kind reaches the same codes through its handler's throws.

**Owner bindings**
- Each ownership's binding is `{ id, …record }`: `id` the `Telo.OwnerKey`, beside the fields `recordType` declares, typed from it. Written into text the id is `string(tenant.id)`.
- **Where one is read:**
  - in a creation-time field of a module-scope declaration, which makes it owner-bound, it is that instance's owner, fixed for its lifetime;
  - in a creation-time field of a `with:`-scoped declaration, it is the owner of the zone the run was opened in;
  - in a runtime-evaluated field or a step body of any declaration, it is the owner of the innermost entered zone of that ownership at that dispatch.
- **Reading one is a zone requirement:** a declaration with a runtime field or step reading `tenant` requires the `tenant` ownership's zone, as a member-bound declaration does. Reached outside one, it is `ZONE_REQUIREMENT_UNSATISFIED` naming the ownership and the field that reads it, and `ERR_ZONE_REQUIRED` at run time.
- **Inside the dispatch only:** an annotated slot's ownerships cover its target's dispatch, not the dispatching kind's own fields. A route's `inputs:`, `returns:` or `catches:` reading `user` makes the router require a zone nothing opens around it, so it is refused as above; a route shows the user's name by having its handler return it.
- **Not a filter:** `tenant.id` in a `!sql` hole makes an owner column easy to write, and nothing checks that a statement uses it. Section 2 still requires the store to be partitioned or listed shared.

**Inside an ownership** — the same however it was entered:
- **Zone:** an owner-bound declaration, and one reading an owner at run time, requires that ownership's zone. A kind that only makes sense for one owner requires `Telo.Ownership` at its schema root with the existing `x-telo-requires-zone`.
- **Holding:** entering holds the owner's resources, building them first when the owner has none, before the target is dispatched. The hold is released when the entered dispatch closes, by the scope plan's held-stream rule, so a streamed reply keeps its owner's connection alive until it settles.
- **Nesting:** entering an ownership inside its own zone takes over for its own target; the innermost decides. Entering one also closes, for its target, every zone of an ownership `within` it — a user of one tenant never pairs with another tenant's data. Acting for a second owner is therefore a call someone wrote, never a key that drifted.
- **Tracing:** the entered dispatch's span carries each owner as `telo.owner.<name>` (`telo.owner.tenant`). An owner key is never sensitive.
- **Durable execution:** each owner is an input of the entered dispatch (a principal's member, a message field, `Telo.AsOwner`'s `owner`), so a replay enters the same owners.
- **Clearing:** the zone rules already shed every zone at a detached dispatch, at a Service's `run()` and at every inbound handler, so detached work, a schedule tick or a worker without `ownership` acts for no owner until it enters one itself.
- **Rust kernel:** refuses `Telo.Ownership`, `Telo.AsOwner` and a kind declaring `x-telo-enters-ownership` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

*Example — one database per tenant, the tenant taken from the signed-in organization and checked against a tenants table, reached by unchanged resources in a library. No route, handler or contract names the tenant, and nothing declares a pool:*

`orders/telo.yaml` — the library declares no owner anywhere:

```yaml
kind: Telo.Library
metadata: { name: Orders }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.30.0
resources:
  connection: { kind: Sql.Connection }
exports:
  resources: [save]
---
kind: Telo.Sequence
metadata: { name: save }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [item], properties: { item: { type: string } } }
steps:
  - name: write
    invoke:
      kind: Sql.Transaction
      connection: !ref connection
      inputs: { item: !cel "inputs.item" }
      steps:
        kind: Telo.Sequence
        inputType:
          kind: Telo.JsonSchema
          schema: { type: object, required: [item], properties: { item: { type: string } } }
        steps:
          - name: insert
            invoke: { kind: Sql.Command, connection: !ref connection }
            inputs: { sql: !sql "INSERT INTO orders (item) VALUES (${{ inputs.item }})" }
          - name: count
            invoke: { kind: Sql.Query, connection: !ref connection }
            inputs: { sql: SELECT count(*) AS n FROM orders }
        outputs: { orders: !cel "steps.count.result.rows[0].n" }
    inputs: { item: !cel "inputs.item" }
outputs: { orders: !cel "steps.write.result.orders" }
```

`telo.yaml`:

```yaml
kind: Telo.Application
metadata: { name: TenantOrders }
requires: { telo: ">=0.134.0" }
imports:
  Server: oci://ghcr.io/telorun/http-server@0.43.0
  Auth: oci://ghcr.io/telorun/auth@0.2.0
  Sql: oci://ghcr.io/telorun/sql@0.30.0
  SQLite: oci://ghcr.io/telorun/sqlite@0.14.0
  Orders:
    source: ./orders
    resources: { connection: !ref orderDb }
variables:
  dataDir: { env: DATA_DIR, type: string, x-telo-type: { name: Telo.HostPath, entry: directory } }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Telo.Ownership
metadata: { name: tenant }
recordType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [name, plan]
    properties: { name: { type: string }, plan: { type: string, enum: [free, pro] } }
steps:
  - name: row
    invoke:
      kind: Sql.Query
      connection: { kind: SQLite.Connection, file: !cel "variables.dataDir.joinPath('tenants.db')" }
    inputs: { sql: !sql "SELECT name, plan FROM tenants WHERE id = ${{ string(key) }}" }
  - name: missing
    if: !cel "size(steps.row.result.rows) == 0"
    then:
      - name: unknown
        throw:
          code: TENANT_UNKNOWN
          message: !interpolate "No tenant ${{ string(key) }}"
          data: { tenant: !cel "string(key)" }
record:
  name: !cel "steps.row.result.rows[0].name"
  plan: !cel "steps.row.result.rows[0].plan"
targets:
  - !ref ordersSchema
---
kind: SQLite.Connection
metadata: { name: orderDb }
file: !cel "variables.dataDir.joinPath(tenant.plan + '/' + string(tenant.id) + '.db')"
---
kind: SQLite.Table
metadata: { name: ordersTable }
table: orders
columns:
  id: { type: integer, primaryKey: true, identity: always }
  item: { type: text }
---
kind: SQLite.Schema
metadata: { name: ordersSchema }
connection: !ref orderDb
version: !cel "module.version"
tables: [!ref ordersTable]
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
trustProxy: true
mounts:
  - path: /
    mount: !ref ordersApi
    authentication:
      verifiers:
        - verifier: { kind: Auth.TrustedHeader, principalIssuer: gateway }
          from: { kind: Server.FromForwardedIdentity, header: x-user, scheme: Proxy }
---
kind: Server.Api
metadata: { name: ordersApi }
ownership:
  - { by: !ref tenant, from: org }
routes:
  - request:
      path: /orders
      method: POST
      schema:
        body: { type: object, required: [item], properties: { item: { type: string } } }
    handler: !ref Orders.save
    inputs: { item: !cel "request.body.item" }
    returns:
      - status: 201
        content:
          application/json:
            schema: { type: object, required: [orders], properties: { orders: { type: integer } } }
            body: { orders: !cel "result.orders" }
    catches:
      - status: 403
        when: !cel "error.code == 'ERR_OWNER_REQUIRED' || error.code == 'TENANT_UNKNOWN'"
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: no organization }
      - status: 503
        when: !cel "error.code == 'ERR_OWNERS_EXHAUSTED'"
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: too many active tenants }
      - status: 500
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: !cel "error.code" }
```

Refused: the same router without `ownership:` is `ZONE_REQUIREMENT_UNSATISFIED` at the route, naming `tenant` and the `connection` input, as is `Orders.save` called from a boot target. A route `returns:` body reading `tenant.name` is `ZONE_REQUIREMENT_UNSATISFIED` at that line. A handler `{ kind: Telo.AsOwner, ownership: !ref tenant, invoke: !ref Orders.save }` fed `owner: !cel "request.params.tenant"` is `VALUE_TYPE_SEALED` at that line (section 3). An ownership named `request` is `OWNERSHIP_NAME_RESERVED`.

*Verify:*
- **Owner-bound:** `orderDb`, `ordersSchema`, and `Orders`' transaction and both statements are owner-bound to `tenant`; `save`, which only calls the transaction, is not. Hover on `orderDb` names `tenant` and the `file` field that bound it.
- **Routing:** two concurrent requests from gateways forwarding two organizations each write their own SQLite file, and both statements join that tenant's transaction, with `Orders` imported `isolated` and `shared` alike. `orderDb` is created once per tenant across many requests.
- **Migration per tenant:** a tenant's first request creates its file with the `orders` table before `Orders.save` runs; a second tenant's first request does the same for its own file; a changed `ordersTable` is applied to each tenant's file at that tenant's next build; `ordersSchema` named as a boot target is `ZONE_REQUIREMENT_UNSATISFIED`, and a `targets` entry not owner-bound is `OWNERSHIP_TARGET_NOT_OWNER_BOUND`.
- **Record:** concurrent first requests of one organization run the ownership's steps once; a `pro` tenant's file is created under `pro/`; an organization with no row gets the 403 through `TENANT_UNKNOWN` and nothing else is built; a renamed tenant's new name is read by a `Telo.Sequence` step's `tenant.name` within `recordLifetime`, without reopening its connection; a sequence step reading `tenant.plan` called from a boot target fails `telo check` with `ZONE_REQUIREMENT_UNSATISFIED`.
- **Lifetime:** a tenant's connection is closed `idleTimeout` after its last request and reopened by the next; with `maxOwners: 1` a second tenant's request fails at once with `ERR_OWNERS_EXHAUSTED` while the first is held, and succeeds once it is released.
- **Bound twice:** a declaration whose fields read `tenant.id` and a cluster pool's member, or the bindings of two ownerships of different chains, is `OWNER_BOUND_MULTIPLE`; a `KvMemory.Store` listed in `perOwner` is one store per tenant.
- **No organization:** a principal with a null `org` gets the 403 the route's `catches:` entry draws, and nothing is built; without that entry the server answers 403 itself.
- **Nesting:** an inner `Telo.AsOwner` for a second tenant, inside a route of the router, writes that tenant's file; the outer handler's later steps write the first tenant's again.
- **Annotation:** `x-telo-enters-ownership` whose entries' `from` names a member that is not a string, or an `owner` field typed `string`, is `ENTERS_OWNERSHIP_INVALID` at the kind and fails registration; a controller opening it through a slot without the annotation throws `ERR_ZONE_ANNOTATION_MISSING`.
- **Worker:** a `Queue.Worker` whose handler calls `Orders.save` fails `telo check` naming `tenant`; with `ownership: [{ by: !ref tenant, owner: !cel "message.tenant" }]` and a `messageType` declaring `tenant` a `Telo.OwnerKey` of `tenant` it passes, and an enqueue passing `request.body.tenant` is `VALUE_TYPE_SEALED`.
- **Trace:** each route's handler span carries `telo.owner.tenant` with the organization.

### 2. A store reached by an owner is partitioned, or declared shared

*Before:* add a module-level `Cache.Store` to the example above, read by a `Cache.View` inside `Orders.save`. Every tenant reads every other tenant's entries, and `telo check` reports nothing. The same cache under a user layer would serve one user's entries to every user of the tenant.

*After:* kinds whose resources keep or deliver data say so, and inside each ownership every such resource is either partitioned by that layer's owner or listed as shared with a reason. The default is refused, layer by layer.

**`x-telo-holds-state: true`**
- At a kind's schema root: a resource of the kind keeps or delivers data that another dispatch reads. Inherited along `extends`, so on an abstract it binds every implementation. Any other value, or the annotation off the root, is `HOLDS_STATE_INVALID` at the kind and `ERR_HOLDS_STATE_INVALID` at registration.
- **Adopters:** `KeyValueStore.Store`, `Cache.Store`, `SQL.Connection`, `Blob.Store`, `Queues.Queue`, `VectorStore.Store`, `RecordStream.JournalStore`, `Graph.Store` and `Broadcast.Channel`. Kinds that keep their data in one of these (`Session.Sessions`, `Lease.Critical`, `Idempotency.Once`, `RateLimit` limiters) need nothing: their store is the holder the rule finds.

**The rule**
- **Reached:** the analyzer walks down from every place an ownership is entered — each `Telo.AsOwner`'s `invoke` slot and each `x-telo-enters-ownership` slot with entries — over the call graph, and from every declaration it reaches along each `use: dependency` reference, transitively. A holder found this way is *reached by* every ownership open there.
- **Judged per layer:** a holder reached by an ownership must be partitioned for that ownership or listed in its `shared:`. A holder reached inside `tenant` and `user` is judged twice.
- **Partitioned by address:** the holder is owner-bound to that ownership or one within it — the database-per-owner layout, or a namespaced view whose namespace reads the owner — or is a `with:`-scoped declaration whose creation-time fields read the owner. The walk does not continue beneath it: what an owner's instance is built over (one shared store beneath a namespaced view) is that instance's partition.
- **Partitioned by column:** the holder is a connection, and inside that ownership nothing raw reaches it — every declaration reaching it there is confined (section 4) — and every table those declarations touch is owned by that ownership. A confined table that is not — a tenant-wide catalog read inside the `user` layer — is listed in that layer's `shared:` by itself, so one connection holds per-user and tenant-wide tables alike.
- **Refused:** a holder or table that is neither is `OWNER_STATE_UNPARTITIONED` at its declaration, naming the ownership and the chain from where it was entered; for a library's own declaration it is reported at the `imports:` entry reaching it. `ERR_OWNER_STATE_UNPARTITIONED` at load.
- **Not reached, not judged:** a holder no ownership reaches (a migration run as a boot target, an operator's report) is never refused.
- **Scoped holders:** a holder declared in a `with:` scope lives one run; it is partitioned only when a creation-time field reads the owner, and is otherwise listed shared.
- **Residue, stated:** the walk sees what the call graph sees, as the zone checks do. A dispatch through a slot with no static target is not followed, and nothing refuses it at run time.

**`Telo.Ownership.shared`**
- A list of entries, each with a non-empty `reason`:
  - `{ resource: !ref <name>, reason }` — a holder, a table or a confined declaration of the ownership's own module, or an instance an imported library exports (`!ref <Alias>.<name>`). An inline one is named first: the refusal says so. A confined declaration listed here reads across this layer's owners: it is confined by the layers outside it only, and does not require this layer's zone — a support view of every user's notes in a tenant.
  - `{ import: <Alias>, reason }` — every holder declared inside that import's library and the libraries beneath it.
- The reason is shown on hover over what it names, so a reviewer reads one sentence per shared store.
- An entry naming something this ownership never reaches unpartitioned is the warning `OWNERSHIP_SHARED_UNUSED`.

*Example:* the module-level cache above is refused at its declaration, naming `tenant` and the chain `ordersApi → Orders.save → view → store`. Listing it — `shared: [{ resource: !ref responseCache, reason: entries are keyed by order id, which is unique across tenants }]` — passes. A `Session.Sessions` over a module-level `KvMemory.Store` is listed the same way, its reason that a session id is unique across tenants.

*Verify:*
- The cache variant fails `telo check` and load naming the chain; listed in `shared:` it passes; listed in `tenant`'s `perOwner` instead, it is one cache per tenant and passes with no entry.
- The same cache reached under a router entering `tenant` then `user` is refused twice, once per layer, until listed in both.
- A library declaring its own `KvMemory.Store` and reached by the ownership is reported at the app's `imports:` entry; `{ import: <Alias>, reason }` clears it.
- A module-level `KvSql.Store` over a shared connection whose namespace reads `string(tenant.id)` is owner-bound and passes, and the shared `Sql.Connection` beneath it is not judged; the same store with a fixed namespace is `OWNER_STATE_UNPARTITIONED`.
- A `Queue.Enqueue` onto a module-level queue inside the ownership is refused until the queue is listed shared.
- A shared entry naming the server is `OWNERSHIP_SHARED_UNUSED`.

### 3. An owner key proves where it came from

*Before:* an owner id is a string, and any string will do — a path parameter, a body field, a header.

*After:* **`Telo.OwnerKey`** is a sealed value type, one per ownership: a plain string does not become one, and one ownership's key is not another's. A layer is entered with an owner read off the authenticated principal, or through a conversion someone wrote down.

**Sealed value types**
- A value-type entry gains `sealed: true` (`json` over `string` only): a nominal brand a plain value does not flow into, however it was built.
- A CEL value already typed with it — read from `inputs`, a step result, a queue message, an owner binding's `id` — flows wherever one is required. A plain value becomes one in exactly four places:
  - a literal written in the manifest;
  - an Application `variables:` / `secrets:` entry declaring the type, which the host supplies;
  - a dispatch whose output contract declares it — a controller's result;
  - an `outputs:` entry of a body whose own `outputType` declares it — the written conversion.
- Any other CEL `string` at a slot of a sealed type is `VALUE_TYPE_SEALED` at that line, refused at load by the kernel's analysis. At run time a sealed value is its base's representation; the guarantee is static.
- Any entry may be sealed; `Telo.OwnerKey` is the first.

**`Telo.OwnerKey`**
- Sealed, over `string`, non-empty, never sensitive. Its parameter `of` names the ownership (`{ name: Telo.OwnerKey, of: !ref tenant }`); two keys of different ownerships are different types, so a tenant's key is refused where a user's is required (`CEL_TYPE_ERROR`).
- A router's `from` entry reads the principal directly and needs no sealed value; `Auth.Principal` stays as it is.
- **An operator acting for a tenant named in the URL:** a `Telo.Sequence` asks the policy whether the principal may act for it and returns the parameter from an `outputs:` entry whose `outputType` declares `Telo.OwnerKey` of `tenant`, then calls `Telo.AsOwner`. That is the one place a string becomes an owner, and a reviewer reads it.
- **A job over every tenant:** the same conversion over the rows of a tenants table, one `Telo.AsOwner` per row.

*Verify:*
- `owner: !cel "request.params.tenant"` and `owner: !cel "request.headers['x-tenant']"` at a `Telo.AsOwner` fail `telo check` with `VALUE_TYPE_SEALED` at that line, and fail at load.
- A literal `owner: acme`, a sequence output declaring the key and a step result typed with it pass; `tenant.id` passed where a `Telo.OwnerKey` of `user` is required is `CEL_TYPE_ERROR`.
- `string(tenant.id) + '.db'` in a connection's `file` type-checks; `tenant.id + '.db'` is a CEL type error.

### 4. Shared tables partitioned by owner columns

*Before:* many tenants in one database share each table, and the tenant column — and, inside a tenant, the owning user's column — is filled and filtered by hand in every statement. One forgotten `WHERE` reads every tenant's or every user's rows, and only a PostgreSQL row-level security policy, when someone wrote one, would stop it.

*After:* a table declares who owns its rows, layer by layer. Every statement Telo generates over it is confined to the current owner of each layer, and the database refuses a row of one tenant referencing another's, on every engine.

**A table's owners**
- `Sql.Table` gains `ownedBy`: an ordered list of `{ by: !ref <ownership>, column? }`, outermost first; every engine's table kind inherits it. `column` defaults to the ownership's name in snake case followed by `_id` (`tenant_id`, `user_id`). An inner ownership listed without every ownership it is `within` before it is `SQL_OWNED_BY_ORDER`, a rule on `Sql.Table` twinned in normalization.
- **The columns** are added as internal columns — the engine's text type, not null — so they are outside the row contract: no projection, API body, form or row type shows them, and no caller can set one. A name already in `columns` or `internalColumns` is `SQL_OWNER_COLUMN_DECLARED`, twinned in normalization. Every table gains an index over its owner columns in order, for the filter.
- **Uniqueness and references follow `references:`.** For each ownership declared `confined`, every unique index gains its column, in `ownedBy` order, ahead of the declared ones; the primary key gains a unique index over those columns and itself, for foreign keys to reference; and a foreign key between two tables owned by it becomes composite over its column, so a row cannot name another owner's row. An `open` ownership filters rows and constrains nothing: a comment by one user may reference another user's post in the same tenant, and the post is simply not returned to a confined read of its non-owner.
- A table may reference a table with no owners (shared reference data such as countries). A table referencing one owned by a `confined` ownership it is not itself owned by is `SQL_FOREIGN_KEY_OWNERSHIP_MISMATCH`, twinned in normalization.
- **No seeds:** a seed row belongs to no owner, so `seeds` on an owned table is `SQL_OWNED_TABLE_SEEDED`, twinned in normalization.
- **Existing rows:** adding or removing an `ownedBy` entry on a table that holds rows is refused by the schema pass at boot with `ERR_SQL_OWNERSHIP_CHANGED_ON_POPULATED_TABLE`, naming the table; moving rows to owners is a migration the author writes.
- These are ordinary columns, indexes and constraints, so SQLite and PostgreSQL enforce them alike, and no session variable or policy is involved.

**Confined statements: `x-telo-owner-confined`**
- At a kind's schema root: `{ table: <pointer> }`, naming the slot holding the `Sql.Table` every statement of the kind touches, or `true`, saying the kind touches no table through its connection. Anything else is `OWNER_CONFINED_INVALID` at the kind and `ERR_OWNER_CONFINED_INVALID` at registration.
- **When the named table has owners:** reads, updates and deletes are filtered on every owner column equal to the current owner of its layer, inserts set every owner column, and an update never changes one. The controller takes the owners from the kernel through one SDK call, never from its inputs. The declaration requires the zone of every ownership the table names — less any layer whose `shared:` lists it — so reached outside one, it is `ZONE_REQUIREMENT_UNSATISFIED` naming the table and the ownership, and `ERR_ZONE_REQUIRED` at run time. Over a table with no owners nothing changes.
- A confined kind's own template-body entries are covered by its declaration: the statement a templated kind issues inside is the kind's statement.
- **Adopters:** `SqlRepository.Read` / `Create` / `Update` / `Delete` (`/table`); `Crud.Reader` / `Creator` / `Updater` / `Deleter` (the collection's `table`), so a `Crud.Api` over an owned table lists, counts, facets, reads and writes one owner's rows; `Sql.Transaction` (`true`). Their contracts are unchanged. The other SQL backends (`kv-store-sql`, `queue-sql`, `graph-sql` and the rest) adopt it later; until then a connection they reach inside an ownership is unpartitioned (section 2).
- **Outside every ownership** nothing is judged: an operator's report over every tenant's rows is a raw query no ownership reaches.

**The layouts together:** one application may keep some data in a database per tenant and the rest in shared tables, and a per-user layer may sit on either. A table owned by `user` whose connection is owner-bound to `tenant` is both, and legal.

*Example — notes per user and a catalog per tenant, every tenant in one SQLite file:*

```yaml
kind: Telo.Application
metadata: { name: SharedNotes }
requires: { telo: ">=0.134.0" }
imports:
  Server: oci://ghcr.io/telorun/http-server@0.43.0
  Auth: oci://ghcr.io/telorun/auth@0.2.0
  SQLite: oci://ghcr.io/telorun/sqlite@0.14.0
  Repo: oci://ghcr.io/telorun/sql-repository@0.22.0
variables:
  database: { env: DATABASE_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file } }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref schema
  - !ref server
---
kind: Telo.Ownership
metadata: { name: tenant }
---
kind: Telo.Ownership
metadata: { name: user }
within: !ref tenant
references: open
shared:
  - resource: !ref catalogTable
    reason: the catalog is the same for every user of a tenant
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.database"
---
kind: SQLite.Table
metadata: { name: notesTable }
table: notes
ownedBy:
  - { by: !ref tenant }
  - { by: !ref user }
columns:
  id: { type: integer, primaryKey: true, identity: always }
  text: { type: text }
---
kind: SQLite.Table
metadata: { name: catalogTable }
table: catalog
ownedBy:
  - { by: !ref tenant }
columns:
  id: { type: integer, primaryKey: true, identity: always }
  title: { type: text }
---
kind: SQLite.Schema
metadata: { name: schema }
connection: !ref db
version: !cel "module.version"
tables: [!ref notesTable, !ref catalogTable]
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
trustProxy: true
mounts:
  - path: /
    mount: !ref notesApi
    authentication:
      verifiers:
        - verifier: { kind: Auth.TrustedHeader, principalIssuer: gateway }
          from: { kind: Server.FromForwardedIdentity, header: x-user, scheme: Proxy }
---
kind: Server.Api
metadata: { name: notesApi }
ownership:
  - { by: !ref tenant, from: org }
  - { by: !ref user, from: subject }
routes:
  - request:
      path: /notes
      method: POST
      schema:
        body: { type: object, required: [text], properties: { text: { type: string } } }
    handler: { kind: Repo.Create, connection: !ref db, table: !ref notesTable }
    inputs: { data: { text: !cel "request.body.text" } }
    returns:
      - status: 201
        content:
          application/json:
            schema: { type: object, required: [created], properties: { created: { type: boolean } } }
            body: { created: true }
  - request: { path: /notes, method: GET }
    handler: { kind: Repo.Read, connection: !ref db, table: !ref notesTable }
    inputs: { filters: {} }
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [notes], properties: { notes: { type: array } } }
            body: { notes: !cel "result.rows" }
  - request: { path: /catalog, method: GET }
    handler: { kind: Repo.Read, connection: !ref db, table: !ref catalogTable }
    inputs: { filters: {} }
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [items], properties: { items: { type: array } } }
            body: { items: !cel "result.rows" }
```

Refused: without the `shared:` entry, `catalogTable` is `OWNER_STATE_UNPARTITIONED` for `user`, naming the `/catalog` route. A fourth route whose handler is `{ kind: Sql.Query, connection: !ref db }` with `SELECT * FROM notes` is `OWNER_STATE_UNPARTITIONED` at `db` for both layers, naming that handler. `notesApi` without `ownership:` is `ZONE_REQUIREMENT_UNSATISFIED` at each route, naming the table and `tenant`; with only the `tenant` entry, at the two notes routes, naming `user`. `ownedBy` listing `user` without `tenant` before it is `SQL_OWNED_BY_ORDER`. The section 1 `Orders` library, imported over `db`, is refused like the raw route, because its statements are raw.

*Verify:*
- **Confinement:** two users of one organization and a user of another each create notes; each `GET /notes` returns that user's own only, and `GET /catalog` returns the tenant's catalog to both of its users and none of the other tenant's; no owner column appears in a result, a body or a type.
- **Support view:** a `Repo.Read` over `notesTable` listed in `user`'s `shared:`, entered with `tenant` only, returns every user's notes of that tenant and none of another's.
- **Per-owner uniqueness:** a unique index on `catalog.title` lets two tenants hold the same title and refuses a duplicate within one.
- **References:** a tenant-owned table with a foreign key to `catalog` refuses, in the database, a row naming another tenant's item; a note referencing another user's note in the same tenant is accepted, `user` being `open`; a table with no owners referencing `catalog` fails `telo check` and load with `SQL_FOREIGN_KEY_OWNERSHIP_MISMATCH`.
- **Nesting:** a `Telo.AsOwner` of `tenant` for a second tenant inside a notes route closes the `user` zone for its target, so a confined read of `notesTable` beneath it is `ZONE_REQUIREMENT_UNSATISFIED`.
- **Existing rows:** adding an `ownedBy` entry to a populated table fails boot with `ERR_SQL_OWNERSHIP_CHANGED_ON_POPULATED_TABLE`; the same on an empty table adds the column and the indexes.
- **CRUD:** a `Crud.Api` over an owned table, behind a router entering its owners, lists, counts facets, reads, updates and deletes one owner's rows, and a `PATCH` naming another owner's id answers 404.
- **Engines:** the confinement, uniqueness and reference vectors pass on SQLite and PostgreSQL alike.
- **Refusals:** each refused variant above fails `telo check` with its code and fails at load.

## Decisions

- **An owner's resources are derived from what a declaration reads, not declared in a pool.** A connection whose `file` reads `tenant.id` can only mean one connection per tenant, so the reference graph that already finds member-bound declarations finds owner-bound ones too, and a per-tenant resource is written exactly like a shared one. `perOwner` covers the declaration with nothing to read.
- **An owner's resources are built whole and live as one set.** The record, every owner-bound declaration and `targets` are one build with one timeout and one lifetime on the ownership, so a creation failure is the owner's build failure with a declared code, and an owner's connection never outlives or precedes its schema migration.
- **An ownership migrates what it builds.** An owner-bound schema in the ownership's `targets` gives each owner's database its tables before its first request, inside the bounded build, rather than through a boot target that would have to open every database at start.
- **The record refreshes on its own clock.** A changed name or plan must show quickly, while an owner's connections should not be reopened for it, so `recordLifetime` and the resources' `maxLifetime` are separate.
- **One stackable ownership, not a tenant kind and a user kind.** A tenant and a user need the same things — a zone, per-owner resources, a record, confined rows, judged stores — so one kind declared once per layer gives each layer all of them, and a new layer (a workspace between tenant and user) is one more declaration. `within` is what makes them a stack.
- **Each layer is read by its own name.** A binding named by the declaration lets two layers sit in one expression with no ambiguity, which one fixed name could not.
- **The dispatcher enters the ownerships, through one annotation.** The common case — a request acting for its caller — is one `ownership:` list on the router or worker, so no route repeats it; the annotation keeps it generic, any kind that dispatches adopting it with no kernel knowledge of the kind. `Telo.AsOwner` stays for the deliberate cases.
- **The router names the ownerships, not the mount.** The controller that dispatches a handler opens the zones around it, so no zone has to cross an inbound boundary and no mount kind has to carry it through to the router it hosts.
- **A principal's member is trusted, so `Auth.Principal` stays as it is.** The router reads the authenticated principal by declaration, so its members need no sealed type; sealing them would break every existing read of `subject` that compares or joins it with a plain string.
- **Entering an outer layer closes the layers within it.** Otherwise a user of one tenant would remain open beside a second tenant, and a confined read would pair them.
- **The ownership is the zone's provider, wherever it is opened.** Its private map lives on the ownership, so opening it from a router, a worker or `Telo.AsOwner` claims nothing of another kind's state — the reason the zone spec forbids opening another kind's zone does not apply.
- **Holders are found by an annotation on the kind, judged per layer where an ownership reaches them.** The kind is the only thing that knows it keeps data, and the walk from where an ownership is entered is the only place that knows an owner is present; judging every holder in the application would refuse stores no owner ever touches.
- **Exemptions live on the ownership, each with a reason.** One list per layer is what a reviewer audits; a resource cannot carry a new top-level key without every kind's schema declaring it, and an import entry covers what a library declares but does not export.
- **An owner is a record, built once per owner.** What downstream CEL needs about an owner (a tenant's plan, a user's role) is read once by the layer's own steps and cached for `maxLifetime`, rather than looked up again in every resource that needs it; the cost is that a change shows within that time, not at once.
- **Reading an owner is a zone requirement.** A runtime read makes the declaration need the layer, and a creation-time read makes it owner-bound, which needs the layer too, so the existing zone check reports every reach without that owner.
- **Both layouts are first-class, and judged by one rule.** A database per owner isolates fully and costs a connection per active owner; shared tables scale to many owners in one database. Which an application needs is its own trade-off, so each is a way to be partitioned, and section 2 judges every store the same whichever is used.
- **Shared-table checks are per table, not per connection.** One connection commonly holds tenant-wide and per-user tables; judging the connection would force a shared entry that also exempts the per-user ones.
- **Cross-owner references are a declared property of the layer.** Whether a row may reference another owner's is what separates a tenant from a collaborating user, and nesting depth does not decide it — a consumer application's only layer may be the user.
- **A shared table is confined by Telo, not by the engine.** The predicates and the columns are written by the kinds that generate statements, and the per-owner uniqueness and references are ordinary indexes and constraints, so SQLite and PostgreSQL enforce the same thing; row-level security exists only on some engines and protects only when configured.
- **Hand-written SQL over a shared table is vouched for, never parsed.** SQL text is engine-specific and opaque to the analyzer, so a raw statement inside an ownership leaves its connection unpartitioned until a `shared:` entry states why it is safe.
- **An owner key is sealed, and typed per ownership.** A brand that accepts any string would type-check `request.params.tenant`, which is the mistake being prevented, and one shared key type would let a tenant id stand where a user id belongs; the written conversion keeps the deliberate cases possible and visible.

## Housekeeping

- **Agreement suite.** `tests/check-run-agreement.yaml` gains one row for each refusal, refused by both halves: an owner-bound declaration reached outside its ownership (from a boot target, from a detached dispatch and from a router without `ownership:`), a declaration bound to two ownership chains or to an ownership and a pool (direct and import-anchored), a `targets` entry not owner-bound, a looping `within`, a reserved ownership name, a `recordType` declaring `id`, a malformed `x-telo-enters-ownership`, entries out of `within` order, a runtime field reading an owner reached outside its ownership, an unpartitioned holder or table reached by an ownership (direct and import-anchored), a misplaced `x-telo-holds-state`, a malformed `x-telo-owner-confined`, an owner column clashing with a declared one, `ownedBy` out of order, a foreign key across a `confined` ownership, seeds on an owned table, a raw statement over a shared connection inside an ownership, a confined kind reached outside its table's ownership, a plain string at a `Telo.OwnerKey` slot, and one ownership's key at another's slot.
- **Grammar floors**, under the "Changing the grammar" rule: `telo release floor` measures every module whose own file declares a `Telo.Ownership` or a `Telo.AsOwner`, `x-telo-holds-state`, `x-telo-enters-ownership`, `x-telo-owner-confined`, a table `ownedBy`, a router or worker `ownership`, a `Telo.OwnerKey` slot or a creation-time read of an owner binding. The examples write `>=0.134.0`, after the releases carrying the scope and keyed-pools plans; it is whatever release ships this.
- **Releases.** One changeset naming `@telorun/analyzer`, `@telorun/kernel`, `@telorun/sdk` and `@telorun/ide-support` (one telo version line, a minor bump). `telo release add` fragments of kind `Added`, one per module: `http-server` (`Http.Api.ownership`), `queue` (`Queue.Worker.ownership`, and its queue holds state), `sql` (`Sql.Table.ownedBy`, the schema pass's owner columns, indexes and references, `Sql.Transaction` confined, and its connection holds state), `postgres` and `sqlite` (their table kinds and schema passes carry the owner columns), `sql-repository` and `crud` (their statements are confined), and each other adopter of `x-telo-holds-state` — `kv-store`, `cache`, `blob`, `vector-store`, `record-stream`, `graph`, `broadcast`. No major bump anywhere.
- **Built-in vocabulary.** `Telo.Ownership`, `Telo.AsOwner`, the `OwnershipEntry` fragment, the `Telo.OwnerKey` value type, the value-type `sealed` key and the codes `ERR_OWNER_REQUIRED`, `ERR_OWNER_BUILD_TIMEOUT` and `ERR_OWNERS_EXHAUSTED` with their display messages are added to the built-in entries, and the `Telo.Builtins` archive is re-rendered; both analyzers read them.
- **Benefits ledger.** One entry under Telo itself in `docs/guides/what-you-get.md`: multi-tenancy and per-user data checked before the app runs — one `ownership:` list on a router runs every route for the signed-in organization and user, CEL reads each owner's record by name, a resource configured from the tenant is one instance per tenant with nothing else written, a database per tenant is migrated at that tenant's first request, a shared table's rows are filtered, filled and kept unique per owner by Telo on every engine, and inside each layer every store a request reaches is partitioned by its owner or listed as shared with a reason.
- **Documentation:**
  - `docs/guides/multi-tenancy.md`, with both examples: declaring the layers and `within`, `references`, entering them from a router or a worker and with `Telo.AsOwner`, owner records and their lifetime, where an owner binding is read, owner-bound declarations and `perOwner`, sizing `maxOwners` against active owners and the connections each holds (times replicas), `targets`, both layouts and how to choose (isolation and connection count against owner count), migrating every tenant's database ahead of a release, the shared list per layer and how to write a reason, support views, the operator and every-tenant conversions, background work re-entering from its message, and the walk's residue.
  - `sdk/value-types/README.md`: the `sealed` key and `Telo.OwnerKey`'s `of`.
  - The analyzer guide: `x-telo-holds-state`, `x-telo-enters-ownership`, `x-telo-owner-confined`, owner-bound declarations, the per-layer walk, owner bindings and where they are read; the kernel guide: owner contexts and their routing, building where an ownership is entered, closing inner layers; the execution-zones spec: the `Telo.Ownership` zone's provider is the ownership wherever it is opened, and the SDK call that opens it at an annotated slot.
  - `http-server` docs: `Http.Api.ownership` and `ERR_OWNER_REQUIRED`; `queue` docs: `Queue.Worker.ownership`.
  - `sql` docs (`declarative-schema.md`): `ownedBy`, owner columns, per-owner uniqueness and references, populated tables; `sql-repository` and `crud` docs: statements over an owned table are confined.
  - Each `x-telo-holds-state` adopter's docs: its kind holds state, and what that means inside an ownership.
  - The root guide: the two built-in kinds, `x-telo-holds-state`, `x-telo-enters-ownership`, `x-telo-owner-confined`, `Telo.OwnerKey` in the value-type list, owner bindings in the CEL-scope list.
- **Hub guide.** `guide_design_library` (`apps/hub/guides/`): a library may take an owner-bound resource as a `resources:` input, and its declarations over it are then built per owner; a kind that keeps data declares `x-telo-holds-state`; a store a library declares itself is reported at its importer's `imports:` entry inside an ownership, so a library that serves owners takes its stores as `resources:` inputs; a kind that generates SQL over a declared table declares `x-telo-owner-confined` and filters on the table's owner columns, or its connection is unpartitioned inside an ownership.
- **Authoring agent primer.** In the same change: a multi-tenant application declares one `Telo.Ownership` per layer (`tenant`, then `user` `within` it, `references: open` where users reference each other), and enters them with an `ownership:` list on each `Http.Api` (`{ by, from: org }`, `{ by, from: subject }`) and each `Queue.Worker` (`{ by, owner }` from the message), using `Telo.AsOwner` only where the owner is not the signed-in principal; what downstream CEL needs about an owner is a field of its layer's `recordType`, read as `<layer>.<field>` in any field or step body, never re-queried per resource and never read in a route's own `returns:`; a module-level resource whose field reads an owner (`file: … string(tenant.id) …`) is one instance per owner with nothing else written, and one with nothing to read is listed in `perOwner`; never use `Telo.KeyedPool` for tenants or users; an owner's data lives either in its own database — such a connection, with the `Sql.Schema` over it in the ownership's `targets` — or in shared tables declaring `ownedBy`, written and read only through `sql-repository` or `crud`; every store and table a request reaches is partitioned for each layer or in that layer's `shared:` with a reason; an owner id from a path, body or header is converted only through a sequence that checks the policy and declares the layer's `Telo.OwnerKey` in its `outputType`.
