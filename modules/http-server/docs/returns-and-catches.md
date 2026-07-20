---
description: "HTTP route outcome mapping: returns and catches lists with per-MIME content maps, CEL when: conditions, Accept-header negotiation, and stream-mode encoders."
sidebar_label: returns & catches
---

# `returns:` and `catches:`

> Examples below assume the `http-server` module is imported with an `imports:` entry under alias `Http`. Kind references (`Http.Api`, `Http.Server`, …) follow that alias.

Every route in an `Http.Api` defines two outcome lists:

- `returns:` — rendering rules for values the handler resolved with.
- `catches:` — rendering rules for structured `InvokeError` throws from the handler.

Plain `Error` / `RuntimeError` throws (operational failures) skip `catches:` entirely and are handed to Fastify's default 5xx renderer. This keeps domain failures distinct from infrastructure failures.

## Per-entry shape

```yaml
returns:
  - status: <int>            # required
    when: <CEL>              # optional — entry is selected if truthy
    mode: buffer | stream    # optional, default buffer
    headers:                 # optional — entry-level; never includes Content-Type
      <Header-Name>: <CEL or string>
    content:                 # required when status carries a body; omit for 204/304
      <media-type>:
        # buffer-mode value fields:
        body: <CEL or object>
        schema: <JSON Schema>
        # stream-mode value field:
        encoder: <ref to a Codec.Encoder>
        # per-media-type header overrides (merge over entry-level; per-MIME wins):
        headers:
          <Header-Name>: <CEL or string>
```

### Single buffer response

```yaml
returns:
  - status: 200
    content:
      application/json:
        body: { message: "${{ result.greeting }}" }
        schema: { type: object, properties: { message: { type: string } } }
```

### Single stream response (NDJSON)

```yaml
returns:
  - status: 200
    mode: stream
    content:
      application/x-ndjson:
        encoder: { kind: Ndjson.Encoder }
```

### Negotiated stream response

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
      text/plain; charset=utf-8:
        encoder: { kind: PlainText.Encoder }
```

The `Accept` header decides which key wins (see [Content negotiation](#content-negotiation) below).

### Empty response (204, 304)

```yaml
returns:
  - status: 204
    when: "${{ result == null }}"
    # no `content:` block — status only
```

### Catches entry

```yaml
catches:
  - when: "${{ error.code == 'UNAUTHORIZED' }}"
    status: 401
    content:
      application/json:
        body:
          error:
            code: "${{ error.code }}"
            message: "${{ error.message }}"
  - status: 500 # catch-all for any declared code not matched above
    content:
      application/json:
        body:
          error:
            code: "${{ error.code }}"
            message: "${{ error.message }}"
```

`catches:` are buffer-mode only — by the time a catch fires the response is committed pre-stream and there's no upstream iterable to feed an encoder.

## Content negotiation

When a `returns:` entry's `content:` map has multiple keys, the dispatcher picks one per RFC 9110 §12.5.1:

1. Filter `returns:` entries by `when:` (existing behaviour).
2. From the matched entry's `content:` map, filter keys by `Accept` header:
   - q-values respected; `q=0` excludes.
   - Wildcards (`text/*`, `*/*`) supported.
   - Highest q-value wins.
   - Tie-break: declaration order of keys in the `content:` map.
3. No key matches → `406 Not Acceptable`, body lists available media types.
4. No `Accept` header (or only `*/*`) → first key in declaration order.

**Single-key maps still negotiate.** If the only declared key is `application/json` and the client sends `Accept: image/png`, the response is `406 Not Acceptable` (RFC 9110 §15.5.7). This is a deliberate behaviour change vs. the legacy single-`body` shape, which always sent the response regardless of `Accept`. Authors who want to ignore `Accept` entirely can declare `*/*` as a key — but typically you want the matrix response.

**Parameter handling.** Accept entries and content keys are matched on the type/subtype only — anything after the first `;` (e.g. `charset=utf-8`, `q=0.9`) is ignored for matching purposes (q-values are still parsed for ranking). This means `Accept: text/plain; charset=ascii` matches `content: { 'text/plain; charset=utf-8': ... }` — Telo doesn't enforce parameter-level preferences. Authors who need stricter matching should declare distinct keys per parameter combination.

## Rules

- **CEL context.** `returns:` entries see `{ result, request }`. `catches:` entries see `{ error, request }`. Cross-channel references (`result.*` in `catches:`, `error.*` in `returns:`) are rejected by the analyzer.
- **Stream-mode `when:`.** `result.*` is unavailable in stream-mode `when:` — the handler result is an unconsumed `Stream<...>`; iterating it to evaluate the predicate would either fail or consume the stream before bytes flow to the response. Reference only `request.*`. Load-time validator rejects violations.
- **`Content-Type` is forbidden in `headers:`.** The matched `content[mime]` map key is the only Content-Type source. Declaring it again in `headers:` is rejected at load time (case-insensitive).
- **`body` and `encoder` are mutually exclusive.** A `content[mime]` value uses `body` (buffer mode) or `encoder` (stream mode), never both.
- **Matching.** Both lists are scanned top-to-bottom. The first entry whose `when:` evaluates truthy wins. The first entry with no `when:` is the list's catch-all; entries following it are unreachable and rejected by the analyzer.
- **`returns:` is required.** Every route must define at least one `returns:` entry. `catches:` is optional when the handler's declared throw union is empty.
- **Streams on `returns:` only.** `mode: stream` is forbidden on `catches:` entries.
- **Unmatched `InvokeError`.** When a handler throws an `InvokeError` but no `catches:` entry matches and no catch-all is present, the dispatcher renders `500 application/json { error: { code, message, data } }`.

## Stream-mode pipeline

When a `mode: stream` entry matches:

1. Resolve the encoder ref (post-Phase-5 it's a live `Codec.Encoder` instance).
2. Read the handler's `result.output` (must be a `Stream<...>` or `AsyncIterable`).
3. Call `encoder.invoke({ input: result.output })` — yields `{ output: Stream<Uint8Array> }`.
4. Pipe the encoder's `output` to `reply.raw` via Node's `pipeline()` (handles backpressure).

Cancellation propagates top-to-bottom: client disconnect → Fastify socket close → `pipeline()` aborts → `Readable.from(...)` calls `.return()` on the encoder iterable → encoder's `for await` exits → source's `.return()` is called → `model.stream()` cancels the upstream call.

## Mid-stream throws

If a `mode: stream` `returns:` entry matches, the response is committed (status + headers flushed) before the stream body begins. A throw after that point cannot trigger `catches:` — the chunked transfer is aborted and the socket closed. Authors who need catchable failure inside a streaming pipeline must validate upfront and throw before the stream starts.

The format-codec encoders embed *in-band* error frames at their own level: `Ndjson.Encoder` emits `{"type":"error","error":{"message":"..."}}` and ends; `Sse.Encoder` emits `event: error\ndata: ...\n\n` and ends; `PlainText.Encoder` and `Octet.Encoder` propagate the error and abort the transport.

Regardless of encoder, a mid-stream failure is logged server-side through the server's structured logger at `error` level with the error, route, status, and MIME — so a failure that can't reach `catches:` is never silent for the operator. It is also emitted as an `Http.Api.streamFailed` event for debug tooling.

## `notFoundHandler`

`Http.Server.notFoundHandler` accepts the same `returns:` and `catches:` split as a route handler — same `content:` map shape, same Accept-header negotiation, same stream-mode rules. The `invoke:` resource runs when Fastify can't match any mounted route; its return value flows through `returns:`, its `InvokeError` throws through `catches:`.
