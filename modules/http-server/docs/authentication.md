# Authentication and authorization

> Examples assume `http-server` is imported as `Http`, `auth-bearer` as `AuthBearer`, `auth-signature` as `AuthSignature`, `authz` as `Authz` and `jose` as `Jose`.

A mount entry's `authentication:` says who may call that mount's routes, and its `authorization:` whether a caller may do what the request attempts. Both work for every `Telo.Mount` — an `Http.Api`, an `Http.Static`, a third-party mount — because the server runs them before the mount sees the request.

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /api
    mount: !ref api
    authentication:
      verifiers:
        - verifier: !ref tokens
          from: { kind: Http.FromAuthorization, schemes: [Bearer, DPoP] }
        - verifier: !ref apiKeys
          from: { kind: Http.FromHeader, header: x-api-key, scheme: ApiKey }
    authorization:
      policy: !ref scopes
      action: !cel "request.method + ' ' + request.path"
  - path: /health
    mount: !ref health
    authentication: { anonymous: allow }
```

## Order per request

For a request that matches a mount's route, after CORS and before the body is parsed:

1. **Authentication** — the verifiers, in order. Where a source reads the body ([Signed requests](#signed-requests)), the body is read first. With a `throttle` ([Throttling sign-in per client](#throttling-sign-in-per-client)), one unit of its budget is reserved before the body is read, or before a verifier runs.
2. **The origin check**, for a credential the browser sends on its own.
3. **Authorization** — the policy.
4. **The `guard:`**, whose `request` now carries `principal` ([Mount guards](mount-guard.md)).
5. The handler.

A CORS preflight and a request that matches no route reach none of them.

## `authentication`

| Key | Meaning |
| --- | --- |
| `verifiers` | At least one `{ verifier, from }`, tried in order. `verifier` is an `Auth.Verifier`; `from` is a credential source, written inline. |
| `anonymous` | `deny` (the default) answers a request presenting no credential 401. `allow` serves it, with `request.principal` null. |
| `throttle` | `{ budget, key? }`: bounds refused credentials per client ([Throttling sign-in per client](#throttling-sign-in-per-client)). |

The shape is the named shape `Http.Authentication`.

**How the entries are tried.**

- A source that finds no credential where it looks skips its entry.
- The first credential that is presented decides. If the verifier accepts it, `request.principal` is its principal. If the verifier refuses it, the request is answered 401. A refused credential never falls through to a later entry, nor to anonymous: a forged token on a mount allowing anonymous callers is refused, not served anonymously.
- A credential that is present but unreadable is **malformed** and refused 401 — an `Authorization` header naming a listed scheme with no token, Basic credentials that do not decode, an empty or repeated header. It is never read as absent.
- With no credential at all, `anonymous` decides.

To read one verifier's credential from two places, repeat the entry with the same verifier `!ref`.

### Credential sources

Each kind under the abstract `Http.CredentialSource` reads one place. It returns an `Auth.Presentation`, or null when the request carries none there.

| Kind | Reads | Presents |
| --- | --- | --- |
| `Http.FromAuthorization { schemes }` | `Authorization: <scheme> <token>`, the scheme matched case-insensitively (`bearer x` is a `Bearer` token); a header under an unlisted scheme is no credential for this source | `token`, with `scheme` as listed |
| `Http.FromBasic` | `Authorization: Basic …` | `basic` |
| `Http.FromHeader { header, scheme }` | one header (an API key in `x-api-key`) | `token` |
| `Http.FromQuery { parameter, scheme }` | one query parameter | `token` |
| `Http.FromCookie { cookie, scheme, trustedOrigins }` | the cookie a `HttpDispatch` cookie declaration names, its prefix included | `token` |
| `Http.FromClientCertificate { scheme }` | the client certificate the listener received or a trusted proxy forwarded | `certificate` |
| `Http.FromForwardedIdentity { header, scheme }` | the subject a trusted proxy forwards | `asserted` |
| `Http.FromMessageSignature { label?, components, scheme }` | an RFC 9421 `Signature-Input` / `Signature` pair | `signature` |
| `Http.FromBodySignature { signature, timestamp?, base, scheme }` | a webhook signature over the body | `signature` |

`scheme` (an `Http.AuthScheme`, an RFC 9110 token) is the scheme a request lacking the credential, or presenting a refused one, is challenged with.

A source the verifier cannot take is refused by `telo check`: `Http.FromBasic` feeding `AuthBearer.Jwt` is `CONTRACT_INPUTS_MISMATCH`, because the source's output must fit the verifier's `presentation` input.

**A source's reading** (what its `snapshot()` publishes) is how the server learns what it needs without knowing the kind. A source of another module publishes the same:

- `schemes` — the challenge schemes;
- `originCheck: { trustedOrigins }` — the browser sends this credential on its own, so the origin check applies;
- `requiresTrustedProxy: true` — only a server trusting its proxy may read it;
- `bearerMethod: header | query` — the RFC 6750 method a Bearer token is read by, which becomes the mount's `bearer_methods_supported` (`Http.FromAuthorization` under `Bearer` publishes `header`, `Http.FromQuery` under `Bearer` publishes `query`);
- `readsBody: true` — the source reads the body, so the server reads it before any source runs ([Signed requests](#signed-requests)).

**What a source receives** is the request as `Http.CredentialRequest`: `method`, `path`, `host`, `targetUri`, `headers`, `query`, `cookies`, `ip`, `tls`, `clientCertificate`, and `body` for a source publishing `readsBody` only. `targetUri` is the absolute target URI with the query exactly as received; its scheme and authority are the ones the server derives for DPoP's `uri` (below), so behind a proxy they are right only under a correct `trustProxy`, and its path includes the mount's prefix. `body` is sensitive, so it is redacted wherever the source's inputs are recorded.

A source reports a present but unreadable credential by throwing `ERR_HTTP_CREDENTIAL_MALFORMED`, the abstract's only code. Any other failure is a failed access check (below).

### What the verifier receives

`{ presentation, confirmation, resource }`, built by the server once per request:

- `confirmation.certificateThumbprint` — the base64url SHA-256 of the client certificate, when there is one.
- `confirmation.dpop` — `{ proof, method, uri }` when the request carries a `DPoP` header. `uri` is the absolute target as the client sees it (scheme and host under `trustProxy`), without the query.
- `resource` — the protected resource's canonical URI: the origin of the first `Telo.PublicUrl` in the mount's `hostnames`, else the request's origin under `trustProxy`, followed by the mount's path (`/` at the root). A verifier checking an audience compares it (`audience: !cel "[resource]"`).

## Signed requests

Two sources read a signature, and `AuthSignature.Verifier` checks it; neither source names a vendor, so a provider's scheme is a recipe of their fields (see `auth-signature`'s recipes).

```yaml
mounts:
  - path: /webhooks
    mount: !ref webhooks
    authentication:
      verifiers:
        - verifier:
            kind: AuthSignature.Verifier
            maxSignatureAge: 5m
            keys: [{ subject: stripe, algorithm: hmac-sha256, secret: !cel "secrets.stripeWebhookSecret" }]
          from:
            kind: Http.FromBodySignature
            scheme: Stripe
            signature: { header: Stripe-Signature, pattern: "(?:^|,)v1=([0-9a-f]+)", encoding: hex }
            timestamp: { header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)", unit: seconds }
            base:
              - { type: header, header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)" }
              - { type: literal, value: . }
              - { type: body }
  - path: /partner
    mount: !ref partnerRoutes
    authentication:
      verifiers:
        - verifier: !ref partnerSignatures
          from: { kind: Http.FromMessageSignature, scheme: Signature, label: sig1, components: ["@method", "@target-uri", content-digest] }
