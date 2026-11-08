# Benchmarks

Three families share one toolset (the [`benchmark`](../modules/benchmark) module), one result history and one docs page.

## Comparison: Telo vs native — [`lead-intake/`](./lead-intake)

A lead-intake API with one prose contract ([`CONTRACT.md`](./lead-intake/CONTRACT.md)), contract tests that run against any implementation's URL, and two implementations of it: `telo/` (a Telo application) and `node/` (Fastify and better-sqlite3 — the libraries Telo runs on — compiled to JavaScript and started with `node`). [`comparison.yaml`](./lead-intake/comparison.yaml) is a `Benchmark.Comparison` that starts each implementation itself, alternating them round after round, and measures for each:

- **Boot**, cold (the subject's `.telo` cache removed) and warm, from process start to the first successful `/ping`; for Telo also the duration of the startup span, through the `teloObserved` subject, which runs with `TRACE=true`.
- **Throughput** at a fixed concurrency and **latency (p50, p99) at a fixed rate**, the same for every subject, on three endpoints: `/ping` (no CEL, the framework floor) and a mix of heavy writes (about 80 CEL expressions), reads from storage and rejected requests.
- **CPU time per request** and **resident memory** idle, at peak and after the load, in the fixed-rate pass.

The headline figures are two ratios per workload, `telo` ÷ `node` of the medians: CPU per request and p99 at the fixed rate. Neither depends on how hard the generator can push; the throughput ratio is shown beside them and never alerted. The three levels `/leads/light`, `/leads/medium` and `/leads/heavy` (about 5, 25 and 80 CEL expressions, each the previous one plus more rules) price the CEL expressions: the gap between two levels is the cost of the added ones.

Every boot and load pass starts with an empty `STATE_DIR` holding only the lead `seed`, so no pass sees rows an earlier one wrote. The comparison runs on Linux only (it reads `/proc` and pins cores with `taskset`) and needs the `telo` command on `PATH`:

```console
$ REPORT_FILE=./out/comparison.json telo run benchmarks/lead-intake/comparison.yaml
```

Build the Node implementation first (`pnpm --filter @telorun/bench-lead-intake build`). The tables, the record and the refusals are described in [the module's comparison docs](../modules/benchmark/docs/comparison.md); how to run the contract tests and extend them is in [`lead-intake/README.md`](./lead-intake/README.md).

## Feature cost: Telo only — `feature-cost/`

How the cost of Telo's own features grows with their size: `!if` / `!switch` across independent dimensions, `!for-each`, deep imports, template and `extends` depth and the like. [`run.mjs`](./feature-cost/run.mjs) generates plain manifests at growing sizes and a `Benchmark.Comparison` with no workloads that times `telo run` and `telo check` on each, then writes one `feature-cost.jsonl` line per feature. It records the first size at which a feature fails to boot within its time limit, so a change that makes a feature steeply worse shows in the history. Features, sizes and options: [`feature-cost/README.md`](./feature-cost/README.md).

## Authoring: agents — [`authoring/`](./authoring)

Whether a coding agent builds the same app faster, or with fewer tokens, in Telo than in plain Node. One general agent (Claude Code, run non-interactively in a fresh container on a pinned model) builds the lead-intake app from `CONTRACT.md` once in each, then makes three changes to the repo's own implementations (a field end to end, a validation rule, an endpoint); an attempt passes when the contract tests, plus the cases the change adds, pass against the app it left. Five attempts per side per task; one past 60 minutes or USD 20 counts as failed. Token spend (median per passing attempt, the Telo side's including the primer and hub context), cost, turns, time and success rate are reported per side, and the apps built are run through the comparison above. It runs on demand only (`.github/workflows/benchmarks-authoring.yml`), because every attempt spends tokens. How it works, the record it writes and how to run it: [`authoring/README.md`](./authoring/README.md).

## History — [`history/`](./history)

Each run appends its records, one per line, to `comparison.jsonl`, `feature-cost.jsonl` or `authoring.jsonl` on the orphan branch `benchmark-results`, through [`history/append.mjs`](./history/README.md). Both benchmark workflows share the concurrency group `benchmarks`, so two runs never append at once.

## Nightly, alerts and the docs page

[`.github/workflows/benchmarks.yml`](../.github/workflows/benchmarks.yml) runs the comparison and the feature-cost sweep every night at 03:00 UTC on `main` (and on manual dispatch), with the CLI built from the checkout on a GitHub-hosted runner, and appends both histories from one job. It then runs [`history/alert.mjs`](./history/README.md#regression-alerts), which opens an issue labelled `benchmark-regression` for a figure that got worse than the previous 10 runs. The results are published on the [Benchmarks](../docs/reference/benchmarks.md) docs page, which reads the history branch in the reader's browser, so a nightly run needs no site deploy.
