# Run

Control flow for Telo manifests beyond a plain list of steps: iteration and mapping over collections, loops, decision tables and background dispatch.

An ordered list of steps — `if`, `while`, `switch`, `try`/`catch` over invocable steps — is the built-in `Telo.Sequence`, which needs no import. `Run.Sequence` is deprecated: it is a pure alias of it, so it behaves identically and reports `DEPRECATED_KIND` naming `Telo.Sequence`. Write `kind: Telo.Sequence`, and drop the `run` import when nothing else uses it. Shaping a value with CEL is likewise the built-in `Telo.Value`; `Run.Value` is deprecated and reports `DEPRECATED_KIND` naming it.

## Why use this

- **Manifest-native flow control** — branching and looping live in YAML, not in a `JS.Script` escape hatch.
- **Typed step results** — each step's output is statically typed inside `!cel "steps.<name>.result"`, so downstream CEL expressions are validated by the analyzer.
- **Structured error handling** — `try`/`catch` matches on `InvokeError` codes; see [Structured Errors](docs/structured-errors.md) for the end-to-end flow.
- **Composes with everything** — any `Telo.Invocable` resource can be a step, so AI calls, HTTP requests, SQL queries, and your own scripts mix freely.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Run.Sequence` | **Deprecated** — an alias of the built-in `Telo.Sequence` (it extends it and declares nothing of its own), which needs no import. |
| `Run.Value` | **Deprecated** — identical to the built-in `Telo.Value`, which needs no import. See [Composing behaviour](https://telo.run/learn/composing-behaviour). |
| `Run.Choice` | A first-match decision table — pick one typed value from ordered `when → value` rows. See [Run.Choice](docs/choice.md). |

## Example

```yaml
kind: Telo.Application
metadata: { name: pipeline, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-client@0.11.0
  Console: oci://ghcr.io/telorun/console@0.12.0
targets:
  - !ref Pipeline
---
kind: Http.Request
metadata: { name: GetUser }
---
kind: Telo.Sequence
metadata: { name: Pipeline }
steps:
  - name: fetch
    invoke: !ref GetUser
    inputs:
      url: https://example.com/users/1
  - name: greet
    invoke: !ref Console.writeLine
    inputs:
      output: !cel "'Hello, ' + string(steps.fetch.result.body)"
```

## A sequence as an HTTP handler

A `Telo.Sequence` is a `Telo.Runnable`, so it can be a route handler. The data flow has three seams:

1. The route's `inputs:` is a CEL map over the request — its result is passed to the handler's `invoke()`.
2. The sequence's `inputType:` **declares the input contract** — a `Telo.JsonSchema` shape, a named type reference, or an inline schema. Steps read the values as `!cel "inputs.<name>"`, and the kernel fills declared defaults and validates every call against it.
3. The sequence's `outputs:` is a CEL map producing the `result`; the route's `returns:` reads it as `!cel "result"`.

```yaml
kind: Http.Api
metadata: { name: Api }
routes:
  - request:
      method: GET
      path: /users/{id}
      schema:
        params:
          type: object
          properties:
            id: { type: string }
    inputs:
      userId: !cel "request.params.id"     # request context → handler invoke()
    handler: !ref GetUser
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result"            # sequence outputs → response
---
kind: Telo.Sequence
metadata: { name: GetUser }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      userId: {}                               # input contract: untyped (dyn)
steps:
  - name: fetch
    invoke: !ref SelectUser
    inputs:
      sql: "SELECT * FROM users WHERE id = ?"
      bindings:
        - !cel "inputs.userId"             # read the declared input
outputs:
  user: !cel "steps.fetch.result.rows[0]"  # becomes `result` the route sees
```

`inputs:` always means **values** — what a call site sends. The contract is `inputType:`, a schema. The two used to share the name `inputs:`, which is why a declared default never applied and a misspelled input went unnoticed: nothing read the contract at dispatch.

## Bringing up dependencies (`with:` / `targets:`)

A sequence can stand up its own resources for the duration of its run — a database connection, an `Http.Server`, a pool — without them being top-level Application resources:

- **`with:`** declares resources scoped to the sequence. They are initialized before the steps run and torn down when the sequence finishes (or fails).
- **`targets:`** names which of those `with:` resources to `run()` first (e.g. start a server / run migrations) before the steps execute.

```yaml
kind: Telo.Sequence
metadata: { name: IntegrationCheck }
with:
  - kind: SQLite.Connection
    metadata: { name: Db }
    file: ":memory:"
  - kind: SQLite.Schema
    metadata: { name: Migrate }
    connection: !ref Db
    version: !cel "module.version"
    migrations:
      "001-users":
        statement: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"
targets: [ !ref Migrate ]     # run() before the steps
steps:
  - name: seed
    invoke: { kind: Sql.Command, connection: !ref Db }
    inputs: { sql: !sql "INSERT INTO users (name) VALUES (${{ 'Ada' }})" }
```

`targets:` is **not** Application-only — both `Telo.Application` and `Telo.Sequence` have it. The difference is lifetime: an Application's targets/resources live for the process; a sequence's `with:` resources live only for that run. So a `Telo.Sequence` can start an `Http.Server` (put it in `with:`, list it in `targets:`) — useful for self-contained integration tests.

### Per-call resources: `with:` reads `inputs`

Every call of a sequence gets its own `with:` resources, and their **creation-time fields** (those a kind evaluates at creation — `x-telo-eval: compile`, and every field of a provider) read `inputs`: the inputs of the call that opened this run, exactly as the steps see them — validated against `inputType`, defaults filled. That is how a value belonging to one call — a caller's API key, an endpoint, a tenant — configures a resource without putting it at module level, where every caller would share it:

```yaml
kind: Telo.Sequence
metadata: { name: reply }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [apiKey, prompt]
    properties: { apiKey: { type: string, x-telo-sensitive: true }, prompt: { type: string } }
with:
  - kind: Http.ApiKeyHeader
    metadata: { name: credential }
    header: x-api-key
    key: !cel "inputs.apiKey"
  - kind: Http.Client
    metadata: { name: upstream }
    baseUrl: https://api.example.test
    credential: !ref credential
  - kind: Http.Request
    metadata: { name: send }
    client: !ref upstream
    url: /reply
steps:
  - name: send
    invoke: !ref send
```

- The field is typed by the sequence's `inputType`, so `inputs.apikey` is `CEL_UNKNOWN_FIELD` under `telo check`, and the kernel refuses it at load. An inline declaration nested in a `with:` member reads `inputs` too; a nested sequence's `with:` reads the inputs of the call that opened *it*.
- It is evaluated once, when the resource is created at scope entry, and two concurrent calls each get their own. `steps` is not in scope there, and a per-call field (`x-telo-eval: runtime`) keeps its own meaning of `inputs` — lift a value it needs from the opening call into a creation-time field.
- A sequence started by `run()` (a boot target) reads its contract applied to `{}` — the declared defaults — in its steps and its `with:` alike; a contract that refuses `{}` there is `CONTRACT_INPUTS_AT_RUN_SITE`.
- A field the contract marks `x-telo-sensitive` joins a redaction set of the run's own: its text is `[redacted]`, every occurrence, in the `Created` event, logs and trace payloads of the resources created in the run, in the trace payloads of the dispatches the sequence issues during the run (a `Bearer ${{ inputs.apiKey }}` handed to a module-level resource included), and in an error that leaves the run. A record a module-level resource writes from its own code is redacted only by the module's set and its own contract's marks.

`with:` is declared on both kinds as `x-telo-scope: { regions: [/steps, /targets], openedBy: dispatch }`; a `run` release published before that declaration reads `inputs` in a `Run.Sequence` member as `CEL_UNKNOWN_IDENTIFIER`.

### A scope lives until the streams leaving it settle

A `with:` resource may answer a stream — a model's streamed reply, a multipart parse — and the sequence may return it, map it through a module-level stage, or hand it to `Run.Detach`. The run is torn down only once the sequence has produced its result **and** every stream leaving the run has settled: read to its end, failed, or cancelled by its reader. So the resource behind a streamed HTTP reply is torn down after the last chunk is written, or when the client disconnects.

- **What leaves a run**: a stream reachable through maps and lists from the sequence's result (with no `outputs:`, the whole `steps` map), a stream derived from one (`Stream.Map` over it), a stream inside an item of one (each part's `content`), and a stream in the inputs of detached work (`Run.Detach`), which then holds the run until it has drained it. A stream with no scope behind it is never touched.
- **Who owns it**: the call that received it. A stream nobody reads is cancelled when that call ends — a sequence calling a scoped reply and keeping only its `usage`, a route whose `returns:` reads only `result.usage` — and its scope is torn down then. An inbound transport's context (one per HTTP request, one per broadcast delivery) owns until the request completes or is abandoned; a boot `targets:` run owns until its last target returns; a dispatch under `ctx.rootContext()` with no source owns nothing, so a schedule tick's or a queue message's unread stream is cancelled at once.
- **Reading one late**: a held stream pulled after it was cancelled, or a second time once consumed, raises `ERR_INVOKE_CANCELLED` saying why.
- **A failed teardown** has no caller to throw to: it is logged as an error on the sequence's logger under `scope.teardown.failed`.

## Naming intermediate values

A calculation's intermediate values do not need a resource each. `Telo.Value` and `Run.Choice` take a `bindings:` map — names readable bare in their expressions, ordered by what they reference and evaluated lazily — and any step list takes a step carrying `value:` instead of `invoke:`, which publishes `steps.<name>.result` with no dispatch:

```yaml
steps:
  - name: cart
    invoke: !ref LoadCart
  - name: total
    value: !cel "sum(steps.cart.result.lines.map(l, l.price * double(l.qty)))"
```

See [Naming intermediate values](https://telo.run/learn/composing-behaviour#naming-intermediate-values).

## Retrying a step

Any dispatch site takes a `retry:` policy — `attempts`, `initialDelay` and `maxDelay` (durations, or integer milliseconds), `factor`, `jitter`, `nonRetryable`, and `retryAfter` (CEL over the failure yielding the wait to take instead of the backoff) — and a per-attempt `timeout:` (a duration). A step and an Application `targets:` entry are the same kernel-owned shape, so it reads identically in both:

```yaml
  - name: Charge
    invoke: !ref PaymentApi
    retry: { attempts: 3 }
```

It retries a domain failure and refuses two things it cannot help: a cancellation, and a contract violation, which is a property of the manifest and fails identically every time. The wait between attempts is itself cancellable, so Ctrl-C does not have to outlast the backoff. A **live** value must not be passed to a retried dispatch — a stream is consumed by reading, so a re-attempt would send nothing, and the analyzer reports `LIVE_VALUE_RETRIED` before anything runs. See [Step retry](docs/retry.md).

## Reference

- [Composing behaviour](https://telo.run/learn/composing-behaviour) — `Telo.Value`, bindings and pure steps: naming intermediate values without a dispatch.
- [Step retry](docs/retry.md) — re-attempting a failed step, and why a stream cannot be one.
- [Structured Errors](docs/structured-errors.md) — how `try`/`catch` interacts with `InvokeError`.
