# Benchmark program: Telo vs native, feature cost, agent authoring

## Problem

Nothing publishes how Telo performs, or what an author gains or pays for it. Today `benchmarks/feedback` and `benchmarks/score` each pair a Fastify app with a Telo twin, and an orchestrator script prints a latency table on demand. They run on no schedule and keep no history, and no page shows the results. Boot time, memory and CPU are not measured at all.

The load loop in `Benchmark.Suite` would also give wrong numbers for a Telo-vs-native comparison:

- **Hidden stalls.** Each worker waits for its response before sending the next request, so a server stall counts as one slow sample instead of every request that should have gone out meanwhile. This understates p99, and understates it more for the slower server.
- **The generator can be the bottleneck.** Every request passes through Telo's call path and the `Http.Request` controller, all on one Node thread, so a throughput figure can measure the generator instead of the server.
- **The generator disturbs its own timings.** Samples go into an array that grows with the run and is sorted at the end; the generator's garbage collection pauses then show up as latency.
- **Errors are only counted.** A failure becomes +1 with no status code or message.
- **One run, no spread.** Variants are never alternated, and nothing records how much the result varies.

Telo's own costs are invisible as well. Some features — `!if` / `!switch` across independent dimensions, `!for-each`, deep imports — may grow startup time steeply, and no measurement would catch a change that makes one of them worse. Nobody has measured whether a coding agent builds the same app faster, or with fewer tokens, in Telo than in plain Node.

## Solution

Three benchmark families share one toolset, one result history and one docs page.

**1. Comparison: Telo vs native** (`benchmarks/lead-intake/`). A lead-intake API grows out of `score` and replaces both existing suites. It has one prose contract (`CONTRACT.md`), one contract test written as Telo manifest tests that run against any implementation's URL, and the implementations `telo/` and `node/`, with `rust/` to follow. Endpoints:

- `GET /ping` — no CEL, the framework floor.
- `POST /leads/light`, `/medium`, `/heavy` — about 5, 25 and 80 CEL expressions. Each level is the previous one plus more rules, so the gap between two levels is the cost of the added expressions.
- `GET /leads/:id` — a read back from storage.
- An invalid body and an unknown id — the error path.

Every write goes to SQLite. The native app uses the libraries Telo runs on, Fastify and better-sqlite3, on the same Node version, so the gap between the two is Telo's own overhead. Both start as users run them: the native app as compiled JavaScript under `node` (no `tsx`), Telo through the built CLI.

Measured for each implementation:

- Boot: cold (empty `.telo/` cache) and warm, from process start to the first successful response.
- Throughput with a fixed number of parallel clients.
- Latency (p50, p99) at a fixed rate of half native's throughput.
- Resident memory idle, at peak and after the load stops.
- CPU time per request.
- Install size.
- Throughput and latency again with tracing and logging sinks attached.

**2. Feature cost: Telo only** (`benchmarks/features/`). A Node script generates plain manifests, never through `!for-each`, which would mix that feature's own cost into the others. Each feature is generated at N = 1, 10, 100 and 1000, and the growth shape is reported alongside the times. Covered: resource count (the baseline), `!if` / `!switch` by count and by independent dimensions, `!for-each` iterations and nesting, templated-kind consumers and `extends` depth, import depth, width and `shared` vs `isolated`, CEL expressions per request and their size, step count and `try` nesting, execution-scope members, contract schema size, module function calls, and text catalog size. Startup cost is reported per boot phase, and `telo check` time is measured on the same manifests.

**3. Authoring: agents** (`benchmarks/authoring/`). One general coding agent, Claude Code run non-interactively with JSON output, builds the lead-intake app from `CONTRACT.md` and the visible contract tests, once in Node and once in Telo. Three change tasks then start from the repo's own two implementations: add a field end to end, add a validation rule, add an endpoint.

- **Isolation.** Each attempt runs in a fresh container that holds only its task directory. Hidden tests run from outside the container afterwards, and parity means passing them.
- **Context.** The Telo side gets the published `telo` CLI, the hub's MCP server and the authoring primer. The Node side gets Node and npm; models already know Fastify.
- **Recorded per attempt:**
  - **Tokens:** input, output, cache read and cache write.
  - Cost, turns, tool calls, wall time.
  - Whether the hidden tests pass.
  - Lines written.
- **Reported per side:** token spend side by side (median per passing attempt), success rate and median time. The built apps are then run through family 1.
- **Repeats and budget.** Five attempts per side per task. An attempt that exceeds 60 minutes or USD 20 counts as failed. The model is pinned and recorded, and results compare only within one model.

**Toolset: the benchmark module** (TypeScript, no external generator). `Benchmark.Suite` keeps its current role: thresholds in CI and benchmarks that call resources inside one process. A new runnable kind `Benchmark.Compare` carries every out-of-process measurement:

