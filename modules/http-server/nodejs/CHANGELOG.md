# @telorun/http-server

## 1.0.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@1.0.0
  - @telorun/http-dispatch@1.0.0

## 0.5.1

### Patch Changes

- bfe4967: Add a `ports` declaration to `Telo.Application`. `ports` is a name-keyed map
  (sibling of `variables` / `secrets`) where each entry binds a host env var to
  an inbound port the app listens on: `{ env, protocol?, default? }`, implicitly
  typed as an integer in the 1–65535 range. Values resolve at `kernel.load()` —
  mirroring the variables env-resolution path, with the same
  `ERR_MANIFEST_VALIDATION_FAILED` aggregation — and surface in a new
  `ports.<name>` CEL scope, so a binding resource reads `${{ ports.http }}` from
  a single declared source. A runner or the editor can read the exposed ports
  (and the env var that configures each) before the app starts. Application-only;
  `Telo.Library` does not declare ports.

  Also adds `x-telo-type`, a general analyzer-only value-brand annotation. A
  port's transport brands its value (`tcp → TcpPort`, `udp → UdpPort`) as a
  nominal CEL type, and a resource field can declare which brand it accepts
  (`http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a
  `TcpPort`-branded field is a static analyzer error. Brands are analyzer-only —
  the value flows as a plain integer at runtime, so there is no runtime cost.

  Adds an `UNUSED_DECLARATION` warning: a declared `variables` / `secrets` /
  `ports` entry that no CEL expression references is flagged (a generic,
  table-driven pass across the three namespaces). Application-only — a
  `Telo.Library`'s `variables` / `secrets` are a controller-consumed public
  contract and are not flagged.

## 0.5.0

### Major Changes

- b62e535: Streaming-Invocable convention, format-codec packages, and `Http.Api` `content:` map rewrite.

  **Breaking** (`@telorun/http-server`, `@telorun/ai`):

  - `Http.Api.routes[].returns[]` and `routes[].catches[]` (and the equivalent `Http.Server.notFoundHandler` lists) drop top-level `body` / `schema` in favour of a per-MIME `content:` map. Buffer-mode entries use `content[<mime>].body` / `content[<mime>].schema`; stream-mode entries use `content[<mime>].encoder` (ref to any `Codec.Encoder`). The map key is the canonical `Content-Type` — declaring `Content-Type` in `headers:` is rejected at load time. Multi-key `content:` maps are negotiated against the request's `Accept` header (RFC 9110 §12.5.1). Mismatch → `406 Not Acceptable`.
  - `mode: stream` is forbidden in `catches:` (catches fire pre-stream; no upstream iterable to feed an encoder).
  - Migration: every existing `returns: [..., body: ..., schema: ..., headers: { Content-Type: ... }]` rewrites mechanically to `returns: [..., content: { <mime>: { body, schema } }]`. In-tree manifests (`apps/registry`, `examples/*`, `tests/*`, `benchmarks/*`) migrated.
  - `Ai.TextStream`: `format` field removed; controller no longer encodes the wire — it returns `{ output: Stream<StreamPart> }`. Pair with a format-codec encoder (`Ndjson.Encoder`, `Sse.Encoder`, `PlainText.Encoder`) for HTTP responses or other byte transports. `text-stream-drain-controller.ts` removed (replaced by inline source → encoder → decoder steps).
  - `StreamPart.error` shape changed from native `Error` to `{ message, code?, data? }` so generic encoders can JSON-serialize error frames without bespoke translation.

  **New** (`@telorun/codec`, `@telorun/plain-text-codec`, `@telorun/ndjson-codec`, `@telorun/sse-codec`, `@telorun/octet-codec`):

  - `@telorun/codec` ships the `Encoder` and `Decoder` abstracts (no controllers — pure contracts).
  - Format-codec packages each carry one or both directions: `PlainText.Encoder/.Decoder` (UTF-8 collect + emit), `Ndjson.Encoder` (one JSON record per line), `Sse.Encoder` (Server-Sent Events frames), `Octet.Encoder/.Decoder` (raw bytes pass-through and collect).
  - All encoders implement `invoke({input}): Promise<{output: Stream<Uint8Array>}>` per the streaming-Invocable convention.

  **New** (`@telorun/sdk`):

  - `Stream<T>` class wrapping `AsyncIterable<T>`. Producers wrap their iterables in `new Stream(...)` so the value's constructor is recognized by CEL's runtime type-checker (which rejects unrecognized constructors like `AsyncGenerator` and Node `Readable`). The analyzer registers `Stream` as a CEL object type.

  **Annotation** (`@telorun/kernel`, `@telorun/analyzer`):

  - `x-telo-stream: true` schema annotation on input/output properties marks them as carrying a `Stream<T>`. CEL passes the value through by reference; analyzer's chain validator rejects `.field` / `[index]` access past a stream-marked property. Convention: streaming Invocables put the stream on `input` (inputs) and `output` (result).
  - `Self.<Abstract>` magic alias auto-registered for every Telo.Library/Application — lets concrete kinds in the same library use `extends: Self.<Abstract>` without a self-import that would loop the loader.
  - Analyzer's `buildReferenceFieldMap`, `resolveFieldValues`, `extractInlinesAtPath`, and `injectAtPath` (Phase 5) now recurse into `additionalProperties` via a `{}` path-segment marker. Required for refs nested inside open-keyed maps like `content[<mime>].encoder`.
  - `isInlineResource` widened: bare-kind refs (`{kind: X}` with no `name` and no extra config) are now treated as inline-singleton definitions and Phase 2 extracts them as fresh stateless resources. Previously `{kind: X}` raised `INVALID_REFERENCE` (treated as a malformed named ref). This matches the runtime-side `resolveChildren` semantics already documented for `Run.Throw`-style stateless inlines, and lets `encoder: {kind: Ndjson.Encoder}` work without boilerplate. Manifests that had `{kind: X}` with the (broken) intent of resolving to an existing named resource will now silently extract a fresh resource — extremely unlikely in practice (those refs were already failing analysis), but worth flagging for downstream consumers.

  **Behaviour changes worth flagging** (`@telorun/http-server`):

  - **Single-key `content:` maps now do `Accept` negotiation.** A route declaring only `content: { application/json: ... }` returns `406 Not Acceptable` for `Accept: image/png` — RFC 9110 §15.5.7 compliant. Pre-PR, the legacy top-level `body:` shape ignored `Accept` entirely. To preserve "always send" behaviour, declare `*/*` as an explicit key.
  - **Accept matching ignores media-type parameters** beyond the first `;`. `Accept: text/plain; charset=ascii` matches `content: { 'text/plain; charset=utf-8': ... }`. Q-values are still parsed for ranking; only the matching predicate ignores params. Authors needing parameter-level preference must declare distinct keys per parameter combo.
  - **Load-time validators reject misconfigured `content:` shapes.** `validateContentEntryShape` rejects `body+encoder` together (mutually exclusive), missing `encoder` under `mode: stream`, `body` under `mode: stream`, and `encoder` under `mode: buffer`. Previously some of these slipped through to runtime where they manifested as 500-on-negotiation.
  - **Mid-stream `pipeline()` failures emit `Http.Api.streamFailed` events.** Once `reply.hijack()` runs, mid-stream errors (encoder throws, broken pipe) bypass `catches:` by design (response is committed). They now emit a structured event with `path`, `method`, `status`, `mime`, and the error so operators can observe failures that would otherwise be silent.

  **Other** (`@telorun/http-client`, `@telorun/javascript`):

  - `HttpClient.Request` `mode: stream` returns `{ output: Stream<Uint8Array> }` instead of a bare `Readable` — fits the streaming-Invocable convention, pairs with `Octet.Encoder` for HTTP pass-through.
  - `JS.Script` injects `Stream` into every script's scope (via the second function argument, destructured at the top of the wrapper). User code can `new Stream(asyncGen)` directly.

  **Tests**:

  - New Layer 1 hermetic streaming-contract test (`modules/ai/tests/text-stream-streaming-contract.yaml`) — three sub-targets, byte-exact NDJSON / SSE / PlainText.
  - New Layer 2 live OpenAI streaming smoke (`modules/ai-openai/tests/openai-live-text-stream.yaml`) — env-gated; exercises `Ai.TextStream → Ndjson.Encoder → PlainText.Decoder` against the real provider.
  - New http-server integration test (`modules/http-server/tests/text-stream-via-http.yaml`) — exercises three single-format routes plus a four-format negotiated route with five Accept variants.

### Minor Changes

- 0331069: Widen every "handler-shaped" `x-telo-ref` slot to accept both `telo#Invocable` and `telo#Runnable`, so dual-mode kinds — most commonly `Run.Sequence`, whose controller implements both `run()` and `invoke()` — pass static reference validation without each kind declaring secondary capabilities on its own definition.

  Affected slots:

  - `@telorun/http-server`: `Http.Server.parsers[].parser`, `Http.Server.notFoundHandler.invoke`, `Http.Api.routes[].handler`.
  - `@telorun/mcp-server`: `Mcp.Tools.entries[].handler`, `Mcp.Resources.entries[].handler`, `Mcp.Prompts.entries[].handler`.
  - `@telorun/lambda`: `Lambda.HttpApi.routes[].handler`, `Lambda.Sqs.handler`, `Lambda.Direct.handler`.

  Mechanism: each slot's single `x-telo-ref: "telo#Invocable"` is replaced by an `anyOf:` block carrying both refs. The analyzer's reference-field-map walker already collects refs from `anyOf` branches and `checkKind` early-returns on the first match — so the union semantics are honoured without any analyzer change. AJV value-shape validation continues through the slot's existing `oneOf:` (string vs. object form), unchanged.

  Runtime behaviour is unchanged: the kernel calls whichever method the handler's controller exposes (`.invoke()` or `.run()`). This release just lets the schema admit what the kernel already accepts.

### Patch Changes

- c0129c0: Align local `@telorun/http-server` version with the published `std/http-server@2.0.0` on the registry. The local manifest had diverged onto a parallel `1.x` line; this realigns the version stamp so the next publish bumps from `2.0.0` rather than backwards from `1.1.0`.

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

- Updated dependencies [b62e535]
  - @telorun/sdk@0.12.0

## 0.4.0

### Minor Changes

- 0f80fc5: `Bench.Suite.scenarios[*]` and `Http.Server.notFoundHandler` follow the canonical sibling shape: `invoke:` describes the dispatch target only; `inputs:` carries the call-time arguments as a sibling. The previously-accepted nested `invoke.inputs` form is gone — the benchmark runtime now reads `scenario.inputs` and the http-server runtime now reads `notFoundHandler.inputs`. Five benchmark manifests, one example, and `apps/registry/telo.yaml` migrated to the sibling form.

  Statically validate CEL expressions inside `Telo.Definition` template bodies. The analyzer now registers `self` (typed from the definition's `schema:`) and `inputs` (typed from `inputType:`, falling back to the `extends:`-declared abstract's `inputType:`) as available variables in `resources:` / `invoke:` / `run:` / `provide:` / top-level `inputs:` / top-level `result:` fields, catching typos at load time instead of first invocation.

  Aligns Telo.Definition's template-body shape with how Run.Sequence steps factor dispatch from data: `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (values passed to the target) and `result:` (provide-only post-call mapping) live as top-level siblings on the definition. The previous nested `invoke.inputs` shape is gone — the kernel template controller now reads `definition.inputs`, and `modules/sql-repository/Read` migrates to the sibling form.

  Inside top-level `result:`, the `result` CEL variable is typed from the dispatch target's `outputType:`. The produced top-level `result` value is also AJV-checked against the abstract this definition `extends` (`outputType`); top-level `inputs` is AJV-checked against the dispatch target's `inputType` when declared. Mismatches surface as a new `TEMPLATE_TARGET_MISMATCH` diagnostic.

  Adds two reusable context-annotation forms used by the `Telo.Definition` builtin schema and available to any module that needs the same capabilities:

  - `x-telo-context-from-root: "<path>"` — root-anchored navigation (replace semantics), used to type variables sourced from a top-level field regardless of where the CEL appears.
  - `x-telo-context-from-ref-kind: "<refPath>#<field>"` — reads a kind name from `manifestRoot.<refPath>`, resolves it via the definition registry, and returns that kind's `<field>` schema.

  Schema-extracted contexts are now sorted by scope specificity (longest first) so the first-match-wins resolver picks the most-specific context. No existing module relied on the previous ordering (no overlapping scopes), so this change is observably backward-compatible.

## 0.3.4

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/http-dispatch@0.2.2

## 0.3.3

### Patch Changes

- Updated dependencies [1a3c226]
  - @telorun/http-dispatch@0.2.1

## 0.3.2

### Patch Changes

- 1662260: Address four review findings against the new transport-neutral dispatch package:

  - **Catch schema omits `encoder`.** `CatchEntry.content[mime]` is now typed as `CatchContentEntry` (a `Type.Omit` of `ContentEntry` that drops `encoder`). Catches are buffer-mode only — by the time a catch fires the response is committed pre-stream and there's no upstream iterable to feed an encoder, and `dispatchCatches` never reads it. Previously the TypeBox `CatchEntry` reused `ContentEntry` verbatim, so an `encoder:` on a catch passed validation and was silently ignored. The runtime check now matches the YAML manifest schema in `modules/http-server/telo.yaml` (which already uses `additionalProperties: false` on catch content entries). New `CatchContentEntry` value/type is exported from the package root.
  - **`when:` absence check is `=== undefined`, not truthiness.** `matchEntry` previously treated any falsy `entry.when` as "no predicate," which meant a literal `when: false` was registered as the list's catch-all and could be selected when no other entry matched. The check is now explicit-undefined (matching the precaution already taken in `modules/mcp-server/nodejs/src/outcome.ts`). Generic constraint widened from `when?: string` to `when?: unknown` to reflect the post-CEL value shape.
  - **`when:` schema type is `Unknown`, not `String`.** The TypeBox `ReturnEntry`/`CatchEntry` schemas declared `when` as `Type.Optional(Type.String())`, but the manifest declares `when` as `type: boolean` and the dispatcher receives either a literal boolean (`when: true` / `when: false`) or a CEL `CompiledValue` object (`when: ${{ ... }}`). Both shapes were rejected by the controller's `ctx.validateSchema(resource, HttpApiManifest)` check at load time. Switched to `Type.Optional(Type.Unknown())`; `expandWith` already knows how to evaluate either shape.
  - **Accept negotiation honors media-range specificity.** `matchAcceptForMime` previously took the maximum q-value across all matching ranges, so `Accept: application/json;q=0, */*;q=1` would still serve `application/json` via the wildcard even though the client explicitly excluded it. The negotiator now picks the most specific matching range per RFC 9110 §12.5.1 (exact `type/subtype` > type-wildcard `type/*` > full-wildcard `*/*`), with q=0 on the most specific match correctly excluding the representation. Ties on specificity are broken by highest q.

  `@telorun/http-server` — adds vitest as a devDependency and a `test` script that runs `fastifyReplySink` through `@telorun/http-dispatch/test-utils`'s shared `runSinkContract` harness against a real listening Fastify server (not `app.inject` — light-my-request rejects on the destroyed-stream path that mid-flight errors take, which would hide whether the partial body actually made it to the wire). Drift between the production transport and the dispatcher's contract now surfaces as a contract-test failure rather than a transport-specific bug discovered downstream. No production-code changes in this package.

- 07c881a: Migrate `Api.routes[].request` to anchor at the shared `HttpDispatch.Request/$defs/Matcher` carrier instead of inlining the matcher schema (`method` / `path` / `query` / `body` / `headers`). Field-level annotations (`x-telo-topology-role: matcher`) stay on the consuming side; only the value-shape moves to the carrier.

  Same pattern as the earlier `Server.notFoundHandler.returns` / `.catches` migration to `HttpDispatch.Outcomes`. Zero behavioural change: the carrier reproduces the inline schema field-for-field, and validation goes through the same AJV path. The win is that `Lambda.HttpApi.routes[].request` (landing next) now shares one structural type-shape with http-server — no duplicated matcher schema across transports.

  `HttpDispatch.Request` is required as a dependency — already in `modules/http-dispatch/telo.yaml`'s exports; the existing `Telo.Import` of `HttpDispatch` at the top of `modules/http-server/telo.yaml` covers it.

  When http-dispatch evolves the matcher (adds segment annotations, content-encoding hooks, etc.), http-server picks the change up automatically.

- 1662260: Extract `returns:` / `catches:` rendering into a transport-neutral package.

  `@telorun/http-dispatch` — new package, initial publish. Ships:

  - `ResponseSink` interface — transport-neutral status / header / send / stream sink that the dispatcher writes through. HTTP-shaped transports (Fastify-backed http-server, AWS Lambda, future fetch-API / native http.Server adapters) implement this interface; the dispatcher does not know which one is underneath.
  - `dispatchReturns` / `dispatchCatches` — the CEL `when:` matching, status branching, schema validation, per-MIME content negotiation, buffer/stream mode, encoder-ref-driven streaming, header merging, and error-path fall-through previously inlined in `http-api-controller.ts`. Encoder ref injection stays inside the dispatcher: when a `mode: stream` entry matches, the dispatcher calls `encoder.invoke({ input })` itself and hands the resulting `AsyncIterable<Uint8Array>` to the sink. The sink never sees the encoder, the `Invocable`, or any kernel/SDK type — it only ever takes bytes.
  - TypeBox `ReturnEntry` / `CatchEntry` / `ContentEntry` schemas, re-exportable by any transport that consumes the dispatcher.
  - Runtime validators `validateNoContentTypeHeader` and `validateStreamWhenDoesNotReferenceResult` — defense-in-depth checks the dispatcher runs against the outcome lists.
  - `@telorun/http-dispatch/test-utils` — a `runSinkContract(name, factory)` vitest harness that exercises every method on the sink interface through a known sequence (status-only / empty body; buffered JSON; last-write-wins headers; streamed bytes byte-exact; mid-stream failure routed through `onError`; double-send + setStatus-after-send rejection). Both http-server's Fastify adapter and future transport adapters (Lambda, gRPC, …) feed their factory through this harness so drift between transports surfaces as a contract-test failure, not a transport-specific bug discovered downstream.

  `@telorun/http-server` — controller-internal refactor onto the sink via `@telorun/http-dispatch` (added as a new workspace dependency). New `fastifyReplySink` adapter translates `ResponseSink` calls onto `FastifyReply` (`reply.code` / `reply.header` / `reply.send`; `reply.hijack` + `pipeline(Readable.from(...), reply.raw)` for streams). The local `validateContentEntryShape` runtime check is **deleted** — its rule (body/encoder mutual exclusion; stream-mode requires `encoder` everywhere and forbids `body`; stream-mode requires a non-empty `content:`) moves into `modules/http-server/telo.yaml` as a `oneOf`-on-`mode` discriminated union on `Api.routes[].returns[]` and `Server.notFoundHandler.returns[]`. The `mode` field stays optional; the buffer branch matches when `mode` is absent OR `mode: buffer`, so existing manifests without `mode:` continue to validate unchanged (the kernel's shared AJV config at `ctx.validateSchema` does not enable `useDefaults`). `validateNoContentTypeHeader` and `validateStreamWhenDoesNotReferenceResult` move into `@telorun/http-dispatch` as runtime guards; no observable behaviour change for valid manifests.

  `@telorun/sdk` — no change. The dispatcher is not added to the SDK; the SDK retains its zero-runtime-deps posture. HTTP-shaped dispatch code does not belong in the install tree of every non-HTTP module (sql, ai, assert, console, …), and a future Go or Python SDK should not grow a `dispatch` subpath for symmetry — dispatch is a transport-adapter concern, not a module-author concern.

  Polyglot contract: the YAML schema (`status` / `when` / `mode` / `headers` / `content[mime].{body,schema,encoder,headers}` plus the `x-telo-outcome-list` / `x-telo-catches-for` annotations) is what travels across languages, not this TS package. A future Go / Python implementation re-implements the dispatcher against the same schema, duplicated verbatim into each consuming module's manifest (`@telorun/lambda` lands next).

- Updated dependencies [1662260]
- Updated dependencies [07c881a]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
- Updated dependencies [1662260]
  - @telorun/http-dispatch@0.2.0
  - @telorun/sdk@0.10.0

## 0.3.1

### Patch Changes

- d3ed5a5: Tighten `Http.Api.routes[].request.headers` to declare `additionalProperties: { type: "string" }`. Header values are matched as strings against the incoming request, so the schema now reflects what the runtime actually accepts. The telo editor renders this field as a key/value map editor instead of the JSON Schema designer.

## 0.2.4

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.2.2

### Patch Changes

- 2900b1c: The `host` schema default now matches the controller runtime default (`0.0.0.0`) instead of `localhost`. This keeps forwarded ports reachable when the server is run inside a container; the controller already defaulted to `0.0.0.0` at runtime, so the manifest schema now reflects actual behavior.

## 0.2.1

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.2.0

### Minor Changes

- 353d7e5: feat: invocable errors — structured error channel end-to-end

  Invocables and runnables now have a first-class structured-error channel for domain failures (`InvokeError`), distinct from operational failures (plain `Error` / `RuntimeError`). Route handlers branch on named codes via `catches:`; sequences catch with `error.code` / `error.message` / `error.data` / `error.step` context.

  **SDK** (`@telorun/sdk`)

  - New `InvokeError` class + `isInvokeError` guard. Symbol-based discrimination (`Symbol.for("telo.InvokeError")`) is dual-realm-safe across pnpm hoist splits, registry modules, and future sandbox isolation.
  - `ResourceDefinition.throws`: declared-throw contract (`codes` map, `inherit: true`, `passthrough: true`).
  - `ResourceContext` / `EvaluationContext` gain `invokeResolved(kind, name, instance, inputs)` for callers that already hold a resolved instance.

  **Kernel** (`@telorun/kernel`)

  - Single emission point for invoke-level events: `Invoked` / `InvokeRejected` / `InvokeFailed` / `InvokeRejected.Undeclared`. All call paths (direct invoke, sequence scope path, HTTP route handler) route through the same wrapper.
  - `Telo.Definition.throws:` schema with per-capability restrictions (rule 8: only on Invocable / Runnable).
  - `resolveChildren` now auto-registers bare-kind inline refs when a resource name is supplied without an explicit name on the ref — lets stateless invocables like `Run.Throw` be used inline via `invoke: {kind: Run.Throw}`.

  **Analyzer** (`@telorun/analyzer`)

  - New dataflow resolver (`resolve-throws-union.ts`) for `inherit: true` / `passthrough: true` declarations. Walks `x-telo-step-context` arrays generically, applies `try`/`catch` subtraction, detects cycles, memoises per manifest.
  - New coverage validator (`validate-throws-coverage.ts`) — rules 1/2/4/7 for `catches:` lists. Coverage-proving CEL parser recognises `error.code == 'X'`, disjunctions, and `error.code in [...]`. Typed `error.data.<field>` access against per-code `data:` schemas, with intersection narrowing for disjunctive `when:` clauses.
  - New error codes: `UNDECLARED_THROW_CODE`, `UNCOVERED_THROW_CODE`, `UNBOUNDED_UNION_NEEDS_CATCHALL`, `CATCHALL_NOT_LAST`, `INHERIT_WITHOUT_STEP_CONTEXT`.

  **Run module** (`@telorun/run`)

  - `Run.Sequence` declares `throws: { inherit: true }`. Its effective union is resolved from step invocables at analysis time.
  - New `Run.Throw` invocable: takes `{code, message, data?}` and throws `InvokeError`. Declared with `throws: { passthrough: true }`; the analyzer resolves constant / `error.code`-inside-catch forms at each call site.
  - Sequence `try`/`catch` `error` context gains `data?: unknown` and now branches on `isInvokeError`.

  **HTTP server module** (`@telorun/http-server`) — **breaking**

  - Route-level `response:` is replaced by two channel lists: `returns:` (how to render handler results) and `catches:` (how to render `InvokeError` throws). Applies to both `Http.Api` routes and `Http.Server.notFoundHandler`.
  - Plain `Error` / `RuntimeError` throws skip `catches:` and fall through to Fastify's default 5xx renderer — operational vs. domain failures are now distinct on the wire.
  - `catches:` entries reject `mode: stream` at schema validation (structured errors always render as JSON).
  - Unmatched `returns:` dispatch now throws (surfaces via Fastify's error handler) instead of rendering a silent 500.
  - Every `response:` occurrence across the repo (apps, benchmarks, examples, tests) migrated to `returns:` — no manifest carries the old shape.

  See `sdk/nodejs/plans/invocable-errors.md` for the full design and rollout phasing.

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.8

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.7

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