```

**`Http.FromBodySignature`** reads the webhook family.

- `signature: { header, pattern?, encoding }` — `pattern` is an RE2 pattern whose first group captures each signature, every match taken (Stripe sends several during a secret rotation); without one the whole header is the signature. `encoding` is `hex`, `base64` or `base64url`.
- `timestamp: { header, pattern?, unit }`, optional, `unit` `seconds` or `milliseconds`. Declared, a missing or unreadable timestamp is malformed; undeclared, the presentation has no `created`, and a verifier writing `maxSignatureAge` refuses it.
- `base` — the signed bytes, `HttpSignature.BasePart`s joined with nothing between them: `{ type: literal, value }`, `{ type: header, header, pattern? }`, `{ type: body }`. One part must be the body.
- It always publishes `readsBody: true`.

**`Http.FromMessageSignature`** reads RFC 9421.

- The signature read is the one named `label`; without a label the request must carry exactly one signature, otherwise it is malformed.
- `components` is what the signature must cover, and so exactly what it authenticates: derived components (`@method`, `@target-uri`, `@authority`, `@scheme`, `@request-target`, `@path`, `@query`, `@query-param;name="x"`) and lower-case header field names. A signature covering less is malformed. A list without `content-digest` leaves the body unauthenticated, which is what a signed `GET` wants; with it, `Content-Digest` (`sha-256` / `sha-512`) is checked against the body, and a digest that does not hold is malformed.
- The signature base is built from `targetUri`, so `@scheme`, `@authority` and `@target-uri` are the URI the client used only under a correct `trustProxy`: behind a TLS-terminating proxy that is not trusted, every signature covering them fails.
- `keyid`, `alg`, `created` and `expires` become the presentation's `keyId`, `algorithm`, `created` and `expires`.
- It publishes `readsBody: true` only when `components` names `content-digest`.

A request without the signature header carries no credential for either source. One that is present but unreadable is malformed, refused 401. A refused signature is a 401 challenged with the source's `scheme`.

**A body-reading mount buffers every request.** On a mount or route whose effective `authentication` lists a source publishing `readsBody`, the server reads the whole body before any source runs, bounded by the matched route's `maxBodyBytes`, else the server's (1 MiB by default). A longer body is the server's own 413 ([Request bodies](request-bodies.md)) before any source or verifier is called. That includes a streamed upload, so list a body-reading source on the mount or route that receives the signed requests, not on one that also takes uploads. A mount whose sources publish no `readsBody` reads nothing early, and its refusals still come before the body is read.

**The bytes verified are the bytes served.** The buffered body becomes the request's payload: the server's parsers, a parser a mount registers and the streamed-body intake all read it, so a parsed route, a streamed route, `Mcp.HttpEndpoint` and any other mount receive exactly what was verified. This is the mount contract: a mount reads the body only through the server — a content-type parser or the parsed `request.body` — never from the raw socket.

## Throttling sign-in per client

`throttle: { budget, key? }` bounds how many credentials one client may have refused within the budget's window, before any verifier runs or any body is read. `budget` is a `RateLimit.Budget` (its `limit` and `window` say how many guesses per window); `key` is a CEL expression evaluated per request over `request`, typed as `Http.CredentialRequest` without its `body`, which is not read yet, and defaults to `request.ip`.

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /
    mount: !ref pages
    authentication:
      throttle:
        budget: { kind: RateLimit.Budget, store: !ref counters, limit: 20, window: "10m" }
      verifiers:
        - verifier: !ref passwords
          from: { kind: Http.FromAuthorization, schemes: [Basic] }
```

