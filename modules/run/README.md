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

## Example

```yaml
kind: Telo.Application
metadata: { name: pipeline, version: 1.0.0 }
imports:
  Run: std/run@latest
---
kind: Run.Sequence
metadata: { name: Pipeline }
steps:
  - name: fetch
    invoke: { kind: Http.Request, name: GetUser }
  - name: greet
    invoke: { kind: Console.Print }
    inputs:
      message: !cel "'Hello, ' + steps.fetch.result.name"
```

## Run.Sequence as an HTTP handler

A `Run.Sequence` is a `Telo.Runnable`, so it can be a route handler. The data flow has three seams:

1. The route's `inputs:` is a CEL map over the request — its result is passed to the handler's `invoke()`.
2. The sequence's top-level `inputs:` **declares the input contract** (a JSON Schema property map, `{}` = untyped/dyn). Steps read the values as `${{ inputs.<name> }}`.
3. The sequence's `outputs:` is a CEL map producing the `result`; the route's `returns:` reads it as `${{ result }}`.

```yaml
kind: Http.Api
metadata: { name: Api }
routes:
  - method: GET
    path: /users/:id
    inputs:
      userId: !cel "request.params.id"   # request context → handler invoke()
    handler: { kind: Run.Sequence, name: GetUser }
    returns:
      status: 200
      body: !cel "result"                 # sequence outputs → response
---
kind: Run.Sequence
metadata: { name: GetUser }
inputs:
  userId: {}                              # input contract: untyped (dyn)
steps:
  - name: fetch
    invoke: { kind: Sql.Query, name: SelectUser }
    inputs:
      bindings:
        - !cel "inputs.userId"            # read the declared input
outputs:
  user: !cel "steps.fetch.result.rows[0]" # becomes `result` the route sees
```

`inputs:` on the sequence (the contract) and `inputs:` on a step (the values passed to that step's `invoke()`) are different fields that share a name.

## Reference

- [Structured Errors](docs/structured-errors.md) — how `try`/`catch` interacts with `InvokeError`.
