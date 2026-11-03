---
status: done
priority: high
depends-on: []
packages: [modules/http-dispatch, modules/http-server, modules/http-client, apps/authoring-agent, docs]
---

# HTTP transport: cookies, TLS finish, client certificates, Basic credentials

The transport track of phase 0 in `plans/identity-and-access.md`. These are the HTTP pieces
every later authentication module builds on: a session cookie, a client certificate the
handler can read, and a Basic credential on the outbound side.

## Already shipped (the starting point)

- `Http.Server.tls`: `cert` and `key` (`{ pem }` or `{ file }`), `passphrase`, `clientCa`,
  `clientCertificate: none | required`. With it the listener serves HTTPS and the started
  record reports `url.scheme: https`. Bad material fails creation with `ERR_HTTP_TLS_INVALID`.
  Covered by `modules/http-server/tests/tls-serving.yaml` and `docs/tls.md`, with fixtures in
  `tests/__fixtures__/tls/`.
- `Http.Client.tls`: `ca`, `caMode: replace | add`, `cert`, `key`, `passphrase`,
  `serverName`, `insecureSkipVerify`. Covered by `modules/http-client/tests/http-client-tls.yaml`
  and `docs/tls.md`.

Where the earlier draft used different names, the shipped names win: `clientCa` (not `ca`),
`{ file }` (not `certFile`), `serverName` (not `servername`), and `insecureSkipVerify` (not
`rejectUnauthorized`).

## 1. Cookies

**Before.** No CEL context has a `request.cookies`. The `Cookie` header can only be read as
one raw string under `request.headers`. A response can set a cookie only by writing a raw
`Set-Cookie` string into `headers:`, and nothing checks its attributes. `preferredLanguages`
has to parse the header to read a language cookie.

**After.**

- **Declaring a cookie.** `http-dispatch` gains the abstract `HttpDispatch.Cookie` and three
  provider kinds extending it. Every attribute is compile-eval, so a declaration reads
  literals, `variables` and `secrets`, never the request, and a computed attribute is held to
  the kind's rules when the declaration is created.
  - Common keys: `name` (an RFC 6265 token, refusing a leading `__Host-` / `__Secure-` in any
    letter case), `httpOnly` (default `true`), `sameSite` `Strict | Lax | None` (default
    `Lax`), `partitioned` (default `false`).
  - `HostCookie` takes nothing more and renders `__Host-<name>`, `Secure`, `Path=/`, no
    `Domain`.
  - `SecureCookie` adds `domain?` and `path` (default `/`) and renders `__Secure-<name>` with
    `Secure`.
  - `UnprefixedCookie` adds `domain?`, `path` (default `/`) and `secure` (default `true`);
    `sameSite: None` and `partitioned: true` each require `secure` to stay true.
  - `domain` and `path` are typed by one exported named shape,
    `HttpDispatch.CookieAttributeValue` (printable ASCII without `;`); `path` starts with `/`.
  - Every constraint is plain JSON Schema on the kind, so `telo check` and the kernel both
    refuse a bad declaration as `SCHEMA_VIOLATION`. There are no resource rules and no
    cookie-specific codes.
  - Each kind's controller (in the module's own bundle) publishes the full normalized
    attribute record — `name` as sent, prefix included, `secure`, `httpOnly`, `sameSite`,
    `partitioned`, `domain` (null when host-only), `path` — with the schema defaults filled.
    The dispatcher renders from that record and never asks which kind declared the cookie.
