# Authentication and authorization

> Examples assume `http-server` is imported as `Http`, `auth-bearer` as `AuthBearer`, `authz` as `Authz` and `jose` as `Jose`.

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

For a request that matches a mount's route, after CORS and before the body is read:

1. **Authentication** — the verifiers, in order.
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

`scheme` (an `Http.AuthScheme`, an RFC 9110 token) is the scheme a request lacking the credential is challenged with.

A source the verifier cannot take is refused by `telo check`: `Http.FromBasic` feeding `AuthBearer.Jwt` is `CONTRACT_INPUTS_MISMATCH`, because the source's output must fit the verifier's `presentation` input.

**A source's reading** (what its `snapshot()` publishes) is how the server learns what it needs without knowing the kind. A source of another module publishes the same:

- `schemes` — the challenge schemes;
- `originCheck: { trustedOrigins }` — the browser sends this credential on its own, so the origin check applies;
- `requiresTrustedProxy: true` — only a server trusting its proxy may read it;
- `bearerMethod: header | query` — the RFC 6750 method a Bearer token is read by, which becomes the mount's `bearer_methods_supported` (`Http.FromAuthorization` under `Bearer` publishes `header`, `Http.FromQuery` under `Bearer` publishes `query`).

A source reports a present but unreadable credential by throwing `ERR_HTTP_CREDENTIAL_MALFORMED`, the abstract's only code. Any other failure is a failed access check (below).

### What the verifier receives

`{ presentation, confirmation, resource }`, built by the server once per request:

- `confirmation.certificateThumbprint` — the base64url SHA-256 of the client certificate, when there is one.
- `confirmation.dpop` — `{ proof, method, uri }` when the request carries a `DPoP` header. `uri` is the absolute target as the client sees it (scheme and host under `trustProxy`), without the query.
- `resource` — the protected resource's canonical URI: the origin of the first `Telo.PublicUrl` in the mount's `hostnames`, else the request's origin under `trustProxy`, followed by the mount's path (`/` at the root). A verifier checking an audience compares it (`audience: !cel "[resource]"`).

## Overriding on a route

An `Http.Api` route takes `authentication:` and `authorization:` too.

- In `authentication`, each key the route writes replaces the mount's, and an absent key is inherited. `authentication: { anonymous: allow }` makes one route optional through the mount's verifiers.
- A route that writes `authentication` denies anonymous callers by default even when its mount declares none. `authentication: {}` on such a route, with no verifier of its own or the mount's, is `AUTHENTICATION_UNSATISFIABLE`.
- A route's `authorization` replaces the mount's whole.
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
| `ERR_HTTP_FORBIDDEN` | 403 | `{ requiredScopes? }` | the policy denied the action |
| `ERR_HTTP_CROSS_ORIGIN_REFUSED` | 403 | — | the origin check failed |
| `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` | 503 | `{ stage: source \| verifier \| policy }` | a source, verifier or policy threw |

**The 401's `WWW-Authenticate`** carries every challenge in one header, comma-separated (RFC 9110), duplicates dropped:

- For each entry and each scheme its source publishes, the verifier's published challenge of that scheme (matched case-insensitively), else the bare scheme. `AuthBearer.Jwt` publishes `Bearer`, and `DPoP algs="…"` when it verifies DPoP proofs.
- On a refusal, the challenge the verifier returned replaces that entry's challenge of the same scheme. A refusal with a null challenge keeps the published one.

```
WWW-Authenticate: Bearer error="invalid_token", error_description="The access token has expired", ApiKey
```

**The 403** carries `WWW-Authenticate: <scheme> error="insufficient_scope", scope="…"` when the policy names `requiredScopes` and the caller presented a credential, the scheme being the one it arrived under.

**The 503** is the server's own answer whatever the source, verifier or policy threw. Its code reaches only the trace (the failing dispatch's span) and the log (`http.server.access_check.unavailable`, [Log events](log-events.md)), as the cause, never the response. A cancellation is not an access failure, and an uncoded failure is a bare 500, so a broken check never lets a request through.

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

A refusal is `ERR_HTTP_CROSS_ORIGIN_REFUSED`, 403. There is no switch to turn it off. The same request authenticated by a bearer token is not checked, since a browser never sends one on its own. A trusted origin is a scheme and host, with a port when it is not the default, and nothing after it; anything else is refused by `telo check` (`HTTP_TRUSTED_ORIGIN_INVALID`) and when the source is created.

## Refused before the app runs

| Mistake | `telo check` | At creation |
| --- | --- | --- |
| On a server where any mount declares `authentication`, a mount without it (a `guard:` does not count; `when:` is not read) | `MOUNT_IMPLICITLY_PUBLIC` | `ERR_MOUNT_IMPLICITLY_PUBLIC` |
| A mount denying anonymous callers with no verifier, or a route of a router it mounts doing so where neither the route nor the mount names one | `AUTHENTICATION_UNSATISFIABLE` (a rule on `Http.Server` for the mount, on `Http.Api` for its routes, judged whatever else the mount entry holds) | `ERR_AUTHENTICATION_UNSATISFIABLE` |
| A mount declaring `protectedResource` whose `authentication` is absent, empty or names no verifier (a verifier declaring no `issuer` is allowed: the document then has no `authorization_servers`, as for an API-key-only resource) | `PROTECTED_RESOURCE_WITHOUT_AUTHENTICATION` | `ERR_PROTECTED_RESOURCE_WITHOUT_AUTHENTICATION` |
| `Http.FromForwardedIdentity` on a server trusting no proxy | `HTTP_PROXY_SOURCE_UNTRUSTED` | `ERR_HTTP_PROXY_SOURCE_UNTRUSTED` |
| `Http.FromForwardedIdentity` in a route's `authentication` | `HTTP_PROXY_SOURCE_ON_ROUTE` | `ERR_HTTP_PROXY_SOURCE_ON_ROUTE` |
| A source whose presentation the verifier cannot take | `CONTRACT_INPUTS_MISMATCH` | the verifier's input refused at the call, answered 503 |

`MOUNT_IMPLICITLY_PUBLIC` is scoped to one server: a second server is usually a deliberate internal port. Give a public mount `{ anonymous: allow }`.
