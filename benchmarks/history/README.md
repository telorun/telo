# Benchmark history

Every benchmark workflow keeps its records, one JSON object per line, in a file on the orphan branch `benchmark-results`: `comparison.jsonl`, `feature-cost.jsonl` and `authoring.jsonl`. Workflow artifacts expire and bot commits on `main` would add noise, so the history lives on a branch of its own.

## Appending

```console
$ GITHUB_TOKEN=… node benchmarks/history/append.mjs --records out/authoring.jsonl --target authoring.jsonl
```

`append.mjs` clones nothing into the working tree: it works in a temporary repository. It reads the branch from the remote (`--remote`, default this repository's `origin`; `--branch`, default `benchmark-results`), appends every line of `--records` to `--target`, commits as `github-actions[bot]` and pushes. When the remote has no such branch it creates it as an orphan. A line that is not a JSON object, or a target that is not a bare `<name>.jsonl`, is refused before anything is fetched. A push that loses a race is retried against the new tip, up to three attempts; appending is not idempotent per run — running it twice appends twice.

For an https remote it authenticates with `$GITHUB_TOKEN` when set (passed to git as configuration, never in a URL); the job needs `permissions: contents: write`. Each record carries its own commit, telo version and host, so the script adds nothing to a line.

## Workflows

Every workflow that appends joins the concurrency group **`benchmarks`** (`concurrency: { group: benchmarks, cancel-in-progress: false }`), so two runs never append at once. Run the append from one job after the measuring jobs, as the [authoring workflow](../../.github/workflows/benchmarks-authoring.yml) does, never from parallel jobs.

The test, `tests/append.test.mjs`, runs the script against a temporary local bare repository.

The [nightly workflow](../../.github/workflows/benchmarks.yml) measures in one job, then appends `comparison.jsonl` (the comparison's record with the commit added) and `feature-cost.jsonl` from a single job with `contents: write`, and runs the alerts in the same job. A manual run on a branch other than `main` measures and appends nothing.

## Regression alerts

```console
$ GITHUB_TOKEN=… node benchmarks/history/alert.mjs --history <directory holding the .jsonl files>
```

`alert.mjs` reads the history files from a directory (the workflow exports them from `benchmark-results` after appending) and compares the newest run of each figure with the 10 runs before it. A figure alerts when the newest run is worse than the median of those 10 by more than its threshold **and** worse than every one of them; with fewer than 10 earlier runs nothing alerts.

| Figure | Threshold |
| --- | --- |
| Per comparison workload: `telo` ÷ `node` of the median CPU time per request | 10% |
| Per comparison workload: `telo` ÷ `node` of the median p99 at the fixed rate | 10% |
| Per feature: warm `telo run` time at the largest N every run in the window completed | 15% |
| Per feature: warm `telo check` time at that N | 15% |
| Per feature: `firstFailure` at a smaller N than in every run of the window | any |

A feature whose limit rises, or that completes more sizes, alerts nothing. An alert opens an issue labelled `benchmark-regression` whose body ends with a hidden marker naming the figure (`comparison/<workload>/cpu-per-request`, `feature-cost/<feature>/limit`, …); while an open issue carries that marker, the next alert for the figure comments on it instead. `--dry-run` prints the alerts and calls nothing; `--subject` / `--baseline` name the two subjects of the ratio (`telo` / `node`). A malformed history line or a failed GitHub call stops the script with a message naming the line or the call. The tests (`tests/alert.test.mjs`) use an in-memory issue client and never reach GitHub.

The docs page [Benchmarks](../../docs/reference/benchmarks.md) reads the same two files from `https://raw.githubusercontent.com/telorun/telo/benchmark-results/` in the reader's browser.
