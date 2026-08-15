# Run

Sequential control flow for Telo manifests — `Run.Sequence` chains invocable steps with `if`, `while`, `switch`, and `try`/`catch` blocks.

## Why use this

- **Manifest-native flow control** — branching and looping live in YAML, not in a `JS.Script` escape hatch.
- **Typed step results** — each step's output is statically typed inside `${{ steps.<name>.result }}`, so downstream CEL expressions are validated by the analyzer.
- **Structured error handling** — `try`/`catch` matches on `InvokeError` codes; see [Structured Errors](docs/structured-errors.md) for the end-to-end flow.
- **Composes with everything** — any `Telo.Invocable` resource can be a step, so AI calls, HTTP requests, SQL queries, and your own scripts mix freely.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Run.Sequence` | Run an ordered list of invocable steps with control-flow blocks. |
| `Run.Value` | A pure value/binding invocable — shape a CEL value (or a constant) with no `JS.Script`. See [Run.Value](docs/value.md). |
| `Run.Choice` | A first-match decision table — pick one typed value from ordered `when → value` rows. See [Run.Choice](docs/choice.md). |

## Example

```yaml
kind: Telo.Application
metadata: { name: pipeline, version: 1.0.0 }
imports:
  Run: oci://ghcr.io/telorun/run@0.13.0
  Http: oci://ghcr.io/telorun/http-client@0.11.0
  Console: oci://ghcr.io/telorun/console@0.12.0
targets:
  - !ref Pipeline
---
kind: Http.Request
metadata: { name: GetUser }
---
kind: Run.Sequence
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

## Run.Sequence as an HTTP handler

A `Run.Sequence` is a `Telo.Runnable`, so it can be a route handler. The data flow has three seams:

1. The route's `inputs:` is a CEL map over the request — its result is passed to the handler's `invoke()`.
2. The sequence's `inputType:` **declares the input contract** — a `Telo.JsonSchema` shape, a named type reference, or an inline schema. Steps read the values as `!cel "inputs.<name>"`, and the kernel fills declared defaults and validates every call against it.
3. The sequence's `outputs:` is a CEL map producing the `result`; the route's `returns:` reads it as `${{ result }}`.

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
kind: Run.Sequence
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
kind: Run.Sequence
metadata: { name: IntegrationCheck }
with:
  - kind: SQLite.Connection
    metadata: { name: Db }
    file: ":memory:"
  - kind: Sql.Migrations
    metadata: { name: Migrate }
    connection: !ref Db
    migrations:
      "001-users":
        statement: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"
targets: [ !ref Migrate ]     # run() before the steps
steps:
  - name: seed
    invoke: { kind: Sql.Command, connection: !ref Db }
    inputs: { sql: !sql "INSERT INTO users (name) VALUES (${{ 'Ada' }})" }
```

`targets:` is **not** Application-only — both `Telo.Application` and `Run.Sequence` have it. The difference is lifetime: an Application's targets/resources live for the process; a sequence's `with:` resources live only for that run. So yes, a `Run.Sequence` can start an `Http.Server` (put it in `with:`, list it in `targets:`) — useful for self-contained integration tests.

## Naming intermediate values

A calculation's intermediate values do not need a resource each. `Run.Value` and `Run.Choice` take a `bindings:` map — names readable bare in their expressions, ordered by what they reference and evaluated lazily — and any step list takes a step carrying `value:` instead of `invoke:`, which publishes `steps.<name>.result` with no dispatch:

```yaml
steps:
  - name: cart
    invoke: !ref LoadCart
  - name: total
    value: !cel "sum(steps.cart.result.lines.map(l, l.price * double(l.qty)))"
```

See [Bindings and pure steps](docs/bindings.md).

## Retrying a step

Any dispatch site takes a `retry:` policy — `attempts`, `initialDelay`, `factor`, `maxDelay`, `jitter`. A step and an Application `targets:` entry are the same kernel-owned shape, so it reads identically in both:

```yaml
  - name: Charge
    invoke: !ref PaymentApi
    retry: { attempts: 3 }
```

It retries a domain failure and refuses two things it cannot help: a cancellation, and a contract violation, which is a property of the manifest and fails identically every time. The wait between attempts is itself cancellable, so Ctrl-C does not have to outlast the backoff. A **live** value must not be passed to a retried dispatch — a stream is consumed by reading, so a re-attempt would send nothing, and the analyzer reports `LIVE_VALUE_RETRIED` before anything runs. See [Step retry](docs/retry.md).

## Reference

- [Bindings and pure steps](docs/bindings.md) — naming intermediate values without a dispatch.
- [Step retry](docs/retry.md) — re-attempting a failed step, and why a stream cannot be one.
- [Structured Errors](docs/structured-errors.md) — how `try`/`catch` interacts with `InvokeError`.
