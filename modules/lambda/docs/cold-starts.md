---
sidebar_label: Cold Starts
---

# Cold Starts

AWS Lambda's Init phase has a tight budget — well under 10 s for runtime init on `nodejs24.x`, and ideally sub-second when synchronous HTTP traffic flows through API Gateway. The Telo runtime stays inside this budget by default, but a few moves are worth knowing.

## Init vs. invoke

`kernel.boot()` runs every loaded resource's `init()`. For `Lambda.Function`, `init()` is **pure preparation** — it builds the event-shape classifier and caches handler references but performs no I/O. The same applies to `Lambda.HttpApi`, `Lambda.Sqs`, `Lambda.Direct`: they implement `init()` as a no-op.

Heavy work belongs in two places:

- **Per-invocation** (each call): connection acquisition from a pool, model inference, downstream HTTP requests. These happen inside the user's `Telo.Invocable` handler — Telo doesn't dictate their cost.
- **Per-cold-start, lazy**: warm caches, model loads, schema compilation. Push these behind `x-telo-scope` so they instantiate on first invocation rather than at Init.

## `x-telo-scope` for per-cold-start cost

When a heavy resource sits behind `x-telo-scope`, the kernel doesn't initialise it during `boot()` — it waits until the first request that needs it. The first request pays the cost; subsequent requests reuse the warm instance (which stays around as long as the AWS container does — Lambda recycles containers across requests).

This shifts the cost from Init (under a hard cap) to the first invocation (capped only by the user-facing timeout). For a 2 GB ML model load, this is the difference between a Lambda that's runnable and one that times out at startup.

The full pattern is documented at [Resource Lifecycle: Scopes](../../kernel/docs/resource-lifecycle.md).

## What `telo install` does

`telo install ./telo.yaml` populates `.telo/npm/` with all transitive npm dependencies for every controller declared in the manifest. **Crucially, it caches everything before the artifact is packaged** — no registry calls happen at AWS-runtime boot.

If your build pipeline somehow strips `.telo/`, the controller loader will try to consult `$TELO_REGISTRY_URL` at boot and fail loudly. Keep `.telo/` in your artifact.

## Bootstrap overhead

The shipped bootstraps are under 20 lines each. `managed.mjs` does:

1. `new Kernel({ sources: [new LocalFileSource()] })` — instantiates the kernel (no I/O).
2. `await kernel.load("./telo.yaml")` — parses the manifest, follows includes / imports, resolves CEL templates at compile time.
3. `await kernel.boot()` — runs every resource's `init()`.
4. Export `handler` — AWS calls it per invocation.

Steps 2-3 are the bulk of cold-start cost. Steps that touch the network at boot (registry fetches, external API hits) defeat the budget; keep them out of `init()` and behind `x-telo-scope` instead.

## Measuring

The kernel emits a `Kernel.Booted` event with a duration field after boot completes. Forward it to CloudWatch:

```yaml
# (Pattern, not yet a shipped Lambda.* observability resource)
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

Once `@telorun/observability-aws` lands this gets a first-class treatment (CloudWatch EMF, X-Ray segments, etc.). Today it's manual.

## Container vs. zip

For small artifacts (< 50 MB), zip starts faster than container — managed runtime's pre-warmed Node.js base wins over container image cold pulls.

For larger artifacts or custom native dependencies, container images are usually better — AWS aggressively caches them on the underlying host once pulled.

The break-even depends on artifact size and how often AWS rotates your underlying host. Both are supported by the same Telo manifest; see [Deploying](./deploying.md) for the packaging templates.
