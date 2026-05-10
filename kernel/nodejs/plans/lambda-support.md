# Plan — Out-of-the-box AWS Lambda support

Goal: ship a path where a user with a Telo manifest can deploy it as an AWS Lambda function and have invocations route to a declared `Telo.Invocable` without writing glue code. Both AWS Lambda runtime models — managed Node (`nodejs20.x`) and custom runtime (`provided.al2023` / container image with our own bootstrap) — are first-class. The plan is structured in layers: kernel primitives first (generic, useful beyond Lambda), then a Lambda adapter that supports both runtime modes, then packaging and deployment ergonomics.

Today's gap (from investigating [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts), [`cli/nodejs/src/commands/run.ts`](../../../cli/nodejs/src/commands/run.ts), and the existing programmatic-bootstrap plan): the runtime can already invoke `Telo.Invocable` resources (`ResourceContext.invoke` at [`resource-context.ts:150`](../src/resource-context.ts#L150)), pre-install controllers into `.telo/npm/` (`telo install`), and scope per-call state via `x-telo-scope` + `ScopeHandle.run()` — but `Kernel.start()` is a single monolithic call that does init→targets→idle-wait→teardown, with no public way to "boot once, invoke many." The managed runtime mode needs that split; the custom runtime mode reuses the existing `Telo.Service` pattern (mirroring `Http.Server`) and doesn't strictly need the split, but inherits it for free.

## Scope

In-scope:

