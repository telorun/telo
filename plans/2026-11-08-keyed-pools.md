---
status: draft
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, ide-support, authoring-agent, hub]
refinement: not-ready
---

# Keyed pools

## Problem

A resource configured from request-time data cannot be shared, and cannot reach deep consumers. A cluster's client built from a kubeconfig stored in a database can only be built per call in a `with:` scope, rebuilt with its connections on every call; every resource using it must be redeclared in that scope, and the cluster id threaded through every contract down to it. A database-per-tenant application has the same problem with each tenant's connection, plus one more: each tenant's database needs its schema before its first query, and a boot target cannot reach a database that is chosen per call. A Kubernetes connector serving many clusters is the first consumer; nothing here is specific to it.

## Constraints

None.

## Surface

**Added**
- `Telo.KeyedPool` — built-in kind that builds one member resource per key and keeps it.
- `Telo.KeyedPool.keyType` — the key's schema, a string schema; `x-telo-sensitive` in it makes the key a secret.
- `Telo.KeyedPool.steps` — step body run only when a key has no member.
- `Telo.KeyedPool.member` — the declaration built once per key.
- `Telo.KeyedPool.targets` — runnables run once per member before it serves.
- `Telo.KeyedPool.buildTimeout` — bound on one build (default `30s`).
- `Telo.KeyedPool.idleTimeout` — teardown of a member with no holds (default `300s`).
- `Telo.KeyedPool.maxLifetime` — retirement age of a member (default `3600s`).
- `Telo.KeyedPool.maxMembers` — bound on a process's members (default `64`).
- `key` — CEL binding in a pool's `steps` and `member`, typed from `keyType`.
- `resources.<pool>.status.members` — the members `maxMembers` counts, per replica.
- `resources.<pool>.status.building` — the builds in flight, per replica.
- `Telo.Checkout` — built-in invocable that checks out one member and dispatches its target under it.
- `Telo.Checkout.pool`, `Telo.Checkout.invoke` — the pool and the executable dispatched.
- `Telo.Checkout` input `{ key, inputs }` — the key, and the target's own inputs.
- `referenceResolvesTo` — key of a built-in kind entry: the pointer a `!ref` to such a resource resolves to at a slot of another kind.
- `POOL_KEY_TYPE_INVALID` / `ERR_POOL_KEY_TYPE_INVALID` — a `keyType` that is not a string schema.
- `POOL_MEMBER_CAPABILITY_UNSUPPORTED` / `ERR_POOL_MEMBER_CAPABILITY_UNSUPPORTED` — a `member` that is not a provider or an invocable.
- `MEMBER_BOUND_SCOPED` / `ERR_MEMBER_BOUND_SCOPED` — a member-bound declaration inside a `with:` scope.
- `MEMBER_BOUND_MULTIPLE_POOLS` / `ERR_MEMBER_BOUND_MULTIPLE_POOLS` — a declaration reached by two pools.
- `ERR_POOL_EXHAUSTED` — a new key with `maxMembers` reached and no idle member.
- `ERR_POOL_BUILD_TIMEOUT` — a build that ran past `buildTimeout`.
- `docs/guides/keyed-pools.md` — the guide.

**Changed**
- `!ref <pool>` — at a slot whose kinds do not name `Telo.KeyedPool`, stands for the member the innermost checkout of that pool holds.
- `ZONE_REQUIREMENT_UNSATISFIED` / `ERR_ZONE_REQUIRED` — also raised for a member-bound declaration reached outside a checkout of its pool.
- `ERR_DURABLE_TARGET_UNENCODABLE` — also raised for a member-bound declaration as a durable step's target.
- `ERR_RESOURCE_INITIALIZATION_FAILED` — also what a checkout's caller receives when the member's build fails.

**Removed**
- None.

## Solution

### A keyed pool builds a resource per key, and a checkout chooses the key

*Before:* a resource whose configuration is known only during a call is built per call, inside a `with:` scope, together with its connections and TLS sessions. Every resource that uses it is redeclared in that scope, and the cluster id passes down through every contract between the request's edge and the place it is used:

```yaml
kind: Telo.Application
metadata: { name: K8sDashboard }
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@0.14.4
  Sql: oci://ghcr.io/telorun/sql@0.31.4
  Yaml: oci://ghcr.io/telorun/yaml@0.11.1
  Http: oci://ghcr.io/telorun/http-client@0.25.0
  Server: oci://ghcr.io/telorun/http-server@0.44.2
variables:
  database: { env: DATABASE_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file }, default: ./clusters.db }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref dashboardApi }
---
kind: Server.Api
metadata: { name: dashboardApi }
routes:
  - request:
      path: /clusters/{cluster}/pods
      method: GET
      schema:
        params: { type: object, required: [cluster], properties: { cluster: { type: string } } }
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [cluster], properties: { cluster: { type: string } } }
      steps:
        - name: row
          invoke:
            kind: Sql.Query
            connection: { kind: SQLite.Connection, file: !cel "variables.database" }
          inputs: { sql: !sql "SELECT kubeconfig FROM clusters WHERE id = ${{ inputs.cluster }}" }
        - name: parse
          invoke: { kind: Yaml.Parse }
          inputs: { text: !cel "steps.row.result.rows[0].kubeconfig" }
        - name: list
          invoke:
            kind: Telo.Sequence
            inputType:
              kind: Telo.JsonSchema
              schema:
                type: object
                required: [server, token]
                properties: { server: { type: string }, token: { type: string, x-telo-sensitive: true } }
            with:
              - kind: Http.Client
                metadata: { name: client }
                baseUrl: !cel "inputs.server"
                headers: { Authorization: !interpolate "Bearer ${{ inputs.token }}" }
            steps:
              - name: pods
                invoke: { kind: Http.Request, client: !ref client }
                inputs: { method: GET, url: /api/v1/pods }
            outputs: { body: !cel "steps.pods.result.body" }
          inputs:
            server: !cel "steps.parse.result.docs[0].clusters[0].cluster.server"
            token: !cel "steps.parse.result.docs[0].users[0].user.token"
      outputs: { pods: !cel "steps.list.result.body" }
    inputs: { cluster: !cel "request.params.cluster" }
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [pods], properties: { pods: { type: object } } }
            body: { pods: !cel "result.pods" }
```

Every request reads the database, parses the kubeconfig and builds a new client with a new TLS session.

*After:* two new built-in kinds. **`Telo.KeyedPool`** says how one member is built from a key and keeps the members it built. **`Telo.Checkout`** wraps an executable and takes the key from its caller beside the target's inputs, so every resource that dispatch reaches that depends on the pool uses that key's member. No consumer kind declares anything.

**`Telo.KeyedPool`** — a `Telo.Provider` the kernel serves.
- **Fields:**
  - `keyType` (optional): the key's schema, written like `inputType`; it must be a string schema (`POOL_KEY_TYPE_INVALID`, `ERR_POOL_KEY_TYPE_INVALID` at creation). A key is an identity written into the member map, logs, traces and a redaction set, so it has one representation, text, compared and redacted alike on every kernel; an integer id is converted with `string()` at the checkout. Absent, a key is a non-empty string. A key is sensitive exactly when `keyType` marks it `x-telo-sensitive`.
  - `steps` (optional): the shared step grammar, run only when a key has no member. It reads `key`, typed from `keyType`. A resource declared inline in one of these steps is a module-scope declaration like any inline one: created once at load, shared by every build, and not member-bound unless it references the pool.
  - `member`: one full resource declaration, written as in a `with:` block. Its kind resolves through the declaring module's imports, it is validated as a top-level resource, and its creation-time fields read `key` and `steps.<name>.result`. A member that reads no `key` is legal: it keeps identical members apart per key.
  - `targets` (optional): `!ref` entries naming `Telo.Runnable` declarations, run in order once the member and its bound declarations are created and before the member serves any checkout — a schema migration of each member's database. They run once per member build, so again after the member is torn down and rebuilt, and on each replica independently: a target must be idempotent and safe to run concurrently, as a declared schema is. The build covers its targets as a checkout of its key would: a target bound to this pool reaches the member being built, and one reaching another pool's member-bound declaration is `ZONE_REQUIREMENT_UNSATISFIED`. A failing target fails the build, with the codes a creation failure has.
  - `buildTimeout` (default `30s`, covering `steps`, creation and `targets`), `idleTimeout` (default `300s`), `maxLifetime` (default `3600s`) and `maxMembers` (default `64`).