- **Variants and starting.** Each variant names a command, its arguments, environment and working directory, and a readiness URL or "runs to exit". `Benchmark.Compare` starts each variant itself and samples resident memory and CPU of the whole process tree.
- **Boot spans.** When a variant writes Telo spans to a JSON-lines `Telo.FileSink`, it reads the boot spans from that file.
- **Rounds.** Variants alternate over a set number of rounds (default 5), with a set number of boot repetitions (default 20).
- **CPU pinning.** The variant and the load generator run on separate CPU cores.
- **HTTP workloads** run in two modes, fixed rate and fixed client count, with weighted requests and a response check. The load loop sends directly through undici across worker threads, outside Telo's call path. In fixed-rate mode, latency is measured from each request's scheduled send time. Percentiles come from fixed-memory histograms, and errors are reported by status code and message with a sample of each.
- **Calibration.** Before each run the generator is measured against a calibration endpoint. A run is refused when the generator cannot reach three times the throughput the run then reports.
- **Unreliable runs.** A result whose rounds disagree by more than 5% is written flagged as unreliable.
- **Output.** A table on stdout, one JSON record at a `report.path` (`Telo.HostPath`), and thresholds that fail the run.
- **Errors.** Process sampling needs Linux. Elsewhere `Benchmark.Compare` refuses to start with an error naming the field, rather than reporting zeros.

**Kernel: boot phase spans.** The Node kernel records startup as a `telo.boot` span with child spans `telo.boot.load`, `telo.boot.migrate`, `telo.boot.analyze`, `telo.boot.controllers`, `telo.boot.compile` and `telo.boot.init`, timed from process start. They reach the application's attached trace sinks once those exist, carrying their real start times. The tracing spec, the tracing guide, the authoring primer and the tracing entry in `docs/guides/what-you-get.md` say so. The Rust kernel has no tracing yet, so it has nothing to add now.

**Running and publishing.**

- **Comparison and feature cost:** `.github/workflows/benchmarks.yml` runs them nightly at 03:00 UTC on `main`, plus manually, on GitHub-hosted runners. The Telo-to-native ratio is the headline figure; absolute numbers carry the runner's specs.
- **Authoring:** `.github/workflows/benchmarks-authoring.yml` runs it after each telo release, against that release's published CLI and hub, plus manually.
- **History:** each run appends records to `comparison.jsonl`, `features.jsonl` or `authoring.jsonl` on the orphan branch `bench-results`. Every record carries the commit, telo version, Node version, runner and, for authoring, the model.
- **Regression alerts:** a comparison ratio moving more than 10%, or a feature time more than 15% at the largest N, against the median of the last 10 reliable runs, opens an issue labelled `benchmark-regression`.
- **Docs page:** `docs/reference/benchmarks.md` holds the hand-written methodology. The docs build reads `bench-results` and renders the latest tables and the trend charts beneath it. The nightly workflow triggers the docs deployment after appending.

**Retired:** `benchmarks/feedback`, `benchmarks/score`, `benchmarks/scripts/run-bench.mjs`, and their lines in the root `ci` script.

## Decisions

- **Ratio as the headline, measured on hosted runners.** Alternating variants on one machine keeps the ratio stable while absolute numbers vary 10–20%. A dedicated machine was rejected until the ratios prove too noisy.
- **One app with endpoints per CEL level, not three apps.** Every level shares one server, one storage layer and one memory profile, so CEL density is the only difference. Three apps would mean six implementations now and nine with Rust.
- **The load engine is TypeScript inside the module.** A lean Node generator is how Fastify benchmarks itself, and the calibration check proves the headroom on every run. An external tool (oha) and a Rust generator were rejected: neither is needed while calibration passes.
- **`Benchmark.Compare` is one kind, not separate program and workload kinds.** Process lifetimes belong to the rounds the comparison alternates, so a program cannot be a long-lived service that starts once.
- **Feature manifests are generated at run time, never committed.** N changes freely and nothing large sits in the repo. A test generates N = 2 for every feature and `telo check`s it, so the generator cannot silently break.
- **Only `telo check` time is measured for analysis.** The editor engine runs the same analysis, so driving an editor protocol session would add a harness and measure nothing new.
- **Boot phases come from tracing.** Authors then get the same breakdown in their own traces. A benchmark-only timing flag was rejected as a second mechanism next to tracing.
- **The same general agent on both sides.** Using the repo's authoring agent for Telo would mix that agent's quality into the comparison. Hidden tests decide parity, never the agent's own claim.
- **Authoring runs per release, not nightly.** Every attempt costs tokens, and a release is the unit an author actually uses.
- **Regressions alert instead of failing CI.** There are no per-feature time budgets until a few weeks of history show what the stable values are.
- **History lives on an orphan branch.** Workflow artifacts expire after 90 days, and bot commits on `main` would add noise to its history.

## Release and docs bookkeeping

- `modules/benchmark`:
  - Gains `docs/` covering both kinds and the measurement method.
  - Its README is updated, and its descriptions are rewritten to the hub rule.
  - Gets an `Added` release fragment.
  - Needs a `requires:` floor only if its own `telo.yaml` adopts syntax newer than the latest release, verified by running the previous CLI against it.
- The kernel's boot spans ship with a changeset on the telo version line.
- `benchmarks/README.md` describes the three families.

## Verify

- **Contract test.** It passes against both lead-intake implementations in CI, and the features generator test passes.
- **Hidden stalls.** On a fixture server that sleeps 200 ms once every second, fixed-rate p99 reflects every request scheduled during the stall.
- **Calibration.** A run against a server faster than the generator is refused, naming the generator's limit.
- **First nightly run.** It appends records to `bench-results`, the docs page shows them, and a forced regression in a test run opens a labelled issue.
- **Boot spans.** A manifest with a `Telo.LogTraceSink` writing to a JSON `Telo.FileSink` contains every `telo.boot.*` span, and their durations sum to within 5% of `telo.boot`.
- **Authoring.** One manual run records, for both sides, token counts, cost, turns, wall time and hidden-test results.
