---
sidebar_label: Benchmarks
slug: /reference/benchmarks
description: What Telo's benchmarks measure and how — the Telo-vs-Node comparison, the cost of Telo's own features by size, and a coding agent building the same app — with the latest nightly results.
---

# Benchmarks

Three families of benchmark run on Telo, and the nightly ones publish their results on this page.

| Family | Question | Runs |
| --- | --- | --- |
| [Comparison](../../benchmarks/lead-intake/README.md) | How does a Telo application compare with the same API written in Node? | Nightly |
| [Feature cost](../../benchmarks/feature-cost/README.md) | How does the cost of a Telo feature grow with its size? | Nightly |
| [Authoring](../../benchmarks/authoring/README.md) | Does a coding agent build and change the same app with fewer tokens in Telo? | On demand, because every attempt spends tokens |

The [`benchmark` module](../../modules/benchmark/README.md) provides the tools (`Benchmark.Comparison`, `Benchmark.Suite`) and [`benchmarks/`](../../benchmarks/README.md) holds the benchmarks themselves.

## Comparison: Telo against Node

One API, a lead-intake service, is specified in prose and implemented twice: as a Telo application, and in Node with Fastify and better-sqlite3, the libraries Telo runs on. `Benchmark.Comparison` starts each implementation itself and measures, for every workload (`ping` with no CEL, and `leads`, a mix of heavy writes with about 80 CEL expressions, reads and rejected requests):

- **Throughput** at a fixed concurrency.
- **Latency (p50, p99) at a fixed rate**, the same for every subject.
- **CPU time per request** and **resident memory**, in the fixed-rate pass.
- **Boot time**, cold and warm. A cold boot starts with the subject's `.telo` cache removed, so it includes compiling every controller; a warm boot reuses what the cold one left. For Telo the duration of the startup span is recorded beside them.

**The core split.** The comparison takes the whole physical cores it may use and splits them in two halves: the first runs the comparison and its load generator, the second runs the subjects, each pinned with `taskset`. The rule is fixed, so every run splits the same way and a bigger machine needs no edit.

**Rounds and spread.** The subjects take turns, round after round, so a slow minute on the machine hits all of them. Every figure is the median over the rounds and the record keeps its minimum, maximum and coefficient of variation. A noisy figure is reported as noisy; it is never discarded.

**The two headline ratios.** Per workload, `telo` ÷ `node` of the median CPU time per request and of the median p99 at the fixed rate. Absolute numbers move 10–20% between machines and nights, but the two subjects run alternately on the same machine, so their ratio stays stable. Both are measured at a rate the generator can always sustain, so neither depends on how hard it can push. The throughput ratio is shown beside them but is not a headline, because on a small runner the native `/ping` reaches the generator's own ceiling (such a figure is marked generator-bound).

## Feature cost

Each feature of Telo's own (`!if` / `!switch` across independent dimensions, `!for-each`, deep imports, template and `extends` depth, `!cel` count, and so on) is generated as a plain application at growing sizes. For each size the benchmark times `telo run` (to exit) and `telo check`, cold and warm, and records the first size at which a feature fails to boot within its time limit. The page shows the warm `run` and `check` medians at the largest size the latest run completed.

## Regression alerts

After every nightly append, a script compares the newest run with the 10 runs before it. A figure alerts when the newest run is worse than the median of those 10 by more than its threshold and worse than every one of them:

- per comparison workload, the two headline ratios, with a 10% threshold;
- per feature, the run time and the check time at the largest size every run in the window completed, with a 15% threshold;
- per feature, the first failing size moving to a smaller one.

Fewer than 10 earlier runs means no alert. An alert opens a GitHub issue labelled `benchmark-regression`; while an issue for the same figure is open, a repeat comments on it instead. A regression does not fail any build: there are no time budgets until the history shows what the stable values are.

## Latest results

The tables and charts below are read in your browser, so they always show the newest nightly run. The numbers carry the specs of the machine that produced them, a GitHub-hosted runner; compare ratios, not absolute values. The history is two files, `comparison.jsonl` and `feature-cost.jsonl`, described in the [benchmark history notes](../../benchmarks/history/README.md).

```benchmark-results
Results are drawn on the documentation site from the newest nightly run's comparison.jsonl and feature-cost.jsonl.
```
