---
status: draft
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, ide-support, run, lease, idempotency, idempotency-sql, cache, authoring-agent, hub]
---

# Per-invocation scope configuration

## Problem

A `with:` scope creates its resources when an invocation of its owner enters the scope, and tears them down when it leaves. Each run gets its own instances. So a scope is the natural home for a resource whose configuration belongs to one invocation: a credential a caller supplies, an endpoint chosen per request. Four gaps stop it being used that way, or stop it scaling past one call.

1. **A scoped declaration cannot read the invocation that created it.** Its fields expand against the module's scope alone, meaning `variables`, `secrets` and `resources`, while the owner's step body, a few lines below, already sees `inputs`. The only way to configure a scoped resource per call is not to scope it, which puts the value back at module level where every caller shares it.
2. **A stream produced by a scoped resource breaks when the scope ends.** A sequence returning a model's streamed reply, or handing it to detached work, ends its run, the scope is torn down, and the consumer's next pull fails with whatever the disposed resource throws, far from the line that caused it.
3. **`x-telo-sensitive` stops at a forwarding kind.** `Lease.Critical`, `Idempotency.Once` and `Run.Detach` take a payload in their own invocation contract and dispatch it as the inputs of the resource in their `invoke` slot. Their contract declares that payload as an open object, so a credential passing through one is carried verbatim on the `--inspect` debug wire even when the target's contract marks it sensitive, and nothing checks the payload against the target's contract.
4. **A resource configured from request-time data cannot be shared, and cannot reach deep consumers.** A cluster's client built from a kubeconfig in a database, or a tenant's connection, can only be built per call in a `with:` scope, rebuilt with its connections on every call; every resource using it must be redeclared in that scope, and the cluster or tenant id threaded through every contract down to it.

The authoring agent's bring-your-own-key design is the first consumer of the first three; a Kubernetes connector serving many clusters from kubeconfigs stored in a database, and multi-tenant applications holding one connection per tenant, are the first consumers of the fourth. None is specific to either.

## Solution

### 1. A scope reads its opening invocation's `inputs`

*Before:* a field of a resource declared in a `with:` block sees `variables`, `secrets` and `resources`; reading `inputs` there is `CEL_UNKNOWN_IDENTIFIER`. A per-caller key cannot be a scoped resource's configuration:

```yaml
kind: Telo.Application
metadata: { name: ByokChat }
imports:
  Http: oci://ghcr.io/telorun/http-client@0.25.0
  Server: oci://ghcr.io/telorun/http-server@0.42.0
  Anthropic: oci://ghcr.io/telorun/anthropic@0.8.0
  Ndjson: oci://ghcr.io/telorun/ndjson-codec@0.10.1
secrets:
  anthropicKey: { env: ANTHROPIC_API_KEY, type: string }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref chatApi }
---
kind: Server.Api
metadata: { name: chatApi }
routes:
  - request:
      path: /chat
      method: POST
      schema:
        body: { type: object, required: [prompt], properties: { prompt: { type: string } } }
    handler:
      kind: Anthropic.MessagesModelStream
      model: claude-sonnet-5-5
      maxTokens: 1024
      request:
        kind: Http.Request
        client:
          kind: Anthropic.Client
          credential: { kind: Http.ApiKeyHeader, header: x-api-key, key: !cel "secrets.anthropicKey" }
    inputs:
      messages:
        - { role: user, content: !cel "request.body.prompt" }
    returns:
      - status: 200
        mode: stream
        content:
          application/x-ndjson:
            encoder: { kind: Ndjson.Encoder }
    catches:
      - status: 502
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: !cel "error.code" }
```

*After:* a scoped declaration's **creation-time fields** can read `inputs`: the inputs of the invocation that opened this run of the scope. Creation-time fields are those marked `x-telo-eval: compile`, plus every field of a provider. The value is exactly what the owner's step body sees: validated against the owner's bound invocation contract, with its declared defaults filled. An inline declaration nested inside a scoped one is a member of the same scope and reads `inputs` too.

