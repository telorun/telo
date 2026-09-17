# Identity & access — phase 0: transport-neutral primitives

Phase 0 of `plans/identity-and-access.md`. Nothing here is authentication; it is what every
authentication module in the later phases composes over, and it is deliberately useful on its
own — a signed webhook, an encrypted cookie, a transactional email, an HTTPS listener.

## Problem

- **No crypto surface.** Random tokens, digests, HMAC, constant-time comparison and password
  hashing exist only as private code inside four controllers (`oauth-client`'s PKCE, the key/value
  stores' ids, `lease`'s claims). A manifest cannot hash a password, and the next module that needs
  it would grow a fifth private copy.
- **No JOSE.** Nothing signs or verifies a JWT, publishes a JWKS, rotates a signing key or seals a
  value. `oauth-client` stores an ID token "verbatim and otherwise untouched", because nothing can
  check it.
- **No way to deliver a message.** Verification, reset, magic links, one-time codes and invitations
  all send an email or an SMS; no module can.
- **The HTTP transport cannot carry the auth material.** `Http.Server` / `Http.Api` expose no
  cookies in either direction, so a session cannot be set or read; `Http.Server` has no TLS, so
  there is no client certificate; `Http.Client` cannot trust a private CA or present a client
  certificate, and has no Basic credential.

## Solution, in one paragraph

Four new bundled modules — `crypto`, `jose`, `mail` (+ `mail-resend`), `sms` (+ `sms-twilio`)
— each a kind library for manifests AND, where a sibling controller needs it, a code library
through `exports.code:`; plus cookies, TLS and client certificates on the HTTP transport,
declared once in `http-dispatch`'s carrier and served by `http-server`, with the outbound
twin on `http-client`. Every secret that crosses a contract is `x-telo-sensitive`; every
secret that sits in configuration comes from `secrets:`, which the resource-created scrub
already covers.

## Sequencing

Three independent tracks; each lands with its tests, docs and release fragment:

1. **Transport** — cookies (`http-dispatch` + `http-server`), then TLS and client
   certificates (`http-server`), then outbound TLS and `Http.BasicAuth` (`http-client`).
2. **Keys** — `crypto`, then `jose` (which uses `@telorun/crypto` for key derivation).
3. **Delivery** — `mail`, `mail-resend`, `sms`, `sms-twilio`.

## 1. Transport

### 1.1 Cookies

**Before.** `request.cookies` does not exist in any CEL context; a `Cookie` header is reachable
only as the raw string under `request.headers`; a response can set a cookie only by writing a
raw `Set-Cookie` string into `headers:`, with no attribute checking.

**After.**

