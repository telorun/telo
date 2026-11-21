---
status: draft
priority: high
depends-on: []
packages: [modules/auth-visitor, modules/auth, modules/jose, apps/authoring-agent, docs]
refinement: not-ready
---

# Visitor credentials

## Problem

A chat embedded on someone else's site, or a support widget, serves people who are not signed in, and each must still get back their own conversations. Today every such caller is the same caller: a mount with `authentication: { anonymous: allow }` serves them all with `request.principal` null, so anything keyed by the caller is one shared bucket. A `Session.Sessions` set started for a random subject would work, but it writes a session record and an index entry per visitor, and an anonymous population is unbounded. An application can hand-build a route that signs a JWT with `Jose.Sign` and accept it with `AuthBearer.Jwt`. But nothing ties the claims the route mints to what the verifier accepts, the verifier then advertises the application as an OAuth authorization server, and nothing limits how many identities one address can mint.

## Constraints

None.

## Surface

**Added**
- `auth-visitor` module (`AuthVisitor`): pseudonymous credentials for people who are not signed in.
- `AuthVisitor.Visitors`: a provider holding one set of visitor credentials: `name` (its durable identity, and the issuer of its principals), `keys` (a `Jose.KeySet`), `lifetime` (a `Telo.Duration`).
- `AuthVisitor.Issue`: an invocable that mints or renews a visitor token. Slots `visitors` and `throttle` (a `RateLimit.Guard`); inputs `throttleKey` (the throttle bucket) and `token` (string or null, sensitive); output `{ token, subject, expiresAt }`, `token` sensitive.
- `AuthVisitor.Verifier`: an `Auth.Verifier` over a `visitors` set that reads token presentations only. It publishes `challenges: []` and no `issuer`.
- Visitor principal: `kind: user`, `acr: https://telo.run/acr/visitor`, `amr: []`, `issuer` the set's `name`, `via` the verifier's name.
- `AuthVisitor.isVisitor(principal)`: an exported function, true when a non-null `Auth.Principal` is a visitor's.
- `Visitor` credential scheme: visitor tokens travel as `Authorization: Visitor <token>`, read with `Http.FromAuthorization` (`schemes: [Visitor]`).
- `ERR_AUTH_VISITOR_THROTTLED` (`data.retryAfter`, seconds): `Issue` refused a fresh mint because the key's limit is spent.
- `ERR_AUTH_VISITOR_UNAVAILABLE` (no `data`, the original failure its `cause`, retryable): on `Issue` and `Verifier`, the key set or the throttle's store could not be read.
- `AUTH_VISITOR_LIFETIME_EXCEEDS_RETIRE_AFTER` / `ERR_AUTH_VISITOR_LIFETIME_EXCEEDS_RETIRE_AFTER`: a `Visitors` set's `lifetime` is longer than its managed key set's `rotation.retireAfter`, refused by `telo check` and at creation.
- `signToken` in `@telorun/jose`'s code exports: signs a JWS with a signing key the caller has already read, beside `verifyToken`.

**Changed**
- None.

**Removed**
- None.

## Solution

A `Visitors` set is the one place the visitor credential is declared. `Issue` and `Verifier` both reference it, so the issuer, keys and lifetime the minting side uses are the ones the accepting side checks, and neither restates them. A visitor token is a JWT signed with the set's current key, with `iss` set to the set's `name`, a random 128-bit `sub`, `exp` at `lifetime` and no `aud`, so it is accepted on every mount of the application that lists the set's verifier. The name pattern admits no colon, so it never equals an `https://` issuer.

