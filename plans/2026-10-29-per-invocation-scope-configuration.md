---
status: done
priority: high
tracking: worktree-per-invocation-scope-config
depends-on: []
packages: [analyzer, kernel, sdk, ide-support, run, lease, idempotency, idempotency-sql, cache, broadcast, ai-chat, authoring-agent]
---

# Per-invocation scope configuration

## Problem

A `with:` scope creates its resources when an invocation of its owner enters the scope, and tears them down when it leaves. Each run gets its own instances. So a scope is the natural home for a resource whose configuration belongs to one invocation: a credential a caller supplies, an endpoint chosen per request. Three gaps stop it being used that way.

1. **A scoped declaration cannot read the invocation that created it.** Its fields expand against the module's scope alone, meaning `variables`, `secrets` and `resources`, while the owner's step body, a few lines below, already sees `inputs`. The only way to configure a scoped resource per call is not to scope it, which puts the value back at module level where every caller shares it.
2. **A stream produced by a scoped resource breaks when the scope ends.** A sequence returning a model's streamed reply, or handing it to detached work, ends its run, the scope is torn down, and the consumer's next pull fails with whatever the disposed resource throws, far from the line that caused it.
3. **`x-telo-sensitive` stops at a forwarding kind.** `Lease.Critical`, `Idempotency.Once` and `Run.Detach` take a payload in their own invocation contract and dispatch it as the inputs of the resource in their `invoke` slot. Their contract declares that payload as an open object, so a credential passing through one is carried verbatim on the `--inspect` debug wire even when the target's contract marks it sensitive, and nothing checks the payload against the target's contract.

The authoring agent's bring-your-own-key design is the first consumer of all three; none is specific to it.

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

