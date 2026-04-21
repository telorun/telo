---
description: "Benchmark.Suite: load testing driver for invocables with concurrency, duration/request budgets, warmup, and thresholds"
---

# Benchmark

Load benchmarking for any invocable Telo resource. `Benchmark.Suite` drives one or more scenarios against a fixed duration or request budget, collects latency and error metrics, and optionally fails the run when thresholds are breached.

A suite does not care what it is hitting — HTTP calls, SQL queries, a `JavaScript.Script`, a local `Run.Sequence`. Anything with the `Telo.Invocable` capability can be a scenario.

---

## Benchmark.Suite

A runnable that executes scenarios in parallel and reports the result. One of `duration` or `requests` must be set; they are mutually exclusive.

| Field         | Type    | Notes                                                                                          |
| ------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `duration`    | string  | Wall-clock budget (e.g. `30s`, `1m`, `500ms`). Workers keep firing until the window closes.    |
| `requests`    | integer | Fixed total across all workers.                                                                |
| `concurrency` | integer | Number of parallel workers. Defaults to `1`.                                                   |
| `warmup`      | string  | A pre-roll window (e.g. `5s`) whose samples are discarded from the reported metrics.           |
| `scenarios`   | array   | One or more scenario entries (see below). At least one is required.                            |
| `report`      | object  | Output format and optional threshold checks.                                                   |

### Scenarios

Each scenario names an invocable resource and (optionally) a CEL validator. Weight controls relative frequency when multiple scenarios share a run.

```yaml
scenarios:
  - name: search
    weight: 4
    invoke:
      kind: HttpClient.Request
      client: Api
      inputs:
        method: GET
        url: /search?q=telo
    validate: "result.status == 200"
  - name: publish
    weight: 1
    invoke:
      kind: HttpClient.Request
      client: Api
      inputs:
        method: POST
        url: /publish
```

`validate` is evaluated against `result` after each invocation; a `false` result counts as an error in the scenario's metrics without halting the suite.

### Report and thresholds

```yaml
report:
  format: table   # or json
  thresholds:
    - scenario: search
      p99: 250     # ms
      p95: 150
      errorRate: 0.01
```

If any threshold is breached after the run completes, `Benchmark.Suite` exits non-zero — useful as a gate in a `Run.Sequence` or CI pipeline.

---

## Full example

```yaml
kind: Telo.Import
metadata:
  name: Benchmark
source: ../../modules/benchmark
---
kind: HttpClient.Client
metadata:
  name: Api
baseUrl: http://localhost:3000
---
kind: Benchmark.Suite
metadata:
  name: ApiLoad
duration: 30s
concurrency: 16
warmup: 5s
scenarios:
  - name: search
    weight: 4
    invoke:
      kind: HttpClient.Request
      client: Api
      inputs:
        method: GET
        url: /search?q=telo
    validate: "result.status == 200"
report:
  format: table
  thresholds:
    - scenario: search
      p99: 250
      errorRate: 0.01
```