**Keys.** `Issue` and `Verifier` accept every algorithm a `Jose.KeySet` can sign with (ES256, RS256, EdDSA, HS256, never `none`), and `jose`'s key lookup already refuses a header algorithm the key its `kid` selects does not hold, so a set whose `algorithm` changed at a rotation still verifies the tokens it signed before, with no change to `verifyToken`. The key set rotates when the application dispatches `Jose.Rotate`, usually on a schedule. A replaced key keeps verifying for `rotation.retireAfter`, and a `Visitors` set whose `lifetime` exceeds that is refused (`AUTH_VISITOR_LIFETIME_EXCEEDS_RETIRE_AFTER` at check, `ERR_AUTH_VISITOR_LIFETIME_EXCEEDS_RETIRE_AFTER` at creation against the key set's evaluated configuration), because otherwise every visitor whose token outlives its key becomes a new person. A static key set never retires a key and is not judged. Signing goes through `jose`'s own `signToken`, which `Jose.Sign` is rebuilt on, so `jose` keeps one JWS signer.

**Issuing.** `Issue` is transport-neutral. The application declares the issuing route itself, with `authentication: { anonymous: allow }` and no verifier, and passes the stored token from the request body as `token`. `Issue` checks the token itself against its set, by the same verification the `Verifier` runs:
- a valid token of this set is renewed with the **same** subject and a later `expiresAt`, and charges nothing;
- an absent, forged, expired, other-set or retired-key token gets a fresh subject: `Issue` reads the signing key, then charges `throttle` under `throttleKey`, then signs; a spent throttle raises `ERR_AUTH_VISITOR_THROTTLED` and nothing is signed;
- a key set or a throttle store that cannot be read raises `ERR_AUTH_VISITOR_UNAVAILABLE`, never falling back to a fresh mint or to an uncharged one. A key-set outage never spends throttle budget, and a renewal keeps working while the throttle's store is down.

The route passes `request.ip` as `throttleKey`, so behind a proxy the server sets `trustProxy`, or every visitor shares the proxy's bucket. With several replicas the throttle's `Cache.Store` is shared; a store `fallback` makes the limit per replica for the length of an outage. The client renews before `expiresAt`; after expiry the visitor gets a new subject. A signed-in user calling the issuing route gets a visitor token like anyone else, since no verifier runs there.

**Accepting.** `Verifier` accepts a valid token as the visitor principal. A forged, expired or wrongly issued token is a refusal; an unreadable key set raises `ERR_AUTH_VISITOR_UNAVAILABLE`, which an HTTP mount answers 503 as for every verifier. The verifier declares no `issuer`, because the application is not an OAuth authorization server, so a mount's protected-resource metadata never lists one for it. The source's `Visitor` scheme is not `Bearer`, so the host's `Bearer` entry never takes a visitor token.

**Where the visitor verifier is listed.** A visitor is a person, so it is `kind: user`; that it is weakly identified is assurance, so its `acr` is `https://telo.run/acr/visitor`, an absolute URI in a namespace Telo owns, as OpenID Connect asks of a defined `acr` value. `Issue` and `Verifier` stamp it themselves and never read an `acr` claim from the token. The visitor verifier goes only on a mount whose routes all serve visitors, or in one route's `authentication:` override on a host mount. The host mount lists only the host verifier, so a route nobody thought about answers a visitor 401. A rule that needs a signed-in person inside a visitor-facing route reads `!AuthVisitor.isVisitor(request.principal)` where the principal cannot be null, and `principal != null && !AuthVisitor.isVisitor(principal)` in a policy or under `anonymous: allow`; the function's parameter is non-null, so an unguarded nullable principal is refused by `telo check`, as is a misspelt name.

**Claiming.** Moving a visitor's data to a user at sign-in is the application's own job and needs no kind: on a host-authenticated route, the application invokes the visitor `Verifier` as a step with the visitor token from the request body, and re-keys its own rows from the returned `subject`. A refused token, expired before sign-in, has nothing to claim, and the route answers so. A claimed token stays valid until it expires, so on a shared device a second person signing in could claim what the first did as a visitor afterwards; the widget therefore deletes its stored token after a successful claim and asks for a fresh one when it next needs it.