**Per request.**

1. Behind header-only sources, one unit is reserved under the key once a source answers with a credential, before its verifier runs. A request carrying no credential touches no store. Behind a source that reads the body, the unit is reserved for every request, before the body is read. A request reserves at most once.
2. A spent budget answers 429 with `Retry-After` from the budget, `ERR_HTTP_AUTHENTICATION_THROTTLED` and `data: { retryAfter }`. No body is read and no verifier runs, so a throttled client costs no password hash, no store read and no buffer.
3. The reservation is settled back to nothing for an accepted credential, for a verifier that threw (coded or not; a cancellation or a durable suspension leaves it spent), and for a request every source answered with no credential. A refused or malformed credential, a 413 and an aborted upload leave it spent: the throttle counts guesses, not requests.
4. A budget store that throws, on the reserve or on the settle, answers `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` with `data.stage: throttle` and the store's error as the cause. The throttle never fails open. When the verifier threw as well, the answer stays `stage: verifier` and the failed settle is in the same `http.server.access_check.unavailable` record.

**Sizing.** The reservation is atomic, so parallel wrong guesses from one client can never exceed `limit`. The price is that `limit` also counts requests still inside the access stage, including an upload read for a signature: size it as the peak concurrent such requests per key plus the failures you allow. In-flight buffers per key are capped at `limit` × the body bound.