- **What it can pool:** `member` must be a `Telo.Provider` or a `Telo.Invocable`; anything else is `POOL_MEMBER_CAPABILITY_UNSUPPORTED`, and `ERR_POOL_MEMBER_CAPABILITY_UNSUPPORTED` at creation.
- **Building a member:** a key with no member runs `steps`, then creates `member` and every module-scope declaration bound to that member (below), then runs `targets`, in one init loop under the build's root invocation context — the member is built whole, as an import is. A creation failure fails the build and reaches the checkout's caller as `ERR_RESOURCE_INITIALIZATION_FAILED`, carrying the root failure as `cause`. Concurrent checkouts of one key wait for the same build, so it runs once. No caller's cancellation, transaction or zone reaches it, and it runs until it completes or `buildTimeout` elapses; a waiter cancelling abandons only its own wait. On expiry every waiter fails with `ERR_POOL_BUILD_TIMEOUT`, the build's own dispatches are cancelled and the key is cleared, so the next checkout builds again. An abandoned build counts toward `maxMembers` until it settles, and a creation that succeeds after expiry is torn down at once, never served. A failed build caches nothing, and the next checkout of that key builds again; its failure reaches every waiting checkout's caller unchanged, so the build's codes join the checkout's throws union. Pool steps that reach the pool's own members are `DEPENDENCY_CYCLE`.
- **A build's payloads are withheld:** every dispatch a build issues — its `steps`, its `targets` and whatever they dispatch at any depth — writes its trace payloads (inputs, outputs, error `data`) as `[redacted]`; spans, timings, codes and messages stay. An error leaving a build carries that withholding into every observability writer, while CEL in a `catches:` entry still reads its `data`. A build derives a credential (row → document → token) through readers that cannot mark their own output, so only the build's boundary closes the leak.
- **Lifetime of a member:**
  - A member with no holds is torn down through its normal inverse chain after `idleTimeout`.
  - After `maxLifetime` a member is retired: later checkouts of its key build a new member, and the retired one is torn down when its last hold is released. This is the only invalidation, so a rotated credential is picked up within `maxLifetime` on every replica.
  - `maxMembers` bounds the live members of one process: being built, held, idle, and retired but still held all count. A checkout of a new key with no idle member to evict fails at once with `ERR_POOL_EXHAUSTED`, so a step's `retry:` does the waiting; when some member is idle, the least recently used idle member is evicted to make room. Pools are process-local: each replica keeps its own members.
  - Idle and lifetime timers take no kernel hold. Shutdown tears every member down after the checkouts holding them have ended.
- **Reading:** `resources.<pool>` is the pool's configuration plus `status.members` (what `maxMembers` counts) and `status.building`, for this replica. Status is republished when a build starts or ends and when a member is torn down, never when a hold changes.
- **Reference:** `!ref <pool>` (or `!ref <Alias>.<pool>` for a pool an imported library exports) names the pool itself only at a slot whose kinds name `Telo.KeyedPool` — a checkout's `pool:`. At every other slot it stands for the member the innermost checkout of that pool holds, and is kind-checked against `member`'s kind; a mismatch is the existing `REFERENCE_KIND_MISMATCH`, naming the member's kind. The pool's built-in entry declares this as data (`referenceResolvesTo: /member`), read generically by every reader that resolves or kind-checks a reference: the reference resolver, the kind check of a library's `resources:` input (`RESOURCE_INPUT_KIND_MISMATCH` names the member's kind), the kernel's binding of that input, and the editor's reference picker.

**`Telo.Checkout`**
- **Fields:** `pool` (a `!ref` to a `Telo.KeyedPool`) and `invoke` (a `Telo.Executable`: an imported invocable, a `Lease.Critical`, a `Telo.Sequence` with its own `with:`, or the pool itself when its member is an invocable). It is a `Telo.Invocable`, declared like any resource: inline as a route handler or step target, or named at top level.
- **Contract:** input `{ key, inputs }` — `key` typed from `/pool/keyType`, `inputs` typed from `/invoke/inputType` (the forwarding rule) and defaulting to `{}`; output typed from `/invoke/outputType`. The target's own contract stays unchanged: it never declares the key. A checkout has no step body of its own, which would be a second copy of `Telo.Sequence`.
- **Throws:** the target's codes, `ERR_POOL_EXHAUSTED`, `ERR_POOL_BUILD_TIMEOUT`, `ERR_RESOURCE_INITIALIZATION_FAILED` and the build's codes. Which of them a caller retries is its own `retry:`'s `nonRetryable`.
- **Zone:** the `invoke` slot provides a zone correlated on `/pool`. The zone entry holds only the checkout's and the pool's identities, never the key; the pool keeps its own map from zone entry to member. The key traces verbatim unless `keyType` marks it sensitive, then as `[redacted]`.
- **Holding:** invoking a checkout takes a hold on the member of its `key` input (building it when needed) and dispatches `invoke` with its `inputs`. A checkout's exit is a hold-owning exit: streams leaving it are held, and the member hold is released by the held-stream rule when the checkout's dispatch closes. The member owns a redaction set, as a scope run holds its sensitive inputs, opened when its build starts: the key when `keyType` marks it sensitive, joined by every text value at a path a pool step's result type marks `x-telo-sensitive` as that step returns (read from the step target's resolved `outputType`, string leaves beneath included). A failed or timed-out build drops the set with the build, and the error leaving it carries the set through its whole `cause` chain, so a key interpolated into a `throw` or built into a controller's path is `[redacted]` in every log and trace of the failure, while CEL in a `catches:` entry reads the message intact; the messages of `ERR_POOL_EXHAUSTED` and `ERR_POOL_BUILD_TIMEOUT` name the pool, never the key. That set redacts the member's own records and its member-bound declarations' — the `Authorization` header in the member's `Created` event — so a credential is still marked where a step picks it out, as the first example does with `token`.
- **Nesting:** a checkout reached inside another checkout's dispatch of the same pool takes over for its own target; the innermost one decides. A dispatch therefore uses one member per pool; using two members of one recipe at once means two pools.

