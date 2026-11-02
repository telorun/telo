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

- **Declaring cookies on a route.** The canonical request carrier (`HttpDispatch.Request`,
  `$defs/Matcher`) gains `schema.cookies`, declared the same way as `query` or `headers`.
  - It types `request.cookies.<name>` through the existing `request/schema` context merge.
  - The OpenAPI document renders it as `in: cookie` parameters.
  - A route that declares no cookies reads `request.cookies` as a map of string to string.
- **Reading cookies.** Every `request` context of `Http.Server` and `Http.Api` carries
  `cookies` beside `headers`: route `inputs:`, `returns:`, `catches:`, scope-level catches,
  the not-found handler's `inputs:`, and `preferredLanguages`.
  - Parsing follows RFC 6265: the first occurrence of a name wins, and values are passed
    through as written, with no decoding.
  - When `preferredLanguages` reads a cookie, `Cookie` is added to the response's `Vary`, the
    same way a header it reads is.
- **Setting cookies.** The canonical outcome carrier (`HttpDispatch.Outcomes`, both
  `$defs/Returns` and `$defs/Catches`) gains `cookies:` on an entry. It maps a cookie name to
  one of two forms, and each cookie becomes one `Set-Cookie` header. Cookies sit at entry
  level only, because a cookie does not vary by negotiated MIME type.
  - **Value form:** `{ value, maxAge?, expires?, domain?, path?, secure?, httpOnly?, sameSite?,
    partitioned? }`.
    - Only `value`, `maxAge` (a `Telo.Duration`, rendered as whole seconds) and `expires` (a
      `Telo.Timestamp`) may be computed.
    - Every other attribute is a literal, so the rules below can judge it statically.
  - **Clear form:** `{ clear: true, domain?, path?, secure? }`. It renders an empty value with
    `Max-Age=0`, a past `Expires` and the same scope, so the browser actually drops the cookie.
    That includes a `__Host-` cookie, which needs `Secure` even when it is being deleted.
- **Secure defaults:** `secure: true`, `httpOnly: true`, `sameSite: Lax`, `path: /`. A cookie
  that scripts must read says `httpOnly: false` explicitly.
- **Computed values must be legal.** A computed `value` that is not RFC 6265 cookie-octets
  fails the response the same way a body that fails its `schema` does. The error is
  `ERR_COOKIE_VALUE_INVALID`, naming the cookie. Nothing is escaped silently: an author who
  needs arbitrary bytes encodes them, for example with base64url.
- **Raw headers are refused.** `Set-Cookie` in `headers:` (entry level or per MIME type) is
  refused because the raw string bypasses the checked shape.
  - The refusal is a `propertyNames` exclusion in the carrier schema, so it is a
    `SCHEMA_VIOLATION` at check and at creation alike.
  - `Content-Type` joins the same exclusion. Its existing refusal is runtime-only, so this
    gives it the static twin it lacks.
- **Static rules.** These are `x-telo-resource-rules` on `Http.Api` and `Http.Server`,
  reported as `RESOURCE_RULE_VIOLATED`, each twinned in the controller as `ERR_<code>`:

  | Code | Refuses |
  | --- | --- |
  | `COOKIE_NAME_INVALID` | A name that is not an RFC 6265 token. |
  | `COOKIE_HOST_PREFIX` | A `__Host-` cookie without `secure`, with a `path` other than `/`, or with a `domain`. |
  | `COOKIE_SECURE_PREFIX` | A `__Secure-` cookie without `secure`. |
  | `COOKIE_SAMESITE_NONE_INSECURE` | `sameSite: None` without `secure`. |
  | `COOKIE_PARTITIONED_INSECURE` | `partitioned: true` without `secure`. |

- **No dependency.** The cookie shape belongs to the transport-neutral carrier, and parsing
  and serializing are a page of code. Both live in `@telorun/http-dispatch` beside the
  request scope, so another HTTP transport gets them unchanged.
- **OpenAPI.** An entry with `cookies:` documents a `Set-Cookie` response header.

**Verify.**

- `modules/http-server/tests/cookies.yaml`:
  - A route sets two cookies and clears one, and the response's `set-cookie` headers are
    asserted as exact strings, defaults included.
  - A second request carrying `Cookie:` reads `request.cookies.session` into its handler.
  - A duplicated name yields the first occurrence.
  - A computed value holding `;` fails with `ERR_COOKIE_VALUE_INVALID`.
- `modules/http-server/tests/cookie-rules.yaml`:
  - Each of the five codes is refused at a declaring manifest through `Assert.Manifest`, and
    the same manifest's `runFails:` shows the controller twin.
  - `Set-Cookie` and `Content-Type` in `headers:` are both refused as `SCHEMA_VIOLATION`.
- An OpenAPI assertion shows an `in: cookie` parameter and a `Set-Cookie` response header.
- `request-language.yaml` gains a case where `preferredLanguages` reads `request.cookies.lang`
  and the response carries `Vary: Cookie`.

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
- An empty `username`, or one containing `:`, is `ERR_INVALID_CREDENTIAL`. An empty password
  is legal.
- `forceRefresh` returns the same material, as the other three do.
- Basic authentication is what `sms-twilio` and the phase-6 Basic module need.

**Verify.** `modules/http-client/tests/basic-auth.yaml`:

- An `Http.Server` in `with:` echoes the `authorization` header it received, and the test
  asserts the exact string, including a non-ASCII password.
- An empty username fails with `ERR_INVALID_CREDENTIAL`.

## Cross-cutting

- **Releases.**
  - `http-server`, `http-client` and `http-dispatch` each take a `telo release add` fragment,
    one per module and each body naming only that module's own changes.
  - `@telorun/http-dispatch` (a published TS contract) also takes a changeset.
  - `http-server` is bundled, so it takes no changeset.
- **Floors.** All of the new syntax is ordinary schema properties, enums and resource rules
  in the modules' own artifacts, so no floor is expected. This is confirmed by running the
  previous published CLI against each changed `telo.yaml`, per the grammar-change rule.
- **Docs.**
  - New `modules/http-server/docs/cookies.md`.
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
