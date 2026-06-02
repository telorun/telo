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

## Reference

- [Structured Errors](docs/structured-errors.md) — how `try`/`catch` interacts with `InvokeError`.
