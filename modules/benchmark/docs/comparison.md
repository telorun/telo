# Benchmark.Comparison

Compares programs it starts itself — two implementations of one API, or one command at several sizes. For every subject it measures boot time, and for every workload the throughput at a concurrency, the latency at a fixed rate, the CPU each request costs and the resident memory. It runs on Linux only.

```yaml
kind: Benchmark.Comparison
metadata: { name: leadIntake }
rounds: 5
boots: 20
subjects:
  - name: telo
    command: telo
    args: [run, telo.yaml]
    cwd: !module-path telo
    env: { PORT: "8845", TELO_CACHE_DIR: .telo }
    readiness: { url: http://127.0.0.1:8845/ping }
    caches: [.telo]
    stateDirectory: { env: STATE_DIR }
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
report:
  file: !cel "variables.reportFile"
  thresholds:
    - { workload: ping, subject: telo, errorRate: 0.001 }
```

## Subjects

A subject is a `command` with its `args`, started in `cwd` with `env` set over the environment of the running app. Subjects run one at a time, so they may share a port.

- **`readiness: { url }`** — a boot ends at the first 2xx answer at that url, and the subject is then stopped. Without it the subject runs to exit, and the boot ends when it does; a non-zero exit fails the run.
- **`bootTimeout`** (default `60s`) — how long a boot may take to become ready or to exit, and how long a subject may take to exit after SIGTERM.
- **`caches`** — paths inside `cwd` removed before every cold boot. A path that leaves `cwd`, or names `cwd` itself, is refused by the schema. A Telo subject under a `telo-workspace.yaml` keeps its cache at the marker, not in `cwd`; set `TELO_CACHE_DIR: .telo` in its `env` so `caches: [.telo]` names it.
- **`stateDirectory: { env }`** — every boot and load pass gets a fresh empty directory, outside `cwd`, named in that variable and removed when it ends. No pass sees what an earlier one wrote.
- **`traceFile`** — the JSON-lines file, inside `cwd`, the subject's own file sink writes spans to (see [Startup span](#startup-span)).

Each subject is started under `taskset` in a process group of its own. A boot ends with SIGTERM to the whole group, so processes the subject started go too; one still running `bootTimeout` later is killed with SIGKILL and the run fails. Before a subject with `readiness` starts, its url must not already answer: another process holding the port would answer for it.

## Rounds and boots

Subjects take turns over `rounds` (default 5), in the order declared. In each round every subject runs, in order:

1. `boots` (default 20) pairs of boots: a **cold** boot, with `caches` removed first, then a **warm** boot, with the caches the cold boot left. A subject with no `caches` reports both.
2. For each workload, a **throughput pass** and, when the workload states `rate`, a **latency pass**, each on a warm boot of its own.

Boot time runs from the moment the process is started to its first 2xx readiness answer, or to its exit.

## The core split

Before any subject starts, the comparison takes the whole physical cores it may run on (its own CPU affinity, a core counted only when all its SMT siblings are allowed), sorted by their lowest CPU, and splits them in two halves: the first for the comparison itself and its load generator threads, the second — with the odd core, when the count is odd — for the subjects. It pins all its own threads to the first half for the run (threads it starts later inherit that) and restores its affinity afterwards; every subject starts under `taskset` on the second half. The split is a rule, not a field, so every run and every history row splits the same way, and it is written into the record as `host.generatorCpus` and `host.subjectCpus`.

## Load passes

The load is sent directly over HTTP through undici, from one generator thread per generator CPU (at most one per connection), outside Telo's call path. Requests are sent in proportion to their `weight`, in one fixed interleaved order, so every subject and every pass sends the same mix. Each pass sends load for `warmup` unmeasured, then measures for `duration`.

- **Throughput pass** — `concurrency` connections, each sending its next request as soon as the previous one answers. Its figure is the responses received in the window, per second. A transport failure counts as an error but not as a response.
- **Latency pass** — requests go out on a fixed schedule at `rate` per second over all threads, over `concurrency` connections, whatever the server does. Latency is measured from each request's **scheduled** send time, so a server stall delays every request due during it and shows in p99 (no coordinated omission). Requests scheduled in the window are measured to their answer, even one that arrives after the window closes. Choose `concurrency` large enough for `rate` × latency, or requests queue in the generator — which the latency also shows.

A request without `expect` accepts any 2xx; a response with another status is an error, grouped as `expected status <n>, got <m>` (or `expected a 2xx status, got <m>`) with the start of its body as the sample. Responses are checked by status only. A request with no response within 30 s is an error. A subject that exits during a pass fails the run.

### Saturation

The throughput pass records the comparison's own CPU use (every thread of its process) over the generator cores. When the median over rounds is 90% or more, the workload result is written with `generatorBound: true` and its throughput is a lower bound: the generator, not the subject, set the ceiling. The table marks it with `*`. Saturation is recorded, never refused. The latency-pass figures do not depend on the generator's ceiling.

### CPU and memory

Both come from the latency pass, over the subject's whole process tree read from `/proc`:

- **CPU per request** — user and system time of every process in the tree (children it already reaped included) over the measured window, until every measured request has answered, divided by the requests measured.
- **Resident memory** — `idle` is read one second after the boot is ready, before any load; `peak` is the largest reading, every 100 ms, while load is sent; `after` is read one second after the last request answered.

## Spread

Every timing figure is the median over all its samples — rounds × boots for a boot, rounds for a pass — with its min, max and coefficient of variation beside it (see [measurement](measurement.md)). The `rssBytes` points are medians over rounds. Spread is recorded, never used to discard a run.

## Startup span

