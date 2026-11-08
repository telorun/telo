---
status: draft
priority: high
depends-on: [2026-10-29-per-invocation-scope-configuration.md]
packages: [analyzer, kernel, sdk, ide-support, authoring-agent, hub]
---

# Keyed pools

## Problem

A resource configured from request-time data cannot be shared, and cannot reach deep consumers. A cluster's client built from a kubeconfig stored in a database can only be built per call in a `with:` scope, rebuilt with its connections on every call; every resource using it must be redeclared in that scope, and the cluster id threaded through every contract down to it. A Kubernetes connector serving many clusters is the first consumer; nothing here is specific to it.

## Solution

### A keyed pool builds a resource per key, and a checkout chooses the key

*Before:* a resource whose configuration is known only during a call — a cluster's client built from a kubeconfig stored in a database — can be built only per call, inside a `with:` scope, together with its connections and TLS sessions. Every resource that uses it has to be redeclared in that scope, and the cluster id passed down through every contract between the request's edge and the place it is used.

*After:* two new built-in kinds. **`Telo.KeyedPool`** says how one member is built from a key and keeps the members it built. **`Telo.Checkout`** wraps an executable and takes the key from its caller beside the target's inputs, so every resource that dispatch reaches that depends on the pool uses that key's member. No consumer kind declares anything.

**`Telo.KeyedPool`**
- **Fields:**
  - `keyType` (optional): the key's schema, written like `inputType`; it must be a string schema (`POOL_KEY_TYPE_INVALID`, `ERR_POOL_KEY_TYPE_INVALID` at creation). Absent, a key is a non-empty string. A key is sensitive exactly when `keyType` marks it `x-telo-sensitive`.
  - `steps` (optional): the shared step grammar, run only when a key has no member. It reads `key`, typed from `keyType`. A resource declared inline in one of these steps is a module-scope declaration like any inline one: created once at load, shared by every build, and not member-bound unless it references the pool.
  - `member`: one full resource declaration, written as in a `with:` block. Its kind resolves through the declaring module's imports, it is validated as a top-level resource, and its creation-time fields read `key` and `steps.<name>.result`.
  - `targets` (optional): `!ref` entries naming `Telo.Runnable` declarations member-bound to this pool, run in order once the member and its bound declarations are created and before the member serves any checkout — a schema migration of each member's database. A failing target fails the build, with the codes a creation failure has; an entry not member-bound to this pool is `POOL_TARGET_NOT_MEMBER_BOUND`, and `ERR_POOL_TARGET_NOT_MEMBER_BOUND` at load.
  - `buildTimeout` (default `30s`, covering `targets`), `idleTimeout` (default `300s`), `maxLifetime` (no default; absent means members never age out) and `maxMembers` (default `64`).
- **A key nobody reads:** a pool whose `member` and `steps` never read `key` builds the same member for every key. It is `POOL_KEY_UNUSED` at the pool, and `ERR_POOL_KEY_UNUSED` at load.
- **What it can pool:** `member` must be a `Telo.Provider` or a `Telo.Invocable`; anything else is `POOL_MEMBER_CAPABILITY_UNSUPPORTED`, and `ERR_POOL_MEMBER_CAPABILITY_UNSUPPORTED` at creation.
- **Building a member:** a key with no member runs `steps`, then creates `member` and every module-scope declaration bound to that member (below), in one init loop under the build's root invocation context — the member is built whole, as an import is. A creation failure fails the build and reaches the checkout's caller as `ERR_RESOURCE_INITIALIZATION_FAILED`, carrying the root failure as `cause`, declared in `Telo.Checkout`'s throws. Concurrent checkouts of one key wait for the same build, so it runs once. No caller's cancellation, transaction or zone reaches it, and it runs until it completes or `buildTimeout` elapses; a waiter cancelling abandons only its own wait. On expiry every waiter fails with `ERR_POOL_BUILD_TIMEOUT`, declared retryable in `Telo.Checkout`'s throws, the build's own dispatches are cancelled and the key is cleared, so the next checkout builds again. An abandoned build counts toward `maxMembers` until it settles, and a creation that succeeds after expiry is torn down at once, never served. A failed build caches nothing, and the next checkout of that key builds again; its failure reaches every waiting checkout's caller unchanged, so the build's codes join the checkout's throws union. Pool steps that reach the pool's own members are `DEPENDENCY_CYCLE`.
- **Lifetime of a member:**
  - A member with no holds is torn down through its normal inverse chain after `idleTimeout`.
  - After `maxLifetime` a member is retired: later checkouts of its key build a new member, and the retired one is torn down when its last hold is released.
  - `maxMembers` bounds the live members of one process: being built, held, idle, and retired but still held all count. A checkout of a new key with no idle member to evict fails at once with `ERR_POOL_EXHAUSTED`, declared retryable in `Telo.Checkout`'s throws, so a step's `retry:` does the waiting; when some member is idle, the least recently used idle member is evicted to make room. Pools are process-local: each replica keeps its own members.
  - Idle and lifetime timers take no kernel hold. Shutdown tears every member down after the checkouts holding them have ended.