**Embedding.** A widget on another origin sends `Authorization`, so the server's `cors` lists the widget's origins and `authorization` in `allowedHeaders`. The widget keeps its token in its own storage, which a browser partitions per embedding site; a visitor on two host sites is two visitors.

## Decisions

- **Stateless tokens, not sessions.** A visitor costs no store write. Rejected: `Session.Sessions` started for a random subject, whose storage grows with every anonymous caller. Accepted: a visitor token cannot be revoked or listed before it expires.
- **One set declaration that both halves reference.** Rejected: an application-composed `Jose.Sign` route, where the minted claims and the verifier's checks can drift and nothing catches it.
- **`kind: user` with a visitor `acr`, not a new `kind` or a flag.** `kind` answers person or service; assurance is `acr`'s axis. A `kind: visitor` would still pass the commonest check, `principal != null`, and a flag would be a second spelling of what `acr` says. The fail-open risk is closed by where the verifier is listed, not by the shape.
- **A Telo-owned `acr` URI behind `isVisitor`.** Rejected: OpenID Connect's `"0"`, which identity providers emit for signed-in users (an SSO session reuse), so a real user would read as a visitor; comparing the issuer or `via`, which makes the check per-deployment text that every added set or a rename breaks; and the URI written as a literal in each rule, where a typo silently admits every visitor.
- **`Authorization: Visitor <token>`, not a custom header.** Shared caches and log pipelines treat `Authorization` as private and a custom header as not, so a custom header can leak one visitor's responses to another. A scheme of its own, not `Bearer`, keeps the host's `Bearer` entry from taking the token and keeps it out of protected-resource metadata. No request needs both a visitor and a host credential in headers, since claiming reads the visitor token from the body.
- **`Issue` judges the presented token itself.** A token judged by the access check before the route runs cannot be recovered from by that route: an expired one would answer 401 on the very call meant to replace it. Rejected: a `principal` input from a verifier on the issuing route, with a client rule to discard the token on 401.
- **No `issuer` published, and the issuer is the set's `name`.** That key means an authorization server clients would try to discover; a `urn:` or invented scheme would claim a namespace nobody registered.
- **The throttle is a required slot, charged only by a fresh mint.** An issuer anyone can call without a limit mints unbounded identities, and only `Issue` knows, after checking the token, whether a call creates one; charging renewals locks new visitors out behind a shared address. Rejected: a mount guard, which cannot tell a mint from a renewal.
- **One code for an outage, failing closed.** A caller has one answer to a key-set and a throttle-store failure, "try later"; which one failed is the `cause`'s. Rejected: passing `jose`'s codes through, which ties every issuing route's `catches:` to `jose`'s vocabulary, while `RateLimit.Guard` has no code to pass; and a fail-open throttle, which mints unbounded identities during an outage.
- **Signing lives in `jose`.** Building a JWS is `jose`'s concept. Rejected: `Issue` dispatching a hidden `Jose.Sign` instance, which the analyzer never sees; and a template body over `Jose.Sign` / `Jose.Verify`, which writes the verification policy twice.
- **`lifetime` beyond `retireAfter` is refused.** Both values are declared, and the failure is silent re-identification of every visitor at every rotation. Rejected: deriving one from the other, since one key set serves many signers with their own lifetimes.
- **Renewal keeps the subject.** Otherwise every renewal orphans the visitor's data.

Bookkeeping:
- `modules/auth-visitor/docs/`: `visitors.md` (the token, keys and rotation, the lifetime rule), `issuing.md` (renewal before expiry, the throttle, its shared store and `trustProxy`, both codes), `verifier.md` (the principal, the two layouts for listing the verifier), `claiming.md`, `embedding.md` (CORS, storage partitioning); README.
- `auth`'s `principal.md` states the general rule, naming no module's value: `acr` is the assurance the accepting verifier vouches for, a verifier whose credential is weaker than a sign-in states that with an absolute URI it owns, and "no principal" still means null. `verifier.md` in `auth-visitor` defines the URI and both forms of the `isVisitor` check.
- `jose`: `signToken` in its code exports and docs, `Jose.Sign` rebuilt on it with its output unchanged.
- Tests in `modules/auth-visitor/tests/*.yaml`, fixtures in `__fixtures__/`, the rule pinned refused at check and at creation.
- `modules/CLAUDE.md` gains a visitors paragraph beside sessions; the primer; a ledger entry under Standard library, "Visitors without sign-in"; the hub description naming "anonymous" and "guest".
- `telo release add` fragments for `auth-visitor`, `auth` and `jose`; module `license: MIT` and `LICENSE`; `telo release floor`.