- **Setting and clearing.** `HttpDispatch.Outcomes`' `$defs/Returns` and `$defs/Catches`
  entries gain `cookies:`, a list of `{ cookie, value?, maxAge?, expires? }`.
  - `cookie` is `x-telo-ref: { kind: Self.Cookie, use: dependency }`; it resolves to
    `HttpDispatch.Cookie` from the carrier transplanted into `Http.Api` and `Http.Server`, at
    check and at run time alike. It is written inline when one entry uses it.
  - Only `value`, `maxAge` (a `Telo.Duration`, sent as whole seconds) and `expires` (a
    `Telo.Timestamp`, sent as an HTTP date) vary per response.
  - Each cookie is one `Set-Cookie` line, in written order; the same declaration listed twice
    is written twice.
  - Clearing is `maxAge` of zero or less on the same declaration: an empty value unless one
    is given, `Max-Age=0`, and a past `Expires` unless one is given, under the declaration's
    own scope, so the browser drops it.
  - A literal `value` must be cookie-octets (refused statically). A computed one that is not
    fails the response with `ERR_COOKIE_VALUE_INVALID`, naming the cookie. Nothing is escaped
    silently.
- **The sink.** `ResponseSink.setHeader(name, value: string | readonly string[])`. A list is
  the header's complete set of lines in order, replaces any earlier value, is never
  comma-joined, and an empty list removes the header. The dispatcher writes an entry's
  cookies as one list call. The Fastify sink removes the header before setting it, because
  Fastify appends to an existing `Set-Cookie`.
- **Reading cookies.** Every `request` context of `Http.Server` and `Http.Api` carries
  `cookies` beside `headers`: route `inputs:`, `returns:`, `catches:`, scope-level catches, a
  guard's `inputs:` and `catches:`, the not-found handler and `preferredLanguages`.
  - Parsing follows RFC 6265: the first occurrence of a name wins, and values are passed
    through as written, with no decoding.
  - A route that declares no cookies reads `request.cookies` as a map of string to string.
  - `HttpDispatch.Request`'s `$defs/Matcher` gains `schema.cookies`. It types
    `request.cookies.<name>` through the `request/schema` context merge, and the OpenAPI
    document renders it as `in: cookie` parameters.
  - Fastify validates no cookies, so `Http.Api` validates `schema.cookies` itself with a
    text-coercing validator, as a query is read. A refused cookie is answered 400
    `ERR_INPUT_INVALID` with a finding at `/cookies/<name>`.
  - When `preferredLanguages` reads `request.cookies`, `Cookie` joins the response's `Vary`.
- **Raw headers are refused.** `headers:` (entry level and per MIME type) excludes `Set-Cookie`
  and `Content-Type` through `propertyNames`, reported by `telo check` as
  `DEPENDENT_SCHEMA_MISMATCH`. `Http.Api`'s creation-time header check refuses both too, for a
  dependency's routes, which the consumer's check does not judge.
- **OpenAPI.** An entry with `cookies:` documents a `Set-Cookie` response header on its status,
  added through the route's own `swaggerTransform`, so the schema Fastify serializes with is
  untouched.
- **No floor.** The previous published CLI (0.128.0) reads `http-dispatch`'s and
  `http-server`'s manifests (`requires:` stripped) with no issue, and loads the cookie
  controllers. `http-server` keeps its existing `>=0.129.0`.

**Verify.**

- `modules/http-dispatch/tests/cookie-declarations.yaml`: through `Assert.Manifest`, each
  refused by `telo check` and by the run — a `HostCookie` with `domain`; an `UnprefixedCookie`
  with `sameSite: None, secure: false`; a name holding `;`; an `UnprefixedCookie` named
  `__host-x`; an attribute reading `request` (`CEL_UNKNOWN_IDENTIFIER`).
- `modules/http-server/tests/cookies.yaml`: exact `Set-Cookie` strings, defaults included, for
  a computed `HostCookie` value, a `SecureCookie` with domain, path, `maxAge` and `expires`,
  its clear (byte-identical `Domain` / `Path` / `Secure`), and an inline `UnprefixedCookie`; a
  request reading `request.cookies.session` with a repeated name yielding the first; a missing
  declared cookie answered 400 at `/cookies/session`; a computed value holding `;` answered
  500 `ERR_COOKIE_VALUE_INVALID`; the OpenAPI document's `in: cookie` parameter and
  `Set-Cookie` response header.
