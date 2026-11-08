---
status: done
priority: medium
depends-on: []
packages: [benchmarks, modules/benchmark, kernel]
tracking: feat/benchmark-program
---

# Benchmark program: Telo vs native, feature cost, agent authoring

## Problem

Nothing publishes how Telo performs, or what an author gains or pays for it. Today `benchmarks/feedback` and `benchmarks/score` each pair a Fastify app with a Telo twin, and an orchestrator script prints a latency table on demand. They run on no schedule and keep no history, and no page shows the results. Boot time, memory and CPU are not measured at all.

The load loop in `Benchmark.Suite` would also give wrong numbers for a Telo-vs-native comparison:

- **Hidden stalls.** Each worker waits for its response before sending the next request, so a server stall counts as one slow sample instead of every request that should have gone out meanwhile. This understates p99, and understates it more for the slower server.
- **The generator can be the bottleneck.** Every request passes through Telo's call path and the `Http.Request` controller, all on one Node thread, so a throughput figure can measure the generator instead of the server.
- **The generator disturbs its own timings.** Samples go into an array that grows with the run and is sorted at the end; the generator's garbage collection pauses then show up as latency.
- **Errors are only counted.** A failure becomes +1 with no status code or message.
- **One run, no spread.** Subjects are never alternated, and nothing records how much the result varies.

Telo's own costs are invisible as well. Some features — `!if` / `!switch` across independent dimensions, `!for-each`, deep imports — may grow startup time steeply, and no measurement would catch a change that makes one of them worse. Nobody has measured whether a coding agent builds the same app faster, or with fewer tokens, in Telo than in plain Node.

## Solution

Three benchmark families share one toolset, one result history and one docs page.

### 1. Comparison: Telo vs native (`benchmarks/lead-intake/`)

A lead-intake API grows out of `score` and replaces both existing suites. It has one prose contract (`CONTRACT.md`), one contract test written as Telo manifest tests that run against any implementation's URL, and the implementations `telo/` and `node/`, with `rust/` to follow. Endpoints:

- `GET /ping` — no CEL, the framework floor.
- `POST /leads/light`, `/leads/medium`, `/leads/heavy` — about 5, 25 and 80 CEL expressions. Each level is the previous one plus more rules, so the gap between two levels is the cost of the added expressions.
- `GET /leads/:id` — a read back from storage.
- An invalid body and an unknown id — the error path.

Every write goes to SQLite. `CONTRACT.md` says where: in the directory the `STATE_DIR` environment variable names, which an implementation seeds with the lead `seed` when it starts empty. The Telo implementation binds it as a root `Telo.DurableDirectory` need read from `STATE_DIR`, and attaches the trace and log sinks of the startup-span example below when `TRACE` is `true`. The native app uses the libraries Telo runs on, Fastify and better-sqlite3, on the same Node version, so the gap between the two is Telo's own overhead. Both start as users run them: the native app as compiled JavaScript under `node` (no `tsx`), Telo through the built CLI.

Measured for each implementation:

- Boot: cold (the subject's `caches` removed) and warm, from process start to the first successful response. For Telo, the startup span's duration beside it.
- Throughput at a fixed `concurrency`.
- Latency (p50, p99) at the workload's fixed `rate`, the same for every subject.
- CPU time per request and resident memory idle, at peak and after the load stops, both in the fixed-rate pass.
- Throughput and latency again with tracing and logging sinks attached (the `teloObserved` subject).

The headline figures are two ratios per workload, `telo` ÷ `node` of the medians: CPU per request and p99 at `rate`. Neither depends on how hard the generator can push. The throughput ratio is shown beside them and never alerted.

The comparison manifest, `benchmarks/lead-intake/comparison.yaml`:

```yaml
kind: Telo.Application
metadata:
  name: LeadIntakeComparison
imports:
  Benchmark: ../../modules/benchmark
variables:
  reportFile:
    env: REPORT_FILE
    type: string
    x-telo-type: Telo.HostPath
    default: ./comparison.json
targets:
  - !ref leadIntake
---
kind: Benchmark.Comparison
metadata:
  name: leadIntake
rounds: 5
boots: 20
subjects:
  - name: telo
    command: telo
    args: [run, telo.yaml]
    cwd: !module-path telo
    env: { PORT: "8845" }
    readiness: { url: http://127.0.0.1:8845/ping }
    caches: [.telo]
    stateDirectory: { env: STATE_DIR }
  - name: teloObserved
    command: telo
    args: [run, telo.yaml]
    cwd: !module-path telo
    env: { PORT: "8845", TRACE: "true" }
    readiness: { url: http://127.0.0.1:8845/ping }
    caches: [.telo]
    stateDirectory: { env: STATE_DIR }
    traceFile: spans.jsonl
  - name: node
    command: node
    args: [dist/server.js]
    cwd: !module-path node
    env: { PORT: "8845" }
    readiness: { url: http://127.0.0.1:8845/ping }
    stateDirectory: { env: STATE_DIR }
workloads:
  - name: ping
    duration: 30s
    warmup: 5s
    concurrency: 64
    rate: 2000
    requests:
      - { method: GET, url: http://127.0.0.1:8845/ping, expect: { status: 200 } }
  - name: leads
    duration: 30s
    warmup: 5s
    concurrency: 64
    rate: 1000
    requests:
      - method: POST
        url: http://127.0.0.1:8845/leads/heavy
        weight: 3
        headers: { content-type: application/json }
        body:
          email: alice.johnson@acme-corp.com
          company: { name: Acme Corp, employees: 850, country: US, industry: saas }
          plan: growth
        expect: { status: 201 }
      - { method: GET, url: http://127.0.0.1:8845/leads/seed, expect: { status: 200 } }
      - method: POST
        url: http://127.0.0.1:8845/leads/light
        headers: { content-type: application/json }
        body: { email: not-an-email }
        expect: { status: 400 }
report:
  file: !cel "variables.reportFile"
  thresholds:
    - { workload: leads, subject: telo, errorRate: 0.001 }
```

Subjects run one at a time, so they share the port. Telo keeps its cache in `.telo/` beside the entry manifest, which is why `caches: [.telo]` is relative to the `cwd`. `traceFile` names the JSON-lines file the subject's own `Telo.FileSink` writes. A request without `expect` accepts any 2xx; a response with another status counts as an error.

Running it on Linux:

```console
$ REPORT_FILE=./out/comparison.json telo run benchmarks/lead-intake/comparison.yaml

Boot        Subject       Cold     Warm     Startup span
            telo          612ms    388ms    -
            teloObserved  631ms    401ms    297ms
            node          142ms    139ms    -

Workload  Subject       RPS (c=64)  p50@rate  p99@rate  CPU/req  RSS idle/peak/after  Errors
ping      telo          14210.4     0.6ms     2.1ms     0.07ms   82/118/86 MB         0.00%
ping      teloObserved  11904.8     0.8ms     2.9ms     0.09ms   84/126/90 MB         0.00%
ping      node          23012.7*    0.4ms     1.2ms     0.04ms   58/74/61 MB          0.00%
leads     telo          4120.3      1.9ms     6.8ms     0.21ms   88/141/97 MB         0.00%
leads     teloObserved  3511.0      2.3ms     8.4ms     0.25ms   91/150/101 MB        0.00%
leads     node          9864.0      0.8ms     2.4ms     0.09ms   61/83/66 MB          0.00%

* generator-bound: the load generator saturated its cores; this throughput is a lower bound.
Rates: ping 2000/s, leads 1000/s. Generator on CPUs 0,1; subjects on CPUs 2,3. Median of 5 rounds; spread is in the report file.
```

`out/comparison.json` then holds the run's record:

```json
{
  "teloVersion": "0.112.0",
  "host": { "os": "ubuntu-24.04", "cpus": 4, "model": "AMD EPYC 7763", "node": "22.11.0", "generatorCpus": [0, 1], "subjectCpus": [2, 3] },
  "bootResults": [
    { "subject": "telo", "coldMs": { "median": 612, "min": 588, "max": 655, "cv": 0.04 }, "warmMs": { "median": 388, "min": 371, "max": 402, "cv": 0.03 } },
    { "subject": "teloObserved", "coldMs": { "median": 631, "min": 602, "max": 671, "cv": 0.04 }, "warmMs": { "median": 401, "min": 385, "max": 420, "cv": 0.03 }, "startupMs": { "median": 297, "min": 284, "max": 311, "cv": 0.03 } },
    { "subject": "node", "coldMs": { "median": 142, "min": 136, "max": 151, "cv": 0.03 }, "warmMs": { "median": 139, "min": 134, "max": 147, "cv": 0.03 } }
  ],
  "workloadResults": [
    { "workload": "ping", "subject": "telo", "throughput": { "median": 14210.4, "min": 13988.2, "max": 14301.9, "cv": 0.009 }, "generatorBound": false, "rate": 2000, "p50Ms": { "median": 0.6, "min": 0.6, "max": 0.7, "cv": 0.07 }, "p99Ms": { "median": 2.1, "min": 1.9, "max": 2.4, "cv": 0.08 }, "cpuPerRequestMs": { "median": 0.07, "min": 0.07, "max": 0.08, "cv": 0.05 }, "rssBytes": { "idle": 85983232, "peak": 123731968, "after": 90177536 }, "errors": { "count": 0, "rate": 0, "groups": [] } },
    { "workload": "ping", "subject": "teloObserved", "throughput": { "median": 11904.8, "min": 11690.1, "max": 12033.5, "cv": 0.011 }, "generatorBound": false, "rate": 2000, "p50Ms": { "median": 0.8, "min": 0.7, "max": 0.8, "cv": 0.05 }, "p99Ms": { "median": 2.9, "min": 2.6, "max": 3.3, "cv": 0.09 }, "cpuPerRequestMs": { "median": 0.09, "min": 0.09, "max": 0.1, "cv": 0.04 }, "rssBytes": { "idle": 88080384, "peak": 132120576, "after": 94371840 }, "errors": { "count": 0, "rate": 0, "groups": [] } },
    { "workload": "ping", "subject": "node", "throughput": { "median": 23012.7, "min": 22841.0, "max": 23102.3, "cv": 0.004 }, "generatorBound": true, "rate": 2000, "p50Ms": { "median": 0.4, "min": 0.4, "max": 0.5, "cv": 0.08 }, "p99Ms": { "median": 1.2, "min": 1.1, "max": 1.4, "cv": 0.09 }, "cpuPerRequestMs": { "median": 0.04, "min": 0.04, "max": 0.05, "cv": 0.06 }, "rssBytes": { "idle": 60817408, "peak": 77594624, "after": 63963136 }, "errors": { "count": 0, "rate": 0, "groups": [] } },
    { "workload": "leads", "subject": "telo", "throughput": { "median": 4120.3, "min": 4031.8, "max": 4188.6, "cv": 0.016 }, "generatorBound": false, "rate": 1000, "p50Ms": { "median": 1.9, "min": 1.8, "max": 2.1, "cv": 0.05 }, "p99Ms": { "median": 6.8, "min": 6.1, "max": 7.9, "cv": 0.09 }, "cpuPerRequestMs": { "median": 0.21, "min": 0.2, "max": 0.23, "cv": 0.04 }, "rssBytes": { "idle": 92274688, "peak": 147849216, "after": 101711872 }, "errors": { "count": 0, "rate": 0, "groups": [] } },
    { "workload": "leads", "subject": "teloObserved", "throughput": { "median": 3511.0, "min": 3440.7, "max": 3570.2, "cv": 0.014 }, "generatorBound": false, "rate": 1000, "p50Ms": { "median": 2.3, "min": 2.2, "max": 2.5, "cv": 0.05 }, "p99Ms": { "median": 8.4, "min": 7.6, "max": 9.5, "cv": 0.08 }, "cpuPerRequestMs": { "median": 0.25, "min": 0.24, "max": 0.27, "cv": 0.04 }, "rssBytes": { "idle": 95420416, "peak": 157286400, "after": 105906176 }, "errors": { "count": 0, "rate": 0, "groups": [] } },
    { "workload": "leads", "subject": "node", "throughput": { "median": 9864.0, "min": 9702.4, "max": 9950.1, "cv": 0.009 }, "generatorBound": false, "rate": 1000, "p50Ms": { "median": 0.8, "min": 0.8, "max": 0.9, "cv": 0.05 }, "p99Ms": { "median": 2.4, "min": 2.2, "max": 2.7, "cv": 0.07 }, "cpuPerRequestMs": { "median": 0.09, "min": 0.09, "max": 0.1, "cv": 0.04 }, "rssBytes": { "idle": 63963136, "peak": 87031808, "after": 69206016 }, "errors": { "count": 0, "rate": 0, "groups": [] } }
  ]
}
```

A run whose errors break a threshold prints them and exits non-zero:

```console
Errors  Subject  Workload  Status  Count  Message                       Sample
        telo     leads     500     131    expected status 201, got 500  {"code":"ERR_SQL_BUSY","detail":"database is locked"}

THRESHOLD FAIL [leads/telo] errorRate 0.40% > 0.10%
```

Refusals, each ending the run:

```console
$ telo run benchmarks/lead-intake/comparison.yaml
[ERR_BENCHMARK_PLATFORM_UNSUPPORTED] Benchmark.Comparison "leadIntake" samples process memory and CPU from /proc and pins cores with taskset, which this host (darwin) does not have. Run it on Linux with at least 2 physical cores.

[ERR_BENCHMARK_BOOT_FAILED] Benchmark.Comparison "leadIntake": subject "telo" exited with code 1 before http://127.0.0.1:8845/ping answered (round 2, cold boot 1). Last stderr line: Error: listen EADDRINUSE: address already in use 127.0.0.1:8845

[ERR_BENCHMARK_STARTUP_SPAN_MISSING] Benchmark.Comparison "leadIntake": subject "teloObserved" names traceFile spans.jsonl, but after round 1, boot 1 it holds no "startup" span. Attach a Telo.LogTraceSink under tracing.sinks and a Telo.FileSink writing spans.jsonl under logging.sinks.
```

### 2. Feature cost: Telo only (`benchmarks/feature-cost/`)

A Node script generates plain manifests under `benchmarks/feature-cost/generated/`, never through `!for-each`, which would mix that feature's own cost into the others. Each feature runs at the sizes of its class:

- Counts and widths: N = 1, 10, 100, 1000.
- Depth and nesting (import depth, `extends` depth, `!for-each` nesting, `try` nesting): N = 1, 4, 16, 64, 256.
- Independent dimensions (`choiceDimensions`, `!if` / `!switch`): N = 1, 2, 4, 8, 16.

Covered: resource count (the baseline), `!if` / `!switch` by count (`choiceCount`) and by independent dimensions (`choiceDimensions`), `!for-each` iterations and nesting, templated-kind consumers and `extends` depth, import depth, width and `shared` vs `isolated`, CEL expressions per request and their size, step count and `try` nesting, execution-scope members, contract schema size, module function calls, and text catalog size. Every generated application carries the `logging` / `tracing` blocks of the startup-span example below.

For each feature and N the script also writes a `Benchmark.Comparison` with no workloads, which measures boots only — `telo run` to exit and `telo check` — at `rounds: 5, boots: 1`; history, not in-run spread, carries the statistics. The script stops a feature at the first N whose comparison fails and records that N, the code and the message as the feature's `firstFailure`. For `choiceDimensions` at N = 8:

```yaml
kind: Telo.Application
metadata:
  name: FeatureCostChoiceDimensions8
imports:
  Benchmark: ../../../modules/benchmark
variables:
  reportFile:
    env: REPORT_FILE
    type: string
    x-telo-type: Telo.HostPath
    default: ./choice-dimensions-8.json
targets:
  - !ref choiceDimensions8
---
kind: Benchmark.Comparison
metadata:
  name: choiceDimensions8
rounds: 5
boots: 1
subjects:
  - name: run
    command: telo
    args: [run, telo.yaml]
    cwd: !module-path choice-dimensions-8
    env: { TRACE: "true" }
    caches: [.telo]
    bootTimeout: 60s
    traceFile: spans.jsonl
  - name: check
    command: telo
    args: [check, telo.yaml]
    cwd: !module-path choice-dimensions-8
    caches: [.telo]
    bootTimeout: 60s
report:
  file: !cel "variables.reportFile"
```

A subject with no `readiness` runs to exit; a non-zero exit or one past `bootTimeout` (default 60s) is `ERR_BENCHMARK_BOOT_FAILED`. One `feature-cost.jsonl` line per feature, shown wrapped:

```json
{
  "commit": "8b808da48", "teloVersion": "0.112.0",
  "host": { "os": "ubuntu-24.04", "cpus": 4, "model": "AMD EPYC 7763", "node": "22.11.0", "generatorCpus": [0, 1], "subjectCpus": [2, 3] },
  "feature": "choiceDimensions",
  "sizes": [
    { "n": 1, "runColdMs": { "median": 402, "min": 391, "max": 420, "cv": 0.03 }, "runWarmMs": { "median": 251, "min": 244, "max": 262, "cv": 0.03 }, "startupMs": { "median": 118, "min": 112, "max": 126, "cv": 0.04 }, "checkColdMs": { "median": 361, "min": 350, "max": 377, "cv": 0.03 }, "checkWarmMs": { "median": 204, "min": 198, "max": 213, "cv": 0.03 } },
    { "n": 2, "runColdMs": { "median": 409, "min": 398, "max": 425, "cv": 0.03 }, "runWarmMs": { "median": 255, "min": 247, "max": 266, "cv": 0.03 }, "startupMs": { "median": 121, "min": 115, "max": 130, "cv": 0.04 }, "checkColdMs": { "median": 368, "min": 356, "max": 384, "cv": 0.03 }, "checkWarmMs": { "median": 209, "min": 202, "max": 219, "cv": 0.03 } },
    { "n": 4, "runColdMs": { "median": 431, "min": 418, "max": 449, "cv": 0.03 }, "runWarmMs": { "median": 268, "min": 260, "max": 280, "cv": 0.03 }, "startupMs": { "median": 133, "min": 127, "max": 141, "cv": 0.04 }, "checkColdMs": { "median": 395, "min": 383, "max": 411, "cv": 0.03 }, "checkWarmMs": { "median": 231, "min": 224, "max": 241, "cv": 0.03 } },
    { "n": 8, "runColdMs": { "median": 702, "min": 680, "max": 735, "cv": 0.03 }, "runWarmMs": { "median": 455, "min": 441, "max": 472, "cv": 0.03 }, "startupMs": { "median": 318, "min": 305, "max": 333, "cv": 0.04 }, "checkColdMs": { "median": 688, "min": 667, "max": 716, "cv": 0.03 }, "checkWarmMs": { "median": 520, "min": 503, "max": 541, "cv": 0.03 } }
  ],
  "firstFailure": { "n": 16, "code": "ERR_BENCHMARK_BOOT_FAILED", "message": "subject \"check\" did not exit within 60s (round 1, cold boot 1)" }
}
```

### 3. Authoring: agents (`benchmarks/authoring/`)

One general coding agent, Claude Code run non-interactively with JSON output, builds the lead-intake app from `CONTRACT.md`, once in Node and once in Telo. Three change tasks then start from the repo's own two implementations: add a field end to end, add a validation rule, add an endpoint. Each change task is a directory holding its `TASK.md`, and its contract tests are the base contract tests plus the cases the change adds.

- **Harness.** A Node script in `benchmarks/authoring/`, run by the workflow, does one attempt at a time: it starts a fresh container holding only the task directory and the prose (`CONTRACT.md`, plus `TASK.md` for a change task), runs the agent in it on the pinned model, takes the token counts, cost and turns from the agent's JSON result, then boots the built app outside the container with a fresh `STATE_DIR` and runs the contract tests against it. Parity means passing them.
- **Context.** The Telo side gets the published `telo` CLI, the hub's MCP server and the authoring primer. The Node side gets Node and npm; models already know Fastify.
- **Reported per side:** total token spend side by side (median per passing attempt; the Telo side's includes the primer and hub context, since they are part of what authoring in Telo costs), success rate and median time. The built apps are then run through family 1.
- **Repeats and budget.** Five attempts per side per task. An attempt that exceeds 60 minutes or USD 20 counts as failed, so one run costs at most USD 800 (2 sides × 4 tasks × 5 attempts). The model is pinned and recorded, and results compare only within one model.

One `authoring.jsonl` line per attempt:

```json
{"commit":"8b808da48","teloVersion":"0.112.0","model":"claude-opus-5-5","task":"build","side":"telo","attempt":3,"tokens":{"input":182340,"output":41210,"cacheRead":2410388,"cacheWrite":201544},"costUsd":4.12,"turns":38,"toolCalls":121,"wallSeconds":1460,"contractTestsPassed":true,"linesWritten":412}
```

### Toolset: the benchmark module

TypeScript, no external generator. One load engine serves both kinds: fixed-memory histograms for percentiles, errors grouped by status (or error code) and message with a sample of each, and one record shape. `Benchmark.Suite` keeps its role — thresholds in CI and benchmarks that call resources inside one process — and its closed loop and `validate`; it gains the histograms and the error groups. A new runnable kind `Benchmark.Comparison` carries every out-of-process measurement:

- **Subjects and starting.** Each subject names a `command`, its `args`, `env` and `cwd` (a `Telo.HostPath`), `readiness: { url }` or nothing for "runs to exit", and `bootTimeout`. `caches` lists paths, relative to `cwd`, removed before each cold boot. `stateDirectory: { env }` gives every boot a fresh empty directory in that variable, removed when the boot ends. `Benchmark.Comparison` starts each subject itself, samples resident memory and CPU of the whole process tree, and ends a boot with SIGTERM, waiting for the subject to exit.
- **Startup span.** When a subject names `traceFile`, the file is emptied before every boot and, after each boot measurement has exited (which flushes the subject's sinks), read up to the span whose name starts with `startup `. Load passes do not read it.
- **Rounds.** Subjects alternate over `rounds` (default 5), with `boots` boots each (default 20). Every load pass runs on a boot of its own, so no pass sees rows an earlier pass wrote.
- **CPU pinning.** `Benchmark.Comparison` splits the whole physical cores it may use into two halves, keeping SMT siblings together and giving an odd core to the subjects. It pins itself and its generator threads to the first half, and starts every subject under `taskset` on the second. The split is written into the record as `host.generatorCpus` and `host.subjectCpus`.
- **HTTP workloads.** A workload is optional. Each runs a throughput pass at `concurrency` and, when it states `rate`, a latency pass at that many requests per second, with weighted requests and an `expect: { status }`. The load loop sends directly through undici across worker threads, outside Telo's call path. In the fixed-rate pass, latency is measured from each request's scheduled send time.
- **Generator saturation.** The throughput pass records the generator's own CPU use over its cores; at 90% or more the workload result is written with `generatorBound: true`, and its throughput is shown as a lower bound.
- **Spread.** Every timing figure is the median over all its samples (rounds × boots for a boot, rounds for a pass), with min, max and coefficient of variation beside it. The memory points in `rssBytes` are medians.
- **Output.** A table on stdout, the run's record at `report.file` (a `Telo.HostPath`), and thresholds that fail the run.
- **Errors.** `ERR_BENCHMARK_PLATFORM_UNSUPPORTED` before any subject starts, on a host without `/proc` or `taskset` or with fewer than 2 physical cores, rather than reporting zeros; `ERR_BENCHMARK_BOOT_FAILED` when a subject exits before it is ready, exits non-zero when it runs to exit, or passes `bootTimeout`, naming which with its exit code and last stderr line; `ERR_BENCHMARK_STARTUP_SPAN_MISSING` when a `traceFile` holds no startup span after a boot.

`Benchmark.Suite`'s JSON report adopts the shared `errors` record. Before:

```json
{
  "Score": { "total": 31840, "rps": 1061.3, "p50": 8.9, "p95": 14.2, "p99": 21.7, "errors": 3, "errorRate": 0.0000942 }
}
```

After:

```json
{
  "Score": {
    "total": 31840, "rps": 1061.3, "p50": 8.9, "p95": 14.2, "p99": 21.7,
    "errors": {
      "count": 3,
      "rate": 0.0000942,
      "groups": [
        { "code": "ERR_HTTP_REQUEST_FAILED", "message": "validate returned false: status 500", "count": 3, "sample": "{\"code\":\"ERR_SQL_BUSY\",\"detail\":\"database is locked\"}" }
      ]
    }
  }
}
```

### Kernel: the startup span

The Node kernel records startup as one span, `startup <application name>`, from the process start the CLI passes (a kernel started any other way — `App.Instance`, `ctx.runtime.run` — from its creation) to the end of the init loop. Until `tracing:` resolves, the kernel keeps only its start time; with a trace sink attached the span is exported with its real start time, and with none it is discarded. The tracing spec, the tracing guide, the authoring primer and the tracing entry in `docs/guides/what-you-get.md` say so. The Rust kernel has no tracing yet, so it has nothing to add now.

An application that writes it to a file:

```yaml
kind: Telo.Application
metadata:
  name: TracedStartup
variables:
  trace: { env: TRACE, type: boolean, default: false }
logging:
  sinks:
    - sink: { kind: Telo.FileSink, destination: spans.jsonl, encoding: json }
      when: !cel "variables.trace"
tracing:
  sinks:
    - sink: { kind: Telo.LogTraceSink }
      when: !cel "variables.trace"
```

```console
$ TRACE=true telo run telo.yaml
```

`spans.jsonl` then holds:

```json
{"msg":"startup TracedStartup","event_name":"telo.span","trace_id":"4f9c2a7e0b1d4c3e8a6f5b2d9e0c1a7b","span_id":"a1b2c3d4e5f60718","attributes":{"telo.span.outcome":"ok","telo.span.duration_ms":297}}
```

### Running and publishing

- **Comparison and feature cost:** `.github/workflows/benchmarks.yml` runs them nightly at 03:00 UTC on `main`, plus manually, on GitHub-hosted runners. The two headline ratios are the published figures; absolute numbers carry the host's specs.
- **Authoring:** `.github/workflows/benchmarks-authoring.yml` runs it on manual dispatch only, against a published CLI and the hub.
- **History:** each run appends its records, one per line, to `comparison.jsonl`, `feature-cost.jsonl` or `authoring.jsonl` on the orphan branch `benchmark-results`, adding the commit. Every record carries the commit, telo version, host and, for authoring, the model. Both workflows share one concurrency group, so two runs never append at once.
- **Regression alerts:** a figure opens an issue labelled `benchmark-regression` when it is worse than the median of the last 10 runs by more than the threshold, and worse than every one of those 10. The figures are the two headline ratios per workload (threshold 10%) and each feature's run and check times at the largest N every run in the window completed (threshold 15%); a feature whose `firstFailure` moves to a smaller N also alerts. Fewer than 10 runs of history means no alert, and a figure that already has an open issue gets a comment instead of a second issue.
- **Docs page:** `docs/reference/benchmarks.md` holds the hand-written methodology. The page reads the history files from `benchmark-results` in the reader's browser, through `raw.githubusercontent.com`, and renders the latest tables, the two headline ratios and the throughput ratio per workload, and the trend charts beneath them; when the fetch fails (no branch yet, a fork, offline) it renders "no results yet" in their place. Nothing redeploys the site: the docs deploy from release tags only, and the page shows the newest results whichever release built it.

**Retired:** `benchmarks/feedback`, `benchmarks/score`, `benchmarks/scripts/run-bench.mjs`, and their lines in the root `ci` script.

## Decisions

- **The headline is two ratios measured on hosted runners.** Alternating subjects on one machine keeps a ratio stable while absolute numbers vary 10–20%. CPU per request and p99 at a fixed rate do not depend on the generator's ceiling, which on a 4-core runner the native `ping` reaches most nights. A dedicated machine was rejected until the ratios prove too noisy.
- **One app with endpoints per CEL level, not three apps.** Every level shares one server, one storage layer and one memory profile, so CEL density is the only difference. Three apps would mean six implementations now and nine with Rust.
- **The load engine is TypeScript inside the module.** A lean Node generator is how Fastify benchmarks itself, and the generator's own CPU use is recorded on every throughput pass. An external tool (oha) and a Rust generator were rejected: the headline figures do not depend on the generator's ceiling.
- **Saturation is recorded, not refused.** A calibration endpoint does not reflect the real workloads, and on a 4-core runner a fixed headroom rule would refuse most nightly runs.
- **The core split is a rule, not a field.** Every manifest and every history row then split the same way, and a bigger runner needs no edit.
- **One load engine for both kinds.** Two engines would give two accuracies for the same figure; `Benchmark.Suite` keeps its closed loop and its CEL `validate` because it runs inside the process it measures.
- **Responses are checked by status only.** A CEL check per response would need a second CEL environment in every generator thread; correctness is the contract tests' job.
- **Where state lives is the contract's.** `STATE_DIR` is stated once in `CONTRACT.md`, so a comparison needs no implementation's private database path — including an app an agent built.
- **`Benchmark.Comparison` is one kind, not separate program and workload kinds.** Process lifetimes belong to the rounds the comparison alternates, so a program cannot be a long-lived service that starts once.
- **The latency rate is a literal, the same for every subject.** The author picks it below the slowest subject's capacity.
- **Spread is recorded, never used to discard a run.** A run flagged unreliable would leave the alert baseline empty on noisy runners.
- **No install size.** It would be defined differently per subject — a CLI install outside the subject for Telo, `node_modules` for Node — and nothing acts on it.
- **Feature manifests are generated at run time, never committed.** N changes freely and nothing large sits in the repo. A test generates N = 2 for every feature and `telo check`s it, so the generator cannot silently break.
- **Only `telo check` time is measured for analysis.** The editor engine runs the same analysis, so driving an editor protocol session would add a harness and measure nothing new.
- **Startup time comes from tracing, as one span.** Authors then get the same figure in their own traces. A benchmark-only timing flag was rejected as a second mechanism next to tracing. Per-phase spans were rejected: the init loop interleaves controller loading, compilation and creation, so a span per phase would claim intervals that never happened.
- **The same general agent on both sides, given the prose contract only.** Using the repo's authoring agent for Telo would mix that agent's quality into the comparison. The contract tests are Telo manifests the Node side could not run, so neither side gets them; they decide parity from outside.
- **Authoring runs only on manual dispatch.** Every attempt costs tokens, so a person decides when one is worth it.
- **Regressions alert instead of failing CI.** There are no per-feature time budgets until a few weeks of history show what the stable values are.
- **History lives on an orphan branch.** Workflow artifacts expire after 90 days, and bot commits on `main` would add noise to its history.

## Release and docs bookkeeping

- `modules/benchmark`:
  - Gains `docs/` covering both kinds, the shared engine, the core split, the per-pass boots and the three codes.
  - Its README is updated, and its descriptions are rewritten to the hub rule.
  - Gets an `Added` release fragment covering `Benchmark.Comparison` and the change to `Benchmark.Suite`'s report.
  - Needs a `requires:` floor only if its own `telo.yaml` adopts syntax newer than the latest release, verified by running the previous CLI against it.
- The kernel's startup span ships with a changeset on the telo version line.
- `benchmarks/README.md` describes the three families.

## Verify

- **Contract test.** It passes against both lead-intake implementations in CI, and the feature-cost generator test passes.
- **Hidden stalls.** On a fixture server that sleeps 200 ms once every second, the fixed-rate p99 reflects every request scheduled during the stall.
- **Generator saturation.** A run against a server faster than the generator writes `generatorBound: true` on that workload result, and the table marks it.
- **Core split.** During a run, `Cpus_allowed_list` in `/proc/<pid>/status` shows disjoint sets for the subject's process tree and every generator thread, matching `host.generatorCpus` / `host.subjectCpus`.
- **Fresh state.** Two rounds of the `leads` workload start every pass with only `seed` stored, for every subject, and nothing is left under any subject's `cwd` but its `caches`.
- **Refusals.** On macOS the comparison exits with `ERR_BENCHMARK_PLATFORM_UNSUPPORTED` before starting a subject; a subject whose port is taken gives `ERR_BENCHMARK_BOOT_FAILED` with its exit code; `teloObserved` with `TRACE` removed gives `ERR_BENCHMARK_STARTUP_SPAN_MISSING`.
- **Suite errors.** A Suite run against an endpoint that answers 500 reports the error group with its code, message and a sample, and its memory stays flat over a long run.
- **Feature limits.** A fixture that hangs at N = 64 records `firstFailure` at 64 with `ERR_BENCHMARK_BOOT_FAILED` within `bootTimeout`, and the run continues with the next feature; the nightly job finishes in under 2 hours.
- **First nightly run.** It appends records to `benchmark-results`, the docs page shows them, and a forced 15% CPU-per-request regression in `telo` opens one labelled issue for that workload's ratio; forcing it again adds a comment, not a second issue. A feature whose limit rises from 8 to 16 opens no issue.
- **Startup span.** `TRACE=true telo run` of the example above writes exactly one `startup TracedStartup` span; with `TRACE` unset nothing is written. On a fixture whose resource sleeps 200 ms in init, the span lasts at least 200 ms.
- **Authoring.** One manual run records, for both sides, token counts, cost, turns, wall time and contract-test results.