## Verify

- Two first calls to the issuing route get different subjects. Renewing with a valid visitor token keeps its subject, moves `expiresAt` and leaves the throttle's remaining count unchanged.
- Renewing across a rotation, with the old key not yet retired, keeps the subject; so does renewing after the set's `algorithm` changed from ES256 to EdDSA and the set rotated.
- An expired, forged or other-set token on the issuing route gets a new subject; a token whose header names HS256 against an ES256 set is a new subject at `Issue` and a refusal at `Verifier`.
- With the key set's store failing, `Issue` raises `ERR_AUTH_VISITOR_UNAVAILABLE` with `cause.code` `ERR_JOSE_KEYSET_UNAVAILABLE`, returns no token and leaves the throttle's count unchanged. With the throttle's store failing and no `fallback`, a fresh mint raises `ERR_AUTH_VISITOR_UNAVAILABLE`, while a renewal succeeds with the same subject.
- `telo check` of the issuing route with only the throttle catch reports `ERR_AUTH_VISITOR_UNAVAILABLE` uncovered; with both catches it reports nothing.
- A host user calling the issuing route gets a visitor token, with no refusal.
- On the support mount, listing the host verifier from `Authorization` `[Bearer]` then the visitor verifier from `Authorization` `[Visitor]`:
  - `Authorization: Visitor <t>` reads a principal with `kind: user`, `acr: https://telo.run/acr/visitor`, `amr: []` and `issuer` the set's `name`, even when the token was minted with an `acr` claim of its own;
  - `Authorization: Bearer <t>` reads the host user;
  - a tampered visitor token is 401 and never reaches the host verifier.
- On the host mount, a visitor-only request is 401; a route overriding `verifiers` with both admits it.
- On `/support`, a host token carrying `acr: "0"` and one with `acr` null both read `signedIn: true`; a visitor reads `signedIn: false`. An `Authz.CelPolicy` rule `principal != null && !AuthVisitor.isVisitor(principal)` admits both host users and refuses a visitor and an anonymous caller.
- `telo check` refuses `AuthVisitor.isVisitor(principal)` over an unguarded nullable principal, and a misspelt function name.
- No file under `modules/auth/` names the visitor `acr` value.
- A token from another `Visitors` set over the same keys is refused.
- A mount declaring `protectedResource:` and listing the visitor verifier serves a document naming no authorization server and no bearer method for it.
- Past the throttle's limit for one `throttleKey`, a fresh mint raises `ERR_AUTH_VISITOR_THROTTLED` and signs nothing.
- `lifetime: 720h` beside a managed set's `retireAfter: 24h` is refused by `telo check` at the `Visitors` set; the same values computed from `variables:` are refused at creation; `720h` beside `720h` or `744h` passes; a static set is not judged.
- A cross-origin preflight from a listed widget origin carrying `authorization` is allowed.
- Claiming: the claim route re-keys a visitor's rows to the signed-in user; an expired visitor token answers `claimed: false` and changes nothing.
- `jose`'s sign/verify tests pass unchanged with `Jose.Sign` running on `signToken`.

## Example

Before, an application wires the credential by hand, writing the issuer twice and advertising itself as an authorization server:

```yaml
kind: Jose.Sign
metadata: { name: mintVisitor }
keys: !ref visitorKeys
issuer: https://support.acme.test
expiresIn: 720h
---
kind: AuthBearer.Jwt
metadata: { name: visitorTokens }
keys: !ref visitorKeys
issuer: https://support.acme.test
algorithms: [ES256]
```