**Keys and stores.** A budget counts under its own name and the key on its store, so two budgets of different names on one `Cache.Store` do not share counters, while one budget referenced from a mount and a route is one counter. A route that wants its own counter on a shared budget writes a `throttle` with a suffixed key (`!interpolate "${{ request.ip }}/login"`), or a budget of its own. A budget over a process-local store bounds each replica separately; a fleet-wide bound needs a store the replicas share, and two applications sharing one store share the counter of a budget they both name alike.

**The client address** is `request.ip`, which is the real client only under a correct `trustProxy`; behind a proxy that is not trusted every client is the proxy. An IPv6 client holding a /64 gets one budget per address, so key on a prefix of `request.ip` where that matters. `Protection.PasswordThrottle` is the other half: it bounds guessing at one account from any number of addresses.

A route's `throttle` replaces the mount's whole, so it must name a `budget`.

## Overriding on a route

An `Http.Api` route takes `authentication:` and `authorization:` too.

- In `authentication`, each key the route writes replaces the mount's, and an absent key is inherited. `authentication: { anonymous: allow }` makes one route optional through the mount's verifiers.
- A route that writes `authentication` denies anonymous callers by default even when its mount declares none. `authentication: {}` on such a route, with no verifier of its own or the mount's, is `AUTHENTICATION_UNSATISFIABLE`.
- A route's `authorization` replaces the mount's whole, and so does its `throttle`.
- `Http.FromForwardedIdentity` is refused in a route's `authentication`: whether the proxy is trusted is the server's, so it belongs on a mount.

## `request.principal`

The principal is read only as `request.principal`, in `inputs:`, `returns:`, `catches:`, a mount's `authorization` and its guard. It is never handed over any other way.

| Where | Type |
| --- | --- |
| A route's `inputs`, `returns` and `authorization` | `Auth.Principal`, non-null exactly when every mount reaching the route denies anonymous callers and the route does not allow them; nullable otherwise |
| A mount's `authorization` and its guard | `Auth.Principal`, nullable where the mount allows anonymous callers or declares no authentication |
| Every `catches:` list | nullable: a 401 is rendered there before anyone is authenticated |

Reading a member unguarded where it may be null is `CEL_NULLABLE_ACCESS`; `request.principal != null && …` proves it. A router nothing mounts types it nullable.

## `authorization`

| Key | Meaning |
| --- | --- |
| `policy` | An `Auth.Policy` (`Authz.CelPolicy`, for instance). |
| `action` | Required: what the request attempts, evaluated per request over `request`. |
| `resource` | What it is attempted on; null when omitted. |

The policy receives `{ principal, action, resource, context }`, `context` being `{ method, path, host, ip }`. `allow: false` is a 403. The shape is the named shape `Http.Authorization`.

## Refusals

Every refusal goes through the route's `catches:`, then its router's (on an `Http.Api` mount), then the server's, and is answered with its built-in problem when no entry claims it. Each of these codes may be named in a proving `when:` on any of the three lists, its `error.data` is typed there, and no route owes their coverage.