- The canonical request carrier (`HttpDispatch.Request`, `$defs/Matcher`) gains
  `schema.cookies`, so a route declares the cookies it reads exactly as it declares `query` or
  `headers`; they type `request.cookies.<name>` through the existing `request/schema` context
  merge and render into the OpenAPI document as `in: cookie` parameters. Every `request`
  context `Http.Server` and `Http.Api` expose (route `inputs:`, `returns:`, `catches:`, the
  not-found handler's `inputs:`) carries `cookies` beside `headers`, parsed per RFC 6265 —
  first occurrence of a name wins, values opaque.
- The canonical outcome carrier (`HttpDispatch.Outcomes`, `$defs/Returns` and `$defs/Catches`)
  gains `cookies:` on an entry — a map from cookie name to either a value form
  `{ value, maxAge?, expires?, domain?, path?, secure?, httpOnly?, sameSite?, partitioned? }`
  or a clear form `{ clear: true, path?, domain? }`, which renders `Max-Age=0` with the same
  scope so the browser actually drops it. Each cookie becomes one `Set-Cookie` header. Entry
  level only — a cookie does not vary by negotiated MIME.
- **Defaults are the secure ones**: `secure: true`, `httpOnly: true`, `sameSite: Lax`,
  `path: /`. A cookie scripts may read says `httpOnly: false` explicitly.
- **`Set-Cookie` is forbidden in `headers:`**, the `Content-Type` precedent: the raw string
  bypasses the checked attribute shape.
- **Static rules**, declared as `x-telo-resource-rules` on `Http.Api` and `Http.Server`
  (reported as `RESOURCE_RULE_VIOLATED` with the rule in `data.rule`): `COOKIE_NAME_INVALID`
  (not an RFC 6265 token), `COOKIE_HOST_PREFIX` (`__Host-` requires `secure`, `path: /` and no
  `domain`), `COOKIE_SECURE_PREFIX` (`__Secure-` requires `secure`),
  `COOKIE_SAMESITE_NONE_INSECURE` (`sameSite: None` requires `secure`).
- No dependency: the shape belongs to the transport-neutral carrier, and parsing plus
  serializing a cookie is a page of code. A Fastify cookie plugin would put the shape on the
  one side of the boundary no other transport reaches.

**Verify.** `modules/http-server/tests/cookies.yaml`: a route sets two cookies and clears one;
the response's `set-cookie` headers are asserted as exact strings; a second request carrying
`Cookie:` reads `request.cookies.session` into its handler. `modules/http-server/tests/cookie-rules.yaml`
asserts the four rule codes through `Assert.Manifest`.

### 1.2 TLS and client certificates on `Http.Server`

**Before.** The listener is plain HTTP; the started record hardcodes `url.scheme: http`;
`trustProxy` derives `request.ip` and the forwarded scheme and host, nothing more.

**After.**

- `tls:` on `Http.Server` (compile-eval): `cert`, `key`, `ca` as PEM strings, or `certFile`,
  `keyFile`, `caFile` as host paths read once at `init()` (the mounted-secret shape on
  Kubernetes); `passphrase`; `minVersion: TLSv1.2 | TLSv1.3` (default `TLSv1.2`);
  `clientCertificate: none | request | require` (default `none` — `request` asks and continues
  when the client presents none or the chain fails, recording the result; `require` refuses the
  handshake unless the chain validates against `ca`). The key comes from `secrets:` (a literal
  key in a manifest is the author's own decision; the created-event scrub covers a declared
  secret and nothing covers a literal).
- With `tls:` present the listener speaks HTTPS, and the started record reports
  `url.scheme: https`. `baseUrl`, `trustForwardedHeaders` and the OpenAPI `servers` derivation
  are unchanged: the advertised URL was always independent of the socket's scheme.
- `request.tls` in every `request` context: `null` on a plain socket, otherwise
  `{ protocol, clientCertificate }`, where `clientCertificate` is `null` or
  `{ subject, issuer, serialNumber, fingerprint256, validFrom, validTo, subjectAltNames, pem,
  verified, via: listener | header }`. `verified` is true only when THIS listener validated the
  chain.
- `tls.clientCertificateHeader: { name, format: xfcc | pem | base64-der }` reads a certificate a
  fronting proxy forwarded (Envoy's `x-forwarded-client-cert`, nginx's escaped PEM, Traefik's
  base64 DER), honoured **only under `trustProxy`** — otherwise a client-supplied header is
  ignored, never parsed. A header-delivered certificate is `verified: false, via: header`;
  validating it against the application's own CAs is `auth-mtls`'s job in phase 6, which must
  do so for the listener-delivered one as well.

**Verify.** A committed test-only PEM set under `modules/http-server/tests/__fixtures__/tls/`
(a CA, a `localhost` server certificate, a client certificate; long validity; a README saying
they are fixtures). `tests/tls.yaml`: an `Http.Server` with `tls:` in `with:`, an `Http.Client`
trusting the fixture CA, a 200, and the `http.server.started` record asserting `url.scheme: https`.
`tests/client-certificate.yaml`: `clientCertificate: require` — a client with the fixture
certificate reads its own `subject.CN` back through `request.tls`; a client without one fails
the handshake. `tests/client-certificate-header.yaml`: an XFCC header is parsed under
`trustProxy` and ignored without it.

### 1.3 `Http.Client`: outbound TLS and Basic

**Before.** Requests use the platform `fetch` with its default trust store; there is no way to
trust a private CA, present a client certificate, or send a Basic credential except by
hand-building the header.

**After.** `tls: { ca, cert, key, rejectUnauthorized (default true), servername }` on
`Http.Client`, applied to every request through it (an agent built from those options, handed
to `fetch`); `key` from `secrets:`. `Http.BasicAuth` — a fourth static `Http.Credential`
(`username`, `password`) rendering `Authorization: Basic`; `forceRefresh` returns the same
material, as the other three do. Both are what the TLS tests above and the phase-6 mTLS and
Basic modules need on the client side.

**Verify.** `modules/http-client/tests/basic-auth.yaml` asserts the exact `authorization` header
a server in `with:` received; the TLS tests in 1.2 exercise `tls.ca` and `tls.cert` / `tls.key`.

## 2. Keys

### 2.1 `crypto` (`Crypto`)

**Before.** Private copies in four controllers; nothing reachable from a manifest.

**After.** Categories `[Security]`. Node's own primitives for random bytes, digests, HMAC,
scrypt, PBKDF2, HKDF and constant-time comparison; `hash-wasm` inlined for Argon2id and bcrypt —
pure JS with the WebAssembly embedded, so it bundles like everything else, where the `argon2`
package is a native addon esbuild cannot inline. A `pkg:cargo` candidate can join the
controller list later without changing the surface.

One operation per kind, all `Telo.Invocable`:

| Kind | Inputs → outputs |
| --- | --- |
| `Crypto.Random` | `{ bytes (default 32), encoding: hex \| base64url \| base64 }` → `{ value }` (sensitive: it is the next session id or API key) |
| `Crypto.Digest` | `{ algorithm: sha256 \| sha384 \| sha512, input, encoding }` → `{ value }` |
| `Crypto.Hmac` | `{ op: sign \| verify, algorithm, key (sensitive), input, encoding, expected? }` → `{ value }` / `{ valid }` — verification is constant-time |
| `Crypto.PasswordHash` | `{ op: hash \| verify, password (sensitive), hash? (sensitive) }` → `{ hash }` / `{ valid, rehash }`. Configured `algorithm: argon2id (default) \| bcrypt \| scrypt \| pbkdf2` with parameters and an optional `pepper` from `secrets:`; `verify` accepts every PHC / MCF encoding the module knows regardless of configuration, so imported hashes verify, and `rehash: true` says the stored hash is weaker than configured — the caller re-hashes on a successful login, which is the standard migration path. bcrypt refuses a password over 72 bytes (`ERR_PASSWORD_TOO_LONG`) rather than truncating silently |
| `Crypto.Compare` | `{ a, b }` (both sensitive) → `{ equal }` — constant-time; CEL's `==` is not |
| `Crypto.DeriveKey` | `{ secret (sensitive), salt, info, length }` → `{ key }` (sensitive), HKDF |

`exports.code: @telorun/crypto` carries the same operations as functions, so `api-key`,
`session`, `identity` and `jose` call them in-process rather than dispatching. Errors:
`ERR_CRYPTO_UNSUPPORTED_HASH` (a `verify` given an encoding the module does not know),
`ERR_PASSWORD_TOO_LONG`.

**Verify.** `modules/crypto/tests/password-hash.yaml` (hash then verify; wrong password;
a literal imported bcrypt hash verifies with `rehash: true`; the 72-byte refusal),
`hmac.yaml`, `random-digest.yaml`, `compare.yaml`.

### 2.2 `jose` (`Jose`)

**Before.** Nothing signs, verifies, encrypts or publishes keys.

**After.** Categories `[Security]`. The `jose` package (already in the lockfile through
`openid-client` and the MCP SDK; pure JS over WebCrypto) inlined. `exports.code: @telorun/jose`
carries the key-set instance contract a phase-5 authorization server and a phase-1 bearer
verifier call in-process.

- `Jose.Keys` (abstract, provider): something that yields verification keys.
- `Jose.KeySet` (extends `Keys`): the local signing key set, in one of two forms. **Managed**:
  `store: !ref KvStore.Store` + `wrapKey` (from `secrets:`), `algorithm` (`ES256` default;
  `RS256`, `EdDSA`, `HS256`), `rotation: { retireAfter }`. The set is one record in the store —
  current key id, every key with its wrapped private JWK, public JWK, creation time and
  retirement time — written with `compareAndSet` so two replicas rotating at once converge, the
  loser re-reading. Private material is wrapped under a key derived from `wrapKey` before it is
  stored, because a key/value store is shared infrastructure; the first key is generated on
  first use. **Static**: `keys:` (JWKs from `secrets:`), no store, no rotation — for a team
  whose keys come from outside.
- `Jose.RemoteKeySet` (extends `Keys`): `url` (a JWKS) or `issuer` (discovery → `jwks_uri`),
  `cacheTtl`, `timeout`; refetches on an unknown `kid` under a cooldown; fetched through the
  platform `fetch` as `oauth-client` does.
- `Jose.Sign` (`keys: !ref Jose.KeySet`; `type` — `JWT` default, `at+jwt`, `logout+jwt`;
  `issuer`, `audience`, `expiresIn`, `notBefore`): `{ claims, subject?, audience?, expiresIn?,
  jwtId?: auto }` → `{ token (sensitive), kid, expiresAt }`.
- `Jose.Verify` (`keys: !ref Jose.Keys`; `algorithms` — REQUIRED, no algorithm is ever taken
  from the token; `issuer`, `audience`, `type`, `clockTolerance`, `maxTokenAge`,
  `requiredClaims`): `{ token (sensitive), audience? }` → `{ valid: true, payload, header }` or
  `{ valid: false, reason: malformed | algorithm | unknownKey | signature | expired | notBefore |
  issuer | audience | type | claims }`. A refusal is a **returned outcome**, the `Callback`
  precedent — an authenticator renders it as 401, a sequence branches on it — and only an
  unreachable remote key set throws (`ERR_JOSE_REMOTE_KEYS_UNREACHABLE`).
- `Jose.Encrypt` / `Jose.Decrypt`: JWE compact, `A256GCM`, under a key derived from `secret:`
  (from `secrets:`) or a key set; `{ payload (sensitive) }` → `{ token (sensitive) }` and back
  to `{ valid, payload | reason }`. What a stateless encrypted cookie and a sealed pending record
  are made of.
- `Jose.Rotate` (`keys: !ref Jose.KeySet`): `{ force? }` → `{ rotated, currentKid, retiredKids }`
  — a new key becomes current, the previous one keeps verifying until `retireAfter` elapses,
  then leaves the set. Rotation is a **dispatch**, so the schedule is the consumer's:
  `Scheduler.Cron` invoking it.
- `Jose.PublicKeys` (`keys: !ref Jose.Keys`): `{}` → `{ keys }`, the public JWKS of the current
  and retiring keys — what an `Http.Api` route renders at `/.well-known/jwks.json`. An
  invocable rather than the provider's value because the value is taken once at init and keys
  rotate afterwards.

Errors: `ERR_JOSE_KEYSET_UNAVAILABLE` (store unreachable, or a wrapped key that will not unwrap —
the `wrapKey` changed), `ERR_JOSE_REMOTE_KEYS_UNREACHABLE`, `ERR_JOSE_ALGORITHM_UNSUPPORTED`.

**Verify.** `modules/jose/tests/sign-verify.yaml` (static keys), `verify-outcomes.yaml`
(expired, wrong audience, `alg: none`, an HS256 token against an asymmetric key — every reason
asserted by name), `rotate.yaml` (a managed set over `KvStoreMemory.Store`: sign under the
first key, rotate, sign under the second, both verify, retire, the first reports `unknownKey`),
`encrypt-decrypt.yaml`, `remote-keyset.yaml` (an `Http.Server` in `with:` serving
`Jose.PublicKeys`; a `Jose.RemoteKeySet` pointed at it verifies, and refetches on a rotated
`kid`).

## 3. Delivery

### 3.1 `mail` (`Mail`) and `mail-resend`

**After.** `Mail.Transport` (abstract, invocable): `{ from?, to, cc?, bcc?, replyTo?, subject,
text?, html?, headers?, attachments? }` → `{ messageId, accepted, rejected }`; an address is a
string or `{ name, address }`. `Mail.Smtp` implements it over `nodemailer` (pure JS, inlined):
`host`, `port`, `secure`, `starttls: require | opportunistic | never`, `auth` from `secrets:`,
`from` default, `pool`, `timeout`; the pooled transport is closed by the inverse of the
`init()` effect, so the module declares `requires: telo: ">=0.82.0"`. `Mail.Capture` implements
it by recording, and `Mail.CaptureRead` reads the record back — the transport every later
phase's tests send through. `mail-resend` is the precedent for an HTTP provider: one
template-form kind extending `Mail.Transport` whose body is an `Http.Request` with `inputs:`
mapping the message to the provider's JSON and `result:` mapping the response back; no
controller. SendGrid, Postmark and Mailgun follow the same shape when wanted; SES waits for
request signing in phase 6.

Message templating — subjects and bodies per language — is a later phase's concern
(`passwordless`, i18n); phase 0 delivers what it is handed.

**Verify.** `modules/mail/tests/capture.yaml`; `modules/mail-resend/tests/send.yaml` with an
`Http.Server` in `with:` standing in for the provider and asserting the request body it
received. SMTP against a real receiver runs under `modules/mail/tests/integration/`
(`SMTP_HOST` / `SMTP_PORT`), outside the root suite.

### 3.2 `sms` (`Sms`) and `sms-twilio`

**After.** `Sms.Transport` (abstract, invocable): `{ to (E.164), from?, text }` →
`{ messageId, status: queued | sent }`; `Sms.Capture` + `Sms.CaptureRead`. `sms-twilio` is one
template-form kind over `Http.Request` through an `Http.Client` carrying `Http.BasicAuth`
(account SID / auth token from `secrets:`).

**Verify.** `modules/sms/tests/capture.yaml`; `modules/sms-twilio/tests/send.yaml` against a
stand-in server, asserting the form body and the Basic header.

## Cross-cutting

- **Packaging**: each new module is `modules/<name>/telo.yaml` + a private `nodejs/` build
  package + `tests/*.yaml` + `README.md` + `docs/`, controllers as one `pkg:telo/local/js`
  bundle per module with one `#fragment` per kind. New rows in `modules/README.md` under a
  `Security` section (`crypto`, `jose`) and a `Messaging` section (`mail`, `sms` and their
  providers).
- **Releases**: new modules and `http-client` take `telo release add` fragments only;
  `http-server` (`pkg:npm`-delivered) and `http-dispatch` (a published TS contract) take a
  changeset each as well.
- **Floors**: `mail` declares `telo: ">=0.82.0"` for its effect chain. `crypto` and `jose`
  declare `telo: ">=<the release carrying sensitive contract fields>"`, forward-declared per
  the grammar-change rule — their contracts mark tokens, passwords and keys, and an older
  runtime does not reject the annotation, it ignores it and puts the value on the debug wire.
  The rule's execution check will NOT show a rejection here; the floor is declared for the
  silent-leak failure, not a syntax one.
- **Docs**: `modules/http-server/docs/cookies.md` and `docs/tls.md`; `returns-and-catches.md`
  gains the `cookies:` entry and the `Set-Cookie` prohibition; `http-dispatch` and `http-client`
  READMEs; the authoring-agent primer's HTTP section learns `request.cookies`, `request.tls`,
  `cookies:` on a return entry and `tls:` on the server.
- **Out of phase 0**: no authentication seam, no `request.principal`, no change to
  `Mcp.HttpEndpoint` — all phase 1. `oauth-client` keeps its private PKCE code; moving it onto
  `@telorun/crypto` is an optional tidy-up, not a dependency.
