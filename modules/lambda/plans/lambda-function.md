# Plan — AWS Lambda function adapter

Goal: ship `modules/lambda` with a `Lambda.Function` resource kind that runs a Telo `Invocable` on AWS Lambda. Supports both deployment models from the same definition:

- **Managed runtime** (`nodejs20.x`) — AWS owns the outer loop; a small `index.mjs` bootstrap dispatches per `exports.handler` call.
- **Custom runtime** (`provided.al2023` or container image) — our `bootstrap` polls `$AWS_LAMBDA_RUNTIME_API` and dispatches via `Telo.Service`.

Builds on the [kernel lifecycle split](../../../kernel/nodejs/plans/kernel-lifecycle-split.md) for the managed path (`boot()` without targets). Custom path inherits the new methods for free via the convenience `start()`.

Packaging is a separate plan ([lambda-bundle.md](./lambda-bundle.md)) — this plan defines what runs in the Lambda; that one defines how the artifact gets there.

## Prerequisites

This plan has one hard prerequisite that must land first:

- **Transport-neutral response rendering** ([../../../packages/http-dispatch/nodejs/plans/transport-neutral-response.md](../../../packages/http-dispatch/nodejs/plans/transport-neutral-response.md)). The existing `returns:` / `catches:` rendering pipeline lives in `dispatchReturns` / `dispatchCatches` at [`modules/http-server/nodejs/src/http-api-controller.ts:199-440`](../../http-server/nodejs/src/http-api-controller.ts#L199-L440) and is tightly coupled to `FastifyReply`. That refactor extracts it into a new sibling package **`@telorun/http-dispatch`** (sourced at `http-dispatch/nodejs/`) carrying a transport-neutral `ResponseSink` interface plus the shared `dispatchReturns` / `dispatchCatches` functions; both `@telorun/http-server` and `@telorun/lambda` add `@telorun/http-dispatch` as a new workspace dependency. The package is intentionally *not* placed inside `@telorun/sdk` — the SDK keeps its zero-runtime-deps posture (HTTP-shaped dispatch code does not belong in the install tree of every non-HTTP module), and a future Go / Python SDK should not grow a `dispatch` subpath for symmetry. The Lambda controller writes its own `LambdaResponseSink` adapter (see [Shared dispatch](#shared-dispatch)) and calls into the shared dispatch — so the *runtime* code is shared. The *schema* (status / when / mode / headers / content[mime].{body,schema,encoder,headers}) is **inlined verbatim** into each per-source `EventSource` `$defs/Returns` / `$defs/Catches` block — no cross-module schema sharing per the prerequisite plan. Same analyzer coverage via `x-telo-outcome-list` / `x-telo-catches-for` falls out for free because the duplicated copy carries the same annotations. Until the runtime refactor lands, the Lambda function adapter is blocked on response/error rendering.

## Scope

In-scope:

- Module + controller package.
- Both deployment modes from the same `Lambda.Function` definition.
- Event sources v1: direct invoke, API Gateway HTTP API (payload v2), and SQS. EventBridge, S3, API Gateway REST, Function URLs follow incrementally.
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

### `Lambda.EventSource` abstract + per-source definitions

Each AWS event source is its own kind, all conforming to a `Lambda.EventSource` abstract. Per-source kinds carry `$defs` that pin the shape of every discriminator field (`Match`, `Request`, `Returns`, `Catches`). This makes the schema a discriminated union the analyzer and editor handle natively — no freeform `match: { type: object }` blob.

```yaml
kind: Telo.Library
metadata:
  namespace: std
  name: lambda
  version: 0.1.0
exports:
  kinds: [Function, ApiGatewayHttp, ApiGatewayRest, FunctionUrl, Direct, Sqs, EventBridge, S3, EventSource]
---
kind: Telo.Abstract
metadata: { name: EventSource }
capability: Telo.Type
schema:
  # Per-source definitions extend this and provide:
  #   $defs/Match    — discriminator shape (method+path, queueName, source+detailType, …)
  #   $defs/Request  — CEL context shape inside the handler (request.*)
  #   $defs/Returns  — outcome-list entry shape for successful returns
  #   $defs/Catches  — outcome-list entry shape for thrown InvokeError
  # HTTP-shaped sources inline the same Returns / Catches schema shape used by
  # http-server (status, when, mode, headers, content[mime].{...}) — duplicated
  # verbatim per the prerequisite plan; no cross-module schema sharing.
  # Pass-through sources (Direct, EventBridge, S3) declare simpler Returns/Catches
  # shapes appropriate for their response envelope.
  type: object
---
kind: Telo.Definition
metadata: { name: ApiGatewayHttp }
extends: Self.EventSource
schema:
  $defs:
    Match:
      type: object
      additionalProperties: false
      properties:
        method:
          enum: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, ANY]
        path:
          type: string   # OpenAPI-style path with {param} segments
      required: [method, path]
    Request:
      type: object
      properties:
        request:
          type: object
          properties:
            method:  { type: string }
            path:    { type: string }
            params:  { type: object, additionalProperties: true }
            query:   { type: object, additionalProperties: true }
            headers: { type: object, additionalProperties: true }
            body:    {}
    # Returns / Catches are inlined verbatim from http-server's schema
    # (status, when, mode, headers, content[mime].{body,schema,encoder,headers}
    # for Returns; same minus mode/encoder for Catches). Full shape elided here
    # for plan readability — see modules/http-server/telo.yaml for the canonical
    # source, and copy each property (including x-telo-outcome-list /
    # x-telo-catches-for annotations) into this kind's $defs when the manifest
    # is written. Drift against the canonical copy is on the author per the
    # prerequisite plan.
    Returns:
      type: array
      items:
        type: object
        # ... full schema inlined here verbatim from http-server
    Catches:
      type: array
      items:
        type: object
        # ... full schema inlined here verbatim from http-server (buffer-mode only)
---
kind: Telo.Definition
metadata: { name: Sqs }
extends: Self.EventSource
schema:
  $defs:
    Match:
      type: object
      additionalProperties: false
      properties:
        queueName: { type: string }
        queueArn:  { type: string }
    Request:
      type: object
      properties:
        request:
          type: object
          properties:
            records:
              type: array
              items:
                type: object
                properties:
                  messageId:   { type: string }
                  body:        { type: string }
                  attributes:  { type: object, additionalProperties: true }
                  messageAttributes: { type: object, additionalProperties: true }
    Returns:
      type: object
      properties:
        # SQS expects { batchItemFailures: [{ itemIdentifier: string }] } for partial-batch-failure.
        batchItemFailures:
          type: array
          items:
            type: object
            properties:
              itemIdentifier: { type: string }
    Catches:
      type: object
      # SQS doesn't have a response envelope for thrown errors — the message
      # goes to the DLQ. catches: here is for re-mapping a structured throw into
      # a batchItemFailures entry (e.g. "partial success: this record failed").
      properties:
        partialFailureFor:
          type: string   # CEL expression resolving to the failing record's messageId
# … similar definitions for ApiGatewayRest, FunctionUrl, Direct, EventBridge, S3
```

### `Lambda.Function` resource kind

```yaml
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
          source:
            description: Reference to the event source kind that fires this handler.
            x-telo-ref: "std/lambda#EventSource"
          match:
            description: Discriminator selecting which events of `source` route here.
            x-telo-schema-from: "source/$defs/Match"
          handler:
            x-telo-ref: telo#Invocable
          inputs:
            description: CEL expressions mapping the event payload onto the handler's inputs.
            type: object
            additionalProperties: true
            x-telo-eval: runtime
            # Per-source CEL context (request.*) sourced from the event kind's $defs/Request.
            x-telo-schema-from: "source/$defs/Request"
          returns:
            description: Rendering rules for handler-resolved values.
            type: array
            x-telo-outcome-list: returns
            x-telo-schema-from: "source/$defs/Returns"
          catches:
            description: Rendering rules for structured (InvokeError) throws.
            type: array
            x-telo-outcome-list: catches
            x-telo-catches-for: handler
            x-telo-schema-from: "source/$defs/Catches"
        required: [source, handler]
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
  - source: { kind: Lambda.ApiGatewayHttp }
    match: { method: POST, path: /webhook }
    handler: { kind: My.Webhook }
    inputs:
      payload: !cel "request.body"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result.output"
    catches:
      - code: ValidationError
        status: 400
        content:
          application/json:
            body: !cel "{ error: error.message }"

  - source: { kind: Lambda.Sqs }
    match: { queueName: orders }
    handler: { kind: My.OrderProcessor }
    inputs:
      records: !cel "request.records"
```

`capability: Telo.Service` for both runtime modes. Under managed mode `init()` returns immediately (AWS owns the poll loop; the bootstrap drives `invoke` from outside). Under custom mode `init()` starts the poll loop and `acquireHold()`s the kernel.

**Why a discriminated union over a flat enum + opaque `match`:**

- Analyzer rejects `match: { queueName: orders }` paired with `source: Lambda.ApiGatewayHttp` — schema mismatch is caught at `telo check` time, not at first invocation.
- Editor renders a per-source form for `match` instead of a generic key/value blob — direct hit against Telo's visual-editing goal.
- CEL inside `inputs:` / `returns:` / `catches:` is type-checked against the source kind's `$defs/Request` — `${{ request.body }}` is valid under `ApiGatewayHttp`, valid under `Direct`, invalid under `Sqs` (which exposes `records[]` instead).
- Reuses the existing `x-telo-outcome-list` / `x-telo-catches-for` analyzer machinery for throws coverage — no new analyzer surface to wire up.

### Shared dispatch

The controller (`function.ts`) implements `Telo.Service`. Both modes share:

- **Event classification** — input event → matched `handlers[i]` entry. Each handler's `source.kind` tells the controller which event-source kind's classifier to use; the kind's own definition supplies the match shape and the request normalization. API Gateway events keyed by method + route; SQS by source ARN; EventBridge by `source` + `detail-type`; direct invoke by a discriminator passed in the payload.
- **Input mapping** — event payload normalized into the `{ request: {...} }` shape declared in the source kind's `$defs/Request`. Identical normalization pattern to [`http-server-controller.ts:200-214`](../../http-server/nodejs/src/http-server-controller.ts#L200-L214); per-source extractors live in `event-sources/<source>.ts`.
- **Scope entry** — `scope.run(s => s.invoke(handler.kind, handler.name, inputs))` per event.
- **Outcome rendering** — `returns:` and `catches:` are rendered through the transport-neutral response sink ([Prerequisites](#prerequisites)). The Lambda controller constructs a `LambdaResponseSink` per event, calls the shared `dispatchReturns` / `dispatchCatches`, and when the dispatcher's `send` / `stream` completes the sink emits the AWS response envelope appropriate for the matched `source.kind`. HTTP-shaped sources (`ApiGatewayHttp`, `ApiGatewayRest`, `FunctionUrl`) produce the standard `{ statusCode, headers, body, isBase64Encoded }`; pass-through sources (`Direct`, `EventBridge`, `S3`) emit the invocable's `result.output` as-is; `Sqs` constructs `{ batchItemFailures: [...] }` from rendered entries.
- **Unhandled throw fallback** — anything that isn't an `InvokeError` (and therefore can't be matched by `catches:`) becomes a 500 for HTTP-shaped sources, a generic AWS error for direct/EventBridge, or a full-batch failure for SQS. Message goes to the response body where applicable; stack always goes to CloudWatch.

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

**Streaming.** Invocables with `x-telo-stream: true` on their output type render through the response sink's `stream(AsyncIterable<Uint8Array>, onError?)` path — same call site as `http-server`. The Lambda sink implementations differ by mode:

- Managed: wrap the handler with `awslambda.streamifyResponse`; `stream` pipes into the Lambda response stream.
- Custom: POST to `/runtime/invocation/{requestId}/response` with `Transfer-Encoding: chunked`.

Detection (inspecting the resolved invocable's output type for `x-telo-stream`) is identical across modes — the sink handles the rest. Only HTTP-shaped event sources support streaming; pass-through sources like Direct / EventBridge / S3 must buffer (AWS doesn't have a streaming return envelope for those).

**Logging.** Lambda captures `console.log` / `console.error` to CloudWatch. Bootstrap leaves `kernel.stdout` / `kernel.stderr` at the defaults (`process.stdout` / `process.stderr`). Structured JSON falls out the bottom.

X-Ray tracing: deferred. Add when an `@telorun/observability-aws` module exists.

## Why this shape

The whole thing is `Telo.Service` + a thin transport. Under custom mode it's *exactly* the `Http.Server` pattern with a different transport (Lambda Runtime API instead of TCP). Under managed mode it's the same controller, but its `init()` is a no-op and the bootstrap drives invocation from outside — using the new public `Kernel.invoke()`.

A single resource kind covering both modes (via a `runtime` discriminator) keeps the user's manifest portable: switching deployment style is changing one field, not rewriting handler config.

The per-source kind design (`Lambda.ApiGatewayHttp`, `Lambda.Sqs`, …) means:

- The outcome-rendering schema (`returns:` / `catches:`) is *the same schema* http-server uses — same analyzer coverage, same `dispatchReturns` / `dispatchCatches` (refactored through the transport-neutral sink), same per-MIME content negotiation. No fork of response semantics across transports.
- Adding a new event source = adding one definition with four `$defs` slots. No controller changes beyond the per-source extractor file under `event-sources/`.
- Future FaaS modules (`modules/gcp-cloud-functions`, etc.) define their own per-source kinds in the same shape — the `EventSource`-as-abstract pattern generalizes across FaaS providers.

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
- New module manifest `std/lambda@0.1.0` published to the Telo registry. Per-source `EventSource` definitions inline the http-server `returns:` / `catches:` schema verbatim into their `$defs` — no shared schema module.
- New package `@telorun/lambda` adds `@telorun/http-dispatch` as a new workspace dependency and consumes the transport-neutral runtime as `import { ... } from "@telorun/http-dispatch"`; no dependency on `@telorun/http-server`, no new dependency on `@telorun/sdk` beyond the existing one. The `@telorun/http-dispatch` initial publish and the `@telorun/http-server` patch bump (which also picks up `@telorun/http-dispatch` as a new workspace dep) are tracked in the prerequisite plan's changeset; `@telorun/sdk` does not change.
