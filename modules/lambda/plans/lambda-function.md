# Plan — AWS Lambda function adapter

Goal: ship `modules/lambda` with a `Lambda.Function` resource kind that runs a Telo `Invocable` on AWS Lambda. Supports both deployment models from the same definition:

- **Managed runtime** (`nodejs20.x`) — AWS owns the outer loop; a small `index.mjs` bootstrap dispatches per `exports.handler` call.
- **Custom runtime** (`provided.al2023` or container image) — our `bootstrap` polls `$AWS_LAMBDA_RUNTIME_API` and dispatches via `Telo.Service`.

Builds on the [kernel lifecycle split](../../../kernel/nodejs/plans/kernel-lifecycle-split.md) for the managed path (`boot()` without targets). Custom path inherits the new methods for free via the convenience `start()`.

Packaging is a separate plan ([lambda-bundle.md](./lambda-bundle.md)) — this plan defines what runs in the Lambda; that one defines how the artifact gets there.

## Scope

In-scope:

- Module + controller package.
- Both deployment modes from the same `Lambda.Function` definition.
- Event sources v1: direct invoke + API Gateway HTTP API (payload v2). SQS, EventBridge, S3, API Gateway REST, Function URLs follow incrementally.
- Response streaming when the invocable's output declares `x-telo-stream: true`.
- Graceful teardown on `SIGTERM`.

Out of scope:

- Other FaaS platforms (`modules/gcp-cloud-functions`, etc.) — separate modules, separate plans.
- Lambda Extensions API beyond the basic `SIGTERM`.
- SnapStart — semantics interact with controller state in ways that need separate analysis.

## Change

### Module layout

```
modules/lambda/
├── telo.yaml                  # Library declaring Lambda.Function
├── nodejs/                    # controller package (@telorun/lambda)
│   ├── package.json
│   ├── src/
│   │   ├── function.ts        # LambdaFunction controller (shared dispatch)
│   │   ├── managed.ts         # subpath export — managed-mode helpers
│   │   ├── custom.ts          # subpath export — custom-mode poll loop
│   │   ├── event-sources/     # per-source classification + input mapping
│   │   └── responses/         # per-source response mapping
│   └── tests/
└── docs/
    ├── overview.md
    ├── function.md
    └── cold-starts.md
```

### `Lambda.Function` resource kind

```yaml
kind: Telo.Library
metadata:
  namespace: std
  name: lambda
  version: 0.1.0
exports:
  kinds: [Function]
---
kind: Telo.Definition
metadata: { name: Function }
capability: Telo.Service
controllers:
  - pkg:npm/@telorun/lambda@0.1.0?local_path=./nodejs#function
schema:
  type: object
  properties:
    runtime:
      enum: [managed, custom]
      default: managed
      x-telo-eval: compile
    handlers:
      type: array
      x-telo-scope: /handlers/*
      items:
        type: object
        properties:
          eventSource:
            enum: [apiGatewayHttp, apiGatewayRest, functionUrl, direct, sqs, eventBridge, s3]
          match:
            description: optional discriminator (path pattern, queue ARN, source name)
            type: object
          handler:
            x-telo-ref: telo#Invocable
          response:
            type: object
            properties:
              statusFrom: { type: string }
              headersFrom: { type: string }
              bodyFrom: { type: string }
              streaming: { type: boolean }
  required: [handlers]
```

User manifest example:

```yaml
kind: Telo.Application
metadata: { name: my-fn, version: 1.0.0 }
---
kind: Telo.Import
metadata: { name: Lambda }
source: std/lambda@0.1.0
---
kind: Lambda.Function
metadata: { name: Main }
runtime: managed
handlers:
  - eventSource: apiGatewayHttp
    match: { method: POST, path: /webhook }
    handler: { kind: My.Webhook }
  - eventSource: sqs
    match: { queueName: orders }
    handler: { kind: My.OrderProcessor }
```

`capability: Telo.Service` for both runtime modes. Under managed mode `init()` returns immediately (AWS owns the poll loop; the bootstrap drives `invoke` from outside). Under custom mode `init()` starts the poll loop and `acquireHold()`s the kernel.

### Shared dispatch

The controller (`function.ts`) implements `Telo.Service`. Both modes share:

