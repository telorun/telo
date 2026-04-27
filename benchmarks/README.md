# Benchmarks

Side-by-side performance comparisons between native TypeScript implementations and their Telo-manifest equivalents.

Each subdirectory contains:

- `api.ts` — native baseline (Fastify; runs on Node via `tsx`)
- `api.yaml` — the same API expressed as a Telo manifest
- `benchmark.yaml` — full `Bench.Suite` load run (JSON output)
- `test-benchmark.yaml` — small smoke variant invoked by `pnpm test` (CI)

The shared orchestrator at [`scripts/run-bench.mjs`](./scripts/run-bench.mjs) spawns a server (`tsx api.ts` or `telo run api.yaml`), waits for the port, runs the chosen benchmark YAML, tears the server down, and pretty-prints the JSON report. `--compare` runs native + Telo back-to-back and prints a Δ table.

## Suites

| Package                       | Port | What it benchmarks                                   |
| ----------------------------- | ---- | ---------------------------------------------------- |
| [`feedback/`](./feedback)     | 8844 | SQLite-backed REST CRUD (POST + GET list + GET one)  |
| [`score/`](./score)           | 8845 | Lead scoring — CEL-heavy, ~70 expressions per request |

## Common commands

```bash
# Full load run (orchestrated, ~30s)
pnpm --filter @telorun/bench-score bench

# Native vs Telo, side-by-side latency table
pnpm --filter @telorun/bench-score compare

# CI smoke (small, fast)
pnpm --filter @telorun/bench-score test
```

`pnpm -r test` picks up each package's `test` script and runs it as part of CI.
