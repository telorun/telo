# bench-feedback

Side-by-side benchmark of a feedback collection REST API:

- `api.ts` — native TypeScript (Fastify + better-sqlite3)
- `api.yaml` — same API as a Telo manifest (Http.Server + Sql.Connection + Sql.Exec/Query)
- `benchmark.yaml` — full load suite (`Bench.Suite`) driven by `../scripts/run-bench.mjs`
- `test-benchmark.yaml` — small smoke variant used by `pnpm test` / CI

Both implementations expose the same shape on `:8844`:

| Method | Path                  | Purpose                  |
| ------ | --------------------- | ------------------------ |
| POST   | `/v1/feedback`        | Insert an entry          |
| GET    | `/v1/feedback`        | List all entries         |
| GET    | `/v1/feedback/{id}`   | Fetch a single entry     |

## Scripts

| Script               | What it does                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| `serve:native`       | Start the Fastify server (manual, for `curl`/iteration)                     |
| `serve:telo`         | Start the Telo server (manual, for `curl`/iteration)                        |
| `bench`              | Spawn the Telo server, run `benchmark.yaml`, tear down. Pretty-print table. |
| `bench:native`       | Same as `bench` against the native server.                                  |
| `compare`            | Run native + Telo back-to-back and print a side-by-side latency table.      |
| `test`               | CI smoke: Telo server + `test-benchmark.yaml` (200 requests, concurrency 2).|

```bash
pnpm --filter @telorun/bench-feedback bench       # full Telo load
pnpm --filter @telorun/bench-feedback compare     # native vs Telo
pnpm --filter @telorun/bench-feedback test        # CI smoke
```

`compare` requires `benchmark.yaml`'s `report.format: json`; the orchestrator parses both reports and emits a Δ table.
