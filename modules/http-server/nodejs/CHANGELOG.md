# @telorun/http-server

## 1.0.0

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

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

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
