# http-dispatch

The canonical HTTP response value-shapes, the dispatcher that renders them, and
the cookie declarations a response sets.

It is a **schema carrier** plus a small runtime library, shared by every
HTTP-shaped transport so that the entry shape, the MIME negotiation rules, the
buffer/stream split and the cookie rules live in one place rather than once per
transport. Its only instantiable kinds are the cookie declarations.

## What it publishes

- **`HttpDispatch.Outcomes`** — `$defs/Returns` and `$defs/Catches`, the response
  rendering lists. A transport anchors its own slots at them with
  `x-telo-schema-from`, so `Http.Api`'s routes, `Http.Server`'s `notFoundHandler`
  and both scope-level catch lists all validate against the same entries.
- **`HttpDispatch.Request`** — `$defs/Matcher`, the canonical request matcher
  (`method` + `path`, with an optional `schema` block of `params`, `query`,
  `body`, `headers` and `cookies`), and `$defs/Hostname`,
  one entry of a host matcher: a `!ref` to a `Telo.PublicUrl` or
  `Telo.PublicHostPattern` need, never a domain name. `Http.Server`'s
  `mounts[].hostnames` anchors at it, so every HTTP transport reads the same
  matcher with the same meaning.

Both are `capability: Telo.Type`: they are never instantiated.

- **`HttpDispatch.Cookie`** — the abstract every cookie declaration extends, and
  the kind an entry's `cookies[].cookie` slot takes. Its kinds `HostCookie`
  (`__Host-<name>`), `SecureCookie` (`__Secure-<name>`) and `UnprefixedCookie`
  are providers whose attributes are fixed at creation and refused as
  `SCHEMA_VIOLATION` where a browser would reject or weaken them. What each
  renders, and the rules, are in [cookie declarations](docs/cookie-declarations.md);
  how a server sets and reads them is in
  [`modules/http-server/docs/cookies.md`](../http-server/docs/cookies.md).

## Cookies

`Outcomes`' return and catch entries carry `cookies:`, a list of
`{ cookie, value?, maxAge?, expires? }`. `dispatchReturns` / `dispatchCatches`
read each declaration through the attribute record it publishes
(`CookieAttributes`: `name` as sent, prefix included, `secure`, `httpOnly`,
`sameSite`, `partitioned`, `domain` — null when host-only — and `path`), expand the
three per-response fields, and write the entry's lines as ONE
`setHeader("Set-Cookie", lines)` call. They never ask which kind declared a cookie,
so another implementation of `Cookie` needs only to publish the record as its
reading.

- `setCookieLine(attributes, { value, maxAge, expires })` — one `Set-Cookie` line.
  A max age of zero or less clears the cookie (`Max-Age=0`, a past `Expires`
  unless one is given, an empty value unless one is given). A value that is not
  RFC 6265 cookie-octets, or a max age or expiry of the wrong type, throws the
  `InvokeError` `ERR_COOKIE_VALUE_INVALID` (exported), naming the cookie.
- `parseCookieHeader(header)` — a `Cookie` request header as a map of name to
  value: the first occurrence of a name kept, values as written, no decoding. A
  transport binds it as `request.cookies` in every request context.

## The response sink

A transport writes a response through a `ResponseSink`: `setStatus`, `setHeader`,
then one `send(body?)` or `stream(iter, onError?)`. `setHeader(name, value)` is
last-write-wins; `value` is a string, or a list that is the header's complete set
of lines, written one line per member in order and never comma-joined — an empty
list removes the header. `runSinkContract(name, makeSink)` from
`@telorun/http-dispatch/test-utils` holds an implementation to all of it.

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

## The request scope

A transport hands every mount a `RequestScope` as the third argument of
`register(app, prefix, requestScope)`; `forRequest(request)` returns the
request's `RequestTrace`:

- `context` — the request span's context, carrying its cancellation.
- `lang` — the negotiated language; reading it makes the response vary by it.
- `tls` — `{ protocol }` (a `RequestTls`) for a request on a TLS socket, `null`
  on a plain one. It describes the socket only.
- `clientCertificate` — the `ClientCertificate` the listener received or a
  trusted proxy forwarded, `null` when there is none: `subject` / `issuer`
  (attribute to value), `serialNumber`, `fingerprint256`, `validFrom` /
  `validTo` (CEL timestamps), `subjectAltNames`, `pem`, `verified` (true only
  when the listener validated the chain) and `via` (`listener` | `proxy`).
- `reject(error)` — report the error that decided the response.

A mount binds `tls` and `clientCertificate` into its `request` CEL contexts
from here, so the transport alone decides where they come from.

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
