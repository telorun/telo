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
  (`method` + `path`, with an optional `schema` block), and `$defs/Hostname`,
  one entry of a host matcher: a `!ref` to a `Telo.PublicUrl` or
  `Telo.PublicHostPattern` need, never a domain name. `Http.Server`'s
  `mounts[].hostnames` anchors at it, so every HTTP transport reads the same
  matcher with the same meaning.

Both are `capability: Telo.Type`: they are never instantiated.

## Hostname matching

The library exports the one reading of a host matcher every transport applies,
so two transports cannot route one host differently:

- `normalizeRequestHost(host)` — a request's host as matched: lowercased, its
  port and a trailing dot dropped, an IPv6 literal kept in brackets.
- `isIpLiteral(host)` — whether a normalized host is IPv4 or bracketed IPv6.
- `hostnameMatcher(host)` / `hostnameMatcherOfOrigin(origin)` — the
  `HostnameMatcher` an exact host or a pattern (`*.a.example`, one or more whole
  labels; `*-a.example`, characters inside the first label) is, read from a
  host or from the origin a need's fulfilment holds.
- `hostnameClaim(matcher, host)` — how strongly a matcher claims a host:
  `Infinity` for an exact host, the literal suffix's length for a pattern,
  `undefined` for none. The strongest claim wins, which is the precedence: an
  exact host, then the longest pattern suffix.
- `sameHostnameMatcher(a, b)` and `describeHostnameMatcher(matcher)` — for
  refusing two entries that claim the same hosts, and naming one in a message.

What a transport does with a match — mounts, precedence classes,
`unknownHosts` — is in
[`modules/http-server/docs/host-routing.md`](../http-server/docs/host-routing.md).

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
  reply.header("Content-Type", PROBLEM_MEDIA_TYPE);
  reply.send(problemDetails(500, error));
}
```

**Every error is rendered as an RFC 9457 problem.** `problemDetails(status, failure?)`
renders one from a status and a coded failure (`{ code, data?, displayMessage? }`): `type`
is `about:blank`, `title` the registered reason phrase of the status (absent for an
unregistered one, never localized — `httpReasonPhrase(status)`), `status`, `detail` the
display message formatted in its own language with `data` as its values (present only when
there is one), `code`, and `data` unchanged (absent when there is none). Without a failure
it is the bare `{ type, title, status }` of an uncoded one. `PROBLEM_MEDIA_TYPE` is
`application/problem+json`. A failure's developer `message` is never part of a problem.

`dispatchCatches` binds `problem` — the default problem each entry renders, under that
entry's own status — beside `error` in every entry's CEL, its `when:` included. An entry
with no `body:` sends that problem as `application/problem+json`, the one key the `Catches`
schema lets omit `body:` (every other key requires it). An error is never refused
for `Accept`: an entry none of whose keys the header admits renders its first key.
`dispatchReturns` answers a `returns:` entry whose representations `Accept` refuses with a
406 problem, code `ERR_NOT_ACCEPTABLE` (exported), `data: { available }`.

The normative shape — every member, and when a transport answers with a problem — is in
[`modules/http-server/docs/returns-and-catches.md`](../http-server/docs/returns-and-catches.md#problem-details).

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