*After:* a scoped declaration's **creation-time fields** can read `inputs`, in a scope whose kind declares it is opened by its own dispatch (`Telo.Sequence` does): the inputs of the invocation that opened this run of the scope. Creation-time fields are those marked `x-telo-eval: compile`, plus every field of a provider. The value is exactly what the owner's step body sees: validated against the owner's bound invocation contract, with its declared defaults filled. An inline declaration nested inside a scoped one is a member of the same scope and reads `inputs` too.

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
- **Opened by `run()`:** a scope whose owner is started with `run()` (a sequence run as a boot target) sees the owner's contract applied to the empty call — the value the kernel hands `run()` itself, which its step body sees too.
- **Run inputs:** the kernel binds `run()`'s input side. A run of an instance with an input contract is the contract applied to `{}`: defaults filled, then validated. The value travels in the run request (`Controller.Run` gains `inputs`, present when the instance has an input contract; a controller that ignores it keeps working), never in the dispatch context. `CONTRACT_INPUTS_AT_RUN_SITE` refuses a contract that refuses `{}`, and `ERR_INPUT_INVALID` is its runtime backstop. The invocation-contract spec's statement that `run()` is not bound is amended accordingly, and so is the controller-protocol spec and its message data. A `run` release older than this keeps its own `{}` for `Run.Sequence.run()`; the kind is deprecated and upgrading `run` fixes it.
- **Lifetime:** evaluated once per scope entry, when the scoped resource is created. A scoped resource never re-reads `inputs` mid-scope, and two concurrent runs each see their own.
- **Runtime-eval fields are unchanged.** Many already bind an `inputs` of their own — that resource's own call — so binding the opening invocation's there too would make one name mean two things at one site. A value a per-call field needs from the opening invocation is lifted into a creation-time field.
- **`steps` is not bound.** Scoped resources are created at scope entry, before any step has run.
- **Static consequence:** a creation-time field that reads `inputs` is no longer a constant known at load. Every analyzer pass that resolves a creation-time value statically — resource rules, a ref slot's use chosen by a sibling field, value checks against literals — treats it as unresolved, as it already treats a field reading another resource's published state, and never folds it to a default. For a use case map, unresolved means the union of its cases.
- **Which scopes bind `inputs`:** a kind declares it with the object form of the scope annotation, `x-telo-scope: { regions: [...], openedBy: dispatch }`; the string and list forms mean "not opened by dispatch" and bind nothing. `openedBy: dispatch` on a kind with no `invoke` or `run` (a capability other than Invocable, Runnable or Service) or a malformed object is `SCOPE_OPENED_BY_INVALID` at the kind and `ERR_SCOPE_OPENED_BY_INVALID` at definition registration, through the one reader. `Telo.Sequence` and `Run.Sequence` adopt it, so `run` takes a measured `telo release floor`. A `run` release published without the declaration reads `inputs` in a member as `CEL_UNKNOWN_IDENTIFIER` under `telo check`, refused at load too.
- **Kernel and SDK:** opening a scope takes the opening invocation's inputs as a required argument of the SDK's scope-handle surface, so a controller cannot open one without them: an object on a scope declaring `openedBy: dispatch`, `null` on any other. A legacy open whose first argument is a function is read as `null`. An open that disagrees with the kind's declaration is `ERR_SCOPE_OPENING_INVALID`, naming the kind, the resource and the disagreeing side. `Telo.Sequence` and `Run.Sequence` pass their invocation's inputs — from `invoke`, or from `run` as above.
- **Editor:** the editor's CEL scope query offers `inputs` at exactly these sites, completion and hover included.
- **Nested scope:** a scope sees the inputs of the invocation that opened *it*, never those of an enclosing scope.
- **Redaction:** each scope run owns a redaction set of its own, layered over the sets of the context owning the holder (the module's for a top-level holder, the enclosing run's for a scoped one): the text values of the opening inputs at every path the owner's input contract marks `x-telo-sensitive`, string leaves beneath included. It is filled at scope entry, never cleared, and dropped by reference with the run, so a lazily serialized event keeps redacting. A value matches by substring at any length, every occurrence; a sensitive non-string scalar is not value-redacted. "Under the run" is defined by ownership and by explicit dispatch identity, never by ambient payload. A record is redacted by the run's set when it is:
  - written by a resource created in the run — its log records (attributes and error value), its `Created` properties, and every debug-wire event carrying its published reading;
  - the trace payload (inputs, outputs, error) of a dispatch whose target was created in the run, of a dispatch the owner issues inside the run (which carries the run's identity in its own per-dispatch context, never inherited), or of the opening dispatch itself;
  - an error value the kernel builds for a failure that left the run, which carries the run's set from its exit.

  So `apiKey` above is `[redacted]` in the scoped credential's configuration and in the `Bearer`-interpolated form alike, including when a step forwards that text to a module-level resource. A record a module-level resource writes from its own code is the module's record, redacted by the module's set and its contract's `x-telo-sensitive` marks, not by any run's; published readings, read as CEL data, stay unredacted.

*Verify:*
- The example above, called concurrently with two keys, sends each key on its own upstream call only.
- The `inputs.apikey` variant fails `telo check` with `CEL_UNKNOWN_FIELD` at that line, and fails at load.
- A scoped resource's `detach:` field that reads `inputs` puts both of its ref slot's uses into the call graph.
- Completion in `key:` lists `apiKey` and `prompt`.
- The example under `--inspect` with a log sink, called concurrently with two keys: neither key appears in any `Created` event, log record, trace payload or error value attributed to the run; after 10,000 requests the module context's redaction set is the size it was before the first.
- The example with a step forwarding `Bearer ${{ inputs.apiKey }}` to a module-level `Http.Request` shows `[redacted]` in that dispatch's `Invoking` payload; an upstream failure echoing the key is `[redacted]` in the route's error log record.
- A sequence with `inputType` `{ greeting: { type: string, default: hi } }`, started as a boot target, reads `hi` in its step body and in a scoped member's creation-time field. The same sequence without the default and with `minProperties: 1` fails `telo check` with `CONTRACT_INPUTS_AT_RUN_SITE` and fails at load.
- Under a `run` release without the `openedBy` declaration, `inputs.apiKey` in a `Run.Sequence` member fails `telo check` with `CEL_UNKNOWN_IDENTIFIER` and fails at load; the same manifest without the read boots on the new kernel. A controller passing `null` on a declared scope, or an object on an undeclared one, fails its first open with `ERR_SCOPE_OPENING_INVALID`.

### 2. A scope lives until the streams leaving it settle

*Before:* a scope run ends when its owner returns. A stream in the returned value — the example above returns the model's reply — is pulled after the model was torn down.

*After:* a scope run ends only when both hold: its owner has produced its value, and every stream reachable from a value leaving the run has settled — finished, failed, or cancelled by its consumer. A value leaves the run by being returned, or by being handed to a detached or trigger dispatch as its inputs.

- **Held streams.** A stream reachable from a value leaving a scope run — returned, or in a detached or trigger dispatch's inputs — is *held*, and so is a stream leaving a dispatch that owns a held stream (a mapped or decoded one). The kernel wraps a held stream to observe when it settles; a stream with no scope behind it is never wrapped, tracked or cancelled.
- **Found by value, only where a hold exists.** The kernel walks a value — maps, lists, and each item of a held stream as its consumer pulls it, never ahead of the consumer and with nothing buffered — at a scope run's end, at a detached or trigger dispatch issued inside a scope run or by a dispatch owning a held stream, and at the return of a dispatch that owns a live held stream. No other dispatch looks at its value, and a walk skips a subtree whose resolved contract is closed and holds no live value type. A stream derived from a scoped one, a stream at an open or untyped path, and a stream inside an item (a multipart part's `content`) are covered alike.
- **SDK:** closing a scope takes the run's produced value as a required argument and returns it with its streams wrapped, the counterpart of the required opening inputs.
- **Detached work** holds the scope run until every stream in its inputs settles, so a scoped stream handed to detached work keeps the scope open until that work drains it. Nothing is refused statically.
- **Ownership.** A held stream found in a dispatch's returned value is registered with the dispatch that called it; one in a detached or trigger dispatch's inputs with that dispatch. A dispatch's ownership closes when it has produced its value and every stream leaving it has settled, and the kernel then cancels every held stream it still owns. So a held stream nobody reads — a route whose `returns:` reads only `result.usage` beside a returned `output` stream, a sequence ignoring a step's stream — is cancelled when the dispatch that received it ends, and its scope is torn down then. A derived stream keeps its source alive, since the source is cancelled only once the derived stream has settled.
- **Dispatch ownership.** Every dispatch has an owner of its own, carried as an opaque `owner` member of the invocation context: inherited by derived contexts, replaced by the kernel at each dispatch, and crossing the controller protocol as an opaque id (additive within the current generation; an unknown or closed owner counts as closed, so a held stream registered with it is cancelled at once). A dispatch is detached or trigger when its context's owner is not the owner of the dispatch that issued it.
- **Roots.** A source made by `ctx.createCancellationSource()` (on the wire `Cancellation.Create`) carries a root owner on its context, closing at `dispose()` (completed) or `cancel()` (abandoned); a source from the free SDK function carries none and is the bare root. A context an inbound source opens (one per HTTP request) owns until it is disposed or cancelled; every in-repo inbound transport that reads a stream from a dispatch result (HTTP routes, and MCP and SSE through them; `Broadcast.Subscription`, one source per delivery, disposed when the handler returns; the `ai-chat` turn runner, one per turn) dispatches under a context it opens.
- **Deferred teardown.** When held streams leave a scope run, `ScopeHandle.run` returns the wrapped value at once and the run is torn down once they settle, tracked against the holder and drained by its teardown; a failure of that teardown is an error record on the holder's logger under the event `scope.teardown.failed`, never swallowed. A run no stream leaves is torn down before `run` returns, failures thrown. A shutdown sweeping a pending run cancels its held streams first, so a later pull raises `ERR_INVOKE_CANCELLED`; an outer run waits for every run opened in its context; a held stream no iterator opened settles when its owner closes, and an iterator opened after settlement raises `ERR_INVOKE_CANCELLED` saying the stream was already consumed and its scope has ended. The boot runner opens one owner for the whole `targets:` run, closed when the last target returns. The bare root owns nothing: a held stream that would pass to it — a schedule tick's or a queue message's result — is cancelled at once and its scope released.
- **Outside the guarantee:** a held stream a controller pulls after its dispatch returns without having dispatched under a context it opened — its pull raises `ERR_INVOKE_CANCELLED`, saying the stream reached a caller that opened no context — and a stream hidden inside a host object that is neither a map, a list nor a stream. A position a body does read is held until its reader consumes it or the dispatch closes, so a loop calling a scoped stream-returning step and ignoring the stream keeps each turn's scope until the loop returns.

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
- **Adopters:** `Lease.Critical` (`inputs`; `result` from `/invoke/outputType`), `Idempotency.Once` (`inputs`; `result` from `/invoke/outputType`), `IdempotencySql.Once` (`inputs`), `Cache.View` (its `inputType` root beside its own `key`; `value` from the target's output) and `Run.Detach` (its whole `inputType`, at the contract root), the input nodes pointing at `/invoke/inputType`. `Run.Detach`'s contract, before and after:

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

## Decisions

- **`inputs` is bound only in creation-time fields of scoped declarations, under that name.** A runtime-eval field already has a per-call meaning for `inputs` in many kinds; a second name for the owner's value would split completion, hover and documentation.
- **The opening inputs reach the kernel as a required argument, not through the ambient invocation context.** That context carries identities and never payload, which is the execution-zone rule.
- **A run is the contract's empty call, bound by the kernel.** A value fully determined by the contract cannot be each controller's opt-in, or a manifest passes `telo check` and fails at boot.
- **Which scopes bind `inputs` is declared by the kind.** The `requires:` floor bounds the kernel, not the release of the dependency whose controller opens the scope; only the kind's own published schema separates an old controller from a new one.
- **A run's redaction is owned by an instance or a dispatch the run issues.** Widening the module's set would make every record scan every concurrent run's keys, and removing a value at run end would un-redact lazily serialized events.
- **Stream lifetime is held, not refused, and ends with its owner.** A refusal would forbid the bring-your-own-key consumer's streamed reply; holding the scope until its leaving streams settle makes every flow the manifest can express work, and ownership by the receiving dispatch bounds the hold, since every dispatch ends while a reader may never come.
- **Only held streams are tracked, and the bare root owns nothing.** Walking every dispatch's value would cost every large open-typed result, and a process-lifetime owner would leak a scope per schedule tick or queue message.
- **A sensitive input is redacted by value, per lifetime.** A value set follows the key through interpolation and into controller logs, which a mark on the consuming kind's field would not; owning it per scope run keeps the module's set from growing with call count.
- **Forwarding is typed, not annotated, both ways.** `x-telo-value-schema-from` already says "this node is that resource's contract", so redaction and the payload check follow from the type on the way in and on the way back, rather than from a second annotation.

## Housekeeping

- **Agreement suite.** `tests/check-run-agreement.yaml` gains rows: an undeclared field read in a scope (refused by both halves); `inputs` in a member of a scope declared without `openedBy` (refused by both halves); a run-started sequence whose step body reads a defaulted input (agrees, runs); a contract refusing `{}` at a run site (refused by both halves).
- **Grammar floors**, under the "Changing the grammar" rule, verified by execution against the previous published CLI:
  - Every module whose own file reads `inputs` inside a `with:` block declares `requires: telo:` at the release that carries this. The examples write `>=0.132.0`, the next minor at the time of writing; it is whatever release ships this.
  - `lease`, `idempotency`, `idempotency-sql`, `cache` and `run` declare the floor only if the previous CLI rejects their file with `x-telo-value-schema-from` in its contract (expected for the root placements of `Run.Detach` and `Cache.View` only).
  - The `run` module passing inputs and the produced value to the scope handle is a controller change; it rides the SDK surface the floor already covers.
- **Releases.** One changeset naming `@telorun/analyzer`, `@telorun/kernel` and `@telorun/sdk` (one telo version line, a minor bump), and `telo release add` fragments of kind `Added` for `run`, `lease`, `idempotency`, `idempotency-sql` and `cache`, one per module. No major bump anywhere.
- **Benefits ledger.** One entry under Telo itself in `docs/guides/what-you-get.md`: per-request resources — a resource configured from the caller's inputs lives for one call and stays alive until its streamed answer is consumed or abandoned.
- **Documentation:**
  - The `Telo.Sequence` and `run` `with:` documentation: scoped fields read `inputs`, and a scope lives until the streams leaving it settle.
  - The analyzer guide: the `x-telo-scope` entry, the CEL-scope list, the `x-telo-value-schema-from` entry (forwarding kinds).
  - The kernel guide: a scope's lifetime and stream ownership; the invocation-contract spec states the held-stream ownership rule for every kernel; the logging spec and the kernel guide's redaction section describe the per-lifetime redaction set.
  - `lease`, `idempotency`, `idempotency-sql`, `cache` and `run` docs: the forwarded payload is typed by the target's contract and refused at the wrapper's own dispatch.
  - The root guide's CEL-scope list.
- **Authoring agent primer.** In the same change: a `with:`-scoped resource reads the enclosing invocation's `inputs` in its creation-time fields, and that, not an invented per-call field on a kind, is how a per-request credential, endpoint or tenant value is carried; a scoped resource's stream may be returned, and a stream a caller does not read is cancelled when the call that received it ends, and at once when it reaches no opened context; a sensitive input read into a scoped resource is redacted wherever that resource's configuration or logs surface.