```yaml
kind: Telo.Application
metadata: { name: ByokChat }
requires: { telo: ">=0.132.0" }
imports:
  Http: oci://ghcr.io/telorun/http-client@0.25.0
  Server: oci://ghcr.io/telorun/http-server@0.42.0
  Anthropic: oci://ghcr.io/telorun/anthropic@0.8.0
  Ndjson: oci://ghcr.io/telorun/ndjson-codec@0.10.1
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref chatApi }
---
kind: Server.Api
metadata: { name: chatApi }
routes:
  - request:
      path: /chat
      method: POST
      schema:
        headers: { type: object, required: [x-model-key], properties: { x-model-key: { type: string } } }
        body: { type: object, required: [prompt], properties: { prompt: { type: string } } }
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [apiKey, prompt]
          properties: { apiKey: { type: string, x-telo-sensitive: true }, prompt: { type: string } }
      with:
        - kind: Anthropic.MessagesModelStream
          metadata: { name: model }
          model: claude-sonnet-5-5
          maxTokens: 1024
          request:
            kind: Http.Request
            client:
              kind: Anthropic.Client
              credential: { kind: Http.ApiKeyHeader, header: x-api-key, key: !cel "inputs.apiKey" }
      steps:
        - name: reply
          invoke: !ref model
          inputs:
            messages:
              - { role: user, content: !cel "inputs.prompt" }
      outputs: { output: !cel "steps.reply.result.output" }
    inputs:
      apiKey: !cel "request.headers['x-model-key']"
      prompt: !cel "request.body.prompt"
    returns:
      - status: 200
        mode: stream
        content:
          application/x-ndjson:
            encoder: { kind: Ndjson.Encoder }
    catches:
      - status: 502
        content:
          application/json:
            schema: { type: object, required: [error], properties: { error: { type: string } } }
            body: { error: !cel "error.code" }
```

Refused: writing the credential's `key` as `!cel "inputs.apikey"` is `CEL_UNKNOWN_FIELD` at that line under `telo check`, and the kernel refuses the same manifest at load.

- **Typing:** the reader that types `inputs` in the owner's step body types it here, so the two cannot disagree.
- **Opened by `run()`:** a scope whose owner runs with no inputs (a sequence run as a boot target) sees the contract's defaults over an empty object, as its step body does.
- **Lifetime:** evaluated once per scope entry, when the scoped resource is created. A scoped resource never re-reads `inputs` mid-scope, and two concurrent runs each see their own.
- **Runtime-eval fields are unchanged.** Many already bind an `inputs` of their own — that resource's own call — so binding the opening invocation's there too would make one name mean two things at one site. A value a per-call field needs from the opening invocation is lifted into a creation-time field.
- **`steps` is not bound.** Scoped resources are created at scope entry, before any step has run.
- **Static consequence:** a creation-time field that reads `inputs` is no longer a constant known at load. Every analyzer pass that resolves a creation-time value statically — resource rules, a ref slot's use chosen by a sibling field, value checks against literals — treats it as unresolved, as it already treats a field reading another resource's published state, and never folds it to a default. For a use case map, unresolved means the union of its cases.
- **Kernel and SDK:** opening a scope takes the opening invocation's inputs as a required argument of the SDK's scope-handle surface, so a controller cannot open one without them. `Telo.Sequence` and its deprecated twin `Run.Sequence` pass their invocation's inputs.
- **Editor:** the editor's CEL scope query offers `inputs` at exactly these sites, completion and hover included.
- **Nested scope:** a scope sees the inputs of the invocation that opened *it*, never those of an enclosing scope.
- **Redaction:** each scope run owns a redaction set of its own, layered over its module context's: the text values of the opening inputs at every path the owner's input contract marks `x-telo-sensitive`, string leaves beneath included. It is filled at scope entry and discarded with the run, and every log record, debug-wire event, published reading, trace payload and error value written under the run is redacted by it — so `apiKey` above is `[redacted]` in the scoped credential's configuration and in the `Bearer`-interpolated form alike. A sensitive non-string scalar is not value-redacted, and a short sensitive value redacts every occurrence of its text, as a secret's does.

*Verify:*
- The example above, called concurrently with two keys, sends each key on its own upstream call only.
- The `inputs.apikey` variant fails `telo check` with `CEL_UNKNOWN_FIELD` at that line, and fails at load.
- A scoped resource's `detach:` field that reads `inputs` puts both of its ref slot's uses into the call graph.
- Completion in `key:` lists `apiKey` and `prompt`.
- The example under `--inspect` with a log sink, called concurrently with two keys: neither key appears in any `Created` event, published reading, log record, trace payload or error value; after 10,000 requests the module context's redaction set is the size it was before the first.

### 2. A scope lives until the streams leaving it settle

*Before:* a scope run ends when its owner returns. A stream in the returned value — the example above returns the model's reply — is pulled after the model was torn down.

*After:* a scope run ends only when both hold: its owner has produced its value, and every stream reachable from a value leaving the run has settled — finished, failed, or cancelled by its consumer. A value leaves the run by being returned, or by being handed to a detached or trigger dispatch as its inputs.

