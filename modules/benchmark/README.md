# Benchmark

Load benchmarking for any invocable Telo resource. `Benchmark.Suite` drives one or more scenarios against a fixed duration or request budget, collects latency and error metrics, and optionally fails the run when thresholds are breached.

## Why use this

- **Invocable-agnostic** — HTTP calls, SQL queries, `JavaScript.Script`, a local `Run.Sequence` — anything with the `Telo.Invocable` capability is a valid scenario target.
- **Weighted scenarios** — run mixed workloads in parallel with per-scenario `weight`.
- **Threshold gating** — `report.thresholds` exits non-zero when `p99` / `p95` / `p50` / `errorRate` are breached; drop straight into CI.
- **Result validation** — per-scenario CEL `validate` expression flags failed responses without halting the suite.
- **Warm-up window** — `warmup` discards pre-roll samples to keep metrics honest.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Benchmark.Suite` | Runnable that executes weighted scenarios against an invocable and reports latency / error metrics. |

## Example

```yaml
kind: Telo.Application
metadata:
  name: api-load
  version: 1.0.0
imports:
  Benchmark: std/benchmark@0.3.0
  HttpClient: std/http-client@0.3.0
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

## Top-level fields

One of `duration` or `requests` must be set; they are mutually exclusive.

| Field         | Type    | Notes                                                                                          |
| ------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `duration`    | string  | Wall-clock budget (e.g. `30s`, `1m`, `500ms`). Workers keep firing until the window closes.    |
| `requests`    | integer | Fixed total across all workers.                                                                |
| `concurrency` | integer | Number of parallel workers. Defaults to `1`.                                                   |
| `warmup`      | string  | A pre-roll window (e.g. `5s`) whose samples are discarded from the reported metrics.           |
| `scenarios`   | array   | One or more scenario entries (see below). At least one is required.                            |
| `report`      | object  | Output format and optional threshold checks.                                                   |

## Scenarios

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

## Report and thresholds

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