- **Managed Node runtime** (`nodejs20.x`, zip artifact). AWS provides the outer loop; our adapter dispatches per `exports.handler` invocation.
- **Custom runtime** (`provided.al2023` or container image). Our bootstrap owns the process; a `Telo.Service` polls `$AWS_LAMBDA_RUNTIME_API` and dispatches.
- Event sources: API Gateway HTTP API (v2 payload), API Gateway REST (v1), Lambda Function URLs, direct invoke, SQS, EventBridge, S3. SNS/Kinesis are easy follow-ups once the dispatch table exists.
- Response streaming (Lambda's `awslambda.streamifyResponse` under managed; chunked HTTP under custom) for streaming `Invocable`s that produce `Stream<T>` outputs.
- Graceful teardown on Lambda runtime shutdown (`SIGTERM` from the runtime's freeze/destroy cycle; additionally the in-flight-poll drain under custom mode).

Out of scope (deferred):

- Other FaaS targets (GCP Cloud Functions, Cloudflare Workers, Vercel) — the adapter shape generalizes but only Lambda ships here.
- ALB target group event source.
- Lambda@Edge / CloudFront Functions (constrained runtime, different shape).
- Lambda Extensions API beyond the basic `SIGTERM` path.
- SnapStart — works in principle under managed runtime, but snapshot-restore semantics interact with controller state (e.g. open DB connections) and need a separate think.

## Layer 1 — Kernel primitives

These are generic — they unlock managed-mode Lambda and also fix the embedding story for tests, IDE previews, and any other warm-invoke embedder. Custom mode doesn't strictly require them, but inherits them for free since `start()` becomes a convenience over the split methods.

### Split `Kernel.start()` into `boot()`, `runTargets()`, `teardown()`

[`kernel.ts:295-348`](../src/kernel.ts#L295-L348) today is one method:

```
register controllers → analyzer.prepare → setInitOrder → initializeResources
  → Kernel.Initialized → Kernel.Starting → runTargets → Kernel.Started
  → waitForIdle → [finally] teardownResources → Kernel.Stopped
```

Refactor into three public methods with the same observable order. New shape:

- `async boot(): Promise<void>` — controller register, analyzer prepare, init order, `initializeResources`, emits `Kernel.Initialized`. Does **not** run targets. Does **not** wait. Returns when every resource is initialized and the kernel is ready to accept invokes.
- `async runTargets(): Promise<void>` — emits `Kernel.Starting`, calls `rootContext.runTargets()`, emits `Kernel.Started`. Throws if `boot()` hasn't run.
- `async teardown(): Promise<void>` — emits `Kernel.Stopping`, calls `rootContext.teardownResources()`, emits `Kernel.Stopped`. Idempotent on second call (no-op after first).
- `start()` becomes a thin convenience: `await this.boot(); await this.runTargets(); try { await this.waitForIdle(); } finally { await this.teardown(); }`. The CLI and test runner keep working unchanged.

Why a three-way split, not just `boot()`+`teardown()`: the managed-runtime Lambda adapter calls `boot()` only (no targets at warm-start). The custom-runtime adapter calls `start()` (targets run; the `Lambda.Service` is a target that owns the poll loop). The CLI and tests stay on `start()`. Each path picks the right entry without flag-passing.

Touch points:

- [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts) — refactor `start()`, add `boot`/`runTargets`/`teardown`. Move the `try/finally` to `start()` only.
- [`sdk/nodejs/src/types.ts`](../../../sdk/nodejs/src/types.ts) — extend the `Kernel` interface.
- [`cli/nodejs/src/commands/run.ts`](../../../cli/nodejs/src/commands/run.ts) — no change; still calls `start()`.
- [`modules/test/nodejs/src/suite.ts`](../../../modules/test/nodejs/src/suite.ts) — no change; still `load` → `start`.

### Public `Kernel.invoke(ref, inputs)`

Today `ResourceContext.invoke(kind, name, inputs)` exists and works ([`resource-context.ts:150`](../src/resource-context.ts#L150)) but no public surface lets an external embedder call it. Add:

```ts
class Kernel {
  async invoke<TInputs, TOutput>(
    ref: string | { kind: string; name: string },
    inputs: TInputs,
  ): Promise<TOutput>;
}
```

`ref` accepts either a parsed `{kind, name}` or the dot-form string `"My.Handler"` for ergonomics — split on the last `.`. Resolves through the root `ModuleContext` (which is what `ResourceContextImpl.invoke` already does). Throws if `boot()` hasn't completed; throws if the resource isn't a `Telo.Invocable`.

Used directly by the managed-mode adapter bootstrap. Used indirectly by the custom-mode `Lambda.Service` via `ctx.invoke` (which it already has). Also unblocks non-Lambda embedders that want a programmatic invoke surface.

Touch points:

- [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts) — delegate to `rootContext.invoke`. Five lines.
- [`sdk/nodejs/src/types.ts`](../../../sdk/nodejs/src/types.ts) — interface addition.

### Per-invocation `x-telo-scope` entry from outside the kernel

`ScopeHandle.run(fn)` ([`evaluation-context.ts:353`](../src/evaluation-context.ts#L353)) is the primitive for "fresh resources per call." Both adapter modes use the same approach: the `Lambda.Function` resource declares a `handlers` field marked `x-telo-scope: /handlers/*` (mirroring [`modules/run/telo.yaml:223`](../../../modules/run/telo.yaml#L223)'s pattern). The kernel hands the controller a `ScopeHandle` at init; the controller calls `scope.run(...)` per event before invoking the handler.

No kernel-API change needed — this falls out of the existing scope plumbing for both managed and custom modes, because both express the adapter as a Telo resource.

### Relation to the existing programmatic-bootstrap plan

The [in-memory bootstrap plan](./programmatic-kernel-bootstrap.md) lands first (it doesn't block this work but its `MemorySource` becomes useful for tests and for container-image flows where the manifest is baked into the image). The kernel changes in *this* plan layer on top:

- Programmatic plan renames `loadFromConfig` → `load`, makes `sources` required, introduces `MemorySource`. This plan inherits the renamed `load` method.
- Per-instance `moduleCache` from the programmatic plan is a prerequisite for any future Lambda extension / multi-tenant scenarios (out of scope, but the cache change is the right shape).

If the programmatic plan hasn't landed by the time Layer 1 is implemented, do these changes against the current `loadFromConfig` and have the programmatic plan rebase on top — Layer 1's changes are orthogonal to the rename.

### Changeset for Layer 1

Single minor bump on:

- `@telorun/kernel` — `boot`/`runTargets`/`teardown`/`invoke` additions; `start()` becomes a convenience method (no break).
- `@telorun/sdk` — interface additions.

No break, no migration. Existing `start()` callers keep working.

## Layer 2 — Lambda adapter

A new published module `modules/lambda` declaring Lambda-specific resource kinds. The controller package is `@telorun/lambda` published under `modules/lambda/nodejs`. The manifest stays the single source of truth for both runtime modes.

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
metadata:
  name: Function
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
              statusFrom: { type: string }   # CEL path on the invocable's output
              headersFrom: { type: string }
              bodyFrom: { type: string }
              streaming: { type: boolean }
  required: [handlers]
```

User manifest:

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
runtime: managed   # or custom
handlers:
  - eventSource: apiGatewayHttp
    match: { method: POST, path: /webhook }
    handler: { kind: My.Webhook }
  - eventSource: sqs
    match: { queueName: orders }
    handler: { kind: My.OrderProcessor }
```

`capability: Telo.Service` for both modes — under custom mode the service actively polls; under managed mode the service just registers a dispatch table the outer bootstrap consults. Same `init()` returns immediately in managed mode (nothing to poll, AWS pulls events); under custom mode `init()` registers the poll loop on the event loop and `acquireHold()`s the kernel.

### Controller dispatch (shared between modes)

The `@telorun/lambda` controller exports a `LambdaFunction` class that implements `Telo.Service`. Both modes share:

- **Event classification** — input event → matched `handlers[i]` entry. API Gateway events keyed by `httpMethod + routeKey`; SQS by source ARN; EventBridge by `source` + `detail-type`; direct by handler-name discriminator passed in the payload.
- **Input mapping** — event payload normalized into the `{ request: {...} }` shape Telo handlers already expect (mirrors [`http-server-controller.ts:200-214`](../../../modules/http-server/nodejs/src/http-server-controller.ts#L200-L214)).
- **Scope entry** — `scope.run(s => s.invoke(handler.kind, handler.name, inputs))`.
- **Output mapping** — invocable result → AWS response shape via the declared CEL paths, with sensible defaults.
- **Error mapping** — `InvokeError` → status from `catches` (reuse `dispatchCatches` from [`http-server-controller.ts`](../../../modules/http-server/nodejs/src/http-server-controller.ts), extracted to a shared helper); unhandled throw → 500 with stack in CloudWatch, message in body.

### Mode-specific lifecycle

| concern | managed (`runtime: managed`) | custom (`runtime: custom`) |
|---|---|---|
| outer loop | AWS-provided; `index.mjs` exports `handler` | our `bootstrap` polls `$AWS_LAMBDA_RUNTIME_API` |
| kernel boot | bootstrap shim calls `kernel.boot()` at module load | `kernel.start()` runs to completion of init; service holds kernel alive |
| dispatch trigger | `exports.handler` called per event by AWS | service's poll loop receives event |
| dispatch site | bootstrap looks up controller's dispatch fn, calls it | service's poll loop calls its own dispatch fn directly |
| target services | `runTargets()` skipped (no targets fire at warm-start) | `runTargets()` runs normally; `Lambda.Service` is itself a target |
| teardown | `SIGTERM` → `kernel.teardown()` | `SIGTERM` → drain in-flight poll → `kernel.teardown()` |
| keepalive | none needed (AWS owns lifecycle) | `acquireHold()` in `init()` |

### Bootstrap entry points

Both modes ship a small bootstrap file produced by `telo bundle` (Layer 3). The user never writes these.

**Managed mode** — `index.mjs`:

```js
import { Kernel, LocalFileSource } from "@telorun/kernel";
import { getDispatcher } from "@telorun/lambda/managed";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");
await kernel.boot();
const dispatch = getDispatcher(kernel);
process.once("SIGTERM", () => kernel.teardown());
export const handler = dispatch;
```

`getDispatcher(kernel)` finds the single `Lambda.Function` resource in the boot graph, returns its `dispatch(event, context)` method.

**Custom mode** — `bootstrap` (executable):

```js
#!/usr/bin/env node
import { Kernel, LocalFileSource } from "@telorun/kernel";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");
process.once("SIGTERM", () => kernel.teardown());
await kernel.start(); // Lambda.Service inside polls and holds the kernel alive
```

Both entry points are <20 lines and don't grow with feature additions — all the smarts live in the `Lambda.Function` controller.

### Changeset for Layer 2

- New package `@telorun/lambda` — initial publish (0.1.0). Subpath exports `./managed` and `./custom` keep mode-specific dependencies tree-shakable.
- `modules/lambda/telo.yaml` ships in the registry alongside.

## Layer 3 — Packaging

Lambda artifacts have specific layout requirements. The user shouldn't have to learn them.

### `telo bundle <manifest>` CLI command

New command in [`cli/nodejs/src/commands/`](../../../cli/nodejs/src/commands/). Flags:

- `--runtime managed | custom` (default `managed`).
- `--target zip | image` (default `zip`).
- `--out <dir>` (default `./dist`).

Steps shared across modes:

1. **Load + analyze** the manifest using the same loader the existing `install`/`check`/`publish` commands use ([`commands/install.ts:55-67`](../../../cli/nodejs/src/commands/install.ts#L55-L67)). Fail on analysis errors.
2. **Validate target** — manifest must have exactly one `Lambda.Function` resource; its `runtime` field must match `--runtime` (or be unset, in which case the flag fills it in).
3. **Inline includes + canonicalize relative imports** — reuse `expandAndInlineIncludes` and `canonicalizeRelativeImports` from [`commands/publish.ts`](../../../cli/nodejs/src/commands/publish.ts) (extract to a shared `cli/nodejs/src/bundling.ts` first).
4. **Pre-install controllers** — run the same flow as `telo install` ([`commands/install.ts`](../../../cli/nodejs/src/commands/install.ts)) to populate `<out>/.telo/npm/`. Hermetic — no registry calls at Lambda boot.
5. **Bundle kernel + sdk + adapter** — copy resolved `node_modules` subtree for `@telorun/kernel`, `@telorun/sdk`, `@telorun/analyzer`, `@telorun/lambda`, and every controller package referenced by the manifest.

Mode-specific finalization:

- **`--runtime managed --target zip`** — emit `<out>/index.mjs` (managed bootstrap above). Output zips into a Lambda-uploadable archive. Lambda config: `Runtime=nodejs20.x`, `Handler=index.handler`.
- **`--runtime custom --target zip`** — emit `<out>/bootstrap` (custom bootstrap above), set executable bit. Output zips. Lambda config: `Runtime=provided.al2023`, `Handler` ignored. Includes Node.js binary (~50 MB) since `provided.al2023` doesn't ship one.
- **`--target image`** (either runtime) — emit a `Dockerfile` based on the appropriate Telo Lambda base image (Layer 3.1), `COPY` the bundle output. User builds + pushes to ECR.

### 3.1 — Lambda base images

For container-image deployments, provide two base images so users don't repackage Node + kernel themselves:

- `telorun/lambda-managed:<version>` — `FROM public.ecr.aws/lambda/nodejs:20`, pre-installs `@telorun/kernel`, `@telorun/sdk`, `@telorun/analyzer`, `@telorun/lambda` into `${LAMBDA_TASK_ROOT}/node_modules/`. `CMD ["index.handler"]`.
- `telorun/lambda-custom:<version>` — `FROM public.ecr.aws/lambda/provided:al2023`, ships a Node.js binary plus the same kernel packages, with `bootstrap` as the entry point.

Both images published from `apps/lambda-base-image/managed/` and `apps/lambda-base-image/custom/`, mirroring the existing [`telorun/telo` docker image](../../../apps/docker-runner). Separate release workflow, no npm changeset (container registry only).

### Changeset for Layer 3

- `@telorun/cli` — minor (new `bundle` command).
- New container artifacts `telorun/lambda-managed`, `telorun/lambda-custom` — separate release.

## Layer 4 — Lambda-runtime concerns

### Cold-start budget

Lambda gives ~10 s for module init (managed) or for the first poll-request (custom). Concrete moves apply to both modes:

- **Skip `runTargets()` under managed** — already baked into the bootstrap; only `boot()` runs at module load. Targets are a `telo run` concept.
- **Defer slow init via `x-telo-scope`** — heavy resources (DB pools, AI model loads) scope to the handler so they initialize per-first-invocation rather than at boot. Already supported; document the pattern.
- **No registry calls at boot** — guaranteed by step 4 of `telo bundle` (`.telo/npm/` is hermetic). Adapter asserts `TELO_REGISTRY_URL` is unset or unused at boot; fails fast if it would be consulted.
- **Measure** — adapter emits a `Kernel.Booted` event with a duration. CloudWatch dashboards in the docs.

### Graceful teardown

Both modes wire `process.once("SIGTERM", () => kernel.teardown())` in the bootstrap. `kernel.teardown()` is idempotent (per Layer 1).

Custom mode additionally drains in-flight polling: when `SIGTERM` arrives, cancel the next `GET /runtime/invocation/next` (don't long-poll into shutdown), let any in-flight `kernel.invoke(...)` complete, then teardown. The drain is a `Promise.race` inside the `Lambda.Service` poll loop.

### Response shape mapping

API Gateway HTTP API (payload v2) expects:

```json
{ "statusCode": 200, "headers": {...}, "body": "...", "isBase64Encoded": false }
```

The controller maps invocable output → response using the `response.statusFrom` / `headersFrom` / `bodyFrom` CEL paths declared per-handler. Defaults if omitted: `statusCode=200`, `headers={}`, `body=JSON.stringify(output)`, `isBase64Encoded=false`.

Streaming (Invocables whose output type has `x-telo-stream: true`):

- **Managed mode** — `awslambda.streamifyResponse` wraps the handler; the `Stream<T>` is piped into the Lambda response stream.
- **Custom mode** — POST to `/runtime/invocation/{requestId}/response` with `Transfer-Encoding: chunked` and stream the body. AWS supports this on `provided.al2023`.

The controller detects the streaming case by inspecting the resolved invocable's declared output type — identical logic across modes; only the sink differs.

### Error mapping

Three categories, identical across modes:

1. **Manifest analysis failure at boot** — kernel throws during `boot()` (or `start()` in custom mode); Lambda init fails; CloudWatch shows the `RuntimeDiagnostic` array.
2. **`InvokeError` from a handler** — controller maps to HTTP status via the invocable's `catches` block (reuse `dispatchCatches`).
3. **Unhandled controller throw** — 500 response, error message in `body.error.message`, stack to CloudWatch.

### Logging

Lambda captures `console.log` / `console.error` to CloudWatch. The kernel already routes runtime events through `stdout`/`stderr` configurable on `KernelOptions`; the bootstrap sets them to `process.stdout`/`process.stderr`. Structured JSON falls out the bottom.

X-Ray tracing: deferred. Add when an `@telorun/observability-aws` module exists.

## Layer 5 — Testing

Three test surfaces:

1. **Layer 1 kernel changes** — `kernel/nodejs/tests/lifecycle.test.ts` (vitest, wired in by the programmatic-bootstrap plan). Asserts `boot()` returns before targets run, `invoke()` works after `boot()`, `teardown()` is idempotent, `start()` still produces the same event order.
2. **Adapter unit tests** — `modules/lambda/nodejs/tests/*.test.ts` (vitest). Feed fake AWS event payloads (one per supported source), assert correct invocable dispatch and response shape. Tests both managed-mode `getDispatcher` and custom-mode poll loop (the latter against a mock `AWS_LAMBDA_RUNTIME_API` http server).
3. **End-to-end Lambda test** — under `modules/lambda/nodejs/tests/e2e.test.ts`, drive both modes against [aws-lambda-runtime-interface-emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator) (RIE). RIE emulates the managed runtime natively; for custom mode, we point `bootstrap` at RIE's exposed endpoint and verify it polls correctly. Both run in CI without real AWS credentials.

### Test placement note

The repo's `tests/` directory is YAML manifests today ([`tests/`](../../../tests/)). The Lambda E2E tests use vitest (RIE driving, response assertions — not expressible in YAML) and live under `modules/lambda/nodejs/tests/`, alongside the package's unit tests. Wire into CI as a separate per-package vitest job.

## Layer 6 — Documentation

- `modules/lambda/docs/overview.md` — entry-point doc, mode-comparison table, when to pick which runtime.
- `modules/lambda/docs/function.md` — `Lambda.Function` schema reference (handler shape, event-source semantics, response mapping).
- `modules/lambda/docs/packaging.md` — `telo bundle` walkthrough, zip vs image trade-offs, IAM policy template, SAM/CDK examples for both modes.
- `modules/lambda/docs/cold-starts.md` — budget guidance, `x-telo-scope` patterns, when to switch to container image, managed vs custom artifact-size trade-off.

Add file paths to [`pages/docusaurus.config.ts`](../../../pages/docusaurus.config.ts) and entries in [`pages/sidebars.ts`](../../../pages/sidebars.ts). Each markdown file gets `sidebar_label` frontmatter.

## Implementation order

Each step lands as a separate PR with its own changeset:

1. Programmatic-bootstrap plan (already filed, not strictly blocking but useful for tests).
2. **Layer 1** kernel split + public `invoke` — small, additive, no breaks.
3. **Layer 2** module skeleton + controller, **managed mode only**, **direct + apiGatewayHttp** event sources only. Smallest path to a working Lambda.
4. **Layer 2** custom mode added — reuses ~all the controller code; only the lifecycle wrapper differs.
5. **Layer 3** `telo bundle --runtime managed --target zip` — minimum viable bundler.
6. **Layer 3** remaining `--runtime` / `--target` combinations + base images.
7. **Layer 4** runtime concerns — teardown drain, streaming, response/error mapping. Lands incrementally alongside Layer 2.
8. **Layer 2** remaining event sources (sqs, eventBridge, s3, apiGatewayRest, functionUrl).
9. **Layer 5** E2E tests against RIE — gates the 0.1.0 release.
10. **Layer 6** docs.

## Open architectural questions

Per CLAUDE.md, these need a decision before code lands. Listing here so they're not lost:

- **Container base image registry**: Docker Hub (mirrors existing `telorun/telo`) vs. AWS ECR Public (lower egress for AWS users). Could publish to both.
- **Event-source coverage in v1**: minimum viable is direct + apiGatewayHttp + sqs. Anything else is gravy. User confirms the bar.
- **Streaming responses in v1**: cheap to wire because `Stream<T>` is already in the SDK; default in unless there's a reason to defer.
- **Default `runtime` in the schema**: `managed` (smaller artifact, more familiar to AWS users) vs `custom` (cleaner mental model, matches `Http.Server`). Currently defaulted to `managed`.