- `request-language.yaml`: `preferredLanguages` reading `request.cookies.lang`, with
  `Vary: Accept-Language, Cookie`.
- Unit: the dispatcher writes two set cookies and one cleared as three exact lines in written
  order (`dispatch.test.ts`); `runSinkContract` holds every sink to a list written as N lines
  in order, a later string replacing a list, an empty list removing the header and no
  comma-joining (in-memory and Fastify sinks); each cookie controller fills its kind's schema
  `default:`s (`cookie-defaults.test.ts`).
- `Http.Client` returns one value per response header, so a manifest test cannot see more
  than one `Set-Cookie` line; the multi-line response is proven at the dispatcher and sink
  level above.

## 2. Finishing TLS and client certificates on `Http.Server`

**Before.**

- `clientCertificate` is `none` or `required`. There is no mode that asks for a certificate
  and continues without one.
- There is no `minVersion`.
- A handler cannot see whether the connection was TLS, or who the client certificate names.
- A certificate forwarded by a TLS-terminating proxy cannot be read at all.
- The fixture directory has no README.

**After.**

- **`clientCertificate: none | optional | required`.**
  - `optional` (nginx's word for the same mode) asks for a certificate. The handshake
    completes when the client presents none, or presents one whose chain fails against
    `clientCa`, and the result is recorded instead.
  - `optional` needs `clientCa`, as `required` does, and `clientCa` needs one of the two.
    This is the existing pairing check, widened.
- **`tls.minVersion: TLSv1.2 | TLSv1.3`**, default `TLSv1.2`.
- **`request.tls`** in every `request` context: `null` on a plain socket, otherwise
  `{ protocol }`. It describes this socket only.
- **`request.clientCertificate`** in every `request` context.
  - It is `null`, or `{ subject, issuer, serialNumber, fingerprint256, validFrom, validTo,
    subjectAltNames, pem, verified, via: listener | proxy }`.
  - `subject` and `issuer` are maps of attribute to value (`CN`, `O`, …), and `validFrom` and
    `validTo` are `Telo.Timestamp`.
  - `verified` is true only when this listener validated the chain against `clientCa`.
  - The certificate is a top-level member rather than part of `request.tls` because behind a
    terminating proxy there is a certificate but no TLS socket. A consumer reads one place
    whichever way the certificate arrived.
- **`forwardedClientCertificate: { header, format: xfcc | pem | base64-der }`** on
  `Http.Server`, beside `trustProxy`.
  - It reads a certificate forwarded by a fronting proxy: Envoy's
    `x-forwarded-client-cert`, nginx's URL-escaped PEM, or Traefik's base64 DER.
  - It is a top-level field rather than part of `tls:`, because the proxy case is exactly the
    one where the server has no `tls:`.
  - Declaring it without `trustProxy` is `HTTP_FORWARDED_CERTIFICATE_UNTRUSTED`, a resource
    rule twinned at creation, so a client-supplied header is never parsed unguarded.
  - A forwarded certificate is `verified: false, via: proxy`. A header that fails to parse
    yields `null`, and the request is not refused.
  - When the listener also validated a certificate of its own, the listener's certificate
    wins.
  - Validating a forwarded certificate against the application's CAs belongs to `auth-mtls`
    in phase 6.
- **A module-owned listener.** Every `Http.Server` accepts connections on a `net` or `tls`
  listener it owns and hands each to HTTP once its TLS handshake completes, so `request.tls`
  and `request.clientCertificate` read the same on Node and Bun. A TLS connection closed
  before it is served (a handshake error, the handshake timeout, a peer hanging up, a
  certificate refused under `required`) is logged as `http.server.tls_handshake.failed`, and
  stopping closes idle and handshaking connections at once and each busy one after its
  response, running the app's close hooks while it waits, so a hook ending a long-lived
  response lets the stop finish. A hostname `listen.address` (`localhost`) is bound on every
  address it resolves to on one port; an address the host has no interface for is skipped and
  logged as `http.server.address_unavailable`.
- **Fixture README.** `tests/__fixtures__/tls/` gains a README saying the PEMs are test
  fixtures, with how they were generated and their validity.

**Verify.**

- `tls-serving.yaml` gains a `minVersion: TLSv1.3` server whose handler reads
  `request.tls.protocol` back as `TLSv1.3`, and a plain server reading `request.tls` as `null`.
- `modules/http-server/tests/client-certificate.yaml`:
  - Under `required`, a client with the fixture certificate reads its own `subject.CN` back,
    with `verified: true, via: listener`.
  - Under `optional`, a client without a certificate gets `null`, and the rogue client gets its
    certificate with `verified: false`.
  - A client without a certificate fails the handshake under `required`. This is already
    covered and is kept.
- `modules/http-server/tests/forwarded-client-certificate.yaml`:
  - Under `trustProxy`, each of the three formats is parsed from a header the test sends.
  - A malformed header yields `null`.
  - Declaring the field without `trustProxy` is refused at check through `Assert.Manifest`,
    with its `runFails:` twin.

## 3. `Http.BasicAuth`

**Before.** `Http.Client` has three static credentials: `BearerToken`, `ApiKeyHeader` and
`QueryKey`. Basic authentication means building the header by hand.

**After.**

- `Http.BasicAuth` is a fourth static `Http.Credential`, with `username` and `password` (both
  compile-eval, normally from `secrets:`).
- It renders `Authorization: Basic <base64(username:password)>`, encoding the text as UTF-8
  per RFC 7617.
- An empty `username`, or one containing `:`, is a `SCHEMA_VIOLATION` from `telo check` and at
  creation; a computed one is refused when the credential is created. An empty password is
  legal.
- `forceRefresh` returns the same material, as the other three do.
- Basic authentication is what `sms-twilio` and the phase-6 Basic module need.

**Verify.** `modules/http-client/tests/basic-auth.yaml`:

- An `Http.Server` in `with:` echoes the `authorization` header it received, and the test
  asserts the exact string, including a non-ASCII password.
- An empty and a colon-bearing username are refused through `Assert.Manifest` with their
  `runFails:` twins, and a computed colon-bearing one is refused at creation.

## Cross-cutting

- **Releases.**
  - `http-server`, `http-client` and `http-dispatch` each take a `telo release add` fragment,
    one per module and each body naming only that module's own changes.
  - No changesets: `@telorun/http-dispatch` is module-owned (in `.changeset/config.json`'s
    `ignore`, its version its module's), and `http-server` and `http-client` are bundled.
- **Floors.** All of the new syntax is ordinary schema properties, enums and resource rules
  in the modules' own artifacts, so no floor is needed beyond `http-server`'s existing one.
  This is confirmed by running the previous published CLI against each changed `telo.yaml`,
  per the grammar-change rule.
- **Docs.**
  - New `modules/http-server/docs/cookies.md` and `modules/http-dispatch/docs/cookie-declarations.md`.
  - `docs/tls.md` gains `optional`, `minVersion`, `request.tls`, `request.clientCertificate`
    and `forwardedClientCertificate`.
  - `returns-and-catches.md` gains `cookies:` and the `Set-Cookie` prohibition.
  - `request-language.md` gains reading a language cookie through `request.cookies`.
  - The `http-server`, `http-dispatch` and `http-client` READMEs are updated, and
    `http-client` documents `BasicAuth`.
- **Authoring agent.** The primer's HTTP section learns `request.cookies`, `cookies:` on an
  entry, `request.tls`, `request.clientCertificate`, `tls:` and `forwardedClientCertificate`
  on the server, and `Http.BasicAuth`.
- **Benefits ledger.** Under Standard library → HTTP:
  - Cookies with checked, secure-by-default attributes.
  - HTTPS and mutual TLS with the client certificate readable in handlers.
- **Not in this plan.** These belong to phase 1: an authentication seam,
  `request.principal`, and changes to `Mcp.HttpEndpoint`.
