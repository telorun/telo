# @telorun/http-dispatch

## 0.2.0

### Minor Changes

- 07c881a: Publish `HttpDispatch.Request` carrier alongside `HttpDispatch.Outcomes`.

  `packages/http-dispatch/telo.yaml` now exports a second `Telo.Definition` (`capability: Telo.Type`, name: `Request`) whose `schema.$defs.Matcher` carries the canonical HTTP request matcher value-shape — `method` / `path` / `query` / `body` / `headers` with `path` + `method` required and the `method` enum locked to the seven standard methods. Same `Telo.Type` pattern as `Outcomes`: pure schema carrier, never instantiated, consumed by HTTP-shaped transports (http-server, lambda, …) via `x-telo-schema-from: "HttpDispatch.Request/$defs/Matcher"` on their per-route `request:` field.

  Consumers keep their own per-field annotations on the consuming side (`x-telo-topology-role: matcher`, `x-telo-context-from: "request/schema"` navigation from sibling `inputs:` / `returns:` / `catches:` context blocks). The carrier owns the structural value-shape only.

  No consumer migrates in this changeset — `http-server.Api.routes[].request` and `Lambda.HttpApi.routes[].request` adopt the anchor in their own follow-ups. This change is the prerequisite that unblocks both.

  Polyglot contract: matcher schema travels through the carrier across languages, not through any TS package.

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

### Patch Changes

- 1662260: Address four review findings against the new transport-neutral dispatch package:

  - **Catch schema omits `encoder`.** `CatchEntry.content[mime]` is now typed as `CatchContentEntry` (a `Type.Omit` of `ContentEntry` that drops `encoder`). Catches are buffer-mode only — by the time a catch fires the response is committed pre-stream and there's no upstream iterable to feed an encoder, and `dispatchCatches` never reads it. Previously the TypeBox `CatchEntry` reused `ContentEntry` verbatim, so an `encoder:` on a catch passed validation and was silently ignored. The runtime check now matches the YAML manifest schema in `modules/http-server/telo.yaml` (which already uses `additionalProperties: false` on catch content entries). New `CatchContentEntry` value/type is exported from the package root.
  - **`when:` absence check is `=== undefined`, not truthiness.** `matchEntry` previously treated any falsy `entry.when` as "no predicate," which meant a literal `when: false` was registered as the list's catch-all and could be selected when no other entry matched. The check is now explicit-undefined (matching the precaution already taken in `modules/mcp-server/nodejs/src/outcome.ts`). Generic constraint widened from `when?: string` to `when?: unknown` to reflect the post-CEL value shape.
  - **`when:` schema type is `Unknown`, not `String`.** The TypeBox `ReturnEntry`/`CatchEntry` schemas declared `when` as `Type.Optional(Type.String())`, but the manifest declares `when` as `type: boolean` and the dispatcher receives either a literal boolean (`when: true` / `when: false`) or a CEL `CompiledValue` object (`when: ${{ ... }}`). Both shapes were rejected by the controller's `ctx.validateSchema(resource, HttpApiManifest)` check at load time. Switched to `Type.Optional(Type.Unknown())`; `expandWith` already knows how to evaluate either shape.
  - **Accept negotiation honors media-range specificity.** `matchAcceptForMime` previously took the maximum q-value across all matching ranges, so `Accept: application/json;q=0, */*;q=1` would still serve `application/json` via the wildcard even though the client explicitly excluded it. The negotiator now picks the most specific matching range per RFC 9110 §12.5.1 (exact `type/subtype` > type-wildcard `type/*` > full-wildcard `*/*`), with q=0 on the most specific match correctly excluding the representation. Ties on specificity are broken by highest q.

  `@telorun/http-server` — adds vitest as a devDependency and a `test` script that runs `fastifyReplySink` through `@telorun/http-dispatch/test-utils`'s shared `runSinkContract` harness against a real listening Fastify server (not `app.inject` — light-my-request rejects on the destroyed-stream path that mid-flight errors take, which would hide whether the partial body actually made it to the wire). Drift between the production transport and the dispatcher's contract now surfaces as a contract-test failure rather than a transport-specific bug discovered downstream. No production-code changes in this package.

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0
