---
status: draft
priority: high
depends-on: []
packages: [modules/auth-visitor, modules/auth, apps/authoring-agent, docs]
refinement: not-started
---

# Visitor credentials

## Problem

A chat embedded on someone else's site, or a support widget, serves people who never sign in, and each must still get back their own conversations. Today every such caller is the same caller: a mount with `authentication: { anonymous: allow }` serves them all with `request.principal` null, so anything keyed by the caller is one shared bucket. A session does not help, because `Session.Verifier` reads a cookie and a page framed on another site gets its cookies blocked or partitioned. An application can hand-build a route that signs a JWT with `Jose.Sign` and accept it with `AuthBearer.Jwt`. But nothing ties the claims the route mints to what the verifier accepts, the verifier then advertises the application as an OAuth authorization server, and nothing limits how many identities one address can mint.

## Surface

**Added**
- `auth-visitor` module (`AuthVisitor`): pseudonymous credentials for people who have not signed in.
- `AuthVisitor.Visitors`: a provider holding one set of visitor credentials: `name` (its durable identity), `keys` (a `Jose.KeySet`), `lifetime` (a `Telo.Duration`).
- `AuthVisitor.Issue`: an invocable that mints or renews a visitor token. Slots `visitors` and `limit` (a `RateLimit.Guard`); inputs `key` (the throttle bucket) and `principal` (nullable); output `{ token, subject, expiresAt }`.
- `AuthVisitor.Verifier`: an `Auth.Verifier` over a `visitors` set that reads token presentations only. It publishes `challenges: []` and `principalIssuer`, and no `issuer`.
- Visitor principal: `kind: user`, `acr: "0"`, `amr: []`, `issuer: urn:telo:visitor:<name>`, `via` the verifier's name.
- `Visitor-Token` header: the request header visitor tokens travel in, read with `Http.FromHeader` (`header: visitor-token`, `scheme: Visitor`).
- `ERR_AUTH_VISITOR_THROTTLED` (`data.retryAfter`): `Issue` refused because the key's limit is spent.
- `ERR_AUTH_VISITOR_PRINCIPAL_FOREIGN`: `Issue` given a principal from another issuer.

**Changed**
- `auth` `principal.md`: states that a visitor is a `user` at assurance `acr: "0"`, and that "no principal" still means null.

**Removed**
- None.

## Solution

A `Visitors` set is the one place the visitor credential is declared. `Issue` and `Verifier` both reference it, so the issuer, keys and lifetime the minting side uses are the ones the accepting side checks, and neither restates them. A visitor token is a JWT signed with the set's current key, with `iss` set to `urn:telo:visitor:<name>`, a random 128-bit `sub` and `exp` at `lifetime`. Keys rotate through the `Jose.KeySet`'s own rotation, so a token signed before a rotation still verifies until it expires.

`Issue` is transport-neutral. The application declares the issuing route itself, on a mount with `authentication: { anonymous: allow }`, because a first mint presents no token. Every call charges the `limit` guard under `key` (the route passes `request.ip`) before anything is signed. Then:
- with `principal` null, it mints a fresh subject;
- with a principal of this set's issuer, it renews the token with the **same** subject, so a visitor's data survives expiry;
- with any other principal, it refuses (`ERR_AUTH_VISITOR_PRINCIPAL_FOREIGN`).

`Verifier` accepts a valid token as the visitor principal. A forged, expired or wrongly issued token is a refusal; an unreachable key set throws, as for every verifier. The verifier declares no `issuer`, because the application is not an OAuth authorization server, so a mount's protected-resource metadata never lists one for it.

A visitor is a person, so it is `kind: user`. That it is weakly identified is assurance, carried by `acr: "0"` as OpenID Connect defines it. A route that needs a signed-in user lists only the host's verifier in its `authentication:`, so a visitor-only request is answered 401 by the seam itself.

## Decisions

- **One set declaration that both halves reference.** Rejected: an application-composed `Jose.Sign` route, where the minted claims and the verifier's checks can drift and nothing catches it.
- **`kind: user` with `acr: "0"`, not a new `kind`.** `kind` says what the caller is; assurance is `acr`'s axis. A new `kind` value would reach every consumer of `kind` and break the contract's own rule that "no principal" is null, never an anonymous kind.
- **Its own header, not `Authorization`.** A request carries one `Authorization` header, and claiming a visitor's data at sign-in needs both credentials on one request. The seam's "the first credential presented decides" rule then makes a request carrying both authenticate as the host user.
- **No `issuer` published.** That key means an authorization server clients would try to discover.
- **The throttle is a required slot**, charged before signing. An issuer anyone can call without a limit mints unbounded identities.
- **Renewal keeps the subject.** Otherwise every expiry orphans the visitor's data.

Bookkeeping: `modules/auth-visitor/docs/` (the token, issuing and renewing, mounting the verifier beside a host verifier, the `Visitor-Token` header) and README; `auth` `principal.md`; a ledger entry under Standard library, "Visitors without accounts"; the primer; a `telo release add` fragment for `auth-visitor` and one for `auth`; module `license: MIT` and `LICENSE`; `telo release floor`.

## Verify

- Two first calls to the issuing route get different subjects. Renewing with a valid visitor token keeps its subject and moves `expiresAt`.
- On a mount listing `{ host verifier from Authorization }` then `{ visitor verifier from Visitor-Token }`:
  - a request carrying only `Visitor-Token` reads a principal with `kind: user`, `acr: "0"` and issuer `urn:telo:visitor:<name>`;
  - a request carrying both headers reads the host user;
  - a route overriding `authentication:` with only the host verifier answers 401 to a visitor-only request.
- A tampered or expired token is refused with a 401. A token from another `Visitors` set is refused.
- The mount's protected-resource document names no authorization server for the visitor verifier.
- Past the guard's limit for one `key`, `Issue` raises `ERR_AUTH_VISITOR_THROTTLED` and signs nothing.
- `Issue` with a host user's principal raises `ERR_AUTH_VISITOR_PRINCIPAL_FOREIGN`.

## Example after the change

```yaml
kind: AuthVisitor.Visitors
metadata: { name: visitors }
name: support
keys: !ref visitorKeys
lifetime: 720h
---
kind: Http.Api
metadata: { name: visitorApi }
routes:
  - request: { path: /visitor, method: POST }
    handler:
      kind: AuthVisitor.Issue
      visitors: !ref visitors
      limit: { kind: RateLimit.Guard, store: !ref limits, limit: 20, window: 1h }
    inputs:
      key: !cel "request.ip"
      principal: !cel "request.principal"
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
    catches:
      - when: !cel "error.code == 'ERR_AUTH_VISITOR_THROTTLED'"
        status: 429
        content: { application/json: { body: { code: !cel "error.code" } } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /api
    mount: !ref visitorApi
    authentication:
      anonymous: allow
      verifiers:
        - verifier: { kind: AuthVisitor.Verifier, visitors: !ref visitors }
          from: { kind: Http.FromHeader, header: visitor-token, scheme: Visitor }
```