- **Event classification** — input event → matched `handlers[i]` entry. API Gateway events keyed by method + route; SQS by source ARN; EventBridge by `source` + `detail-type`; direct invoke by a discriminator passed in the payload.
- **Input mapping** — event payload normalized into the `{ request: {...} }` shape Telo handlers already expect (mirrors [`http-server-controller.ts:200-214`](../../http-server/nodejs/src/http-server-controller.ts#L200-L214)).
- **Scope entry** — `scope.run(s => s.invoke(handler.kind, handler.name, inputs))` per event.
- **Output mapping** — invocable result → AWS response shape via the declared CEL paths; sensible defaults (`statusCode=200`, `headers={}`, `body=JSON.stringify(output)`).
- **Error mapping** — `InvokeError` → status from the invocable's `catches` block (extract `dispatchCatches` from [`http-server-controller.ts`](../../http-server/nodejs/src/http-server-controller.ts) into a shared helper first); unhandled throw → 500 with stack to CloudWatch, message in the body.

### Mode-specific lifecycle

| concern | managed (`runtime: managed`) | custom (`runtime: custom`) |
|---|---|---|
| outer loop | AWS-provided; bootstrap exports `handler` | bootstrap polls `$AWS_LAMBDA_RUNTIME_API` |
| kernel boot | `kernel.boot()` at module load | `kernel.start()` runs to completion of `init`; service holds kernel alive |
| dispatch trigger | `exports.handler` called per event by AWS | service's poll loop receives event |
| dispatch site | bootstrap looks up controller's dispatch fn, calls it | service's poll loop calls its own dispatch fn directly |
| target services | `runTargets()` skipped | `runTargets()` runs normally; service is itself a target |
| teardown | `SIGTERM` → `kernel.teardown()` | `SIGTERM` → cancel next poll → drain in-flight invoke → `kernel.teardown()` |
| keepalive | none needed | `acquireHold()` in `init()` |

### Bootstrap entry points

Both modes ship a small bootstrap file written by the [bundler](./lambda-bundle.md). Shown here so this plan defines what's *expected* of the bootstrap; that plan defines how it's emitted.

**Managed mode** — `index.mjs`:

```js
import { Kernel, LocalFileSource } from "@telorun/kernel";
import { getDispatcher } from "@telorun/lambda/managed";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");
await kernel.boot();
process.once("SIGTERM", () => kernel.teardown());
export const handler = getDispatcher(kernel);
```

`getDispatcher(kernel)` finds the single `Lambda.Function` resource in the boot graph and returns its `dispatch(event, context)` method.

**Custom mode** — `bootstrap`:

```js
#!/usr/bin/env node
import { Kernel, LocalFileSource } from "@telorun/kernel";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");
process.once("SIGTERM", () => kernel.teardown());
await kernel.start();
```

Both entry points are <20 lines and don't grow with feature additions — the smarts live in the controller.

### Runtime concerns

**Cold-start budget.** Lambda gives ~10 s for module init (managed) or first poll-request (custom). Moves:

- **Skip `runTargets()` under managed.** Baked into the bootstrap.
- **Defer slow init via `x-telo-scope`.** Heavy resources (DB pools, AI model loads) scope to the handler so they initialize per-first-invocation. Document the pattern in `docs/cold-starts.md`.
- **No registry calls at boot.** Guaranteed by the bundler — `.telo/npm/` is hermetic. Adapter fails fast at boot if `TELO_REGISTRY_URL` would be consulted.
- **Measure.** Adapter emits a `Kernel.Booted` event with a duration; CloudWatch dashboard examples in the docs.

**Streaming.** Invocables with `x-telo-stream: true` on their output type:

- Managed: wrap with `awslambda.streamifyResponse`, pipe the `Stream<T>` into the Lambda response stream.
- Custom: POST to `/runtime/invocation/{requestId}/response` with `Transfer-Encoding: chunked`.

Detection is identical across modes (inspect the resolved invocable's output type); only the sink differs.

**Logging.** Lambda captures `console.log` / `console.error` to CloudWatch. Bootstrap leaves `kernel.stdout` / `kernel.stderr` at the defaults (`process.stdout` / `process.stderr`). Structured JSON falls out the bottom.

X-Ray tracing: deferred. Add when an `@telorun/observability-aws` module exists.

## Why this shape

The whole thing is `Telo.Service` + a thin transport. Under custom mode it's *exactly* the `Http.Server` pattern with a different transport (Lambda Runtime API instead of TCP). Under managed mode it's the same controller, but its `init()` is a no-op and the bootstrap drives invocation from outside — using the new public `Kernel.invoke()`.

A single resource kind covering both modes (via a `runtime` discriminator) keeps the user's manifest portable: switching deployment style is changing one field, not rewriting handler config. Same dispatch logic, same event mapping, same response mapping — only the lifecycle wrapper differs.

## Test

1. **Unit tests** — `modules/lambda/nodejs/tests/dispatch.test.ts` (vitest). For each supported event source, feed a representative payload and assert correct invocable dispatch and response shape. Mock the AWS Lambda Runtime API HTTP server for the custom-mode poll loop.
2. **E2E** — `modules/lambda/nodejs/tests/e2e.test.ts`. Drive both modes against [aws-lambda-runtime-interface-emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator) (RIE). Managed: RIE invokes our bootstrapped `handler`. Custom: point our `bootstrap` at RIE's emulated runtime endpoint and verify it polls. Runs in CI without real AWS credentials.

Vitest tests live under `modules/lambda/nodejs/tests/`; wire into CI as a per-package vitest job.

## Docs

- `modules/lambda/docs/overview.md` — entry point; when to pick managed vs custom.
- `modules/lambda/docs/function.md` — `Lambda.Function` schema reference, handler shape, event-source semantics, response mapping.
- `modules/lambda/docs/cold-starts.md` — budget guidance, `x-telo-scope` patterns, artifact-size trade-offs.

Add to [`pages/docusaurus.config.ts`](../../../pages/docusaurus.config.ts) `include` array and [`pages/sidebars.ts`](../../../pages/sidebars.ts). `sidebar_label` frontmatter on each.

## Changeset

- New package `@telorun/lambda` — initial publish (0.1.0).
- New module manifest `std/lambda@0.1.0` published to the Telo registry.
- `@telorun/http-server` — minor bump if extracting `dispatchCatches` requires a re-export. If it becomes a new `@telorun/http-shared` package, that's a new initial publish.

## Open questions

- **Event-source coverage in v1**: direct + apiGatewayHttp is the floor. SQS adds queue-driven flows; worth including for v1?
- **Streaming in v1**: cheap to wire (`Stream<T>` is already in the SDK). Default in unless there's reason to defer.
- **Default `runtime`** in the schema: `managed` (smaller artifact, more familiar) vs `custom` (cleaner mental model). Currently `managed`.
