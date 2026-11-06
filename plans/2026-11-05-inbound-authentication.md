---
status: done
priority: medium
depends-on: []
tracking: feat/inbound-authentication
packages: [analyzer/nodejs, modules/auth, modules/authz, modules/auth-bearer, modules/api-key, modules/api-key-sql, modules/api-key-postgres, modules/api-key-sqlite, modules/session, modules/auth-basic, modules/identity, modules/protection, modules/http-server, modules/http-dispatch, modules/mcp-server, examples, apps/authoring-agent, apps/hub, docs]
---

# Inbound authentication

## Problem

Nothing in Telo checks who a request comes from. `Http.Server` has cookies, TLS and client certificates. Its only hook is a mount `guard:`: an invocable whose inputs the author maps from headers with CEL (`'authorization' in request.headers ? … : ''`). It returns nothing, so no route knows who called it. And `telo check` cannot tell a guarded mount from an open one. `Mcp.HttpEndpoint` is unauthenticated, which the MCP authorization spec does not allow. The standard library covers only the outbound half (`Http.Credential`, `oauth-client`) plus the primitives that shipped for this work (`crypto`, `jose`, `mail`, `sms`). There are no verifiers, API keys, sessions or policies, so an API that needs to know its caller has to leave Telo.

## Solution

**Contracts — `auth`, which imports nothing.**
- `Auth.Principal`: `subject` (exported on traces as `enduser.id`), `issuer`, `kind: user | service`, `claims`, `scopes`, `roles`, `permissions`, nullable `org`, `amr`, `acr`, `sessionId`, `authenticatedAt`, `via`.
- `Auth.Presentation`: the credential material by what it is — `token`, `basic`, `certificate` or `asserted` — every member sensitive.
- `Auth.Verifier`: `{ presentation, confirmation, resource }` → `{ principal }` or `{ refused, reason, challenge }`. `confirmation` is the client-certificate thumbprint and the DPoP proof with its method and URI, built by the transport. A verifier's reading publishes the `issuers` it trusts.
- `Auth.PasswordVerifier`: `{ identifier, password }` → principal or refusal with `unknown | mismatch | disabled | throttled`.
- `Auth.Policy`: `{ principal, action, resource, context }` → `{ allow, reason, requiredScopes }`.
- `Auth.TrustedHeader`: accepts `asserted` presentations.

Every transport and verifier module imports `auth`.

**The HTTP seam (`http-server`).**
- A mount entry gains `authentication: { verifiers: [{ verifier, from }], anonymous }`, with `anonymous` defaulting to `deny`. It also gains `authorization: { policy, action, resource }`, where `action` is required and `action` / `resource` are CEL over `request`.
- `Http.Api.routes[]` override either key, key by key: `authentication: { anonymous: allow }` makes one route optional through the mount's verifiers.
- `from` is a credential source, a kind under the open abstract `Http.CredentialSource`:
  - `Http.FromAuthorization { schemes }`, with case-insensitive schemes
  - `Http.FromBasic`
  - `Http.FromHeader { header }`
  - `Http.FromQuery { parameter }`
  - `Http.FromCookie { cookie, trustedOrigins }`
  - `Http.FromClientCertificate`
  - `Http.FromForwardedIdentity { header }`, refused without `trustProxy`
- Verifiers run in order. An absent credential skips its entry. A presented credential that fails is a 401 and never falls through.
- The request then runs authentication → authorization → `guard:` (whose `request` gains `principal`) → handler.
- Handlers read the principal only as `request.principal` in `inputs:`. It is non-null on a route exactly when every mount reaching it denies anonymous and the route does not allow it, and nullable otherwise.
- A refusal is a 401 with every verifier's challenge in one `WWW-Authenticate`. A denial is a 403, carrying `error="insufficient_scope", scope="…"` when the policy names scopes. A verifier that cannot reach its keys or endpoint throws, and the default answer is 503. All of these go through the route → router → server `catches:` ladder with built-in problem bodies.
- An unsafe method or upgrade authenticated through `Http.FromCookie` must pass an origin check: `Sec-Fetch-Site` is `same-origin` / `none`, or `Origin` is the mount's origin or in `trustedOrigins`. Otherwise it is refused 403 (`ERR_HTTP_CROSS_ORIGIN_REFUSED`). There is no switch to turn this off.
- On a server where any mount declares `authentication:`, every mount must declare it — `{ anonymous: allow }` at least. A `guard:` does not count. Otherwise it is `MOUNT_IMPLICITLY_PUBLIC`, an error at check, twinned as `ERR_MOUNT_IMPLICITLY_PUBLIC`.

**Protected-resource metadata.**
- A mount's `protectedResource:` (`scopesSupported`, `resourceName`, `resourceDocumentation`, `resourcePolicyUri`, `resourceTosUri`) makes the server answer `/.well-known/oauth-protected-resource<mount path>` (RFC 9728) without authentication, on the mount's hostnames.
- `resource` is derived from the mount's `Telo.PublicUrl` and path. `authorization_servers` comes from the verifiers' `issuers`, and `bearer_methods_supported` from the sources.
- Every 401 from that mount carries `resource_metadata`.
- `Mcp.HttpEndpoint` adds only `MCP_PROTECTED_RESOURCE_MISSING`: a mount denying anonymous that serves it must declare `protectedResource:` and reach an issuer.