A catch-all (an entry with no `when:`, or one whose `when:` names no code) renders a refusal too, so it is typed by them wherever they can arrive: on a route whose own `authentication` / `authorization`, or whose mount's, is present, on the router's list and on the server's — and on every list of a router an importer may mount, one listed in `exports.resources`. There, a catch-all reading a member only the handler's codes declare (`problem.data.id`) is `CEL_UNKNOWN_FIELD`; name the code in its `when:` (`problem.code == 'ORDER_NOT_FOUND'`). A route nothing authenticates keeps the handler's typing.

A mount kind of another module gets the same typing by declaring two annotations, `x-telo-raises: [<code>…]` on the field whose presence raises the codes and `x-telo-catches-for: { slot, raises: [<code>…] }` on each catch list that receives them, each code declared in its `throws.codes`.

| Code | Status | `data` | When |
| --- | --- | --- | --- |
| `ERR_HTTP_UNAUTHENTICATED` | 401 | `{ reason: absent \| malformed \| refused }` | no credential where anonymous callers are denied, or a malformed or refused one |
| `ERR_HTTP_AUTHENTICATION_THROTTLED` | 429 | `{ retryAfter }` | the client's `throttle` budget is spent; `Retry-After` carries `retryAfter` |
| `ERR_HTTP_FORBIDDEN` | 403 | `{ requiredScopes? }` | the policy denied the action |
| `ERR_HTTP_CROSS_ORIGIN_REFUSED` | 403 | — | the origin check failed |
| `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` | 503 | `{ stage: source \| verifier \| policy \| throttle }` | a source, verifier or policy threw, or the throttle's budget store failed to reserve or settle |

**The 401's `WWW-Authenticate`** carries every challenge in one header, comma-separated (RFC 9110), duplicates dropped:

- For each entry and each scheme its source publishes, the verifier's published challenge of that scheme (matched case-insensitively), else the bare scheme. `AuthBearer.Jwt` publishes `Bearer`, and `DPoP algs="…"` when it verifies DPoP proofs.
- On a refusal, the challenge the verifier returned replaces that entry's challenge of the same scheme. A refusal with a null challenge keeps the published one.

```
WWW-Authenticate: Bearer error="invalid_token", error_description="The access token has expired", ApiKey
```

**The 403** carries `WWW-Authenticate: <scheme> error="insufficient_scope", scope="…"` when the policy names `requiredScopes` and the caller presented a credential, the scheme being the one it arrived under.

**The 503** is the server's own answer whatever the source, verifier, policy or budget store threw. Its code reaches only the trace (the failing dispatch's span) and the log (`http.server.access_check.unavailable`, [Log events](log-events.md)), as the cause, never the response. A cancellation is not an access failure, and an uncoded failure is a bare 500, so a broken check never lets a request through.

An author's entry overrides a built-in rendering:

```yaml
catches:
  - when: !cel "error.code == 'ERR_HTTP_UNAUTHENTICATED'"
    status: 401
    content: { application/json: { body: { reason: !cel "error.data.reason" } } }
```

The `WWW-Authenticate` header is set before the entry renders, so it stays unless the entry writes its own.

## `protectedResource`

A mount declaring `protectedResource:` publishes its OAuth 2.0 protected-resource metadata (RFC 9728), so a client that meets a 401 can find the authorization server.

```yaml
mounts:
  - path: /mcp
    mount: !ref endpoint
    authentication:
      verifiers:
        - verifier: !ref tokens
          from: { kind: Http.FromAuthorization, schemes: [Bearer] }
    protectedResource: { scopesSupported: [tools], resourceName: Orders }
```

