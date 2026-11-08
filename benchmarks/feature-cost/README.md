# Feature cost

How the cost of Telo's own features grows with their size. `run.mjs` writes plain applications under `generated/` (gitignored), one per feature and size, and for each a `Benchmark.Comparison` with no workloads that times two subjects: `telo run telo.yaml` (to exit, with `TRACE=true` so the startup span is read) and `telo check telo.yaml`, each cold and warm. Nothing is a `!for-each` over the size, which would put the loop's own cost beside the feature's.

```console
$ TELO_COMMAND=telo node benchmarks/feature-cost/run.mjs --features choiceDimensions --sizes 1,2 --rounds 1
```

Standard output (and `--out`, default `generated/feature-cost.jsonl`, overwritten) holds one line per feature: `{ commit, teloVersion, host, feature, sizes: [{ n, runColdMs, runWarmMs, startupMs, checkColdMs, checkWarmMs }], firstFailure? }`, each timing `{ median, min, max, cv }`. A feature stops at the first size whose comparison fails with `ERR_BENCHMARK_BOOT_FAILED` or `ERR_BENCHMARK_STARTUP_SPAN_MISSING`, and that size, code and message are its `firstFailure`; the sweep carries on with the next feature. Any other failure (no `taskset`, a crashed run) ends the sweep with a non-zero exit, since it says nothing about the feature.

## Options

| Option | Meaning |
| --- | --- |
| `--features a,b` | Features to run (default all; `--list` prints them). |
| `--sizes 1,2,4` | Sizes for every selected feature (default: the feature's class, below). |
| `--rounds n` | Comparison rounds per size (default 5). `boots` is always 1. |
| `--boot-timeout 60s` | Per-boot limit written into each comparison. |
| `--out file` | The `feature-cost.jsonl` written. |
| `--commit sha` | Recorded commit (default `$COMMIT`, else `git rev-parse HEAD`). |
| `--features-module file` | An ES module exporting `FEATURES`, added to the catalogue (the sweep test's fixtures use it). |
| `--generate-only` / `--check` | Write the applications and stop / also run `telo check` on each and exit non-zero on a finding. |

`TELO_COMMAND` is the telo command, possibly several words (`bun cli/nodejs/bin/telo.ts`), used both to run the comparisons and as the subjects' command. Measuring needs what `Benchmark.Comparison` needs: Linux, `taskset`, two or more physical cores. A full run (5 rounds, every size) takes roughly 25 to 40 seconds of boots per size.

## Features and sizes

Sizes per class: **count** 1, 10, 100, 1000; **depth** 1, 4, 16, 64, 256; **dimension** 1, 2, 4, 8, 16.

| Feature | Class | N is |
| --- | --- | --- |
| `resourceCount` | count | resources declared (the baseline) |
| `choiceCount` | count | `!if` / `!switch` documents reading the same two inputs |
| `choiceDimensions` | dimension | `!if` / `!switch` documents each reading an input of its own (2^N configurations) |
| `forEachIterations` | count | elements a templated kind's `!for-each` turns into resources and targets |
| `forEachNesting` | depth | nesting depth of `!for-each` over one element per level |
| `templateConsumers` | count | resources of one templated kind |
| `extendsDepth` | depth | length of an `extends` chain |
| `importDepth` | depth | libraries importing one another in a chain |
| `importWidth`, `importWidthShared` | count | imports of one library, `isolated` / `shared` |
| `celCount` | count | `!cel` expressions in one value |
| `celSize` | count | elements of one list literal in an expression |
| `stepCount` | count | steps of a sequence |
| `tryNesting` | depth | nested `try` steps |
| `scopeMembers` | count | resources in a sequence's `with:` |
| `contractSchemaSize` | count | properties of an `inputType` |
| `moduleFunctionCalls` | count | calls of a module function in one expression |
| `textCatalogSize` | count | entries of a text translation catalog |

Every application opens with the `logging` / `tracing` blocks of the startup-span example (a `Telo.FileSink` writing `spans.jsonl` and a `Telo.LogTraceSink`, both `when: !cel "variables.trace"`) and runs to completion with exit 0, because a subject with no `readiness` is timed to exit.

## Tests

`tests/generator.yaml` (in the root suite, every platform) generates N = 2 for every feature and holds each to `telo check` and a run that exits 0; it also pins the feature list. `tests/sweep/sweep.yaml` runs the sweep on two fixture features, one of which stops exiting at n = 4, and asserts its `firstFailure` while the next feature is still measured. It needs Linux, `taskset` and a `telo` command:

```console
$ TELO_COMMAND=telo telo run benchmarks/feature-cost/tests/sweep/sweep.yaml
```