- **Held streams.** A stream reachable from a value leaving a scope run — returned, or in a detached or trigger dispatch's inputs — is *held*, and so is a stream leaving a dispatch that owns a held stream (a mapped or decoded one). The kernel wraps a held stream to observe when it settles; a stream with no scope behind it is never wrapped, tracked or cancelled.
- **Found by value, only where a hold exists.** The kernel walks a value — maps, lists, and each item of a held stream as its consumer pulls it, never ahead of the consumer and with nothing buffered — at a scope run's end, at a checkout's exit, at a detached or trigger dispatch issued inside a scope run or by a dispatch owning a held stream, and at the return of a dispatch that owns a live held stream. No other dispatch looks at its value, and a walk skips a subtree whose resolved contract is closed and holds no live value type. A stream derived from a scoped one, a stream at an open or untyped path, and a stream inside an item (a multipart part's `content`) are covered alike.
- **SDK:** closing a scope takes the run's produced value as a required argument and returns it with its streams wrapped, the counterpart of the required opening inputs.
- **Detached work** holds the scope run until every stream in its inputs settles, so a scoped stream handed to detached work keeps the scope open until that work drains it. Nothing is refused statically.
- **Ownership.** A held stream found in a dispatch's returned value is registered with the dispatch that called it; one in a detached or trigger dispatch's inputs with that dispatch. A dispatch's ownership closes when it has produced its value and every stream leaving it has settled, and the kernel then cancels every held stream it still owns. So a held stream nobody reads — a route whose `returns:` reads only `result.usage` beside a returned `output` stream, a sequence ignoring a step's stream — is cancelled when the dispatch that received it ends, and its scope is torn down then. A derived stream keeps its source alive, since the source is cancelled only once the derived stream has settled.
- **Roots.** A context an inbound source opens (one per HTTP request) owns until it is disposed or cancelled; every in-repo inbound transport that reads a stream from a dispatch result (HTTP routes, MCP, SSE, channels) dispatches under a context it opens. The boot runner opens one owner for the whole `targets:` run, closed when the last target returns. The bare root owns nothing: a held stream that would pass to it — a schedule tick's or a queue message's result — is cancelled at once and its scope released.
- **Outside the guarantee:** a held stream a controller pulls after its dispatch returns without having dispatched under a context it opened — its pull raises `ERR_INVOKE_CANCELLED`, saying the stream reached a caller that opened no context — and a stream hidden inside a host object that is neither a map, a list nor a stream. A position a body does read is held until its reader consumes it or the dispatch closes, so a loop calling a scoped stream-returning step and ignoring the stream keeps each turn's scope until the loop returns.

The same rule governs a checkout's hold (section 4).

*Verify:*
- In the section 1 example the model's teardown is recorded after the last chunk reaches the client, and after a client that disconnects mid-reply, never before.
- A reply mapped by a module-level stage and returned keeps the scope open the same way.
- The same handler with an `outputType` declaring `additionalProperties: true` and no stream type keeps the scope open the same way.
- A scoped stream handed to `Run.Detach` keeps the scope open until the detached body drains it.
- The section 1 handler returning `{ output, usage }` behind a route whose `returns:` reads only `result.usage`: the model's teardown is recorded right after each response is written, and the live-scope count stays flat over 10,000 requests; a sequence ignoring a stream step result tears its scope down at return.
- A sequence returning a decoded or mapped stream keeps the source alive until the derived stream settles, and cancels the source only then.
- A scoped multipart parse returned from a sequence keeps the scope open until the last part's `content` is drained or cancelled.
- A bytes stream returned through a scope costs one type test per chunk, and memory stays flat over a large stream of structured items.
- 10,000 `Schedule.Interval` ticks, 10,000 `Queue.Worker` messages and a boot target, each returning the section 1 handler's `{ output, usage }` with only `usage` read: the live-scope count stays flat, each teardown recorded at that delivery's return.
- A dispatch with an open `outputType` returning a 20 MB parsed body, with no held stream in play, performs no walk; an unscoped stream returned through three dispatches reaches its consumer as the identical, unwrapped object.
- `telo check` reports nothing for any of these.

### 3. Sensitivity marks survive a forwarding kind

*Before:* `Lease.Critical`, `Idempotency.Once` and `Run.Detach` declare the payload they forward as an open object. With this application, the `nightly` invocation's traced inputs carry the token verbatim:

```yaml
kind: Telo.Application
metadata: { name: NightlyReport }
imports:
  Lease: oci://ghcr.io/telorun/lease@0.14.1
  KvMemory: oci://ghcr.io/telorun/kv-store-memory@0.8.1
  Http: oci://ghcr.io/telorun/http-client@0.25.0
secrets:
  reportToken: { env: REPORT_TOKEN, type: string }
targets:
  - invoke: !ref nightly
    inputs:
      key: nightly-report
      inputs: { token: !cel "secrets.reportToken", day: "2026-11-06" }
---
kind: Lease.Critical
metadata: { name: nightly }
store: { kind: KvMemory.Store }
ttl: 600s
invoke:
  kind: Telo.Sequence
  inputType:
    kind: Telo.JsonSchema
    schema:
      type: object
      required: [token, day]
      properties: { token: { type: string, x-telo-sensitive: true }, day: { type: string } }
  steps:
    - name: send
      invoke: { kind: Http.Request, client: { kind: Http.Client, baseUrl: "https://reports.example.test" } }
      inputs:
        method: POST
        url: /reports
        headers: { Authorization: !interpolate "Bearer ${{ inputs.token }}" }
        body: { day: !cel "inputs.day" }
```

```json
{ "key": "nightly-report", "inputs": { "token": "s3cr3t-token", "day": "2026-11-06" } }
```

*After:* each forwarding kind types its forwarded node with the existing `x-telo-value-schema-from`, pointing at its slot target's contract. `Lease.Critical`'s `inputs` property, before and after:

```yaml
inputs:
  type: object
  additionalProperties: true
  description: Inputs forwarded to the wrapped `invoke` body when the lease is acquired.
```

```yaml
inputs:
  type: object
  description: Inputs forwarded to the wrapped `invoke` body when the lease is acquired.
  x-telo-value-schema-from: /invoke/inputType
```

The application changes only by importing the `lease` release that carries this (`0.15.0`, the next minor at writing):

```yaml
kind: Telo.Application
metadata: { name: NightlyReport }
imports:
  Lease: oci://ghcr.io/telorun/lease@0.15.0
  KvMemory: oci://ghcr.io/telorun/kv-store-memory@0.8.1
  Http: oci://ghcr.io/telorun/http-client@0.25.0
secrets:
  reportToken: { env: REPORT_TOKEN, type: string }
targets:
  - invoke: !ref nightly
    inputs:
      key: nightly-report
      inputs: { token: !cel "secrets.reportToken", day: "2026-11-06" }
---
kind: Lease.Critical
metadata: { name: nightly }
store: { kind: KvMemory.Store }
ttl: 600s
invoke:
  kind: Telo.Sequence
  inputType:
    kind: Telo.JsonSchema
    schema:
      type: object
      required: [token, day]
      properties: { token: { type: string, x-telo-sensitive: true }, day: { type: string } }
  steps:
    - name: send
      invoke: { kind: Http.Request, client: { kind: Http.Client, baseUrl: "https://reports.example.test" } }
      inputs:
        method: POST
        url: /reports
        headers: { Authorization: !interpolate "Bearer ${{ inputs.token }}" }
        body: { day: !cel "inputs.day" }
```

Its traced inputs:

```json
{ "key": "nightly-report", "inputs": { "token": "[redacted]", "day": "2026-11-06" } }
```

- **Redaction:** an instance's input-sensitive paths are read from its resolved contract, so a node typed from its target's contract carries the target's `x-telo-sensitive` marks. A target whose contract cannot be resolved statically (a kind-only dispatch) leaves the node unconstrained: no static check, and redaction withholds the forwarded value whole, the existing rule.
- **Checking:** the payload is checked against the target's contract by the existing call-site check. Refused: dropping `day` from the target's `inputs` above is `CONTRACT_INPUTS_MISMATCH` at that line under `telo check`, and `ERR_INPUT_INVALID` at the lease's own dispatch.
- **The rule:** a kind that forwards a payload to a slot's target unchanged types the forwarded node from that target's contract, and a result it hands back from the target's `outputType`, so marks and checks travel both ways. A kind that maps its caller's data rather than forwarding it types that data by a declaration of its own, never an open object. The rule is stated for kind authors in the analyzer guide's `x-telo-value-schema-from` entry and under `docs/extend/`; whether a kind forwards is controller behaviour, so a third-party kind is covered only when it follows the rule.
- **Adopters:** `Lease.Critical` (`inputs`; `result` from `/invoke/outputType`), `Idempotency.Once` (`inputs`; `result` from `/invoke/outputType`), `IdempotencySql.Once` (`inputs`), `Cache.View` (its `inputType` root beside its own `key`; `value` from the target's output) and `Run.Detach` (its whole `inputType`, at the contract root), the input nodes pointing at `/invoke/inputType`; the new `Telo.Checkout` (section 4) is built the same way, at `inputs` on input and at the root on output. `Run.Detach`'s contract, before and after:

```yaml
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: true
    description: Inputs passed through to the wrapped target at dispatch time.
```

```yaml
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    description: Inputs passed through to the wrapped target at dispatch time.
    x-telo-value-schema-from: /invoke/inputType
```

*Verify:*
- The example traces `[redacted]` for `token` under `--inspect`, and `day` verbatim, for the lease, both idempotency claims, the cache view and the detach alike; a body whose `outputType` marks a field sensitive traces it `[redacted]` in the result of `Lease.Critical` and `Idempotency.Once`. `Sql.Transaction` maps its caller's data through its own `inputs:` field and is not an adopter: a sensitive value routed through a transaction is still traced verbatim.
- The `day`-less variant fails `telo check` with `CONTRACT_INPUTS_MISMATCH` and the run with `ERR_INPUT_INVALID`.

### 4. A keyed pool builds a resource per key, and a checkout chooses the key

*Before:* a resource whose configuration is known only during a call — a cluster's client built from a kubeconfig stored in a database, a tenant's database connection — can be built only per call, inside a `with:` scope, together with its connections and TLS sessions. Every resource that uses it has to be redeclared in that scope, and the tenant or cluster id passed down through every contract between the request's edge and the place it is used.

*After:* two new built-in kinds. **`Telo.KeyedPool`** says how one member is built from a key and keeps the members it built. **`Telo.Checkout`** wraps an executable and takes the key from its caller beside the target's inputs, so every resource that dispatch reaches that depends on the pool uses that key's member. No consumer kind declares anything.

**`Telo.KeyedPool`**
- **Fields:**
  - `keyType` (optional): the key's schema, written like `inputType`; it must be a string schema (`POOL_KEY_TYPE_INVALID`, `ERR_POOL_KEY_TYPE_INVALID` at creation). Absent, a key is a non-empty string. A key is sensitive exactly when `keyType` marks it `x-telo-sensitive`.
  - `steps` (optional): the shared step grammar, run only when a key has no member. It reads `key`, typed from `keyType`. A resource declared inline in one of these steps is a module-scope declaration like any inline one: created once at load, shared by every build, and not member-bound unless it references the pool.
  - `member`: one full resource declaration, written as in a `with:` block. Its kind resolves through the declaring module's imports, it is validated as a top-level resource, and its creation-time fields read `key` and `steps.<name>.result`.
  - `buildTimeout` (default `30s`), `idleTimeout` (default `300s`), `maxLifetime` (no default; absent means members never age out) and `maxMembers` (default `64`).
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
- **Contract:** input `{ key, inputs }` — `key` typed from `/pool/keyType`, `inputs` typed from `/invoke/inputType` (section 3) and defaulting to `{}`; output typed from `/invoke/outputType`. The target's own contract stays unchanged: it never declares the key.
- **Throws:** the target's codes, `ERR_POOL_EXHAUSTED`, `ERR_POOL_BUILD_TIMEOUT`, `ERR_RESOURCE_INITIALIZATION_FAILED` and the build's codes.
- **Zone:** the `invoke` slot provides a zone correlated on `/pool`. The zone entry holds only the checkout's and the pool's identities, never the key; the pool keeps its own map from zone entry to member. The key traces verbatim unless `keyType` marks it sensitive, then as `[redacted]`.
- **Holding:** invoking a checkout takes a hold on the member of its `key` input (building it when needed) and dispatches `invoke` with its `inputs`. A checkout's exit is a hold-owning exit: streams leaving it are held, and the member hold is released by the rule of section 2 when the checkout's dispatch closes. The member context owns a redaction set for the member's lifetime, as a scope run holds its sensitive inputs (section 1): the key when `keyType` marks it sensitive, and every text value at a path a pool step's result type marks `x-telo-sensitive` (read from that step target's resolved `outputType`, string leaves beneath included). A credential read from an open result (a row, a parsed document) is picked out by an inline `Telo.Sequence` step whose `outputType` marks it, as the first example does with `token`.
- **Nesting:** a checkout reached inside another checkout's dispatch of the same pool takes over for its own target; the innermost one decides. A dispatch therefore uses one member per pool; using two members of one recipe at once means two pools.

**Member-bound declarations**
- **Which they are**, computed statically from the reference graph: a pool's `member`, and any declaration that references a member-bound declaration (or the pool, standing for its member) in a `use: dependency` slot or reads one in a creation-time field, transitively. An `Http.Request` whose `client` is `!ref clusters` is one, as is an `Sql.Query` whose `connection` is `!ref tenants`, an `Sql.Transaction` over it, a resource inside an imported library whose `resources:` input is supplied with `!ref tenants`, and a template body entry that reaches one.
- **Routing:** a dispatch of a member-bound declaration goes to that declaration's instance in the member context of the member the innermost checkout of its pool holds. There is one member context per member and per module instance holding member-bound declarations; it is created when the member is built, lives as long as the member, and is torn down with it. So a member-bound declaration is created once per member, not once per call, and its controller is unchanged: a reference slot it reads, at creation or on every call, resolves inside that context to that member.
- **Not in a scope:** a member-bound declaration inside a `with:` scope is `MEMBER_BOUND_SCOPED` at that declaration, and `ERR_MEMBER_BOUND_SCOPED` at load. A scoped declaration lives for one run and may read that run's `inputs`; a member-bound one lives as long as its member and is shared by every caller of its key, so one declaration cannot be both. A scope reaches a pooled resource only by calling it — a step's `invoke: !ref <module-scope member-bound declaration>` — never through a scoped declaration's dependency slot or creation-time field, which would make that declaration member-bound.
- **One pool:** a declaration is bound to exactly one pool. One reachable from more than one is `MEMBER_BOUND_MULTIPLE_POOLS` at the declaration, naming each pool and the chain that bound it — at the `imports:` entry when a second pool reaches a library declaration through that import's `resources:` — and `ERR_MEMBER_BOUND_MULTIPLE_POOLS` at load. Work needing members of two pools nests two checkouts, each declaration bound to one of them.
- **Libraries:** of a library whose `resources:` input is supplied `!ref tenants`, only its member-bound declarations exist per member. Everything else in it, its `lifecycle` included, is untouched.
- **Reading:** inside a checkout, `resources.<name>` of a member-bound declaration reads the instance of the member that checkout holds.
- **Transactions:** an `Sql.Transaction` over a pooled connection is itself member-bound, so its zone correlation resolves to the same member's connection its statements use.
- **Outside a checkout:** a reach of a member-bound declaration that no checkout of its pool covers is `ZONE_REQUIREMENT_UNSATISFIED`, and `ERR_ZONE_REQUIRED` at run time; both name the pool and the chain of references that made the declaration member-bound. That covers a dispatch, a detached or trigger dispatch (both start with no zones), a runtime-eval `resources.<name>` read, a boot target, a member-bound Service, Mount or Sink (a library's included), and a callable's data slot. Detached work that needs a member wraps its target in a checkout of its own.

**Durable execution:** a checkout's key is an ordinary input of the step that calls it, so a replay checks out the same key. A member-bound declaration as a durable step's own target has no encodable identity — its member is chosen at run time — so it is refused at the sender with `ERR_DURABLE_TARGET_UNENCODABLE`, the message naming the chain that bound it; durable work reaches a member through a step whose target is a checkout.

**Rust kernel:** refuses `Telo.KeyedPool` and `Telo.Checkout` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

*Example — one client per cluster:* a dashboard serving each cluster's pods, its kubeconfig stored in a database. Every request for the same cluster id uses the same `Http.Client` and the same `Http.Request` instance; the database is read and the kubeconfig parsed only when that id has no member, and the token the parse yields is marked sensitive by the step that picks it out. The checkout wraps the request directly, so the request's own contract (`method`, `url`) is its `inputs`, and the step's `retry:` waits out a full pool or a timed-out build.

```yaml
kind: Telo.Application
metadata: { name: K8sDashboard }
requires: { telo: ">=0.132.0" }
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

*Example — one connection per tenant, reached by unchanged resources in a library:* each tenant's orders live in their own SQLite file. The route's checkout takes the tenant as its `key` and wraps the library's `save`; the library's transaction and both statements name its `connection` input, which the application supplies as the pool, and use that tenant's connection with no tenant id in any of their contracts.

`orders/telo.yaml`:

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
requires: { telo: ">=0.132.0" }
imports:
  Server: oci://ghcr.io/telorun/http-server@0.42.0
  SQLite: oci://ghcr.io/telorun/sqlite@0.13.0
  Orders:
    source: ./orders
    resources: { connection: !ref tenants }
variables:
  dataDir: { env: DATA_DIR, type: string, x-telo-type: { name: Telo.HostPath, entry: directory } }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
---
kind: Telo.KeyedPool
metadata: { name: tenants }
keyType: { kind: Telo.JsonSchema, schema: { type: string, pattern: "^[a-z0-9-]+$" } }
maxMembers: 256
member:
  kind: SQLite.Connection
  file: !cel "variables.dataDir.joinPath(key + '.db')"
---
kind: Server.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref ordersApi }
---
kind: Server.Api
metadata: { name: ordersApi }
routes:
  - request:
      path: /tenants/{tenant}/orders
      method: POST
      schema:
        params: { type: object, required: [tenant], properties: { tenant: { type: string, pattern: "^[a-z0-9-]+$" } } }
        body: { type: object, required: [item], properties: { item: { type: string } } }
    handler: { kind: Telo.Checkout, pool: !ref tenants, invoke: !ref Orders.save }
    inputs:
      key: !cel "request.params.tenant"
      inputs: { item: !cel "request.body.item" }
    returns:
      - status: 201
        content:
          application/json:
            schema: { type: object, required: [orders], properties: { orders: { type: integer } } }
            body: { orders: !cel "result.orders" }
    catches:
      - status: 503
        when: !cel "error.code == 'ERR_POOL_EXHAUSTED'"
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

Refused: route `inputs:` without `key`, or without `inputs.item`, is `CONTRACT_INPUTS_MISMATCH` under `telo check` — `item` judged against `Orders.save`'s contract — and `ERR_INPUT_INVALID` at run time; a literal `key` outside `keyType` (`../etc`) is refused by `telo check`, and a computed one is `ERR_INPUT_INVALID` before the pool's steps run, from this route and from any other caller alike.

*Verify:*
- **Building:** a fixture provider counting its constructions, pooled: three checkouts of one key build one member, two keys build two, concurrent first checkouts of one key run the pool's `steps` once, a failed build is retried by the next checkout, and each member-bound declaration is created at build time, before any of the checkout's steps run.
- **Creation failure:** a member-bound `Http.Client` that fails creation for key `bad` fails that checkout with `ERR_RESOURCE_INITIALIZATION_FAILED`, which a `catches:` entry naming it catches; the next checkout of `bad` rebuilds, and key `good` is unaffected.
- **Routing, multi-tenant:** two concurrent requests for two tenants in the second example each write their own SQLite file, and both statements join that tenant's transaction, with `Orders` imported `isolated` and `shared` alike; `save` itself is not member-bound (it only calls the transaction), the transaction and both statements are.
- **Envelope:** `Orders.save` declares no tenant and two tenants still write their own files; `--inspect` traces the checkout's `key` and `inputs.item` verbatim, and a pool keyed `1` logs `1` verbatim elsewhere in its messages; with a `keyType` marked sensitive the key is `[redacted]` in member logs, traces and readings; a checkout wrapping a `Lease.Critical` forwards its `inputs` and returns the lease's output unchanged; a checkout whose target is a `Telo.Sequence` with `with:` holds the member until that sequence's dispatch closes.
- **Scoped:** a `Telo.Sequence` whose `with:` declares an `Sql.Query` with `connection: !ref tenants` fails `telo check` with `MEMBER_BOUND_SCOPED` at that declaration, and load with `ERR_MEMBER_BOUND_SCOPED`.
- **Library Service:** a library Service whose creation-time field reads `resources.connection`, supplied `!ref tenants`, fails `telo check` and boot with `ZONE_REQUIREMENT_UNSATISFIED`.
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

- **`inputs` is bound only in creation-time fields of scoped declarations, under that name.** A runtime-eval field already has a per-call meaning for `inputs` in many kinds; a second name for the owner's value would split completion, hover and documentation.
- **The opening inputs reach the kernel as a required argument, not through the ambient invocation context.** That context carries identities and never payload, which is the execution-zone rule.
- **Stream lifetime is held, not refused, and ends with its owner.** A refusal would forbid the bring-your-own-key consumer's streamed reply; holding the scope until its leaving streams settle makes every flow the manifest can express work, and ownership by the receiving dispatch bounds the hold, since every dispatch ends while a reader may never come.
- **Only held streams are tracked, and the bare root owns nothing.** Walking every dispatch's value would cost every large open-typed result, and a process-lifetime owner would leak a scope per schedule tick or queue message.
- **A sensitive input is redacted by value, per lifetime.** A value set follows the key through interpolation and into controller logs, which a mark on the consuming kind's field would not; owning it per scope run keeps the module's set from growing with call count.
- **Forwarding is typed, not annotated, both ways.** `x-telo-value-schema-from` already says "this node is that resource's contract", so redaction and the payload check follow from the type on the way in and on the way back, rather than from a second annotation.
- **A member is built whole.** The pool's `steps`, `member` and every module-scope declaration bound to it are created in one init loop, so a creation failure is a build failure with a declared code, never a creation scattered across later dispatches.
- **A build is bounded by the pool.** It runs detached from every caller, so no caller's deadline reaches it; `buildTimeout` is what keeps one hung dependency from freezing a key and, after `maxMembers` such keys, the whole pool.
- **The pool owns the key's type.** The build consumes the key, so `keyType` validates it for every caller and says, through `x-telo-sensitive`, whether it is a secret; tenant and cluster ids stay visible to operators by default.
- **A declaration is bound to one pool.** A declaration reaching two pools would need an instance per combination of members and could mix two tenants' backends; refusing it keeps "a member is built whole" true.
- **A full pool sheds load.** A new key with no idle member to evict fails at once with retryable `ERR_POOL_EXHAUSTED`; the caller's `retry:` is the one waiting layer, since a freed member serves only its own key and a hold can last as long as a stream.
- **A checkout takes `{ key, inputs }` and adds a hold and a zone; it has no step body.** The caller knows the key and the target does not, so the target's contract stays its own; a step body of its own would be a second copy of `Telo.Sequence`.
- **A pool is referenced by its own name.** A member is chosen at run time, so a structural member path would be a false address and a second way to reach inline declarations; the built-in entry's `referenceStandsFor` keeps the rule data rather than a kind-name check.

## Housekeeping

- **Agreement suite.** `tests/check-run-agreement.yaml` gains one row for each refusal, refused by both halves: an undeclared field read in a scope, a pool of a kind outside `Telo.Provider` / `Telo.Invocable`, a `keyType` that is not a string schema, a pool referenced at a slot of an incompatible kind, a member-bound declaration reached outside a checkout (from a boot target and from a detached dispatch), a member-bound declaration in a `with:` scope, and a declaration bound to two pools (direct and import-anchored).
- **Grammar floors**, under the "Changing the grammar" rule, verified by execution against the previous published CLI:
  - Every module whose own file declares a `Telo.KeyedPool` or a `Telo.Checkout`, or reads `inputs` inside a `with:` block, declares `requires: telo:` at the release that carries this. The examples write `>=0.132.0`, the next minor at the time of writing; it is whatever release ships this.
  - `lease`, `idempotency`, `idempotency-sql`, `cache` and `run` declare the floor only if the previous CLI rejects their file with `x-telo-value-schema-from` in its contract (expected for the root placements of `Run.Detach` and `Cache.View` only).
  - The `run` module passing inputs and the produced value to the scope handle is a controller change; it rides the SDK surface the floor already covers.
- **Releases.** One changeset naming `@telorun/analyzer`, `@telorun/kernel` and `@telorun/sdk` (one telo version line, a minor bump), and `telo release add` fragments of kind `Added` for `run`, `lease`, `idempotency`, `idempotency-sql` and `cache`, one per module. No major bump anywhere.
- **Built-in vocabulary.** `Telo.KeyedPool` and `Telo.Checkout`, with the pool's `referenceStandsFor`, are added to the built-in entries and the `Telo.Builtins` archive is re-rendered; both analyzers read them.
- **Benefits ledger.** One entry under Telo itself in `docs/guides/what-you-get.md`: per-request and per-tenant resources — a resource configured from the caller's inputs lives for one call and stays alive until its streamed answer is consumed or abandoned, and `Telo.KeyedPool` with `Telo.Checkout` builds one per tenant or cluster, reused across calls, with no tenant id passed through the code that uses it.
- **Documentation:**
  - `docs/guides/keyed-pools.md`, with both examples, sizing `maxMembers` against concurrently active keys, long holds and replica count (each replica keeps its own members, so backend connections scale as members times replicas) (with a step `retry:` naming `ERR_POOL_EXHAUSTED` and `ERR_POOL_BUILD_TIMEOUT`), `buildTimeout` against step `timeout:`, `keyType` and keying by a secret, marking a credential a build reads with an inline step's `outputType`, and one pool per declaration, and why a pooled resource is declared at module scope.
  - The `Telo.Sequence` and `run` `with:` documentation: scoped fields read `inputs`, and a scope lives until the streams leaving it settle.
  - The analyzer guide: the `x-telo-scope` entry, the CEL-scope list, the `x-telo-value-schema-from` entry (forwarding kinds), the pool reference rule.
  - The kernel guide: a scope's lifetime and stream ownership, and routing member-bound declarations; the invocation-contract spec states the held-stream ownership rule for every kernel; the logging spec and the kernel guide's redaction section describe the per-lifetime redaction set.
  - `lease`, `idempotency`, `idempotency-sql`, `cache` and `run` docs: the forwarded payload is typed by the target's contract and refused at the wrapper's own dispatch.
  - The root guide's built-in kinds and CEL-scope lists.
- **Hub guide.** `guide_design_library` (`apps/hub/guides/`): a library may take a pooled resource as a `resources:` input, and its declarations over it are then built per member.
- **Authoring agent primer.** In the same change: a `with:`-scoped resource reads the enclosing invocation's `inputs` in its creation-time fields, and that, not an invented per-call field on a kind, is how a per-request credential, endpoint or tenant value is carried; a scoped resource's stream may be returned, and a stream a caller does not read is cancelled when the call that received it ends, and at once when it reaches no opened context; a sensitive input read into a scoped resource is redacted wherever that resource's configuration or logs surface; `Telo.KeyedPool` and `Telo.Checkout` build one resource per key and serve it to unchanged resources anywhere beneath the checkout, referenced by the pool's own name; a checkout is called with `{ key, inputs }` and forwards `inputs` to the executable it wraps; a pool's `keyType` validates every key and marks a secret key sensitive, and `buildTimeout` bounds a build; a credential a pool's steps read is marked `x-telo-sensitive` in the `outputType` of the step that picks it out; a declaration is bound to one pool; a pooled resource is never declared in a `with:` scope.
