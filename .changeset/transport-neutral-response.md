---
"@telorun/http-dispatch": minor
"@telorun/http-server": patch
---

Extract `returns:` / `catches:` rendering into a transport-neutral package.

`@telorun/http-dispatch` — new package, initial publish. Ships:

- `ResponseSink` interface — transport-neutral status / header / send / stream sink that the dispatcher writes through. HTTP-shaped transports (Fastify-backed http-server, AWS Lambda, future fetch-API / native http.Server adapters) implement this interface; the dispatcher does not know which one is underneath.
- `dispatchReturns` / `dispatchCatches` — the CEL `when:` matching, status branching, schema validation, per-MIME content negotiation, buffer/stream mode, encoder-ref-driven streaming, header merging, and error-path fall-through previously inlined in `http-api-controller.ts`. Encoder ref injection stays inside the dispatcher: when a `mode: stream` entry matches, the dispatcher calls `encoder.invoke({ input })` itself and hands the resulting `AsyncIterable<Uint8Array>` to the sink. The sink never sees the encoder, the `Invocable`, or any kernel/SDK type — it only ever takes bytes.
- TypeBox `ReturnEntry` / `CatchEntry` / `ContentEntry` schemas, re-exportable by any transport that consumes the dispatcher.
- Runtime validators `validateNoContentTypeHeader` and `validateStreamWhenDoesNotReferenceResult` — defense-in-depth checks the dispatcher runs against the outcome lists.
- `@telorun/http-dispatch/test-utils` — a `runSinkContract(name, factory)` vitest harness that exercises every method on the sink interface through a known sequence (status-only / empty body; buffered JSON; last-write-wins headers; streamed bytes byte-exact; mid-stream failure routed through `onError`; double-send + setStatus-after-send rejection). Both http-server's Fastify adapter and future transport adapters (Lambda, gRPC, …) feed their factory through this harness so drift between transports surfaces as a contract-test failure, not a transport-specific bug discovered downstream.

`@telorun/http-server` — controller-internal refactor onto the sink via `@telorun/http-dispatch` (added as a new workspace dependency). New `fastifyReplySink` adapter translates `ResponseSink` calls onto `FastifyReply` (`reply.code` / `reply.header` / `reply.send`; `reply.hijack` + `pipeline(Readable.from(...), reply.raw)` for streams). The local `validateContentEntryShape` runtime check is **deleted** — its rule (body/encoder mutual exclusion; stream-mode requires `encoder` everywhere and forbids `body`; stream-mode requires a non-empty `content:`) moves into `modules/http-server/telo.yaml` as a `oneOf`-on-`mode` discriminated union on `Api.routes[].returns[]` and `Server.notFoundHandler.returns[]`. The `mode` field stays optional; the buffer branch matches when `mode` is absent OR `mode: buffer`, so existing manifests without `mode:` continue to validate unchanged (the kernel's shared AJV config at `ctx.validateSchema` does not enable `useDefaults`). `validateNoContentTypeHeader` and `validateStreamWhenDoesNotReferenceResult` move into `@telorun/http-dispatch` as runtime guards; no observable behaviour change for valid manifests.

`@telorun/sdk` — no change. The dispatcher is not added to the SDK; the SDK retains its zero-runtime-deps posture. HTTP-shaped dispatch code does not belong in the install tree of every non-HTTP module (sql, ai, assert, console, …), and a future Go or Python SDK should not grow a `dispatch` subpath for symmetry — dispatch is a transport-adapter concern, not a module-author concern.

Polyglot contract: the YAML schema (`status` / `when` / `mode` / `headers` / `content[mime].{body,schema,encoder,headers}` plus the `x-telo-outcome-list` / `x-telo-catches-for` annotations) is what travels across languages, not this TS package. A future Go / Python implementation re-implements the dispatcher against the same schema, duplicated verbatim into each consuming module's manifest (`@telorun/lambda` lands next).
