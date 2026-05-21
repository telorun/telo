---
sidebar_label: Cold Starts
---

# Cold Starts

AWS Lambda's Init phase has a tight budget — well under 10 s on `nodejs24.x`, ideally sub-second when synchronous HTTP traffic flows through API Gateway. The Telo runtime stays inside this budget by default, but a few moves are worth knowing when your handlers do real work.

## Init vs. invoke

At cold start, Telo runs every resource's `init()` before the Lambda accepts its first event. The Lambda kinds (`Function`, `HttpApi`, `Sqs`, `Direct`) all init in **pure preparation** mode — no I/O, no network, no expensive work.

Heavy work belongs in two places:

- **Per-invocation** (each call): connection acquisition from a pool, model inference, downstream HTTP requests. These happen inside your handler — Telo doesn't dictate their cost.
- **Per-cold-start, lazy**: warm caches, model loads, schema compilation. Push these behind `x-telo-scope` so they instantiate on first invocation rather than at Init.

## Defer slow init with `x-telo-scope`

When a heavy resource sits behind `x-telo-scope`, the kernel doesn't initialise it during `boot()` — it waits until the first request that needs it. The first request pays the cost; subsequent requests reuse the warm instance (which stays around as long as the AWS execution environment does).

This shifts the cost from Init (under AWS's hard cap) to the first invocation (capped only by your user-facing timeout). For a 2 GB ML model load, this is the difference between a Lambda that's runnable and one that times out at startup.

See [Resource Lifecycle: Scopes](../../../kernel/docs/resource-lifecycle.md) for the full pattern.

## What `telo install` does

`telo install ./telo.yaml` populates two sibling trees under `<manifest-dir>/.telo/`:

- `.telo/npm/` — every transitive npm dependency the manifest needs.
- `.telo/manifests/` — the raw YAML of every transitively-imported `Telo.Library`, keyed by registry namespace/name/version (or `__http/<host>/...` for direct HTTP imports).

**Both caches are written before the artifact is packaged** — no registry calls happen at AWS-runtime boot. Controllers load from `.telo/npm/`; the manifest graph resolves from `.telo/manifests/`.

If your build pipeline strips `.telo/`, the kernel falls back to `$TELO_REGISTRY_URL` at boot. Outside a VPC with internet egress that fails immediately; even with egress, the round-trip-per-import blows the cold-start budget. Keep `.telo/` in your artifact.

## Bootstrap overhead

The shipped bootstraps are under 20 lines each. `managed.mjs` does:

1. Instantiate the kernel (no I/O).
2. `kernel.load("./telo.yaml")` — parses the manifest, follows includes / imports, compiles CEL templates.
3. `kernel.boot()` — runs every resource's `init()`.
4. Export `handler` — AWS calls it per invocation.

Steps 2–3 are the bulk of cold-start cost. Anything that touches the network at boot (registry fetches, external API hits) defeats the budget — keep it out of `init()` and behind `x-telo-scope` instead.

## Measuring

The kernel emits a `Kernel.Booted` event with a duration field after boot completes. Forward it to CloudWatch with a minimal handler:

```yaml
kind: JavaScript.Script
metadata: { name: BootMetric }
inputs:
  durationMs: !cel "event.payload.durationMs"
code: |
  function main({ durationMs }) {
    console.log(JSON.stringify({ metric: 'kernel.boot.ms', value: durationMs }));
    return {};
  }
```


## Container vs. zip

For small artifacts (< 50 MB), zip starts faster than container — managed runtime's pre-warmed Node.js base wins over container image cold pulls.

For larger artifacts or custom native dependencies, container images are usually better — AWS aggressively caches them on the underlying host once pulled.

Both work with the same Telo manifest; see [Deploying](./deploying.md) for the packaging templates.
