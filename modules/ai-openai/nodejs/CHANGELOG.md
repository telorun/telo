# @telorun/ai-openai

## 0.3.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

- Updated dependencies [adc248b]
  - @telorun/ai@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0
  - @telorun/ai@0.3.0

## 0.2.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.
- Updated dependencies [4c1a50b]
  - @telorun/ai@0.2.1

## 0.2.0

### Minor Changes

- 80c3c03: Initial release of `@telorun/ai` and `@telorun/ai-openai`.

  `@telorun/ai` ships:

  - `Ai.Model` — `Telo.Abstract` declaring the LLM provider contract (`invoke` + `stream` methods on the runtime instance).
  - `Ai.Completion` — `Telo.Invocable` that delegates single-turn LLM calls to any `Ai.Model` implementation. Owns message-building (prompt shorthand, messages array, system-prompt prepend / override), option layering (manifest → invocation, shallow merge, downstream wins), input exclusivity validation, and output-shape contract enforcement.
  - Internal test fixture (`AiEcho.EchoModel` + `AiEcho.StreamCollector`) under `tests/__fixtures__/ai-echo.yaml` — exercises both the buffered `invoke` and chunked `stream` paths exactly the way external provider packages do, including the alias-form `extends: Ai.Model` resolution.
  - Shared utilities: `redact(fields, obj)` for snapshot redaction; full `AiModelInstance` / `Message` / `Usage` / `FinishReason` / `StreamPart` types under `@telorun/ai/types`.

  `@telorun/ai-openai` ships:

  - `Ai.OpenaiModel` — `Telo.Definition` with `capability: Telo.Invocable, extends: Ai.Model` (canonical alias-form pattern). Implements both methods via Vercel AI SDK (`generateText` for `invoke`, `streamText` for `stream`).
  - Maps Vercel finish reasons into the `Ai.Model` enum (`stop` / `length` / `content-filter` / `error` / `other`).
  - `apiKey` redaction in `snapshot()` so the CEL-visible `resources.<name>` record never carries the secret. Hermetic test asserts the redaction.
  - Manual live integration tests under `tests/__fixtures__/` (env-gated on `OPENAI_API_KEY`); excluded from the default CI run.

  Both packages document the contract, schema, options, and the "how to add a new provider" walkthrough under `docs/`. Wired into the Docusaurus sidebar as a new "AI" group with a "Providers" sub-category.

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

  - @telorun/sdk@0.12.0
  - @telorun/ai@0.2.0

- f74bfa2: Silence the Vercel AI SDK's `AI SDK Warning: …` console output by setting `globalThis.AI_SDK_LOG_WARNINGS = false` at module load. The warnings (e.g. `temperature is not supported for reasoning models`) are useful during library development but noise for Telo manifest consumers who can't act on them. Suppressed once at import time; affects every consumer of `@telorun/ai-openai` in the same Node process.

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

- Updated dependencies [b62e535]

  - @telorun/sdk@0.12.0
  - @telorun/ai@0.2.0

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]

  - @telorun/sdk@0.12.0
  - @telorun/ai@0.2.0

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/ai@0.2.0
  - @telorun/sdk@0.12.0

## 0.1.6

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/ai@0.1.3

## 0.1.5

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0
  - @telorun/ai@0.1.2

## 0.1.4

### Patch Changes

- Updated dependencies [d3ed5a5]
  - @telorun/ai@0.1.1
