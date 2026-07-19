# @telorun/lambda

## 0.6.0

### Minor Changes

- 2395a4a: Make network failures actionable instead of `fetch failed`.

  `fetch` rejects with an opaque `TypeError: fetch failed` for DNS, connection
  refusal, and TLS alike; the real cause (`ENOTFOUND`, `ECONNREFUSED`, …) sits on
  `error.cause`, which nothing in the repo read. A misconfigured host surfaced as
  `INTERNAL_ERROR: fetch failed` with nothing to act on — no host, no reason, no
  indication of which manifest field was wrong.

  `fetchOrThrow` in `@telorun/sdk` wraps a transport failure as an `InvokeError`
  with code `ERR_NETWORK_UNREACHABLE`, carrying structured `data` — `operation`,
  `url`, `host`, `port`, `cause`, the underlying `detail`, and the `resource` +
  `setting` to change — plus a default message composed from them. A non-OK
  response is returned untouched — a status code is a reply the caller interprets,
  often from the provider's own error body — so it drops into existing call sites
  without changing status handling. Cancellation is re-thrown as-is.

  Every part is structured, including the actionable one: a call site passes
  `resource` (the instance's `metadata.name`) and `setting` (`baseUrl`) as bare
  identifiers, and the sentence is composed in one place. Prose at the call site
  would be exactly what another language's SDK has to retype and keep in sync,
  whereas `cause: "ENOTFOUND"` and `setting: "baseUrl"` are the same symbols
  everywhere — so a kernel-side renderer can later format from `data` without any
  SDK changing.

  Wrapping never loses what was thrown: the original error is preserved as
  `cause` (`InvokeError` gained an optional `{ cause }`), its message is kept in
  `data.detail`, and for a code the mapping does not recognise that message is
  appended to the rendered text — so an unmapped code reads as strictly more than
  the raw `fetch failed` it replaces, never less.

  Also fixes a live misclassification in `Http.Request`: `mapNetworkError`
  selected its error kind by substring-matching the message, but the message is
  always the literal `"fetch failed"`, so `enotfound`/`ssl` never matched and every
  network failure — DNS and TLS included — was reported as `CONNECTION_REFUSED`.
  It now classifies on the cause chain's code, via the exported `networkCauseCode`.
  `Mcp.Client` had the same opaque-message problem in its transport error and is
  fixed the same way.

### Patch Changes

- @telorun/http-dispatch@0.4.1

## 0.5.1

### Patch Changes

- 4e5d861: Guard `process.env` against controllers bypassing declared bindings. Once the
  kernel boots it replaces the global `process.env` with a guardrail Proxy whose
  denied set is **derived from the manifest**: exactly the host env-var names the
  root Application binds via `variables` / `secrets` / `ports` (their `env:` keys).
  Such a key reads back `undefined` (and `'FOO' in process.env` / enumeration see
  nothing) even when the variable is set, and the first read of each logs a
  warning. Controllers must read those through `ctx.env` (the sanctioned snapshot
  the kernel threads in) or, preferably, the declared `variables` / `secrets`.

  Every **other** key passes through transparently (real value, no warning) — the
  kernel carries no allowlist of vendor env conventions. A bundled SDK reading its
  own configuration (`NODE_ENV`, `AWS_PROFILE` / `AWS_*` / `SMITHY_*`, `~/.aws`
  path lookups, `BUN_*`, the AWS Lambda execution-environment context, …) is
  undeclared, so it is untouched. The guarantee is narrow and honest: a controller
  cannot bypass a _declared_ binding by reading its raw env var. This is a
  guardrail, not an isolation boundary — in-process controllers can still reach the
  OS environment by other means; the `process.env` property is left non-writable so
  a casual `process.env = {…}` cannot drop it.

  The denied set is process-global and additive: several `Kernel` instances can
  boot in one process (the test suite runs child kernels in-process), and each
  unions its declared keys into the shared set even after the Proxy is installed.

  The kernel's own `TELO_*` / cache reads and its subprocess spawns (`npm`,
  `cargo`/`rustc`) use the real environment captured before the lock — shared on
  `globalThis` so a second in-process `@telorun/kernel` copy (the test suite loads
  its own to spawn child kernels) recovers it even when loaded after the lock,
  rather than capturing the Proxy and handing child spawns an env missing the
  denied keys. `analyzeOnly` loads never boot, so `telo check` / the editor / the
  analyzer are unaffected.

  The stdlib controllers that read host env use `ctx.env`: `config`
  (`Config.EnvironmentVariableStore`), `lambda` (Lambda mode detection),
  `mcp-client` (the spawned stdio child's environment), and `test` (the env the
  suite forwards to each spawned test kernel). These keep their existing behaviour
  and remain compatible with older kernels.

## 0.5.0

### Minor Changes

