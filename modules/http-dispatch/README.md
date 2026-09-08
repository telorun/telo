# http-dispatch

The canonical HTTP response value-shapes, and the dispatcher that renders them.

This module declares no resource kinds you instantiate. It is a **schema carrier**
plus a small runtime library, shared by every HTTP-shaped transport so that the
entry shape, the MIME negotiation rules and the buffer/stream split live in one
place rather than once per transport.

## What it publishes

- **`HttpDispatch.Outcomes`** — `$defs/Returns` and `$defs/Catches`, the response
  rendering lists. A transport anchors its own slots at them with
  `x-telo-schema-from`, so `Http.Api`'s routes, `Http.Server`'s `notFoundHandler`
  and both scope-level catch lists all validate against the same entries.
- **`HttpDispatch.Request`** — `$defs/Matcher`, the canonical request matcher
  (`method` + `path`, with an optional `schema` block).

Both are `capability: Telo.Type`: they are never instantiated.

## The rendering contract

`dispatchReturns` renders a handler's resolved value. `dispatchCatches` renders a
thrown `InvokeError`.

**`dispatchCatches` declines rather than renders.** It returns `true` when an
entry matched and it wrote the response, and `false` when none did — writing
nothing at all. What an unmatched throw *means* is the caller's to decide,
because a catch list is one rung of a scope ladder: a route's entries, then its
router's, then its server's. Deciding it here rendered a fixed 500 from inside a
shared library, which both swallowed the error and made every outer rung
unreachable, since nothing ever escaped the innermost one.

So a caller that has no further rung must render the last resort itself:

```ts
if (!(await dispatchCatches(entries, error, requestContext, accept, ctx, validate, sink))) {
  reply.code(500);
  reply.header("Content-Type", "application/json");
  reply.send(errorEnvelope(error));
}
```

`errorEnvelope(error)` is exported for exactly this: it is the
`{error: {code, message, data}}` body this module used to produce internally, so
a transport that renders it on decline is byte-identical to the old behaviour.

**Plain errors never reach either function.** A non-`InvokeError` has no
`error.code` for a `when:` to key on, so a transport hands those to its own
default error path.

**Catches are buffer-mode only.** By the time a catch fires the response is
committed pre-stream, so there is no upstream iterable to feed an encoder;
`mode: stream` is a `returns:` shape only.

## Where the details live

The authoring-level documentation — the `content` map, Accept negotiation,
stream-mode encoders, the catch ladder and its coverage rules — is in
[`modules/http-server/docs/returns-and-catches.md`](../http-server/docs/returns-and-catches.md),
beside the kinds that expose these shapes to a manifest author.