**Analyzer primitives, generic.**
- `x-telo-context-from-referrer` becomes legal on evaluated bindings. This is what types `request.principal` from the referring mounts, so reading it unguarded on an optional route is `CEL_NULLABLE_ACCESS`.
- `x-telo-ref` gains `outputTo: { slot, member }`: a slot's output must fit a member of a sibling slot's `inputType`. A `from` source feeding a verifier that cannot take its presentation is `CONTRACT_INPUTS_MISMATCH`.

**Verifiers and their companions.**
- **`auth-bearer`.** `AuthBearer.Jwt` (`keys`, `issuer`, `algorithms`, `types`, default `[at+jwt]`) and `AuthBearer.Introspection` (RFC 7662: `endpoint`, `client` credential, `issuer`, a `Cache.Store` capped at the token's `exp`), both under `AuthBearer.AccessTokenVerifier`. They share:
  - a required `audience` (CEL over `resource` for RFC 8707 binding)
  - `confirmation` — DPoP (RFC 9449) with a `KvStore.Store` replay record shared across replicas, and certificate-bound tokens (RFC 8705)
  - `revocation`, a `jti` denylist written by `AuthBearer.Revoke`
  - `principal` mapping from claims: `scope`, else `scp`, for scopes; `kind: service` when `sub == client_id`
- **`api-key`, `api-key-sql`, `api-key-postgres`, `api-key-sqlite`** — the queue split.
  - **Format:** `<prefix>_<id><secret><CRC32>` in base62; public id `apk_<id>`. A key with a bad checksum is refused before any store read.
  - **Storage:** SHA-256 digests compared in constant time, never cached.
  - **Contracts:** `ApiKey.KeySource` (lookup) and `ApiKey.Store` (adds `Issue`, `List`, `Revoke`, `Rotate` with an `overlap`).
  - **Declared keys:** `ApiKey.DeclaredKeys` holds digests written in the manifest, minted by `ApiKey.Generate`.
  - **Verifier:** `ApiKey.Verifier` routes by prefix across `sources`.
  - **Ownership:** an owner is `user | service | organization`; the key's public id is the `RateLimit` bucket.
  - **Last use:** recorded at most once per `lastUsedResolution`.
  - **SQL store:** `ApiKeySql.Store` sweeps expired and revoked rows past `retention`.
- **`session`, over `KvStore.Store` only.**
  - `Session.Sessions` (durable `name`, `idleTimeout`, `absoluteLifetime`, `persistent`, `maxPerSubject`).
  - `Session.Start` always mints a new id. `Rotate`, `End`, `EndAll` (one write) and `List` read a bounded per-subject index.
  - `Session.Verifier` requires the session to be listed in its subject's index.
  - Idle expiry slides with at most ten writes per idle period.
  - The cookie is the app's `HttpDispatch.HostCookie`, referenced by the source and by the login and logout `cookies:` entries; a null `expires` writes a browser-session cookie.
  - A stateless session is documented as a recipe: a JWT in a cookie, read by `AuthBearer.Jwt`.
- **`auth-basic`.** `AuthBasic.Verifier` over `passwords: Auth.PasswordVerifier`, challenging `Basic realm="…", charset="UTF-8"`.
- **`identity`** starts with `Identity.DeclaredUsers`: users written in the manifest, with password hashes from `secrets:`, checked through `Crypto.PasswordHash`. An unknown user runs a check against a dummy hash, so it takes as long as a wrong password.
- **`protection`** starts with `Protection.PasswordThrottle`, which wraps a password verifier and counts failures per identifier on a `RateLimit.Budget`.
- **`authz`** starts with `Authz.CelPolicy`.

## Decisions

- **Contracts in a module, not kernel built-ins.** No kernel consumes a principal. As a built-in, every new principal field would need a release of both kernels.
- **The seam lives on the mount.** It covers every `Telo.Mount` with no knowledge of any one kind, and it is what makes "public" a fact the analyzer can check. A wrapping guard mount and handler-level composition give the analyzer nothing to check.
- **Credential sources are kinds.** Credential parsing written in CEL turns a malformed header into anonymous. A closed union of sources cannot be extended by the request-signing module that comes later.
- **A presentation says what the material is, not where it came from.** An API key sent as `Bearer`, a session id and a JWT in a cookie are all `token`, so any verifier can be fed from any location that suits it.
- **No `Auth.Chain`, no `Auth.Anonymous`.** The mount's list is the chain, and "no principal" is `anonymous: allow` with a null `request.principal`. A principal of kind anonymous would contradict that typing.
- **A presented credential that fails never falls through.** Otherwise a forged token on a mount allowing anonymous would be served as anonymous.
- **`MOUNT_IMPLICITLY_PUBLIC` is an error, scoped to one server.** An `/admin` mount added without authentication is exactly what a warning lets through. A second server is usually a deliberate internal port. `ROUTE_IMPLICITLY_PUBLIC` is gone (a route can only be made public explicitly), and so is `AUTHZ_ACTION_MISSING` (a missing `action` is a schema violation).
- **The origin check, not CSRF tokens.** The exposure comes from a cookie carrying the credential, whichever verifier reads it. Fetch Metadata plus `Origin` covers every form, where a token must be threaded through each one.
- **Protected-resource metadata is derived.** An issuer written twice — on the verifier and in the metadata — is how tokens issued for one resource end up accepted by another.
- **Storage follows the record.** API keys are administered and durable, so they live in SQL with listing and sweeping. Sessions are ephemeral and bounded by their TTL, so they live in `KvStore.Store`, which already has three backends.
- **API keys are digested with SHA-256, not a password hash.** A 256-bit secret gains nothing from argon2, and running argon2 on every request is expensive. They are never cached, so a revocation holds on every replica at the next request.
- **Digest authentication is not offered.** It requires storing a password-equivalent value.
- **Declared users and the password throttle ship now, in their own modules.** Without them Basic is unusable or unbounded, and placing them in `auth-basic` would make `identity` and `ldap` import an HTTP-scheme module.
- **Authorization ships now as `authz`.** A route requiring a scope is part of serving a token-based API. A separate `requires: { scopes }` key would be a second way to write what a CEL policy already says.

## Bookkeeping

- `http-server`, `mcp-server` and every new module that uses `outputTo` or the evaluated `x-telo-context-from-referrer` declare a `requires: telo:` floor. Each floor is verified by running the previous CLI against the module.
- Each module gets its docs; `mount-guard.md` is updated to point at `authentication:`.
- The primer, the hub `design-library` guide and `modules/CLAUDE.md` are updated.
- New ledger entries in what-you-get.md: request authentication with a typed caller, API keys, sessions with log-out-everywhere, protection against cross-site request forgery, and protected-resource discovery for MCP.
- An analyzer changeset, and one `Added` fragment per module.
- The roadmap loses this phase; the signed-in-viewer plan depends on this one.

## Verify

- The example *API-key-only microservice* (under `examples/`, with tests):
  - It accepts a JWT from an external issuer through `Jose.RemoteKeySet`, and its own API key.
  - It refuses a tampered JWT, a wrong `aud`, a revoked `jti` and a revoked key, each with a 401 and its challenge.
  - It refuses a token missing a scope with a 403 carrying `insufficient_scope`.
- `telo check` refuses a server with one authenticated mount and one silent mount (`MOUNT_IMPLICITLY_PUBLIC`). It also refuses `request.principal.subject` on an `anonymous: allow` route (`CEL_NULLABLE_ACCESS`), and `Http.FromBasic` feeding `AuthBearer.Jwt` (`CONTRACT_INPUTS_MISMATCH`). The same server run without checking fails with `ERR_MOUNT_IMPLICITLY_PUBLIC`.
- Requests:
  - `Authorization: bearer x` with a lowercase scheme is verified.
  - A malformed `Authorization` header on an `anonymous: allow` mount is a 401, not anonymous.
  - An unreachable JWKS is a 503.
- Across two replicas sharing a store: a replayed DPoP proof is refused on the second replica, and a key revoked on one replica is refused on the other at the next request.
- API keys:
  - A key with one checksum character changed is refused with no store read.
  - A table dump yields no usable key.
  - The api-key suite passes on PostgreSQL and SQLite.
- Sessions:
  - After `Session.EndAll`, every copy of the cookie is refused.
  - A cross-site `POST` carrying the cookie gets 403, while the same `POST` with a bearer token passes.
  - Steady traffic writes a session at most about ten times per idle period.
- Basic:
  - Basic verifies against `Identity.DeclaredUsers`.
  - After N wrong passwords the identifier answers `throttled` while others still pass.
  - An unknown user and a wrong password take the same time and the same 401.
- MCP: a client completes discovery against an `Mcp.HttpEndpoint` with the issuer configured once, and receives `resource_metadata` on its first 401.

## Example after the change

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /api
    mount: !ref api
    authentication:
      verifiers:
        - verifier:
            kind: AuthBearer.Jwt
            keys: { kind: Jose.RemoteKeySet, issuer: https://login.example.com/ }
            issuer: https://login.example.com/
            algorithms: [RS256]
            audience: !cel "[resource]"
          from: { kind: Http.FromAuthorization, schemes: [Bearer] }
        - verifier: !ref apiKeys
          from: { kind: Http.FromHeader, header: x-api-key }
    authorization: { policy: !ref scopes, action: !cel "request.method + ' ' + request.path" }
    protectedResource: { scopesSupported: ["orders:read", "orders:write"] }
  - path: /health
    mount: !ref health
    authentication: { anonymous: allow }
```