- 5331205: Add cooperative invoke cancellation via an out-of-band `InvokeContext`.

  Every `invoke(inputs, ctx?)` now receives a second argument carrying a read-only
  cancellation token (`ctx.cancellation`): poll `isCancelled`, subscribe via
  `onCancelled`, bail with `throwIfCancelled`, or hand its `signal` to a Web API.
  The SDK exposes the source/token split (`createCancellationSource`,
  `CancellationSource`/`CancellationToken`), a never-cancellable sentinel, and the
  `isCancellationError` helper. Deadlines are scheduled cancellation
  (`source.cancelAt(epochMs)` / `cancelAfter(ms)`).

  The kernel mints one cancellation scope per invocation tree (inherited by nested
  invokes via a kernel-internal `AsyncLocalStorage`, always passed to controllers
  as the explicit argument), refuses a not-yet-dispatched invoke whose tree was
  cancelled with `ERR_INVOKE_CANCELLED`, and emits a scoped `InvokeCancelled`
  event. `Kernel.invoke(ref, inputs, opts?)` accepts `{ signal, deadlineAt }`.
  Sources are allocated lazily, so invokes that never touch cancellation pay no
  extra allocation.

  The boot `targets` run is also cancellable: `Runnable.run(ctx?)` now receives
  the token, `Kernel.cancel(reason?)` cancels the boot scope, and the CLI's
  SIGINT/SIGTERM handler calls it so Ctrl-C cooperatively stops honoring targets
  and in-flight invoke trees (then unblocks graceful exit via `forceIdle`).

  Honoring leaves: `Ai.Text` / `Ai.TextStream` / `Ai.Agent` forward the token's
  signal into the model (aborting a live LLM stream on cancel); `http-client`
  merges it with its request timeout. Triggers: `http-server` cancels on client
  disconnect and returns 499; `lambda` arms cancellation at the AWS deadline.

### Patch Changes

- @telorun/http-dispatch@0.4.1

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

- Updated dependencies [adc248b]
  - @telorun/http-dispatch@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0
  - @telorun/http-dispatch@0.4.0

## 0.3.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.3.0

### Minor Changes

- 0331069: Widen every "handler-shaped" `x-telo-ref` slot to accept both `telo#Invocable` and `telo#Runnable`, so dual-mode kinds — most commonly `Run.Sequence`, whose controller implements both `run()` and `invoke()` — pass static reference validation without each kind declaring secondary capabilities on its own definition.

  Affected slots:

  - `@telorun/http-server`: `Http.Server.parsers[].parser`, `Http.Server.notFoundHandler.invoke`, `Http.Api.routes[].handler`.
  - `@telorun/mcp-server`: `Mcp.Tools.entries[].handler`, `Mcp.Resources.entries[].handler`, `Mcp.Prompts.entries[].handler`.
  - `@telorun/lambda`: `Lambda.HttpApi.routes[].handler`, `Lambda.Sqs.handler`, `Lambda.Direct.handler`.

  Mechanism: each slot's single `x-telo-ref: "telo#Invocable"` is replaced by an `anyOf:` block carrying both refs. The analyzer's reference-field-map walker already collects refs from `anyOf` branches and `checkKind` early-returns on the first match — so the union semantics are honoured without any analyzer change. AJV value-shape validation continues through the slot's existing `oneOf:` (string vs. object form), unchanged.

  Runtime behaviour is unchanged: the kernel calls whichever method the handler's controller exposes (`.invoke()` or `.run()`). This release just lets the schema admit what the kernel already accepts.

### Patch Changes

- 3e3f134: Migrate Docker image publishing to a per-runtime-repo scheme with variant + multi-arch tagging.

  **Kernel image** moves from `telorun/telo` to `telorun/node`, reserving the namespace for future polyglot kernels (`telorun/rust`, `telorun/go`). The previous monolithic image is split into four variants per release:

  - `telorun/node:<v>` / `telorun/node:<v>-slim` — lean variants, no Rust toolchain.
  - `telorun/node:<v>-rust-<rust-version>` / `telorun/node:<v>-rust-<rust-version>-slim` — opt-in Rust toolchain layered on top.

  Rolling tags (`latest`, `<major>`, `<major>.<minor>`) compose with the variant suffixes. Release tags are immutable; pin to exact versions for reproducible builds. Release images are multi-arch (`linux/amd64` + `linux/arm64`). Dev tags (`sha-<short>-*`) appear on every main-branch push, slim variants only.

  **Lambda base images** newly published as `telorun/lambda-node-managed:<lambda-version>` (managed nodejs runtime) and `telorun/lambda-node-custom:<lambda-version>` (custom `provided.al2023` runtime). Both pre-install `@telorun/lambda` and its workspace deps at `${LAMBDA_TASK_ROOT}`; user images derive from them and add only their manifest + install root. The `-node-` segment in the repo name reserves the namespace for future `telorun/lambda-rust-*` images.

  **CI**: docker publishing now runs from `.github/workflows/publish-docker.yml`, called by `publish.yml` after `changesets/action` actually publishes packages. Per-image gating reads `outputs.publishedPackages` so kernel images rebuild only when `@telorun/cli` bumps and lambda images only when `@telorun/lambda` bumps.

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
  - @telorun/sdk@0.12.0
  - @telorun/http-dispatch@0.3.0

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
