# @telorun/lambda

## 1.0.0

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@1.0.0
  - @telorun/http-dispatch@1.0.0

## 0.2.2

### Patch Changes

- 58362c4: Add E2E test suite and rewrite module documentation.

  `modules/lambda/nodejs/tests/e2e/` — testcontainers-driven end-to-end tests against the AWS Lambda Runtime Interface Emulator, covering `Lambda.Direct`, `Lambda.HttpApi`, and `Lambda.Sqs` in both managed (`nodejs24.x`) and custom (`provided.al2023`-style) runtime models. Each test packs the workspace into a fixture, runs `telo install` against the real public registry, bind-mounts the fixture into the AWS Lambda runtime image, and drives the bootstrap through RIE. 12 cases total; CI job in `.github/workflows/e2e.yml`. `testcontainers` added as a devDependency.

  Documentation under `modules/lambda/README.md` and `modules/lambda/docs/*` rewritten as a user guide: removed version pins from prose (only manifests and source: refs keep them), dropped internal-implementation jargon (controller/classifier/dispatcher language replaced with kind names), and removed "v1 surface" / future-plans laundry lists. Added working example manifests under `examples/aws/lambda/` (one per handler kind plus a multi-kind setup), all linked from the module docs.

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/http-dispatch@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1a3c226]
  - @telorun/http-dispatch@0.2.1

## 0.2.0

### Minor Changes

- 07c881a: Initial publish of `@telorun/lambda` (0.1.0). Telo AWS Lambda module — per-source handler kinds dispatched by a `Lambda.Function` `Telo.Service`.

  `modules/lambda/telo.yaml` declares:

  - `Lambda.Handler` — `Telo.Abstract` (`capability: Telo.Invocable`, typed `inputType` of `{event, context}`). Concrete handler kinds `extend: Self.Handler`.
  - `Lambda.HttpApi` — API Gateway HTTP API v2 trigger. `routes[].request` anchors at `HttpDispatch.Request/$defs/Matcher`; `routes[].returns` / `.catches` anchor at `HttpDispatch.Outcomes/$defs/{Returns,Catches}` — full structural parity with `http-server.Api.routes[]`. CORS support inline.
  - `Lambda.Sqs` — SQS queue trigger. Single queue, single handler. Handler receives `event.Records` and may return `{batchItemFailures: [{itemIdentifier}]}` for per-message retry (opt-in via `partialBatchResponse: true`, default).
  - `Lambda.Direct` — catch-all for synchronous SDK invokes, Step Functions tasks, EventBridge Scheduler, internal RPC. `returns:` / `catches:` use simple `when`/`body` matching (no HTTP envelope).
  - `Lambda.Function` — `Telo.Service`. AWS-facing transport. `init()` builds the event-shape classifier from listed handlers (HttpApi → `requestContext.http`; Sqs → `Records[].eventSource === "aws:sqs"`; Direct → catch-all) and rejects duplicate classifier kinds per Function. `run()` (custom-mode only) starts the AWS Runtime API poll loop and `acquireHold()`s the kernel. `invoke({event, context})` classifies, then dispatches via `ctx.invokeResolved`.

  `modules/lambda/nodejs/` (`@telorun/lambda`) ships:

  - `src/common/mode.ts` — `$AWS_LAMBDA_RUNTIME_API` presence detection (managed vs custom).
  - `src/common/runtime-api.ts` — AWS Runtime API helpers (`pollNext` / `postResponse` / `postError` / `postInitError`) for the custom-mode poll loop.
  - `src/common/classifier.ts` — event-shape classifier registry, one entry per concrete handler kind.
  - `src/common/match-http-route.ts` — OpenAPI-style path matcher (`/users/{id}` → `params`).
  - `src/common/lambda-response-sink.ts` — `ResponseSink` adapter that buffers a Lambda HTTP API v2 response envelope (`{statusCode, headers, body, isBase64Encoded}`). Streaming throws (deferred follow-up).
  - `src/function.ts` — `Lambda.Function` controller.
  - `src/http-api.ts` — `Lambda.HttpApi` controller. Walks routes, matches path + method, expands `inputs:` CEL, invokes handler, renders outcome through `@telorun/http-dispatch`'s `dispatchReturns`/`dispatchCatches`. Default 404 for unmatched routes; CORS headers emitted when configured.
  - `src/direct.ts` — `Lambda.Direct` controller. First-match-wins on `when:` with catch-all fallback, optional `code:` constraint on catches.
  - `src/sqs.ts` — `Lambda.Sqs` controller. Passes-through `batchItemFailures` from the handler's return when `partialBatchResponse: true` (default).
  - `managed.mjs` / `custom.mjs` — static bootstraps copied verbatim by users into their Lambda artifact (`cp node_modules/@telorun/lambda/managed.mjs ./index.mjs` for managed; `cp node_modules/@telorun/lambda/custom.mjs ./bootstrap` for custom). Identical across every Lambda manifest — no generated code; the Function name is the literal `"Main"` by convention (edit the file if you need a different name).

  Tests under `modules/lambda/tests/`: `direct-dispatch.yaml`, `http-api-dispatch.yaml`, `sqs-dispatch.yaml` — each exercises Function → handler-kind → JavaScript handler → result with synthetic AWS payloads. All pass against the YAML test runner (`pnpm run test`).

  Docs under `modules/lambda/docs/`: `http-api.md`, `sqs.md`, `direct.md`, `deploying.md`, `cold-starts.md` (plus `README.md` as the overview). Wired into Docusaurus via [pages/sidebars.ts](pages/sidebars.ts).

  Deferred to follow-up PRs (not blocking v1):

  - Response streaming for `Lambda.HttpApi` (`mode: stream` returns). AWS streaming requires either the managed-runtime `awslambda.streamifyResponse` wrapper or custom-runtime chunked POSTs against the Runtime API; the sink currently throws on stream attempts with a clear diagnostic.
  - Additional handler kinds (`Lambda.RestApi`, `Lambda.FunctionUrl`, `Lambda.EventBridge`, `Lambda.S3`, `Lambda.Schedule`).
  - Base Docker images (`telorun/lambda-managed`, `telorun/lambda-custom`) — out-of-band release alongside `@telorun/lambda`.
  - RIE-driven E2E tests for both deployment modes.
  - SnapStart (semantics interact with controller state).
  - X-Ray tracing — gated on `@telorun/observability-aws`.

  Adds `@telorun/http-dispatch` and `@telorun/sdk` as workspace deps; `@telorun/kernel` is a devDependency (used only by the bootstrap files at user-runtime, not by the controllers). No new kernel API required.

### Patch Changes

- Updated dependencies [1662260]
- Updated dependencies [07c881a]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
- Updated dependencies [1662260]
  - @telorun/http-dispatch@0.2.0
  - @telorun/sdk@0.10.0