- **Reference:** `!ref <pool>` (or `!ref <Alias>.<pool>` for a pool an imported library exports) names the pool itself only at a slot whose kinds name `Telo.KeyedPool` — a checkout's `pool:`. At every other slot it stands for the member the innermost checkout of that pool holds, and is kind-checked against `member`'s kind; a mismatch is the existing `REFERENCE_KIND_MISMATCH`, naming the member's kind. The pool's built-in entry declares this as data (`referenceStandsFor: /member`), read generically by the reference resolver, the kernel and the editor's reference picker. `resources.<pool>` stays the pool's own reading.

**`Telo.Checkout`**
- **Fields:** `pool` (a `!ref` to a `Telo.KeyedPool`) and `invoke` (a `Telo.Executable`: an imported invocable, a `Lease.Critical`, a `Telo.Sequence` with its own `with:`, or the pool itself when its member is an invocable). It is a `Telo.Invocable`, declared like any resource: inline as a route handler or step target, or named at top level.
- **Contract:** input `{ key, inputs }` — `key` typed from `/pool/keyType`, `inputs` typed from `/invoke/inputType` (the scope plan's forwarding rule) and defaulting to `{}`; output typed from `/invoke/outputType`. The target's own contract stays unchanged: it never declares the key.
- **Throws:** the target's codes, `ERR_POOL_EXHAUSTED`, `ERR_POOL_BUILD_TIMEOUT`, `ERR_RESOURCE_INITIALIZATION_FAILED` and the build's codes.
- **Zone:** the `invoke` slot provides a zone correlated on `/pool`. The zone entry holds only the checkout's and the pool's identities, never the key; the pool keeps its own map from zone entry to member. The key traces verbatim unless `keyType` marks it sensitive, then as `[redacted]`.
- **Holding:** invoking a checkout takes a hold on the member of its `key` input (building it when needed) and dispatches `invoke` with its `inputs`. A checkout's exit is a hold-owning exit: streams leaving it are held, and the member hold is released by the scope plan's held-stream rule when the checkout's dispatch closes. The member context owns a redaction set for the member's lifetime, as a scope run holds its sensitive inputs: the key when `keyType` marks it sensitive, and every text value at a path a pool step's result type marks `x-telo-sensitive` (read from that step target's resolved `outputType`, string leaves beneath included). A credential read from an open result (a row, a parsed document) is picked out by an inline `Telo.Sequence` step whose `outputType` marks it, as the first example does with `token`.
- **Nesting:** a checkout reached inside another checkout's dispatch of the same pool takes over for its own target; the innermost one decides. A dispatch therefore uses one member per pool; using two members of one recipe at once means two pools.