After:

```yaml
kind: Telo.Application
metadata: { name: SupportDesk, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  AuthBearer: oci://ghcr.io/telorun/auth-bearer@0.3.0
  AuthVisitor: oci://ghcr.io/telorun/auth-visitor@0.1.0
  Jose: oci://ghcr.io/telorun/jose@0.3.1
  RateLimit: oci://ghcr.io/telorun/rate-limit@0.15.0
  CacheRedis: oci://ghcr.io/telorun/cache-redis@0.14.0
  KvStoreRedis: oci://ghcr.io/telorun/kv-store-redis@0.9.4
  Scheduler: oci://ghcr.io/telorun/scheduler@0.12.3
  Sql: oci://ghcr.io/telorun/sql@0.31.4
  SQLite: oci://ghcr.io/telorun/sqlite@0.15.0
variables:
  redisUrl: { env: REDIS_URL, type: string, default: "redis://127.0.0.1:6379" }
  widgetOrigins: { env: WIDGET_ORIGINS, type: array, items: { type: string }, default: ["https://shop.example.org"] }
  dbFile: { env: DB_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file }, default: support.db }
secrets:
  keyWrap: { env: VISITOR_KEY_WRAP, type: string, minLength: 16 }
ports:
  http: { env: PORT, protocol: tcp, default: 8080 }
targets:
  - !ref migrate
  - !ref rotation
  - !ref server
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: SQLite.Schema
metadata: { name: migrate }
connection: !ref db
tables:
  - kind: SQLite.Table
    table: conversations
    columns:
      id: { type: integer, primaryKey: true, identity: always }
      owner: { type: text, nullable: false }
      topic: { type: text, nullable: false }
---
kind: Jose.KeySet
metadata: { name: visitorKeys }
store: { kind: KvStoreRedis.Store, url: !cel "variables.redisUrl" }
name: visitors
wrapKey: !cel "secrets.keyWrap"
rotation: { every: 168h, retireAfter: 744h }
---
kind: Scheduler.Cron
metadata: { name: rotation }
cron: "0 3 * * *"
invoke: { kind: Jose.Rotate, keys: !ref visitorKeys }
---
kind: AuthVisitor.Visitors
metadata: { name: visitors }
name: support
keys: !ref visitorKeys
lifetime: 720h
---
kind: AuthVisitor.Verifier
metadata: { name: visitorVerifier }
visitors: !ref visitors
---
kind: AuthBearer.Jwt
metadata: { name: hostTokens }
keys: { kind: Jose.RemoteKeySet, url: https://login.acme.test/.well-known/jwks.json }
issuer: https://login.acme.test
algorithms: [ES256]
audience: https://support.acme.test/
---
kind: Http.Api
metadata: { name: visitorApi }
routes:
  - request:
      path: /visitor
      method: POST
      schema: { body: { type: object, additionalProperties: false, properties: { token: { type: [string, "null"] } } } }
    handler:
      kind: AuthVisitor.Issue
      visitors: !ref visitors
      throttle:
        kind: RateLimit.Guard
        store: { kind: CacheRedis.Store, url: !cel "variables.redisUrl" }
        limit: 20
        window: 1h
    inputs:
      throttleKey: !cel "request.ip"
      token: !cel "has(request.body.token) ? request.body.token : null"
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
    catches:
      - when: !cel "error.code == 'ERR_AUTH_VISITOR_THROTTLED'"
        status: 429
        headers: { Retry-After: !cel "string(error.data.retryAfter)" }
        content: { application/json: { body: { code: !cel "error.code" } } }
      - when: !cel "error.code == 'ERR_AUTH_VISITOR_UNAVAILABLE'"
        status: 503
        headers: { Retry-After: "5" }
        content: { application/json: { body: { code: !cel "error.code" } } }
---
kind: Http.Api
metadata: { name: supportApi }
routes:
  - request: { path: /conversations, method: GET }
    handler: { kind: Sql.Query, connection: !ref db }
    inputs:
      sql: "SELECT id, topic FROM conversations WHERE owner = ? ORDER BY id"
      bindings: [!cel "request.principal.subject"]
    returns:
      - status: 200
        content:
          application/json:
            body: { conversations: !cel "result.rows", signedIn: !cel "!AuthVisitor.isVisitor(request.principal)" }
  - request: { path: /conversations/{id}/export, method: GET }
    authorization:
      policy:
        kind: Authz.CelPolicy
        rules:
          - { when: !cel "principal != null && !AuthVisitor.isVisitor(principal)", allow: true }
          - { when: !cel "true", allow: false, reason: sign in to export a conversation }
      action: export
    returns:
      - { status: 200, content: { application/json: { body: { conversation: !cel "request.params.id" } } } }
---
kind: Http.Api
metadata: { name: accountApi }
routes:
  - request: { path: /billing, method: GET }
    returns:
      - { status: 200, content: { application/json: { body: { owner: !cel "request.principal.subject" } } } }
  - request: { path: /articles, method: GET }
    authentication:
      verifiers:
        - { verifier: !ref hostTokens, from: { kind: Http.FromAuthorization, schemes: [Bearer] } }
        - { verifier: !ref visitorVerifier, from: { kind: Http.FromAuthorization, schemes: [Visitor] } }
    returns:
      - { status: 200, content: { application/json: { body: { reader: !cel "request.principal.subject" } } } }
  - request:
      path: /claim
      method: POST
      schema: { body: { type: object, additionalProperties: false, required: [visitorToken], properties: { visitorToken: { type: string } } } }
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [visitorToken, user]
          properties: { visitorToken: { type: string, x-telo-sensitive: true }, user: { type: string } }
      steps:
        - name: visitor
          invoke: !ref visitorVerifier
          inputs:
            presentation: { type: token, token: !cel "inputs.visitorToken", scheme: Visitor }
            confirmation: {}
            resource: null
        - name: move
          if: !cel "has(steps.visitor.result.principal)"
          then:
            - name: rekey
              invoke: { kind: Sql.Command, connection: !ref db }
              inputs:
                sql: "UPDATE conversations SET owner = ? WHERE owner = ?"
                bindings: [!cel "inputs.user", !cel "steps.visitor.result.principal.subject"]
      outputs:
        claimed: !cel "has(steps.visitor.result.principal)"
    inputs:
      visitorToken: !cel "request.body.visitorToken"
      user: !cel "request.principal.subject"
    returns:
      - { status: 200, content: { application/json: { body: { claimed: !cel "result.claimed" } } } }
    catches:
      - when: !cel "error.code == 'ERR_AUTH_VISITOR_UNAVAILABLE'"
        status: 503
        content: { application/json: { body: { code: !cel "error.code" } } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
trustProxy: 1
cors:
  origin: !cel "variables.widgetOrigins"
  methods: [GET, POST]
  allowedHeaders: [authorization, content-type]
mounts:
  - path: /issue
    mount: !ref visitorApi
    authentication: { anonymous: allow }
  - path: /support
    mount: !ref supportApi
    authentication:
      verifiers:
        - { verifier: !ref hostTokens, from: { kind: Http.FromAuthorization, schemes: [Bearer] } }
        - { verifier: !ref visitorVerifier, from: { kind: Http.FromAuthorization, schemes: [Visitor] } }
  - path: /account
    mount: !ref accountApi
    authentication:
      verifiers:
        - { verifier: !ref hostTokens, from: { kind: Http.FromAuthorization, schemes: [Bearer] } }
```