- **The document.** `GET /.well-known/oauth-protected-resource<mount path>` (the bare path for a mount at `/`) answers `application/json` without authentication, on the mount's `hostnames` only. With `protectedResource:` absent nothing is served.
- **Written:** `scopesSupported`, `resourceName`, `resourceDocumentation`, `resourcePolicyUri`, `resourceTosUri`, published as `scopes_supported`, `resource_name`, `resource_documentation`, `resource_policy_uri`, `resource_tos_uri`.
- **Derived, never written:** `resource` is the mount's public origin and path (the same value verifiers receive as `resource`); `authorization_servers` is the distinct union, in order, of the `issuer` each of the mount's verifiers publishes in its reading (see [verifiers](https://hub.telo.run/module/oci/ghcr.io/telorun/auth/)), left out when none does, which is valid for an API-key-only resource; `bearer_methods_supported` comes from the sources' `bearerMethod`. There is deliberately no field for an issuer: one written twice, on the verifier and here, is how tokens issued for one resource end up accepted by another. Route-level `authentication` does not change the document.
- **Every 401** (and the 403 naming `insufficient_scope`) from the mount adds `resource_metadata="<absolute URL of the document>"` to each challenge. A mount without `protectedResource:` adds none.

A mounted kind learns what stands in front of it from a fourth argument to its `register(app, prefix, requestScope, access)`: `{ deniesAnonymous, protectedResource, issuers }`, where `issuers` is the distinct union, in order, of the `issuer` the mount's verifiers publish. A mount kind that is only useful when discoverable can use it to refuse being served without metadata.

## The origin check

A request authenticated through `Http.FromCookie` — any source publishing `originCheck` — that changes state (any method but `GET`, `HEAD` and `OPTIONS`, or a protocol upgrade) must come from this site:

1. `Sec-Fetch-Site: same-origin` or `none` passes.
2. Otherwise `Origin` must equal the mount's origin (its public address, else the request's origin) or be listed in the source's `trustedOrigins`.
3. A request with neither header is refused.

A refusal is `ERR_HTTP_CROSS_ORIGIN_REFUSED`, 403. `QUERY` is checked like `POST`, so a cross-origin `QUERY` also needs `cors.methods` to list it ([The QUERY method](query-method.md)). There is no switch to turn it off. The same request authenticated by a bearer token is not checked, since a browser never sends one on its own. A trusted origin is a scheme and host, with a port when it is not the default, and nothing after it; anything else is refused by `telo check` (`HTTP_TRUSTED_ORIGIN_INVALID`) and when the source is created.

## Refused before the app runs

| Mistake | `telo check` | At creation |
| --- | --- | --- |
| On a server where any mount declares `authentication`, a mount without it (a `guard:` does not count; `when:` is not read) | `MOUNT_IMPLICITLY_PUBLIC` | `ERR_MOUNT_IMPLICITLY_PUBLIC` |
| A mount denying anonymous callers with no verifier, or a route of a router it mounts doing so where neither the route nor the mount names one | `AUTHENTICATION_UNSATISFIABLE` (a rule on `Http.Server` for the mount, on `Http.Api` for its routes, judged whatever else the mount entry holds) | `ERR_AUTHENTICATION_UNSATISFIABLE` |
| A mount declaring `protectedResource` whose `authentication` is absent, empty or names no verifier (a verifier declaring no `issuer` is allowed: the document then has no `authorization_servers`, as for an API-key-only resource) | `PROTECTED_RESOURCE_WITHOUT_AUTHENTICATION` | `ERR_PROTECTED_RESOURCE_WITHOUT_AUTHENTICATION` |
| `Http.FromForwardedIdentity` on a server trusting no proxy | `HTTP_PROXY_SOURCE_UNTRUSTED` | `ERR_HTTP_PROXY_SOURCE_UNTRUSTED` |
| `Http.FromForwardedIdentity` in a route's `authentication` | `HTTP_PROXY_SOURCE_ON_ROUTE` | `ERR_HTTP_PROXY_SOURCE_ON_ROUTE` |
| A source whose presentation the verifier cannot take | `CONTRACT_INPUTS_MISMATCH` | the verifier's input refused at the call, answered 503 |
| An `Http.FromBodySignature` `pattern` that is not RE2 or captures no group, or a `base` without a `{ type: body }` part; an `Http.FromMessageSignature` `components` entry of another form, or carrying a parameter such as `;sf` | `SCHEMA_VIOLATION` | `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` |

`MOUNT_IMPLICITLY_PUBLIC` is scoped to one server: a second server is usually a deliberate internal port. Give a public mount `{ anonymous: allow }`.
