# Plan: streaming, codecs, and `Ai.TextStream` tests

## Status

This plan has been partially implemented. The streaming contract, codec packages, `Ai.TextStream` shape change, and analyzer support are all in place. The http-server rewrite, manifest migration, integration-test relocation, Layer 1/2 tests, and docs/changesets remain pending. See [Implementation order](#implementation-order) for the current state.

## Goal

Define the cross-runtime streaming contract; rework `Ai.TextStream` to yield typed records as a `Stream<StreamPart>`; ship format-codec packages (encoder + decoder per format) under a shared `Codec.Encoder` / `Codec.Decoder` abstract; add streaming-behaviour tests at two layers (hermetic and live). **No new kernel capability is added** — codecs are plain `Telo.Invocable`s; the streaming dimension lives in the schema via the `x-telo-stream` annotation.

## Streaming contract

`Stream<T>` (the class exported by `@telorun/sdk`) wraps an `AsyncIterable<T>` and is the runtime value type for every stream-typed property in Telo. `Ai.TextStream` returns `{ output: Stream<StreamPart> }`. Future binary sources may return `Stream<Uint8Array>`. Encoders and other consumers iterate with `for await`.

The `Stream` class exists because cel-js's runtime type-checker rejects values whose `.constructor` isn't `Object/Map/Array/Set/registered` — bare `AsyncGenerator` instances trip that rejection. The `@telorun/sdk` `Stream` class is registered with the analyzer's CEL environment ([cel-environment.ts](../../../analyzer/nodejs/src/cel-environment.ts)) so values of that constructor pass through field access cleanly. Producers wrap their iterables: `new Stream(asyncGen)`.

Cross-runtime mapping:

| concept                  | JS (`AsyncIterable`)        | Rust                         | Go                                       |
| ------------------------ | --------------------------- | ---------------------------- | ---------------------------------------- |
| Pull next item           | `await iter.next()`         | `stream.poll_next(cx).await` | `v, ok := <-ch`                          |
| Termination              | `{done: true}`              | `Poll::Ready(None)`          | channel `close`                          |
| Error                    | `next()` rejects            | `Poll::Ready(Some(Err))`     | error channel / `(0, err)` from `Read`   |
| Cancellation             | `iter.return()`             | drop the `Stream`            | cancel `context.Context`                 |
| Byte chunks specifically | `Stream<Uint8Array>`        | `Stream<Item = Bytes>`       | `<-chan []byte` (or `io.Reader` for raw) |

Each runtime adapter (napi-rs for Rust, WASI streams for Go when available) is responsible for translating its native stream type to/from the JS `Stream` boundary, including cancellation, error mapping, and chunk batching.

## `x-telo-stream` annotation

Any property in an `inputType` or `outputType` schema may be marked `x-telo-stream: true`. CEL passes the value through by reference (no expansion / serialization); the analyzer treats it as opaque (no member or index access past the marked property). **Convention across all streaming Invocables in Telo**: stream-typed inputs sit on the `input` property of `inputs`; stream-typed outputs sit on the `output` property of the result. Other properties on either side stay normal-typed.

This generalizes beyond codecs. Compressors (stream → stream), aggregators (stream → scalars), splitters (object → stream), and streaming validators all fit the same Invocable shape — each declares whichever properties happen to be stream-typed.

## `Self.<Abstract>` alias

For same-library `extends:` (concrete kinds extending an abstract declared in the same `Telo.Library`), the analyzer auto-registers `Self` as an alias pointing at the declaring library's own module name. This avoids the loader-loop a self-import would cause. Used everywhere a format-codec module declares its concrete `Encoder` / `Decoder` extending the local `Codec.X` abstract.

## Codec package layout

Five packages, one shared abstracts package + four format-specific codec packages:

| package                       | exports                | aliases (typical) | x-telo-refs                                |
| ----------------------------- | ---------------------- | ----------------- | ------------------------------------------ |
| `@telorun/codec`              | `Encoder`, `Decoder` (abstracts) | `Codec`           | `std/codec#Encoder`, `std/codec#Decoder`   |
| `@telorun/plain-text-codec`   | `Encoder`, `Decoder`   | `PlainText`       | `PlainText.Encoder` / `PlainText.Decoder`  |
| `@telorun/ndjson-codec`       | `Encoder`              | `Ndjson`          | `Ndjson.Encoder`                           |
| `@telorun/sse-codec`          | `Encoder`              | `Sse`             | `Sse.Encoder`                              |
| `@telorun/octet-codec`        | `Encoder`, `Decoder`   | `Octet`           | `Octet.Encoder` / `Octet.Decoder`          |

Format-codec modules import `@telorun/codec` for the abstracts and declare concrete kinds via `extends: Codec.Encoder` / `extends: Codec.Decoder`. Future formats (CBOR, MessagePack, Protobuf-stream, app-specific JSON envelopes) ship as additional `*-codec` packages following the same shape.

`Ndjson.Decoder` and `Sse.Decoder` ship later — they require line / frame buffering across chunk boundaries (more involved than the buffer-mode `PlainText.Decoder` / `Octet.Decoder`). Asymmetric shipping is part of the model: a format module can be encoder-only or decoder-only at any given time without false symmetry pressure.

### Runtime contract (encoders)

```ts
interface EncoderInstance<TIn = unknown> {
  invoke(inputs: { input: AsyncIterable<TIn> })
    : Promise<{ output: Stream<Uint8Array> }>;

  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
```

### Runtime contract (decoders)

```ts
interface DecoderInstance {
  // Output shape varies per concrete decoder:
  //   PlainText.Decoder → { text: string }
  //   Octet.Decoder     → { bytes: Uint8Array }
  //   future Ndjson.Decoder → { records: Stream<unknown> }
  //   future Sse.Decoder    → { events: Stream<{event, data}> }
  invoke(inputs: { input: AsyncIterable<Uint8Array> })
    : Promise<Record<string, unknown>>;

  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
```

### Codec catalog (initial release)

| kind                   | wire format                 | input → output                                                            |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `PlainText.Encoder`    | `text/plain; charset=utf-8` | `{delta: string}` / `string` / `Uint8Array` → UTF-8 bytes                 |
| `PlainText.Decoder`    | `text/plain; charset=utf-8` | `Uint8Array` → `{ text: string }` (buffer-mode collect)                   |
| `Ndjson.Encoder`       | `application/x-ndjson`      | any JSON-serializable record → `JSON.stringify(item) + "\n"` per item     |
| `Sse.Encoder`          | `text/event-stream`         | `{type, ...rest}` / `string` → `event: <type>\ndata: <json>\n\n` per item |
| `Octet.Encoder`        | `application/octet-stream`  | `Uint8Array` → `Uint8Array` (pass-through)                                |
| `Octet.Decoder`        | `application/octet-stream`  | `Uint8Array` → `{ bytes: Uint8Array }` (buffer-mode collect)              |

Encoders carry no MIME declaration — the `content[mime]` map key in the route is the only Content-Type source. Pairing `Sse.Encoder` under `application/x-ndjson` produces wrong bytes on the wire and is author-beware. No runtime warning, no static cross-check (deferred to the typed-abstracts plan).

Input-shape validation is runtime-only for v1: the encoder peeks the first item and throws if it can't handle the shape. Pre-flight type checking against the handler's stream-item type lands later as part of typed-abstracts ([kernel/nodejs/plans/typed-abstracts.md](../../../kernel/nodejs/plans/typed-abstracts.md)) — additive change, no breakage.

### Mid-stream error handling

Per-encoder:
- `Ndjson.Encoder` emits `{"type":"error","error":{"message":"..."}}\n` and ends.
- `Sse.Encoder` emits `event: error\ndata: {"message":"..."}\n\n` and ends.
- `PlainText.Encoder` and `Octet.Encoder` propagate the error to the iterable consumer (the consumer aborts the transport).

### `StreamPart.error` is JSON-serializable

`StreamPart.error` is a plain object (`{ message, code?, data? }`), not a native `Error`. Provider controllers translate native errors at yield time so generic encoders can frame error parts via `JSON.stringify(item)` without bespoke serialization.

```ts
export type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: { message: string; code?: string; data?: unknown } };
```

## `Ai.TextStream` source contract

`Ai.TextStream.invoke(...)` returns `Promise<{ output: Stream<StreamPart> }>` — honoring the `output`-property convention for streaming Invocables. The underlying `Ai.Model.stream()` keeps its bare-iterable shape (it's not an Invocable; it's a method on the Model instance the controller calls internally).

Manifest fields:

- `model` — `x-telo-ref: "std/ai#Model"`
- `system` — string, optional default system prompt
- `options` — object, optional per-resource option overrides

The `format` field has been removed. `Ai.TextStream` is a thin configured wrapper over `model.stream()`, mirroring `Ai.Text`'s relationship to `model.invoke()`. Encoding is the consumer's responsibility (HTTP route via a format-codec encoder, JS step via direct iteration, etc.).

`Ai.TextStream`'s `outputType` in [modules/ai/telo.yaml](../telo.yaml) declares `output` with `x-telo-stream: true` so the analyzer's chain validator forbids member access past `result.output`.

## `Http.Api` `returns:` schema rewrite (clean break, **pending**)

`body:`, `schema:`, and a new `encoder:` field move out of the top-level entry and into a per-MIME `content:` map. The map key IS the Content-Type — there is no separate `contentType:` field, no `headers.Content-Type` override.

New per-entry shape:

```yaml
returns:
  - status: <int>            # required, existing
    when: <CEL>              # optional, existing
    mode: buffer | stream    # optional, default buffer (existing)
    headers:                 # optional, existing — but NEVER includes Content-Type
      <Header-Name>: <CEL or string>
    content:                 # required when status has a body
      <media-type>:
        # buffer-mode value fields:
        body: <CEL or object>
        schema: <JSON Schema>
        # stream-mode value field:
        encoder: <x-telo-ref to Codec.Encoder>
        # per-media-type header overrides (merge over entry-level headers):
        headers:
          <Header-Name>: <CEL or string>
```

Rules:
- The map key (e.g. `application/x-ndjson`) is the canonical Content-Type. The server sets `Content-Type` from the matched key automatically.
- `headers.Content-Type` is **forbidden** at every level — analyzer error if present. Map key is the only declaration.
- `content[mime].body` and `content[mime].encoder` are mutually exclusive per value. Buffer-mode entries use `body:`; stream-mode entries use `encoder:`. Schema-level `oneOf` enforces.
- `content[mime].schema:` validates the rendered body in buffer mode. In stream mode, `schema:` is unused (the encoder owns shape); reserved for future analyzer pre-flight against the handler's stream-item type.
- Status codes that have no body (e.g. 204, 304) omit `content:` entirely.
- Per-media-type `headers:` merge over entry-level `headers:` (per-MIME wins on conflict).

The same `content:` map shape applies to **every place that today uses `body:` / `schema:` / `headers:` at the entry level**:

- `Http.Api.routes[].returns[]`
- `Http.Api.routes[].catches[]` — error responses negotiate Content-Type the same way (a JSON error body is the default; SSE/NDJSON variants opt in via the same map). **Buffer-mode only**: `mode: stream` is forbidden in `catches:` because by the time a catch fires, the response is committed (status + headers flushed) and there's no upstream iterable to feed an encoder.
- `Http.Server.notFoundHandler.returns[]` and `.catches[]` — same shape, same rules.

This is a **breaking change** to existing manifests. Top-level `body:` / `schema:` is removed everywhere it appears in those four locations.

### Old vs new examples

Single buffer response (was):
```yaml
returns:
  - status: 200
    headers: { Content-Type: application/json }
    body: { message: "${{ result.greeting }}" }
    schema: { type: object, properties: { message: { type: string } } }
```

Single buffer response (now):
```yaml
returns:
  - status: 200
    content:
      application/json:
        body: { message: "${{ result.greeting }}" }
        schema: { type: object, properties: { message: { type: string } } }
```

Single stream response (now):
```yaml
returns:
  - status: 200
    mode: stream
    content:
      application/x-ndjson:
        encoder: { kind: Ndjson.Encoder }
```

Negotiated stream response (now):
```yaml
returns:
  - status: 200
    mode: stream
    content:
      application/x-ndjson:
        encoder: { kind: Ndjson.Encoder }
      text/event-stream:
        encoder: { kind: Sse.Encoder }
        headers: { Cache-Control: "no-cache" }
      text/plain:
        encoder: { kind: PlainText.Encoder }
```

Empty response (204, now):
```yaml
returns:
  - status: 204
    when: "${{ result == null }}"
    # no `content:` block
```

## Content negotiation algorithm

When a `returns:` entry's `content:` map has multiple keys:

1. Filter `returns:` entries by `when:` (existing behaviour). Falsy `when:` drops the entry.
2. From the matched entry's `content:` map, filter keys by `Accept` header per RFC 9110 §12.5.1:
   - q-values respected; `q=0` excludes.
   - Wildcards (`text/*`, `*/*`) supported.
   - Pick highest q-value match.
   - Tie-break: declaration order of keys in the `content:` map.
3. No key matches → `406 Not Acceptable`, body lists available media types.
4. No `Accept` header (or only `*/*`) → first key (declaration order).

Single-key `content:` maps skip steps 2–4 and use the only entry.

Stream-entry `when:` may reference `request.*` only; `result.*` is unavailable because the handler result is an unconsumed `Stream`. The analyzer flags `result.*` references in a stream-entry `when:` as an error. `when:` filtering and Accept-header negotiation are separate concerns — `when:` for explicit author predicates, Accept matching for content negotiation.

## In-tree manifests requiring manual migration

Every entry under `returns:` / `catches:` (in `Http.Api.routes[]` AND in `Http.Server.notFoundHandler`) with top-level `body:`/`schema:` needs hand-conversion to the new `content:` map shape. Per-entry rewrite:

- Move `body:` and `schema:` under `content[<media-type>]`.
- Determine `<media-type>` from the entry's `headers.Content-Type`. If absent, default to `application/json`.
- Strip `Content-Type` from `headers:`. Remove `headers:` entirely if empty.
- Preserve other headers (e.g. `Cache-Control`) at the entry level.
- Multi-entry runs sharing the same `status:` and differing only by `headers.Content-Type:` collapse into one entry with multiple `content:` keys (the implicit-negotiation case becomes explicit).

**Find every affected file** before migrating:

```sh
git grep -lE "^( *)(returns|catches): *$" -- '*.yaml' | xargs grep -lE "^ *(body|schema): "
```

Partial enumeration of affected files (run the grep to confirm completeness): `examples/hello-api.yaml`, `examples/feedback-api-repo.yaml`, `examples/templated-api-usage.yaml`, `examples/templated-api.yaml`, `examples/configurable-http-server.yaml`, `tests/pipeline-with-server.yaml`, `tests/x-telo-eval-compile.yaml`, `tests/module-template-basics.yaml`, `apps/registry/telo.yaml` (multiple routes), `modules/ai/tests/__fixtures__/text-stream-http-formats.yaml` (currently parked), plus the http-server `__fixtures__` set used by `throws-coverage.yaml` (`passthrough-inside-catch.yaml`, `bad-globals-access.yaml`, `uncovered-code.yaml`, `valid-globals-access.yaml`, `catchall-not-last.yaml`, `inherit-cycle.yaml`, `undeclared-code.yaml`).

## Manifest examples (post-rewrite)

The route's `encoder:` field accepts two forms (matches existing `handler:` and `contentTypeParsers.parser:` patterns):

- **Named reference** — `encoder: { kind: Ndjson.Encoder, name: NdjsonEnc }` — points at a separately declared resource. Use when the encoder has manifest config worth naming.
- **Inline** — `encoder: { kind: Ndjson.Encoder }` — declares the encoder in place. For stateless built-ins, skips the boilerplate.

### Inline form (single-format route)

```yaml
kind: Telo.Import
metadata: { name: Ndjson }
source: pkg:npm/@telorun/ndjson-codec
---
kind: Ai.TextStream
metadata: { name: ChatStream }
model: { kind: Ai.OpenaiModel, name: Gpt4o }
---
kind: Http.Api
metadata: { name: ChatApi }
routes:
  - request: { path: /chat, method: POST }
    handler: { kind: Ai.TextStream, name: ChatStream }
    inputs:
      prompt: "${{ request.body.prompt }}"
    returns:
      - status: 200
        mode: stream
        content:
          application/x-ndjson:
            encoder: { kind: Ndjson.Encoder }
```

### Named form (single-format route)

```yaml
kind: Ndjson.Encoder
metadata: { name: NdjsonEnc }
---
kind: Http.Api
metadata: { name: ChatApi }
routes:
  - request: { path: /chat, method: POST }
    handler: { kind: Ai.TextStream, name: ChatStream }
    returns:
      - status: 200
        mode: stream
        content:
          application/x-ndjson:
            encoder: { kind: Ndjson.Encoder, name: NdjsonEnc }
```

### Inline form (negotiated route)

```yaml
kind: Http.Api
metadata: { name: ChatApi }
routes:
  - request: { path: /chat, method: POST }
    handler: { kind: Ai.TextStream, name: ChatStream }
    returns:
      - status: 200
        mode: stream
        content:
          application/x-ndjson:
            encoder: { kind: Ndjson.Encoder }
          text/event-stream:
            encoder: { kind: Sse.Encoder }
            headers: { Cache-Control: "no-cache" }
          text/plain:
            encoder: { kind: PlainText.Encoder }
```

## Non-HTTP consumers

Any `Run.Sequence` step or non-HTTP caller invoking `Ai.TextStream` receives `{ output: Stream<StreamPart> }` as `result`. Consumers either iterate `result.output` directly (`JS.Script`) or pipe it through a format-codec encoder manually (encoders are Invocables — they work outside HTTP).

### Step context for `${{ steps.X.result }}`

`Ai.TextStream`'s outputType declares `output` with `x-telo-stream: true`. The analyzer's `x-telo-step-context` walker honours that annotation **per-property**, not per-result:

- `${{ steps.X.result.output }}` — type-checks as opaque; passes through CEL by reference. Use as input to a downstream encoder step or iterate inside a `JS.Script`.
- `${{ steps.X.result.output[0] }}`, `${{ steps.X.result.output.text }}`, etc. — analyzer diagnostic: "this property yields a stream — pipe it through an Encoder or iterate in a JS.Script step."
- `${{ steps.X.result.somethingElse }}` — introspects normally if the schema declares it.

The same rule applies on the input side: any Invocable whose `inputType` declares `x-telo-stream: true` on a property accepts that value by reference, with no CEL expansion or analyzer introspection inside it.

### Iterating directly in `JS.Script`

The `Stream` class is exposed in every `JS.Script`'s scope (injected via the wrapper as `telo.Stream`):

```yaml
kind: JS.Script
metadata: { name: Drain }
code: |
  async function main({ stream }) {
    let text = "";
    for await (const part of stream) {
      if (part.type === "text-delta") text += part.delta;
    }
    return { text };
  }
```

```yaml
- name: Drain
  inputs:
    stream: "${{ steps.Stream.result.output }}"
  invoke: { kind: JS.Script, name: Drain }
```

## Cancellation propagation

When the HTTP client disconnects mid-stream, the server cancels the chain top-to-bottom:

1. Fastify detects the socket close and aborts the response.
2. The server calls `.return()` on the encoder's `output` iterable (the `Stream<Uint8Array>` from `encoder.invoke().output`) it was consuming.
3. The encoder's `async function*` body unwinds — its `for await` over `inputs.input` exits, propagating `.return()` to the source's `output` iterable.
4. The source — `Ai.TextStream` — propagates `.return()` from its `output` iterable down to `model.stream()`.
5. The provider controller (e.g. `Ai.OpenaiModel`) catches the iterator close and aborts the underlying SDK call (`AbortController.abort()` on Vercel AI SDK's `streamText`).

Provider controllers are responsible for honouring the `.return()` signal — failing to do so leaves provider connections open after the client is gone. Tests for each provider should cover this (out of scope for this plan; tracked under each provider module's test plan).

Inside `Ai.TextStream` and the format-codec encoders, propagation is automatic — `async function*` body unwinding via `.return()` is standard JS semantics and requires no special handling.

## Backward compatibility with `Readable`-returning handlers

Today's `dispatchReturns()` `mode: stream` path expects a Node `Readable` from the handler. After the rewrite, it expects `{ output: Stream<unknown> }` — the standard streaming-Invocable result shape. Legacy handlers that returned a bare `Readable` need migrating: wrap the return value as `{ output: new Stream(theReadable) }`. Once wrapped, Node `Readable` (which IS `AsyncIterable<Buffer>`) pairs naturally with `Octet.Encoder` for pass-through.

Stated explicitly in the plan: **all stream handlers return `{ output: Stream<T> }`. `Readable` is wrapped in `Stream` because cel-js's runtime type-checker rejects unrecognized constructors (Readable's constructor is not in the recognized set).** No special-casing in the encoder dispatch.

## Test layers

### Layer 1 — hermetic streaming-contract test (`modules/ai/tests/`)

`modules/ai/tests/text-stream-streaming-contract.yaml` — three sub-targets, one per encoder (`PlainText.Encoder`, `Ndjson.Encoder`, `Sse.Encoder`). Each: `AiEcho.EchoModel` → `Ai.TextStream` → encoder → `PlainText.Decoder` → `Assert.Schema`.

Per-target assertions:
- `Ndjson.Encoder`: concatenated chunks split on `\n` produce N+1 valid JSON records.
- `Sse.Encoder`: concatenated chunks split on `\n\n` produce N frames each starting with `event: `.
- `PlainText.Encoder`: concatenated chunks decode as valid UTF-8.
- Total bytes equal the expected wire output for the prompt.

The simpler [text-stream-smoke.yaml](../tests/text-stream-smoke.yaml) (already shipped) covers the NDJSON path end-to-end as a sanity check; Layer 1 broadens this to all three text-format encoders with byte-exact assertions.

### Layer 2 — live OpenAI streaming smoke (`modules/ai-openai/tests/`)

`modules/ai-openai/tests/openai-live-text-stream.yaml` — env-gated like `openai-live-stream.yaml`. `OpenaiModel` → `Ai.TextStream` → `Ndjson.Encoder` → `PlainText.Decoder` → `Assert.Schema`.

Assertions:
- Concatenated text is non-empty.
- Last NDJSON line parses as `{"type":"finish",...}` with `usage.totalTokens > 0`.

NDJSON is the only format exercised live; format encoding is covered hermetically in Layer 1.

## Implementation order

The schema flip in step 4 is inherently atomic — `@telorun/http-server`'s new wire contract and the in-tree manifests that exercise it must move in lockstep. Step 4 is therefore one commit / one PR, gated on `pnpm run test` passing.

1. **Kernel + analyzer (✅ done)** — `x-telo-stream: true` schema annotation. CEL passes any property marked stream through by reference (existing evaluator already does this for non-string values; analyzer-side change registers the `Stream` class as an object type so cel-js doesn't reject it). The analyzer's chain validator now rejects member or index access past stream-marked properties — `extractChain` handles `[]` ops, `validateChainAgainstSchema` checks `x-telo-stream`, `buildStepContextSchema` falls back from resource manifest to kind definition for `outputType` lookup. `Self.<Abstract>` magic alias auto-registered for same-library `extends:`.
2. **`@telorun/sdk` (✅ done)** — `Stream<T>` class exported. Implements `AsyncIterable<T>`, forwards `Symbol.asyncIterator` to wrapped source. Registered with the analyzer's CEL environment.
3. **`@telorun/ai` types (✅ done)** — `StreamPart.error` shape changed to `{ message, code?, data? }`. Provider controllers (`ai-echo`, `ai-openai`) translate native `Error` to that shape at yield time.
4. **`@telorun/ai` (✅ done, partial)** — `Ai.TextStream.invoke()` now returns `Promise<{ output: Stream<StreamPart> }>`. `format` field removed. Controller's encoder logic removed (returns `{ output: new Stream(model.stream({...})) }`). `outputType` declares `output` with `x-telo-stream: true`. `text-stream-http-formats.yaml` parked under `__fixtures__/` until the http-server flip lands. `text-stream-drain-controller.ts` deleted.
5. **`@telorun/codec` + format-codec packages (✅ done)** — `@telorun/codec` ships `Encoder` and `Decoder` abstracts. Format-specific packages: `@telorun/plain-text-codec` (Encoder + Decoder), `@telorun/ndjson-codec` (Encoder), `@telorun/sse-codec` (Encoder), `@telorun/octet-codec` (Encoder + Decoder). Each concrete kind extends the abstract via `Codec.Encoder` / `Codec.Decoder` (the `Codec` alias is declared by the per-package `Telo.Import`). Smoke test at [modules/codec/tests/codecs-smoke.yaml](../../codec/tests/codecs-smoke.yaml).
6. **`@telorun/javascript` (✅ done)** — `JS.Script` injects `Stream` (from `@telorun/sdk`) into every script's scope so user code can `new Stream(asyncGen)`.
7. **Atomic schema flip (⏳ pending)** — single commit:
   - `@telorun/http-server` — rewrite `returns:` AND `catches:` entry schemas (in `Http.Api.routes[]` and `Http.Server.notFoundHandler`): remove top-level `body`/`schema`, add `content:` map with per-MIME `body`/`schema`/`encoder`/`headers`. Forbid `headers.Content-Type` everywhere. Forbid `mode: stream` in `catches:`. Implement Accept-header negotiation over `content:` keys in `dispatchReturns()` and `dispatchCatches()`. Wire `mode: stream` to: read handler `result.output`, call resolved encoder's `invoke({input: handlerOutput})`, take encoder `result.output`, pipe to `reply.raw`. Cancellation: propagate Fastify socket-close to the encoder result iterable's `.return()`.
   - **Manual migration** — hand-rewrite every in-tree manifest listed in [In-tree manifests requiring manual migration](#in-tree-manifests-requiring-manual-migration), including the parked `text-stream-http-formats.yaml`. All in the same commit as the http-server change.
   - **Analyzer rules** — add `headers.Content-Type forbidden` and `result.* in stream-mode when:` rules. They check fields only present in the new schema, so they ship with the flip.
   - Commit lands when `pnpm run test` is green across all pieces.
8. **Move integration test (⏳ pending, depends on step 7)** — `git mv modules/ai/tests/__fixtures__/text-stream-http-formats.yaml modules/http-server/tests/text-stream-via-http.yaml` after step 7 migrates it to the new shape. Verify it exercises the negotiation path.
9. **Layer 1 test (⏳ pending)** — `modules/ai/tests/text-stream-streaming-contract.yaml`.
10. **Layer 2 test (⏳ pending)** — `modules/ai-openai/tests/openai-live-text-stream.yaml`.
11. **Module docs (⏳ partial)** — `modules/ai/README.md`, `modules/ai/docs/ai-text-stream.md` already updated. Pending: `modules/http-server/docs/returns-and-catches.md` (new) and `modules/ai-openai/docs/ai-openai-model.md` updates after step 7. Confirm Docusaurus include + sidebar entries for codec packages.
12. **Changesets (⏳ pending)** — add entries under `.changeset/` for every touched published package: `@telorun/sdk` (Stream class — minor), `@telorun/ai` (Ai.TextStream return-shape change, format field removal — major), `@telorun/ai-openai` (StreamPart.error shape adapter — patch), `@telorun/javascript` (Stream injected into script scope — minor), `@telorun/codec` + each `*-codec` package (initial release — minor), `@telorun/http-server` (returns/catches schema rewrite, content negotiation — major after step 7), plus kernel/analyzer if they publish (for the `x-telo-stream` annotation, `Self` alias, chain-extractor changes).

## Existing artefact actions

| File                                                                            | Action                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| In-tree manifests with `returns: [..., body: ..., schema: ...]`                 | Hand-migrate to `returns: [..., content: { <mime>: { body, schema } }]`. ⏳                              |
| `modules/ai/tests/__fixtures__/text-stream-http-formats.yaml`                   | Hand-migrate, then `git mv` to `modules/http-server/tests/text-stream-via-http.yaml`. ⏳                |
| `modules/ai/nodejs/src/text-stream-drain-controller.ts`                         | Deleted. ✅                                                                                              |
| `modules/ai/nodejs/package.json` `./text-stream-drain` export                   | Removed. ✅                                                                                              |
| `modules/ai/tests/__fixtures__/ai-echo.yaml` `TextStreamDrain` definition       | Removed. ✅                                                                                              |
| `modules/ai/telo.yaml` `Ai.TextStream.format` field                             | Removed. ✅                                                                                              |
| `modules/ai/telo.yaml` `Ai.TextStream` outputType                               | Set to `{ properties: { output: { x-telo-stream: true } }, required: [output] }`. ✅                    |
| `modules/ai/nodejs/src/ai-text-stream-controller.ts` encoder logic              | Removed. Controller returns `{ output: new Stream(model.stream({...})) }`. ✅                            |