A `Visitors` set whose lifetime outlives its keys is refused before the app runs:

```yaml
kind: Jose.KeySet
metadata: { name: visitorKeys }
store: { kind: KvStoreRedis.Store, url: !cel "variables.redisUrl" }
name: visitors
wrapKey: !cel "secrets.keyWrap"
rotation: { every: 168h, retireAfter: 24h }
---
kind: AuthVisitor.Visitors
metadata: { name: visitors }
name: support
keys: !ref visitorKeys
lifetime: 720h
```

```console
$ telo check ./telo.yaml
error AUTH_VISITOR_LIFETIME_EXCEEDS_RETIRE_AFTER at AuthVisitor.Visitors/visitors lifetime
  lifetime 720h is longer than retireAfter 24h of key set visitorKeys: a token would outlive the key that signed it, and its visitor would become a new one at renewal. Raise rotation.retireAfter to at least 720h, or shorten lifetime.
```

On the wire (`$V` holds the token the first call returned, `$H` a host user's access token):

```console
$ curl -s -X POST localhost:8080/issue/visitor -H 'content-type: application/json' -d '{"token":null}'
{"token":"eyJhbGciOiJFUzI1NiIsImtpZCI6Ims3In0.eyJpc3MiOiJzdXBwb3J0Iiwic3ViIjoiOGYzYzJhMWU5YjRkNDc2MGE1ZTFjMmQzYjRhNTk2ODciLCJpYXQiOjE3OTUyNTUyMDAsImV4cCI6MTc5Nzg0NzIwMH0.Jx0H6AbyFyBskWbh-412etIpjBickWOu2O5Uc0ao-KKaKJLh7WkNHvfNsCJsgvsm0h2qtK3FxGG3Y9N_oZV3iA","subject":"8f3c2a1e9b4d4760a5e1c2d3b4a59687","expiresAt":"2026-12-21T10:00:00Z"}

$ curl -s -X POST localhost:8080/issue/visitor -H 'content-type: application/json' -d "{\"token\":\"$V\"}"
{"token":"eyJhbGciOiJFUzI1NiIsImtpZCI6Ims3In0.eyJpc3MiOiJzdXBwb3J0Iiwic3ViIjoiOGYzYzJhMWU5YjRkNDc2MGE1ZTFjMmQzYjRhNTk2ODciLCJpYXQiOjE3OTUzMzgwMDAsImV4cCI6MTc5NzkzMDAwMH0.meQ1fh8yycnlkYijV6baP7mqlwB0DPTZiOxu4RzLgE-bCaWGG3lf37fPfHtZMH2JKlXS-ZNY7ouqf6FWJcCcEQ","subject":"8f3c2a1e9b4d4760a5e1c2d3b4a59687","expiresAt":"2026-12-22T09:00:00Z"}

$ curl -s localhost:8080/support/conversations -H "authorization: Visitor $V"
{"conversations":[{"id":1,"topic":"Where is my order?"}],"signedIn":false}

$ curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/support/conversations -H "authorization: Visitor ${V}x"
401

$ curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/account/billing -H "authorization: Visitor $V"
401

$ curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/support/conversations/1/export -H "authorization: Visitor $V"
403

$ curl -s localhost:8080/support/conversations/1/export -H "authorization: Bearer $H"
{"conversation":"1"}

$ curl -s -X POST localhost:8080/account/claim -H "authorization: Bearer $H" -H 'content-type: application/json' -d "{\"visitorToken\":\"$V\"}"
{"claimed":true}

$ curl -s -i -X POST localhost:8080/issue/visitor -H 'content-type: application/json' -d '{"token":null}'
HTTP/1.1 429 Too Many Requests
Retry-After: 1260
content-type: application/json

{"code":"ERR_AUTH_VISITOR_THROTTLED"}

$ # with Redis down
$ curl -s -i -X POST localhost:8080/issue/visitor -H 'content-type: application/json' -d '{"token":null}'
HTTP/1.1 503 Service Unavailable
Retry-After: 5
content-type: application/json

{"code":"ERR_AUTH_VISITOR_UNAVAILABLE"}
```