**Member-bound declarations**
- **Which they are**, computed statically from the reference graph: a pool's `member`, and any declaration that references a member-bound declaration (or the pool, standing for its member) in a `use: dependency` slot or reads one in a creation-time field, transitively. An `Http.Request` whose `client` is `!ref clusters` is one, as is an `Sql.Query` whose `connection` is a pool, an `Sql.Transaction` over it, a resource inside an imported library whose `resources:` input is supplied with a pool, and a template body entry that reaches one.
- **Routing:** a dispatch of a member-bound declaration goes to that declaration's instance in the member context of the member the innermost checkout of its pool holds. There is one member context per member and per module instance holding member-bound declarations; it is created when the member is built, lives as long as the member, and is torn down with it. So a member-bound declaration is created once per member, not once per call, and its controller is unchanged: a reference slot it reads, at creation or on every call, resolves inside that context to that member.
- **Not in a scope:** a member-bound declaration inside a `with:` scope is `MEMBER_BOUND_SCOPED` at that declaration, and `ERR_MEMBER_BOUND_SCOPED` at load. A scoped declaration lives for one run and may read that run's `inputs`; a member-bound one lives as long as its member and is shared by every caller of its key, so one declaration cannot be both. A scope reaches a pooled resource only by calling it — a step's `invoke: !ref <module-scope member-bound declaration>` — never through a scoped declaration's dependency slot or creation-time field, which would make that declaration member-bound.
- **One pool:** a declaration is bound to exactly one pool. One reachable from more than one is `MEMBER_BOUND_MULTIPLE_POOLS` at the declaration, naming each pool and the chain that bound it — at the `imports:` entry when a second pool reaches a library declaration through that import's `resources:` — and `ERR_MEMBER_BOUND_MULTIPLE_POOLS` at load. Work needing members of two pools nests two checkouts, each declaration bound to one of them.
- **Libraries:** of a library whose `resources:` input is supplied a pool, only its member-bound declarations exist per member. Everything else in it, its `lifecycle` included, is untouched.
- **Reading:** inside a checkout, `resources.<name>` of a member-bound declaration reads the instance of the member that checkout holds.
- **Transactions:** an `Sql.Transaction` over a pooled connection is itself member-bound, so its zone correlation resolves to the same member's connection its statements use.
- **Outside a checkout:** a reach of a member-bound declaration that no checkout of its pool covers is `ZONE_REQUIREMENT_UNSATISFIED`, and `ERR_ZONE_REQUIRED` at run time; both name the pool and the chain of references that made the declaration member-bound. That covers a dispatch, a detached or trigger dispatch (both start with no zones), a runtime-eval `resources.<name>` read, a boot target, a member-bound Service, Mount or Sink (a library's included), and a callable's data slot. Detached work that needs a member wraps its target in a checkout of its own.

**Durable execution:** a checkout's key is an ordinary input of the step that calls it, so a replay checks out the same key. A member-bound declaration as a durable step's own target has no encodable identity — its member is chosen at run time — so it is refused at the sender with `ERR_DURABLE_TARGET_UNENCODABLE`, the message naming the chain that bound it; durable work reaches a member through a step whose target is a checkout.

**Rust kernel:** refuses `Telo.KeyedPool` and `Telo.Checkout` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

*Example — one client per cluster:* a dashboard serving each cluster's pods, its kubeconfig stored in a database. Every request for the same cluster id uses the same `Http.Client` and the same `Http.Request` instance; the database is read and the kubeconfig parsed only when that id has no member, and the token the parse yields is marked sensitive by the step that picks it out. The checkout wraps the request directly, so the request's own contract (`method`, `url`) is its `inputs`, and the step's `retry:` waits out a full pool or a timed-out build.

```yaml
kind: Telo.Application
metadata: { name: K8sDashboard }
requires: { telo: ">=0.134.0" }
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@0.13.0
  Sql: oci://ghcr.io/telorun/sql@0.30.0
  Yaml: oci://ghcr.io/telorun/yaml@0.11.1
  Http: oci://ghcr.io/telorun/http-client@0.25.0
  Server: oci://ghcr.io/telorun/http-server@0.42.0
variables:
  database: { env: DATABASE_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file } }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Telo.KeyedPool
metadata: { name: clusters }
buildTimeout: 10s
idleTimeout: 300s
maxLifetime: 3600s
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
          retry: { attempts: 3, initialDelay: 200ms, nonRetryable: [CLUSTER_NOT_FOUND] }
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
```

Refused: a boot target `- invoke: !ref probe`, where `probe` is a named `Http.Request` document with `client: !ref clusters`, outside any checkout, is `ZONE_REQUIREMENT_UNSATISFIED` under `telo check`, naming `clusters` and the `client` reference; `ERR_ZONE_REQUIRED` at boot. A `Telo.Sequence` as `member` is `POOL_MEMBER_CAPABILITY_UNSUPPORTED`.

*Verify:*
- **Building:** a fixture provider counting its constructions, pooled: three checkouts of one key build one member, two keys build two, concurrent first checkouts of one key run the pool's `steps` once, a failed build is retried by the next checkout, and each member-bound declaration is created at build time, before any of the checkout's steps run.
- **Creation failure:** a member-bound `Http.Client` that fails creation for key `bad` fails that checkout with `ERR_RESOURCE_INITIALIZATION_FAILED`, which a `catches:` entry naming it catches; the next checkout of `bad` rebuilds, and key `good` is unaffected.
- **Envelope:** `--inspect` traces the checkout's `key` and `inputs` verbatim, and a pool keyed `1` logs `1` verbatim elsewhere in its messages; with a `keyType` marked sensitive the key is `[redacted]` in member logs, traces and readings; a checkout wrapping a `Lease.Critical` forwards its `inputs` and returns the lease's output unchanged; a checkout whose target is a `Telo.Sequence` with `with:` holds the member until that sequence's dispatch closes.
- **Scoped:** a `Telo.Sequence` whose `with:` declares an `Http.Request` with `client: !ref clusters` fails `telo check` with `MEMBER_BOUND_SCOPED` at that declaration, and load with `ERR_MEMBER_BOUND_SCOPED`.
- **Library Service:** a library Service whose creation-time field reads `resources.connection`, supplied a pool, fails `telo check` and boot with `ZONE_REQUIREMENT_UNSATISFIED`.
- **Per member, not per call:** the `Http.Request` in the first example is created once per cluster id across many requests, and requests for two cluster ids use two clients.
- **No consumer change:** no stdlib controller or kind schema changes for any of the above.
- **Outside a checkout:** the refused boot target, and the same request from a detached dispatch, fail `telo check` and boot, naming the pool.
- **Editor:** hover on a member-bound declaration names its pool and the chain of references that made it member-bound — the chain the refusals print. At `client: !ref clusters`, go-to-definition opens the pool, hover names the member's kind (`Http.Client`), rename of `clusters` rewrites both the checkout's `pool:` and every member reference, and the reference picker offers `clusters` at slots accepting `Http.Client`.
- **Reference:** `client: !ref clusters` at a slot of an incompatible kind is `REFERENCE_KIND_MISMATCH` in both halves; `!ref Clusters.clusters` from an importer of a library exporting the pool resolves with no parser change.
- **Lifetime:** after `idleTimeout` with no hold the fixture records one teardown, before it none; a member past `maxLifetime` while held is torn down only when released, and the next checkout builds a new one; with `maxMembers: 1`, a new key fails at once with `ERR_POOL_EXHAUSTED` while the one member is building, held, or retired but still held, and a step `retry:` with backoff naming it succeeds once the hold is released.
- **Streams:** a watch streamed to an SSE client keeps its member past `idleTimeout`; it is torn down `idleTimeout` after the client disconnects, and not before.
- **Capability:** a `Telo.Service` as a pool's `member` fails `telo check` and boot with the pool-capability code; `keyType: { kind: Telo.JsonSchema, schema: { type: integer } }` fails both with `POOL_KEY_TYPE_INVALID`.
- **Build credentials:** the first example under `--inspect` with a log sink: the token appears in no `Created` event, reading, member log or traced step output, while `baseUrl` stays verbatim; after 10,000 builds with idle eviction the module context's redaction set is the size it was before the first.
- **Two pools:** a kind with two dependency slots supplied from two pools fails `telo check` and load with `MEMBER_BOUND_MULTIPLE_POOLS`, naming both; the same through a library is reported at its `imports:` entry.
- **Build timeout:** a fixture build step that never returns fails three concurrent waiters with `ERR_POOL_BUILD_TIMEOUT` after `buildTimeout`, its dispatch observes cancellation, and a step `retry:` naming the code succeeds once the dependency recovers; a fixture provider whose `init()` hangs and then succeeds counts toward `maxMembers: 1` until it settles, and is then torn down, never served.

## Decisions

- **A member is built whole.** The pool's `steps`, `member` and every module-scope declaration bound to it are created in one init loop, so a creation failure is a build failure with a declared code, never a creation scattered across later dispatches.
- **A build is bounded by the pool.** It runs detached from every caller, so no caller's deadline reaches it; `buildTimeout` is what keeps one hung dependency from freezing a key and, after `maxMembers` such keys, the whole pool.
- **A full pool sheds load.** A new key with no idle member to evict fails at once with retryable `ERR_POOL_EXHAUSTED`; the caller's `retry:` is the one waiting layer, since a freed member serves only its own key and a hold can last as long as a stream.
- **A checkout takes `{ key, inputs }` and adds a hold and a zone; it has no step body.** The caller knows the key and the target does not, so the target's contract stays its own; a step body of its own would be a second copy of `Telo.Sequence`.
- **A pool is referenced by its own name.** A member is chosen at run time, so a structural member path would be a false address and a second way to reach inline declarations; the built-in entry's `referenceStandsFor` keeps the rule data rather than a kind-name check.
- **The pool owns the key's type.** The build consumes the key, so `keyType` validates it for every caller and says, through `x-telo-sensitive`, whether it is a secret; cluster ids stay visible to operators by default.
- **A declaration is bound to one pool.** A declaration reaching two pools would need an instance per combination of members and could mix two keys' backends; refusing it keeps "a member is built whole" true.
- **A pool migrates what it builds.** A member-bound schema run in the pool's `targets` gives each member's database its tables before its first checkout, inside the bounded build, rather than through a boot target that would have to open every member's database at start.

## Housekeeping

- **Agreement suite.** `tests/check-run-agreement.yaml` gains one row for each refusal, refused by both halves: a pool of a kind outside `Telo.Provider` / `Telo.Invocable`, a `keyType` that is not a string schema, a pool whose key nothing reads, a pool `targets` entry not bound to it, a pool referenced at a slot of an incompatible kind, a member-bound declaration reached outside a checkout (from a boot target and from a detached dispatch), a member-bound declaration in a `with:` scope, and a declaration bound to two pools (direct and import-anchored).
- **Grammar floors**, under the "Changing the grammar" rule: `telo release floor` measures every module whose own file declares a `Telo.KeyedPool` or a `Telo.Checkout`. The example writes `>=0.134.0`, after the release carrying the scope plan; it is whatever release ships this.
- **Releases.** One changeset naming `@telorun/analyzer`, `@telorun/kernel`, `@telorun/sdk` and `@telorun/ide-support` (one telo version line, a minor bump). No module changes.
- **Built-in vocabulary.** `Telo.KeyedPool` (with `referenceStandsFor` and `targets`), `Telo.Checkout` and the codes `ERR_POOL_EXHAUSTED` and `ERR_POOL_BUILD_TIMEOUT` with their display messages are added to the built-in entries, and the `Telo.Builtins` archive is re-rendered; both analyzers read them.
- **Benefits ledger.** One entry under Telo itself in `docs/guides/what-you-get.md`: per-key resources — `Telo.KeyedPool` with `Telo.Checkout` builds one client or connection per cluster or other key, reused across calls, with no id passed through the code that uses it.
- **Documentation:**
  - `docs/guides/keyed-pools.md`, with the cluster example, sizing `maxMembers` against concurrently active keys, long holds and replica count (each replica keeps its own members, so backend connections scale as members times replicas), a step `retry:` naming `ERR_POOL_EXHAUSTED` and `ERR_POOL_BUILD_TIMEOUT`, `buildTimeout` against step `timeout:`, `keyType` and keying by a secret, marking a credential a build reads with an inline step's `outputType`, `targets`, one pool per declaration, and why a pooled resource is declared at module scope.
  - The analyzer guide: the pool reference rule and member-bound declarations; the kernel guide: routing member-bound declarations, member contexts and their lifetime.
  - The root guide: the two built-in kinds.
- **Hub guide.** `guide_design_library` (`apps/hub/guides/`): a library may take a pooled resource as a `resources:` input, and its declarations over it are then built per member.
- **Authoring agent primer.** In the same change: `Telo.KeyedPool` and `Telo.Checkout` build one resource per key and serve it to unchanged resources anywhere beneath the checkout, referenced by the pool's own name; a checkout is called with `{ key, inputs }`; a pool's `keyType` validates every key and marks a secret key sensitive, and `buildTimeout` bounds a build; a credential a pool's steps read is marked `x-telo-sensitive` in the `outputType` of the step that picks it out; a pool's `targets` migrate each member's database; a pooled resource is never declared in a `with:` scope.
