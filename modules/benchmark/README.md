# Benchmark

Load and performance benchmarking. `Benchmark.Suite` drives weighted scenarios against invocable resources inside the running app, for a fixed duration or request budget, collects latency and error metrics, and optionally fails the run when thresholds are breached. `Benchmark.Comparison` starts programs itself — two implementations of one API, or one command at several sizes — and measures their boot time, HTTP throughput, latency at a fixed rate, CPU per request and memory, on Linux.

## Why use this

- **Invocable-agnostic** — HTTP calls, SQL queries, a local `Run.Sequence` — anything with the `Telo.Invocable` capability is a valid scenario target.
- **Weighted scenarios** — run mixed workloads in parallel with per-scenario `weight`.
- **Threshold gating** — `report.thresholds` exits non-zero when `p99` / `p95` / `p50` / `errorRate` are breached; drop straight into CI.
- **Result validation** — per-scenario CEL `validate` expression flags failed responses without halting the suite.
- **Warm-up window** — `warmup` discards pre-roll samples to keep metrics honest.
- **Out-of-process comparisons** — `Benchmark.Comparison` alternates subjects over rounds, pins the load generator and the subjects to separate cores, measures latency open-loop from each request's scheduled time, flags a generator-bound throughput, and writes a JSON record with the spread of every figure.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Benchmark.Suite` | Runnable that executes weighted scenarios against an invocable and reports latency / error metrics. |
| `Benchmark.Comparison` | Runnable that starts programs and compares their boot time, throughput, latency, CPU and memory. See [docs/comparison.md](docs/comparison.md). |

## Example

```yaml
kind: Telo.Application
metadata:
  name: api-load
  version: 1.0.0
imports:
  Benchmark: oci://ghcr.io/telorun/benchmark@0.6.0
  HttpClient: oci://ghcr.io/telorun/http-client@0.11.0
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
      client: !ref Api
    inputs:
      method: GET
      url: /search?q=telo
    validate: !cel "result.status == 200"
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
      client: !ref Api
    inputs:
      method: GET
      url: /search?q=telo
    validate: !cel "result.status == 200"
  - name: publish
    weight: 1
    invoke:
      kind: HttpClient.Request
      client: !ref Api
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

### Report shape

`format: json` prints, per scenario, `{ total, rps, p50, p95, p99, errors: { count, rate, groups: [{ code, message, count, sample }] } }`. Percentiles come from a fixed-memory histogram (within 0.4% of exact). A request that throws, or whose `validate` is not `true`, is grouped by code and message with a sample of the failure; the table format prints the groups after the table. See [docs/suite.md](docs/suite.md) and [docs/measurement.md](docs/measurement.md).

## Comparing programs

```yaml
kind: Benchmark.Comparison
metadata: { name: pingCompare }
rounds: 3
boots: 5
subjects:
  - name: app
    command: node
    args: [server.js]
    cwd: !module-path app
    env: { PORT: "8845" }
    readiness: { url: http://127.0.0.1:8845/ping }
    stateDirectory: { env: STATE_DIR }
workloads:
  - name: ping
    duration: 10s
    warmup: 2s
    concurrency: 16
    rate: 500
    requests:
      - { url: http://127.0.0.1:8845/ping, expect: { status: 200 } }
report:
  file: !cel "variables.reportFile"
  thresholds:
    - { workload: ping, errorRate: 0, p99: 20 }
```

Each round boots every subject cold and warm, then runs each workload's throughput pass and latency pass on boots of their own. The table goes to stdout and the record to `report.file`; a subject without `readiness` runs to exit, which makes a boot-only comparison. Linux only: the comparison samples `/proc` and pins cores with `taskset`. See [docs/comparison.md](docs/comparison.md).
