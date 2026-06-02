# Plan — AWS Lambda function adapter

Goal: ship `modules/lambda` with:

- A family of per-source `Telo.Invocable` kinds (`Lambda.HttpApi`, `Lambda.Sqs`, `Lambda.Direct`, …) under a `Lambda.Handler` abstract. Each concrete kind binds one AWS event source — the source type is encoded by the kind itself, not by a discriminator field on a generic function.
- A `Lambda.Function` `Telo.Service` kind that owns the AWS-facing transport. The Function receives every AWS invocation (managed handler export or custom poll-loop event) and dispatches to the correct handler based on event shape. One Function per AWS Lambda artifact; the Function lists the handlers it can dispatch to.

Both deployment models work from the same Function + handler set:

- **Managed runtime** (`nodejs24.x`) — AWS owns the outer loop; a 10-line `index.mjs` bootstrap (shipped as a library file in `@telorun/lambda`, copied by the user) calls `kernel.invoke("aws/lambda#Function", <name>, { event, context })` per AWS invocation.
- **Custom runtime** (`provided.al2023` or container image) — a `bootstrap` script (also shipped, also copied) polls `$AWS_LAMBDA_RUNTIME_API` and calls the same `kernel.invoke` per loop iteration.

Packaging is **not** in scope for this plan and not in scope for `@telorun/lambda`. The module exposes runtime primitives (the kinds, the controllers, the shipped bootstrap files, an optional base Docker image); users package their Lambda artifacts using standard tooling (`telo install` + `zip` for the zip target, a 4-line Dockerfile against the base image for the container target). See [Deploying](#deploying) for the full manual flow. The deliberate choice not to ship a packaging resource is discussed in [Why no `Lambda.Bundle`](#why-no-lambdabundle).

## Prerequisites

One hard prerequisite, one soft:

- **(Hard) Transport-neutral response rendering + shared outcome schema** ([../../http-dispatch/nodejs/plans/transport-neutral-response.md](../../http-dispatch/nodejs/plans/transport-neutral-response.md)). `@telorun/http-dispatch` owns one HTTP-dispatch concern end to end — both the *runtime* dispatcher and the *manifest* schema:

  - **Runtime half** (already shipped). `dispatchReturns` / `dispatchCatches` plus the `ResponseSink` interface live in [`modules/http-dispatch/nodejs/src/`](../../http-dispatch/nodejs/src/). Both `@telorun/http-server` and `@telorun/lambda` add `@telorun/http-dispatch` as a workspace dependency; the Lambda controller writes a `LambdaResponseSink` adapter (see [Shared dispatch](#shared-dispatch)) and calls the shared dispatch. The package is intentionally *not* placed inside `@telorun/sdk` — the SDK keeps its zero-runtime-deps posture (HTTP-shaped dispatch code does not belong in the install tree of every non-HTTP module).
  - **Manifest half** (POC landed for `Outcomes`; `Request` carrier and full http-server migration pending). [`modules/http-dispatch/telo.yaml`](../../http-dispatch/telo.yaml) is a `Telo.Library` publishing two `Telo.Definition`s (`capability: Telo.Type`):
    - **`Outcomes`** — whose `schema.$defs.Returns` and `schema.$defs.Catches` carry the canonical response-rendering value-shape (status / when / mode / headers / content[mime].{body,schema,encoder,headers} + buffer/stream `oneOf`). Consumers anchor via `x-telo-schema-from: "HttpDispatch.Outcomes/$defs/{Returns,Catches}"`. POC landed; migrated `Server.notFoundHandler.returns/catches`.
    - **`Request`** — whose `schema.$defs.Matcher` carries the HTTP request matcher value-shape (`method` / `path` / `query` / `body` / `headers`). Consumers anchor `routes[].request` via `x-telo-schema-from: "HttpDispatch.Request/$defs/Matcher"`. Identical between `http-server.Api.routes[].request` and `Lambda.HttpApi.routes[].request` — same carrier serves both. Ships alongside `Outcomes`; gates the full `http-server` `Api.routes[]` migration and Lambda's `HttpApi.routes[]` adoption.

    Both required a kind-agnostic analyzer extension — `x-telo-schema-from` now accepts import-aliased absolute paths (first segment containing a dot, resolved through the kind owner's alias scope) in addition to the existing sibling-ref and absolute-field-path forms. The `Outcomes` POC migration shrunk 142 lines of inline schema to 3 lines of schema-from references; full repo test suite (77/77) passes. Lambda's HTTP-shaped handler kinds (`HttpApi`, `RestApi`, `FunctionUrl`) pick up the same one-line anchors for both `Outcomes` and `Request`; no structural schema is duplicated across transports.

  Until both carriers land *and* http-server's `Api.routes[]` migrates to them, the Lambda function adapter is partially blocked — HTTP-shaped handler kinds can land structurally using the schema-from pattern, but the full "single source of truth across http-server and lambda" claim awaits the http-server migration. **Annotation duplication still exists** between transports for `x-telo-context` / `x-telo-context-from` / `x-telo-context-ref-from` on the `inputs:` / `returns:` / `catches:` fields — those are analyzer-side metadata read locally per field, not propagated through `x-telo-schema-from` today. A follow-up analyzer extension (let `x-telo-context-from` and `x-telo-context-ref-from` navigate through schema-from anchors) would remove the remaining duplication; tracked in the prereq plan but not v1-blocking.

- **(Soft) Typed `Telo.Abstract`** ([../../../kernel/nodejs/plans/typed-abstracts.md](../../../kernel/nodejs/plans/typed-abstracts.md)) — *partially landed; this plan does not block on the remainder*. Each concrete handler kind (`Lambda.HttpApi`, `Lambda.Sqs`, `Lambda.Direct`, …) declares its own `inputType` carrying the AWS event shape it expects. The controller validates incoming `{event, context}` payloads against that `inputType` *before* user CEL in `inputs:` evaluates — otherwise a malformed AWS payload (envelope drift, IAM-misrouted message, fuzzing input) reaches CEL with no boundary check and the error surfaces as a confusing CEL-evaluation diagnostic rather than a transport-layer validation failure. The pieces this plan needs are already in tree:

  - **`Telo.Abstract` schema is open** ([`manifest-schemas.ts:128-147`](../../../kernel/nodejs/src/manifest-schemas.ts#L128-L147) — `additionalProperties: true` "for forward compatibility with typed-abstracts work (inputType, outputType, …)"). So declaring `inputType` on the `Lambda.Handler` abstract and overriding it per concrete kind works today, no kernel/analyzer change required.
  - **Runtime validator compilation works today** via [`ctx.createTypeValidator()` at `resource-context.ts:74`](../../../kernel/nodejs/src/resource-context.ts#L74) — same machinery `JavaScript.Script` ([`modules/javascript/nodejs/src/script.ts:47-48`](../../../modules/javascript/nodejs/src/script.ts#L47-L48)) and `Sql.Select` already use against their own `inputType`. Each Lambda function-kind controller calls it once at `init()` with its own kind's `inputType` and runs the resulting validator on every incoming payload.

  What's **not** yet landed from typed-abstracts: (a) the analyzer's load-time *subtype conformance check* (typed-abstracts §3) that would catch a third-party `Acme.PubSubFunction extends Lambda.Handler` with a deviating `inputType` at `telo check` time, and (b) the invoke-time validation hook (typed-abstracts §4) that would fire automatically since concrete kinds are `Telo.Invocable` and the bootstrap routes via `ctx.invoke` through the abstract. When either lands, this plan inherits the analyzer-time check automatically; until then, the manual `ctx.createTypeValidator()` call in each controller's `init()` is the load-bearing payload check.

## Scope

In-scope:

- Module + controller package: per-source handler kinds + `Lambda.Function` (the AWS-facing service).
- One `Lambda.Function` per Telo.Application — convention, not analyzer-enforced. The shipped bootstrap invokes the Function named `Main` by default; users with a different name copy and edit the bootstrap. Multi-Function-per-manifest isn't part of v1's design (see Out of scope).
- Both deployment modes (managed / custom) — handled by which shipped bootstrap file the user copies into their artifact, plus their AWS runtime declaration. No manifest-level config.
- Handler kinds v1: `Lambda.Direct` (catch-all / synchronous SDK invoke), `Lambda.HttpApi` (API Gateway HTTP API v2), `Lambda.Sqs`. `Lambda.RestApi`, `Lambda.FunctionUrl`, `Lambda.EventBridge`, `Lambda.S3`, `Lambda.Schedule` follow incrementally.
- Response streaming when the invocable's output declares `x-telo-stream: true` (HTTP-shaped kinds only — AWS doesn't expose streaming response envelopes for SQS / EventBridge / S3).
- Graceful teardown on `SIGTERM`.
- Shipped library bootstraps (`managed.mjs`, `custom.mjs`) and an optional base Docker image (`telorun/lambda-managed`, `telorun/lambda-custom`) to make manual packaging a copy-paste exercise.

Out of scope:

- A Telo packaging resource (`Lambda.Bundle` / `Lambda.Package`). See [Why no `Lambda.Bundle`](#why-no-lambdabundle) and [Deploying](#deploying) — packaging is a standard `telo install` + `zip` (or 4-line Dockerfile) flow.
- Multi-Function-in-one-image deployments. The pattern (one Docker image hosting N AWS Lambdas via per-Lambda env-var routing) exists in AWS but is uncommon — most teams ship one artifact per Lambda or use AWS Layers for shared dependencies. Multi-Lambda backends in v1 use multiple Telo.Application manifests (one per Lambda). If a real consumer surfaces, the extension lands deliberately with proper deploy-side validation, not the runtime-env-var convention this plan considered and dropped.
- Other FaaS platforms (`modules/gcp-cloud-functions`, etc.) — separate modules, separate plans.
- Lambda Extensions API beyond the basic `SIGTERM`.
- SnapStart — semantics interact with controller state in ways that need separate analysis.

## Change

### Module layout

```
modules/lambda/
├── telo.yaml                  # Library: Lambda.Handler abstract + concrete kinds + Lambda.Function
├── nodejs/                    # controller package (@telorun/lambda)
│   ├── package.json
│   ├── src/
│   │   ├── common/            # shared infra: mode detection, sink factory,
│   │   │                      #   validator cache, event-shape classifier,
│   │   │                      #   AWS Runtime API helpers (pollNext / postResponse / postError)
│   │   ├── function.ts        # controller for Lambda.Function (Telo.Service)
│   │   ├── http-api.ts        # controller for Lambda.HttpApi
│   │   ├── sqs.ts             # controller for Lambda.Sqs
│   │   └── direct.ts          # controller for Lambda.Direct
│   ├── managed.mjs            # shipped bootstrap file — users copy this verbatim
│   ├── custom.mjs             # shipped bootstrap file — users copy this verbatim
│   └── tests/
└── docs/
    ├── overview.md            # picking a kind; managed vs custom; the Function
    ├── http-api.md            # Lambda.HttpApi reference
    ├── sqs.md                 # Lambda.Sqs reference
    ├── direct.md              # Lambda.Direct reference
    ├── deploying.md           # full manual flow: zip + image, both runtimes
    └── cold-starts.md
```

The Function controller owns the AWS-facing transport (mode detection, poll loop in custom mode, event classification, dispatch). Per-kind controllers handle their kind's specifics (route matching, outcome rendering, validators). Shared concerns live in `common/`. The `managed.mjs` / `custom.mjs` files at the package root are static — they're the bootstraps users copy into their artifact root. They never grow with feature additions. Adding a new handler kind is one new file under `src/` plus one new `Telo.Definition` in `telo.yaml`; no changes to existing kinds, no changes to the Function (it learns the new kind through the event-shape classifier registered when the new kind's controller comes online).

### Per-source handler kinds

`Lambda.Handler` is an abstract that names the dispatch contract; each concrete kind binds one AWS event source. The source type is encoded by the kind itself — there is no `source:` discriminator field on a generic function. Each concrete kind owns its full schema directly: matcher shape, source-specific config knobs, response shape. No type-only "EventSource" schema carriers; no per-handler polymorphism via `x-telo-schema-from`.

A Telo.Application can declare any number of handler resources extending `Lambda.Handler`. They become candidates for dispatch by a `Lambda.Function` (defined below). Handlers are pure `Telo.Invocable`s — they have no AWS-facing transport themselves; they only receive `{event, context}` payloads when a Function calls into them via `ctx.invoke`.

```yaml
kind: Telo.Library
metadata:
  namespace: aws
  name: lambda
  version: 0.1.0
imports:
  # Shared HTTP outcome schema for HTTP-shaped handler kinds.
  HttpDispatch: std/http-dispatch@0.4.1
exports:
  kinds: [ Function, HttpApi, Sqs, Direct ]
---
# Abstract dispatch contract. Concrete handler kinds extend this; a
# Lambda.Handler (see below) dispatches incoming AWS events to whichever
# concrete instances it lists in its `handlers:` array.
kind: Telo.Abstract
metadata: { name: Handler }
capability: Telo.Invocable
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      event: { type: object }
      context: { type: object }
    required: [ event, context ]
outputType:
  kind: Type.JsonSchema
  schema:
    # AWS-shaped response envelope. Concrete kinds narrow this per-source.
    type: object
---
# API Gateway HTTP API v2 trigger. The kind IS the source.
kind: Telo.Definition
metadata: { name: HttpApi }
extends: Self.Handler
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/lambda@0.4.1?local_path=./nodejs#http-api
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      event:
        type: object
        properties:
          version: { type: string, const: "2.0" }
          requestContext: { type: object }
          headers: { type: object, additionalProperties: true }
          body: {}
          isBase64Encoded: { type: boolean }
        required: [ version, requestContext ]
      context: { type: object }
    required: [ event, context ]
schema:
  type: object
  properties:
    cors:
      type: object
      additionalProperties: false
      properties:
        origin: { oneOf: [ { type: string }, { type: array, items: { type: string } } ] }
        methods: { type: array, items: { type: string } }
        allowedHeaders: { type: array, items: { type: string } }
        credentials: { type: boolean }
        maxAge: { type: integer }
    routes:
      type: array
      x-telo-scope: /routes/*
      items:
        type: object
        additionalProperties: false
        properties:
          request:
            # HTTP request matcher — structural schema (method / path / query /
            # body / headers) anchored at the shared @telorun/http-dispatch
            # carrier. Mirrors http-server.Api.routes[].request once http-server
            # migrates to the same anchor (tracked in the prereq plan).
            x-telo-schema-from: "HttpDispatch.Request/$defs/Matcher"
          handler:
            x-telo-ref: telo#Invocable
            x-telo-context:
              type: object
              additionalProperties: false
              properties:
                inputs: { type: object, additionalProperties: true }
                result: { type: object, additionalProperties: true }
          inputs:
            type: object
            additionalProperties: true
            x-telo-eval: runtime
            # CEL evaluation context for input-mapping expressions. Mirrors
            # http-server.Api.routes[].inputs's context. The `request/schema`
            # navigation reads the matcher shape from the schema-from anchor
            # above (the analyzer follows x-telo-schema-from when resolving
            # x-telo-context-from anchors — a small extension landed alongside
            # the Request carrier; until then, this is duplicated inline as the
            # full matcher type-shape mirroring HttpDispatch.Request/$defs/Matcher).
            x-telo-context:
              type: object
              additionalProperties: false
              properties:
                request:
                  x-telo-context-from: "request/schema"
                  type: object
                  properties:
                    method: { type: string }
                    path: { type: string }
                    query: { type: object, additionalProperties: true }
                    body: { type: object, additionalProperties: true }
                    headers: { type: object, additionalProperties: true }
                    params: { type: object, additionalProperties: true }
          returns:
            type: array
            x-telo-outcome-list: returns
            x-telo-schema-from: "HttpDispatch.Outcomes/$defs/Returns"
            x-telo-context:
              type: object
              additionalProperties: false
              properties:
                request:
                  x-telo-context-from: "request/schema"
                  type: object
                  properties:
                    method: { type: string }
                    path: { type: string }
                result:
                  x-telo-context-ref-from: "handler/outputType"
                  type: object
                  additionalProperties: true
          catches:
            type: array
            x-telo-outcome-list: catches
            x-telo-catches-for: handler
            x-telo-schema-from: "HttpDispatch.Outcomes/$defs/Catches"
            x-telo-context:
              type: object
              additionalProperties: false
              properties:
                request:
                  x-telo-context-from: "request/schema"
                  type: object
                  properties:
                    method: { type: string }
                    path: { type: string }
                error:
                  type: object
                  additionalProperties: false
                  properties:
                    code: { type: string }
                    message: { type: string }
                    data: { type: object, additionalProperties: true }
        required: [ request, handler ]
  required: [ routes ]
---
# SQS queue trigger. Single queue, single handler — no routes array (one Lambda
# per queue is the standard AWS pattern; multi-queue triggers split into multiple
# bundles).
kind: Telo.Definition
metadata: { name: Sqs }
extends: Self.Handler
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/lambda@0.4.1?local_path=./nodejs#sqs
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      event:
        type: object
        properties:
          Records:
            type: array
            items:
              type: object
              properties:
                messageId: { type: string }
                body: { type: string }
                attributes: { type: object, additionalProperties: true }
                messageAttributes: { type: object, additionalProperties: true }
                eventSourceARN: { type: string }
              required: [ messageId, body, eventSourceARN ]
        required: [ Records ]
      context: { type: object }
    required: [ event, context ]
schema:
  type: object
  properties:
    queue:
      type: object
      additionalProperties: false
      properties:
        queueName: { type: string }
        queueArn: { type: string }
    batchSize:
      type: integer
      minimum: 1
      maximum: 10000
    partialBatchResponse:
      type: boolean
      default: true
    handler:
      x-telo-ref: telo#Invocable
    inputs:
      type: object
      additionalProperties: true
      x-telo-eval: runtime
    returns:
      # SQS partial-batch-failure shape — bespoke, not HTTP-outcome-shaped.
      type: object
      additionalProperties: false
      properties:
        batchItemFailures:
          type: array
          items:
            type: object
            properties:
              itemIdentifier: { type: string }
            required: [ itemIdentifier ]
  required: [ handler ]
---
# Direct (synchronous SDK invoke / Step Functions / internal callers). No fixed
# matcher — payload is whatever the caller sent. Use for admin tooling, internal
# RPC, EventBridge Scheduler with no transformation, or as a catch-all for
# mixed-pattern functions.
kind: Telo.Definition
metadata: { name: Direct }
extends: Self.Handler
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/lambda@0.4.1?local_path=./nodejs#direct
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      event: { type: object }
      context: { type: object }
    required: [ event, context ]
schema:
  type: object
  properties:
    handler:
      x-telo-ref: telo#Invocable
    inputs:
      type: object
      additionalProperties: true
      x-telo-eval: runtime
    returns:
      type: array
      x-telo-outcome-list: returns
      items:
        type: object
        properties:
          when: { type: boolean }
          body: {}
    catches:
      type: array
      x-telo-outcome-list: catches
      x-telo-catches-for: handler
      items:
        type: object
        properties:
          code: { type: string }
          when: { type: boolean }
          body: {}
  required: [ handler ]

# … similar definitions for RestApi, FunctionUrl, EventBridge, S3, Schedule
---
# Function: AWS-facing transport. Represents the AWS Lambda function (one ARN).
# The bootstrap calls kernel.invoke against a Function instance; the Function
# classifies the incoming AWS event by shape (API Gateway requestContext.http
# → HttpApi; Records[].eventSource === "aws:sqs" → Sqs; etc.) and dispatches
# via ctx.invoke to the matching handler.
kind: Telo.Definition
metadata: { name: Function }
capability: Telo.Service
controllers:
  - pkg:npm/@telorun/lambda@0.4.1?local_path=./nodejs#function
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      event: { type: object }
      context: { type: object }
    required: [ event, context ]
schema:
  type: object
  properties:
    handlers:
      type: array
      minItems: 1
      items:
        # x-telo-ref against the Lambda.Handler abstract; any concrete kind
        # extending it satisfies the ref structurally and by kind-check.
        x-telo-ref: "aws/lambda#Handler"
  required: [ handlers ]
```

User manifest, HTTP-only Lambda (single-handler Function):

```yaml
kind: Telo.Application
metadata: { name: webhook-handler, version: 1.0.0 }
imports:
  Lambda: aws/lambda@0.1.0
targets: [ Main ]
---
kind: Lambda.HttpApi
metadata: { name: Webhook }
cors: { origin: "*" }
routes:
  - request: { method: POST, path: /webhook }
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
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - { kind: Lambda.HttpApi, name: Webhook }
```

User manifest, mixed-source Lambda (HTTP + SQS on one ARN — the case where the Function's classifier earns its keep):

```yaml
kind: Telo.Application
metadata: { name: backend, version: 1.0.0 }
imports:
  Lambda: aws/lambda@0.1.0
targets: [ Main ]
---
kind: Lambda.HttpApi
metadata: { name: WebApi }
routes: [ ... ]
---
kind: Lambda.Sqs
metadata: { name: OrderProcessor }
queue: { queueName: orders }
batchSize: 10
handler: { kind: My.OrderProcessor }
inputs:
  records: !cel "event.Records"
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - { kind: Lambda.HttpApi, name: WebApi }
  - { kind: Lambda.Sqs, name: OrderProcessor }
```

AWS-side, the user binds both API Gateway and an SQS event source mapping to the same Lambda ARN; AWS delivers events of either shape to the same handler entry; the Function classifies and dispatches internally. This is still **one** AWS Lambda artifact and **one** `Lambda.Function` resource — it just has multiple event source mappings on the AWS side and a handler per source-shape in the manifest.

For a deployment with N **separate** AWS Lambda artifacts (each its own ARN, IAM role, scaling profile), write N separate Telo.Application manifests, one per Lambda. Each manifest contains its own `Lambda.Function`. Shared dependencies between Lambdas use AWS Layers — the standard AWS architecture for that case. v1 doesn't ship a one-image-many-Lambdas option; see [Out of scope](#scope).

Each handler kind is `capability: Telo.Invocable`. Handlers have no AWS-facing transport themselves — they're pure dispatch targets. The Function (`capability: Telo.Service`) owns the AWS transport: its `init()` prepares the event-shape classifier and payload validators; its `run()` (fired by `runTargets()` under custom-mode deployments) starts the poll loop and acquires the kernel hold. Per-event dispatch goes through the Function's `invoke()` method, either via the bootstrap-exported handler in managed mode or via the Function's own poll loop in custom mode.

### Shared dispatch

The Function controller (`nodejs/src/function.ts`) owns the AWS-facing transport. Each per-source handler kind has its own controller in `nodejs/src/<kind>.ts` that defines the dispatch logic for that kind. Shared infrastructure (mode detection, sink factory, validator cache, event-shape classifier) lives in `common/`.

The Function follows the standard `Telo.Service` shape — `init()` for preparation, `run()` for "actually start the service," `teardown()` for cleanup — and additionally exposes an `invoke(inputs)` method that the bootstrap calls per AWS event via `kernel.invoke`. The `init()` / `run()` split mirrors how `Http.Server` works: `init()` is pure setup, `run()` is what actually engages with the outside world.

**`init()` — called for every loaded Function at `kernel.boot()` time, regardless of `targets:`:**

- Builds an event-shape classifier from the Function's `handlers:` list. Each listed handler's kind contributes one classifier entry: HttpApi matches when `event.requestContext?.http` is present; Sqs matches when `event.Records?.[0]?.eventSource === "aws:sqs"`; Direct matches anything (catch-all). Multiple HttpApi-like classifiers in one Function are an error at `init()` (they'd be ambiguous).
- Compiles each handler's `inputType` validator via [`ctx.createTypeValidator()` at `resource-context.ts:74`](../../../kernel/nodejs/src/resource-context.ts#L74) for boundary validation; cached per resolved handler instance.
- Pure preparation; no side effects on the outside world. After `init()`, the Function is ready to be `invoke()`d but isn't actively listening for anything.

**`run()` — called by `kernel.runTargets()` for the Function listed in the Telo.Application's `targets:`:**

- Detects deployment mode from `process.env.AWS_LAMBDA_RUNTIME_API`. Custom mode — start the poll loop in a background task (polls AWS Runtime API, calls `this.invoke({event, context})` per event, posts the response back) and `acquireHold()` the kernel so the process stays alive across iterations. Managed mode — under the current bootstrap shapes `run()` is never invoked in managed mode (managed bootstrap calls `kernel.boot()` only, not `runTargets()`), but the method is defensive: if called under managed env it just `acquireHold()`s and returns, so the process stays loaded between AWS invocations.

**`teardown()` — on SIGTERM:** releases the hold and stops the poll loop (custom mode); the kernel then exits cleanly.

**`invoke(inputs)` — called per AWS event by `kernel.invoke` from the bootstrap (managed mode) or by the Function's own poll loop (custom mode):**

1. **Classify** — walks the classifier table for the incoming `{event, context}`. Picks the first matching handler. No match → throws an "unroutable event" error; the bootstrap surfaces it to AWS.
2. **Validate** — runs the matched handler's `inputType` validator against the payload. Failure → `TypeValidationError` to AWS (transport-layer diagnostic, not a CEL surprise).
3. **Dispatch** — calls `ctx.invoke(handler.kind, handler.name, { event, context })` against the matched handler. The handler controller handles its own routing logic (routes[] for HttpApi, single-handler for Sqs / Direct).
4. **Render outcome** — the handler's `invoke` returns the AWS-shaped response. The Function passes it back to its caller (the bootstrap in managed mode, or its own poll loop in custom mode, which POSTs it to the AWS Runtime API).

**Per-handler-kind controllers, at invocation (called via `ctx.invoke` by the Function):**

- **Event classification within the kind** — kind-specific.
  - `Lambda.HttpApi`: walks `routes[]`, matches the event against `routes[].request.method` + `routes[].request.path` (OpenAPI-style path-param extraction). Same matcher logic as [`http-server`'s route dispatcher](../../http-server/nodejs/src/http-api-controller.ts) — pulled into `common/match-http-route.ts` and shared.
  - `Lambda.Sqs`: no further classification (single queue, single handler). Event has `Records[]`; the controller passes the array through to the user's CEL.
  - `Lambda.Direct`: no further classification. Event is opaque; user CEL maps it.
- **Scope entry** — `scope.run(s => s.invoke(handler.kind, handler.name, inputs))` per matched event (or per route, for `HttpApi`).
- **Outcome rendering** — kind-specific.
  - HTTP-shaped kinds (`HttpApi`, `RestApi`, `FunctionUrl`): construct a `LambdaResponseSink` per invocation, call the shared `dispatchReturns` / `dispatchCatches` from `@telorun/http-dispatch`, sink emits the AWS HTTP response envelope `{ statusCode, headers, body, isBase64Encoded }`. Same call site as http-server; shape parity with `Http.Api.routes[]`.
  - `Lambda.Sqs`: renders the `batchItemFailures` envelope directly from `returns:` matches (no MIME negotiation, no sink). Unhandled throws mark all messages for retry; partial-batch failure is opt-in via `partialBatchResponse: true` (default).
  - `Lambda.Direct`: simple `when`/`body` match; serializes the matched entry's body as JSON and returns it as the function's return value.
- **Unhandled throw fallback** — kind-specific: HTTP kinds emit a 500 with the stack going to CloudWatch (body sanitized); SQS surfaces a throw to AWS as full-batch retry; Direct propagates the throw to AWS, which surfaces it to the SDK caller.

When typed-abstracts' invoke-time hook ([typed-abstracts.md §4](../../../kernel/nodejs/plans/typed-abstracts.md)) lands, the Function's manual `inputType` validation moves into the kernel's `ctx.invoke` machinery (fires automatically because handlers are `Telo.Invocable` and the Function dispatches via `ctx.invoke`); until then, the Function's manual call is the load-bearing payload check.

### Mode-specific lifecycle

The mode is determined at runtime by `process.env.AWS_LAMBDA_RUNTIME_API` (AWS sets it in custom-runtime environments, leaves it unset in managed). The user picks which mode they're targeting at deploy time by choosing the AWS runtime declaration (`nodejs24.x` vs `provided.al2023`) and copying the matching bootstrap file (`managed.mjs` vs `custom.mjs`); the Function controller's `run()` observes the resulting env and adapts.

| concern | managed (`nodejs24.x`) | custom (`provided.al2023` / container) |
|---|---|---|
| `$AWS_LAMBDA_RUNTIME_API` | unset | set by AWS |
| outer loop | AWS-provided; bootstrap exports `handler` | Function's `run()` starts a `while (!stopping)` poll loop in a background task |
| kernel boot path | `kernel.boot()` only — runs every Function's `init()` (preparation), exports the handler, returns immediately so AWS can call it | `kernel.start()` (= `boot()` + `runTargets()` + wait-for-idle + `teardown()`) — runs every Function's `init()`, then `run()` on each Function in `targets:` |
| Function.`init()` | runs (every loaded Function) | runs (every loaded Function) |
| Function.`run()` | does NOT run — managed bootstrap skips `runTargets()` | runs (the Function is in `targets:`) — starts the poll loop + acquires hold |
| dispatch trigger | `exports.handler` called per event by AWS → forwards into `kernel.invoke` | Function's poll loop receives an event from `$AWS_LAMBDA_RUNTIME_API` |
| dispatch site | `kernel.invoke("aws/lambda#Function", <name>, { event, context })` — called from the exported handler | `this.invoke({ event, context })` — called from inside the Function's own poll loop |
| teardown | `SIGTERM` → `kernel.teardown()` | `SIGTERM` → cancel next poll → drain in-flight invoke → release hold → `kernel.teardown()` |
| keepalive | AWS owns process lifetime | Function holds the kernel via `acquireHold()` during the poll loop |

Same handler kinds, same `init()`-time preparation, same `invoke()` per event. The bootstrap shape and the choice between `kernel.boot()` and `kernel.start()` are what differ — managed mode wants to return immediately so AWS can call the exported handler; custom mode wants to block until SIGTERM while its poll loop runs.

### Bootstrap entry points

Two bootstrap files ship as static exports of `@telorun/lambda` — users copy whichever matches their target runtime into their artifact. Neither file is generated, neither is per-manifest; both are <20 lines and exist verbatim in the package.

**Managed mode** — `@telorun/lambda/managed.mjs`:

```js
import { Kernel, LocalFileSource } from "@telorun/kernel";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");
await kernel.boot();
process.once("SIGTERM", () => kernel.teardown());

export const handler = (event, context) =>
  kernel.invoke("aws/lambda#Function", "Main", { event, context });
```

User copies this file into their artifact as `index.mjs` (or `dist/handler.mjs`, or any path matching their AWS handler config). AWS calls `handler(event, context)`; the Function classifies the event and dispatches to the matching handler. The bootstrap invokes the Function named `Main` — by convention every Telo.Application's Lambda.Function is named that. Users who pick a different name copy this file and edit the one string; the bootstrap is small enough that this is genuinely a copy-paste edit rather than a configuration system.

**Custom mode** — `@telorun/lambda/custom.mjs`:

```js
import { Kernel, LocalFileSource } from "@telorun/kernel";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");

// kernel.start() = boot() + runTargets() + wait-for-idle + teardown().
// boot() inits the Function; runTargets() calls run() on the Function in
// `targets:`; run() starts the poll loop and acquireHold()s the kernel.
// wait-for-idle blocks until the hold is released (SIGTERM in the poll
// loop), then teardown fires.
process.once("SIGTERM", () => kernel.teardown());
await kernel.start();
```

The custom bootstrap is even thinner than the managed one — it just boots the kernel and waits. The Function's `init()` is what runs the poll loop in this mode (per [Mode-specific lifecycle](#mode-specific-lifecycle)). `pollNext` / `postResponse` / `postError` helpers used inside the Function live in `nodejs/src/common/runtime-api.ts` — not exported, not user-facing.

Both bootstrap files are identical across every Lambda manifest in the project: they don't know about specific handler kinds, function names, or routing rules. Adding `Lambda.EventBridge` later changes no bootstrap line. Users who want to write their own bootstrap (e.g., to add OpenTelemetry instrumentation around `kernel.invoke`) can — the shipped files are convenience, not a contract.

### Runtime concerns

**Cold-start budget.** Lambda's Init phase has a tight budget (well under 10 s for runtime init on `nodejs24.x`); aim for sub-second when synchronous HTTP traffic is in play. Moves:

- **Managed mode uses `kernel.boot()`; custom mode uses `kernel.start()`.** Managed skips `runTargets()` because AWS owns the outer loop — `init()` is enough to prepare the Function for the bootstrap-exported handler. Custom runs targets so the Function's `run()` fires, starting its poll loop.
- **Defer slow init via `x-telo-scope`.** Heavy resources (DB pools, AI model loads) scope to the handler so they initialize per-first-invocation. Document the pattern in `docs/cold-starts.md`.
- **No registry calls at boot.** Guaranteed by the deployment artifact — `.telo/npm/` is hermetic (populated by `telo install` before packaging; see [Deploying](#deploying)). Adapter fails fast at boot if `TELO_REGISTRY_URL` would be consulted.
- **Measure.** Adapter emits a `Kernel.Booted` event with a duration; CloudWatch dashboard examples in the docs.

**Streaming.** Invocables with `x-telo-stream: true` on their output type render through the response sink's `stream(AsyncIterable<Uint8Array>, onError?)` path — same call site as `http-server`. The Lambda sink implementations differ by mode (constructed by `common/sink-factory.ts` based on the env-var check):

- Managed: wrap the handler with `awslambda.streamifyResponse`; `stream` pipes into the Lambda response stream.
- Custom: POST to `/runtime/invocation/{requestId}/response` with `Transfer-Encoding: chunked`.

Detection (inspecting the resolved invocable's output type for `x-telo-stream`) is identical across modes — the sink handles the rest. Only HTTP-shaped kinds (`HttpApi`, `RestApi`, `FunctionUrl`) support streaming; non-HTTP kinds (`Sqs`, `EventBridge`, `S3`, `Direct`) must buffer (AWS doesn't have a streaming return envelope for those).

**Logging.** Lambda captures `console.log` / `console.error` to CloudWatch. Bootstrap leaves `kernel.stdout` / `kernel.stderr` at the defaults (`process.stdout` / `process.stderr`). Structured JSON falls out the bottom.

X-Ray tracing: deferred. Add when an `@telorun/observability-aws` module exists.

## Why this shape

`Lambda.Function` owns the AWS-facing transport; per-source handler kinds (`Telo.Invocable`s) are pure dispatch targets the Function invokes. The bootstrap is a thin shim that boots the kernel and calls `kernel.invoke("aws/lambda#Function", <name>, payload)`. The Function classifies events by shape and dispatches to handlers via `ctx.invoke`. Same dispatch primitive across kinds and across modes.

**Polyglot scope, stated honestly.** The *manifest layer* — the `aws/lambda@0.1.0` registry artifact declaring `Lambda.Function` / `Lambda.Handler` / `Lambda.HttpApi` / `Lambda.Sqs` / `Lambda.Direct` with their schemas, inputTypes, and `x-telo-*` annotations — is language-neutral. A future Go or Python kernel reads the same registry artifact. The *controller and bootstrap layers* are necessarily per-language: `@telorun/lambda` is the Node.js implementation; the shipped `managed.mjs` / `custom.mjs` files import `@telorun/kernel` and only work under a Node-compatible runtime. A future Go kernel would ship its own `telorun-lambda-go` (or similar) package with equivalent Go-flavored bootstraps consuming the same manifest layer. This matches every other Telo module: `@telorun/sdk`, `@telorun/http-server`, etc. are Node-implementation packages of language-neutral concepts. The polyglot story is at the manifest layer, not the bootstrap.

**Why per-source handler kinds instead of a single `Lambda.Handler` with a `source:` discriminator.** A polymorphic `Lambda.Handler` would have to type-check `handlers[].match` against a per-source schema via `x-telo-schema-from "source/$defs/Match"`, type-check `inputs:` against a per-source CEL context via `x-telo-schema-from "source/$defs/Request"`, and branch the controller on `source.kind` at invocation time. That's two layers of polymorphism (per-handler source AND per-handler match) supporting a usage pattern most Lambdas don't need. The per-source-kind design collapses this:

- **The kind IS the source.** No discriminator field; no per-handler polymorphism; no schema-from indirection. The schema for `Lambda.HttpApi` is monomorphic and complete on its own.
- **Source-specific config sits where it belongs.** SQS's `batchSize` / `partialBatchResponse` go on `Lambda.Sqs` directly. HTTP's `cors:` goes on `Lambda.HttpApi` directly. No namespace-under-`source:` plumbing.
- **The "type-only EventSource carrier" layer disappears.** Previously, each event source needed a `Telo.Type` schema carrier defining `$defs/Match`, `$defs/Request`, `$defs/Returns`, `$defs/Catches` so a generic Function could anchor schema-from against it. With per-source kinds, the handler kind owns its schemas directly. One layer of indirection gone.
- **Editor form rendering is straightforward.** The user picks a kind from a kind-picker; the editor renders one form for that kind. No conditional rendering keyed on a `source.kind` selection.
- **Adding a new handler kind is additive.** New definition in `telo.yaml`, new controller file in `nodejs/src/`. Zero changes to existing kinds. Same shape: one `extends: Self.Handler`, one `inputType`, one `schema:`. Third-party `Acme.PubSubFunction extends Self.Handler` ships the same way.

**Why a Function resource owns the AWS transport rather than each handler kind hosting its own.** Three reasons. First, an AWS Lambda function can have multiple event source mappings on one ARN (HTTP + SQS + Direct invoke all landing on the same ARN); a single dispatching resource lets one Telo manifest express this without contortions. Second, having a single AWS-facing service per artifact keeps the bootstrap trivially generic — there's exactly one resource shape (`Telo.Service`) the bootstrap dispatches to, regardless of which handler kinds are in play. Third, it separates *what AWS sees* (the Function — the entry-point service) from *what the dispatch targets are* (the handler kinds — `Lambda.HttpApi`, `Lambda.Sqs`, …) — the same separation `http-server` already makes between `Server` (TCP listener) and `Api` (route table).

**Why `targets: [Main]` on the `Telo.Application`.** The Function is `Telo.Service`; its `init()` runs at `kernel.boot()` time (preparation — building the classifier, compiling validators), but the actual outside-world engagement happens in `run()`, which is only called for resources listed in `targets:`. Without `targets: [Main]`, custom-mode deployments would call `kernel.start()` but `runTargets()` would find nothing to run, and the Function's poll loop would never start. This isn't a Lambda quirk — it's the same convention every `Telo.Service` follows in the stdlib (`apps/registry/telo.yaml` puts `RegistryServer` in `targets:` for exactly the same reason; `Http.Server.run()` is what binds the port). One line per Lambda artifact. The line is load-bearing for custom mode and harmless in managed (managed bootstrap calls `kernel.boot()` only and never invokes `runTargets()`).

**Why HTTP outcome schemas come from `@telorun/http-dispatch`.** `Lambda.HttpApi.routes[].returns` and `.catches` anchor at `HttpDispatch.Outcomes/$defs/{Returns,Catches}` — the same `Telo.Definition` `http-server`'s `Api.routes[]` anchors against. Same analyzer coverage, same `dispatchReturns` / `dispatchCatches` runtime through the transport-neutral sink, same per-MIME content negotiation, same `x-telo-ref` to `std/codec#Encoder`. Zero fork across transports: when http-dispatch evolves, both http-server and Lambda's HTTP-shaped kinds pick it up for free. Non-HTTP kinds (`Sqs`'s `batchItemFailures`) carry their own bespoke `returns:` schema — different shape genuinely warrants different structure.

**Why `request:` for `Lambda.HttpApi` matches `http-server.Api`.** The matcher field inside `routes[]` is called `request:` (not `match:`) for HTTP-shaped Lambda kinds, mirroring `http-server.Api.routes[].request` exactly. Users can copy route entries between the two transports without renaming a field. Non-HTTP kinds use domain-appropriate names — `Lambda.Sqs.queue`, future `Lambda.EventBridge.rule`, `Lambda.S3.trigger` — because the per-source-kind design unlocks per-domain naming without forcing one universal name. (`Lambda.Direct` doesn't have a matcher field at all — there's nothing to match against.)

The matcher *structural* schema (`method` / `path` / `query` / `body` / `headers`) is shared between transports via a `HttpDispatch.Request` carrier published from `@telorun/http-dispatch` (see [Prerequisites](#prerequisites)). Both `Lambda.HttpApi.routes[].request` and `http-server.Api.routes[].request` anchor at it via `x-telo-schema-from: "HttpDispatch.Request/$defs/Matcher"` — same carrier pattern that solves the `Returns` / `Catches` duplication. When http-dispatch evolves the matcher (e.g. adds OpenAPI-style segment annotations, or a new content-encoding hook), both transports pick it up for free.

The `x-telo-context` annotations on `inputs:` / `returns:` / `catches:` — which type the CEL variables inside those fields — are still inlined locally in v1. These are analyzer-side metadata read per-field, not propagated through `x-telo-schema-from` today; the `request/schema` sibling navigation works because the analyzer follows schema-from anchors when resolving context-from references (a small extension landing alongside the Request carrier). Removing the per-consumer annotation duplication is a follow-up in the prereq plan; not v1-blocking.

**Why a typed `Telo.Abstract` over a free-form one.** With each concrete kind declaring its own `inputType` (the AWS event shape it expects after the runtime invokes it), the analyzer's typed-abstracts subtype check (when it lands) keeps third-party `Acme.PubSubFunction extends Lambda.Handler` honest at `telo check` time: a deviating `inputType` fails analysis before reaching first invocation. Until that lands, the Function compiles AJV validators from each listed function's `inputType` and runs them manually at invocation. Same machinery (`ctx.createTypeValidator`) the kernel exposes for `JavaScript.Script`, `Sql.Select`, etc. — each Lambda handler kind is one more consumer.

**Why no `Lambda.Bundle` or `Lambda.Package` resource.** The packaging operations a Telo build resource would have done — load + analyze, inline includes, install controllers, copy node_modules, emit bootstrap, zip / Dockerfile-emit — are mostly already covered by existing tooling: `telo install` populates `.telo/npm/` hermetically; the bootstrap is a shipped library file users copy verbatim; `zip` and `docker build` need no Telo-specific layer. The savings of a build resource are ~10 lines of bootstrap and a `zip` invocation. The costs are real: dual-mode controllers, a Telo CLI coupled to AWS specifics (which the project explicitly forbids), per-target-format logic. Instead of bundling, the module ships a base Docker image and a docs page with copy-pasteable templates for both targets. The docs are the build tool. See [Deploying](#deploying) for the full manual flow.

**Why deployment mode is selected by which bootstrap the user copies, not by a manifest field.** Whether the artifact runs under AWS's managed Node runtime (`nodejs24.x`) or our custom bootstrap (`provided.al2023` / container) is a packaging concern: it picks which AWS runtime declaration the user's deployment template carries and which bootstrap file gets copied into the artifact (`managed.mjs` → `index.mjs`, or `custom.mjs` → `bootstrap`). The Function controller observes the resulting environment via `$AWS_LAMBDA_RUNTIME_API`'s presence and adapts. No manifest-level config means no possibility of manifest/bundle disagreement — the manifest is identical across both deployment shapes.

**Why no boilerplate for inline kind references.** Users write inline `{kind: ...}` refs (`handler: { kind: My.Webhook }` etc.) without declaring named resources. The analyzer's Phase 2 inline-resource normalization ([`normalize-inline-resources.ts`](../../../analyzer/nodejs/src/normalize-inline-resources.ts)) already extracts `{kind}`-only values across every `x-telo-ref` slot in the codebase — it auto-generates a first-class resource (deterministic name like `Main_routes_0_handler`), rewrites the slot to the standard `{kind, name}` shape, and registers the manifest. By Phase 3 the ref looks exactly like an explicitly-declared named resource. This isn't a Lambda-specific concession — `apps/registry/telo.yaml` uses the same inline form for `Sql.Exec`, `S3.Put`, `HttpClient.Request`, etc.

## Test

1. **Per-kind unit tests** — one vitest file per concrete kind (`tests/http-api.test.ts`, `tests/sqs.test.ts`, `tests/direct.test.ts`). For each kind, feed a representative AWS payload and assert correct invocable dispatch and response shape. The shared `common/` infrastructure (mode detection, sink factory, validator cache, event-shape classifier) gets its own `tests/common.test.ts` exercising both env-var presence states.
2. **Function tests** — `tests/function.test.ts` covers event-shape classification (HTTP event → HttpApi handler; SQS event → Sqs handler; Direct as catch-all), unroutable-event errors, mixed-source manifests (one Function with multiple handler kinds) dispatching correctly, and the `init()`/`run()` lifecycle split (init runs at boot regardless of targets; run runs only when the Function is in `targets:` under `kernel.start()`).
3. **E2E** — `tests/e2e-managed.test.ts` and `tests/e2e-custom.test.ts`. Drive both modes against [aws-lambda-runtime-interface-emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator) (RIE). Managed: RIE invokes the bootstrapped `handler`. Custom: point the bootstrap script at RIE's emulated runtime endpoint and verify it polls. Runs in CI without real AWS credentials. Per-kind coverage: at minimum one HttpApi + one Sqs + one Direct E2E scenario each, in both modes, plus a mixed-source Function scenario.

Vitest tests live under `modules/lambda/nodejs/tests/`; wire into CI as a per-package vitest job.

## Docs

- `modules/lambda/docs/overview.md` — entry point. When to pick which concrete handler kind; what `Lambda.Function` does; the `Lambda.Handler` abstract.
- `modules/lambda/docs/http-api.md` — `Lambda.HttpApi` reference. Routes / matchers / CORS / response rendering. Parity table with `http-server.Api`.
- `modules/lambda/docs/sqs.md` — `Lambda.Sqs` reference. Queue binding, batch sizes, partial-batch-failure semantics.
- `modules/lambda/docs/direct.md` — `Lambda.Direct` reference. When to use it (SDK invoke, Step Functions, schedulers without rule shape, internal admin tooling).
- `modules/lambda/docs/deploying.md` — full manual packaging flow (the page that replaces having a build resource): `telo install` + `zip` for the zip target; `telo install` + 4-line Dockerfile against `telorun/lambda-managed:<version>` or `telorun/lambda-custom:<version>` for the image target. AWS-side config templates (SAM / CDK / Terraform snippets). See [Deploying](#deploying) below for the inline summary.
- `modules/lambda/docs/cold-starts.md` — budget guidance, `x-telo-scope` patterns, artifact-size trade-offs.

Add each to [`pages/docusaurus.config.ts`](../../../pages/docusaurus.config.ts) `include` array and [`pages/sidebars.ts`](../../../pages/sidebars.ts). `sidebar_label` frontmatter on each.

## Deploying

Telo ships no packaging resource (see [Why no `Lambda.Bundle`](#why-no-lambdabundle) below). The manual flow is short enough to fit on this page; `docs/deploying.md` is the canonical version with platform-specific deploy templates.

**1. Author the manifest** as described in [Per-source handler kinds](#per-source-handler-kinds), declaring one or more `Lambda.<Kind>` resources plus a `Lambda.Function` that lists them. The `Telo.Application` must include the Function(s) in its `targets:` list — that's what makes the Function's `run()` fire under custom-runtime deployments (see [Mode-specific lifecycle](#mode-specific-lifecycle)).

**2. Install dependencies hermetically:**

```bash
telo install ./telo.yaml
```

Populates `.telo/npm/` with all controllers and their dependencies. Same command Telo uses for any module deployment.

**3. Copy the right bootstrap into the artifact root:**

```bash
# Managed runtime:
cp node_modules/@telorun/lambda/managed.mjs ./index.mjs
# Custom runtime:
cp node_modules/@telorun/lambda/custom.mjs ./bootstrap && chmod +x ./bootstrap
```

**4. Package.** Zip target:

```bash
zip -r function.zip telo.yaml index.mjs .telo node_modules
```

Image target (a 4-line Dockerfile against the Telo-provided base image):

```dockerfile
FROM telorun/lambda-managed:0.1.0
COPY telo.yaml ${LAMBDA_TASK_ROOT}/
COPY .telo/ ${LAMBDA_TASK_ROOT}/.telo/
COPY node_modules/ ${LAMBDA_TASK_ROOT}/node_modules/
```

The base image (`telorun/lambda-managed` / `telorun/lambda-custom`) is `FROM public.ecr.aws/lambda/nodejs:20` (or `provided:al2023`) with `@telorun/kernel`, `@telorun/sdk`, `@telorun/lambda` pre-installed and the right `CMD` baked in. Users supply only their manifest + their app's `node_modules`.

**5. Deploy** with any AWS tool — `aws lambda update-function-code`, SAM, CDK, Terraform, etc. The deployment template is responsible for setting the AWS runtime (`nodejs24.x` for managed, `provided.al2023` for custom), event source mappings (API Gateway, SQS, etc.), and the IAM role.

For backends that need multiple AWS Lambda functions, repeat the flow per Lambda — one Telo.Application manifest each, packaged separately. Shared dependencies between Lambdas use AWS Layers. Telo doesn't ship a one-image-many-Lambdas mode in v1.

## Why no `Lambda.Bundle`

A Telo build resource (`Lambda.Bundle` / `Lambda.Package`) was considered and explicitly dropped. The case against:

- **The savings are small.** Cross-referencing what the build resource would have done against the manual flow above: load + analyze is `telo check`; install controllers is `telo install`; emit bootstrap is `cp managed.mjs index.mjs`; zip / image is `zip` / a 4-line Dockerfile. The actual Telo-specific automation is the `cp` and the bootstrap-name choice. ~10 lines of saved typing per artifact.
- **The costs are real.** A Telo build resource would have to: pick between dual-mode controller and split-kind (Function / Package) complexity; couple `@telorun/cli` to AWS specifics (which the project explicitly forbids — S3 lives in `modules/s3`, not in `@telorun/cli`); implement per-target-format logic (zip vs image vs future Lambda Web Adapter vs SnapStart); duplicate functionality `telo install` already provides; handle pnpm symlink quirks differently than the standard `pnpm install --shamefully-hoist`.
- **Pruning is the one capability the manual flow lacks** (the build resource could have pruned the manifest to only resources reachable from the targeted Function, reducing artifact size and cold-start time). Real but optional: a Telo manifest's typical Lambda footprint is small enough that loading-all-handlers doesn't measurably affect cold start. If a real consumer hits the limit, pruning ships then — as either a CLI flag on `telo install` or a future `Lambda.Package` resource — without changing the runtime story.
- **Custom deployment pipelines work as-is.** Teams using Bazel, Pulumi, custom Dockerfiles, or in-house CI tooling don't have to thread through a Telo bundler. They use `telo install` + their existing zip/image machinery.

The deliberate decision is: Telo ships the *runtime* (kinds, controllers, shipped bootstraps, base Docker images, docs); deployment is the user's responsibility, using their existing tooling. If pruning, IAM scaffolding, or other deploy-time automation becomes load-bearing for real users, it lands as additive tooling — not as a v1 prerequisite.

## Changeset

- **New package `@telorun/lambda`** — initial publish (0.1.0). Controllers for `Lambda.Function`, `Lambda.HttpApi`, `Lambda.Sqs`, `Lambda.Direct` (v1). Shared infrastructure under `src/common/`. Two static bootstrap files at the package root: `managed.mjs` and `custom.mjs`, exported as package paths so users `cp node_modules/@telorun/lambda/managed.mjs ./index.mjs`. Adds `@telorun/http-dispatch` as a new workspace dependency at the runtime level for HTTP-shaped kinds (`import { dispatchReturns, dispatchCatches } from "@telorun/http-dispatch"`). No dependency on `@telorun/http-server`. No new dependency on `@telorun/sdk` beyond the existing one.
- **New module manifest `aws/lambda@0.1.0`** published to the Telo registry. Declares the `Lambda.Handler` abstract (`capability: Telo.Invocable`, typed `inputType` / `outputType`) plus concrete handler kinds (`HttpApi`, `Sqs`, `Direct` in v1) plus `Lambda.Function` (`capability: Telo.Service`). HTTP-shaped handler kinds anchor `$defs/Returns` / `$defs/Catches` at `HttpDispatch.Outcomes` via aliased `x-telo-schema-from`; non-HTTP kinds inline bespoke shapes. Adds a `Telo.Import` of `std/http-dispatch@0.4.1`.
- **New base Docker images** `telorun/lambda-managed:0.1.0` (FROM `public.ecr.aws/lambda/nodejs:20`) and `telorun/lambda-custom:0.1.0` (FROM `public.ecr.aws/lambda/provided:al2023`). Each pre-installs `@telorun/kernel`, `@telorun/sdk`, `@telorun/lambda` into `${LAMBDA_TASK_ROOT}/node_modules/` and bakes the right `CMD`. Users' Dockerfiles become 4 `COPY` lines. Separate release workflow (container registries: Docker Hub + AWS ECR Public), versions tracked with `@telorun/lambda`. No npm changeset entry — out-of-band release.
- **Prereq plan changesets** track upstream work: the `@telorun/http-dispatch` initial publish, its `telo.yaml` Library publishing `Outcomes` **and `Request`** (the matcher carrier shared between `http-server.Api.routes[].request` and `Lambda.HttpApi.routes[].request`), the analyzer's aliased-`x-telo-schema-from` extension plus the schema-from-aware context-from resolution that makes `x-telo-context-from: "request/schema"` follow the anchor, and the `@telorun/http-server` patch bump (which picks up `@telorun/http-dispatch` as a workspace dep at both layers and migrates `Api.routes[].request` / `.returns` / `.catches` to the carriers). `@telorun/sdk` does not change.
- **Kernel changes**: none for this plan. The Function uses standard `Telo.Service.init()` + the existing `acquireHold()` machinery; handlers are dispatched via the existing `ctx.invoke(kind, name, inputs)`. No new public kernel API, no new analyzer rule. The bootstrap dispatches to the conventionally-named `Lambda.Function` resource (`"Main"`) via `kernel.invoke("aws/lambda#Function", "Main", payload)`. Multiple `Lambda.Function` resources in one manifest aren't enforced against by the analyzer but aren't part of v1's design (see [Out of scope](#scope)); if a user declares two, the bootstrap will invoke only `Main` and any other Function instances will sit idle (their `init()` runs but `run()` only fires for those in `targets:`).
- **Already-in-tree dependencies** (no changeset entry needed): aliased `x-telo-schema-from` extension (POC landed in earlier work); open `Telo.Abstract` schema; `ctx.createTypeValidator()`.
- **Optional follow-ups, non-blocking:**
  - **Typed-abstracts §3 (subtype conformance check)** — catches third-party `Acme.PubSubFunction extends Lambda.Handler` with deviating `inputType` at `telo check` rather than at first invocation. Tracked in the typed-abstracts plan.
  - **Typed-abstracts §4 (invoke-time validation hook)** — fires automatically since concrete kinds are `Telo.Invocable` and the Function dispatches via `ctx.invoke`. Removes the manual `ctx.createTypeValidator` call in the Function's `init()`. Tracked in the typed-abstracts plan.
  - **`x-telo-context` annotation deduplication** — extend the analyzer so `x-telo-context` blocks themselves can anchor at carrier schemas (rather than requiring inline mirrors of the matcher shape), removing the per-consumer annotation duplication that still lingers between `http-server.Api.routes[]` and `Lambda.HttpApi.routes[]`. The `request/schema` sibling navigation already follows schema-from anchors for the matcher's structural type; this follow-up extends the same treatment to the analyzer-side annotation blocks inside `x-telo-context`. Tracked in the prereq plan.
  - **Manifest pruning** — if a single Lambda artifact's manifest grows large enough that loading unreferenced resources at cold start becomes measurable, ship pruning either as a `telo install --prune-to=<resource>` flag or as a future `Lambda.Package` resource. No active consumer; ship when needed.