**Member-bound declarations**
- **Which they are**, computed statically from the reference graph: a pool's `member`, and any declaration that references a member-bound declaration (or the pool, standing for its member) in a `use: dependency` slot or reads one in a creation-time field, transitively. An `Http.Request` whose `client` is `!ref clusters` is one, as is an `Sql.Query` whose `connection` is a pool, an `Sql.Schema` over it, an `Sql.Transaction` over it, a resource inside an imported library whose `resources:` input is supplied with a pool, and a template body entry that reaches one. A step's `invoke:` of a member-bound declaration does not make the sequence holding it member-bound: the call is routed (below).
- **Routing:** a dispatch of a member-bound declaration goes to that declaration's instance in the member context of the member the innermost checkout of its pool holds. There is one member context per member and per module instance holding member-bound declarations; it is created when the member is built, lives as long as the member, and is torn down with it. So a member-bound declaration is created once per member, not once per call, and its controller is unchanged: a reference slot it reads, at creation or on every call, resolves inside that context to that member.
- **Not in a scope:** a member-bound declaration inside a `with:` scope is `MEMBER_BOUND_SCOPED` at that declaration, and `ERR_MEMBER_BOUND_SCOPED` at load. A scoped declaration lives for one run and may read that run's `inputs`; a member-bound one lives as long as its member and is shared by every caller of its key, so one declaration cannot be both. A scope reaches a pooled resource only by calling it — a step's `invoke: !ref <module-scope member-bound declaration>`.
- **One pool:** a declaration is bound to exactly one pool. One reachable from more than one is `MEMBER_BOUND_MULTIPLE_POOLS` at the declaration, naming each pool and the chain that bound it — at the `imports:` entry when a second pool reaches a library declaration through that import's `resources:` — and `ERR_MEMBER_BOUND_MULTIPLE_POOLS` at load. A declaration reaching two pools would need an instance per combination of members; work needing members of two pools nests two checkouts, each declaration bound to one of them.
- **Libraries:** of a library whose `resources:` input is supplied a pool, only its member-bound declarations exist per member. Everything else in it, its `lifecycle` included, is untouched.
- **Reading:** inside a checkout, `resources.<name>` of a member-bound declaration reads the instance of the member that checkout holds.
- **Transactions:** an `Sql.Transaction` over a pooled connection is itself member-bound, so its zone correlation resolves to the same member's connection its statements use.
- **Outside a checkout:** a reach of a member-bound declaration that no checkout of its pool covers is `ZONE_REQUIREMENT_UNSATISFIED`, and `ERR_ZONE_REQUIRED` at run time; both name the pool and the chain of references that made the declaration member-bound. That covers a dispatch, a detached or trigger dispatch (both start with no zones), a runtime-eval `resources.<name>` read, a boot target, a member-bound Service, Mount or Sink (a library's included), and a callable's data slot. Detached work that needs a member wraps its target in a checkout of its own.

**Durable execution:** a checkout's key is an ordinary input of the step that calls it, so a replay checks out the same key. A member-bound declaration as a durable step's own target has no encodable identity — its member is chosen at run time — so it is refused at the sender with `ERR_DURABLE_TARGET_UNENCODABLE`, the message naming the chain that bound it; durable work reaches a member through a step whose target is a checkout.

**Rust kernel:** refuses `Telo.KeyedPool` and `Telo.Checkout` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

*Example — one client per cluster:* the dashboard above. Every request for the same cluster id uses the same `Http.Client` and the same `Http.Request` instance; the database is read and the kubeconfig parsed only when that id has no member, and the token the parse yields is marked sensitive by the step that picks it out. The checkout wraps the request directly, so the request's own contract (`method`, `url`) is its `inputs`, and the step's `retry:` waits out a full pool or a timed-out build while a deterministic build failure is not retried.

```yaml
kind: Telo.Application
metadata: { name: K8sDashboard }
requires: { telo: ">=unreleased" }
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@0.14.4
  Sql: oci://ghcr.io/telorun/sql@0.31.4
  Yaml: oci://ghcr.io/telorun/yaml@0.11.1
  Http: oci://ghcr.io/telorun/http-client@0.25.0
  Server: oci://ghcr.io/telorun/http-server@0.44.2
variables:
  database: { env: DATABASE_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file }, default: ./clusters.db }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Telo.KeyedPool
metadata: { name: clusters }
buildTimeout: 10s
maxLifetime: 900s
maxMembers: 64
steps:
  - name: row
    invoke:
      kind: Sql.Query
      connection: { kind: SQLite.Connection, file: !cel "variables.database" }
    inputs: { sql: !sql "SELECT kubeconfig FROM clusters WHERE id = ${{ key }}" }
  - name: missing
    if: !cel "size(steps.row.result.rows) == 0"
    then:
      - name: notFound
        throw:
          code: CLUSTER_NOT_FOUND
          message: !interpolate "No cluster with id ${{ key }}"
          data: { clusterId: !cel "key" }
  - name: config
    invoke:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [text], properties: { text: { type: string } } }
      outputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [server, token]
          properties: { server: { type: string }, token: { type: string, x-telo-sensitive: true } }
      steps:
        - name: parse
          invoke: { kind: Yaml.Parse }
          inputs: { text: !cel "inputs.text" }
      outputs:
        server: !cel "steps.parse.result.docs[0].clusters[0].cluster.server"
        token: !cel "steps.parse.result.docs[0].users[0].user.token"
    inputs: { text: !cel "steps.row.result.rows[0].kubeconfig" }
member:
  kind: Http.Client
  baseUrl: !cel "steps.config.result.server"
  headers: { Authorization: !interpolate "Bearer ${{ steps.config.result.token }}" }
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref dashboardApi }
---
kind: Server.Api
metadata: { name: dashboardApi }
routes:
  - request:
      path: /clusters/{cluster}/pods
      method: GET
      schema:
        params: { type: object, required: [cluster], properties: { cluster: { type: string } } }
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [cluster], properties: { cluster: { type: string } } }
      steps:
        - name: list
          retry: { attempts: 3, initialDelay: 200ms, nonRetryable: [CLUSTER_NOT_FOUND, ERR_RESOURCE_INITIALIZATION_FAILED] }
          invoke:
            kind: Telo.Checkout
            pool: !ref clusters
            invoke: { kind: Http.Request, client: !ref clusters }
          inputs:
            key: !cel "inputs.cluster"
            inputs: { method: GET, url: /api/v1/pods }
      outputs: { pods: !cel "steps.list.result.body" }
    inputs: { cluster: !cel "request.params.cluster" }
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [pods], properties: { pods: { type: object } } }
            body: { pods: !cel "result.pods" }
    catches:
      - status: 404
        when: !cel "error.code == 'CLUSTER_NOT_FOUND'"
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: !cel "error.message" }
      - status: 503
        when: !cel "error.code == 'ERR_POOL_EXHAUSTED' || error.code == 'ERR_POOL_BUILD_TIMEOUT'"
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: pool busy }
      - status: 500
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: !cel "error.code" }
  - request: { path: /pool, method: GET }
    handler: { kind: Telo.Value, value: !cel "resources.clusters.status" }
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              required: [members, building]
              properties: { members: { type: integer }, building: { type: integer } }
            body: !cel "result"
```

`maxLifetime: 900s` picks up a rotated kubeconfig within fifteen minutes; `GET /pool` reports this replica's occupancy for sizing `maxMembers`.

*Example — a database per tenant, used by a library:* each tenant's notes live in their own SQLite file. `keyType` limits a tenant id to a safe file name; the pool's `targets` bring each member's database to its schema before its first query; the `Notes` library takes the pooled connection as its `resources:` input, so its query is built once per tenant and knows nothing about tenants.

`notes/telo.yaml`:

```yaml
kind: Telo.Library
metadata: { name: Notes, description: Lists the notes stored in one notes database. }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.31.4
resources:
  connection: { kind: Sql.Connection, description: The database holding the notes table. }
exports:
  resources: [listNotes]
---
kind: Telo.Sequence
metadata: { name: listNotes }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [notes]
    properties:
      notes:
        type: array
        items: { type: object, required: [id, body], properties: { id: { type: integer }, body: { type: string } } }
steps:
  - name: rows
    invoke: { kind: Sql.Query, connection: !ref connection }
    inputs: { sql: "SELECT id, body FROM notes ORDER BY id" }
outputs: { notes: !cel "steps.rows.result.rows" }
```

`telo.yaml`:

```yaml
kind: Telo.Application
metadata: { name: TenantNotes }
requires: { telo: ">=unreleased" }
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@0.14.4
  Server: oci://ghcr.io/telorun/http-server@0.44.2
  Notes:
    source: ./notes
    resources: { connection: !ref tenants }
variables:
  dataDir: { env: DATA_DIR, type: string, x-telo-type: { name: Telo.HostPath, entry: directory }, default: ./tenants }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Telo.KeyedPool
metadata: { name: tenants }
keyType:
  kind: Telo.JsonSchema
  schema: { type: string, pattern: "^[a-z0-9-]{1,40}$" }
idleTimeout: 600s
member:
  kind: SQLite.Connection
  file: !cel "variables.dataDir.joinPath(key + '.db')"
targets:
  - !ref schema
---
kind: SQLite.Schema
metadata: { name: schema }
connection: !ref tenants
tables:
  - kind: SQLite.Table
    table: notes
    columns: { id: { type: integer, primaryKey: true }, body: { type: text } }
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref notesApi }
---
kind: Server.Api
metadata: { name: notesApi }
routes:
  - request:
      path: /tenants/{tenant}/notes
      method: GET
      schema:
        params: { type: object, required: [tenant], properties: { tenant: { type: string } } }
    handler:
      kind: Telo.Checkout
      pool: !ref tenants
      invoke: !ref Notes.listNotes
    inputs: { key: !cel "request.params.tenant" }
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              required: [notes]
              properties:
                notes:
                  type: array
                  items: { type: object, required: [id, body], properties: { id: { type: integer }, body: { type: string } } }
            body: { notes: !cel "result.notes" }
    catches:
      - status: 400
        when: !cel "error.code == 'ERR_INPUT_INVALID'"
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: invalid tenant id }
      - status: 503
        when: !cel "error.code == 'ERR_POOL_EXHAUSTED' || error.code == 'ERR_POOL_BUILD_TIMEOUT'"
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: tenant pool busy }
      - status: 500
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: !cel "error.code" }
```

`schema` references the pool at its `connection` slot, so it is member-bound and runs once per member build — a no-op when the database already has its table; `listNotes`'s inline `Sql.Query` is member-bound through the import, while `listNotes` itself only calls it and stays a module-scope sequence. A tenant id `../etc` fails the checkout's input with `ERR_INPUT_INVALID` before any file is opened.

*Example — refused:* a boot target reaching the pool outside a checkout, a pooled request declared in a `with:` scope, a pool of a `Telo.Sequence`, and an integer key.

```yaml
kind: Telo.Application
metadata: { name: Refused }
requires: { telo: ">=unreleased" }
imports:
  Http: oci://ghcr.io/telorun/http-client@0.25.0
targets:
  - invoke: !ref probe
  - !ref perCall
---
kind: Telo.KeyedPool
metadata: { name: clusters }
member:
  kind: Http.Client
  baseUrl: !interpolate "https://${{ key }}.clusters.internal"
---
kind: Http.Request
metadata: { name: probe }
client: !ref clusters
---
kind: Telo.Sequence
metadata: { name: perCall }
with:
  - kind: Http.Request
    metadata: { name: scoped }
    client: !ref clusters
steps:
  - name: call
    invoke: !ref scoped
    inputs: { method: GET, url: /healthz }
---
kind: Telo.KeyedPool
metadata: { name: sequences }
member:
  kind: Telo.Sequence
  steps: []
---
kind: Telo.KeyedPool
metadata: { name: numbered }
keyType:
  kind: Telo.JsonSchema
  schema: { type: integer }
member:
  kind: Http.Client
  baseUrl: !interpolate "https://node-${{ key }}.clusters.internal"
```

```
$ telo check ./refused.yaml
refused.yaml:7:5    error  Telo.Application/Refused: target 'probe' reaches Http.Request/probe outside any
                           checkout of Telo.KeyedPool/clusters (probe.client → clusters)  ZONE_REQUIREMENT_UNSATISFIED
refused.yaml:23:5   error  Http.Request/scoped: bound to the members of Telo.KeyedPool/clusters
                           (scoped.client → clusters) and declared in a with: scope; declare it at
                           module scope and call it from the scope  MEMBER_BOUND_SCOPED
refused.yaml:34:3   error  Telo.KeyedPool/sequences: member kind Telo.Sequence is a Telo.Runnable; a pool
                           builds a Telo.Provider or a Telo.Invocable  POOL_MEMBER_CAPABILITY_UNSUPPORTED
refused.yaml:39:1   error  Telo.KeyedPool/numbered: keyType must be a string schema; convert an integer id
                           with string() at the checkout  POOL_KEY_TYPE_INVALID

4 errors

$ telo run ./refused.yaml
error  ERR_MANIFEST_VALIDATION_FAILED: refused.yaml has 4 errors (ZONE_REQUIREMENT_UNSATISFIED,
       MEMBER_BOUND_SCOPED, POOL_MEMBER_CAPABILITY_UNSUPPORTED, POOL_KEY_TYPE_INVALID); run telo check for details
```

*Verify:*
- **Building:** a fixture provider counting its constructions, pooled: three checkouts of one key build one member, two keys build two, concurrent first checkouts of one key run the pool's `steps` once, a failed build is retried by the next checkout, and each member-bound declaration is created at build time, before any of the checkout's steps run.
- **Creation failure:** a member-bound `Http.Client` that fails creation for key `bad` fails that checkout with `ERR_RESOURCE_INITIALIZATION_FAILED`, which a `catches:` entry naming it catches; the next checkout of `bad` rebuilds, and key `good` is unaffected; with the first example's `retry:`, a request for `bad` issues exactly one build.
- **Envelope:** `--inspect` traces the checkout's `key` and `inputs` verbatim, and a pool keyed `1` logs `1` verbatim elsewhere in its messages; with a `keyType` marked sensitive the key is `[redacted]` in member logs, traces and readings; a checkout wrapping a `Lease.Critical` forwards its `inputs` and returns the lease's output unchanged; a checkout whose target is a `Telo.Sequence` with `with:` holds the member until that sequence's dispatch closes.
- **Build credentials:** the first example under `--inspect` with a log sink: the `row`, `parse` and `config` dispatch payloads read `[redacted]`; the member's `Created` event shows `baseUrl` verbatim and the `Authorization` header redacted; the token appears in no reading, member log or traced output; a failed build's error `data` is `[redacted]` in its trace while a `catches:` entry reads `error.data.clusterId`; after 10,000 builds with idle eviction the module context's redaction set is the size it was before the first.
- **Sensitive key:** a pool with a sensitive `keyType` whose build fails once by a `throw` interpolating `key` and once by a creation failure whose `cause` message holds a path built from the key: the log sink's error (outer message and every `cause`) and the trace error show `[redacted]` where the key was, the same under `ERR_POOL_BUILD_TIMEOUT` for a dispatch traced after the timeout fired, while a `catches:` entry reading `error.message` sees it verbatim; with no sensitive mark the key logs verbatim; after 10,000 failed builds the module context's redaction set is the size it was before the first.
- **Scoped:** the refused example's `scoped` fails `telo check` with `MEMBER_BOUND_SCOPED` at that declaration, and load with `ERR_MEMBER_BOUND_SCOPED`.
- **Library Service:** a library Service whose creation-time field reads `resources.connection`, supplied a pool, fails `telo check` and boot with `ZONE_REQUIREMENT_UNSATISFIED`.
- **Per member, not per call:** the `Http.Request` in the first example is created once per cluster id across many requests, and requests for two cluster ids use two clients.
- **Per tenant:** the second example passes `telo check` unchanged; the first request for tenant `acme` creates `acme.db` with its `notes` table before the query runs, later requests while the member lives run no schema pass, the `Notes` query is created once per member, after `idleTimeout` and a new request the schema target runs again and changes nothing, and tenant `../etc` is answered 400 with no file created; a pool target reaching another pool's member-bound declaration fails `telo check` with `ZONE_REQUIREMENT_UNSATISFIED`.
- **Library input:** a pool whose member is an `Http.Client`, supplied to the `Notes` import's `connection`, is `RESOURCE_INPUT_KIND_MISMATCH` naming `Http.Client`, in both halves.
- **No consumer change:** no stdlib controller or kind schema changes for any of the above.
- **Outside a checkout:** the refused example's `probe` target, and the same request from a detached dispatch, fail `telo check` and boot, naming the pool.
- **Editor:** hover on a member-bound declaration names its pool and the chain of references that made it member-bound — the chain the refusals print. At `client: !ref clusters`, go-to-definition opens the pool, hover names the member's kind (`Http.Client`), rename of `clusters` rewrites both the checkout's `pool:` and every member reference, and the reference picker offers `clusters` at slots accepting `Http.Client`.
- **Reference:** `client: !ref clusters` at a slot of an incompatible kind is `REFERENCE_KIND_MISMATCH` in both halves; `!ref Clusters.clusters` from an importer of a library exporting the pool resolves with no parser change.
- **Lifetime:** after `idleTimeout` with no hold the fixture records one teardown, before it none; a member past `maxLifetime` while held is torn down only when released, and the next checkout builds a new one; a pool with no `maxLifetime` retires a continuously held member after 3600 s; with `maxMembers: 1`, a new key fails at once with `ERR_POOL_EXHAUSTED` while the one member is building, held, or retired but still held, and a step `retry:` with backoff naming it succeeds once the hold is released.
- **Status:** `resources.clusters.status.members` and `.building` follow builds and teardowns; under sustained traffic on held keys the status publication count equals builds plus teardowns.
- **Streams:** a watch streamed to an SSE client keeps its member past `idleTimeout`; it is torn down `idleTimeout` after the client disconnects, and not before.
- **Capability:** the refused example's `sequences` fails `telo check` and boot with `POOL_MEMBER_CAPABILITY_UNSUPPORTED`; `keyType: { kind: Telo.JsonSchema, schema: { type: integer } }` fails both with `POOL_KEY_TYPE_INVALID`; a pool whose member reads no `key` passes and builds one member per key.
- **Two pools:** a kind with two dependency slots supplied from two pools fails `telo check` and load with `MEMBER_BOUND_MULTIPLE_POOLS`, naming both; the same through a library is reported at its `imports:` entry.
- **Build timeout:** a fixture build step that never returns fails three concurrent waiters with `ERR_POOL_BUILD_TIMEOUT` after `buildTimeout`, its dispatch observes cancellation, and a step `retry:` naming the code succeeds once the dependency recovers; a fixture provider whose `init()` hangs and then succeeds counts toward `maxMembers: 1` until it settles, and is then torn down, never served.
- **Rust kernel:** a manifest declaring a `Telo.KeyedPool` or a `Telo.Checkout`, run on the Rust kernel, is refused with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the kind; `analyzer/rust` loads the new built-in entries and the check-conformance vectors cover the refusal.
- **Durable:** a member-bound declaration as a durable step's target is refused with `ERR_DURABLE_TARGET_UNENCODABLE` naming its chain; the same work through a checkout replays with the same key.

## Housekeeping

- **Agreement suite.** `tests/check-run-agreement.yaml` gains one row for each refusal, refused by both halves: a pool of a kind outside `Telo.Provider` / `Telo.Invocable`, a `keyType` that is not a string schema, a pool referenced at a slot of an incompatible kind, a member-bound declaration reached outside a checkout (from a boot target and from a detached dispatch), a member-bound declaration in a `with:` scope, and a declaration bound to two pools (direct and import-anchored).
- **Grammar floors**, under the "Changing the grammar" rule: `telo release floor` measures every module whose own file declares a `Telo.KeyedPool` or a `Telo.Checkout`; the examples' `>=unreleased` is what it writes until this ships.
- **Releases.** One fragment through `telo release add --kind Added` naming the units `kernel`, `sdk`, `analyzer` and `packages/ide-support` (the telo line, a minor bump), and one each for `apps/hub` and `apps/authoring-agent`. No module changes.
- **Built-in vocabulary.** `Telo.KeyedPool` (with `referenceResolvesTo`, `targets` and its `status:` block), `Telo.Checkout` and the codes `ERR_POOL_EXHAUSTED` and `ERR_POOL_BUILD_TIMEOUT` with their display messages are added to the built-in entries, and the `Telo.Builtins` archive is re-rendered; both analyzers read them, and the Rust kernel's refusal of both kinds joins the check-conformance vectors.
- **Benefits ledger.** One entry under Telo itself in `docs/guides/what-you-get.md`: per-key resources — `Telo.KeyedPool` with `Telo.Checkout` builds one client or connection per cluster, tenant or other key, migrates each one's database before first use, and reuses it across calls, with no id passed through the code that uses it.
- **Documentation:**
  - `docs/guides/keyed-pools.md`, with both examples, sizing `maxMembers` from `status.members` per replica against concurrently active keys, long holds and replica count (each replica keeps its own members, so backend connections scale as members times replicas), a step `retry:` naming `ERR_POOL_EXHAUSTED` and `ERR_POOL_BUILD_TIMEOUT` and listing deterministic build failures in `nonRetryable`, a cache or circuit breaker in front of a build whose backing store must not see a failing key on every request, `buildTimeout` against step `timeout:`, `maxLifetime` shortened for fast credential rotation and why retirement waits for the last hold, `keyType` and keying by a secret, that a build's payloads are withheld from traces and a credential is still marked where a step picks it out, `targets`, one pool per declaration, and why a pooled resource is declared at module scope.
  - `kernel/specs/logging.md` §14.5 gains the member — its set opened at build start, joined as a build's steps return, carried by a failed build's error — beside the scope run, and the build-payload withholding.
  - The analyzer guide: the pool reference rule and member-bound declarations; the kernel guide: routing member-bound declarations, member contexts and their lifetime.
  - The root guide: the two built-in kinds.
- **Hub guide.** `guide_design_library` (`apps/hub/guides/`): a library may take a pooled resource as a `resources:` input, and its declarations over it are then built per member.
- **Authoring agent primer.** In the same change: `Telo.KeyedPool` and `Telo.Checkout` build one resource per key and serve it to unchanged resources anywhere beneath the checkout, referenced by the pool's own name; a checkout is called with `{ key, inputs }`; a pool's `keyType` is a string schema that validates every key and marks a secret key sensitive, and `buildTimeout` bounds a build; a build's payloads never reach traces, a sensitive key is redacted in a failed build's messages (but not in an `error.message` CEL copies into a response), and a credential a pool's steps read is still marked `x-telo-sensitive` in the `outputType` of the step that picks it out; a pool's `targets` migrate each member's database; members retire after `maxLifetime` (default one hour); a pooled resource is never declared in a `with:` scope.