When a subject names `traceFile`, the file is removed before every boot and pass. After each measured boot has exited — which flushes the subject's sinks — it is read up to the first span whose name starts with `startup ` (a record with `event_name: telo.span`), and that span's `telo.span.duration_ms` is the sample. The file is read and required after every cold and warm boot; the reported `startupMs` is over the warm boots, beside the warm boot time it is a part of. Load passes do not read it. A Telo subject writes it with:

```yaml
logging:
  sinks:
    - sink: { kind: Telo.FileSink, destination: spans.jsonl, encoding: json }
tracing:
  sinks:
    - sink: { kind: Telo.LogTraceSink }
```

## Output

On stdout, a boot table and, with workloads, a workload table:

```console
Boot      Subject       Cold   Warm   Startup span
          telo          612ms  388ms  -
          node          142ms  139ms  -

Workload  Subject       RPS (c=64)  p50@rate  p99@rate  CPU/req  RSS idle/peak/after  Errors
ping      telo          14210.4     0.6ms     2.1ms     0.07ms   82/118/86 MB         0.00%
ping      node          23012.7*    0.4ms     1.2ms     0.04ms   58/74/61 MB          0.00%

* generator-bound: the load generator saturated its cores; this throughput is a lower bound.
Rates: ping 2000/s. Generator on CPUs 0,1; subjects on CPUs 2,3. Median of 5 rounds; spread is in the report file.
```

When any request failed, the error groups follow (`Errors  Subject  Workload  Status  Count  Message  Sample`). Progress is logged as the run goes.

### The record

With `report.file`, the run's record is written there as one line of JSON, after the last round:

```json
{
  "teloVersion": "0.112.0",
  "host": { "os": "ubuntu-24.04", "cpus": 4, "model": "AMD EPYC 7763", "node": "22.11.0", "generatorCpus": [0, 1], "subjectCpus": [2, 3] },
  "bootResults": [
    { "subject": "telo", "coldMs": { "median": 612, "min": 588, "max": 655, "cv": 0.04 }, "warmMs": { "median": 388, "min": 371, "max": 402, "cv": 0.03 } }
  ],
  "workloadResults": [
    { "workload": "ping", "subject": "telo", "throughput": { "median": 14210.4, "min": 13988.2, "max": 14301.9, "cv": 0.009 }, "generatorBound": false, "rate": 2000, "p50Ms": { "median": 0.6, "min": 0.6, "max": 0.7, "cv": 0.07 }, "p99Ms": { "median": 2.1, "min": 1.9, "max": 2.4, "cv": 0.08 }, "cpuPerRequestMs": { "median": 0.07, "min": 0.07, "max": 0.08, "cv": 0.05 }, "rssBytes": { "idle": 85983232, "peak": 123731968, "after": 90177536 }, "errors": { "count": 0, "rate": 0, "groups": [] } }
  ]
}
```

- `teloVersion` is the version of the telo CLI running the comparison, `null` when the process was not started by it (a warning says so). `host.os` is `<ID>-<VERSION_ID>` from `/etc/os-release`, `cpus` the logical CPUs, `model` the CPU's model name, `node` the runtime's Node version.
- A subject with a `traceFile` also has `startupMs`.
- A workload without `rate` has `rate`, `p50Ms`, `p99Ms`, `cpuPerRequestMs` and `rssBytes` set to `null`.
- `errors` merges both passes over every round; `rate` is errors over the requests measured.
- A comparison with no workloads writes `"workloadResults": []`.
- Times are in milliseconds, rounded to the microsecond; throughput to one decimal.

### Thresholds

Each `report.thresholds` entry judges the workload results it names — `workload` and `subject`, either omitted for all — with `errorRate`, and `p50` / `p99` in milliseconds against the median at the workload's rate. The record is written first; then a breach prints `THRESHOLD FAIL [<workload>/<subject>] <metric> <actual> > <limit>` on stderr and the run exits with code 1.

`telo check` refuses, at the line, a threshold that judges no declared workload, one naming an undeclared subject, and a latency limit on a workload with no `rate` — as well as two subjects or two workloads sharing a name, and a subject without `readiness` in a comparison with workloads. The same is refused with `ERR_BENCHMARK_COMPARISON_INVALID` when the resource is created where `telo check` does not reach.

## Refusals

Each ends the run with the code and message on stderr and exit code 1:

| Code | When |
| --- | --- |
| `ERR_BENCHMARK_PLATFORM_UNSUPPORTED` | Before any subject starts, on a host that is not Linux, has no `/proc`, no `taskset` on `PATH`, no `getconf CLK_TCK`, no CPU topology in `/sys`, or fewer than 2 whole physical cores this process may use. The message names which. |
| `ERR_BENCHMARK_BOOT_FAILED` | A subject exits before it is ready, exits non-zero when it runs to exit, does not become ready or exit within `bootTimeout`, does not exit within `bootTimeout` of SIGTERM, exits during a pass, or its readiness url already answers before it starts. The message names which, with the exit code, where (`(round 2, cold boot 1)`, `(round 1, latency pass of ping)`) and the last line the subject wrote to stderr. |
| `ERR_BENCHMARK_STARTUP_SPAN_MISSING` | A `traceFile` holds no startup span after a boot. |
| `ERR_BENCHMARK_COMPARISON_INVALID` | The resource breaks a rule above, when it is created. |

`telo run` prints one as:

```console
comparison.yaml  error  Benchmark.Comparison "leadIntake": subject "telo" exited with code 1 before http://127.0.0.1:8845/ping answered (round 2, cold boot 1). Last stderr line: Error: listen EADDRINUSE: address already in use 127.0.0.1:8845  ERR_BENCHMARK_BOOT_FAILED
```
