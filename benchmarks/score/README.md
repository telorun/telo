# bench-score

A lead-scoring API benchmark designed to maximize **CEL evaluations per request**. Useful for measuring CEL-engine changes (e.g. swapping the underlying CEL package).

- `api.yaml` — Telo manifest. One endpoint, ~70 CEL expressions per request, JS handler is a passthrough.
- `api.ts` — native TypeScript (Fastify) mirror with the same field set, formulas, and response shape.
- `benchmark.yaml` — full load suite (driven by `../scripts/run-bench.mjs`).
- `test-benchmark.yaml` — small smoke variant used by `pnpm test` / CI.

## API

`POST /v1/score` — body `{ lead: { email, company: {...}, plan, events: [...], attrs: {...} } }` → returns a rich classification: `lead`, `company`, `events`, `plan`, `attrs`, `score`, `tier`, `summary`.

## CEL surface exercised

- Member access (`request.body.lead.company.name`)
- String ops: `split`, `contains`, `endsWith`, `size`
- Arithmetic on int and double, ratios with `double()` cast
- Comparisons (`<`, `>`, `==`, `!=`)
- Logical (`&&`, `||`)
- Nested ternaries (`x > a ? 'A' : x > b ? 'B' : 'C'`)
- `in` operator over inline lists
- List macros: `filter`, `exists`, `all`, `map`
- Index access: `events[0]`, `split('@')[1]`
- `has()` for optional fields, ternary fallback
- `string()`, `double()` type conversions

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
pnpm --filter @telorun/bench-score bench       # full Telo load
pnpm --filter @telorun/bench-score compare     # native vs Telo
pnpm --filter @telorun/bench-score test        # CI smoke
```
